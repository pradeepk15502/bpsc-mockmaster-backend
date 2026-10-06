import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Jobs } from './deps.js';

export const Q = { generation: 'generation', attempts: 'attempts', maintenance: 'maintenance' } as const;

export class BullJobs implements Jobs {
  private gen: Queue; private att: Queue;
  constructor(connection: Redis, prefix: string) {
    this.gen = new Queue(Q.generation, { connection, prefix });
    this.att = new Queue(Q.attempts, { connection, prefix });
  }
  async enqueueGeneration(jobId: string) {
    // jobId dedupes concurrent enqueues; removeOnComplete lets "retry failed batches" enqueue it again later.
    await this.gen.add('run', { jobId }, { jobId: `gen-${jobId}-${Date.now()}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 1000, removeOnFail: 1000 });
  }
  async scheduleAttemptExpiry(attemptId: string, at: Date) {
    await this.att.add('expire', { attemptId }, { jobId: `expire-${attemptId}`, delay: Math.max(0, at.getTime() - Date.now()) + 1000, attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 5000, removeOnFail: 5000 });
  }
  async close() { await Promise.all([this.gen.close(), this.att.close()]); }
}
