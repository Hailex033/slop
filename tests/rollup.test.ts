import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { costOf, nutritionOf, purchaseUnitCost, rollupAllergens, rollupTime, rollupUnitCost } from '../src/engine/rollup.js';
import { close, db, made, nestedDb, phantom, purchased, recipe } from './helpers.js';

test('unit cost comes from the pack, in stock units', () => {
  const item = purchased('butter', {
    purchase: { supplierId: 'shop', packQty: 250, packUom: 'g', packPrice: 2.5, leadTimeDays: 0 },
  });
  assert.equal(purchaseUnitCost(item), 0.01);
});

test('unit cost converts the pack unit into the stock unit', () => {
  // Bought by the kilo, stocked by the gram.
  const item = purchased('flour', {
    purchase: { supplierId: 'shop', packQty: 1.5, packUom: 'kg', packPrice: 3, leadTimeDays: 0 },
  });
  assert.equal(purchaseUnitCost(item), 0.002);
});

test('cost rolls up through every level of nesting', () => {
  // Each test ingredient is £1 per 100 g, i.e. £0.01/g.
  const database = nestedDb();
  const report = costOf(database, 'dish', 1500, 'g');

  // roux: 100 g butter + 100 g flour = £2 for 200 g of roux.
  // sauce: 200 g roux = £2 for 1000 g of sauce.
  // crust: 100 g butter + 200 g flour = £3 for 300 g.
  // dish: 1000 g sauce + 300 g crust + 200 g cheese = 2 + 3 + 2 = £7.
  assert.ok(close(report.total, 7, 1e-9), `got ${report.total}`);
  assert.ok(close(report.perServing, 1.75, 1e-9));
});

test('cost breakdown pools a leaf reached by two paths', () => {
  const report = costOf(nestedDb(), 'dish', 1500, 'g');
  const butter = report.lines.find((line) => line.itemId === 'butter')!;

  assert.ok(close(butter.qty, 200), `got ${butter.qty}`);
  assert.ok(close(butter.cost, 2, 1e-9));
});

test('prep loss is paid for even though it is not eaten', () => {
  const database = db(
    [purchased('onion'), made('soup')],
    [recipe('soup', 1000, [{ itemId: 'onion', qty: 90, uom: 'g', lossPct: 0.1 }])],
  );
  // 90 g in the pot, 100 g bought, at £0.01/g.
  assert.ok(close(costOf(database, 'soup', 1000, 'g').total, 1, 1e-9));
});

test('overhead is absorbed per hour of cooking and stays labelled as overhead', () => {
  const database = db(
    [purchased('x'), made('slow')],
    [
      recipe('slow', 100, [{ itemId: 'x', qty: 100, uom: 'g' }], {
        steps: [{ text: 'simmer', activeMin: 30, passiveMin: 90 }],
      }),
    ],
  );
  database.settings = { ...database.settings, overheadPerHour: 1 };
  const report = costOf(database, 'slow', 100, 'g');

  assert.ok(close(report.materials, 1, 1e-9));
  assert.ok(close(report.overhead, 2, 1e-9), `two hours at £1, got ${report.overhead}`);
});

test('the cost total agrees with its own breakdown when components are fixed', () => {
  const database = db(
    [purchased('base'), purchased('spice'), made('batch')],
    [
      recipe('batch', 100, [
        { itemId: 'base', qty: 100, uom: 'g' },
        // One pinch per batch, however many batches you make.
        { itemId: 'spice', qty: 10, uom: 'g', scalable: false },
      ]),
    ],
  );

  const two = costOf(database, 'batch', 200, 'g');
  const breakdown = two.lines.reduce((sum, line) => sum + line.cost, 0);

  assert.ok(close(two.materials, breakdown, 1e-9), `${two.materials} vs ${breakdown}`);
  // Two batches: 200 g of base at £0.01, plus the single 10 g of spice.
  assert.ok(close(two.materials, 2.1, 1e-9), `got ${two.materials}`);
  assert.ok(close(two.lines.find((l) => l.itemId === 'spice')!.qty, 10));
});

test('cost shares are taken against the same total that is reported', () => {
  const report = costOf(nestedDb(), 'dish', 1500, 'g');
  const shares = report.lines.reduce((sum, line) => sum + line.share, 0);
  const materialShare = report.materials / report.total;

  assert.ok(close(shares, materialShare, 1e-9), `${shares} vs ${materialShare}`);
});

test('a missing price is reported rather than silently treated as free', () => {
  const database = db(
    [purchased('priced'), purchased('unpriced', { purchase: undefined }), made('dish')],
    [
      recipe('dish', 100, [
        { itemId: 'priced', qty: 50, uom: 'g' },
        { itemId: 'unpriced', qty: 50, uom: 'g' },
      ]),
    ],
  );
  const cost = rollupUnitCost(database, 'dish');

  assert.equal(cost.complete, false);
  assert.deepEqual(cost.missing, ['unpriced']);
});

test('nutrition uses the net quantity, because peel is not eaten', () => {
  const database = db(
    [
      purchased('onion', {
        nutrientsPer100g: { kcal: 100, proteinG: 0, fatG: 0, carbG: 0 },
      }),
      made('soup', { densityGPerMl: 1 }),
    ],
    [recipe('soup', 100, [{ itemId: 'onion', qty: 100, uom: 'g', lossPct: 0.5 }])],
  );
  const facts = nutritionOf(database, 'soup', 100, 'g');

  // 200 g bought, 100 g used, 100 kcal — not 200.
  assert.ok(close(facts.total.kcal, 100, 1e-9), `got ${facts.total.kcal}`);
});

test('reduction concentrates nutrition per 100 g without inventing calories', () => {
  const database = db(
    [purchased('stock', { nutrientsPer100g: { kcal: 10, proteinG: 1, fatG: 0, carbG: 0 } }), made('glace')],
    [recipe('glace', 500, [{ itemId: 'stock', qty: 1000, uom: 'g' }])],
  );
  const facts = nutritionOf(database, 'glace', 500, 'g');

  assert.ok(close(facts.total.kcal, 100, 1e-9), 'total is unchanged by reduction');
  assert.ok(close(facts.per100g.kcal, 20, 1e-9), 'but it is twice as concentrated');
});

test('allergens union across the whole tree, flagging optional-only paths', () => {
  const database = db(
    [
      purchased('butter', { allergens: ['milk'] }),
      purchased('flour', { allergens: ['gluten'] }),
      purchased('nuts', { allergens: ['nuts'] }),
      phantom('roux'),
      made('dish'),
    ],
    [
      recipe('roux', 200, [
        { itemId: 'butter', qty: 100, uom: 'g' },
        { itemId: 'flour', qty: 100, uom: 'g' },
      ]),
      recipe('dish', 100, [
        { itemId: 'roux', qty: 50, uom: 'g' },
        { itemId: 'nuts', qty: 10, uom: 'g', optional: true },
      ]),
    ],
  );
  const allergens = rollupAllergens(database, 'dish');
  const byName = new Map(allergens.map((hit) => [hit.allergen, hit]));

  assert.deepEqual([...byName.keys()].sort(), ['gluten', 'milk', 'nuts']);
  assert.equal(byName.get('milk')!.onlyOptional, false, 'found two levels down, and not optional');
  assert.equal(byName.get('nuts')!.onlyOptional, true);
});

test('critical path is the longest chain, not the sum', () => {
  const database = db(
    [purchased('x'), made('slow-child'), made('fast-child'), made('parent')],
    [
      recipe('slow-child', 100, [{ itemId: 'x', qty: 100, uom: 'g' }], {
        steps: [{ text: 'wait', passiveMin: 120 }],
      }),
      recipe('fast-child', 100, [{ itemId: 'x', qty: 100, uom: 'g' }], {
        steps: [{ text: 'quick', activeMin: 10 }],
      }),
      recipe('parent', 200, [
        { itemId: 'slow-child', qty: 100, uom: 'g' },
        { itemId: 'fast-child', qty: 100, uom: 'g' },
      ], { steps: [{ text: 'assemble', activeMin: 20 }] }),
    ],
  );
  const time = rollupTime(database, 'parent');

  assert.equal(time.activeMin + time.passiveMin, 150, 'all the work still has to be done');
  assert.equal(time.criticalPathMin, 140, 'but the two children can overlap');
  assert.deepEqual(time.criticalPath, ['parent', 'slow-child']);
});

test('the example lasagne costs a plausible amount per serving', () => {
  const database = seedDatabase();
  const report = costOf(database, 'lasagne', 3000, 'g');

  assert.equal(report.complete, true);
  assert.equal(report.servings, 6);
  assert.ok(report.perServing > 1 && report.perServing < 10, `got ${report.perServing}`);
});
