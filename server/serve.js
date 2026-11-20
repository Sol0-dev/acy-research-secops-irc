/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.WEB_PORT ?? 5180);
const HOST = process.env.WEB_HOST ?? '0.0.0.0';
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';
const PROXY_TOKEN = process.env.API_PROXY_TOKEN ?? 'secops-irc-proxy';

const here = path.dirname(fileURLToPath(import.meta.url));
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
  return next();
});

// Proxy the API through the web origin so the browser never talks to the API
// port directly. The proxy token stays server-side.
app.use('/api', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
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
  return res.sendFile(path.join(dist, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`[web] acy-research listening on http://${HOST}:${PORT} -> ${API_URL}`);
});
