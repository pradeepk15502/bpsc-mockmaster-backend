/**
 * Starts a throwaway PostgreSQL 16 cluster and a redis-server on random ports for the whole test run,
 * applies migrations to a template database, and tears everything down afterwards.
 * Nothing is mocked at the database / queue level: tests run against the real engines.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); s.on('error', rej);
});
function pgBin(name: string): string {
  for (const v of ['17', '16', '15', '14']) { const p = `/usr/lib/postgresql/${v}/bin/${name}`; if (existsSync(p)) return p; }
  return name; // on PATH
}
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
function runAsPg(bin: string, args: string[]) {
  return isRoot ? execFileSync('runuser', ['-u', 'postgres', '--', bin, ...args], { stdio: 'pipe' }) : execFileSync(bin, args, { stdio: 'pipe' });
}

let redisProc: ChildProcess | null = null;
let pgData = '';
let workDir = '';

export default async function setup() {
  workDir = mkdtempSync(join(tmpdir(), 'mm-test-'));
  chmodSync(workDir, 0o777);
  pgData = join(workDir, 'pg');
  const pgPort = await freePort();
  const redisPort = await freePort();

  runAsPg(pgBin('initdb'), ['-D', pgData, '-U', 'mm', '--auth=trust', '-E', 'UTF8', '--no-sync']);
  runAsPg(pgBin('pg_ctl'), ['-D', pgData, '-l', join(pgData, 'log.txt'), '-w', '-o', `-p ${pgPort} -k ${workDir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=300`, 'start']);

  redisProc = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { execFileSync('redis-cli', ['-p', String(redisPort), 'ping'], { stdio: 'pipe' }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  const admin = new pg.Client({ connectionString: `postgres://mm@127.0.0.1:${pgPort}/postgres` });
  await admin.connect();
  await admin.query('CREATE DATABASE mm_template');
  await admin.end();
  await migrate(`postgres://mm@127.0.0.1:${pgPort}/mm_template`);

  mkdirSync('.test-runtime', { recursive: true });
  writeFileSync('.test-runtime/env.json', JSON.stringify({ pgPort, redisPort }));
  process.env.MM_TEST_PG_PORT = String(pgPort);
  process.env.MM_TEST_REDIS_PORT = String(redisPort);

  return async () => {
    try { runAsPg(pgBin('pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']); } catch { /* already down */ }
    redisProc?.kill('SIGKILL');
    rmSync(workDir, { recursive: true, force: true });
  };
}
