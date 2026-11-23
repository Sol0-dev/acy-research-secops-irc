/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, ensureGoalHistory } from './state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env') });

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
}

export const config = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASSWORD'),
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

  const [auditIndex] = await pool.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'irc_audit'
       AND index_name = 'idx_audit_created_at'
     LIMIT 1`
  );
  if (auditIndex.length === 0) {
    await pool.query('CREATE INDEX idx_audit_created_at ON irc_audit (created_at)');
  }

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
  const historyBefore = Array.isArray(state.goalHistory)
    ? state.goalHistory.length
    : 0;
  ensureGoalHistory(state);
  if (state.goalHistory.length !== historyBefore) {
    const nextVersion = version + 1;
    await pool.query(
      'UPDATE irc_workspace SET state = ?, version = ? WHERE id = 1',
      [JSON.stringify(state), nextVersion]
    );
    cache = { state, version: nextVersion };
    return { state, version: nextVersion, seeded: false };
  }
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

// Read-only feed for the server-side leaderboard. The client never supplies
// points; the API computes them from these trusted audit rows.
export async function getLeaderboardEvents(from) {
  const [rows] = await pool.query(
    `SELECT id, version, action, actor, payload, created_at
     FROM irc_audit
     WHERE created_at >= ?
       AND actor IS NOT NULL
     ORDER BY created_at ASC, id ASC
     LIMIT 50000`,
    [from]
  );
  return rows.map((row) => {
    let payload = row.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    return {
      id: Number(row.id),
      version: Number(row.version),
      action: row.action,
      actor: row.actor,
      payload: payload ?? {},
      createdAt: row.created_at,
    };
  });
}

// Append an audit-only event without writing the workspace or bumping the
// version. Used for UI navigation events so agents' panel usage is visible in
// the admin audit log without creating state churn.
export async function appendAudit(action, actor, payload) {
  await pool.query(
    'INSERT INTO irc_audit (version, action, actor, payload) VALUES (?, ?, ?, ?)',
    [getVersion(), action, actor, JSON.stringify(payload ?? {})]
  );
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
