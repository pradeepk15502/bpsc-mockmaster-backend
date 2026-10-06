import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
// When running from dist/, SQL files live next to the sources.
function migrationsDir(): string {
  try { readdirSync(DIR); return DIR; } catch { return join(process.cwd(), 'src/db/migrations'); }
}

/** Applies pending *.sql migrations in order, each in its own transaction, recording them in schema_migrations. */
export async function migrate(url: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await c.query('SELECT pg_advisory_lock(727274)');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const dir = migrationsDir();
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f); log(`applied ${f}`);
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await c.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  migrate(url, m => console.log(m)).then(a => { console.log(a.length ? `${a.length} migration(s) applied` : 'up to date'); }).catch(e => { console.error(e); process.exit(1); });
}
