import pino from 'pino';
import { ClaudeQuestionGenerator } from './adapters/claude.js';
import { ConsoleOtpSender, Msg91OtpSender } from './adapters/otp.js';
import { HttpRazorpayClient } from './adapters/razorpay.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';
import { createPool } from './lib/db.js';
import { RateLimiter } from './lib/ratelimit.js';
import { createRedis } from './lib/redis.js';
import { systemClock } from './lib/time.js';
import { BullJobs } from './queues.js';

/** Production wiring. Every secret stays in this process; nothing here is ever serialised to a client. */
export function createDeps(): Deps {
  const cfg = loadConfig();
  const log = pino({ level: cfg.isProd ? 'info' : 'debug', redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', '*.password', '*.code', '*.razorpay_signature'], censor: '[redacted]' } });
  const db = createPool(cfg.DATABASE_URL, 20);
  const redis = createRedis(cfg.REDIS_URL);
  return {
    cfg, db, redis, log, clock: systemClock,
    otp: cfg.OTP_PROVIDER === 'msg91' ? new Msg91OtpSender(cfg.MSG91_AUTH_KEY, cfg.MSG91_TEMPLATE_ID, cfg.MSG91_OTP_VAR) : new ConsoleOtpSender(m => log.warn(m)),
    razorpay: new HttpRazorpayClient(cfg.RAZORPAY_KEY_ID, cfg.RAZORPAY_KEY_SECRET),
    generator: new ClaudeQuestionGenerator(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODEL),
    jobs: new BullJobs(redis, cfg.QUEUE_PREFIX),
    limiter: new RateLimiter(redis, cfg.QUEUE_PREFIX),
  };
}
