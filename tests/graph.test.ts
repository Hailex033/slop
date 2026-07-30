import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { validate } from '../src/domain/db.js';
import { findCycles, lowLevelCodes, planningOrder, recipeDepth, topLevelItems, whereUsed } from '../src/engine/graph.js';
import { db, made, nestedDb, purchased, recipe } from './helpers.js';

test('low-level code is the deepest appearance, not the first', () => {
  const codes = lowLevelCodes(nestedDb());

  assert.equal(codes.get('dish'), 0);
  assert.equal(codes.get('sauce'), 1);
  assert.equal(codes.get('crust'), 1);
  assert.equal(codes.get('roux'), 2);
  // Butter is used directly by the crust (level 2) and via the roux (level 3).
  // The deeper one wins, which is what stops MRP netting it twice.
  assert.equal(codes.get('butter'), 3);
});

test('planning order never places an item before something that contains it', () => {
  const database = nestedDb();
  const order = planningOrder(database);
  const position = new Map(order.map((id, index) => [id, index]));

  for (const parent of database.recipes) {
    for (const component of parent.components) {
      assert.ok(
        position.get(parent.outputItemId)! < position.get(component.itemId)!,
        `${parent.outputItemId} must be planned before ${component.itemId}`,
      );
    }
  }
});

test('where-used walks upward through every path', () => {
  const tree = whereUsed(nestedDb(), 'butter');
  const parents = tree.children.map((child) => child.itemId).sort();

  assert.deepEqual(parents, ['crust', 'roux']);
  const viaRoux = tree.children.find((child) => child.itemId === 'roux')!;
  assert.deepEqual(viaRoux.children.map((child) => child.itemId), ['sauce']);
  assert.equal(viaRoux.qtyPerBatch, 100);
});

test('top-level items are the things nothing else consumes', () => {
  assert.deepEqual(topLevelItems(nestedDb()), ['dish']);
});

test('recipe depth measures the tree below an item', () => {
  const database = nestedDb();
  assert.equal(recipeDepth(database, 'dish'), 3);
  assert.equal(recipeDepth(database, 'sauce'), 2);
  assert.equal(recipeDepth(database, 'butter'), 0);
});

test('cycles are reported rather than thrown, so doctor can list them all', () => {
  const database = db(
    [made('a'), made('b')],
    [
      recipe('a', 100, [{ itemId: 'b', qty: 10, uom: 'g' }]),
      recipe('b', 100, [{ itemId: 'a', qty: 10, uom: 'g' }]),
    ],
  );
  const cycles = findCycles(database);

  assert.equal(cycles.length, 1, 'the same loop found from two entry points is one cycle');
  assert.ok(cycles[0]!.path.length >= 2);
});

test('validation catches dangling references and impossible conversions', () => {
  const database = db(
    [purchased('flour', { stockUom: 'g' }), made('dough')],
    [
      recipe('dough', 100, [
        { itemId: 'flour', qty: 1, uom: 'cup' }, // no density on flour
        { itemId: 'ghost', qty: 1, uom: 'g' },
      ]),
    ],
  );
  const issues = validate(database);

  assert.ok(issues.some((issue) => issue.includes('ghost')));
  assert.ok(issues.some((issue) => issue.includes('densityGPerMl')));
});

test('the shipped example database is internally consistent', () => {
  const database = seedDatabase();
  assert.deepEqual(validate(database), []);
  assert.deepEqual(findCycles(database), []);
});
