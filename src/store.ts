/** JSON persistence. The whole household fits comfortably in one file. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { emptyDb } from './domain/db.js';
import { MiseError } from './domain/errors.js';
import type { Database } from './domain/types.js';

export function defaultDbPath(): string {
  return resolve(process.env['MISE_DB'] ?? 'mise.db.json');
}

export function dbExists(path = defaultDbPath()): boolean {
  return existsSync(path);
}

export function loadDb(path = defaultDbPath()): Database {
  if (!existsSync(path)) {
    throw new MiseError(`No database at ${path}. Run \`mise init\` to create one.`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Database>;
  const base = emptyDb();
  // Merge onto an empty database so that a file written by an older version,
  // or hand-edited, still loads with every collection present. Settings are
  // merged *after* the top-level spread: spreading `parsed` last would put the
  // partial settings object back over the defaults and hand `undefined`
  // horizons and households to the planner.
  return {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings ?? {}) },
  } as Database;
}

/** Write atomically: a half-written pantry is worse than no pantry. */
export function saveDb(db: Database, path = defaultDbPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}
