/** The rendered tree's numbers must agree with the engine's. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explode } from '../src/engine/explode.js';
import { costOf } from '../src/engine/rollup.js';
import { money, renderTree } from '../src/report/format.js';
import { db, made, purchased, recipe } from './helpers.js';

test('the cost column prices each node at its own quantity, not a linear rate', () => {
  const database = db(
    [
      purchased('flour'),
      purchased('leaf', {
        stockUom: 'ea',
        purchase: { supplierId: 'shop', packQty: 1, packUom: 'ea', packPrice: 0.5, leadTimeDays: 0 },
      }),
      made('loaf'),
    ],
    [
      recipe('loaf', 1000, [
        { itemId: 'flour', qty: 500, uom: 'g' },
        { itemId: 'leaf', qty: 1, uom: 'ea', scalable: false },
      ]),
    ],
  );

  // Two batches: the flour doubles, the fixed leaf does not — so cost is
  // not linear, and a per-unit rate times the quantity overstates the loaf.
  const tree = explode(database, { itemId: 'loaf', qty: 2000, uom: 'g' });
  const honest = costOf(database, 'loaf', 2000, 'g').total;
  const linear = 2 * costOf(database, 'loaf', 1000, 'g').total;
  assert.ok(honest < linear, 'the fixed leaf makes cost non-linear');

  const rendered = renderTree(tree, {
    costOfNode: (node) => costOf(database, node.itemId, node.grossQty, node.uom).total,
    currency: 'GBP',
  });
  assert.ok(rendered.includes(money(honest, 'GBP')), `expected ${money(honest, 'GBP')} in:\n${rendered}`);
  assert.ok(!rendered.includes(money(linear, 'GBP')), 'the per-batch double-count is gone');
});
