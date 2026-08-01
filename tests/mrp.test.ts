import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { issue, receive } from '../src/engine/inventory.js';
import { commitProduction, runMrp } from '../src/engine/mrp.js';
import { shoppingList } from '../src/engine/procurement.js';
import { close, db, made, nestedDb, phantom, purchased, recipe } from './helpers.js';

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
  // `receive` refuses phantom lots outright, but a hand-edited database file
  // can still contain one — MRP must ignore it rather than net against it.
  database.lots.push({ id: 'LOT-X', itemId: 'roux', qty: 500, receivedOn: '2026-07-01' });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const roux = result.lines.find((line) => line.itemId === 'roux')!;

  assert.equal(roux.action, 'phantom');
  assert.equal(roux.onHand, 0, 'a phantom never nets against stock');
  assert.ok(!result.production.some((order) => order.itemId === 'roux'));
  assert.ok(!result.purchases.some((order) => order.itemId === 'roux'));
  // ...but its components are still demanded.
  assert.ok(result.lines.some((line) => line.itemId === 'butter' && line.gross > 0));
});

test('a phantom on the meal plan is a problem, not a shopping trip', () => {
  const database = nestedDb();
  // A hand-edited file plans the roux itself. It can never be served —
  // phantoms cannot be stocked — so buying its butter and flour would fund
  // a dinner that cannot happen.
  planned(database, 'roux', 2, '2026-07-02');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(
    result.problems.some((p) => p.includes('MP-1') && p.includes('phantom')),
    JSON.stringify(result.problems),
  );
  // Problems block the commit, so the poisoned plan cannot reach the order book.
  assert.throws(() => commitProduction(database, result), /problems/);
});

test('two same-day makings of a phantom each plan their fixed dose', () => {
  const database = db(
    [purchased('herb'), purchased('sachet', { stockUom: 'ea' }), phantom('blend'), made('soup'), made('stew')],
    [
      recipe('blend', 100, [
        { itemId: 'herb', qty: 100, uom: 'g' },
        { itemId: 'sachet', qty: 1, uom: 'ea', scalable: false },
      ]),
      recipe('soup', 1000, [{ itemId: 'blend', qty: 100, uom: 'g' }]),
      recipe('stew', 1000, [{ itemId: 'blend', qty: 150, uom: 'g' }]),
    ],
  );
  planned(database, 'soup', 1, '2026-07-03');
  planned(database, 'stew', 1, '2026-07-03');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const sachet = result.lines.find((line) => line.itemId === 'sachet')!;
  const herb = result.lines.find((line) => line.itemId === 'herb')!;

  // Execution makes the blend inside each dish separately: two pans on one
  // day are two sachets — while the scalable herb is simply the sum.
  assert.ok(close(sachet.gross, 2), `got ${sachet.gross}`);
  assert.ok(close(herb.gross, 250), `got ${herb.gross}`);
});

test('a committed optional policy survives beneath a phantom', () => {
  const database = db(
    [purchased('base'), purchased('truffle'), phantom('mix'), made('plate')],
    [
      recipe('mix', 100, [
        { itemId: 'base', qty: 100, uom: 'g' },
        { itemId: 'truffle', qty: 5, uom: 'g', optional: true },
      ]),
      recipe('plate', 1000, [{ itemId: 'mix', qty: 100, uom: 'g' }]),
    ],
  );
  planned(database, 'plate', 1, '2026-07-03');
  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7, includeOptional: true }));

  // A later plain run. The order was committed with its garnish, and the
  // garnish lives below a required phantom: dropping the flag on the way
  // down would shop for a batch executeOrder will refuse to cook short.
  const rerun = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const truffle = rerun.lines.find((line) => line.itemId === 'truffle');
  assert.ok(truffle, 'the garnish is still in the plan');
  assert.ok(close(truffle!.gross, 5), `got ${truffle!.gross}`);
});

test('a committed optional policy survives replanning a stocked child', () => {
  const database = db(
    [purchased('stockbase'), purchased('sprinkle'), made('relish'), made('platter')],
    [
      recipe('relish', 1000, [
        { itemId: 'stockbase', qty: 1000, uom: 'g' },
        { itemId: 'sprinkle', qty: 50, uom: 'g', optional: true },
      ]),
      recipe('platter', 1000, [{ itemId: 'relish', qty: 500, uom: 'g' }]),
    ],
  );
  planned(database, 'platter', 1, '2026-07-04');
  // With relish in stock, the optional-enabled commit raises no relish order.
  receive(database, 'relish', { qty: 500, on: '2026-07-01' });
  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7, includeOptional: true }));
  assert.ok(!database.productionOrders.some((o) => o.itemId === 'relish'), 'covered by the tub');

  // The tub is eaten before the plan is cooked.
  issue(database, 'relish', { qty: 500, on: '2026-07-02', ref: 'midnight-snack' });

  // A later plain run replans the relish for the committed platter.
  // Executing that commitment cooks the relish with its sprinkle, so the
  // replacement run must buy the sprinkle — whatever flag this run uses.
  const rerun = runMrp(database, { asOf: '2026-07-02', horizonDays: 7 });
  const sprinkle = rerun.lines.find((line) => line.itemId === 'sprinkle');
  assert.ok(sprinkle && close(sprinkle.gross, 25), `got ${sprinkle?.gross}`);

  // And the replacement commitment snapshots the inherited policy, so the
  // batch is eventually cooked exactly as it was planned and bought.
  const orders = commitProduction(database, rerun);
  const relishOrder = orders.find((o) => o.itemId === 'relish')!;
  assert.equal(relishOrder.includeOptional, true);
});

test('a run that cannot finish in time is a conflict, not a commitment', () => {
  const database = db(
    [purchased('flour'), made('slowloaf')],
    [
      recipe('slowloaf', 1000, [{ itemId: 'flour', qty: 600, uom: 'g' }], {
        servings: 2,
        // A two-night prove: due today, it should have started days ago.
        steps: [{ text: 'long prove', activeMin: 30, passiveMin: 960 }],
      }),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-01', slot: 'dinner', itemId: 'slowloaf', servings: 2 });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const run = result.production.find((p) => p.itemId === 'slowloaf')!;
  assert.equal(run.late, true);
  assert.ok(result.conflicts.some((c) => c.includes('slowloaf')), JSON.stringify(result.conflicts));
  // The ingredients are still planned, so the batch can be cooked late.
  assert.ok(result.lines.some((l) => l.itemId === 'flour' && l.net > 0));

  // Committing must not persist the clamped span: MRP would count the
  // output as supply — and execution would date its completion — before
  // the batch could exist.
  const orders = commitProduction(database, result);
  assert.ok(!orders.some((o) => o.itemId === 'slowloaf'), 'an impossible span is never persisted');
});

test('--ignore-stock still rebuilds safety stock', () => {
  const database = db([purchased('salt2', { safetyStock: 500 })]);
  receive(database, 'salt2', { qty: 1000, on: '2026-07-01' });

  // Fully stocked and nothing planned: a normal run has nothing to do…
  const normal = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(!normal.purchases.some((p) => p.itemId === 'salt2'));

  // …but "plan as if the pantry were empty" must buy the staples an
  // actually empty pantry would need — skipping every safety-stock-only
  // item is exactly the provisioning list going out blank.
  const bare = runMrp(database, { asOf: '2026-07-01', horizonDays: 7, ignoreStock: true });
  const salt = bare.purchases.find((p) => p.itemId === 'salt2');
  assert.ok(salt && close(salt.qty, 500), `got ${salt?.qty}`);
});

test('a firm order keeps every meal it was committed for on the trail', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'lunch', itemId: 'dish', servings: 2 });
  database.mealPlan.push({ id: 'MP-2', date: '2026-07-05', slot: 'dinner', itemId: 'dish', servings: 2 });

  const orders = commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const dishOrder = orders.find((o) => o.itemId === 'dish')!;
  // The dish keeps, so both meals merged into one run — and both stay on
  // the commitment, not just whichever happened to be first.
  assert.deepEqual([...(dishOrder.pegging ?? [])].sort(), ['MP-1', 'MP-2']);

  // The trail survives below the commit too: a later run's shopping list
  // answers "what is this for?" with the dish, not with an order id.
  const list = shoppingList(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const butter = list.lines.find((line) => line.itemId === 'butter')!;
  assert.deepEqual(butter.forDishes, ['dish'], JSON.stringify(butter.forDishes));
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

test('a trip early enough to make is refused when the food would not keep', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Saturday market', leadTimeDays: 0, deliveryDays: [6] }];
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 2 } : item,
  );
  // Needed Friday the 17th. The Saturday before is the 11th — reachable, but
  // cheese bought then is six days old by Friday and only keeps two.
  planned(database, 'cheese', 200, '2026-07-17');

  const result = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  const cheese = result.purchases.find((line) => line.itemId === 'cheese')!;

  assert.equal(cheese.orderBy, '2026-07-11', 'the nearest real trip is still named');
  assert.equal(cheese.late, true, 'but it is flagged, not marked timely');
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0]!, /spoil/);
  assert.deepEqual(result.problems, [], 'freshness is a plan conflict, not a data error');
});

test('the same trip is fine when the shelf life covers the gap', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Saturday market', leadTimeDays: 0, deliveryDays: [6] }];
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 10 } : item,
  );
  planned(database, 'cheese', 200, '2026-07-17');

  const result = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  const cheese = result.purchases.find((line) => line.itemId === 'cheese')!;

  assert.equal(cheese.orderBy, '2026-07-11');
  assert.equal(cheese.late, false);
  assert.deepEqual(result.conflicts, []);
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

test('a run that serves two meals pegs both, all the way to the shopping list', () => {
  const database = nestedDb();
  planned(database, 'sauce', 1000, '2026-07-02');
  planned(database, 'sauce', 1000, '2026-07-04');

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });

  // Sauce keeps, so one production run covers both meals…
  const runs = result.production.filter((order) => order.itemId === 'sauce');
  assert.equal(runs.length, 1);
  assert.deepEqual([...runs[0]!.pegging].sort(), ['MP-1', 'MP-2']);

  // …and the butter that run needs answers to both meals, not just the first.
  const butter = result.purchases.find((line) => line.itemId === 'butter')!;
  assert.deepEqual([...butter.pegging].sort(), ['MP-1', 'MP-2']);
});

test('a phantom needed once is still exploded once', () => {
  const database = nestedDb();
  planned(database, 'sauce', 1000, '2026-07-02');

  const butter = runMrp(database, { asOf: '2026-07-01', horizonDays: 30 }).purchases.filter(
    (line) => line.itemId === 'butter',
  );
  assert.equal(butter.length, 1);
});

test('ignoring stock does not ignore commitments already made', () => {
  const database = nestedDb();
  planned(database, 'sauce', 1000, '2026-07-03');
  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));

  const rerun = runMrp(database, { asOf: '2026-07-01', horizonDays: 7, ignoreStock: true });

  // The committed batch still supplies the meal — no duplicate sauce run…
  assert.equal(rerun.production.filter((order) => order.itemId === 'sauce').length, 0);
  // …and its components are still wanted, from an empty pantry. The helper
  // recipe serves 1 per 1000 g batch, so 1000 servings is 1000 batches:
  // 200 kg of roux, of which half is butter.
  const butter = rerun.purchases.find((line) => line.itemId === 'butter')!;
  assert.ok(close(butter.qty, 100_000), `got ${butter.qty}`);
});

test('sibling phantom rests overlap; they do not stack', () => {
  const database = db(
    [purchased('flour'), purchased('milk2'), phantom('dough'), phantom('batter'), made('bake')],
    [
      recipe('dough', 500, [{ itemId: 'flour', qty: 300, uom: 'g' }], {
        steps: [{ text: 'rest', activeMin: 5, passiveMin: 300 }],
      }),
      recipe('batter', 500, [{ itemId: 'milk2', qty: 300, uom: 'g' }], {
        steps: [{ text: 'rest too', activeMin: 5, passiveMin: 300 }],
      }),
      recipe('bake', 1000, [
        { itemId: 'dough', qty: 500, uom: 'g' },
        { itemId: 'batter', qty: 500, uom: 'g' },
      ], { steps: [{ text: 'assemble', activeMin: 20 }] }),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'bake', servings: 1 });

  const run = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }).production.find(
    (order) => order.itemId === 'bake',
  )!;

  // Both rests happen side by side: 30 hands-on minutes, one 300-minute
  // wait — not the 600 that pushed the start back an extra day.
  assert.equal(run.activeMin, 30);
  assert.equal(run.passiveMin, 300);
  assert.equal(run.minutes, 330);
});

test('unequal sibling waits stagger: the long rest absorbs the other job', () => {
  const database = db(
    [purchased('flour'), purchased('milk2'), phantom('slowdough'), phantom('quickmix'), made('bake2')],
    [
      recipe('slowdough', 500, [{ itemId: 'flour', qty: 300, uom: 'g' }], {
        steps: [{ text: 'brief knead, long rest', activeMin: 60, passiveMin: 300 }],
      }),
      recipe('quickmix', 500, [{ itemId: 'milk2', qty: 300, uom: 'g' }], {
        steps: [{ text: 'long work, brief rest', activeMin: 300, passiveMin: 60 }],
      }),
      recipe('bake2', 1000, [
        { itemId: 'slowdough', qty: 500, uom: 'g' },
        { itemId: 'quickmix', qty: 500, uom: 'g' },
      ]),
    ],
  );
  planned(database, 'bake2', 1, '2026-07-03');

  const run = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }).production.find(
    (order) => order.itemId === 'bake2',
  )!;

  // Start the long rest first: its five hours absorb the other job's five
  // hours of mixing. Seven hours, not eleven — the difference between
  // cooking on the day and being told to start the day before.
  assert.equal(run.activeMin, 360);
  assert.equal(run.minutes, 420);
  assert.equal(run.startOn, run.dueOn, 'one day of cooking, started on the day');
});

test("a phantom's work is folded into the run that consumes it", () => {
  const database = db(
    [purchased('flour'), phantom('dough'), made('sheets')],
    [
      recipe('dough', 500, [{ itemId: 'flour', qty: 300, uom: 'g' }], {
        steps: [
          { text: 'knead', activeMin: 10 },
          { text: 'rest', passiveMin: 30 },
        ],
      }),
      recipe('sheets', 500, [{ itemId: 'dough', qty: 500, uom: 'g' }], {
        steps: [{ text: 'roll', activeMin: 25 }],
      }),
    ],
  );
  planned(database, 'sheets', 1, '2026-07-03');

  const run = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }).production.find(
    (order) => order.itemId === 'sheets',
  )!;

  // The dough has no run of its own — its kneading and resting happen on
  // the sheets' clock, or they happen nowhere.
  assert.equal(run.activeMin, 35);
  assert.equal(run.passiveMin, 30);
  assert.equal(run.minutes, 65);
});

test('an overnight phantom pushes the start of its consumer back', () => {
  const database = db(
    [purchased('flour'), purchased('yeast'), phantom('poolish'), made('bread')],
    [
      recipe('poolish', 400, [
        { itemId: 'flour', qty: 200, uom: 'g' },
        { itemId: 'yeast', qty: 1, uom: 'g' },
      ], { steps: [{ text: 'ferment overnight', activeMin: 3, passiveMin: 1440 }] }),
      recipe('bread', 800, [
        { itemId: 'poolish', qty: 400, uom: 'g' },
        { itemId: 'flour', qty: 400, uom: 'g' },
      ], { steps: [{ text: 'mix and bake', activeMin: 30 }] }),
    ],
  );
  planned(database, 'bread', 1, '2026-07-05');

  const run = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }).production.find(
    (order) => order.itemId === 'bread',
  )!;

  // 1473 minutes of work is a multi-day job however you slice an 8-hour day.
  assert.equal(run.minutes, 1473);
  assert.equal(run.startOn, '2026-07-02', 'the poolish night is on the schedule');
});

test('an overdue perishable order is supply for today, not for its past self', () => {
  const database = db(
    [purchased('tomato'), made('sauce', { shelfLifeDays: 2 })],
    [recipe('sauce', 1000, [{ itemId: 'tomato', qty: 500, uom: 'g' }])],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-01', slot: 'dinner', itemId: 'sauce', servings: 1 });
  commitProduction(database, runMrp(database, { asOf: '2026-06-30', horizonDays: 7 }));

  // The batch was never cooked. Days later another meal wants sauce — the
  // overdue order, executed today, produces a lot that is fresh for it. On
  // the historical dates it looked spoiled before it was needed, and the
  // same kilogram was planned twice.
  database.mealPlan.push({ id: 'MP-2', date: '2026-07-06', slot: 'dinner', itemId: 'sauce', servings: 1 });
  const result = runMrp(database, { asOf: '2026-07-05', horizonDays: 7 });

  assert.equal(result.production.filter((o) => o.itemId === 'sauce').length, 0, 'the open order covers it');
});

test('a plan with data problems refuses to be committed', () => {
  const database = db(
    [purchased('flour'), made('bread')],
    [
      recipe('bread', 1000, [
        { itemId: 'flour', qty: 600, uom: 'g' },
        { itemId: 'ghost', qty: 100, uom: 'g' },
      ]),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'bread', servings: 1 });
  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(result.problems.length > 0);

  // Firming it would persist an order executeOrder refuses to cook, which
  // then counts as supply and suppresses replanning of the broken dish.
  assert.throws(() => commitProduction(database, result), /Cannot commit/);
  assert.equal(database.productionOrders.length, 0);
});

test('an overdue order wants its ingredients today, not in the past', () => {
  const database = db(
    [purchased('tomato', { shelfLifeDays: 3 }), made('sauce')],
    [recipe('sauce', 1000, [{ itemId: 'tomato', qty: 500, uom: 'g' }])],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-01', slot: 'dinner', itemId: 'sauce', servings: 1 });
  commitProduction(database, runMrp(database, { asOf: '2026-06-30', horizonDays: 7 }));

  // The batch slipped; tomatoes arrived after its scheduled start. Cooked
  // today, the order uses them — demand dated on the old startOn could not
  // see stock received since, and bought the same tomatoes again.
  receive(database, 'tomato', { qty: 500, on: '2026-07-04' });

  const result = runMrp(database, { asOf: '2026-07-05', horizonDays: 7 });
  assert.ok(!result.purchases.some((line) => line.itemId === 'tomato'), 'the fresh tomatoes cover it');
});

test('an overdue perishable delivery is fresh from today, not spoiled in transit', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 2 } : item,
  );
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-06-28',
    expectedOn: '2026-06-29',
    status: 'open',
    lines: [{ itemId: 'cheese', packs: 2, packQty: 100, packUom: 'g', unitPrice: 1 }],
  });
  planned(database, 'cheese', 200, '2026-07-06');

  const result = runMrp(database, { asOf: '2026-07-05', horizonDays: 7 });
  const cheese = result.lines.find((line) => line.itemId === 'cheese')!;

  // Received today, the two-day life runs to the 7th — good for the 6th.
  assert.ok(close(cheese.onOrder, 200), `got ${cheese.onOrder}`);
  assert.ok(!result.purchases.some((line) => line.itemId === 'cheese'), 'not ordered twice');
});

test('a hole in a recipe is a planning problem, not a silent omission', () => {
  const database = db(
    [purchased('flour'), made('bread')],
    [
      recipe('bread', 1000, [
        { itemId: 'flour', qty: 600, uom: 'g' },
        { itemId: 'ghost', qty: 100, uom: 'g' },
      ]),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'bread', servings: 1 });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });

  // Production will refuse to cook this recipe; the plan must not present a
  // confident shopping list that quietly lacks an ingredient.
  assert.ok(result.problems.some((p) => p.includes('ghost')), JSON.stringify(result.problems));
  assert.ok(result.purchases.some((line) => line.itemId === 'flour'), 'the rest still plans');
});

test('a committed order straddling the horizon still buys its components', () => {
  const database = db(
    [purchased('flour'), made('bread')],
    [
      recipe('bread', 1000, [{ itemId: 'flour', qty: 600, uom: 'g' }], {
        steps: [{ text: 'prove overnight, twice', passiveMin: 1440 }],
      }),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-08', slot: 'dinner', itemId: 'bread', servings: 1 });

  // A fortnight-wide run commits the bake: due the 8th, started the 6th.
  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 14 }));
  const order = database.productionOrders[0]!;
  assert.equal(order.startOn, '2026-07-06');
  assert.equal(order.dueOn, '2026-07-08');

  // A one-week view ends on the 7th: the bake starts inside it, finishes
  // beyond it. The flour still has to be bought this week.
  const week = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const flour = week.purchases.find((line) => line.itemId === 'flour')!;

  assert.ok(flour, 'the straddling order still demands its components');
  assert.ok(close(flour.qty, 600), `got ${flour.qty}`);
  assert.equal(flour.neededOn, '2026-07-06', 'wanted when the cooking starts');
  assert.equal(week.production.length, 0, 'and nothing is planned twice');
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

  // Butter is genuinely reachable nine ways in that dataset; still one line.
  assert.equal(result.lines.filter((line) => line.itemId === 'butter').length, 1);
});
