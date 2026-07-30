/**
 * Pantry inventory: lot-tracked stock, FEFO issue, and an append-only ledger.
 *
 * Stock is not a number on an item — it is a set of lots, each with its own
 * expiry and its own actual cost. That is what makes "use the yoghurt that goes
 * off on Thursday first" and "what did this meal actually cost me" answerable,
 * and it is the difference between a shopping-list app and an ERP.
 */

import { conversionContext, mustItem } from '../domain/db.js';
import { addDays, daysBetween, today, type IsoDate } from '../domain/date.js';
import { ShortageError } from '../domain/errors.js';
import { nextId } from '../domain/ids.js';
import { convert, type UomCode } from '../domain/units.js';
import type { Database, InventoryTxn, Item, ItemId, Lot, Storage, TxnType } from '../domain/types.js';

/** Every lot of an item with stock remaining. */
export function lotsOf(db: Database, itemId: ItemId): Lot[] {
  return db.lots.filter((lot) => lot.itemId === itemId && lot.qty > 0);
}

/** Total quantity on hand, in the item's stock unit. */
export function onHand(db: Database, itemId: ItemId): number {
  return lotsOf(db, itemId).reduce((sum, lot) => sum + lot.qty, 0);
}

/**
 * First-expired-first-out. Lots with an expiry date go first, soonest first;
 * undated lots follow in receipt order.
 */
export function fefo(lots: readonly Lot[]): Lot[] {
  return [...lots].sort((a, b) => {
    if (a.expiresOn && b.expiresOn) return a.expiresOn.localeCompare(b.expiresOn);
    if (a.expiresOn) return -1;
    if (b.expiresOn) return 1;
    return a.receivedOn.localeCompare(b.receivedOn);
  });
}

export interface Allocation {
  readonly lot: Lot;
  readonly qty: number;
}

export interface AllocationPlan {
  readonly allocations: readonly Allocation[];
  /** Quantity that could not be covered from stock. */
  readonly shortfall: number;
  /** Weighted actual cost of the allocated quantity, where lots are priced. */
  readonly cost: number;
}

/** Work out which lots would cover a requirement, without changing anything. */
export function planAllocation(db: Database, itemId: ItemId, qty: number): AllocationPlan {
  const allocations: Allocation[] = [];
  let remaining = qty;
  let cost = 0;

  for (const lot of fefo(lotsOf(db, itemId))) {
    if (remaining <= 1e-9) break;
    const take = Math.min(lot.qty, remaining);
    allocations.push({ lot, qty: take });
    cost += take * (lot.unitCost ?? 0);
    remaining -= take;
  }

  return { allocations, shortfall: Math.max(0, remaining), cost };
}

function post(db: Database, txn: Omit<InventoryTxn, 'id'>): InventoryTxn {
  const entry: InventoryTxn = { ...txn, id: nextId('TXN', db.ledger) };
  db.ledger.push(entry);
  return entry;
}

export interface ReceiveOptions {
  readonly qty: number;
  readonly uom?: UomCode;
  readonly on?: IsoDate;
  readonly expiresOn?: IsoDate;
  readonly unitCost?: number;
  readonly location?: Storage;
  readonly origin?: string;
  readonly type?: Extract<TxnType, 'receipt' | 'produce'>;
  readonly note?: string;
}

/** Book stock in: a delivery, a harvest, or the output of a production order. */
export function receive(db: Database, itemId: ItemId, options: ReceiveOptions): Lot {
  const item = mustItem(db, itemId);
  const on = options.on ?? today();
  const qty = convert(options.qty, options.uom ?? item.stockUom, item.stockUom, conversionContext(item));

  const expiresOn =
    options.expiresOn ?? (item.shelfLifeDays !== undefined ? addDays(on, item.shelfLifeDays) : undefined);
  const location = options.location ?? item.storage;

  const lot: Lot = {
    id: nextId('LOT', db.lots),
    itemId,
    qty,
    receivedOn: on,
    ...(expiresOn ? { expiresOn } : {}),
    ...(options.unitCost !== undefined ? { unitCost: options.unitCost } : {}),
    ...(location ? { location } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  db.lots.push(lot);

  post(db, {
    at: on,
    type: options.type ?? 'receipt',
    itemId,
    qty,
    lotId: lot.id,
    ...(options.unitCost !== undefined ? { unitCost: options.unitCost } : {}),
    ...(options.origin ? { ref: options.origin } : {}),
    ...(options.note ? { note: options.note } : {}),
  });

  return lot;
}

export interface IssueOptions {
  readonly qty: number;
  readonly uom?: UomCode;
  readonly on?: IsoDate;
  readonly ref?: string;
  readonly type?: Extract<TxnType, 'issue' | 'waste'>;
  /** Allow stock to be consumed that isn't there, recording the shortfall. */
  readonly allowNegative?: boolean;
  readonly note?: string;
}

export interface IssueResult {
  readonly issued: number;
  readonly shortfall: number;
  /** Actual cost of what was consumed, from the lots it came out of. */
  readonly cost: number;
  readonly txns: readonly InventoryTxn[];
}

/** Consume stock, oldest-expiring first. */
export function issue(db: Database, itemId: ItemId, options: IssueOptions): IssueResult {
  const item = mustItem(db, itemId);
  const on = options.on ?? today();
  const want = convert(options.qty, options.uom ?? item.stockUom, item.stockUom, conversionContext(item));

  const plan = planAllocation(db, itemId, want);
  if (plan.shortfall > 1e-9 && !options.allowNegative) {
    throw new ShortageError(itemId, plan.shortfall, item.stockUom);
  }

  const txns: InventoryTxn[] = [];
  for (const allocation of plan.allocations) {
    allocation.lot.qty -= allocation.qty;
    txns.push(
      post(db, {
        at: on,
        type: options.type ?? 'issue',
        itemId,
        qty: -allocation.qty,
        lotId: allocation.lot.id,
        ...(allocation.lot.unitCost !== undefined ? { unitCost: allocation.lot.unitCost } : {}),
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.note ? { note: options.note } : {}),
      }),
    );
  }
  db.lots = db.lots.filter((lot) => lot.qty > 1e-9);

  return {
    issued: want - plan.shortfall,
    shortfall: plan.shortfall,
    cost: plan.cost,
    txns,
  };
}

/** Correct the books after a stocktake. */
export function adjust(db: Database, itemId: ItemId, newQty: number, on: IsoDate = today()): InventoryTxn {
  const current = onHand(db, itemId);
  const delta = newQty - current;
  if (delta > 0) {
    receive(db, itemId, { qty: delta, on, note: 'stocktake adjustment' });
  } else if (delta < 0) {
    issue(db, itemId, { qty: -delta, on, note: 'stocktake adjustment', allowNegative: true });
  }
  return post(db, { at: on, type: 'adjust', itemId, qty: delta, note: 'stocktake' });
}

export interface ExpiringLot {
  readonly lot: Lot;
  readonly item: Item;
  /** Negative when already past its date. */
  readonly daysLeft: number;
}

export function expiring(db: Database, withinDays: number, asOf: IsoDate = today()): ExpiringLot[] {
  return db.lots
    .filter((lot) => lot.qty > 0 && lot.expiresOn !== undefined)
    .map((lot) => ({
      lot,
      item: mustItem(db, lot.itemId),
      daysLeft: daysBetween(asOf, lot.expiresOn!),
    }))
    .filter((entry) => entry.daysLeft <= withinDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Write off everything past its date. Returns what was binned, and its cost. */
export function sweepExpired(
  db: Database,
  asOf: IsoDate = today(),
): { itemId: ItemId; qty: number; cost: number }[] {
  const wasted: { itemId: ItemId; qty: number; cost: number }[] = [];
  for (const entry of expiring(db, -1, asOf)) {
    const { lot } = entry;
    const cost = lot.qty * (lot.unitCost ?? 0);
    wasted.push({ itemId: lot.itemId, qty: lot.qty, cost });
    lot.qty = 0;
    post(db, {
      at: asOf,
      type: 'waste',
      itemId: lot.itemId,
      qty: -entry.lot.qty,
      lotId: lot.id,
      note: `expired ${lot.expiresOn}`,
    });
  }
  db.lots = db.lots.filter((lot) => lot.qty > 1e-9);
  return wasted;
}

/** Quantity already on order and expected to land on or before `date`. */
export function onOrder(db: Database, itemId: ItemId, by: IsoDate): number {
  let total = 0;
  for (const order of db.purchaseOrders) {
    if (order.status !== 'open' || order.expectedOn > by) continue;
    for (const line of order.lines) {
      if (line.itemId !== itemId) continue;
      const item = mustItem(db, itemId);
      if (!item.purchase) continue;
      total += convert(
        line.packs * item.purchase.packQty,
        item.purchase.packUom,
        item.stockUom,
        conversionContext(item),
      );
    }
  }
  return total;
}

/** Value of everything in the pantry, at actual cost where known. */
export function stockValue(db: Database): number {
  return db.lots.reduce((sum, lot) => sum + lot.qty * (lot.unitCost ?? 0), 0);
}

export interface StockLine {
  readonly item: Item;
  readonly qty: number;
  readonly uom: UomCode;
  readonly lots: number;
  readonly value: number;
  readonly nextExpiry?: IsoDate;
  readonly belowSafety: boolean;
}

/** Current stock, one line per item. */
export function stockReport(db: Database): StockLine[] {
  const byItem = new Map<ItemId, Lot[]>();
  for (const lot of db.lots) {
    if (lot.qty <= 0) continue;
    const list = byItem.get(lot.itemId);
    if (list) list.push(lot);
    else byItem.set(lot.itemId, [lot]);
  }

  return [...byItem.entries()]
    .map(([itemId, lots]) => {
      const item = mustItem(db, itemId);
      const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
      const expiries = lots.map((lot) => lot.expiresOn).filter((d): d is IsoDate => Boolean(d)).sort();
      return {
        item,
        qty,
        uom: item.stockUom,
        lots: lots.length,
        value: lots.reduce((sum, lot) => sum + lot.qty * (lot.unitCost ?? 0), 0),
        ...(expiries[0] ? { nextExpiry: expiries[0] } : {}),
        belowSafety: item.safetyStock !== undefined && qty < item.safetyStock,
      };
    })
    .sort((a, b) => a.item.category.localeCompare(b.item.category) || a.item.name.localeCompare(b.item.name));
}
