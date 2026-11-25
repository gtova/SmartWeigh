import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pool } from './db.js';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { sessionsRouter } from './routes/sessions.js';
import { measurementsRouter, meRouter } from './routes/me.js';
import { HttpError } from './errors.js';
import { normalizeTarget } from './routes/auth.js';
import { outbox } from './providers/message.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.webOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', db: 'down' });
    }
  });

  // Local development only: lets the login screen show the one-time code since nothing is really sent.
  if (process.env.DEV_SHOW_OTP === '1' && config.devMode) {
    app.get('/dev/last-code', (req, res) => {
      const t = normalizeTarget(String(req.query.target ?? ''));
      const m = t && [...outbox].reverse().find((o) => o.to === t.target);
      const code = m && /(\d{6})/.exec(m.text)?.[1];
      res.json({ code: code ?? null });
    });
  }

  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/sessions', sessionsRouter);
  app.use('/measurements', measurementsRouter);
  app.use('/me', meRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, ...err.extra });
    console.error('unhandled error', err instanceof Error ? err.message : 'unknown');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}





