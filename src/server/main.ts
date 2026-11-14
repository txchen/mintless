import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApi } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { defaultProviders } from './providers.ts';
import { startScheduler } from './scheduler.ts';
import { markInterruptedRuns, type SyncDeps } from './sync/engine.ts';

process.umask(0o077);
const config = loadConfig();
const db = openDb(config.dbPath);
markInterruptedRuns(db);
const sync: SyncDeps = { db, masterKey: config.masterKey, providerFor: defaultProviders };
const api = createApi({
  db,
  masterKey: config.masterKey,
  sessionTtlMs: config.sessionTtlMs,
  sync,
  now: Date.now,
});
const apiListener = getRequestListener(api.fetch);
const isApi = (req: IncomingMessage) => req.url === '/api' || Boolean(req.url?.startsWith('/api/'));

const server = createServer();
let webListener: (req: IncomingMessage, res: ServerResponse) => void;

if (config.dev) {
  const { createServer: createVite } = await import('vite-plus');
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server }, allowedHosts: config.devAllowedHosts },
    appType: 'spa',
  });
  webListener = (req, res) => vite.middlewares(req, res);
} else {
  const root = resolve(import.meta.dirname, '../../dist/web');
  const index = await readFile(resolve(root, 'index.html'), 'utf8');
  const web = new Hono()
    .use(
      '/assets/*',
      serveStatic({
        root,
        onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable'),
      }),
    )
    .use(serveStatic({ root }))
    .get('*', (c) => c.html(index, 200, { 'cache-control': 'no-cache' }));
  webListener = getRequestListener(web.fetch);
}

server.on('request', (req, res) => (isApi(req) ? apiListener(req, res) : webListener(req, res)));
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE' ? `Port ${config.port} on ${config.host} is already in use` : error,
  );
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(
    `Mintless listening on http://${config.host}:${config.port} (${config.dev ? 'development' : 'production'})`,
  );
});

const stopScheduler = startScheduler(sync, config.syncIntervalMs);
const shutdown = () => {
  stopScheduler();
  server.close(() => {
    db.sqlite.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
