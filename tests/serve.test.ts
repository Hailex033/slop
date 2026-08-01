/**
 * The dev server, exercised as a process.
 *
 * These assertions only mean anything end-to-end: the defect they guard
 * against was an uncaught exception in the request handler, which does not
 * fail a function call — it takes the whole process down.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess;

before(async () => {
  server = spawn('node', [join(ROOT, 'scripts', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the listening line rather than sleeping a fixed amount.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 10_000);
    server.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('running at')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup with code ${code}`));
    });
  });
});

after(() => {
  server?.kill();
});

test('serves the page', async () => {
  const response = await fetch(`${BASE}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Mise/);
});

test('serves the compiled engine the page imports', async () => {
  assert.equal((await fetch(`${BASE}/dist/src/engine/explode.js`)).status, 200);
});

test('a malformed URL escape is a 400, not the end of the server', async () => {
  // `decodeURIComponent('%ZZ')` throws; before this was caught, one such
  // request killed the process and every other client with it.
  for (const path of ['/%ZZ', '/%E0%A4%A', '/web/%']) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 400, `${path} should be rejected, not fatal`);
  }

  // The point of the test: it is still answering afterwards.
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  assert.equal(server.exitCode, null, 'the server process is still alive');
});

test('paths outside the repository are refused', async () => {
  for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 404, `${path} must not escape the root`);
  }
});

test('an unknown path is a 404 and the server carries on', async () => {
  assert.equal((await fetch(`${BASE}/nope/missing.js`)).status, 404);
  assert.equal((await fetch(`${BASE}/`)).status, 200);
});
