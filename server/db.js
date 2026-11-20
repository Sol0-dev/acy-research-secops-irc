import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createInitialState } from './state.js';

export const config = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'acy',
  password: process.env.DB_PASSWORD ?? 'acy_dev_password',
  database: process.env.DB_NAME ?? 'secops_irc',
};

const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

// The single canonical workspace row. Every command is persisted here before
// the API responds, so the client only ever receives DB-backed state.
let cache = null;

function parseState(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return JSON.parse(raw);
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'));
  return raw;
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS irc_workspace (
      id TINYINT NOT NULL PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 1,
      state JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS irc_audit (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      version BIGINT NOT NULL,
      action VARCHAR(64) NOT NULL,
      actor VARCHAR(64) NULL,
      payload JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await pool.query('SELECT state, version FROM irc_workspace WHERE id = 1');
  if (rows.length === 0) {
    const state = createInitialState();
    await pool.query(
      'INSERT INTO irc_workspace (id, version, state) VALUES (1, 1, ?)',
      [JSON.stringify(state)]
    );
    cache = { state, version: 1 };
    return { state, version: 1, seeded: true };
  }

  const state = parseState(rows[0].state);
  const version = Number(rows[0].version);
  cache = { state, version };
  return { state, version, seeded: false };
}

export function getState() {
  if (!cache) throw new Error('database has not been initialised');
  return cache.state;
}

export function getVersion() {
  if (!cache) throw new Error('database has not been initialised');
  return cache.version;
}

export async function getAudit(limit = 200) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const [rows] = await pool.query(
    `SELECT version, action, actor, payload, created_at
     FROM irc_audit
     ORDER BY id DESC
     LIMIT ${safeLimit}`
  );
  return rows.map((row) => ({
    version: Number(row.version),
    action: row.action,
    actor: row.actor,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

function stampProgress(nextState, version) {
  if (!nextState || !nextState.progress) return;
  for (const log of Object.values(nextState.progress)) {
    if (!log || !Array.isArray(log.entries)) continue;
    let stamped = false;
    for (const entry of log.entries) {
      if (entry.version && entry.version > 0) continue;
      entry.version = version;
      stamped = true;
      if (entry.commit && !entry.commit.hash) entry.commit.hash = `v${version}`;
    }
    if (stamped) log.headVersion = version;
  }
}

function stampReports(nextState, version) {
  if (!nextState || !nextState.reports) return;
  for (const list of Object.values(nextState.reports)) {
    if (!Array.isArray(list)) continue;
    for (const report of list) {
      if (!report.version) report.version = version;
    }
  }
}

export async function persistState(nextState, action, actor, payload) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      'SELECT version FROM irc_workspace WHERE id = 1 FOR UPDATE'
    );
    const version = Number(rows[0]?.version ?? 0) + 1;

    // Progress entries are appended before the command commits, so stamp them
    // with the exact workspace version this write creates.
    stampProgress(nextState, version);
    stampReports(nextState, version);

    await connection.query(
      'UPDATE irc_workspace SET state = ?, version = ?, updated_at = NOW() WHERE id = 1',
      [JSON.stringify(nextState), version]
    );
    await connection.query(
      'INSERT INTO irc_audit (version, action, actor, payload) VALUES (?, ?, ?, ?)',
      [version, action, actor, JSON.stringify(payload ?? {})]
    );
    await connection.commit();
    cache = { state: nextState, version };
    return version;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function ping() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    return true;
  } finally {
    connection.release();
  }
}

export { pool };
