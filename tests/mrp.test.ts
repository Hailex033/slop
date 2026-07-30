import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { receive } from '../src/engine/inventory.js';
import { commitProduction, runMrp } from '../src/engine/mrp.js';
import { close, nestedDb } from './helpers.js';

function planned(database: ReturnType<typeof nestedDb>, itemId: string, servings: number, date: string) {
  database.mealPlan.push({ id: `MP-${database.mealPlan.length + 1}`, date, slot: 'dinner', itemId, servings });
}

test('a shared ingredient is netted exactly once, at its deepest level', () => {
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-02');
  // 200 g of butter is needed in total: 100 via the roux, 100 via the crust.
  receive(database, 'butter', { qty: 150, on: '2026-07-01' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const butter = result.lines.filter((line) => line.itemId === 'butter');

  assert.equal(butter.length, 1, 'one line, not one per path');
  assert.equal(butter[0]!.level, 3);
  assert.ok(close(butter[0]!.gross, 200), `got ${butter[0]!.gross}`);
  assert.ok(close(butter[0]!.onHand, 150));
  assert.ok(close(butter[0]!.net, 50), 'net of everything already in the house');
});

test('phantoms pass demand straight through without being stocked or ordered', () => {
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-02');
  receive(database, 'roux', { qty: 500, on: '2026-07-01' }); // should be ignored

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const roux = result.lines.find((line) => line.itemId === 'roux')!;

  assert.equal(roux.action, 'phantom');
  assert.equal(roux.onHand, 0, 'a phantom never nets against stock');
  assert.ok(!result.production.some((order) => order.itemId === 'roux'));
  assert.ok(!result.purchases.some((order) => order.itemId === 'roux'));
  // ...but its components are still demanded.
  assert.ok(result.lines.some((line) => line.itemId === 'butter' && line.gross > 0));
});

test('stock of a made sub-recipe stops it being made again', () => {
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-02');
  receive(database, 'sauce', { qty: 1000, on: '2026-07-01' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const sauce = result.lines.find((line) => line.itemId === 'sauce')!;

  assert.equal(sauce.action, 'covered');
  assert.ok(!result.production.some((order) => order.itemId === 'sauce'));
  // And because the sauce is covered, nothing below it is demanded through
  // that branch: butter demand drops to the crust's 100 g.
  const butter = result.lines.find((line) => line.itemId === 'butter')!;
  assert.ok(close(butter.gross, 100), `got ${butter.gross}`);
});

test('safety stock is topped up on top of demand', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, safetyStock: 500 } : item,
  );
  planned(database, 'dish', 4, '2026-07-02');
  receive(database, 'cheese', { qty: 200, on: '2026-07-01' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;

  // 200 g needed + 500 g buffer - 200 g on hand.
  assert.ok(close(cheese.net, 500), `got ${cheese.net}`);
});

test('purchases are dated back by supplier lead time', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' && item.purchase
      ? { ...item, purchase: { ...item.purchase, leadTimeDays: 2 } }
      : item,
  );
  planned(database, 'dish', 4, '2026-07-10');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  const cheese = result.purchases.find((line) => line.itemId === 'cheese')!;

  assert.equal(cheese.neededOn, '2026-07-10');
  assert.equal(cheese.orderBy, '2026-07-08');
});

test('an order-by date never lands in the past', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' && item.purchase
      ? { ...item, purchase: { ...item.purchase, leadTimeDays: 30 } }
      : item,
  );
  planned(database, 'dish', 4, '2026-07-02');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.equal(result.purchases.find((line) => line.itemId === 'cheese')!.orderBy, '2026-07-01');
});

test('demand outside the horizon is not planned', () => {
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-08-30');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.equal(result.lines.length, 0);
});

test('production is scheduled to start before it is due when it takes long enough', () => {
  const database = seedDatabase({ from: '2026-07-01' });
  database.mealPlan = [
    { id: 'MP-1', date: '2026-07-08', slot: 'breakfast', itemId: 'sourdough', servings: 8 },
  ];

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  const loaf = result.production.find((order) => order.itemId === 'sourdough')!;

  // ~20 hours of proving and baking does not fit in one cooking day.
  assert.ok(loaf.startOn < loaf.dueOn, `${loaf.startOn} should precede ${loaf.dueOn}`);
});

test('a committed production order stops the same batch being planned twice', () => {
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-05');

  const first = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.equal(commitProduction(database, first).length, first.production.length);

  const second = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const dish = second.lines.find((line) => line.itemId === 'dish')!;

  assert.equal(dish.action, 'covered', 'already committed to cooking it');
  assert.ok(!second.production.some((order) => order.itemId === 'dish'));
});

test('replacing an item in place is seen by the next planning run', () => {
  // Guards the lookup-index cache: reassigning db.items with the same length
  // must not serve stale item definitions.
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-02');
  runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });

  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, safetyStock: 750 } : item,
  );

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;
  assert.ok(close(cheese.net, 950), `200 g demand + 750 g buffer, got ${cheese.net}`);
});

test('the example week produces both a shopping list and a cook list', () => {
  const database = seedDatabase({ from: '2026-07-01' });
  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });

  assert.ok(result.purchases.length > 0);
  assert.ok(result.production.length > 0);
  assert.deepEqual(result.problems, []);

  // Butter is genuinely reachable five ways in that dataset; still one line.
  assert.equal(result.lines.filter((line) => line.itemId === 'butter').length, 1);
});
