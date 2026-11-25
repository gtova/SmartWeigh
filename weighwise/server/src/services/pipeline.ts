import { config } from '../config.js';
import { onSaved } from '../events.js';
import { findFallbackMeasurements, generateRecommendation, regenerateRecommendation } from './ai/agent.js';
import { notifyQueue } from './notify.js';

let started = false;
const retryTimers = new Set<ReturnType<typeof setTimeout>>();

/** Schedules background retries for a measurement whose analysis fell back to the neutral placeholder. */
function scheduleRetries(measurementId: string) {
  config.ai.retryDelaysMs.forEach((delay) => {
    const t = setTimeout(async () => {
      retryTimers.delete(t);
      try {
        await regenerateRecommendation(measurementId);
      } catch {
        // A failed retry leaves the placeholder in place; a later retry or the sweep can still fix it.
      }
    }, delay);
    t.unref?.();
    retryTimers.add(t);
  });
}

/** After a measurement is saved: build the AI recommendation, then queue the result message. */
export function startPipeline() {
  if (started) return;
  started = true;
  onSaved(async ({ measurementId }) => {
    let wasFallback = false;
    try {
      wasFallback = await generateRecommendation(measurementId);
    } catch {
      // The result is still delivered (with the stored/neutral text) even if the AI step fails.
      wasFallback = true;
    }
    if (wasFallback) scheduleRetries(measurementId);
    await notifyQueue.add({ measurementId });
  });
}

/** Periodic safety net: re-attempts any fallback recommendations left behind (e.g. after a restart). */
export function startFallbackSweeper() {
  const id = setInterval(async () => {
    try {
      for (const measurementId of await findFallbackMeasurements()) {
        await regenerateRecommendation(measurementId).catch(() => undefined);
      }
    } catch {
      // best effort
    }
  }, config.ai.sweepIntervalMs);
  id.unref?.();
  return id;
}

/** Test helper: cancels any pending in-process retry timers. */
export function clearPipelineTimers() {
  for (const t of retryTimers) clearTimeout(t);
  retryTimers.clear();
}
