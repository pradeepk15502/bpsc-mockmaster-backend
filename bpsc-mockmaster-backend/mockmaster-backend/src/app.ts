import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import type { Deps } from './deps.js';
import { AppError } from './lib/errors.js';
import { LIMITS } from './lib/ratelimit.js';
import { authRoutes } from './modules/auth.js';
import { eventRoutes } from './modules/events.js';
import { catalogRoutes } from './modules/catalog.js';
import { paymentRoutes } from './modules/payments.js';
import { attemptRoutes } from './modules/attempts.js';
import { contentRoutes } from './modules/content.js';
import { adminRoutes } from './modules/admin.js';
import { accountRoutes } from './modules/account.js';
import { legalRoutes } from './modules/legal.js';

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.log as any,
    trustProxy: deps.cfg.TRUST_PROXY > 0 ? ((_addr: string, hop: number) => hop < deps.cfg.TRUST_PROXY) : false,
    bodyLimit: 256 * 1024,
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: deps.cfg.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);                       // same-origin / server-to-server (webhooks)
      cb(null, deps.cfg.origins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key'],
    maxAge: 600,
  });
  await app.register(cookie);

  // The Razorpay webhook signature is computed over the exact raw bytes: keep them.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!body || (body as Buffer).length === 0) return done(null, {});
    try { done(null, JSON.parse((body as Buffer).toString('utf8'))); }
    catch { done(new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.'), undefined); }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      if (err.status === 429 && err.details?.retryAfterSec) reply.header('retry-after', String(err.details.retryAfterSec));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, requestId: req.id });
    }
    if (err?.validation || err?.statusCode === 400 || err?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'The request could not be understood.' }, requestId: req.id });
    }
    if (err?.statusCode === 413) return reply.status(413).send({ error: { code: 'TOO_LARGE', message: 'The request is too large.' }, requestId: req.id });
    req.log.error({ err }, 'unhandled error');
    // No stack traces, SQL or provider messages reach the client.
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' }, requestId: req.id });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' }, requestId: req.id }));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await deps.db.query('SELECT 1'); await deps.redis.ping(); return { ok: true }; }
    catch { return reply.status(503).send({ ok: false }); }
  });

  authRoutes(app, deps);
  eventRoutes(app, deps);
  catalogRoutes(app, deps);
  paymentRoutes(app, deps);
  attemptRoutes(app, deps);
  contentRoutes(app, deps);
  adminRoutes(app, deps);
  accountRoutes(app, deps);
  legalRoutes(app, deps);
  void LIMITS;
  return app;
}
