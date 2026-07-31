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

test('a committed production order still demands its own components', () => {
  // A firm order is supply to its parent and demand to its children. Treating
  // it as supply only would let `mrp --commit` quietly empty the shopping list,
  // because every level would look covered while nothing had been bought.
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-05');

  const before = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const boughtBefore = before.purchases.map((line) => line.itemId).sort();
  assert.ok(boughtBefore.length > 0, 'the fixture starts with an empty pantry');

  commitProduction(database, before);
  const after = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });

  assert.deepEqual(
    after.purchases.map((line) => line.itemId).sort(),
    boughtBefore,
    'committing what to cook must not change what has to be bought',
  );
  for (const itemId of boughtBefore) {
    const cheap = before.purchases.find((line) => line.itemId === itemId)!;
    const firm = after.purchases.find((line) => line.itemId === itemId)!;
    assert.ok(close(firm.qty, cheap.qty), `${itemId}: ${firm.qty} vs ${cheap.qty}`);
  }
});

test('committing twice does not double the ingredient demand', () => {
  const database = nestedDb();
  planned(database, 'dish', 4, '2026-07-05');

  const first = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  commitProduction(database, first);
  const second = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  commitProduction(database, second); // second run plans nothing, so nothing is added

  const third = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const butterFirst = first.lines.find((line) => line.itemId === 'butter')!;
  const butterThird = third.lines.find((line) => line.itemId === 'butter')!;

  assert.ok(close(butterThird.gross, butterFirst.gross), `${butterThird.gross} vs ${butterFirst.gross}`);
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

test('safety stock is rebuilt even with nothing planned', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, safetyStock: 300 } : item,
  );
  // No meal plan, no orders, empty pantry: the buffer alone is the demand.
  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const cheese = result.purchases.find((line) => line.itemId === 'cheese');

  assert.ok(cheese, 'a depleted buffer is a requirement in its own right');
  assert.ok(close(cheese.qty, 300));

  receive(database, 'cheese', { qty: 300, on: '2026-07-01' });
  const topped = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(!topped.purchases.some((line) => line.itemId === 'cheese'), 'and stops once it is full');
});

test('expired stock is not counted as supply', () => {
  const database = nestedDb();
  planned(database, 'cheese', 200, '2026-07-10');
  receive(database, 'cheese', { qty: 500, on: '2026-07-01', expiresOn: '2026-07-05' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;

  assert.equal(cheese.onHand, 0, 'the cheese is off by the time it is wanted');
  assert.ok(close(cheese.net, 200));
});

test('stock still good on the day it is needed does count', () => {
  const database = nestedDb();
  planned(database, 'cheese', 200, '2026-07-04');
  receive(database, 'cheese', { qty: 500, on: '2026-07-01', expiresOn: '2026-07-05' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  assert.equal(result.lines.find((line) => line.itemId === 'cheese')!.action, 'covered');
});

test('purchases land on a day the supplier is actually open', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Saturday market', leadTimeDays: 0, deliveryDays: [6] }];
  // 2026-07-15 is a Wednesday; the Saturday before it is the 11th.
  planned(database, 'cheese', 200, '2026-07-15');

  const result = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  const cheese = result.purchases.find((line) => line.itemId === 'cheese')!;

  assert.equal(cheese.orderBy, '2026-07-11');
  assert.equal(cheese.late, false);
  assert.deepEqual(result.conflicts, []);
});

test('an unreachable shopping day is reported as a conflict, not hidden', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Saturday market', leadTimeDays: 0, deliveryDays: [6] }];
  // Needed Thursday, with no Saturday in between.
  planned(database, 'cheese', 200, '2026-07-09');

  const result = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  const cheese = result.purchases.find((line) => line.itemId === 'cheese')!;

  assert.equal(cheese.late, true);
  assert.equal(cheese.orderBy, '2026-07-11', 'the next actual market day');
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]!, /cannot supply it in time/);
  assert.deepEqual(result.problems, [], 'a shop being shut is not a data error');
});

test('an expiring lot covers the meal before it, not the one after', () => {
  const database = nestedDb();
  planned(database, 'cheese', 200, '2026-07-02');
  planned(database, 'cheese', 200, '2026-07-10');
  receive(database, 'cheese', { qty: 400, on: '2026-07-01', expiresOn: '2026-07-05' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;

  assert.ok(close(cheese.gross, 400));
  assert.ok(close(cheese.onHand, 200), `only the 2 July meal can use it, got ${cheese.onHand}`);
  assert.ok(close(cheese.net, 200), `the 10 July meal still needs buying, got ${cheese.net}`);
  assert.equal(result.purchases.find((line) => line.itemId === 'cheese')!.neededOn, '2026-07-10');
});

test('an earlier meal gets first call on food that is about to turn', () => {
  const database = nestedDb();
  planned(database, 'cheese', 300, '2026-07-02');
  planned(database, 'cheese', 300, '2026-07-20');
  // 300 g that keeps, and 300 g that does not.
  receive(database, 'cheese', { qty: 300, on: '2026-07-01' });
  receive(database, 'cheese', { qty: 300, on: '2026-07-01', expiresOn: '2026-07-05' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;

  // FEFO across dates: the perishable 300 g goes to the 2 July meal, the
  // keeping 300 g to the 20 July one, and nothing needs buying.
  assert.ok(close(cheese.onHand, 600), `got ${cheese.onHand}`);
  assert.equal(cheese.action, 'covered');
});

test('a delivery is supply only from the day it arrives', () => {
  const database = nestedDb();
  planned(database, 'cheese', 200, '2026-07-02');
  planned(database, 'cheese', 200, '2026-07-20');
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-07-01',
    expectedOn: '2026-07-10',
    status: 'open',
    lines: [{ itemId: 'cheese', packs: 4, unitPrice: 1 }],
  });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;

  assert.ok(close(cheese.onOrder, 200), 'only the later meal can use the delivery');
  assert.ok(close(cheese.net, 200), 'the 2 July meal is still short');
  assert.equal(result.purchases.find((line) => line.itemId === 'cheese')!.neededOn, '2026-07-02');
});

test('a perishable short on two distant dates becomes two shopping trips', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 2 } : item,
  );
  planned(database, 'cheese', 100, '2026-07-02');
  planned(database, 'cheese', 100, '2026-07-06');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  const buys = result.purchases.filter((line) => line.itemId === 'cheese');

  assert.equal(buys.length, 2, 'one trip cannot cover both meals');
  assert.deepEqual(buys.map((line) => line.neededOn), ['2026-07-02', '2026-07-06']);
  assert.ok(close(buys[0]!.qty, 100));
  assert.ok(close(buys[1]!.qty, 100));
});

test('shortfalls within the shelf life are still bought in one go', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 7 } : item,
  );
  planned(database, 'cheese', 100, '2026-07-02');
  planned(database, 'cheese', 100, '2026-07-06');

  const buys = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 }).purchases.filter(
    (line) => line.itemId === 'cheese',
  );

  assert.equal(buys.length, 1, 'it keeps long enough to buy once');
  assert.ok(close(buys[0]!.qty, 200));
  assert.equal(buys[0]!.neededOn, '2026-07-02');
});

test('an item with no shelf life is always bought in one go', () => {
  const database = nestedDb();
  planned(database, 'cheese', 100, '2026-07-02');
  planned(database, 'cheese', 100, '2026-08-20');

  const buys = runMrp(database, { asOf: '2026-07-01', horizonDays: 90 }).purchases.filter(
    (line) => line.itemId === 'cheese',
  );

  assert.equal(buys.length, 1);
  assert.ok(close(buys[0]!.qty, 200));
});

test('a perishable sub-recipe short twice is cooked twice', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'sauce' ? { ...item, shelfLifeDays: 3 } : item,
  );
  planned(database, 'sauce', 1000, '2026-07-02');
  planned(database, 'sauce', 1000, '2026-07-12');

  const batches = runMrp(database, { asOf: '2026-07-01', horizonDays: 20 }).production.filter(
    (order) => order.itemId === 'sauce',
  );

  assert.equal(batches.length, 2, 'you cannot cook the 12th’s sauce on the 2nd');
  assert.deepEqual(batches.map((order) => order.dueOn), ['2026-07-02', '2026-07-12']);
});

test('a delivery of a perishable stops being supply when it would spoil', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 2 } : item,
  );
  planned(database, 'cheese', 200, '2026-07-06');
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-07-02',
    expectedOn: '2026-07-02',
    status: 'open',
    lines: [{ itemId: 'cheese', packs: 2, unitPrice: 1 }],
  });

  const cheese = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 }).lines.find(
    (line) => line.itemId === 'cheese',
  )!;

  // Received on the 2nd it becomes a lot expiring the 4th, so it cannot feed
  // a meal on the 6th — inbound supply is perishable too.
  assert.equal(cheese.onOrder, 0);
  assert.ok(close(cheese.net, 200));
});

test('a delivery that lands in time is still credited', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 5 } : item,
  );
  planned(database, 'cheese', 200, '2026-07-06');
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-07-02',
    expectedOn: '2026-07-02',
    status: 'open',
    lines: [{ itemId: 'cheese', packs: 2, unitPrice: 1 }],
  });

  const cheese = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 }).lines.find(
    (line) => line.itemId === 'cheese',
  )!;

  assert.ok(close(cheese.onOrder, 200), 'good until the 7th, wanted on the 6th');
  assert.equal(cheese.action, 'covered');
});

test('a lot booked in for a future date is not supply today', () => {
  const database = nestedDb();
  planned(database, 'cheese', 200, '2026-07-05');
  receive(database, 'cheese', { qty: 500, on: '2026-07-10' });

  const cheese = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 }).lines.find(
    (line) => line.itemId === 'cheese',
  )!;

  assert.equal(cheese.onHand, 0, 'it has not arrived yet');
  assert.ok(close(cheese.net, 200));
});

test('a lot that has already arrived still counts', () => {
  const database = nestedDb();
  planned(database, 'cheese', 200, '2026-07-05');
  receive(database, 'cheese', { qty: 500, on: '2026-07-04' });

  const cheese = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 }).lines.find(
    (line) => line.itemId === 'cheese',
  )!;

  assert.ok(close(cheese.onHand, 200));
  assert.equal(cheese.action, 'covered');
});

test('production that should have started already is reported, not back-dated', () => {
  const database = nestedDb();
  database.recipes = database.recipes.map((recipe) =>
    recipe.outputItemId === 'sauce'
      ? { ...recipe, steps: [{ text: 'reduce', passiveMin: 600 }] }
      : recipe,
  );
  // A ten-hour recipe wanted today cannot fit in the eight-hour day it has.
  planned(database, 'sauce', 1000, '2026-07-01');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const batch = result.production.find((order) => order.itemId === 'sauce')!;

  assert.ok(batch.startOn >= '2026-07-01', 'no prep task on a day that has gone');
  assert.ok(
    result.conflicts.some((conflict) => conflict.includes('sauce')),
    `the impossible deadline must be surfaced: ${JSON.stringify(result.conflicts)}`,
  );
});

test('production that comfortably fits raises no conflict', () => {
  const database = nestedDb();
  planned(database, 'sauce', 1000, '2026-07-05');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.deepEqual(result.conflicts, []);
});

test('a phantom needed on two dates carries each date down to its ingredients', () => {
  const database = nestedDb();
  // The sauce keeps two days, so its two meals are two separate cookings, each
  // needing its own roux. Butter is perishable here so that the two resulting
  // demands stay visible as two orders rather than merging — a keeping
  // ingredient would rightly be bought once.
  database.items = database.items.map((item) => {
    if (item.id === 'sauce') return { ...item, shelfLifeDays: 2 };
    if (item.id === 'butter') return { ...item, shelfLifeDays: 3 };
    return item;
  });
  planned(database, 'sauce', 1000, '2026-07-02');
  planned(database, 'sauce', 1000, '2026-07-20');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 });
  const butter = result.purchases.filter((line) => line.itemId === 'butter');

  assert.equal(butter.length, 2, 'the roux is made twice, so butter is wanted twice');
  assert.deepEqual(butter.map((line) => line.neededOn), ['2026-07-02', '2026-07-20']);
});

test('a fixed component under a phantom is counted once per making', () => {
  const database = nestedDb();
  database.items = [
    ...database.items,
    { id: 'salt', name: 'salt', category: 'Test', sourcing: 'purchased', stockUom: 'g',
      purchase: { supplierId: 'shop', packQty: 100, packUom: 'g', packPrice: 1, leadTimeDays: 0 } },
  ];
  database.items = database.items.map((item) =>
    item.id === 'sauce' ? { ...item, shelfLifeDays: 2 } : item,
  );
  database.recipes = database.recipes.map((recipe) =>
    recipe.outputItemId === 'roux'
      ? { ...recipe, components: [...recipe.components, { itemId: 'salt', qty: 5, uom: 'g' as const, scalable: false }] }
      : recipe,
  );
  planned(database, 'sauce', 1000, '2026-07-02');
  planned(database, 'sauce', 1000, '2026-07-20');

  const salt = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 }).lines.find(
    (line) => line.itemId === 'salt',
  )!;

  // Two separate rouxs, each needing its own fixed pinch.
  assert.ok(close(salt.gross, 10), `got ${salt.gross}`);
});

test('a phantom needed once is still exploded once', () => {
  const database = nestedDb();
  planned(database, 'sauce', 1000, '2026-07-02');

  const butter = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 }).purchases.filter(
    (line) => line.itemId === 'butter',
  );
  assert.equal(butter.length, 1);
});

test('a buffer that is already short is wanted today, not on the last day', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, safetyStock: 300 } : item,
  );

  const buy = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }).purchases.find(
    (line) => line.itemId === 'cheese',
  )!;

  assert.equal(buy.neededOn, '2026-07-01', 'an empty buffer is empty now');
  assert.equal(buy.orderBy, '2026-07-01');
});

test('a buffer that is intact is only a floor on the closing balance', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, safetyStock: 300 } : item,
  );
  receive(database, 'cheese', { qty: 300, on: '2026-06-30' });
  planned(database, 'cheese', 200, '2026-07-03');

  const buy = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }).purchases.find(
    (line) => line.itemId === 'cheese',
  )!;

  // The buffer is fine today; what is missing is the 200 g eaten on the 3rd,
  // which has to be back before the horizon closes.
  assert.ok(close(buy.qty, 200), `got ${buy.qty}`);
  assert.equal(buy.neededOn, '2026-07-07');
});

test('the example week produces both a shopping list and a cook list', () => {
  const database = seedDatabase({ from: '2026-07-01' });
  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });

  assert.ok(result.purchases.length > 0);
  assert.ok(result.production.length > 0);
  assert.deepEqual(result.problems, [], 'every item is sourceable');

  // Butter is genuinely reachable five ways in that dataset; still one line.
  assert.equal(result.lines.filter((line) => line.itemId === 'butter').length, 1);
});
