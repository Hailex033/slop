import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShortageError } from '../src/domain/errors.js';
import {
  adjust,
  availableOn,
  expiring,
  fefo,
  issue,
  onHand,
  onOrder,
  isUsableOn,
  receive,
  stockReport,
  stockValue,
  sweepExpired,
  usableLots,
} from '../src/engine/inventory.js';
import { close, db, purchased } from './helpers.js';

function pantry() {
  return db([purchased('milk', { stockUom: 'ml', shelfLifeDays: 7 }), purchased('flour')]);
}

test('receipts create lots and the ledger records them', () => {
  const database = pantry();
  receive(database, 'flour', { qty: 1, uom: 'kg', on: '2026-07-01', unitCost: 0.002 });

  assert.equal(onHand(database, 'flour'), 1000, 'stored in the stock unit, not the pack unit');
  assert.equal(database.ledger.length, 1);
  assert.equal(database.ledger[0]!.type, 'receipt');
  assert.ok(close(stockValue(database), 2));
});

test('shelf life sets an expiry automatically', () => {
  const database = pantry();
  const lot = receive(database, 'milk', { qty: 1000, on: '2026-07-01' });
  assert.equal(lot.expiresOn, '2026-07-08');
});

test('issues take from the soonest-expiring lot first', () => {
  const database = pantry();
  receive(database, 'milk', { qty: 500, on: '2026-07-01', expiresOn: '2026-07-20', unitCost: 0.001 });
  receive(database, 'milk', { qty: 500, on: '2026-07-02', expiresOn: '2026-07-05', unitCost: 0.002 });

  const result = issue(database, 'milk', { qty: 600, on: '2026-07-03' });

  // 500 from the 5 July lot at 0.002, then 100 from the 20 July lot at 0.001.
  assert.ok(close(result.cost, 1.1), `got ${result.cost}`);
  assert.equal(onHand(database, 'milk'), 400);
  assert.equal(database.lots.length, 1, 'the emptied lot is gone');
  assert.equal(database.lots[0]!.expiresOn, '2026-07-20');
});

test('undated lots queue behind dated ones, oldest first', () => {
  const lots = fefo([
    { id: 'c', itemId: 'x', qty: 1, receivedOn: '2026-01-03' },
    { id: 'a', itemId: 'x', qty: 1, receivedOn: '2026-01-02', expiresOn: '2026-02-01' },
    { id: 'b', itemId: 'x', qty: 1, receivedOn: '2026-01-01' },
  ]);
  assert.deepEqual(lots.map((lot) => lot.id), ['a', 'b', 'c']);
});

test('issuing more than you have is refused unless explicitly allowed', () => {
  const database = pantry();
  receive(database, 'flour', { qty: 100 });

  assert.throws(() => issue(database, 'flour', { qty: 500 }), ShortageError);
  assert.equal(onHand(database, 'flour'), 100, 'a refused issue changes nothing');

  const forced = issue(database, 'flour', { qty: 500, allowNegative: true });
  assert.equal(forced.issued, 100);
  assert.equal(forced.shortfall, 400);
  assert.equal(onHand(database, 'flour'), 0);
});

test('expiry reporting counts days from the date asked about', () => {
  const database = pantry();
  receive(database, 'milk', { qty: 500, on: '2026-07-01', expiresOn: '2026-07-04' });
  receive(database, 'milk', { qty: 500, on: '2026-07-01', expiresOn: '2026-07-30' });

  assert.equal(expiring(database, 7, '2026-07-02').length, 1);
  assert.equal(expiring(database, 40, '2026-07-02').length, 2);
  assert.equal(expiring(database, 7, '2026-07-02')[0]!.daysLeft, 2);
});

test('sweeping writes off what is past its date and leaves the rest', () => {
  const database = pantry();
  receive(database, 'milk', { qty: 500, on: '2026-07-01', expiresOn: '2026-07-04', unitCost: 0.001 });
  receive(database, 'milk', { qty: 300, on: '2026-07-01', expiresOn: '2026-07-30', unitCost: 0.001 });

  const wasted = sweepExpired(database, '2026-07-10');

  assert.equal(wasted.length, 1);
  assert.ok(close(wasted[0]!.cost, 0.5));
  assert.equal(onHand(database, 'milk'), 300);

  // The ledger has to reconcile with the waste report; posting the quantity
  // after clearing the lot would silently record a zero.
  const waste = database.ledger.find((txn) => txn.type === 'waste');
  assert.ok(waste);
  assert.equal(waste.qty, -500);
});

test('open purchase orders count as supply, received ones do not', () => {
  const database = pantry();
  database.purchaseOrders.push({
    id: 'PO-0001',
    supplierId: 'shop',
    orderedOn: '2026-07-01',
    expectedOn: '2026-07-03',
    status: 'open',
    lines: [{ itemId: 'flour', packs: 3, unitPrice: 1 }],
  });

  // Three packs of 100 g.
  assert.equal(onOrder(database, 'flour', '2026-07-05'), 300);
  assert.equal(onOrder(database, 'flour', '2026-07-02'), 0, 'not here yet');

  database.purchaseOrders[0]!.status = 'received';
  assert.equal(onOrder(database, 'flour', '2026-07-05'), 0);
});

test('expired lots are physically present but not available', () => {
  const database = pantry();
  receive(database, 'milk', { qty: 500, on: '2026-06-01', expiresOn: '2026-06-10' });
  receive(database, 'milk', { qty: 300, on: '2026-06-01', expiresOn: '2026-08-01' });

  assert.equal(onHand(database, 'milk'), 800, 'both cartons are in the fridge');
  assert.equal(availableOn(database, 'milk', '2026-07-01'), 300, 'only one is drinkable');
  assert.equal(availableOn(database, 'milk', '2026-06-05'), 800);
  assert.equal(availableOn(database, 'milk', '2026-06-10'), 800, 'good through its date');
});

test('issuing skips lots that have gone off by the issue date', () => {
  const database = pantry();
  receive(database, 'milk', { qty: 500, on: '2026-06-01', expiresOn: '2026-06-10', unitCost: 0.001 });
  receive(database, 'milk', { qty: 300, on: '2026-06-01', expiresOn: '2026-08-01', unitCost: 0.002 });

  const result = issue(database, 'milk', { qty: 400, on: '2026-07-01', allowNegative: true });

  assert.equal(result.issued, 300, 'the off carton is not usable');
  assert.equal(result.shortfall, 100);
  assert.equal(onHand(database, 'milk'), 500, 'and is still sitting there to be binned');
});

test('a stocktake posts the movement exactly once', () => {
  const database = pantry();
  receive(database, 'flour', { qty: 10, on: '2026-07-01' });
  database.ledger = [];

  const txns = adjust(database, 'flour', 15, '2026-07-01');

  assert.equal(onHand(database, 'flour'), 15);
  assert.equal(database.ledger.length, 1, 'one movement, one ledger line');
  assert.equal(database.ledger[0]!.type, 'adjust');
  assert.equal(database.ledger.reduce((sum, txn) => sum + txn.qty, 0), 5);
  assert.equal(txns.length, 1);
});

test('a stocktake downwards reconciles too, and can reach expired stock', () => {
  const database = pantry();
  receive(database, 'milk', { qty: 500, on: '2026-06-01', expiresOn: '2026-06-10' });
  database.ledger = [];

  adjust(database, 'milk', 200, '2026-07-01');

  assert.equal(onHand(database, 'milk'), 200);
  assert.equal(database.ledger.reduce((sum, txn) => sum + txn.qty, 0), -300);
  assert.ok(database.ledger.every((txn) => txn.type === 'adjust'));
});

test('a stocktake that finds nothing wrong posts nothing', () => {
  const database = pantry();
  receive(database, 'flour', { qty: 10, on: '2026-07-01' });
  database.ledger = [];

  assert.deepEqual(adjust(database, 'flour', 10, '2026-07-01'), []);
  assert.equal(database.ledger.length, 0);
});

test('an item with a safety level stays on the report after running out', () => {
  const database = db([purchased('butter', { safetyStock: 100 }), purchased('flour')]);
  receive(database, 'butter', { qty: 50, on: '2026-07-01' });

  const stocked = stockReport(database, '2026-07-02');
  assert.equal(stocked.length, 1);
  assert.equal(stocked[0]!.belowSafety, true);

  issue(database, 'butter', { qty: 50, on: '2026-07-02' });
  const empty = stockReport(database, '2026-07-02');

  assert.equal(empty.length, 1, 'it must not vanish when it matters most');
  assert.equal(empty[0]!.item.id, 'butter');
  assert.equal(empty[0]!.qty, 0);
  assert.equal(empty[0]!.usable, 0);
  assert.equal(empty[0]!.lots, 0);
  assert.equal(empty[0]!.belowSafety, true);
});

test('items with no safety level appear only when they are actually in stock', () => {
  const database = db([purchased('butter'), purchased('flour')]);
  assert.deepEqual(stockReport(database, '2026-07-02'), [], 'an empty pantry is an empty report');

  receive(database, 'flour', { qty: 100, on: '2026-07-01' });
  assert.deepEqual(
    stockReport(database, '2026-07-02').map((line) => line.item.id),
    ['flour'],
  );
});

test('a lot cannot be used before the day it arrived', () => {
  const database = pantry();
  receive(database, 'flour', { qty: 500, on: '2026-07-10' });

  assert.equal(onHand(database, 'flour'), 500, 'it exists in the books');
  assert.equal(availableOn(database, 'flour', '2026-07-01'), 0, 'but not yet on the shelf');
  assert.equal(availableOn(database, 'flour', '2026-07-10'), 500, 'available the day it lands');
  assert.equal(availableOn(database, 'flour', '2026-07-11'), 500);

  assert.throws(() => issue(database, 'flour', { qty: 100, on: '2026-07-01' }), ShortageError);
  assert.equal(issue(database, 'flour', { qty: 100, on: '2026-07-10' }).issued, 100);
});

test('back-dating an issue to after the receipt is still fine', () => {
  const database = pantry();
  receive(database, 'flour', { qty: 500, on: '2026-07-01' });
  // Recording on Friday that you cooked on Wednesday, with stock in since Monday.
  assert.equal(issue(database, 'flour', { qty: 100, on: '2026-07-03' }).issued, 100);
});

test('every availability path applies the same usability rule', () => {
  // These four used to decide "is this lot usable" separately, and drifted.
  const database = db([purchased('butter', { safetyStock: 100 })]);
  receive(database, 'butter', { qty: 500, on: '2026-07-10' });

  const asOf = '2026-07-01';
  assert.equal(isUsableOn(database.lots[0]!, asOf), false);
  assert.equal(availableOn(database, 'butter', asOf), 0);
  assert.equal(usableLots(database, 'butter', asOf).length, 0);
  assert.equal(stockReport(database, asOf)[0]!.usable, 0);
  assert.equal(stockReport(database, asOf)[0]!.belowSafety, true, 'the buffer is not covered yet');

  // ...and all four agree once it has landed.
  const later = '2026-07-10';
  assert.equal(isUsableOn(database.lots[0]!, later), true);
  assert.equal(availableOn(database, 'butter', later), 500);
  assert.equal(usableLots(database, 'butter', later).length, 1);
  assert.equal(stockReport(database, later)[0]!.usable, 500);
  assert.equal(stockReport(database, later)[0]!.belowSafety, false);
});
