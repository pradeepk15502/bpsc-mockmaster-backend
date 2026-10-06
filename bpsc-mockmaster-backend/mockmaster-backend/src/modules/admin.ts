import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { exec, many, one, tx } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { actorOf, parse, Uuid } from '../http.js';
import { adminGuard } from './sessions.js';
import { processDeletion } from './account.js';
import { maskMobile } from './auth.js';

export function adminRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/admin/students', { preHandler: adminGuard(deps, 'student.view') }, async req => {
    const q = parse(z.object({ q: z.string().trim().max(80).optional() }), req.query);
    const like = q.q ? '%' + q.q.replace(/[%_]/g, '') + '%' : null;
    const rows = await many(deps.db, `SELECT id, student_code, name, email, mobile, status, created_at, last_login_at FROM users
                                      WHERE ($1::text IS NULL OR name ILIKE $1 OR student_code ILIKE $1 OR mobile LIKE $1) ORDER BY created_at DESC LIMIT 100`, [like]);
    return { students: rows.map(r => ({ ...r, mobile: maskMobile(r.mobile) })) };
  });
  app.post('/api/admin/students/:id/status', { preHandler: adminGuard(deps, 'student.suspend') }, async req => {
    const id = parse(Uuid, (req.params as any).id); const b = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(300) }), req.body);
    return tx(deps.db, async c => {
      const u = await one(c, "SELECT status FROM users WHERE id=$1 AND status <> 'DELETED' FOR UPDATE", [id]); if (!u) throw notFound('Student');
      await exec(c, 'UPDATE users SET status=$2 WHERE id=$1', [id, b.status]);
      if (b.status === 'SUSPENDED') await exec(c, "UPDATE sessions SET revoked_at=$2 WHERE subject_type='STUDENT' AND subject_id=$1 AND revoked_at IS NULL", [id, deps.clock.now()]);
      await audit(c, actorOf(req), b.status === 'SUSPENDED' ? 'STUDENT_SUSPENDED' : 'STUDENT_REACTIVATED', 'User', id, u.status, b.status, b.reason);
      return { ok: true };
    });
  });
  app.get('/api/admin/waitlist', { preHandler: adminGuard(deps, 'waitlist.view') }, async () => ({
    demand: await many(deps.db, 'SELECT cohort_base, count(*)::int n, min(created_at) first_at FROM waitlist GROUP BY cohort_base ORDER BY n DESC'),
  }));
  app.get('/api/admin/deletion-requests', { preHandler: adminGuard(deps, 'deletion.process') }, async () => ({
    requests: await many(deps.db, "SELECT d.id, d.status, d.reason, d.requested_at, d.processed_at, u.student_code FROM deletion_requests d JOIN users u ON u.id = d.user_id ORDER BY d.requested_at DESC LIMIT 200"),
  }));
  app.post('/api/admin/deletion-requests/:id/complete', { preHandler: adminGuard(deps, 'deletion.process') }, async req =>
    processDeletion(deps, parse(Uuid, (req.params as any).id), req.admin!.name, actorOf(req)));
  app.get('/api/admin/support', { preHandler: adminGuard(deps, 'support.view') }, async () => ({
    tickets: await many(deps.db, 'SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 200'),
  }));
  app.get('/api/admin/audit', { preHandler: adminGuard(deps, 'audit.view') }, async req => {
    const q = parse(z.object({ entity: z.string().max(40).optional(), entityId: z.string().max(160).optional() }), req.query);
    return { audit: await many(deps.db, 'SELECT * FROM audit_logs WHERE ($1::text IS NULL OR entity=$1) AND ($2::text IS NULL OR entity_id=$2) ORDER BY id DESC LIMIT 500', [q.entity ?? null, q.entityId ?? null]) };
  });
  app.get('/api/admin/notifications', { preHandler: adminGuard(deps) }, async () => ({
    notifications: await many(deps.db, "SELECT * FROM notifications WHERE audience='admin' ORDER BY created_at DESC LIMIT 100"),
  }));
}
