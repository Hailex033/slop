import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDatabase } from '../src/data/seed.js';
import { costOf, dietaryConflicts, nutritionOf, purchaseUnitCost, rollupAllergens, rollupTime, rollupUnitCost } from '../src/engine/rollup.js';
import { MiseError } from '../src/domain/errors.js';
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

test('nutrition does not scale a fixed component with the batch', () => {
  const database = db(
    [
      purchased('base', { nutrientsPer100g: { kcal: 100, proteinG: 0, fatG: 0, carbG: 0 } }),
      purchased('egg', {
        stockUom: 'ea',
        unitWeightG: 50,
        nutrientsPer100g: { kcal: 200, proteinG: 0, fatG: 0, carbG: 0 },
      }),
      made('batch', { densityGPerMl: 1 }),
    ],
    [
      recipe('batch', 100, [
        { itemId: 'base', qty: 100, uom: 'g' },
        { itemId: 'egg', qty: 1, uom: 'ea', scalable: false },
      ]),
    ],
  );

  // One batch: 100 kcal of base plus one 50 g egg at 200 kcal/100 g = 200 kcal.
  assert.ok(close(nutritionOf(database, 'batch', 100, 'g').total.kcal, 200, 1e-9));
  // Two batches: twice the base, still one egg.
  assert.ok(close(nutritionOf(database, 'batch', 200, 'g').total.kcal, 300, 1e-9));
});

test('rollups exclude optional components by default, like everything else', () => {
  const database = db(
    [
      purchased('base', { nutrientsPer100g: { kcal: 100, proteinG: 0, fatG: 0, carbG: 0 } }),
      purchased('garnish', { nutrientsPer100g: { kcal: 500, proteinG: 0, fatG: 0, carbG: 0 } }),
      made('dish', { densityGPerMl: 1 }),
    ],
    [
      recipe('dish', 100, [
        { itemId: 'base', qty: 100, uom: 'g' },
        { itemId: 'garnish', qty: 100, uom: 'g', optional: true },
      ]),
    ],
  );

  // The default has to describe the same dish the tree and the shopping list do.
  const plain = costOf(database, 'dish', 100, 'g');
  assert.ok(close(plain.total, 1, 1e-9), `got ${plain.total}`);
  assert.ok(!plain.lines.some((line) => line.itemId === 'garnish'));
  assert.ok(close(nutritionOf(database, 'dish', 100, 'g').total.kcal, 100, 1e-9));

  const garnished = costOf(database, 'dish', 100, 'g', { includeOptional: true });
  assert.ok(close(garnished.total, 2, 1e-9));
  assert.ok(garnished.lines.some((line) => line.itemId === 'garnish'));
  assert.ok(
    close(nutritionOf(database, 'dish', 100, 'g', { includeOptional: true }).total.kcal, 600, 1e-9),
  );

  // And the per-unit standard rate agrees with whichever view is asked for.
  assert.ok(close(rollupUnitCost(database, 'dish').total, 0.01, 1e-9));
  assert.ok(close(rollupUnitCost(database, 'dish', { includeOptional: true }).total, 0.02, 1e-9));
});

test('nothing costs nothing, fixed components included', () => {
  const database = db(
    [
      purchased('base', { nutrientsPer100g: { kcal: 100, proteinG: 0, fatG: 0, carbG: 0 } }),
      purchased('spice', { nutrientsPer100g: { kcal: 300, proteinG: 0, fatG: 0, carbG: 0 } }),
      made('batch', { densityGPerMl: 1 }),
    ],
    [
      recipe('batch', 100, [
        { itemId: 'base', qty: 100, uom: 'g' },
        // The pinch that does not shrink with the batch is exactly what made a
        // zero-sized request cost something.
        { itemId: 'spice', qty: 10, uom: 'g', scalable: false },
      ]),
    ],
  );

  const cost = costOf(database, 'batch', 0, 'g');
  assert.equal(cost.total, 0);
  assert.deepEqual(cost.lines, []);
  assert.equal(nutritionOf(database, 'batch', 0, 'g').total.kcal, 0);

  // A real quantity still charges the fixed pinch once.
  assert.ok(close(costOf(database, 'batch', 100, 'g').total, 1.1, 1e-9));
});

test('a negative quantity is refused rather than costed', () => {
  const database = nestedDb();
  assert.throws(() => costOf(database, 'dish', -100, 'g'), MiseError);
  assert.throws(() => nutritionOf(database, 'dish', -100, 'g'), MiseError);
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

test('hands-on time scales with the quantity; unattended time does not', () => {
  const database = db(
    [purchased('mince'), made('ragu')],
    [
      recipe('ragu', 1000, [{ itemId: 'mince', qty: 500, uom: 'g' }], {
        steps: [
          { text: 'brown', activeMin: 60 },
          { text: 'simmer', passiveMin: 120 },
        ],
      }),
    ],
  );

  const one = rollupTime(database, 'ragu', 1000, 'g');
  assert.equal(one.activeMin, 60);
  assert.equal(one.criticalPathMin, 180);

  // Twenty batches: twenty rounds of browning, one shared simmer alongside.
  const twenty = rollupTime(database, 'ragu', 20_000, 'g');
  assert.equal(twenty.activeMin, 1200, 'the mince still has to be browned twenty times');
  assert.equal(twenty.passiveMin, 120, 'the pots all simmer at once');
  assert.equal(twenty.criticalPathMin, 1320);

  // Unscaled keeps the recipe-card reading; nothing takes negative time.
  assert.equal(rollupTime(database, 'ragu').activeMin, 60);
  assert.equal(rollupTime(database, 'ragu', 0, 'g').criticalPathMin, 0);
  assert.throws(() => rollupTime(database, 'ragu', -1, 'g'), MiseError);
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

test('optional allergens warn when the optional view is on', () => {
  const database = db(
    [
      purchased('pasta'),
      purchased('walnuts', { allergens: ['nuts'] }),
      made('salad'),
    ],
    [
      recipe('salad', 500, [
        { itemId: 'pasta', qty: 400, uom: 'g' },
        { itemId: 'walnuts', qty: 50, uom: 'g', optional: true },
      ]),
    ],
  );
  database.settings = {
    ...database.settings,
    household: [{ name: 'Cleo', appetite: 1, avoids: ['nuts'] }],
  };

  // Plain dish, plain answer: the walnuts stay in the packet.
  assert.deepEqual(dietaryConflicts(database, 'salad'), []);
  // But the dish being analysed with them included must warn about them.
  const withOptional = dietaryConflicts(database, 'salad', { includeOptional: true });
  assert.equal(withOptional.length, 1);
  assert.deepEqual(withOptional[0]!.allergens, ['nuts']);
});

test('passive overhead is charged once, not once per batch', () => {
  const database = db(
    [purchased('mince'), made('ragu')],
    [
      recipe('ragu', 1000, [{ itemId: 'mince', qty: 500, uom: 'g' }], {
        steps: [
          { text: 'brown', activeMin: 10 },
          { text: 'simmer', passiveMin: 60 },
        ],
      }),
    ],
  );
  database.settings = { ...database.settings, overheadPerHour: 60 }; // £1 a minute

  // Two batches: browning twice, one shared simmer — 80 minutes of hob, not
  // 140. The same policy runMinutes applies to the clock applies to the bill.
  const report = costOf(database, 'ragu', 2000, 'g');
  assert.ok(close(report.overhead, 80), `got ${report.overhead}`);
});

test('a recipe hole is reported, not priced as free food', () => {
  const database = db(
    [purchased('flour'), made('bread')],
    [
      recipe('bread', 1000, [
        { itemId: 'flour', qty: 600, uom: 'g' },
        { itemId: 'ghost', qty: 100, uom: 'g' },
      ]),
    ],
  );

  const cost = costOf(database, 'bread', 1000, 'g');
  assert.equal(cost.complete, false, 'a missing component cannot make a complete total');
  assert.ok(cost.missing.includes('ghost'));

  const facts = nutritionOf(database, 'bread', 1000, 'g');
  assert.equal(facts.complete, false);
  assert.ok(facts.missing.includes('ghost'));
});

test('the seven-level Escoffier chain costs out completely', () => {
  const database = seedDatabase();
  const report = costOf(database, 'chicken-chasseur', 1200, 'g');

  assert.equal(report.complete, true, 'every leaf under the demi-glace has a price');
  assert.equal(report.servings, 4);
  assert.ok(report.perServing > 1 && report.perServing < 10, `got ${report.perServing}`);

  // Allergens climb the whole chain: the sulphites are the wine in the pan
  // sauce, the gluten and milk are the brown roux five levels down.
  const allergens = rollupAllergens(database, 'chicken-chasseur').map((hit) => hit.allergen);
  assert.deepEqual([...allergens].sort(), ['gluten', 'milk', 'sulphites']);
});
