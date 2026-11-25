import { config } from '../../config.js';
import type { Changes, Flag } from './flags.js';
import { PROMPT_VERSION, type LlmOutput } from './schema.js';

/** What the model sees: no name, email, phone or ids. */
export interface AgentInput {
  age: number;
  heightCm: number;
  current: { weightKg: number; bmi: number | null; bodyFatPct: number | null; muscleMassKg: number | null; bodyWaterPct: number | null };
  history: { date: string; weightKg: number; bodyFatPct: number | null }[];
  changes: Changes;
  flags: Flag[];
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: { system: string; user: string }): Promise<string>;
}

export const SYSTEM_PROMPT = `אתה כותב בעברית הסבר קצר והמלצות עדינות לאדם שנמדד בעמדת שקילה והרכב גוף. גרסת הנחיות: ${PROMPT_VERSION}.
כללים:
- טון תומך, חם ומעודד, בלי שיפוטיות ובלי ביקורת על הגוף.
- בלי יעדי משקל, בלי קלוריות, בלי עידוד לירידה חדה ובלי דיאטות.
- בלי אבחון או פרשנות רפואית. מדדי ההרכב הם הערכה בלבד. אל תכתוב אם ערך "תקין" או "גבוה".
- הסבר את המספר והשינוי בשפה פשוטה, וציין שהשוואה משמעותית יותר בתנאים דומים (שעה, שתייה, פעילות).
- אם יש דגל extreme_change או concerning_trend, הצע בעדינות להתייעץ עם איש מקצוע.
- אם יש דגל composition_jump, ציין שזו הערכה שעשויה להיות מושפעת מתנאי המדידה, בלי להסיק מסקנה.
- החזר JSON בלבד בצורה: {"explanation": string, "recommendations": [2 עד 3 מחרוזות], "suggest_professional": boolean}`;

export const buildUserPrompt = (input: AgentInput) => JSON.stringify(input);

/** Offline provider: fills fixed Hebrew templates from the computed flags. No cost, no key. */
export class MockLLM implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'template-v1';
  async generate({ user }: { user: string }) {
    const i = JSON.parse(user) as AgentInput;
    return JSON.stringify(templateOutput(i));
  }
}

export function templateOutput(i: AgentInput): LlmOutput {
  const w = i.current.weightKg.toFixed(1);
  const d = i.changes.vsPreviousKg;
  let explanation: string;
  if (i.flags.includes('first_measurement')) {
    explanation = `זו המדידה הראשונה שלך, והמשקל שנמדד הוא ${w} ק"ג. מכאן נוכל לעקוב אחרי המגמה לאורך זמן.`;
  } else if (d === null || Math.abs(d) < 0.3) {
    explanation = `המשקל שלך עומד על ${w} ק"ג, כמעט בלי שינוי מהמדידה הקודמת.`;
  } else {
    explanation = `המשקל שלך עומד על ${w} ק"ג, ${d > 0 ? 'עלייה' : 'ירידה'} של ${Math.abs(d).toFixed(1)} ק"ג לעומת המדידה הקודמת.`;
  }
  if (i.flags.includes('composition_jump')) explanation += ' מדדי ההרכב הם הערכה בלבד, ויכול להיות שההפרש נובע מתנאי המדידה.';
  const recs = ['כדאי למדוד בתנאים דומים, למשל באותה שעה ביום, כדי שההשוואה תהיה משמעותית.', 'שתייה סדירה לאורך היום עוזרת לקבל תמונה יציבה יותר.'];
  const pro = i.flags.includes('extreme_change') || i.flags.includes('concerning_trend');
  if (pro) recs.push('אם השינוי מעסיק אותך, אפשר להתייעץ עם איש מקצוע.');
  else recs.push('מעקב לאורך שבועות מספק תמונה אמינה יותר ממדידה בודדת.');
  return { explanation, recommendations: recs, suggest_professional: pro };
}

/** Real provider (Anthropic Messages API). Key and model come from env, server-side only. */
export class ClaudeLLM implements LLMProvider {
  readonly name = 'claude';
  constructor(
    readonly model: string,
    private apiKey: string,
  ) {
    if (!model) throw new Error('LLM_MODEL is required when LLM_PROVIDER=claude');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude');
  }
  async generate({ system, user }: { system: string; user: string }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: 400, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`llm_http_${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return body.content?.find((c) => c.type === 'text')?.text ?? '';
  }
}

export const llm: { provider: LLMProvider } = {
  provider: config.llm.provider === 'claude' ? new ClaudeLLM(config.llm.model, config.llm.apiKey) : new MockLLM(),
};
