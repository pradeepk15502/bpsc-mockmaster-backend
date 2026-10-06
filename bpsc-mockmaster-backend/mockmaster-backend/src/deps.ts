import type { Logger } from 'pino';
import type { QuestionGenerator } from './adapters/claude.js';
import type { OtpSender } from './adapters/otp.js';
import type { RazorpayClient } from './adapters/razorpay.js';
import type { Config } from './config.js';
import type { Db } from './lib/db.js';
import type { RateLimiter } from './lib/ratelimit.js';
import type { Redis } from './lib/redis.js';
import type { Clock } from './lib/time.js';

/** Background work the API hands to the worker process. */
export interface Jobs {
  enqueueGeneration(jobId: string): Promise<void>;
  scheduleAttemptExpiry(attemptId: string, at: Date): Promise<void>;
  close(): Promise<void>;
}

export interface Deps {
  cfg: Config; db: Db; redis: Redis; clock: Clock; log: Logger;
  otp: OtpSender; razorpay: RazorpayClient; generator: QuestionGenerator;
  jobs: Jobs; limiter: RateLimiter;
}
