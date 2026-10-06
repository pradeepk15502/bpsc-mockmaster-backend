import { buildApp } from './app.js';
import { createDeps } from './bootstrap.js';

const deps = createDeps();
const app = await buildApp(deps);
await app.listen({ port: deps.cfg.PORT, host: '0.0.0.0' });
const stop = async () => { await app.close(); await deps.jobs.close(); await deps.db.end(); deps.redis.disconnect(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
