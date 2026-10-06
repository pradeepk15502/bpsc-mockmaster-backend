import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_APP_ORIGIN: z.string().default('http://localhost:3000'),
  COOKIE_DOMAIN: z.string().optional().default(''),
  TZ_EXAM: z.string().default('Asia/Kolkata'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_PEPPER: z.string().min(32),
  OTP_PEPPER: z.string().min(32),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  GENERATION_DAILY_TOKEN_BUDGET: z.coerce.number().int().default(4_000_000),
  OTP_PROVIDER: z.enum(['msg91', 'console']).default('console'),
  MSG91_AUTH_KEY: z.string().optional().default(''),
  MSG91_TEMPLATE_ID: z.string().optional().default(''),
  MSG91_OTP_VAR: z.string().default('otp'),
  QUEUE_PREFIX: z.string().default('mm'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),        // number of trusted reverse-proxy hops
  // Shown on the legal / support pages. Required in production — never invented by the app.
  LEGAL_ENTITY_NAME: z.string().optional().default(''),
  SUPPORT_EMAIL: z.string().optional().default(''),
  SUPPORT_PHONE: z.string().optional().default(''),
  BUSINESS_ADDRESS: z.string().optional().default(''),
  GRIEVANCE_OFFICER: z.string().optional().default(''),
  REFUND_WINDOW_DAYS: z.coerce.number().int().min(0).max(60).default(7),   // business decision — confirm before launch
  LEGAL_REVIEWED: z.enum(['true', 'false']).default('false'),             // set true only after a lawyer reviewed the pages
});
export type Config = z.infer<typeof Env> & { isProd: boolean; origins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error('Invalid configuration — ' + issues);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  // Production guard rails: refuse to boot with unsafe settings.
  if (isProd) {
    if (c.OTP_PROVIDER !== 'msg91') throw new Error('OTP_PROVIDER must be msg91 in production (console/demo OTP is not allowed).');
    if (!c.MSG91_AUTH_KEY || !c.MSG91_TEMPLATE_ID) throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required in production.');
    if (c.RAZORPAY_KEY_ID.startsWith('rzp_test_')) throw new Error('Test Razorpay keys are not allowed in production.');
    if (c.PUBLIC_APP_ORIGIN.includes('localhost')) throw new Error('PUBLIC_APP_ORIGIN must be the real site origin in production.');
    if (!c.PUBLIC_APP_ORIGIN.split(',').every(o => o.trim().startsWith('https://'))) throw new Error('PUBLIC_APP_ORIGIN must use https in production.');
    for (const k of ['LEGAL_ENTITY_NAME', 'SUPPORT_EMAIL', 'BUSINESS_ADDRESS', 'GRIEVANCE_OFFICER'] as const) if (!c[k]) throw new Error(`${k} is required in production (legal / support pages).`);
    if (!c.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required in production (generation worker).');
  }
  return { ...c, isProd, origins: c.PUBLIC_APP_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) };
}
