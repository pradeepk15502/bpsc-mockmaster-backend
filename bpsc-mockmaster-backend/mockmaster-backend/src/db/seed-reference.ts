import pg from 'pg';
import { seedReference } from './reference-data.js';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query('BEGIN'); await seedReference(c); await c.query('COMMIT');
await c.end();
console.log('Reference data seeded. All exam configurations are PENDING_VERIFICATION and all prices are inactive until an admin verifies / activates them.');
