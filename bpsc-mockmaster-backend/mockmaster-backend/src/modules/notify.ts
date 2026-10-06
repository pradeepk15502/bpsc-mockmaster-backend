import { exec, type Queryable } from '../lib/db.js';
export async function notify(c: Queryable, n: { audience: 'student' | 'admin'; userId?: string | null; type: string; title: string; message?: string; mockId?: string | null; purchaseId?: string | null; cta?: unknown }, at: Date) {
  await exec(c, 'INSERT INTO notifications (audience, user_id, type, title, message, created_at, related_mock_id, related_purchase_id, cta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [n.audience, n.userId ?? null, n.type, n.title, n.message ?? '', at, n.mockId ?? null, n.purchaseId ?? null, n.cta ?? null]);
}
