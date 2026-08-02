import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CycleError, MiseError } from '../src/domain/errors.js';
import { seedDatabase } from '../src/data/seed.js';
import { aggregate, aggregateAll, explode, flatten, quantityForServings } from '../src/engine/explode.js';
import { close, db, made, nestedDb, phantom, purchased, recipe } from './helpers.js';

test('recursion reaches every level without knowing how deep it goes', () => {
  const nodes = flatten(explode(nestedDb(), { itemId: 'dish', qty: 1500, uom: 'g' }));
  const depthOf = (itemId: string): number[] =>
    nodes.filter((node) => node.itemId === itemId).map((node) => node.depth).sort();

  assert.deepEqual(depthOf('dish'), [0]);
  assert.deepEqual(depthOf('sauce'), [1]);
  assert.deepEqual(depthOf('roux'), [2]);
  // Butter is genuinely at two different depths: directly under the crust, and
  // three levels down under sauce > roux.
  assert.deepEqual(depthOf('butter'), [2, 3]);
});

test('quantities scale by batch factor at every hop', () => {
  // Two batches of dish -> 2000 g sauce -> 400 g roux -> 200 g butter.
  const tree = explode(nestedDb(), { itemId: 'dish', qty: 3000, uom: 'g' });
  const nodes = flatten(tree);
  const butterUnderRoux = nodes.find((n) => n.itemId === 'butter' && n.path.includes('roux'));

  assert.ok(butterUnderRoux);
  assert.ok(close(butterUnderRoux.grossQty, 200), `got ${butterUnderRoux.grossQty}`);
});

test('aggregation pools an ingredient reachable by several paths', () => {
  const tree = explode(nestedDb(), { itemId: 'dish', qty: 1500, uom: 'g' });
  const requirements = aggregate(tree, { level: 'leaves' });
  const butter = requirements.find((r) => r.itemId === 'butter');

  // 100 g through the roux, 100 g through the crust.
  assert.ok(butter);
  assert.ok(close(butter.qty, 200), `got ${butter.qty}`);
  assert.equal(butter.occurrences, 2);
  assert.deepEqual([...butter.usedIn].sort(), ['crust', 'roux']);
});

test('prep loss is grossed up on the way down', () => {
  const database = db(
    [purchased('onion'), made('soup')],
    [recipe('soup', 1000, [{ itemId: 'onion', qty: 90, uom: 'g', lossPct: 0.1 }])],
  );
  const tree = explode(database, { itemId: 'soup', qty: 1000, uom: 'g' });
  const onion = tree.children[0]!;

  assert.equal(onion.netQty, 90);
  assert.ok(close(onion.grossQty, 100), `got ${onion.grossQty}`);
});

test('components marked non-scalable do not multiply with the batch', () => {
  const database = db(
    [purchased('bay', { stockUom: 'ea', unitWeightG: 0.2 }), purchased('stock'), made('stew')],
    [
      recipe('stew', 1000, [
        { itemId: 'bay', qty: 2, uom: 'ea', scalable: false },
        { itemId: 'stock', qty: 500, uom: 'g' },
      ]),
    ],
  );
  const tree = explode(database, { itemId: 'stew', qty: 4000, uom: 'g' });
  const byId = new Map(tree.children.map((child) => [child.itemId, child]));

  assert.equal(byId.get('bay')!.grossQty, 2, 'four batches still need two bay leaves');
  assert.equal(byId.get('stock')!.grossQty, 2000, 'everything else quadruples');
});

test('phantoms appear in the tree but not in stockable requirements', () => {
  const tree = explode(nestedDb(), { itemId: 'dish', qty: 1500, uom: 'g' });

  assert.ok(flatten(tree).some((node) => node.itemId === 'roux' && node.phantom));
  const stocked = aggregate(tree, { level: 'stocked' }).map((r) => r.itemId);
  assert.ok(!stocked.includes('roux'), 'a phantom is never something you hold');
  assert.ok(stocked.includes('sauce'), 'a stocked sub-recipe is');
});

test('stopAt truncates expansion where you want to buy instead of make', () => {
  const tree = explode(nestedDb(), { itemId: 'dish', qty: 1500, uom: 'g', stopAt: new Set(['sauce']) });
  const sauce = tree.children.find((child) => child.itemId === 'sauce')!;

  assert.equal(sauce.stopped, true);
  assert.equal(sauce.children.length, 0);
  assert.ok(aggregate(tree, { level: 'leaves' }).some((r) => r.itemId === 'sauce'));
});

test('optional components are excluded unless asked for', () => {
  const database = db(
    [purchased('base'), purchased('garnish'), made('dish')],
    [
      recipe('dish', 100, [
        { itemId: 'base', qty: 100, uom: 'g' },
        { itemId: 'garnish', qty: 10, uom: 'g', optional: true },
      ]),
    ],
  );

  assert.equal(explode(database, { itemId: 'dish', qty: 100 }).children.length, 1);
  assert.equal(explode(database, { itemId: 'dish', qty: 100, includeOptional: true }).children.length, 2);
});

test('a self-referential recipe is caught rather than recursed forever', () => {
  const database = db(
    [purchased('flour'), made('starter')],
    [
      recipe('starter', 200, [
        { itemId: 'starter', qty: 50, uom: 'g' },
        { itemId: 'flour', qty: 150, uom: 'g' },
      ]),
    ],
  );

  assert.throws(
    () => explode(database, { itemId: 'starter', qty: 200 }),
    (error: unknown) => {
      assert.ok(error instanceof CycleError);
      assert.deepEqual(error.path, ['starter', 'starter']);
      return true;
    },
  );
});

test('an indirect cycle is caught too', () => {
  const database = db(
    [made('a'), made('b'), made('c')],
    [
      recipe('a', 100, [{ itemId: 'b', qty: 50, uom: 'g' }]),
      recipe('b', 100, [{ itemId: 'c', qty: 50, uom: 'g' }]),
      recipe('c', 100, [{ itemId: 'a', qty: 50, uom: 'g' }]),
    ],
  );
  assert.throws(() => explode(database, { itemId: 'a', qty: 100 }), CycleError);
});

test('servings convert to quantity through the recipe yield', () => {
  const database = nestedDb();
  // dish yields 1500 g for 4 servings.
  assert.equal(quantityForServings(database, 'dish', 4).qty, 1500);
  assert.equal(quantityForServings(database, 'dish', 2).qty, 750);
  assert.equal(quantityForServings(database, 'dish', 8).qty, 3000);
});

test('a week of meals merges into one requirement list', () => {
  const database = nestedDb();
  const trees = [
    explode(database, { itemId: 'dish', servings: 4 }),
    explode(database, { itemId: 'crust', qty: 300, uom: 'g' }),
  ];
  const merged = aggregateAll(trees, { level: 'leaves' });
  const butter = merged.find((r) => r.itemId === 'butter')!;

  // 200 g from the dish (roux + crust) plus 100 g from the standalone crust.
  assert.ok(close(butter.qty, 300), `got ${butter.qty}`);
});

test('the shipped example database explodes four levels deep', () => {
  const database = seedDatabase();
  const tree = explode(database, { itemId: 'lasagne', servings: 6 });
  const butter = flatten(tree).find((node) => node.path.join('>').includes('roux>butter'));

  assert.ok(butter, 'butter should be reachable via lasagne > besciamella > roux');
  assert.equal(butter.depth, 3);
});

test('the Escoffier chain explodes seven levels deep', () => {
  const database = seedDatabase();
  const nodes = flatten(explode(database, { itemId: 'chicken-chasseur', servings: 4 }));
  const carrot = nodes.find((node) =>
    node.path.join('>').includes('demi-glace>espagnole>brown-stock>mirepoix>carrot'),
  );

  assert.ok(carrot, 'carrot is reachable via chasseur > sauce > demi-glace > espagnole > brown stock > mirepoix');
  assert.equal(carrot.depth, 6);
  // Butter twice under one dish: in the pan sauce, and in the espagnole's
  // brown roux four levels further down.
  assert.equal(nodes.filter((node) => node.itemId === 'butter').length, 2);
});

test('mirepoix appears under both stocks and the espagnole, and is netted once', () => {
  const database = seedDatabase();
  const tree = explode(database, { itemId: 'chicken-chasseur', servings: 4 });
  const mirepoix = flatten(tree).filter((node) => node.itemId === 'mirepoix');

  // espagnole directly, espagnole's brown stock, and the demi-glace's own
  // brown stock — three distinct paths through one phantom.
  assert.equal(mirepoix.length, 3);
  assert.ok(mirepoix.every((node) => node.phantom));

  const carrot = aggregate(tree, { level: 'leaves' }).find((r) => r.itemId === 'carrot')!;
  assert.equal(carrot.occurrences, 3, 'three appearances pool into one line');
});

test('a dish can be an ingredient of another dish', () => {
  const database = seedDatabase();
  const tree = explode(database, { itemId: 'eggs-benedict', servings: 4 });
  const starter = flatten(tree).find((node) => node.path.join('>').includes('sourdough>levain>starter'));

  assert.ok(starter, 'the benedict reaches the sourdough starter through the loaf it toasts');
  const stocked = aggregate(tree, { level: 'stocked' }).map((r) => r.itemId);
  assert.ok(stocked.includes('sourdough'), 'the loaf is stockable — bake once, use twice');
});

test('a zero requirement expands to nothing, fixed components included', () => {
  const database = db(
    [purchased('bay', { stockUom: 'ea', unitWeightG: 0.2 }), purchased('stock'), made('stew')],
    [
      recipe('stew', 1000, [
        { itemId: 'bay', qty: 2, uom: 'ea', scalable: false },
        { itemId: 'stock', qty: 500, uom: 'g' },
      ]),
    ],
  );

  const tree = explode(database, { itemId: 'stew', qty: 0, uom: 'g' });
  assert.equal(tree.grossQty, 0);
  assert.deepEqual(tree.children, [], 'no bay leaf for a stew nobody is making');
  assert.deepEqual(aggregate(tree, { level: 'leaves' }), []);
});

test('a valid chain deeper than any arbitrary ceiling still reaches its leaves', () => {
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

  const nodes = flatten(explode(database, { itemId: 'level-19', qty: 100, uom: 'g' }));
  const leaf = nodes.find((node) => node.itemId === 'leaf');

  assert.ok(leaf, 'the purchased leaf at depth 20 is reached');
  assert.equal(leaf.depth, 20);
  assert.ok(!nodes.some((node) => node.stopped), 'nothing was silently truncated');
});

test('a negative requirement is refused', () => {
  const database = nestedDb();
  assert.throws(() => explode(database, { itemId: 'dish', qty: -100, uom: 'g' }), MiseError);
  assert.throws(() => explode(database, { itemId: 'dish', servings: -1 }), MiseError);
});
