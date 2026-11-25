import { z } from 'zod';

export const PROMPT_VERSION = 'v1';

// Words the product must never show (no calories, weight goals, diets, or "normal/high" judgements).
export const FORBIDDEN = ['קלורי', 'דיאטה', 'יעד משקל', 'משקל יעד', 'הרזי', 'להרזות', 'צום', 'תקין', 'גבוה', 'השמנה', 'שמן מדי'];

const hebrew = /[\u0590-\u05FF]/;
const text = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => hebrew.test(s), 'hebrew').refine((s) => !FORBIDDEN.some((w) => s.includes(w)), 'forbidden');

export const outputSchema = z.object({
  explanation: text(500),
  recommendations: z.array(text(160)).min(2).max(3),
  suggest_professional: z.boolean(),
});
export type LlmOutput = z.infer<typeof outputSchema>;

export function parseOutput(raw: string): LlmOutput | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const r = outputSchema.safeParse(JSON.parse(m[0]));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Pre-written message used when the model fails twice or the user has not consented to AI processing. */
export const NEUTRAL: LlmOutput = {
  explanation: 'המדידה נשמרה בהצלחה. אפשר לראות את הפרטים ואת ההיסטוריה שלך באזור האישי.',
  recommendations: ['כדאי למדוד בתנאים דומים, למשל באותה שעה ביום, כדי שההשוואה תהיה משמעותית.', 'שתייה סדירה לאורך היום עוזרת לקבל תמונה יציבה יותר.'],
  suggest_professional: false,
};
