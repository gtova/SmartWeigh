import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export interface JobQueue<T> {
  add(data: T): Promise<void>;
  /** Registers the processor. It throws to request a retry; `onFinalFailure` runs when retries are exhausted. */
  process(handler: (data: T) => Promise<void>, onFinalFailure: (data: T, err: Error) => Promise<void>): void;
  /** Resolves when no jobs are pending (tests). */
  idle(): Promise<void>;
}

export const RETRIES = 3;
export const backoffMs = { base: 2000 }; // grows exponentially: 2s, 4s, 8s

/** In-process queue with retries and growing delays; used when Redis is not configured. */
export class MemoryQueue<T> implements JobQueue<T> {
  private handler?: (d: T) => Promise<void>;
  private onFail?: (d: T, e: Error) => Promise<void>;
  private pending = new Set<Promise<void>>();

  async add(data: T) {
    const p = this.run(data).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  process(h: (d: T) => Promise<void>, f: (d: T, e: Error) => Promise<void>) {
    this.handler = h;
    this.onFail = f;
  }
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  private async run(data: T) {
    let last: Error = new Error('no handler');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        await this.handler?.(data);
        return;
      } catch (e) {
        last = e instanceof Error ? e : new Error('unknown');
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, backoffMs.base * 2 ** attempt));
      }
    }
    await this.onFail?.(data, last);
  }
}

/** BullMQ-backed queue (Redis). Retries are handled by BullMQ with exponential backoff. */
export class BullQueue<T> implements JobQueue<T> {
  private q: Queue;
  private connection: Redis;
  constructor(private name: string) {
    this.connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.q = new Queue(name, { connection: this.connection });
  }
  async add(data: T) {
    await this.q.add('job', data, {
      attempts: RETRIES + 1,
      backoff: { type: 'exponential', delay: backoffMs.base },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }
  process(h: (d: T) => Promise<void>, f: (d: T, e: Error) => Promise<void>) {
    const w = new Worker(this.name, async (job) => h(job.data as T), { connection: this.connection.duplicate() });
    w.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void f(job.data as T, err);
    });
  }
  async idle() {
    /* not needed outside tests */
  }
}

export function createQueue<T>(name: string): JobQueue<T> {
  return config.redisUrl ? new BullQueue<T>(name) : new MemoryQueue<T>();
}
