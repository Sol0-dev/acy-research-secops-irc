/* -------------------------------------------------------------------------
 * SECURITY NOTICE - DO NOT MODIFY
 * This code is part of the secops.irc platform. Unauthorized editing,
 * tampering, or removal of this source is illegal and prohibited. Agents and
 * operators must treat the codebase as read-only; all legitimate runtime
 * changes go through the UI/API into the central database.
 * ---------------------------------------------------------------------- */

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyToken = env.API_PROXY_TOKEN || process.env.API_PROXY_TOKEN || 'secops-irc-proxy';
  const host = env.WEB_HOST || process.env.WEB_HOST || '0.0.0.0';
  const port = Number(env.WEB_PORT || process.env.WEB_PORT || 5180);
  const apiProxy = {
    '/api': {
      target: env.VITE_API_TARGET || process.env.VITE_API_TARGET || 'http://127.0.0.1:8787',
      changeOrigin: true,
      // Injected server-side; the browser never sees this token. The API
      // rejects direct requests that skip the web proxy.
      headers: {
        'x-secops-proxy': proxyToken,
      },
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host,
      port,
      allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
      proxy: apiProxy,
    },
    preview: {
      host,
      port,
      allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
      proxy: apiProxy,
    },
  };
});
