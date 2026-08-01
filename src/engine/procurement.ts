/**
 * Procurement: turning net requirements into a shopping list.
 *
 * MRP says "you are 340 g of butter short". The shop sells 250 g blocks. The
 * gap between those two sentences is this module: pack rounding, minimum order
 * quantities, supplier grouping and aisle ordering — plus the leftover that
 * rounding creates, which is real stock that lands in the pantry and gets netted
 * against next week.
 */

import { conversionContext, findSupplier, mustItem } from '../domain/db.js';
import { addDays, maxDate, today, type IsoDate } from '../domain/date.js';
import { MiseError, NotFoundError } from '../domain/errors.js';
import { nextId } from '../domain/ids.js';
import { convert, type UomCode } from '../domain/units.js';
import type { Database, ItemId, Lot, PurchaseOrder, SupplierId } from '../domain/types.js';
import { receive, transactionally } from './inventory.js';
import type { MrpResult, PlannedPurchase } from './mrp.js';
import { purchaseUnitCost } from './rollup.js';

export interface ShoppingLine {
  readonly itemId: ItemId;
  readonly name: string;
  readonly category: string;
  /** What you actually need. */
  readonly needQty: number;
  readonly uom: UomCode;
  /** How many packs that works out to, after rounding up and applying MOQ. */
  readonly packs: number;
  readonly packLabel: string;
  /** Quantity you will actually come home with. */
  readonly buyQty: number;
  /** Surplus created by pack rounding — tomorrow's opening stock. */
  readonly leftover: number;
  readonly unitPrice: number;
  readonly lineCost: number;
  readonly supplierId?: SupplierId;
  readonly supplierName?: string;
  readonly orderBy: IsoDate;
  /** True when no trip works: too late for the meal, or too early to keep. */
  readonly late: boolean;
  /** What this is for, in plain language: "ragù, béchamel". */
  readonly forDishes: readonly string[];
  readonly problem?: string;
}

export interface ShoppingList {
  readonly asOf: IsoDate;
  readonly lines: readonly ShoppingLine[];
  readonly total: number;
  readonly currency: string;
  /** Lines that could not be priced or sourced. */
  readonly unresolved: readonly ShoppingLine[];
}

/** Round a requirement up to whole packs, honouring any minimum order. */
export function packsFor(db: Database, itemId: ItemId, qty: number): { packs: number; packQty: number } {
  const item = mustItem(db, itemId);
  if (!item.purchase) return { packs: 0, packQty: 0 };
  const packQty = convert(
    item.purchase.packQty,
    item.purchase.packUom,
    item.stockUom,
    conversionContext(item),
  );
  if (packQty <= 0) return { packs: 0, packQty: 0 };
  // A hair under a whole pack is still a whole pack; the epsilon stops floating
  // point from turning "exactly 2 packs" into 3.
  const needed = Math.ceil(qty / packQty - 1e-9);
  return { packs: Math.max(needed, item.purchase.moqPacks ?? 0), packQty };
}

export interface ShoppingListOptions {
  readonly asOf?: IsoDate;
  /** Only include what must be ordered by this date. */
  readonly orderByBefore?: IsoDate;
}

/** Build a costed, aisle-ordered shopping list from a planning run. */
export function shoppingList(
  db: Database,
  mrp: MrpResult,
  options: ShoppingListOptions = {},
): ShoppingList {
  const asOf = options.asOf ?? mrp.asOf;
  // Pegging ids come back as meal plan entries or, once a plan is firmed up,
  // production orders. Both resolve to something a person recognises.
  const dishNames = new Map<string, string>();
  for (const entry of db.mealPlan) {
    dishNames.set(entry.id, mustItem(db, entry.itemId).name);
  }
  for (const order of db.productionOrders) {
    dishNames.set(order.id, mustItem(db, order.itemId).name);
  }

  const lines: ShoppingLine[] = [];
  for (const planned of mrp.purchases) {
    if (options.orderByBefore && planned.orderBy > options.orderByBefore) continue;
    lines.push(toShoppingLine(db, planned, dishNames));
  }

  lines.sort(
    (a, b) =>
      (a.supplierName ?? '~').localeCompare(b.supplierName ?? '~') ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );

  return {
    asOf,
    lines,
    total: lines.reduce((sum, line) => sum + line.lineCost, 0),
    currency: db.settings.currency,
    unresolved: lines.filter((line) => line.problem !== undefined),
  };
}

function toShoppingLine(
  db: Database,
  planned: PlannedPurchase,
  dishNames: Map<string, string>,
): ShoppingLine {
  const item = mustItem(db, planned.itemId);
  const { packs, packQty } = packsFor(db, planned.itemId, planned.qty);
  const unitCost = purchaseUnitCost(item);
  const unitPrice = unitCost ?? 0;
  const buyQty = packs * packQty;
  const supplier = item.purchase ? findSupplier(db, item.purchase.supplierId) : undefined;

  const forDishes = [
    ...new Set(planned.pegging.map((id) => dishNames.get(id) ?? id).filter(Boolean)),
  ];

  // Zero is a price — the seeded sourdough starter genuinely costs nothing
  // to replenish. Only an *absent* or unusable price is a problem; using
  // zero as the sentinel put a perfectly sourceable free item in the
  // unresolved list.
  const problem = !item.purchase
    ? 'no supplier or pack size on file'
    : unitCost === undefined || !Number.isFinite(unitCost)
      ? 'no price on file'
      : undefined;

  return {
    itemId: planned.itemId,
    name: item.name,
    category: item.category,
    needQty: planned.qty,
    uom: item.stockUom,
    packs,
    packLabel: item.purchase ? `${item.purchase.packQty} ${item.purchase.packUom}` : '—',
    buyQty,
    leftover: Math.max(0, buyQty - planned.qty),
    unitPrice,
    lineCost: item.purchase ? packs * item.purchase.packPrice : 0,
    ...(item.purchase ? { supplierId: item.purchase.supplierId } : {}),
    ...(supplier ? { supplierName: supplier.name } : {}),
    orderBy: planned.orderBy,
    late: planned.late,
    forDishes,
    ...(problem ? { problem } : {}),
  };
}

export interface ShoppingTrip {
  readonly supplier: string;
  /** The day this visit happens. Two Saturdays at the market are two trips. */
  readonly orderBy: IsoDate;
  readonly lines: ShoppingLine[];
  readonly total: number;
}

/**
 * Group a shopping list the way you actually shop: one group per *trip* — a
 * supplier on a date — not one per supplier. A perishable wanted twice in the
 * week means two visits to the same shop, and merging them into one undated
 * group would hide the second visit that `raisePurchaseOrders` goes on to
 * create an order for.
 */
export function bySupplier(list: ShoppingList): ShoppingTrip[] {
  const groups = new Map<string, { supplier: string; orderBy: IsoDate; lines: ShoppingLine[] }>();
  for (const line of list.lines) {
    const supplier = line.supplierName ?? 'Unsourced';
    const key = `${supplier}@${line.orderBy}`;
    const group = groups.get(key);
    if (group) group.lines.push(line);
    else groups.set(key, { supplier, orderBy: line.orderBy, lines: [line] });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      total: group.lines.reduce((sum, line) => sum + line.lineCost, 0),
    }))
    .sort((a, b) => a.orderBy.localeCompare(b.orderBy) || a.supplier.localeCompare(b.supplier));
}

/**
 * Convert a shopping list into open purchase orders, one per supplier.
 * Once raised, the quantities count as `onOrder` and later MRP runs net
 * against them instead of ordering the same butter again.
 */
export function raisePurchaseOrders(
  db: Database,
  list: ShoppingList,
  on: IsoDate = today(),
): PurchaseOrder[] {
  // One order per *trip*, not per supplier. Two visits to the same market on
  // different Saturdays are two orders arriving on two different days, and
  // collapsing them would misdate one of them. Lead time is part of the key
  // too, because an order carries a single arrival date and MRP scheduled
  // each line against its own item's lead time — reading the supplier default
  // here instead would commit a same-day item as arriving three days late.
  interface Trip {
    supplierId: SupplierId;
    orderBy: IsoDate;
    leadTimeDays: number;
    lines: ShoppingLine[];
  }

  const trips = new Map<string, Trip>();
  for (const line of list.lines) {
    // An unresolved line is a question, not an order: committing one would
    // turn "no price on file" into a free purchase and a zero-cost receipt.
    // It stays on the list's unresolved report until the data is fixed.
    if (!line.supplierId || line.packs <= 0 || line.problem) continue;
    const leadTimeDays = leadTimeFor(db, line.itemId);
    const key = `${line.supplierId}@${line.orderBy}@${leadTimeDays}`;
    const trip = trips.get(key);
    if (trip) trip.lines.push(line);
    else trips.set(key, { supplierId: line.supplierId, orderBy: line.orderBy, leadTimeDays, lines: [line] });
  }

  const created: PurchaseOrder[] = [];
  for (const trip of [...trips.values()].sort((a, b) => a.orderBy.localeCompare(b.orderBy))) {
    // The shopping line already worked out the first day this supplier can
    // actually be visited. Stamping the order with today + lead time instead
    // would claim delivery on a day the shop is shut, and the next planning
    // run would count it as supply and lose the conflict.
    const orderedOn = maxDate(on, trip.orderBy);
    const order: PurchaseOrder = {
      id: nextId('PO', [...db.purchaseOrders, ...created]),
      supplierId: trip.supplierId,
      orderedOn,
      expectedOn: addDays(orderedOn, trip.leadTimeDays),
      status: 'open',
      lines: trip.lines.map((line) => {
        // Snapshot the pack terms alongside the price. The receipt and later
        // MRP runs read these, not the live master, so editing an item's pack
        // size cannot quietly change what this order will deliver.
        const purchase = mustItem(db, line.itemId).purchase;
        return {
          itemId: line.itemId,
          packs: line.packs,
          ...(purchase ? { packQty: purchase.packQty, packUom: purchase.packUom } : {}),
          unitPrice: purchase?.packPrice ?? 0,
        };
      }),
    };
    created.push(order);
    db.purchaseOrders.push(order);
  }
  return created;
}

/**
 * Lead time for an item.
 *
 * Deliberately reads the item's own purchase terms and nothing else, because
 * that is exactly what MRP schedules the trip against. An item with no purchase
 * terms has no supplier either, so there is nothing to fall back to. Taking the
 * supplier's default here instead is what let a same-day item be committed as
 * arriving three days after the meal it was planned for.
 */
export function leadTimeFor(db: Database, itemId: ItemId): number {
  return mustItem(db, itemId).purchase?.leadTimeDays ?? 0;
}

export interface ReceiptResult {
  readonly orderId: string;
  readonly lots: readonly Lot[];
  readonly cost: number;
}

/**
 * Book a delivery in.
 *
 * This is the step that closes the loop: packs become lots, lots get expiry
 * dates from the item's shelf life, and the order stops counting as supply so
 * the next MRP run nets against real stock instead of a promise.
 */
export function receivePurchaseOrder(
  db: Database,
  orderId: string,
  on: IsoDate = today(),
): ReceiptResult {
  const order = db.purchaseOrders.find((candidate) => candidate.id === orderId);
  if (!order) throw new NotFoundError('purchase order', orderId);
  if (order.status === 'received') throw new MiseError(`Purchase order "${orderId}" is already received.`);
  if (order.status === 'cancelled') throw new MiseError(`Purchase order "${orderId}" was cancelled.`);

  const lots: Lot[] = [];
  let cost = 0;

  // The whole delivery books in as one unit. A later line can still fail —
  // its item deleted from a hand-edited master, a conversion no longer
  // bridgeable — and by then earlier lines have already become lots and
  // ledger entries. Without the boundary the order stays open, so fixing the
  // data and retrying would receive those earlier lines twice.
  transactionally(db, () => {
    for (const line of order.lines) {
      const item = mustItem(db, line.itemId);
      // What arrives is what was ordered: the pack terms recorded on the
      // line. The live master is only a fallback for orders saved before
      // lines carried their own terms.
      const packQty = line.packQty ?? item.purchase?.packQty;
      const packUom = line.packUom ?? item.purchase?.packUom;
      if (packQty === undefined || packUom === undefined) {
        // No snapshot and no live terms either: there is no defensible
        // quantity to book. Skipping the line and marking the order received
        // would erase its inbound supply without a lot or an error — throw
        // instead, so the order stays open until the data is repaired.
        throw new MiseError(
          `Order "${order.id}" line for "${item.name}" has no pack size on the line or the item — ` +
            `cannot receive it until one is restored.`,
        );
      }
      const qty = convert(line.packs * packQty, packUom, item.stockUom, conversionContext(item));
      if (qty <= 0) continue;

      const lineCost = line.packs * line.unitPrice;
      cost += lineCost;
      lots.push(
        receive(db, line.itemId, {
          qty,
          on,
          unitCost: lineCost / qty,
          origin: order.id,
          note: `received ${line.packs} × ${packQty} ${packUom}`,
        }),
      );
    }

    order.status = 'received';
  });

  return { orderId: order.id, lots, cost };
}
