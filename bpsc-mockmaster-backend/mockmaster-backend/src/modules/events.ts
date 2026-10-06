import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { exec, type Queryable } from '../lib/db.js';
import { LIMITS } from '../lib/ratelimit.js';
import { parse, studentOf } from '../http.js';
import { studentGuard } from './sessions.js';

/** Product events only — no keystrokes, mouse tracking, tab-switch spying or device fingerprinting. */
export async function logEvent(c: Queryable, userId: string | null, type: string, data: { mockId?: string; attemptId?: string; questionId?: string; [k: string]: unknown }, at: Date) {
  const { mockId, attemptId, questionId, ...rest } = data;
  await exec(c, 'INSERT INTO events (user_id, type, at, mock_id, attempt_id, question_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, type, at, mockId ?? null, attemptId ?? null, questionId ?? null, Object.keys(rest).length ? rest : null]);
}

// Only these may be sent by the browser; everything that matters (payments, submissions, scores) is logged server-side.
const CLIENT_EVENTS = ['MOCK_VIEWED', 'RESULT_VIEWED', 'PALETTE_OPENED', 'LANGUAGE_CHANGED', 'MARKED_FOR_REVIEW'] as const;
const Body = z.object({ type: z.enum(CLIENT_EVENTS), mockId: z.string().max(120).optional(), attemptId: z.string().uuid().optional(), questionId: z.string().max(120).optional(), value: z.string().max(40).optional() });

export function eventRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/events', { preHandler: studentGuard(deps) }, async req => {
    const u = studentOf(req);
    await deps.limiter.hit('events', u.userId, LIMITS.eventsPerUser);
    const b = parse(Body, req.body);
    await logEvent(deps.db, u.userId, b.type, { mockId: b.mockId, attemptId: b.attemptId, questionId: b.questionId, ...(b.value ? { value: b.value } : {}) }, deps.clock.now());
    return { ok: true };
  });
}
