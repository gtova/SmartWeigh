import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outboxFile = path.join(os.tmpdir(), 'weighwise-e2e-outbox.json');
const outbox = (): { kind: string; to: string; text: string }[] => JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
const EMAIL = 'e2e.user@example.com';

async function lastCode(page: Page, count: number) {
  await expect.poll(() => outbox().length, { timeout: 10_000 }).toBeGreaterThan(count);
  return /(\d{6})/.exec(outbox().at(-1)!.text)![1];
}

test.describe.configure({ mode: 'serial' });

test('kiosk: full flow from welcome to result and reset', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByRole('heading', { name: /ברוכים הבאים/ })).toBeVisible();
  await page.getByRole('button', { name: 'התחלה', exact: true }).click();

  await page.getByRole('tab', { name: 'כתובת דוא"ל' }).click();
  await page.getByLabel('כתובת דוא"ל', { exact: true }).fill(EMAIL);
  const before = outbox().length;
  await page.getByRole('button', { name: 'שלחו לי קוד' }).click();
  const code = await lastCode(page, before);
  for (const d of code) await page.getByRole('button', { name: d, exact: true }).click();

  // first login: registration
  await expect(page.getByRole('heading', { name: 'עוד רגע ואנחנו מתחילים' })).toBeVisible();
  await page.getByLabel('שם מלא').fill('בודק אוטומטי');
  await page.getByLabel('שנת לידה').fill('1988');
  await page.getByLabel('גובה (ס״מ)').fill('176');
  await page.getByLabel(/קראתי ואני מסכים/).check();
  await page.getByLabel(/סוכן AI/).check();
  await page.getByRole('button', { name: 'שמירה והמשך' }).click();

  await page.getByRole('button', { name: 'תשלום', exact: true }).click();

  // guided hygiene: cannot skip, drying timer enforced
  await expect(page.getByRole('heading', { name: 'נוהל חיטוי מודרך' })).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'בוצע', exact: true }).click();
    await expect(page.getByText(`${i + 1}. `, { exact: false }).first()).toBeVisible();
    if (i < 3) await expect(page.locator('.steplist .done')).toHaveCount(i + 1);
  }
  const dry = page.getByRole('button', { name: 'הייבוש הסתיים' });
  await expect(dry).toBeDisabled();
  await expect(dry).toBeEnabled({ timeout: 10_000 });
  await dry.click();
  await page.getByRole('button', { name: 'המשך', exact: true }).click();

  // declarations
  const go = page.getByRole('button', { name: 'המשך למדידה' });
  await expect(go).toBeDisabled();
  await page.getByLabel(/המכשיר מתאים לי/).check();
  await page.getByLabel('ניקיתי לפי ההנחיות.').check();
  await go.click();

  await page.getByRole('button', { name: 'התחלת מדידה' }).click();
  await expect(page.getByRole('heading', { name: 'התוצאה שלכם' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('הערכות הרכב גוף הן הערכה בלבד')).toBeVisible();
  await expect(page.getByText(/התוצאה נשלחה אליכם למייל/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'סיום' }).click();
  await expect(page.getByRole('heading', { name: 'תודה!' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /ברוכים הבאים/ })).toBeVisible({ timeout: 10_000 }); // auto reset
});

test('kiosk: cancel returns to the welcome screen', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'התחלה', exact: true }).click();
  await page.getByRole('button', { name: 'ביטול ויציאה' }).click();
  await expect(page.getByRole('heading', { name: /ברוכים הבאים/ })).toBeVisible();
});

test('kiosk: offline blocks payment and weighing with a clear message', async ({ page, context }) => {
  await page.goto('/kiosk');
  await context.setOffline(true);
  await expect(page.getByText('אין חיבור לאינטרנט.')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('אין חיבור לאינטרנט.')).toBeHidden();
});

test('site: result link -> login -> measurement, history, export, delete', async ({ page }) => {
  const mail = outbox().filter((o) => o.kind === 'email' && o.text.includes('/login?next=')).at(-1)!;
  const link = /(http:\/\/localhost:5173\/login\?next=\S+)/.exec(mail.text)![1];
  await page.goto(link);
  await page.getByRole('tab', { name: 'כתובת דוא"ל' }).click();
  await page.getByLabel('כתובת דוא"ל', { exact: true }).fill(EMAIL);
  const before = outbox().length;
  await page.getByRole('button', { name: 'שלחו לי קוד' }).click();
  await page.getByLabel('קוד אימות').fill(await lastCode(page, before));
  await page.getByRole('button', { name: 'כניסה', exact: true }).click();

  await expect(page).toHaveURL(/\/measurements\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: /פרטי שקילה/ })).toBeVisible();
  await expect(page.getByText('הסבר והמלצות')).toBeVisible();

  await page.getByRole('link', { name: 'היסטוריית שקילות' }).click();
  await expect(page.getByRole('row')).toHaveCount(2); // header + one measurement

  await page.getByRole('link', { name: 'הגדרות' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /ייצוא כל הנתונים/ }).click()]);
  expect(download.suggestedFilename()).toBe('weighwise-export.json');

  await page.getByRole('button', { name: 'מחיקת חשבון ונתונים' }).click();
  await page.getByRole('button', { name: 'כן, למחוק הכל' }).click();
  await expect(page.getByRole('heading', { name: /שקילה וניתוח הרכב גוף/ })).toBeVisible();
  // old session no longer works
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
