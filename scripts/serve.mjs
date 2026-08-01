#!/usr/bin/env node
/**
 * A static file server with no dependencies, so `npm run web` works offline.
 * Serves the repository root: `web/` for the page, `dist/` for the engine that
 * the page imports as plain ES modules.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

  // `decodeURIComponent` throws on a malformed escape like `/%ZZ`, and an
  // exception thrown out of this callback is an uncaught exception on the
  // event loop — which takes the whole process down. One bad request should
  // cost the client a 400, not everyone else the server.
  let requested;
  try {
    requested = url.pathname === '/' ? '/web/index.html' : decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request: malformed URL escape\n');
    return;
  }

  // Contain everything under the repository root.
  const target = resolve(ROOT, `.${normalize(requested)}`);
  if (!target.startsWith(ROOT) || !existsSync(target) || statSync(target).isDirectory()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${requested}\n`);
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(response);
});

server.listen(PORT, () => {
  if (!existsSync(join(ROOT, 'dist', 'web', 'app.js'))) {
    process.stdout.write('! dist/web/app.js is missing — run `npm run build` first.\n');
  }
  process.stdout.write(`mise is running at http://localhost:${PORT}\n`);
});
