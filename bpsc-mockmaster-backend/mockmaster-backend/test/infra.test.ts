import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

describe('infrastructure', () => {
  const env = JSON.parse(readFileSync('.test-runtime/env.json', 'utf8'));
  it('migrated template has the full schema and the audit log is append-only', async () => {
    const c = new pg.Client({ connectionString: `postgres://mm@127.0.0.1:${env.pgPort}/mm_template` });
    await c.connect();
    const r = await c.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'");
    expect(r.rows[0].n).toBeGreaterThanOrEqual(30);
    await c.query('BEGIN');
    await c.query("INSERT INTO audit_logs (actor_type, action, entity) VALUES ('SYSTEM','TEST','X')");
    await expect(c.query("UPDATE audit_logs SET action='CHANGED'")).rejects.toThrow(/append-only/);
    await c.query('ROLLBACK');
    await c.end();
  });
});
