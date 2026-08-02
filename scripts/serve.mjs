#!/usr/bin/env node
/**
 * A static file server with no dependencies, so `npm run web` works offline.
 * Serves exactly two trees: `web/` for the page, `dist/` for the engine that
 * the page imports as plain ES modules.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 4173);

// Only the public asset trees are served. The repository root also holds the
// CLI database (household names, meal plans, pantry), `.git/`, and source —
// none of which should be downloadable by whoever else is on the network.
const PUBLIC = ['/web/', '/dist/'];

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
  // Everything derived from the request is parsed inside the guard: a URL
  // built on `request.headers.host` throws on a hostile Host header (`[`)
  // *before* any later try could catch it, and an exception out of this
  // callback is an uncaught exception on the event loop — the whole process
  // gone. Only the path matters here, so parse against a fixed local base
  // and let one bad request cost its client a 400, not everyone the server.
  let requested;
  try {
    const url = new URL(request.url ?? '/', 'http://mise.local');
    requested = url.pathname === '/' ? '/web/index.html' : decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request: malformed URL\n');
    return;
  }

  // Normalise *before* the allowlist check, so `/web/../mise.db.json` is
  // judged as the `/mise.db.json` it resolves to, not by its prefix.
  const clean = normalize(requested);
  if (!PUBLIC.some((prefix) => clean.startsWith(prefix))) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${requested}\n`);
    return;
  }

  // Contain everything under the repository root.
  const target = resolve(ROOT, `.${clean}`);
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
