import { onSaved } from '../events.js';
import { generateRecommendation } from './ai/agent.js';
import { notifyQueue } from './notify.js';

let started = false;

/** After a measurement is saved: build the AI recommendation, then queue the result message. */
export function startPipeline() {
  if (started) return;
  started = true;
  onSaved(async ({ measurementId }) => {
    try {
      await generateRecommendation(measurementId);
    } catch {
      // The result is still delivered (with the stored/neutral text) even if the AI step fails.
    }
    await notifyQueue.add({ measurementId });
  });
}
