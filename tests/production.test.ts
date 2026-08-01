import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { onHand, onOrder, receive } from '../src/engine/inventory.js';
import { commitProduction, runMrp } from '../src/engine/mrp.js';
import { bySupplier, packsFor, raisePurchaseOrders, receivePurchaseOrder, shoppingList } from '../src/engine/procurement.js';
import { cookableNow, executeOrder, feasibility, prepSchedule, produce, raiseProductionOrder, serve } from '../src/engine/production.js';
import { CycleError, MiseError, ShortageError } from '../src/domain/errors.js';
import { close, db, made, nestedDb, phantom, purchased, recipe } from './helpers.js';

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
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-12', slot: 'dinner', itemId: 'cheese', servings: 200 });

  const mrp = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  const [order] = raisePurchaseOrders(database, shoppingList(database, mrp), '2026-07-06');

  // The Sunday meal is shopped on Saturday the 11th — the market's day.
  assert.ok(order);
  assert.equal(order.expectedOn, '2026-07-11');

  // The committed inbound covers the meal on the next run.
  const after = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  assert.ok(close(after.lines.find((line) => line.itemId === 'cheese')!.onOrder, 200));
  assert.deepEqual(after.conflicts, []);
});

test('a late line is a conflict to resolve, not an order to repeat', () => {
  const database = nestedDb();
  database.suppliers = [{ id: 'shop', name: 'Saturday market', leadTimeDays: 0, deliveryDays: [6] }];
  // Thursday the 9th, with no Saturday before it: the market cannot serve it.
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-09', slot: 'dinner', itemId: 'cheese', servings: 200 });

  const list = shoppingList(database, runMrp(database, { asOf: '2026-07-06', horizonDays: 14 }));
  assert.equal(list.lines[0]!.late, true);

  // Committing a delivery that misses its meal buys food twice: the order
  // cannot serve the demand, so the next run re-plans the same shortfall —
  // and would commit it again, and again.
  assert.deepEqual(raisePurchaseOrders(database, list, '2026-07-06'), []);
  const rerun = runMrp(database, { asOf: '2026-07-06', horizonDays: 14 });
  assert.equal(rerun.conflicts.length, 1, 'the decision stays on the table');
  assert.deepEqual(
    raisePurchaseOrders(database, shoppingList(database, rerun), '2026-07-06'),
    [],
    'no amount of committing creates a second order',
  );
});

test('a pack-size edit after ordering does not change what was ordered', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'cheese', servings: 200 });

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const [order] = raisePurchaseOrders(database, shoppingList(database, mrp), '2026-07-01');
  assert.ok(order);
  assert.equal(order.lines[0]!.packs, 2, 'two 100 g packs cover 200 g');

  // The shop rebrands: cheese now comes in 250 g packs at a new price. The
  // order in flight was for two 100 g packs and must stay two 100 g packs.
  database.items = database.items.map((item) =>
    item.id === 'cheese'
      ? { ...item, purchase: { ...item.purchase!, packQty: 250, packPrice: 2.4 } }
      : item,
  );

  // Planning still counts the inbound at the ordered size, on both paths...
  const after = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(close(after.lines.find((line) => line.itemId === 'cheese')!.onOrder, 200));
  assert.ok(close(onOrder(database, 'cheese', '2026-07-07'), 200));

  // ...and the receipt books in what was committed to, not the new pack.
  const receipt = receivePurchaseOrder(database, order.id, '2026-07-02');
  assert.equal(receipt.lots.length, 1);
  assert.ok(close(receipt.lots[0]!.qty, 200), `got ${receipt.lots[0]!.qty}`);
});

test('a receipt that fails mid-order books nothing at all', () => {
  const database = nestedDb();
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-07-01',
    expectedOn: '2026-07-01',
    status: 'open',
    lines: [
      // The butter line is fine; the ghost line throws after it has booked.
      { itemId: 'butter', packs: 2, packQty: 100, packUom: 'g', unitPrice: 1 },
      { itemId: 'ghost', packs: 1, packQty: 100, packUom: 'g', unitPrice: 1 },
    ],
  });
  const ledgerBefore = database.ledger.length;

  assert.throws(() => receivePurchaseOrder(database, 'PO-0001', '2026-07-01'));

  assert.equal(onHand(database, 'butter'), 0, 'the butter lot was rolled back with the failure');
  assert.equal(database.ledger.length, ledgerBefore, 'the ledger records nothing that did not happen');
  const order = database.purchaseOrders.find((o) => o.id === 'PO-0001')!;
  assert.equal(order.status, 'open', 'so the order can be corrected and received exactly once');
});

test('an unresolved line is never committed into an order', () => {
  const database = nestedDb();
  database.items.push({
    id: 'mystery', name: 'mystery', category: 'Test', sourcing: 'purchased', stockUom: 'g',
    // Supplier and pack on file, price hand-mangled: reported, not ordered.
    purchase: { supplierId: 'shop', packQty: 100, packUom: 'g', packPrice: Number.NaN, leadTimeDays: 0 },
  });
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'mystery', servings: 100 });

  const list = shoppingList(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  assert.equal(list.unresolved.length, 1, 'the missing price is reported');

  const orders = raisePurchaseOrders(database, list, '2026-07-01');
  assert.ok(
    orders.every((order) => order.lines.every((line) => line.itemId !== 'mystery')),
    'a question is not an order',
  );
});

test('serving a planned meal retires its demand', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'dish', servings: 4 });
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 500, on: '2026-06-30' });

  const result = serve(database, 'dish', 4, { on: '2026-07-02' });
  assert.equal(result.servedPlanEntryId, 'MP-1');

  // The food is eaten; re-planning must not buy and cook a replacement.
  const rerun = runMrp(database, { asOf: '2026-07-02', horizonDays: 7 });
  assert.ok(!rerun.production.some((order) => order.itemId === 'dish'), 'not planned again');

  // An entry for a future date is untouched by today's serving.
  database.mealPlan.push({ id: 'MP-2', date: '2026-07-05', slot: 'dinner', itemId: 'dish', servings: 4 });
  const later = serve(database, 'dish', 4, { on: '2026-07-03', allowShortages: true });
  assert.equal(later.servedPlanEntryId, undefined, 'nothing due on or before the 3rd matches');
  assert.equal(database.mealPlan.find((e) => e.id === 'MP-2')!.servedOn, undefined);
});

test('a partial serving retires only the portions eaten', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'dish', servings: 6 });
  receive(database, 'butter', { qty: 2000, on: '2026-06-30' });
  receive(database, 'flour', { qty: 2000, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 2000, on: '2026-06-30' });

  serve(database, 'dish', 2, { on: '2026-07-02' });
  const entry = database.mealPlan[0]!;
  assert.equal(entry.servedServings, 2);
  assert.equal(entry.servedOn, undefined, 'four portions are still owed');

  // Planning still wants the remaining four — not zero, not six.
  const rerun = runMrp(database, { asOf: '2026-07-02', horizonDays: 7 });
  const run = rerun.production.find((o) => o.itemId === 'dish')!;
  assert.ok(close(run.qty, 1500), `got ${run.qty}`);

  serve(database, 'dish', 4, { on: '2026-07-03' });
  assert.equal(entry.servedOn, '2026-07-03', 'now it is history');
  assert.ok(!runMrp(database, { asOf: '2026-07-03', horizonDays: 7 }).production.some((o) => o.itemId === 'dish'));
});

test('a legacy fully-served entry stays history without a quantity', () => {
  const database = nestedDb();
  // Data written before servedServings existed: the completion marker alone.
  database.mealPlan.push({
    id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'dish', servings: 4, servedOn: '2026-07-02',
  });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(!result.production.some((o) => o.itemId === 'dish'), 'servedOn alone means fully served');

  // And a serve today must not re-open it either.
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 500, on: '2026-06-30' });
  const served = serve(database, 'dish', 4, { on: '2026-07-03' });
  assert.equal(served.servedPlanEntryId, undefined, 'history is not a match');
});

test('purchase commits refuse an invalid plan too', () => {
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

  const mrp = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const list = shoppingList(database, mrp);
  assert.ok(list.problems.length > 0, 'the list carries the run\'s problems');

  // Paying for the surviving ingredients of a dish that cannot be cooked
  // just moves the damage into the order book.
  assert.throws(() => raisePurchaseOrders(database, list, '2026-07-01'), /Cannot commit/);
  assert.equal(database.purchaseOrders.length, 0);
});

test('an explicit plan entry must match the dish being served', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'cheese', servings: 100 });
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 500, on: '2026-06-30' });

  const ledgerBefore = database.ledger.length;
  assert.throws(
    () => serve(database, 'dish', 4, { on: '2026-07-02', planEntryId: 'MP-1' }),
    /not an unserved entry for/,
  );
  assert.equal(database.ledger.length, ledgerBefore, 'refused before anything moved');
  assert.equal(database.mealPlan[0]!.servedServings, undefined, 'the cheese entry is untouched');
});

test('a committed plan keeps its optional policy', () => {
  const database = db(
    [purchased('base'), purchased('garnish'), made('plate')],
    [
      recipe('plate', 1000, [
        { itemId: 'base', qty: 800, uom: 'g' },
        { itemId: 'garnish', qty: 50, uom: 'g', optional: true },
      ]),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'plate', servings: 1 });

  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7, includeOptional: true }));
  const order = database.productionOrders[0]!;
  assert.equal(order.includeOptional, true);

  // A later default run still buys the garnish the commitment includes…
  const rerun = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.ok(rerun.purchases.some((line) => line.itemId === 'garnish'), 'the committed garnish is still bought');

  // …and executing the order issues it.
  receive(database, 'base', { qty: 1000, on: '2026-07-01' });
  receive(database, 'garnish', { qty: 100, on: '2026-07-01' });
  const result = executeOrder(database, order.id, { on: '2026-07-03' });
  assert.ok(result.consumed.some((line) => line.itemId === 'garnish'), 'cooked as committed');
});

test('a forced serve of a purchased item records the gap instead of refusing', () => {
  const database = db([purchased('bread', { shelfLifeDays: 4 })]);
  receive(database, 'bread', { qty: 100, on: '2026-07-01' });

  // Without --force the honest refusal stands: there is no recipe to run.
  assert.throws(() => serve(database, 'bread', 250, { on: '2026-07-02' }), /can only be bought/);

  const result = serve(database, 'bread', 250, { on: '2026-07-02', allowShortages: true });
  assert.ok(result.shortages.some((s) => s.itemId === 'bread' && close(s.short, 150)));

  // The ledger accounts for the whole serving, overrun included.
  const consumed = database.ledger
    .filter((txn) => txn.type === 'issue')
    .reduce((sum, txn) => sum + txn.qty, 0);
  assert.ok(close(consumed, -250), `ledger accounts for ${consumed}`);
});

test('a recipe hole makes a dish infeasible, not unlimited', () => {
  const database = nestedDb();
  database.items = database.items.filter((item) => item.id !== 'cheese');
  receive(database, 'butter', { qty: 5000, on: '2026-06-30' });
  receive(database, 'flour', { qty: 5000, on: '2026-06-30' });

  const check = feasibility(database, 'dish', 4, '2026-07-01', true);
  assert.ok(check.servings < 0.01, `got ${check.servings}`);
  assert.ok(
    check.missing.some((m) => m.itemId === 'cheese' && m.name.includes('not in the item master')),
    JSON.stringify(check.missing),
  );
});

test('a dangling supplier reference is unresolved, not quietly ordered from', () => {
  const database = nestedDb();
  database.items.push({
    id: 'import', name: 'import', category: 'Test', sourcing: 'purchased', stockUom: 'g',
    // The supplier this points at was deleted in a hand edit.
    purchase: { supplierId: 'gone', packQty: 100, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
  });
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'import', servings: 100 });

  const list = shoppingList(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const line = list.lines.find((l) => l.itemId === 'import')!;

  assert.match(line.problem ?? '', /unknown supplier "gone"/);
  assert.equal(list.unresolved.length, 1);
  // And no purchase order is raised against a supplier that does not exist.
  const orders = raisePurchaseOrders(database, list, '2026-07-01');
  assert.ok(orders.every((order) => order.supplierId !== 'gone'));
});

test('a free item is priced at zero, not flagged as unpriced', () => {
  const database = nestedDb();
  // The seeded sourdough starter's shape: a standing item replenished for
  // nothing, with a genuine £0 pack price.
  database.items.push({
    id: 'starter', name: 'starter', category: 'Test', sourcing: 'purchased', stockUom: 'g',
    purchase: { supplierId: 'shop', packQty: 100, packUom: 'g', packPrice: 0, leadTimeDays: 0 },
  });
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'starter', servings: 100 });

  const list = shoppingList(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const line = list.lines.find((l) => l.itemId === 'starter')!;

  assert.equal(line.problem, undefined, 'free is a price, not a missing one');
  assert.equal(line.lineCost, 0);
  assert.deepEqual(list.unresolved, []);
});

test('two visits to the same supplier are two trips on the shopping list', () => {
  const database = nestedDb();
  database.items = database.items.map((item) =>
    item.id === 'cheese' ? { ...item, shelfLifeDays: 2 } : item,
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-02', slot: 'dinner', itemId: 'cheese', servings: 200 });
  database.mealPlan.push({ id: 'MP-2', date: '2026-07-08', slot: 'dinner', itemId: 'cheese', servings: 200 });

  const list = shoppingList(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 10 }));
  const groups = bySupplier(list);

  // Six days apart on a two-day shelf life cannot be one undated visit.
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.orderBy), ['2026-07-02', '2026-07-08']);
  assert.ok(groups.every((g) => g.supplier === 'Shop'));
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

test('executing a parent order settles the child orders its cascade cooked', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'dish', servings: 4 });
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 500, on: '2026-06-30' });

  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const orderFor = (id: string) => database.productionOrders.find((o) => o.itemId === id)!;
  assert.equal(orderFor('sauce').status, 'open');

  // Cooking the dish cascades into the sauce and the crust — the same
  // batches the committed child orders stand for.
  executeOrder(database, orderFor('dish').id, { on: '2026-07-03' });

  assert.equal(orderFor('sauce').status, 'received', 'the cascade executed it');
  assert.equal(orderFor('crust').status, 'received');
  assert.equal(orderFor('dish').status, 'received');
  assert.throws(() => executeOrder(database, orderFor('sauce').id), /already done/);
});

test('a failed cook puts settled child orders back', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'dish', servings: 4 });
  // Butter and flour for the sub-recipes, but no cheese: the dish fails on
  // its last component, after both cascades have already settled orders.
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });

  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const orderFor = (id: string) => database.productionOrders.find((o) => o.itemId === id)!;

  assert.throws(() => executeOrder(database, orderFor('dish').id, { on: '2026-07-03' }), ShortageError);

  assert.equal(orderFor('sauce').status, 'open', 'the settled order came back with the rollback');
  assert.equal(orderFor('crust').status, 'open');
  assert.equal(orderFor('dish').status, 'open');
  assert.equal(onHand(database, 'butter'), 500, 'and so did the butter');
});

test('a cascade covering part of a child order reduces it; the rest settles later', () => {
  const database = nestedDb();
  // A one-day shelf life keeps the two dishes as separate runs, while the
  // sauce — which keeps — merges into a single committed order serving both.
  database.items = database.items.map((item) =>
    item.id === 'dish' ? { ...item, shelfLifeDays: 1 } : item,
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'dish', servings: 4 });
  database.mealPlan.push({ id: 'MP-2', date: '2026-07-06', slot: 'dinner', itemId: 'dish', servings: 4 });
  receive(database, 'butter', { qty: 2000, on: '2026-06-30' });
  receive(database, 'flour', { qty: 2000, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 2000, on: '2026-06-30' });

  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const dishOrders = database.productionOrders
    .filter((o) => o.itemId === 'dish')
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const sauceOrder = database.productionOrders.find((o) => o.itemId === 'sauce')!;
  assert.equal(dishOrders.length, 2);
  assert.ok(close(sauceOrder.qty, 2000), 'one merged commitment for both meals');

  // First dinner cascades 1000 g of sauce — half the commitment. That half
  // went straight into the dish, so no lot remains to reconcile: the order
  // itself must shrink.
  executeOrder(database, dishOrders[0]!.id, { on: '2026-07-03' });
  assert.equal(sauceOrder.status, 'open', 'half a commitment is still a commitment');
  assert.ok(close(sauceOrder.qty, 1000), `got ${sauceOrder.qty}`);

  // The second dinner cooks the remainder and closes it.
  executeOrder(database, dishOrders[1]!.id, { on: '2026-07-06' });
  assert.equal(sauceOrder.status, 'received');
});

test('cooking a recipe with a deleted component is refused, not quietly abridged', () => {
  const database = nestedDb();
  database.items = database.items.filter((item) => item.id !== 'cheese');
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });

  // Not a shortage — the item does not exist. Cooking around the hole would
  // book a full dish that never contained its cheese.
  assert.throws(() => produce(database, 'dish', 1500, { on: '2026-07-01' }), /unknown item "cheese"/);
  assert.equal(onHand(database, 'butter'), 500, 'the sauce it had already made was rolled back');
});

test('a recipe cycle fails cleanly when cooking, not with a stack overflow', () => {
  const database = db(
    [made('a'), made('b')],
    [
      recipe('a', 100, [{ itemId: 'b', qty: 50, uom: 'g' }]),
      recipe('b', 100, [{ itemId: 'a', qty: 50, uom: 'g' }]),
    ],
  );
  // With nothing in stock the cascade chases the loop; it must be named,
  // not left to exhaust the call stack.
  assert.throws(() => produce(database, 'a', 100, { on: '2026-07-01' }), CycleError);
});

test('a receipt line with no pack terms anywhere is refused, keeping the order open', () => {
  const database = nestedDb();
  // A legacy order saved before lines carried their own pack terms…
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-07-01',
    expectedOn: '2026-07-01',
    status: 'open',
    lines: [{ itemId: 'butter', packs: 2, unitPrice: 1 }],
  });
  // …whose item has since lost its purchase terms to a hand edit.
  database.items = database.items.map((item) => {
    if (item.id !== 'butter') return item;
    const { purchase: _purchase, ...rest } = item;
    return rest;
  });

  assert.throws(() => receivePurchaseOrder(database, 'PO-0001', '2026-07-02'), MiseError);
  assert.equal(database.purchaseOrders[0]!.status, 'open', 'repairable, not silently emptied');
  assert.equal(database.lots.length, 0, 'nothing was booked in');
});

test('feasibility times the servings it offers, not the probe', () => {
  const database = db(
    [purchased('oats'), made('porridge')],
    [
      recipe('porridge', 100, [{ itemId: 'oats', qty: 100, uom: 'g' }], {
        steps: [{ text: 'stir', activeMin: 10 }],
      }),
    ],
  );
  receive(database, 'oats', { qty: 400, on: '2026-07-01' });

  const result = feasibility(database, 'porridge', 1, '2026-07-02', true);
  assert.ok(Math.abs(result.servings - 4) < 0.01, `got ${result.servings}`);
  // Four batches on offer means four rounds of stirring — not the probe's one.
  assert.ok(Math.abs(result.criticalPathMin - 40) < 0.5, `got ${result.criticalPathMin}`);
});

test('a cancelled production order cannot be executed', () => {
  const database = nestedDb();
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });
  const order = raiseProductionOrder(database, 'sauce', 1000, '2026-07-03');
  order.status = 'cancelled';

  assert.throws(() => executeOrder(database, order.id), /cancelled/);
  assert.equal(onHand(database, 'butter'), 500, 'nothing was cooked');
});

test('feasibility keeps counting past the old search ceiling', () => {
  const database = db(
    [purchased('oats'), made('porridge')],
    [recipe('porridge', 100, [{ itemId: 'oats', qty: 1, uom: 'g' }])],
  );
  receive(database, 'oats', { qty: 100_000, on: '2026-07-01' });

  // 1 g per serving and 100 kg in the house: the answer is 100 000, not the
  // 512 the old eight-doubling search bound topped out at.
  const result = feasibility(database, 'porridge', undefined, '2026-07-02');
  assert.ok(Math.abs(result.servings - 100_000) < 1, `got ${result.servings}`);
});

test('committed batches stay on the prep schedule', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'dish', servings: 4 });

  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));

  // The next run rightly treats the committed batches as supply…
  const second = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.equal(second.production.length, 0);

  // …but they still have to be cooked, and in the right order.
  const tasks = prepSchedule(database, second).flatMap((day) => day.tasks);
  const position = (id: string) => tasks.findIndex((task) => task.itemId === id);

  assert.ok(position('dish') >= 0, 'the committed dish is on the schedule');
  assert.ok(position('sauce') >= 0, 'its committed sub-recipe too');
  assert.ok(position('sauce') < position('dish'), 'deepest-first still holds');
  const dish = tasks[position('dish')]!;
  assert.ok(close(dish.qty, 1500), `got ${dish.qty}`);
});

test('optional phantom work counts when the plan includes it', () => {
  const database = db(
    [purchased('fruit'), phantom('syrup'), made('cake')],
    [
      recipe('syrup', 100, [{ itemId: 'fruit', qty: 100, uom: 'g' }], {
        steps: [{ text: 'reduce to a syrup', activeMin: 30 }],
      }),
      recipe('cake', 500, [
        { itemId: 'fruit', qty: 300, uom: 'g' },
        { itemId: 'syrup', qty: 100, uom: 'g', optional: true },
      ], { steps: [{ text: 'bake', activeMin: 20 }] }),
    ],
  );
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'cake', servings: 1 });

  const plain = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  assert.equal(plain.production[0]!.minutes, 20, 'without the flag the syrup stays out');

  // With the flag the plan buys the syrup's fruit — so it must also
  // schedule the syrup's making and show its step.
  const rich = runMrp(database, { asOf: '2026-07-01', horizonDays: 7, includeOptional: true });
  assert.equal(rich.production[0]!.minutes, 50);
  const task = prepSchedule(database, rich)
    .flatMap((day) => day.tasks)
    .find((t) => t.itemId === 'cake')!;
  assert.ok(task.steps.some((s) => s.includes('reduce to a syrup')));
});

test('a prep task lists the phantom steps it implies, in making order', () => {
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
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'sheets', servings: 1 });

  const result = runMrp(database, { asOf: '2026-07-01', horizonDays: 7 });
  const task = prepSchedule(database, result)
    .flatMap((day) => day.tasks)
    .find((t) => t.itemId === 'sheets')!;

  // The dough is made first, on this task's clock — its steps lead.
  assert.deepEqual(task.steps, ['dough: knead', 'dough: rest', 'roll']);
  assert.equal(task.activeMin, 35);
  assert.equal(task.passiveMin, 30);
});

test('an overdue open order lands on today, not off the schedule', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-01', slot: 'dinner', itemId: 'dish', servings: 4 });
  commitProduction(database, runMrp(database, { asOf: '2026-06-30', horizonDays: 7 }));

  // Two days later the meal date has passed and the orders are still open:
  // late, not gone. MRP counts their output as supply, so prep must still
  // show the cooking that supply depends on.
  const later = runMrp(database, { asOf: '2026-07-03', horizonDays: 7 });
  const days = prepSchedule(database, later);

  assert.ok(days.length > 0, 'the overdue batch is still somebody\'s job');
  assert.equal(days[0]!.date, '2026-07-03', 'scheduled for today — it cannot be cooked in the past');
  assert.ok(days[0]!.tasks.some((task) => task.itemId === 'dish'));
});

test('executing a parent early still settles its future-start child orders', () => {
  const database = nestedDb();
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-05', slot: 'dinner', itemId: 'dish', servings: 4 });
  receive(database, 'butter', { qty: 500, on: '2026-06-30' });
  receive(database, 'flour', { qty: 500, on: '2026-06-30' });
  receive(database, 'cheese', { qty: 500, on: '2026-06-30' });

  commitProduction(database, runMrp(database, { asOf: '2026-07-01', horizonDays: 7 }));
  const orderFor = (id: string) => database.productionOrders.find((o) => o.itemId === id)!;
  assert.equal(orderFor('sauce').startOn, '2026-07-05');

  // Cooking three days ahead of plan cooks the sauce ahead of plan too. Its
  // order's window has not opened, but the work it stands for is done —
  // and the output went straight into the dish, so nothing ages on a shelf.
  executeOrder(database, orderFor('dish').id, { on: '2026-07-02' });

  assert.equal(orderFor('sauce').status, 'received');
  assert.equal(orderFor('crust').status, 'received');
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

// ---------------------------------------------------------------------------
// Time reflects the work that actually remains
// ---------------------------------------------------------------------------

/** A dish that is ten minutes of assembly around a two-hour sauce. */
function slowSauceDb() {
  return db(
    [
      purchased('tomato', {
        purchase: { supplierId: 'shop', packQty: 1000, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
      }),
      made('sauce'),
      made('plate'),
    ],
    [
      recipe('sauce', 100, [{ itemId: 'tomato', qty: 100, uom: 'g' }], {
        steps: [{ text: 'simmer', passiveMin: 120 }],
      }),
      recipe('plate', 100, [{ itemId: 'sauce', qty: 100, uom: 'g' }], {
        steps: [{ text: 'assemble', activeMin: 10 }],
      }),
    ],
  );
}

test('a sub-recipe already made costs no time', () => {
  const database = slowSauceDb();
  receive(database, 'sauce', { qty: 100, on: '2026-07-01' });

  const check = feasibility(database, 'plate', 1, '2026-07-02');
  assert.ok(close(check.servings, 1, 1e-3));
  assert.ok(close(check.criticalPathMin, 10), `only the assembly remains, got ${check.criticalPathMin}`);
});

test('a sub-recipe still to be made costs its time', () => {
  const database = slowSauceDb();
  // Exactly one serving's worth, so the servings offered equal the probe and
  // the time is the probe's: the sauce's simmer plus the plate's assembly.
  receive(database, 'tomato', { qty: 100, on: '2026-07-01' });

  const check = feasibility(database, 'plate', 1, '2026-07-02');
  assert.ok(close(check.criticalPathMin, 130), `got ${check.criticalPathMin}`);
});

test('cooking counts the time of everything it cooked on the way', () => {
  const database = slowSauceDb();
  receive(database, 'tomato', { qty: 1000, on: '2026-07-01' });

  const result = produce(database, 'plate', 100, { on: '2026-07-02' });
  assert.ok(result.consumed.some((line) => line.itemId === 'sauce' && line.madeToOrder));
  assert.ok(close(result.minutes, 130), `the sauce was simmered by this call too, got ${result.minutes}`);
});

test('cooking with the sub-recipe on hand reports only its own time', () => {
  const database = slowSauceDb();
  receive(database, 'sauce', { qty: 100, on: '2026-07-01' });

  const result = produce(database, 'plate', 100, { on: '2026-07-02' });
  assert.ok(close(result.minutes, 10), `got ${result.minutes}`);
});
