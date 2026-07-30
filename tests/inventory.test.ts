import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShortageError } from '../src/domain/errors.js';
import { expiring, fefo, issue, onHand, onOrder, receive, stockValue, sweepExpired } from '../src/engine/inventory.js';
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
