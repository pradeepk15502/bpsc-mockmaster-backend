import type { Queryable } from './db.js';

export interface Actor { type: 'ADMIN' | 'STUDENT' | 'SYSTEM' | 'WEBHOOK'; id?: string | null; name?: string | null; role?: string | null; ip?: string | null; requestId?: string | null }
export const SYSTEM: Actor = { type: 'SYSTEM', name: 'System', role: 'SYSTEM' };

const s = (v: unknown) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Append-only (enforced by a database trigger). */
export async function audit(c: Queryable, actor: Actor, action: string, entity: string, entityId: string | null, before?: unknown, after?: unknown, reason?: string | null) {
  await c.query(
    `INSERT INTO audit_logs (actor_type, actor_id, actor_name, role, action, entity, entity_id, before, after, reason, ip, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [actor.type, actor.id ?? null, actor.name ?? null, actor.role ?? null, action, entity, entityId, s(before), s(after), reason ?? null, actor.ip ?? null, actor.requestId ?? null]);
}
