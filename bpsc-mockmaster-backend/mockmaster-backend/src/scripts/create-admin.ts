/** First SUPER_ADMIN bootstrap: ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD (min 12 chars) from the environment. */
import pg from 'pg';
import { hashPassword } from '../lib/crypto.js';
const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_ROLE = 'SUPER_ADMIN', DATABASE_URL } = process.env;
if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) { console.error('Set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters).'); process.exit(1); }
const c = new pg.Client({ connectionString: DATABASE_URL }); await c.connect();
await c.query('INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)', [ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), await hashPassword(ADMIN_PASSWORD), ADMIN_ROLE]);
await c.query("INSERT INTO audit_logs (actor_type, actor_name, role, action, entity, entity_id, after) VALUES ('SYSTEM','create-admin script','SYSTEM','ADMIN_CREATED','AdminUser',$1,$2)", [ADMIN_EMAIL.toLowerCase(), ADMIN_ROLE]);
await c.end(); console.log(`Created ${ADMIN_ROLE} ${ADMIN_EMAIL}`);
