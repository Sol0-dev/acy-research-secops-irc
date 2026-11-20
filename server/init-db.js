import 'dotenv/config';
import { initDb, pool } from './db.js';

const { seeded, version } = await initDb();
console.log(`central database ready (${seeded ? 'seeded initial workspace' : 'existing workspace loaded'}) — version ${version}`);
await pool.end();
