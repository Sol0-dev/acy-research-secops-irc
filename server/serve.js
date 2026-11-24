/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '..', '.env') });

const PORT = Number(process.env.WEB_PORT ?? 5180);
const HOST = process.env.WEB_HOST ?? '0.0.0.0';
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';
const PROXY_TOKEN = String(process.env.API_PROXY_TOKEN ?? '').trim();
const BODY_LIMIT = process.env.API_BODY_LIMIT ?? '32mb';
if (!PROXY_TOKEN) {
  console.error('[web] API_PROXY_TOKEN is required in .env');
  process.exit(1);
}

const dist = path.resolve(here, '../dist');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  return next();
});

// Proxy the API through the web origin so the browser never talks to the API
// port directly. The proxy token stays server-side.
app.use('/api', express.raw({ type: '*/*', limit: BODY_LIMIT }), async (req, res) => {
  try {
    const headers = {
      'x-secops-proxy': PROXY_TOKEN,
      'content-type': req.get('content-type') ?? 'application/json',
    };
    const authorization = req.get('authorization');
    if (authorization) headers.authorization = authorization;
    const admin = req.get('x-secops-admin');
    if (admin) headers['x-secops-admin'] = admin;

    const upstream = await fetch(`${API_URL}${req.originalUrl}`, {
      method: req.method,
      headers,
      body:
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : req.body && req.body.length
            ? req.body
            : undefined,
    });

    res.status(upstream.status);
    for (const header of ['content-type', 'content-disposition', 'retry-after']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (error) {
    return res.status(502).json({ error: `api unavailable: ${error.message}` });
  }
});

app.use(
  express.static(dist, {
    index: false,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(dist, 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[web] acy-research listening on http://${HOST}:${PORT} -> ${API_URL}`);
});

server.on('error', (error) => {
  console.error('[web] listen failed:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[web] unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[web] uncaught exception:', error);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[web] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  const force = setTimeout(() => process.exit(0), 8_000);
  if (typeof force.unref === 'function') force.unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
