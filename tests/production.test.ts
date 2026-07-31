import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { onHand, receive } from '../src/engine/inventory.js';
import { runMrp } from '../src/engine/mrp.js';
import { packsFor, raisePurchaseOrders, shoppingList } from '../src/engine/procurement.js';
import { cookableNow, feasibility, prepSchedule, produce, serve } from '../src/engine/production.js';
import { MiseError, ShortageError } from '../src/domain/errors.js';
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

test('a purchase order is stamped for the day the shop is actually open', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Saturday market', leadTimeDays: 0, deliveryDays: [6] }];
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-09', slot: 'dinner', itemId: 'cheese', servings: 200 });

  const mrp = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  const list = shoppingList(database, mrp);
  const [order] = raisePurchaseOrders(database, list, '2026-07-06');

  // The Thursday meal cannot be supplied; the next market day is Saturday 11th.
  assert.ok(order);
  assert.equal(order.expectedOn, '2026-07-11');

  // And committing must not make the conflict disappear: the delivery still
  // lands after the meal, so the next run says so just as loudly.
  const after = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  assert.equal(after.lines.find((line) => line.itemId === 'cheese')!.onOrder, 0);
  assert.equal(after.conflicts.length, 1);
});

test('one purchase order per trip, not per supplier', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Shop', leadTimeDays: 0 }];
  database.mealPlan.push(
    { id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'cheese', servings: 200 },
    { id: 'MP-2', date: '2026-07-20', slot: 'dinner', itemId: 'butter', servings: 200 },
  );

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 });
  const orders = raisePurchaseOrders(database, shoppingList(database, mrp), '2026-07-01');

  assert.equal(orders.length, 2, 'two different shopping days are two orders');
  assert.deepEqual(orders.map((order) => order.expectedOn).sort(), ['2026-07-03', '2026-07-20']);
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

test('a sub-recipe already in the fridge counts as itself, not its ingredients', () => {
  const database = nestedDb();
  // Everything the dish needs, but only as finished sub-recipes: no butter or
  // flour in the house at all. `produce` would issue these happily, so
  // feasibility must not insist on the raw ingredients behind them.
  receive(database, 'sauce', { qty: 1000 });
  receive(database, 'crust', { qty: 300 });
  receive(database, 'cheese', { qty: 200 });

  const check = feasibility(database, 'dish', 4);

  assert.deepEqual(check.missing, []);
  assert.ok(close(check.servings, 4, 1e-3), `got ${check.servings}`);
});

test('partial sub-recipe stock falls back to making up the difference', () => {
  const database = nestedDb();
  receive(database, 'sauce', { qty: 500 }); // half of what four servings need
  receive(database, 'cheese', { qty: 200 });
  receive(database, 'butter', { qty: 150 }); // 50 g for the missing sauce, 100 g for the crust
  receive(database, 'flour', { qty: 250 }); // 50 g via the roux, 200 g in the crust

  const check = feasibility(database, 'dish', 4);

  assert.deepEqual(check.missing, [], 'the shortfall is coverable from raw ingredients');
  assert.ok(close(check.servings, 4, 1e-3), `got ${check.servings}`);
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
  receive(database, 'butter', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'flour', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });

  const result = produce(database, 'crust', 300, { on: '2026-07-01' });

  assert.equal(onHand(database, 'butter'), 900);
  assert.equal(onHand(database, 'flour'), 800);
  assert.equal(onHand(database, 'crust'), 300);
  assert.ok(close(result.cost, 3), `100 g + 200 g at £0.01, got ${result.cost}`);
  assert.ok(result.lotId);
});

test('a missing sub-recipe is cooked on the spot, recursively', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'flour', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });

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
  receive(database, 'butter', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'flour', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 1000, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'sauce', { qty: 600, unitCost: 0.002, on: '2026-06-30' });
  receive(database, 'crust', { qty: 300, unitCost: 0.01, on: '2026-06-30' });

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
  receive(database, 'butter', { qty: 1000, unitCost: 0.005, on: '2026-06-30' });
  receive(database, 'flour', { qty: 1000, unitCost: 0.005, on: '2026-06-30' });

  const result = produce(database, 'crust', 300, { on: '2026-07-01' });
  assert.ok(close(result.cost, 1.5), `got ${result.cost}`);

  const lot = database.lots.find((entry) => entry.itemId === 'crust')!;
  assert.ok(close(lot.unitCost ?? 0, 0.005));
});

test('shortages are reported rather than silently producing from nothing', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 10, on: '2026-06-30' });
  receive(database, 'flour', { qty: 10, on: '2026-06-30' });

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

test('feasibility ignores stock that has gone off', () => {
  const database = nestedDb();
  receive(database, 'sauce', { qty: 1000, on: '2026-07-01', expiresOn: '2026-07-05' });
  receive(database, 'crust', { qty: 300, on: '2026-07-01' });
  receive(database, 'cheese', { qty: 200, on: '2026-07-01' });

  assert.ok(close(feasibility(database, 'dish', 4, '2026-07-03').servings, 4, 1e-3));
  // A week later the sauce is off and there is nothing to make more from.
  assert.ok(feasibility(database, 'dish', 4, '2026-07-10').servings < 0.01);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a shortage below a phantom is refused, exactly as one above it would be', () => {
  const database = nestedDb();
  // Sauce reaches butter and flour through the roux, which is a phantom.
  // Passing through a phantom must not quietly relax the shortage policy.
  assert.throws(() => produce(database, 'sauce', 1000, { on: '2026-07-01' }), ShortageError);
  assert.equal(onHand(database, 'sauce'), 0, 'nothing was booked in');
});

test('a failed production leaves the pantry exactly as it found it', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 500, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, unitCost: 0.01, on: '2026-06-30' });
  // No cheese, so the dish fails — but only after butter and flour have been
  // issued to the sauce and the crust.
  const ledgerBefore = database.ledger.length;

  assert.throws(() => produce(database, 'dish', 1500, { on: '2026-07-01' }), ShortageError);

  assert.equal(onHand(database, 'butter'), 500, 'the butter is back');
  assert.equal(onHand(database, 'flour'), 500);
  assert.equal(onHand(database, 'sauce'), 0, 'and the half-made sauce is gone');
  assert.equal(database.ledger.length, ledgerBefore, 'the ledger records nothing that did not happen');
});

test('shortages are still reported rather than thrown when asked for', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 10 });

  const result = produce(database, 'sauce', 1000, { on: '2026-07-01', allowShortages: true });
  assert.ok(result.shortages.length > 0);
  assert.equal(onHand(database, 'sauce'), 1000, 'the cook pressed on regardless');
});

test('a failed serve leaves the pantry exactly as it found it', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 500, unitCost: 0.01, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, unitCost: 0.01, on: '2026-06-30' });
  // No cheese, so cooking the dish to serve it fails part-way through.
  const ledgerBefore = database.ledger.length;

  assert.throws(() => serve(database, 'dish', 4, { on: '2026-07-01' }), ShortageError);

  assert.equal(onHand(database, 'butter'), 500, 'cook-and-serve rolls back as one unit');
  assert.equal(onHand(database, 'flour'), 500);
  assert.equal(onHand(database, 'sauce'), 0);
  assert.equal(database.ledger.length, ledgerBefore);
});

test('a purchase order arrives on the lead time the plan was made with', () => {
  const database = nestedDb();
  // The supplier is slow by default, but this item can be had the same day.
  database.suppliers = [{ id: 'shop', name: 'Shop', leadTimeDays: 3 }];
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-05', slot: 'dinner', itemId: 'cheese', servings: 200 });

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 14 });
  const planned = mrp.purchases.find((line) => line.itemId === 'cheese')!;
  const [order] = raisePurchaseOrders(database, shoppingList(database, mrp), '2026-07-01');

  assert.ok(order);
  assert.equal(planned.late, false, 'the item itself has no lead time');
  assert.ok(
    order.expectedOn <= planned.neededOn,
    `committed arrival ${order.expectedOn} must not fall after ${planned.neededOn}`,
  );
});

test('feasibility ignores stock that has not arrived yet', () => {
  const database = nestedDb();
  receive(database, 'sauce', { qty: 1000, on: '2026-07-10' });
  receive(database, 'crust', { qty: 300, on: '2026-07-10' });
  receive(database, 'cheese', { qty: 200, on: '2026-07-10' });

  assert.equal(feasibility(database, 'dish', 4, '2026-07-01').servings, 0, 'none of it is here yet');
  assert.ok(close(feasibility(database, 'dish', 4, '2026-07-10').servings, 4, 1e-3));
});

test('a multi-batch run is scheduled for the work it actually is', () => {
  const database = db(
    [purchased('flour', {
      purchase: { supplierId: 'shop', packQty: 1000, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
    }), made('loaf')],
    [
      recipe('loaf', 100, [{ itemId: 'flour', qty: 100, uom: 'g' }], {
        steps: [{ text: 'work', activeMin: 60 }, { text: 'rest', passiveMin: 240 }],
      }),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-20', slot: 'dinner', itemId: 'loaf', servings: 20 });

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 });
  const run = mrp.production.find((order) => order.itemId === 'loaf')!;

  // Twenty batches: hands-on time multiplies, the rest happens in parallel.
  assert.ok(close(run.activeMin, 20 * 60), `got ${run.activeMin}`);
  assert.ok(close(run.passiveMin, 240), 'twenty loaves rest in the same four hours');
  assert.ok(close(run.minutes, 1440));
  // 1440 minutes is three eight-hour days, so it cannot start on the due date.
  assert.equal(run.startOn, '2026-07-18');

  const day = prepSchedule(database, mrp).find((entry) => entry.date === '2026-07-18')!;
  assert.ok(close(day.activeMin, 1200), 'the prep sheet shows the real workload');
});

test('a single-batch run is unchanged', () => {
  const database = db(
    [purchased('flour', {
      purchase: { supplierId: 'shop', packQty: 1000, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
    }), made('loaf')],
    [
      recipe('loaf', 100, [{ itemId: 'flour', qty: 100, uom: 'g' }], {
        steps: [{ text: 'work', activeMin: 60 }, { text: 'rest', passiveMin: 240 }],
      }),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-20', slot: 'dinner', itemId: 'loaf', servings: 1 });

  const run = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 }).production.find(
    (order) => order.itemId === 'loaf',
  )!;

  assert.ok(close(run.activeMin, 60));
  assert.ok(close(run.minutes, 300));
  assert.equal(run.startOn, '2026-07-20', 'five hours fits in the day it is due');
});

// ---------------------------------------------------------------------------
// Cooking is not the same question as eating
// ---------------------------------------------------------------------------

function loafDb() {
  const database = db(
    [
      purchased('flour', {
        purchase: { supplierId: 'shop', packQty: 1000, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
      }),
      made('loaf'),
    ],
    [
      recipe('loaf', 100, [{ itemId: 'flour', qty: 100, uom: 'g' }], {
        steps: [{ text: 'work', activeMin: 30 }, { text: 'rest', passiveMin: 60 }],
      }),
    ],
  );
  return database;
}

test('a finished dish in the tin does not make it cookable', () => {
  const database = loafDb();
  // Four loaves baked, not a gram of flour left.
  receive(database, 'loaf', { qty: 400, on: '2026-07-01' });

  assert.deepEqual(
    cookableNow(database, 1, '2026-07-02'),
    [],
    'you cannot cook a loaf out of a loaf',
  );
  // The dish is still there to be eaten — that is a different question.
  assert.equal(onHand(database, 'loaf'), 400);
});

test('ingredients in the house do make it cookable', () => {
  const database = loafDb();
  receive(database, 'flour', { qty: 400, on: '2026-07-01' });

  const options = cookableNow(database, 1, '2026-07-02');
  assert.equal(options.length, 1);
  assert.ok(close(options[0]!.servings, 4, 1e-3));
});

test('cooking without forcing refuses when the ingredients are gone', () => {
  const database = loafDb();
  receive(database, 'loaf', { qty: 400, on: '2026-07-01' });

  // This is what the web Cook button now does.
  assert.throws(() => produce(database, 'loaf', 100, { on: '2026-07-02' }), ShortageError);
  assert.equal(onHand(database, 'loaf'), 400, 'no lot conjured out of nothing');
});

test('cooking reports the duration of the run, not of one batch', () => {
  const database = loafDb();
  receive(database, 'flour', { qty: 5000, on: '2026-07-01' });

  const result = produce(database, 'loaf', 500, { on: '2026-07-02' });
  // Five batches: 5 x 30 minutes hands-on, plus one 60-minute rest.
  assert.ok(close(result.minutes, 210), `got ${result.minutes}`);
});

test('planning and cooking agree about how long the same job takes', () => {
  // The two used to compute this separately and drift apart.
  const database = loafDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-20', slot: 'dinner', itemId: 'loaf', servings: 5 });
  const planned = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 }).production.find(
    (order) => order.itemId === 'loaf',
  )!;

  receive(database, 'flour', { qty: 5000, on: '2026-07-01' });
  const actual = produce(database, 'loaf', planned.qty, { on: '2026-07-02' });

  assert.ok(close(actual.minutes, planned.minutes), `${actual.minutes} vs ${planned.minutes}`);
});

test('a run of nothing is refused before it can touch the pantry', () => {
  const database = loafDb();
  // A fixed component is what makes this dangerous: a zero-sized batch would
  // still issue the pinch that does not scale.
  database.recipes = database.recipes.map((entry) =>
    entry.outputItemId === 'loaf'
      ? { ...entry, components: [...entry.components, { itemId: 'salt', qty: 5, uom: 'g' as const, scalable: false }] }
      : entry,
  );
  database.items = [...database.items, purchased('salt')];
  receive(database, 'flour', { qty: 1000, on: '2026-07-01' });
  receive(database, 'salt', { qty: 100, on: '2026-07-01' });
  const ledgerBefore = database.ledger.length;

  assert.throws(() => produce(database, 'loaf', 0, { on: '2026-07-02' }), MiseError);
  assert.throws(() => produce(database, 'loaf', -100, { on: '2026-07-02' }), MiseError);
  assert.throws(() => serve(database, 'loaf', 0, { on: '2026-07-02' }), MiseError);

  assert.equal(onHand(database, 'salt'), 100, 'the fixed pinch stayed in the jar');
  assert.equal(database.ledger.length, ledgerBefore, 'and nothing was posted');
  assert.equal(onHand(database, 'loaf'), 0, 'no zero-quantity lot');
});
