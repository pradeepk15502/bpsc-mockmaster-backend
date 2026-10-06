import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient | pg.Client;

// Bigints (bigserial / sum) come back as strings by default; numerics too. Parse the ones we use as numbers.
pg.types.setTypeParser(20, v => Number(v));       // int8
pg.types.setTypeParser(1700, v => Number(v));     // numeric
pg.types.setTypeParser(1082, v => v);             // date stays 'YYYY-MM-DD'

export function createPool(url: string, max = 10): Db {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, statement_timeout: 15_000 } as pg.PoolConfig);
}

export async function one<T = any>(c: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await c.query(sql, params as any[]);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = any>(c: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params as any[]);
  return r.rows as T[];
}
export async function exec(c: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const r = await c.query(sql, params as any[]);
  return r.rowCount ?? 0;
}

/** Runs fn inside a transaction. Serialization failures / deadlocks are retried a few times. */
export async function tx<T>(pool: Db, fn: (c: Tx) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e: any) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      if ((e?.code === '40001' || e?.code === '40P01') && attempt < retries) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
