import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { DEFAULT_SETTINGS } from '../src/domain/db.js';
import { MiseError } from '../src/domain/errors.js';
import { loadDb, saveDb } from '../src/store.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mise-store-'));
}

test('a database round-trips through the store unchanged', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'db.json');
    const original = seedDatabase({ from: '2026-07-01' });
    saveDb(original, path);
    const reloaded = loadDb(path);

    assert.equal(reloaded.items.length, original.items.length);
    assert.equal(reloaded.recipes.length, original.recipes.length);
    assert.equal(reloaded.lots.length, original.lots.length);
    assert.deepEqual(reloaded.settings, original.settings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a partial settings block keeps the defaults for everything it omits', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'old.json');
    // A hand-edited or older file that only sets one thing.
    writeFileSync(path, JSON.stringify({ settings: { currency: 'EUR' }, items: [], recipes: [] }));
    const db = loadDb(path);

    assert.equal(db.settings.currency, 'EUR', 'what was set is honoured');
    assert.equal(db.settings.planningHorizonDays, DEFAULT_SETTINGS.planningHorizonDays);
    assert.deepEqual(db.settings.household, DEFAULT_SETTINGS.household);
    assert.equal(db.settings.overheadPerHour, DEFAULT_SETTINGS.overheadPerHour);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing collections are filled in rather than left undefined', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'sparse.json');
    writeFileSync(path, JSON.stringify({ items: [], recipes: [] }));
    const db = loadDb(path);

    assert.deepEqual(db.lots, []);
    assert.deepEqual(db.ledger, []);
    assert.deepEqual(db.mealPlan, []);
    assert.deepEqual(db.purchaseOrders, []);
    assert.deepEqual(db.productionOrders, []);
    assert.deepEqual(db.settings, DEFAULT_SETTINGS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing database says how to make one', () => {
  assert.throws(() => loadDb(join(scratch(), 'nope.json')), (error: unknown) => {
    assert.ok(error instanceof MiseError);
    assert.match(error.message, /mise init/);
    return true;
  });
});
