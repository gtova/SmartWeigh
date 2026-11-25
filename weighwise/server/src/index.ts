import { configureOutboundProxy } from './net.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { purgeDeletedUsers } from './routes/me.js';
import { startFallbackSweeper, startPipeline } from './services/pipeline.js';
import { expireStaleSessions } from './services/sessions.js';

configureOutboundProxy();
await migrate('up');
if (config.devMode) await seed();
startPipeline();
startFallbackSweeper();
setInterval(() => void expireStaleSessions().catch(() => undefined), 30_000).unref();
setInterval(() => void purgeDeletedUsers().catch(() => undefined), 3600_000).unref();

createApp().listen(config.port, () => {
  // Logs intentionally contain no identifying data.
  console.log(`server listening on :${config.port}`);
});


