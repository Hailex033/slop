import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { onHand, receive } from '../src/engine/inventory.js';
import { runMrp } from '../src/engine/mrp.js';
import { packsFor, shoppingList } from '../src/engine/procurement.js';
import { cookableNow, feasibility, prepSchedule, produce } from '../src/engine/production.js';
import { close, db, made, nestedDb, purchased, recipe } from './helpers.js';

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------

test('requirements round up to whole packs', () => {
  const database = db([
    purchased('butter', {
      purchase: { supplierId: 'shop', packQty: 250, packUom: 'g', packPrice: 2, leadTimeDays: 0 },
    }),
  ]);

  assert.equal(packsFor(database, 'butter', 300).packs, 2);
  assert.equal(packsFor(database, 'butter', 500).packs, 2, 'exactly two packs is two packs');
  assert.equal(packsFor(database, 'butter', 501).packs, 3);
  assert.equal(packsFor(database, 'butter', 1).packs, 1);
});

test('minimum order quantity overrides a smaller requirement', () => {
  const database = db([
    purchased('wine', {
      purchase: { supplierId: 'shop', packQty: 750, packUom: 'ml', packPrice: 7, leadTimeDays: 0, moqPacks: 6 },
      stockUom: 'ml',
    }),
  ]);
  assert.equal(packsFor(database, 'wine', 100).packs, 6);
});

test('the shopping list reports the leftover that rounding creates', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'dish', servings: 4 });

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const list = shoppingList(database, mrp);
  const butter = list.lines.find((line) => line.itemId === 'butter')!;

  // Needs 200 g, buys 2 × 100 g packs, no spare.
  assert.equal(butter.packs, 2);
  assert.ok(close(butter.leftover, 0));

  const cheese = list.lines.find((line) => line.itemId === 'cheese')!;
  assert.equal(cheese.packs, 2, '200 g needed from 100 g packs');
  assert.ok(list.total > 0);
});

test('the shopping list says what each line is for', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'dish', servings: 4 });

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const list = shoppingList(database, mrp);

  assert.deepEqual(list.lines.find((line) => line.itemId === 'butter')!.forDishes, ['dish']);
});

// ---------------------------------------------------------------------------
// Feasibility
// ---------------------------------------------------------------------------

test('feasibility pools a leaf used twice before comparing against stock', () => {
  const database = nestedDb();
  // Four servings need 200 g of butter in total: 100 g via sauce > roux, and
  // 100 g directly in the crust. Stock exactly that, and nothing else spare.
  receive(database, 'butter', { qty: 200 });
  receive(database, 'flour', { qty: 1000 });
  receive(database, 'cheese', { qty: 1000 });

  assert.ok(close(feasibility(database, 'dish', 4).servings, 4, 1e-6));

  // Butter alone is the binding constraint, and it binds on the *pooled*
  // requirement — not on either branch taken separately.
  database.lots = [];
  receive(database, 'butter', { qty: 100 });
  receive(database, 'flour', { qty: 10_000 });
  receive(database, 'cheese', { qty: 10_000 });
  const check = feasibility(database, 'dish', 4);
  assert.ok(close(check.servings, 2, 1e-6), `100 g of butter is two servings, got ${check.servings}`);
});

test('feasibility names what is missing and by how much', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 100 });
  receive(database, 'flour', { qty: 100 });

  const check = feasibility(database, 'dish', 4);
  const missing = new Map(check.missing.map((entry) => [entry.itemId, entry.short]));

  assert.ok(missing.has('cheese'));
  assert.ok(close(missing.get('cheese')!, 200));
  assert.ok(missing.has('flour'));
  assert.ok(close(missing.get('flour')!, 200), '300 g needed, 100 g in the house');
});

test('an empty pantry can cook nothing', () => {
  assert.deepEqual(cookableNow(nestedDb()), []);
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test('cooking issues the components and books in the output', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 1000, unitCost: 0.01 });
  receive(database, 'flour', { qty: 1000, unitCost: 0.01 });

  const result = produce(database, 'crust', 300, { on: '2026-07-01' });

  assert.equal(onHand(database, 'butter'), 900);
  assert.equal(onHand(database, 'flour'), 800);
  assert.equal(onHand(database, 'crust'), 300);
  assert.ok(close(result.cost, 3), `100 g + 200 g at £0.01, got ${result.cost}`);
  assert.ok(result.lotId);
});

test('a missing sub-recipe is cooked on the spot, recursively', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 1000, unitCost: 0.01 });
  receive(database, 'flour', { qty: 1000, unitCost: 0.01 });

  // Sauce needs roux, which is a phantom made of butter and flour. Nothing
  // but raw ingredients is in the house.
  const result = produce(database, 'sauce', 1000, { on: '2026-07-01' });

  assert.equal(onHand(database, 'sauce'), 1000);
  assert.equal(onHand(database, 'butter'), 900, 'the roux ate 100 g of butter');
  assert.equal(onHand(database, 'flour'), 900);
  assert.equal(onHand(database, 'roux'), 0, 'a phantom is never left in stock');
  assert.ok(close(result.cost, 2), `got ${result.cost}`);
});

test('a stocked sub-recipe short by some amount is topped up, not remade wholesale', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 1000, unitCost: 0.01 });
  receive(database, 'flour', { qty: 1000, unitCost: 0.01 });
  receive(database, 'cheese', { qty: 1000, unitCost: 0.01 });
  receive(database, 'sauce', { qty: 600, unitCost: 0.002 });
  receive(database, 'crust', { qty: 300, unitCost: 0.01 });

  produce(database, 'dish', 1500, { on: '2026-07-01' });

  // Needed 1000 g of sauce, had 600 g, so only 400 g was made: that is 80 g of
  // roux, which is 40 g of butter and 40 g of flour.
  assert.equal(onHand(database, 'sauce'), 0);
  assert.ok(close(onHand(database, 'butter'), 960), `got ${onHand(database, 'butter')}`);
  assert.ok(close(onHand(database, 'flour'), 960));
  assert.equal(onHand(database, 'dish'), 1500);
});

test('actual cost comes from the lots consumed, not the price list', () => {
  const database = nestedDb();
  // Bought cheap in a sale; the standard cost is £0.01/g.
  receive(database, 'butter', { qty: 1000, unitCost: 0.005 });
  receive(database, 'flour', { qty: 1000, unitCost: 0.005 });

  const result = produce(database, 'crust', 300, { on: '2026-07-01' });
  assert.ok(close(result.cost, 1.5), `got ${result.cost}`);

  const lot = database.lots.find((entry) => entry.itemId === 'crust')!;
  assert.ok(close(lot.unitCost ?? 0, 0.005));
});

test('shortages are reported rather than silently producing from nothing', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 10 });
  receive(database, 'flour', { qty: 10 });

  const result = produce(database, 'crust', 300, { on: '2026-07-01', allowShortages: true });
  const short = new Map(result.shortages.map((entry) => [entry.itemId, entry.short]));

  assert.ok(close(short.get('butter') ?? 0, 90));
  assert.ok(close(short.get('flour') ?? 0, 190));
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test('prep tasks within a day run deepest-first', () => {
  const database = seedDatabase({ from: '2026-07-01' });
  database.mealPlan = [{ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'lasagne', servings: 6 }];
  database.lots = [];

  const days = prepSchedule(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const flat = days.flatMap((day) => day.tasks);
  const positionOf = (id: string) => flat.findIndex((task) => task.itemId === id);

  assert.ok(positionOf('ragu') < positionOf('lasagne'), 'the ragù before the lasagne');
  assert.ok(positionOf('besciamella') < positionOf('lasagne'));
  assert.ok(positionOf('pasta-sheets') < positionOf('lasagne'));
});
