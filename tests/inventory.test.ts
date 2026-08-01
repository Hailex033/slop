import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MiseError, ShortageError } from '../src/domain/errors.js';
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
import { nextId } from '../src/domain/ids.js';
import { close, db, phantom, purchased } from './helpers.js';

test('unfinished future output is not yet in the pantry', () => {
  const database = db([purchased('flour')]);
  receive(database, 'flour', { qty: 100, on: '2026-07-01', unitCost: 0.01 });
  // A multi-day batch executed early books its output at completion.
  receive(database, 'flour', { qty: 900, on: '2026-07-05', unitCost: 0.01 });

  const line = stockReport(database, '2026-07-02').find((l) => l.item.id === 'flour')!;
  assert.ok(close(line.qty, 100), `got ${line.qty}`);
  assert.equal(line.lots, 1, 'the finishing batch is not on the shelf yet');
  assert.ok(close(line.value, 1));
  assert.ok(close(stockValue(database, '2026-07-02'), 1), 'nor is it wealth yet');

  // Once the making completes, it counts.
  assert.ok(close(stockReport(database, '2026-07-06').find((l) => l.item.id === 'flour')!.qty, 1000));
  assert.ok(close(stockValue(database, '2026-07-06'), 10));
});

test('an issue of nonsense is refused before it touches the lots', () => {
  const database = db([purchased('flour')]);
  receive(database, 'flour', { qty: 100, on: '2026-07-01' });

  // NaN would smear through every candidate lot and the cleanup sweep
  // would then delete them all; a negative issue is a receipt in disguise.
  assert.throws(() => issue(database, 'flour', { qty: Number.NaN, on: '2026-07-02' }), MiseError);
  assert.throws(() => issue(database, 'flour', { qty: -5, on: '2026-07-02' }), MiseError);
  assert.equal(database.lots.length, 1, 'the shelf is untouched');
  assert.ok(close(database.lots[0]!.qty, 100));
});

test('a consumed lot keeps its id reserved in the ledger', () => {
  const database = db([purchased('flour')]);
  const first = receive(database, 'flour', { qty: 100, on: '2026-07-01' });
  issue(database, 'flour', { qty: 100, on: '2026-07-02' });
  assert.equal(database.lots.length, 0, 'the empty lot leaves the shelf');

  // The ledger still tells the first lot's story; a new receipt must not
  // continue it under the same name.
  const second = receive(database, 'flour', { qty: 50, on: '2026-07-03' });
  assert.notEqual(second.id, first.id);

  // The same reservation protects meal-plan ids held only by order pegs.
  assert.equal(nextId('MP', [], ['MP-0007']), 'MP-0008');
});

test('a lot at a nonsense cost is refused, not booked', () => {
  // Zero is a price; negative turns the pantry valuation — and every dish
  // drawing on the lot — negative, and NaN serialises to null.
  const database = db([purchased('flour')]);
  assert.throws(() => receive(database, 'flour', { qty: 100, on: '2026-07-01', unitCost: -0.5 }), MiseError);
  assert.throws(() => receive(database, 'flour', { qty: 100, on: '2026-07-01', unitCost: Number.NaN }), MiseError);
  assert.equal(database.lots.length, 0, 'nothing booked');
  const free = receive(database, 'flour', { qty: 100, on: '2026-07-01', unitCost: 0 });
  assert.equal(free.unitCost, 0, 'free is still a price');
});

test('a lot of nothing is refused, not booked', () => {
  // `stock add flour 0` used to print success while the pantry filtered the
  // zero lot straight back out, leaving only a meaningless ledger receipt.
  const database = db([purchased('flour')]);
  assert.throws(() => receive(database, 'flour', { qty: 0, on: '2026-07-01' }), MiseError);
  assert.throws(() => receive(database, 'flour', { qty: -5, on: '2026-07-01' }), MiseError);
  // A lot of everything is not a lot either: Infinity serialises to null.
  assert.throws(() => receive(database, 'flour', { qty: Number.POSITIVE_INFINITY, on: '2026-07-01' }), MiseError);
  assert.equal(database.lots.length, 0, 'nothing booked');
  assert.equal(database.ledger.length, 0, 'nothing recorded');
});

test('food still being made does not show in expiry alerts', () => {
  const database = db([purchased('milk3', { shelfLifeDays: 2 })]);
  receive(database, 'milk3', { qty: 500, on: '2026-07-01' });
  // A multi-day batch executed early books its output at completion —
  // "use it up first" cannot apply to food that does not exist yet.
  receive(database, 'milk3', { qty: 500, on: '2026-07-05' });

  const soon = expiring(database, 7, '2026-07-02');
  assert.equal(soon.length, 1, 'only what is actually in the fridge');
  assert.equal(soon[0]!.lot.receivedOn, '2026-07-01');
});

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

test('a phantom cannot be received into stock', () => {
  const database = db([phantom('soffritto'), purchased('onion')]);
  // A phantom is defined by never being stocked; a lot of it would sit in
  // the pantry forever, satisfying no demand and issuable by nothing.
  assert.throws(() => receive(database, 'soffritto', { qty: 300, on: '2026-07-01' }), MiseError);
  assert.equal(database.lots.length, 0);
  assert.equal(database.ledger.length, 0);
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

test('a forced issue records the overrun in the ledger', () => {
  const database = db([purchased('milk')]);
  receive(database, 'milk', { qty: 100, on: '2026-07-01' });

  const result = issue(database, 'milk', { qty: 250, on: '2026-07-02', allowNegative: true });
  assert.ok(close(result.shortfall, 150), `got ${result.shortfall}`);

  // The meal was cooked with 250 whatever the lots say: the ledger must
  // account for all of it, or it cannot explain the production it records.
  const consumed = database.ledger
    .filter((txn) => txn.type === 'issue')
    .reduce((sum, txn) => sum + txn.qty, 0);
  assert.ok(close(consumed, -250), `ledger accounts for ${consumed}`);
  const forced = database.ledger.find((txn) => txn.note?.includes('forced'));
  assert.ok(forced, 'the overrun is its own entry');
  assert.equal(forced.lotId, undefined, 'with no lot to pretend it came from');
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
