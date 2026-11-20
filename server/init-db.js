/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import 'dotenv/config';
import { initDb, pool } from './db.js';

const { seeded, version } = await initDb();
console.log(`central database ready (${seeded ? 'seeded initial workspace' : 'existing workspace loaded'}) — version ${version}`);
await pool.end();
