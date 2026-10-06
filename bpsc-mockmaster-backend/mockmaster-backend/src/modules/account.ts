import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { exec, many, one, tx } from '../lib/db.js';
import { conflict } from '../lib/errors.js';
import { LIMITS } from '../lib/ratelimit.js';
import { audit } from '../lib/audit.js';
import { actorOf, noStore, parse, studentOf } from '../http.js';
import { COOKIES, studentGuard } from './sessions.js';
import { hmacHex } from '../lib/crypto.js';

const SupportIn = z.object({ name: z.string().trim().min(2).max(80), contact: z.string().trim().min(5).max(120), category: z.enum(['PAYMENT', 'ACCOUNT', 'MOCK', 'QUESTION', 'OTHER']), message: z.string().trim().min(5).max(4000) });

export function accountRoutes(app: FastifyInstance, deps: Deps) {
  /** Support form works signed-in or not (people locked out of their account need it most). */
  app.post('/api/support', async (req, reply) => {
    noStore(reply);
    await deps.limiter.hit('support', req.ip, LIMITS.supportPerIp);
    const b = parse(SupportIn, req.body);
    let userId: string | null = null;
    const t = req.cookies?.[COOKIES.STUDENT.sid];
    if (t) userId = (await one(deps.db, "SELECT subject_id FROM sessions WHERE token_hash=$1 AND subject_type='STUDENT' AND revoked_at IS NULL AND expires_at > $2", [hmacHex(deps.cfg.SESSION_PEPPER, t), deps.clock.now()]))?.subject_id ?? null;
    const row = await one(deps.db, 'INSERT INTO support_tickets (user_id, name, contact, category, message, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [userId, b.name, b.contact, b.category, b.message, deps.clock.now()]);
    return { ok: true, ticketId: row.id, message: 'Thanks — our team will reply within 2 working days.' };
  });

  app.get('/api/notifications', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const rows = await many(deps.db, "SELECT id, type, title, message, read, created_at FROM notifications WHERE audience='student' AND user_id=$1 ORDER BY created_at DESC LIMIT 50", [studentOf(req).userId]);
    return { notifications: rows };
  });
  app.post('/api/notifications/read-all', { preHandler: studentGuard(deps) }, async req => {
    await exec(deps.db, "UPDATE notifications SET read=true WHERE audience='student' AND user_id=$1 AND NOT read", [studentOf(req).userId]);
    return { ok: true };
  });

  // ---------------- account / data deletion ----------------
  app.post('/api/account/deletion-request', { preHandler: studentGuard(deps) }, async req => {
    const b = parse(z.object({ reason: z.string().trim().max(1000).optional(), confirm: z.literal(true) }), req.body);
    const u = studentOf(req);
    return tx(deps.db, async c => {
      const open = await one(c, "SELECT id, requested_at FROM deletion_requests WHERE user_id=$1 AND status='REQUESTED'", [u.userId]);
      if (open) return { ok: true, requestId: open.id, status: 'REQUESTED', duplicate: true };
      const row = await one(c, 'INSERT INTO deletion_requests (user_id, reason, requested_at) VALUES ($1,$2,$3) RETURNING id', [u.userId, b.reason ?? null, deps.clock.now()]);
      await audit(c, actorOf(req), 'DELETION_REQUESTED', 'User', u.userId, null, 'REQUESTED', b.reason ?? null);
      return { ok: true, requestId: row.id, status: 'REQUESTED', message: 'Your request is recorded. We will process it within 30 days and confirm by SMS/email. Payment records we must keep by law are retained.' };
    });
  });
  app.get('/api/account/deletion-request', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const r = await one(deps.db, 'SELECT id, status, requested_at, processed_at FROM deletion_requests WHERE user_id=$1 ORDER BY requested_at DESC LIMIT 1', [studentOf(req).userId]);
    return { request: r };
  });
  /** Personal data export (JSON). */
  app.get('/api/account/export', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const id = studentOf(req).userId;
    const [user, payments, ents, attempts] = await Promise.all([
      one(deps.db, 'SELECT name, email, mobile, student_code, created_at, last_login_at FROM users WHERE id=$1', [id]),
      many(deps.db, "SELECT status, amount_paise, spec->>'label' AS label, created_at FROM payments WHERE user_id=$1", [id]),
      many(deps.db, 'SELECT exam_type, level, paper, subject_id, status, activated_at, expires_at FROM entitlements WHERE user_id=$1', [id]),
      many(deps.db, "SELECT mock_id, status, submitted_at, result->'total' AS total FROM attempts WHERE user_id=$1", [id]),
    ]);
    reply.header('content-disposition', 'attachment; filename="mockmaster-my-data.json"');
    return { exportedAt: deps.clock.now(), user, payments, entitlements: ents, attempts };
  });
}

/** Admin: anonymise the user. Payments / invoices are kept (financial records); personal identifiers are removed. */
export async function processDeletion(deps: Deps, requestId: string, adminName: string, actor: any) {
  return tx(deps.db, async c => {
    const r = await one(c, "SELECT * FROM deletion_requests WHERE id=$1 FOR UPDATE", [requestId]);
    if (!r) throw conflict('NOT_FOUND', 'Request not found.');
    if (r.status !== 'REQUESTED') return { ok: true, duplicate: true };
    const now = deps.clock.now();
    await exec(c, "UPDATE users SET name='Deleted user', email=NULL, mobile=NULL, status='DELETED', deleted_at=$2 WHERE id=$1", [r.user_id, now]);
    await exec(c, "UPDATE sessions SET revoked_at=$2 WHERE subject_type='STUDENT' AND subject_id=$1 AND revoked_at IS NULL", [r.user_id, now]);
    await exec(c, "UPDATE entitlements SET status='CANCELLED' WHERE user_id=$1 AND status='ACTIVE'", [r.user_id]);
    await exec(c, 'DELETE FROM waitlist WHERE user_id=$1', [r.user_id]);
    await exec(c, 'DELETE FROM notifications WHERE user_id=$1', [r.user_id]);
    await exec(c, 'UPDATE events SET data=NULL WHERE user_id=$1', [r.user_id]);
    await exec(c, 'UPDATE support_tickets SET name=$2, contact=$2 WHERE user_id=$1', [r.user_id, 'deleted']);
    await exec(c, "UPDATE deletion_requests SET status='COMPLETED', processed_at=$2, processed_by=$3 WHERE id=$1", [requestId, now, adminName]);
    await audit(c, actor, 'ACCOUNT_DELETED', 'User', r.user_id, 'ACTIVE', 'DELETED', 'Personal data removed; payment records retained');
    return { ok: true, duplicate: false };
  });
}
