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
import { addDays, today, type IsoDate } from '../domain/date.js';
import { MiseError, NotFoundError } from '../domain/errors.js';
import { nextId } from '../domain/ids.js';
import { convert, type UomCode } from '../domain/units.js';
import type { Database, ItemId, Lot, PurchaseOrder, SupplierId } from '../domain/types.js';
import { receive } from './inventory.js';
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
  const unitPrice = purchaseUnitCost(item) ?? 0;
  const buyQty = packs * packQty;
  const supplier = item.purchase ? findSupplier(db, item.purchase.supplierId) : undefined;

  const forDishes = [
    ...new Set(planned.pegging.map((id) => dishNames.get(id) ?? id).filter(Boolean)),
  ];

  const problem = !item.purchase
    ? 'no supplier or pack size on file'
    : unitPrice === 0
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
    forDishes,
    ...(problem ? { problem } : {}),
  };
}

/** Group a shopping list the way you actually shop: one trip per supplier. */
export function bySupplier(list: ShoppingList): { supplier: string; lines: ShoppingLine[]; total: number }[] {
  const groups = new Map<string, ShoppingLine[]>();
  for (const line of list.lines) {
    const key = line.supplierName ?? 'Unsourced';
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  return [...groups.entries()]
    .map(([supplier, lines]) => ({
      supplier,
      lines,
      total: lines.reduce((sum, line) => sum + line.lineCost, 0),
    }))
    .sort((a, b) => a.supplier.localeCompare(b.supplier));
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
  const bySupplierId = new Map<SupplierId, ShoppingLine[]>();
  for (const line of list.lines) {
    if (!line.supplierId || line.packs <= 0) continue;
    const group = bySupplierId.get(line.supplierId);
    if (group) group.push(line);
    else bySupplierId.set(line.supplierId, [line]);
  }

  const created: PurchaseOrder[] = [];
  for (const [supplierId, lines] of bySupplierId) {
    const supplier = findSupplier(db, supplierId);
    const leadTime = supplier?.leadTimeDays ?? 0;
    const order: PurchaseOrder = {
      id: nextId('PO', [...db.purchaseOrders, ...created]),
      supplierId,
      orderedOn: on,
      expectedOn: addDays(on, leadTime),
      status: 'open',
      lines: lines.map((line) => ({
        itemId: line.itemId,
        packs: line.packs,
        unitPrice: mustItem(db, line.itemId).purchase?.packPrice ?? 0,
      })),
    };
    created.push(order);
    db.purchaseOrders.push(order);
  }
  return created;
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

  for (const line of order.lines) {
    const item = mustItem(db, line.itemId);
    if (!item.purchase) continue;
    const qty = convert(
      line.packs * item.purchase.packQty,
      item.purchase.packUom,
      item.stockUom,
      conversionContext(item),
    );
    if (qty <= 0) continue;

    const lineCost = line.packs * line.unitPrice;
    cost += lineCost;
    lots.push(
      receive(db, line.itemId, {
        qty,
        on,
        unitCost: lineCost / qty,
        origin: order.id,
        note: `received ${line.packs} × ${item.purchase.packQty} ${item.purchase.packUom}`,
      }),
    );
  }

  order.status = 'received';
  return { orderId: order.id, lots, cost };
}
