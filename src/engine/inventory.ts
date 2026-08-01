/**
 * Pantry inventory: lot-tracked stock, FEFO issue, and an append-only ledger.
 *
 * Stock is not a number on an item — it is a set of lots, each with its own
 * expiry and its own actual cost. That is what makes "use the yoghurt that goes
 * off on Thursday first" and "what did this meal actually cost me" answerable,
 * and it is the difference between a shopping-list app and an ERP.
 */

import { conversionContext, isStocked, mustItem } from '../domain/db.js';
import { addDays, daysBetween, today, type IsoDate } from '../domain/date.js';
import { MiseError, ShortageError } from '../domain/errors.js';
import { nextId } from '../domain/ids.js';
import { convert, type UomCode } from '../domain/units.js';
import type { Database, InventoryTxn, Item, ItemId, Lot, Storage, TxnType } from '../domain/types.js';

/** Every lot of an item with stock remaining, whether or not it is still good. */
export function lotsOf(db: Database, itemId: ItemId): Lot[] {
  return db.lots.filter((lot) => lot.itemId === itemId && lot.qty > 0);
}

/** Lot ids the ledger still remembers — retired lots keep their ids reserved. */
function ledgerLotIds(db: Database): string[] {
  const ids: string[] = [];
  for (const txn of db.ledger) {
    if (txn.lotId !== undefined) ids.push(txn.lotId);
  }
  return ids;
}

/**
 * Can this lot be put to use on `asOf`?
 *
 * Bounded at both ends: no use before it was received, no use after it
 * expires. Good through its expiry date itself; an undated lot never expires.
 * Back-dating a receipt or an issue is still fine — what this rules out is
 * consuming stock earlier than the day it arrived.
 *
 * **This is the only place that decision is made.** Every availability path —
 * issuing, planning, feasibility, the pantry report — goes through here,
 * because when the same rule was written out at each call site the copies
 * drifted apart twice.
 */
export function isUsableOn(lot: Lot, asOf: IsoDate): boolean {
  return lot.qty > 0 && lot.receivedOn <= asOf && (!lot.expiresOn || lot.expiresOn >= asOf);
}

/** Lots you could actually put your hands on that day. */
export function usableLots(db: Database, itemId: ItemId, asOf: IsoDate): Lot[] {
  return db.lots.filter((lot) => lot.itemId === itemId && isUsableOn(lot, asOf));
}

/**
 * Physical quantity in lots, in the item's stock unit.
 *
 * This is what is on the shelf, including anything past its date — the pantry
 * report wants that, because the yoghurt is still physically there. Planning
 * and issuing want `availableOn` instead.
 */
export function onHand(db: Database, itemId: ItemId): number {
  return lotsOf(db, itemId).reduce((sum, lot) => sum + lot.qty, 0);
}

/**
 * Quantity you could actually cook with on `asOf`.
 *
 * Expired stock is not supply. Netting demand against it would quietly leave a
 * dish short on the day, which is the one thing a pantry planner must not do.
 */
export function availableOn(db: Database, itemId: ItemId, asOf: IsoDate): number {
  return usableLots(db, itemId, asOf).reduce((sum, lot) => sum + lot.qty, 0);
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

/**
 * Work out which lots would cover a requirement, without changing anything.
 *
 * `asOf` scopes it to stock that is still good on that date; pass `undefined`
 * to reach expired lots too, which only a write-off or a stocktake should do.
 */
export function planAllocation(
  db: Database,
  itemId: ItemId,
  qty: number,
  asOf?: IsoDate,
): AllocationPlan {
  const allocations: Allocation[] = [];
  let remaining = qty;
  let cost = 0;

  const candidates = asOf === undefined ? lotsOf(db, itemId) : usableLots(db, itemId, asOf);
  for (const lot of fefo(candidates)) {
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
  readonly type?: Extract<TxnType, 'receipt' | 'produce' | 'adjust'>;
  readonly note?: string;
}

/** Book stock in: a delivery, a harvest, or the output of a production order. */
export function receive(db: Database, itemId: ItemId, options: ReceiveOptions): Lot {
  const item = mustItem(db, itemId);
  // A phantom is defined by never being stocked: explosion passes through it,
  // MRP never nets it, production never issues it. A lot of "soffritto" would
  // sit in the pantry forever, satisfying nothing. Storable leftovers belong
  // to a manufactured item instead.
  if (item.sourcing === 'phantom') {
    throw new MiseError(
      `"${item.name}" is a phantom sub-recipe — it is made and used in the moment, never stocked.`,
    );
  }
  const on = options.on ?? today();
  const qty = convert(options.qty, options.uom ?? item.stockUom, item.stockUom, conversionContext(item));
  // A lot of nothing is not a lot: the pantry would filter it straight out,
  // leaving a success message, a meaningless ledger receipt, and no stock.
  // `!(qty > 0)` also catches NaN from a mangled quantity.
  if (!(qty > 0)) {
    throw new MiseError(`Cannot book ${qty} ${item.stockUom} of "${item.name}" into stock.`);
  }

  const expiresOn =
    options.expiresOn ?? (item.shelfLifeDays !== undefined ? addDays(on, item.shelfLifeDays) : undefined);
  const location = options.location ?? item.storage;

  const lot: Lot = {
    // Depleted lots leave the shelf but not the ledger: their ids stay
    // reserved, or a new receipt would share an id with the history of a
    // lot it never was.
    id: nextId('LOT', db.lots, ledgerLotIds(db)),
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
  readonly type?: Extract<TxnType, 'issue' | 'waste' | 'adjust'>;
  /** Allow stock to be consumed that isn't there, recording the shortfall. */
  readonly allowNegative?: boolean;
  /** Reach past-date lots as well. Only stocktakes and write-offs should. */
  readonly includeExpired?: boolean;
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

  // Cooking on a date can only use what is still good on that date.
  const plan = planAllocation(db, itemId, want, options.includeExpired ? undefined : on);
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

  // A forced issue consumed more than the lots can explain. The overrun is
  // still consumption — the dish was cooked, the meal served — and a ledger
  // that omits it cannot reconcile with the production it goes on to record.
  // No lot and no cost to attach: just the honest quantity.
  if (plan.shortfall > 1e-9) {
    txns.push(
      post(db, {
        at: on,
        type: options.type ?? 'issue',
        itemId,
        qty: -plan.shortfall,
        ...(options.ref ? { ref: options.ref } : {}),
        note: options.note ? `${options.note}; forced beyond stock` : 'forced beyond stock',
      }),
    );
  }

  return {
    issued: want - plan.shortfall,
    shortfall: plan.shortfall,
    cost: plan.cost,
    txns,
  };
}

/**
 * Correct the books after a stocktake.
 *
 * The movement is posted exactly once, as an `adjust`. Booking the delta and
 * then posting a summary line on top of it would double the ledger against the
 * lots it is supposed to explain, and an append-only ledger that does not
 * reconcile is worse than no ledger.
 */
export function adjust(
  db: Database,
  itemId: ItemId,
  newQty: number,
  on: IsoDate = today(),
): InventoryTxn[] {
  const delta = newQty - onHand(db, itemId);
  if (Math.abs(delta) <= 1e-9) return [];

  if (delta > 0) {
    receive(db, itemId, { qty: delta, on, type: 'adjust', note: 'stocktake' });
    const posted = db.ledger[db.ledger.length - 1];
    return posted ? [posted] : [];
  }

  // A stocktake reaches everything physically present, expired included.
  const result = issue(db, itemId, {
    qty: -delta,
    on,
    type: 'adjust',
    note: 'stocktake',
    allowNegative: true,
    includeExpired: true,
  });
  return [...result.txns];
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
    // Read the quantity out before clearing the lot: `entry.lot` is the same
    // object, so anything read after the reset would post a zero to the ledger.
    const binned = lot.qty;
    const cost = binned * (lot.unitCost ?? 0);
    wasted.push({ itemId: lot.itemId, qty: binned, cost });
    lot.qty = 0;
    post(db, {
      at: asOf,
      type: 'waste',
      itemId: lot.itemId,
      qty: -binned,
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
      // The terms recorded on the line, not the live master — same rule as
      // the receipt and MRP's inbound supply, so all three agree on what a
      // pack-size edit does (nothing) to an already-raised order.
      const packQty = line.packQty ?? item.purchase?.packQty;
      const packUom = line.packUom ?? item.purchase?.packUom;
      if (packQty === undefined || packUom === undefined) continue;
      total += convert(line.packs * packQty, packUom, item.stockUom, conversionContext(item));
    }
  }
  return total;
}

/**
 * Run `work` as a unit: if it throws, the pantry, the ledger and the order
 * book are left exactly as they were.
 *
 * Cooking is a multi-step mutation — issue the mince, issue the passata, book
 * the ragù — and a recipe that fails on its fourth ingredient must not eat the
 * first three. Every mutation in the engine goes through lot quantities, the
 * ledger, or an order's status, so restoring those three restores everything.
 */
export function transactionally<T>(db: Database, work: () => T): T {
  const lots = [...db.lots];
  const quantities = lots.map((lot) => lot.qty);
  const ledgerLength = db.ledger.length;
  // A cascade can settle a committed order mid-cook — closing it outright or
  // reducing its quantity. If the cook then fails, both have to come back,
  // or the batch the order stands for would never (fully) be made.
  const productionSnapshots = db.productionOrders.map((order) => ({
    status: order.status,
    qty: order.qty,
  }));
  const purchaseStatuses = db.purchaseOrders.map((order) => order.status);

  try {
    return work();
  } catch (error) {
    // `issue` replaces db.lots with a filtered array and `receive` pushes to
    // it, so both the array and the quantities on it have to be put back.
    db.lots = lots;
    lots.forEach((lot, index) => {
      lot.qty = quantities[index]!;
    });
    db.ledger.length = ledgerLength;
    productionSnapshots.forEach((snapshot, index) => {
      db.productionOrders[index]!.status = snapshot.status;
      db.productionOrders[index]!.qty = snapshot.qty;
    });
    purchaseStatuses.forEach((status, index) => {
      db.purchaseOrders[index]!.status = status;
    });
    throw error;
  }
}

/** Value of everything in the pantry, at actual cost where known. */
export function stockValue(db: Database): number {
  return db.lots.reduce((sum, lot) => sum + lot.qty * (lot.unitCost ?? 0), 0);
}

export interface StockLine {
  readonly item: Item;
  /** Physically present, expired included. */
  readonly qty: number;
  /** Still fit to use — what planning is allowed to count on. */
  readonly usable: number;
  readonly uom: UomCode;
  readonly lots: number;
  readonly value: number;
  readonly nextExpiry?: IsoDate;
  readonly belowSafety: boolean;
}

/** Current stock, one line per item. */
export function stockReport(db: Database, asOf: IsoDate = today()): StockLine[] {
  const byItem = new Map<ItemId, Lot[]>();

  // Seed with everything that has a safety level, so an item that has run out
  // completely still gets a line. Dropping it the moment its last lot is
  // consumed would hide it from `--low` at exactly the point it matters most.
  for (const item of db.items) {
    if (item.safetyStock !== undefined && isStocked(item)) byItem.set(item.id, []);
  }

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
      const usable = lots.filter((lot) => isUsableOn(lot, asOf)).reduce((sum, lot) => sum + lot.qty, 0);
      const expiries = lots.map((lot) => lot.expiresOn).filter((d): d is IsoDate => Boolean(d)).sort();
      return {
        item,
        qty,
        usable,
        uom: item.stockUom,
        lots: lots.length,
        value: lots.reduce((sum, lot) => sum + lot.qty * (lot.unitCost ?? 0), 0),
        ...(expiries[0] ? { nextExpiry: expiries[0] } : {}),
        // Safety stock is about what you can cook with, not what is in the bin.
        belowSafety: item.safetyStock !== undefined && usable < item.safetyStock,
      };
    })
    .sort((a, b) => a.item.category.localeCompare(b.item.category) || a.item.name.localeCompare(b.item.name));
}
