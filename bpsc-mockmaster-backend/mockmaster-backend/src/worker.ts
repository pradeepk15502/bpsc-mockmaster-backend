/**
 * Worker process (run separately from the API):
 *  - generation jobs (Claude) — the only code that calls Claude
 *  - attempt expiry: delayed job per attempt + sweeper every 15 s (auto-submit even if the browser is closed)
 *  - payment reconciliation every 5 minutes
 *  - daily planner: tomorrow's mocks + generation (human review still required before publish)
 */
import { Queue, Worker } from 'bullmq';
import { createDeps } from './bootstrap.js';
import type { Deps } from './deps.js';
import { tx } from './lib/db.js';
import { addDaysToDate, examDate } from './lib/time.js';
import { expireDueAttempts, finalizeAttempt } from './modules/attempts.js';
import { planDailyMocks, processGenerationJob } from './modules/content-core.js';
import { reconcilePayments } from './modules/payments.js';
import { Q } from './queues.js';

export async function startWorkers(deps: Deps) {
  const connection = deps.redis; const prefix = deps.cfg.QUEUE_PREFIX;
  const maint = new Queue(Q.maintenance, { connection, prefix });
  await maint.upsertJobScheduler('expire-sweep', { every: 15_000 }, { name: 'expire-sweep' });
  await maint.upsertJobScheduler('reconcile-payments', { every: 5 * 60_000 }, { name: 'reconcile-payments' });
  await maint.upsertJobScheduler('daily-plan', { pattern: '0 30 17 * * *', tz: deps.cfg.TZ_EXAM }, { name: 'daily-plan' });

  const workers = [
    new Worker(Q.generation, async job => processGenerationJob(deps, job.data.jobId), { connection, prefix, concurrency: 2 }),
    new Worker(Q.attempts, async job => (await tx(deps.db, c => finalizeAttempt(deps, c, job.data.attemptId, 'AUTO'))).duplicate ? 'already-final' : 'auto-submitted', { connection, prefix, concurrency: 10 }),
    new Worker(Q.maintenance, async job => {
      if (job.name === 'expire-sweep') return expireDueAttempts(deps);
      if (job.name === 'reconcile-payments') return reconcilePayments(deps);
      if (job.name === 'daily-plan') return planDailyMocks(deps, addDaysToDate(examDate(deps.clock.now(), deps.cfg.TZ_EXAM), 1));
    }, { connection, prefix, concurrency: 1 }),
  ];
  for (const w of workers) w.on('failed', (job, err) => deps.log.error({ err, queue: w.name, job: job?.name }, 'job failed'));
  return { workers, maint };
}

if (process.argv[1]?.endsWith('worker.js') || process.argv[1]?.endsWith('worker.ts')) {
  const deps = createDeps();
  const { workers, maint } = await startWorkers(deps);
  deps.log.info('workers started');
  const stop = async () => { await Promise.all(workers.map(w => w.close())); await maint.close(); await deps.jobs.close(); await deps.db.end(); deps.redis.disconnect(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
