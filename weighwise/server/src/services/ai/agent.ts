import { pool } from '../../db.js';
import { computeFlags, type Point } from './flags.js';
import { buildUserPrompt, llm, templateOutput, type AgentInput } from './llm.js';
import { NEUTRAL, parseOutput, PROMPT_VERSION, type LlmOutput } from './schema.js';

const toPoint = (r: { weight_kg: number; body_fat_pct: number | null; measured_at: Date }): Point => ({
  weightKg: r.weight_kg,
  bodyFatPct: r.body_fat_pct,
  measuredAt: new Date(r.measured_at),
});
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export async function buildInput(measurementId: string) {
  const cur = (
    await pool.query(
      `SELECT m.*, u.birth_year, u.height_cm FROM measurements m JOIN users u ON u.id=m.user_id WHERE m.id=$1`,
      [measurementId],
    )
  ).rows[0];
  const hist = (
    await pool.query(
      `SELECT weight_kg, bmi, body_fat_pct, muscle_mass_kg, body_water_pct, measured_at FROM measurements
       WHERE user_id=$1 AND measured_at < $2 ORDER BY measured_at DESC LIMIT 10`,
      [cur.user_id, cur.measured_at],
    )
  ).rows;
  // Earlier advice lets the agent build on it instead of repeating itself. Neutral fallbacks are skipped.
  const recs = (
    await pool.query(
      `SELECT r.recommendations, r.created_at FROM recommendations r JOIN measurements m ON m.id=r.measurement_id
       WHERE m.user_id=$1 AND m.measured_at < $2 AND r.model NOT LIKE '%fallback%' ORDER BY r.created_at DESC LIMIT 5`,
      [cur.user_id, cur.measured_at],
    )
  ).rows;
  const { flags, changes, suggestProfessional } = computeFlags(toPoint(cur), hist.map(toPoint));
  const input: AgentInput = {
    age: new Date().getFullYear() - cur.birth_year,
    heightCm: cur.height_cm,
    current: { weightKg: cur.weight_kg, bmi: cur.bmi, bodyFatPct: cur.body_fat_pct, muscleMassKg: cur.muscle_mass_kg, bodyWaterPct: cur.body_water_pct },
    history: hist.map((h) => ({
      date: day(h.measured_at),
      weightKg: h.weight_kg,
      bmi: h.bmi,
      bodyFatPct: h.body_fat_pct,
      muscleMassKg: h.muscle_mass_kg,
      bodyWaterPct: h.body_water_pct,
    })),
    previousRecommendations: recs.map((r) => ({ date: day(r.created_at), recommendations: r.recommendations as string[] })),
    changes,
    flags,
  };
  return { input, suggestProfessional, userId: cur.user_id as string };
}

/** Calls the model (one retry), validates the output, and falls back to a neutral message. */
export async function generateOutput(input: AgentInput): Promise<{ out: LlmOutput; model: string; promptVersion: string }> {
  const p = llm.provider;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseOutput(await p.generate({ system: p.systemPrompt, user: buildUserPrompt(input) }));
      if (out) return { out, model: `${p.name}:${p.model}`, promptVersion: p.promptVersion };
    } catch (e) {
      // Only the error kind is logged: never the input (health data) or the key.
      console.warn(`llm attempt ${attempt + 1} failed: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
    }
  }
  return { out: NEUTRAL, model: `${p.name}:fallback`, promptVersion: p.promptVersion };
}

/** A recommendation whose model ended in ":fallback" is the neutral placeholder; a real analysis is still owed. */
export const isFallbackModel = (model: string | null | undefined) => !!model?.endsWith(':fallback');

export async function generateRecommendation(measurementId: string) {
  const { input, suggestProfessional, userId } = await buildInput(measurementId);
  const consent = await pool.query("SELECT 1 FROM consents WHERE user_id=$1 AND type='ai_processing' AND revoked_at IS NULL", [userId]);
  // No AI-processing consent: nothing leaves the server; use the fixed template instead.
  const res = consent.rowCount
    ? await generateOutput(input)
    : { out: templateOutput(input), model: 'template:no-consent', promptVersion: PROMPT_VERSION };
  await pool.query(
    `INSERT INTO recommendations(measurement_id, explanation, recommendations, suggest_professional, prompt_version, model, report)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (measurement_id) DO NOTHING`,
    [
      measurementId,
      res.out.explanation,
      JSON.stringify(res.out.recommendations),
      // Code-computed flags always win; the model can only add a suggestion, never remove one.
      suggestProfessional || res.out.suggest_professional,
      res.promptVersion,
      res.model,
      res.out.report ?? null,
    ],
  );
  return isFallbackModel(res.model);
}

/**
 * Re-runs the agent for a measurement whose stored recommendation is a fallback, and overwrites it on success.
 * A no-op when there is no row, when it is already a real analysis, or when the user withdrew AI consent.
 * Returns the outcome so callers (manual button / background retry) can react.
 */
export async function regenerateRecommendation(measurementId: string): Promise<'regenerated' | 'still_fallback' | 'skipped'> {
  const existing = await pool.query('SELECT model FROM recommendations WHERE measurement_id=$1', [measurementId]);
  if (!existing.rowCount || !isFallbackModel(existing.rows[0].model)) return 'skipped';

  const { input, suggestProfessional, userId } = await buildInput(measurementId);
  const consent = await pool.query("SELECT 1 FROM consents WHERE user_id=$1 AND type='ai_processing' AND revoked_at IS NULL", [userId]);
  if (!consent.rowCount) return 'skipped';

  const res = await generateOutput(input);
  if (isFallbackModel(res.model)) return 'still_fallback'; // model still unavailable; keep the placeholder

  await pool.query(
    `UPDATE recommendations SET explanation=$2, recommendations=$3, suggest_professional=$4, prompt_version=$5, model=$6, report=$7, created_at=now()
     WHERE measurement_id=$1`,
    [
      measurementId,
      res.out.explanation,
      JSON.stringify(res.out.recommendations),
      suggestProfessional || res.out.suggest_professional,
      res.promptVersion,
      res.model,
      res.out.report ?? null,
    ],
  );
  return 'regenerated';
}

/** Measurements (newest first) whose recommendation is still a fallback and whose owner has AI consent. */
export async function findFallbackMeasurements(limit = 20): Promise<string[]> {
  const r = await pool.query(
    `SELECT r.measurement_id FROM recommendations r
     JOIN measurements m ON m.id = r.measurement_id
     WHERE r.model LIKE '%:fallback'
       AND EXISTS (SELECT 1 FROM consents c WHERE c.user_id = m.user_id AND c.type='ai_processing' AND c.revoked_at IS NULL)
     ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => x.measurement_id as string);
}
