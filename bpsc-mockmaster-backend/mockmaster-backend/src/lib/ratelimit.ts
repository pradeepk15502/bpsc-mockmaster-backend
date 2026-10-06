import type { Redis } from 'ioredis';
import { tooMany } from './errors.js';

// Fixed-window counter, atomic in Redis. Returns [count, ttlMs].
const LUA = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}`;

export interface Limit { max: number; windowSec: number }

export class RateLimiter {
  constructor(private redis: Redis, private prefix: string) {}
  /** Throws 429 when the key exceeded max hits in the window. */
  async hit(name: string, key: string, lim: Limit): Promise<void> {
    const k = `${this.prefix}:rl:${name}:${key}`;
    const [count, ttl] = (await this.redis.eval(LUA, 1, k, String(lim.windowSec * 1000))) as [number, number];
    if (count > lim.max) throw tooMany(Math.max(1, Math.ceil((ttl > 0 ? ttl : lim.windowSec * 1000) / 1000)));
  }
  /** Read-only check (used for cooldowns where the hit is recorded separately). */
  async ttlSec(name: string, key: string): Promise<number> {
    const t = await this.redis.pttl(`${this.prefix}:rl:${name}:${key}`);
    return t > 0 ? Math.ceil(t / 1000) : 0;
  }
  /** Atomically starts a cooldown; false if one is already running. */
  async claimCooldown(name: string, key: string, sec: number): Promise<boolean> {
    return (await this.redis.set(`${this.prefix}:rl:${name}:${key}`, '1', 'EX', sec, 'NX')) === 'OK';
  }
  async reset(name: string, key: string) { await this.redis.del(`${this.prefix}:rl:${name}:${key}`); }
}

/** Central list of limits so they can be reviewed in one place. */
export const LIMITS = {
  otpRequestPerMobile: { max: 5, windowSec: 3600 },
  otpRequestPerIp: { max: 20, windowSec: 3600 },
  otpResendCooldownSec: 60,
  otpVerifyPerMobile: { max: 10, windowSec: 900 },
  otpVerifyPerIp: { max: 40, windowSec: 900 },
  adminLoginPerIp: { max: 20, windowSec: 900 },
  adminLoginPerEmail: { max: 10, windowSec: 900 },
  paymentCreatePerUser: { max: 10, windowSec: 600 },
  paymentVerifyPerUser: { max: 20, windowSec: 600 },
  attemptStartPerUser: { max: 20, windowSec: 60 },
  answerSavePerAttempt: { max: 180, windowSec: 60 },
  submitPerAttempt: { max: 10, windowSec: 60 },
  heartbeatPerAttempt: { max: 30, windowSec: 60 },
  eventsPerUser: { max: 120, windowSec: 60 },
  readPerUser: { max: 300, windowSec: 60 },
  adminPerUser: { max: 300, windowSec: 60 },
  generatePerAdmin: { max: 20, windowSec: 3600 },
  supportPerIp: { max: 5, windowSec: 3600 },
  publicPerIp: { max: 120, windowSec: 60 },
  webhookPerIp: { max: 600, windowSec: 60 },
} as const;
