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

test('where-used climbs past any arbitrary ceiling', () => {
  const items = [purchased('leaf')];
  const recipes = [];
  let prev = 'leaf';
  for (let i = 0; i < 20; i += 1) {
    const id = `level-${i}`;
    items.push(made(id));
    recipes.push(recipe(id, 100, [{ itemId: prev, qty: 100, uom: 'g' }]));
    prev = id;
  }
  const database = db(items, recipes);

  let node = whereUsed(database, 'leaf');
  let depth = 0;
  while (node.children.length > 0) {
    node = node.children[0]!;
    depth += 1;
  }

  assert.equal(depth, 20, 'the top-level dish twenty parents up is reached');
  assert.equal(node.itemId, 'level-19');
});

test('duplicate suppliers and impossible slots are integrity problems', () => {
  const database = db([purchased('flour')]);
  database.suppliers.push({ id: 'shop', name: 'Shop again', leadTimeDays: 2 });
  database.mealPlan.push({
    id: 'MP-1', date: '2026-07-03', slot: 'supper' as never, itemId: 'flour', servings: 2,
  });

  const issues = validate(database);
  assert.ok(issues.some((issue) => issue.includes('Duplicate supplier id')), JSON.stringify(issues));
  assert.ok(issues.some((issue) => issue.includes('unknown slot "supper"')));
});

test('a negative lead time is an integrity problem', () => {
  // Bought "minus two days out", the shop is scheduled after the dinner and
  // the committed order arrives before it was placed.
  const database = db([
    purchased('flour', {
      purchase: { supplierId: 'shop', packQty: 100, packUom: 'g', packPrice: 1, leadTimeDays: -2 },
    }),
    purchased('rice2', {
      purchase: { supplierId: 'shop', packQty: 500, packUom: 'g', packPrice: 2, leadTimeDays: 0, moqPacks: 'oops' as never },
    }),
    // 1e309 is valid JSON and Infinity in memory: zero packs, no order.
    purchased('bulk9', {
      purchase: { supplierId: 'shop', packQty: 1e309, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
    }),
  ]);
  database.suppliers.push({ id: 'slowpost', name: 'Slow Post', leadTimeDays: Number.NaN });

  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('Item "flour" has an invalid leadTimeDays of -2')), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.includes('Supplier "slowpost" has an invalid leadTimeDays')));
  // A mangled minimum order reaches pack rounding as NaN and the committed
  // order serialises its pack count as null.
  assert.ok(issues.some((i) => i.includes('invalid moqPacks of oops')));
  assert.ok(issues.some((i) => i.includes('Item "bulk9" has an invalid packQty of Infinity')));
});

test('an unpriced-by-accident item is an integrity problem, not free food', () => {
  // `null < 0` is false: doctor approved it while every cost coerced the
  // price to zero and shop --commit snapshotted free orders.
  const database = db([
    purchased('mystery2', {
      purchase: { supplierId: 'shop', packQty: 100, packUom: 'g', packPrice: null as never, leadTimeDays: 0 },
    }),
  ]);

  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('invalid packPrice of null')), JSON.stringify(issues));
});

test('duplicate ids anywhere in the book are integrity problems', () => {
  const database = db(
    [purchased('flour'), made('loaf9')],
    [recipe('loaf9', 1000, [{ itemId: 'flour', qty: 600, uom: 'g' }])],
  );
  database.lots.push(
    { id: 'LOT-9', itemId: 'flour', qty: 100, receivedOn: '2026-07-01' },
    { id: 'LOT-9', itemId: 'flour', qty: 50, receivedOn: '2026-07-02' },
  );
  database.mealPlan.push(
    { id: 'MP-9', date: '2026-07-03', slot: 'dinner', itemId: 'loaf9', servings: 2 },
    { id: 'MP-9', date: '2026-07-04', slot: 'dinner', itemId: 'loaf9', servings: 2 },
  );
  database.purchaseOrders.push(
    {
      id: 'PO-9', supplierId: 'shop', orderedOn: '2026-07-01', expectedOn: '2026-07-02', status: 'open',
      lines: [{ itemId: 'flour', packs: 1, unitPrice: 1 }],
    },
    {
      id: 'PO-9', supplierId: 'shop', orderedOn: '2026-07-01', expectedOn: '2026-07-02', status: 'open',
      lines: [{ itemId: 'flour', packs: 1, unitPrice: 1 }],
    },
  );
  database.productionOrders.push(
    { id: 'PRD-9', itemId: 'loaf9', qty: 100, dueOn: '2026-07-03', startOn: '2026-07-03', status: 'open' },
    { id: 'PRD-9', itemId: 'loaf9', qty: 100, dueOn: '2026-07-03', startOn: '2026-07-03', status: 'open' },
  );

  // `.find()` only ever reaches the first of each pair: the twin order is
  // unreceivable, and shared lot ids make ledger origins ambiguous.
  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('Duplicate lot id "LOT-9"')), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.includes('Duplicate meal plan entry id "MP-9"')));
  assert.ok(issues.some((i) => i.includes('Duplicate purchase order id "PO-9"')));
  assert.ok(issues.some((i) => i.includes('Duplicate production order id "PRD-9"')));
});

test('a negative conversion coefficient is an integrity problem', () => {
  const database = db([
    purchased('oil', { stockUom: 'ml', densityGPerMl: -0.9 }),
    purchased('egg2', { stockUom: 'ea', unitWeightG: 0 }),
    // Expires before it arrives; a buffer floor below empty.
    purchased('sad-yog', { shelfLifeDays: -3, safetyStock: -1 }),
  ]);

  const issues = validate(database);
  assert.ok(issues.some((issue) => issue.includes('non-positive densityGPerMl')), JSON.stringify(issues));
  assert.ok(issues.some((issue) => issue.includes('non-positive unitWeightG')));
  assert.ok(issues.some((issue) => issue.includes('invalid shelfLifeDays of -3')));
  assert.ok(issues.some((issue) => issue.includes('invalid safetyStock of -1')));
});

test('impossible served counts and orphaned orders are integrity problems', () => {
  const database = db([purchased('flour')]);
  database.mealPlan.push({
    id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'flour', servings: 4, servedServings: -2,
  });
  database.mealPlan.push({
    id: 'MP-2', date: '2026-07-04', slot: 'dinner', itemId: 'flour', servings: 4, servedServings: 9,
  });
  database.purchaseOrders.push({
    id: 'PO-1', supplierId: 'nobody', orderedOn: '2026-07-01', expectedOn: '2026-07-02', status: 'open',
    lines: [{ itemId: 'ghost', packs: 1, unitPrice: 1 }],
  });
  database.productionOrders.push({
    id: 'PRD-1', itemId: 'vanished', qty: 100, dueOn: '2026-07-03', startOn: '2026-07-03', status: 'open',
  });

  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('invalid servedServings of -2')), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.includes('invalid servedServings of 9')));
  assert.ok(issues.some((i) => i.includes('unknown supplier "nobody"')));
  assert.ok(issues.some((i) => i.includes('line for unknown item "ghost"')));
  assert.ok(issues.some((i) => i.includes('Production order "PRD-1" references unknown item')));
});

test('zero servings on the plan is an integrity problem', () => {
  // `plan add` refuses this too; a hand-edited file is doctor's job.
  const database = db([purchased('flour')]);
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'flour', servings: 0 });

  const issues = validate(database);
  assert.ok(issues.some((issue) => issue.includes('invalid servings')), JSON.stringify(issues));
});

test('a phantom on the meal plan is an integrity problem', () => {
  const database = nestedDb();
  // `plan add` refuses this; a hand-edited file can still contain it, and
  // doctor must say so rather than leave an unservable dinner standing.
  database.mealPlan.push({ id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'roux', servings: 2 });

  const issues = validate(database);
  assert.ok(issues.some((issue) => issue.includes('phantom')), JSON.stringify(issues));
});

test('dates that are not dates are integrity problems too', () => {
  const database = db([purchased('flour')]);
  database.mealPlan.push({
    id: 'MP-1', date: 'tomorrow' as never, slot: 'dinner', itemId: 'flour', servings: 2,
  });
  database.lots.push({ id: 'LOT-1', itemId: 'flour', qty: 100, receivedOn: '2026-02-30' as never });

  const issues = validate(database);
  assert.ok(issues.some((issue) => issue.includes('invalid date "tomorrow"')), JSON.stringify(issues));
  assert.ok(issues.some((issue) => issue.includes('invalid receivedOn date "2026-02-30"')));
});

test('history and order lines are integrity-checked too', () => {
  const database = db([purchased('flour')]);
  // A deleted item whose transactions survive: the ledger report renders it
  // by id, and doctor must say the master lost something the books mention.
  database.ledger.push({
    id: 'TXN-1', at: '2026-07-01', type: 'receive', itemId: 'vanished', qty: 100, uom: 'g',
  } as never);
  database.purchaseOrders.push({
    id: 'PO-1', supplierId: 'shop', orderedOn: '2026-07-01', expectedOn: '2026-07-02', status: 'open',
    lines: [
      { itemId: 'flour', packs: 0, unitPrice: 1 },
      { itemId: 'flour', packs: 1, unitPrice: -1 },
    ],
  });

  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('Ledger entry "TXN-1"')), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.includes('invalid packs (0)')));
  assert.ok(issues.some((i) => i.includes('invalid unitPrice (-1)')));
});

test('quantities that are not numbers are integrity problems', () => {
  const database = db(
    [purchased('flour'), made('bread2')],
    [
      recipe('bread2', Number.NaN, [
        { itemId: 'flour', qty: 'oops' as never, uom: 'g' },
        { itemId: 'flour', qty: 100, uom: 'g', lossPct: Number.NaN },
      ]),
    ],
  );
  database.lots.push({ id: 'LOT-1', itemId: 'flour', qty: 'oops' as never, receivedOn: '2026-07-01' });
  database.lots.push({ id: 'LOT-2', itemId: 'flour', qty: 10, receivedOn: '2026-07-01', unitCost: -1 });
  database.mealPlan.push({
    id: 'MP-1', date: '2026-07-03', slot: 'dinner', itemId: 'bread2', servings: 'oops' as never,
  });
  database.recipes[0] = {
    ...database.recipes[0]!,
    steps: [{ text: 'rest', activeMin: Number.NaN, passiveMin: -30 }],
  };

  // Every ordered comparison is false for NaN, so all of these passed
  // doctor while production cooked NaN into the ledger, MRP reported
  // uncovered meals as covered, and a NaN-serving dinner simply vanished
  // from every plan.
  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('invalid quantity (oops) of "flour"')), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.includes('out-of-range lossPct')));
  assert.ok(issues.some((i) => i.includes('invalid yield of NaN')));
  assert.ok(issues.some((i) => i.includes('Lot "LOT-1" has an invalid quantity (oops)')));
  assert.ok(issues.some((i) => i.includes('Lot "LOT-2" has an invalid unitCost of -1')));
  assert.ok(issues.some((i) => i.includes('invalid servings of oops')));
  assert.ok(issues.some((i) => i.includes('invalid activeMin of NaN')));
  assert.ok(issues.some((i) => i.includes('invalid passiveMin of -30')));
});

test('order quantities and dates are integrity-checked too', () => {
  const database = db([purchased('flour')]);
  // Doctor used to approve these; executeOrder then refused the zero batch
  // while MRP and prep kept processing the commitment forever.
  database.productionOrders.push({
    id: 'PRD-1', itemId: 'flour', qty: 0, dueOn: '2026-07-03', startOn: '2026-07-03', status: 'open',
  });
  database.productionOrders.push({
    id: 'PRD-2', itemId: 'flour', qty: 100, dueOn: '2026-02-30' as never, startOn: '2026-07-03', status: 'open',
  });
  database.purchaseOrders.push({
    id: 'PO-1', supplierId: 'shop', orderedOn: '2026-07-01', expectedOn: 'someday' as never, status: 'open',
    lines: [{ itemId: 'flour', packs: 1, unitPrice: 1 }],
  });
  // Individually valid dates, impossibly ordered: supply before the batch
  // could exist, a delivery before the order was placed.
  database.productionOrders.push({
    id: 'PRD-3', itemId: 'flour', qty: 100, dueOn: '2026-07-03', startOn: '2026-07-05', status: 'open',
  });
  database.purchaseOrders.push({
    id: 'PO-2', supplierId: 'shop', orderedOn: '2026-07-05', expectedOn: '2026-07-03', status: 'open',
    lines: [{ itemId: 'flour', packs: 1, unitPrice: 1 }],
  });

  const issues = validate(database);
  assert.ok(issues.some((i) => i.includes('invalid qty (0)')), JSON.stringify(issues));
  assert.ok(issues.some((i) => i.includes('invalid dueOn date "2026-02-30"')));
  assert.ok(issues.some((i) => i.includes('invalid expectedOn date "someday"')));
  assert.ok(issues.some((i) => i.includes('starts on 2026-07-05, after it is due')));
  assert.ok(issues.some((i) => i.includes('expected on 2026-07-03, before it was ordered')));
  // And all three orders target purchased flour — unmakeable commitments.
  assert.ok(issues.some((i) => i.includes('only manufactured items are made')));
});

test('two recipes for one item is an integrity problem, not a quiet last-wins', () => {
  const database = db(
    [purchased('flour'), made('bread')],
    [
      recipe('bread', 1000, [{ itemId: 'flour', qty: 600, uom: 'g' }]),
      { ...recipe('bread', 800, [{ itemId: 'flour', qty: 500, uom: 'g' }]), id: 'r-bread-2' },
    ],
  );

  const issues = validate(database);
  assert.ok(issues.some((issue) => issue.includes('more than one recipe')), JSON.stringify(issues));
});

test('where-used shows one entry per parent, lines combined', () => {
  const database = db(
    [purchased('flour'), made('sheets')],
    [
      recipe('sheets', 500, [
        { itemId: 'flour', qty: 300, uom: 'g' },
        { itemId: 'flour', qty: 50, uom: 'g', prep: 'for dusting' },
      ]),
    ],
  );

  const tree = whereUsed(database, 'flour');
  assert.equal(tree.children.length, 1, 'two lines are still one parent');
  assert.equal(tree.children[0]!.qtyPerBatch, 350, 'with the lines combined');
  assert.equal(tree.children[0]!.qtyUom, 'g');
});

test('the shipped example database is internally consistent', () => {
  const database = seedDatabase();
  assert.deepEqual(validate(database), []);
  assert.deepEqual(findCycles(database), []);
});

test('all five mother sauces ship in the item master, each with a recipe', () => {
  const database = seedDatabase();
  // Escoffier's five: béchamel, velouté, espagnole, tomate, hollandaise.
  for (const sauce of ['besciamella', 'veloute', 'espagnole', 'tomato-sauce', 'hollandaise']) {
    assert.ok(database.items.some((item) => item.id === sauce), `${sauce} is missing`);
    assert.ok(database.recipes.some((r) => r.outputItemId === sauce), `${sauce} has no recipe`);
  }
});

test('low-level codes reach six in the expanded graph', () => {
  const codes = lowLevelCodes(seedDatabase());
  // Butter's deepest home is the espagnole's brown roux, five levels under
  // the chasseur; carrot's is the mirepoix inside the brown stock, six.
  assert.equal(codes.get('butter'), 5);
  assert.equal(codes.get('carrot'), 6);
});
