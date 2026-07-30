/**
 * Material requirements planning.
 *
 * This is the join between the two halves of Mise. The meal plan is a master
 * production schedule: "roast chicken for four on Saturday". MRP explodes that
 * through the recipe graph, nets each requirement against what is already in
 * the pantry and what is already on order, and emits the two kinds of order a
 * household actually acts on — *buy this* and *cook this, by then*.
 *
 * The algorithm is the textbook one, and the reason it needs low-level codes is
 * worth stating plainly. Butter is demanded directly by the mash and
 * indirectly, three levels down, by the roux inside the béchamel. If we netted
 * butter the moment we first met it, we would net it against stock, decide we
 * had enough, and then meet it again later with no stock left to net against —
 * and buy twice. Processing strictly in low-level-code order guarantees every
 * demand for an item has been collected before that item is planned.
 */

import {
  conversionContext,
  findItem,
  findSupplier,
  isMade,
  isStocked,
  mustItem,
  recipeFor,
} from '../domain/db.js';
import { addDays, maxDate, today, weekdayIndex, type IsoDate } from '../domain/date.js';
import { nextId } from '../domain/ids.js';
import { convert } from '../domain/units.js';
import type { Database, Item, ItemId, MealPlanEntry, ProductionOrder } from '../domain/types.js';
import { quantityForServings } from './explode.js';
import { lowLevelCodes } from './graph.js';
import { availableOn } from './inventory.js';
import { recipeMinutes } from './rollup.js';

/** Hours in a day you can realistically be cooking. Used for backward scheduling. */
const COOKING_MINUTES_PER_DAY = 8 * 60;

export interface Demand {
  readonly itemId: ItemId;
  readonly qty: number;
  /** The date the quantity is needed *by*. */
  readonly dueOn: IsoDate;
  /** Where the demand came from: a meal plan entry id, or a parent order id. */
  readonly source: string;
  readonly level: number;
}

export interface PlannedPurchase {
  readonly itemId: ItemId;
  readonly name: string;
  /** Net requirement in stock units, before pack rounding. */
  readonly qty: number;
  readonly uom: string;
  readonly neededOn: IsoDate;
  /** Latest date you can buy it and still have it in time. */
  readonly orderBy: IsoDate;
  /** True when even the earliest possible trip lands after it is needed. */
  readonly late: boolean;
  readonly supplierId?: string;
  /** Demands this order covers, for pegging. */
  readonly pegging: readonly string[];
}

export interface PlannedProduction {
  readonly itemId: ItemId;
  readonly name: string;
  readonly qty: number;
  readonly uom: string;
  readonly servings: number;
  readonly dueOn: IsoDate;
  /** Latest start that still hits the due date, from the recipe's own timings. */
  readonly startOn: IsoDate;
  readonly minutes: number;
  readonly level: number;
  readonly pegging: readonly string[];
}

export interface MrpLine {
  readonly itemId: ItemId;
  readonly name: string;
  readonly level: number;
  readonly gross: number;
  readonly onHand: number;
  readonly onOrder: number;
  readonly safetyStock: number;
  readonly net: number;
  readonly uom: string;
  readonly action: 'covered' | 'buy' | 'make' | 'phantom';
}

export interface MrpResult {
  readonly asOf: IsoDate;
  readonly horizonDays: number;
  readonly lines: readonly MrpLine[];
  readonly purchases: readonly PlannedPurchase[];
  readonly production: readonly PlannedProduction[];
  /** Data-level failures: a net requirement with no way at all to get it. */
  readonly problems: readonly string[];
  /**
   * Plan-level conflicts: it can be got, but not in time. The plan is still
   * actionable, it just needs a decision — shop earlier, or eat later.
   */
  readonly conflicts: readonly string[];
}

export interface MrpOptions {
  readonly asOf?: IsoDate;
  readonly horizonDays?: number;
  readonly includeOptional?: boolean;
  /** Ignore what's in the pantry — plan as if starting from empty. */
  readonly ignoreStock?: boolean;
  /** Extra demand on top of the meal plan, e.g. an ad-hoc "cook 2 kg of ragù". */
  readonly extraDemand?: readonly Demand[];
}

/** Turn meal plan entries into level-0 demand. */
export function demandFromPlan(
  db: Database,
  from: IsoDate,
  horizonDays: number,
  entries: readonly MealPlanEntry[] = db.mealPlan,
): Demand[] {
  const until = addDays(from, horizonDays - 1);
  return entries
    .filter((entry) => entry.date >= from && entry.date <= until)
    .map((entry) => ({
      itemId: entry.itemId,
      qty: quantityForServings(db, entry.itemId, entry.servings).qty,
      dueOn: entry.date,
      source: entry.id,
      level: 0,
    }));
}

/**
 * Run MRP over the plan.
 *
 * Returns a full audit trail — gross, on hand, on order, net, and the action
 * taken — because a planning run you cannot interrogate is a planning run you
 * will not trust.
 */
export function runMrp(db: Database, options: MrpOptions = {}): MrpResult {
  const asOf = options.asOf ?? today();
  const horizonDays = options.horizonDays ?? db.settings.planningHorizonDays;
  const codes = lowLevelCodes(db);

  const demandsByItem = new Map<ItemId, Demand[]>();
  const addDemand = (demand: Demand): void => {
    const list = demandsByItem.get(demand.itemId);
    if (list) list.push(demand);
    else demandsByItem.set(demand.itemId, [demand]);
  };

  for (const demand of demandFromPlan(db, asOf, horizonDays)) addDemand(demand);
  for (const demand of options.extraDemand ?? []) addDemand(demand);

  // Plan shallowest first: every parent contributes its dependent demand before
  // the child is netted. Items with no demand are skipped inside the loop, but
  // the sweep must cover the whole item master because demand appears as we go.
  const order = db.items
    .map((item) => item.id)
    .sort((a, b) => (codes.get(a) ?? 0) - (codes.get(b) ?? 0) || a.localeCompare(b));

  const lines: MrpLine[] = [];
  const purchases: PlannedPurchase[] = [];
  const production: PlannedProduction[] = [];
  const problems: string[] = [];
  const conflicts: string[] = [];

  const horizonEnd = addDays(asOf, horizonDays - 1);

  for (const itemId of order) {
    const item = mustItem(db, itemId);
    const demands = demandsByItem.get(itemId) ?? [];
    // Orders already firmed up by a previous run. They are supply for this
    // item *and* a source of demand for its components — see below.
    const firmOrders = options.ignoreStock ? [] : firmProductionOrders(db, itemId, horizonEnd);

    // An item can also need attention with nothing planned at all: a buffer
    // that has been eaten into still has to be rebuilt.
    const safety = isStocked(item) ? (item.safetyStock ?? 0) : 0;
    const needsTopUp =
      !options.ignoreStock && safety > 0 && availableOn(db, itemId, horizonEnd) + 1e-9 < safety;

    if (demands.length === 0 && firmOrders.length === 0 && !needsTopUp) continue;

    const level = codes.get(itemId) ?? 0;
    const gross = demands.reduce((sum, d) => sum + d.qty, 0);
    const dates = [...demands.map((d) => d.dueOn), ...firmOrders.map((o) => o.dueOn)];
    const earliest = dates.reduce<IsoDate>((soonest, date) => (date < soonest ? date : soonest), dates[0] ?? asOf);

    // Phantoms are never stocked and never ordered: pass demand straight down.
    if (!isStocked(item)) {
      lines.push({
        itemId,
        name: item.name,
        level,
        gross,
        onHand: 0,
        onOrder: 0,
        safetyStock: 0,
        net: gross,
        uom: item.stockUom,
        action: 'phantom',
      });
      explodeOneLevel(
        db,
        itemId,
        gross,
        earliest,
        level,
        [...new Set([...demands.map((d) => d.source), ...firmOrders.map((o) => o.id)])],
        addDemand,
        options.includeOptional,
      );
      continue;
    }

    // Net date by date. A carton that goes off on Thursday is supply for
    // Wednesday's dinner and not for Friday's, so a single lump comparison
    // against the earliest due date would let one carton cover the whole week.
    const requirements = [...demands].sort((a, b) => a.dueOn.localeCompare(b.dueOn));
    if (safety > 0) {
      // Safety stock is a floor on the closing balance: it has to be there at
      // the end, after everything planned has been eaten.
      requirements.push({ itemId, qty: safety, dueOn: horizonEnd, source: SAFETY_STOCK, level });
    }

    const allocation = allocate(supplyFor(db, item, firmOrders, options), requirements);
    const net = allocation.shortfalls.reduce((sum, short) => sum + short.qty, 0);
    const dueOn = allocation.shortfalls[0]?.dueOn ?? earliest;
    const pegging = [
      ...new Set(
        allocation.shortfalls.length > 0
          ? allocation.shortfalls.map((short) => short.source)
          : [...demands.map((d) => d.source), ...firmOrders.map((o) => o.id)],
      ),
    ];

    const action: MrpLine['action'] = net <= 1e-9 ? 'covered' : isMade(item) ? 'make' : 'buy';
    lines.push({
      itemId,
      name: item.name,
      level,
      gross,
      onHand: allocation.fromStock,
      onOrder: allocation.fromOrders,
      safetyStock: safety,
      net,
      uom: item.stockUom,
      action,
    });

    // A firm order still has to be cooked, so its components are still needed
    // even though it covers its own parent demand. Skipping this is what would
    // let `mrp --commit` silently empty the shopping list.
    for (const firm of firmOrders) {
      explodeOneLevel(db, itemId, firm.qty, firm.startOn, level, [firm.id], addDemand, options.includeOptional);
    }

    if (net <= 1e-9) continue;

    if (isMade(item)) {
      const recipe = recipeFor(db, itemId);
      if (!recipe) {
        problems.push(`"${item.name}" is made but has no recipe; cannot plan ${net.toFixed(0)} ${item.stockUom}.`);
        continue;
      }
      const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
      const batches = batchQty === 0 ? 0 : net / batchQty;
      const { active, passive } = recipeMinutes(recipe);
      const minutes = active + passive;
      // Backward-schedule against a usable cooking day. A four-hour braise
      // still finishes the same day; an overnight prove does not.
      const daysNeeded = Math.max(1, Math.ceil(minutes / COOKING_MINUTES_PER_DAY));
      const startOn = addDays(dueOn, -(daysNeeded - 1));

      production.push({
        itemId,
        name: item.name,
        qty: net,
        uom: item.stockUom,
        servings: batches * recipe.servings,
        dueOn,
        startOn,
        minutes,
        level,
        pegging,
      });

      // Dependent demand, due when production starts rather than when it ends.
      explodeOneLevel(db, itemId, net, startOn, level, pegging, addDemand, options.includeOptional);
      continue;
    }

    // Purchased: schedule the shopping trip by lead time and shop opening days.
    if (!item.purchase) {
      problems.push(`"${item.name}" is short by ${net.toFixed(1)} ${item.stockUom} but has no supplier.`);
    }
    const trip = schedulePurchase(db, item, dueOn, asOf);
    if (trip.late) {
      const supplier = item.purchase ? findSupplier(db, item.purchase.supplierId) : undefined;
      conflicts.push(
        `${item.name} is needed ${dueOn}, but ${supplier?.name ?? 'the supplier'} cannot supply ` +
          `it in time — the earliest trip is ${trip.orderBy}.`,
      );
    }
    purchases.push({
      itemId,
      name: item.name,
      qty: net,
      uom: item.stockUom,
      neededOn: dueOn,
      orderBy: trip.orderBy,
      late: trip.late,
      ...(item.purchase ? { supplierId: item.purchase.supplierId } : {}),
      pegging,
    });
  }

  return {
    asOf,
    horizonDays,
    lines: lines.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
    purchases: purchases.sort((a, b) => a.orderBy.localeCompare(b.orderBy) || a.name.localeCompare(b.name)),
    production: production.sort(
      (a, b) => a.startOn.localeCompare(b.startOn) || b.level - a.level || a.name.localeCompare(b.name),
    ),
    problems,
    conflicts,
  };
}

/** Pegging label for a requirement that exists only to rebuild a buffer. */
const SAFETY_STOCK = 'safety stock';

/**
 * A quantity of supply, with the window in which it can actually be used.
 *
 * Stock in the fridge is available now and stops being available at its expiry
 * date; a delivery or a batch you have committed to cooking is available from
 * the day it lands and then keeps. Expressing both as a window is what lets one
 * allocator handle them together.
 */
interface SupplyBucket {
  qty: number;
  /** Not usable before this date. Absent means it is already here. */
  readonly from?: IsoDate;
  /** Not usable after this date. Absent means it keeps. */
  readonly until?: IsoDate;
  readonly kind: 'stock' | 'order';
}

function supplyFor(
  db: Database,
  item: Item,
  firmOrders: readonly ProductionOrder[],
  options: MrpOptions,
): SupplyBucket[] {
  if (options.ignoreStock) return [];
  const buckets: SupplyBucket[] = [];

  for (const lot of db.lots) {
    if (lot.itemId !== item.id || lot.qty <= 0) continue;
    buckets.push({
      qty: lot.qty,
      kind: 'stock',
      ...(lot.expiresOn ? { until: lot.expiresOn } : {}),
    });
  }

  for (const order of db.purchaseOrders) {
    if (order.status !== 'open') continue;
    for (const line of order.lines) {
      if (line.itemId !== item.id || !item.purchase) continue;
      buckets.push({
        qty: convert(
          line.packs * item.purchase.packQty,
          item.purchase.packUom,
          item.stockUom,
          conversionContext(item),
        ),
        from: order.expectedOn,
        kind: 'order',
      });
    }
  }

  for (const order of firmOrders) {
    buckets.push({ qty: order.qty, from: order.dueOn, kind: 'order' });
  }

  // First-expired-first-out, so the carton that is about to turn gets used
  // before the one that keeps.
  return buckets.sort((a, b) => {
    if (a.until && b.until) return a.until.localeCompare(b.until);
    if (a.until) return -1;
    if (b.until) return 1;
    return (a.from ?? '').localeCompare(b.from ?? '');
  });
}

interface Shortfall {
  readonly qty: number;
  readonly dueOn: IsoDate;
  readonly source: string;
}

interface Allocation {
  readonly fromStock: number;
  readonly fromOrders: number;
  readonly shortfalls: readonly Shortfall[];
}

/**
 * Consume supply against dated requirements, earliest first.
 *
 * Each requirement may only draw on supply whose window covers its date, which
 * is what makes "400 g expiring on the 5th" cover a meal on the 2nd and not one
 * on the 10th. Requirements are taken in date order so that the earlier meal
 * gets first call on the food that is about to go off.
 */
function allocate(buckets: SupplyBucket[], requirements: readonly Demand[]): Allocation {
  const shortfalls: Shortfall[] = [];
  let fromStock = 0;
  let fromOrders = 0;

  for (const requirement of requirements) {
    let remaining = requirement.qty;
    for (const bucket of buckets) {
      if (remaining <= 1e-9) break;
      if (bucket.qty <= 1e-9) continue;
      if (bucket.from && bucket.from > requirement.dueOn) continue;
      if (bucket.until && bucket.until < requirement.dueOn) continue;

      const take = Math.min(bucket.qty, remaining);
      bucket.qty -= take;
      remaining -= take;
      if (bucket.kind === 'stock') fromStock += take;
      else fromOrders += take;
    }
    if (remaining > 1e-9) {
      shortfalls.push({ qty: remaining, dueOn: requirement.dueOn, source: requirement.source });
    }
  }

  return { fromStock, fromOrders, shortfalls };
}

/**
 * When to go shopping.
 *
 * Lead time sets the latest useful day; the supplier's opening days decide
 * which of the days before it you can actually go. A Saturday market cannot
 * supply Friday's dinner however early you plan, and saying so is more useful
 * than quietly printing an impossible date.
 */
function schedulePurchase(
  db: Database,
  item: Item,
  neededOn: IsoDate,
  asOf: IsoDate,
): { orderBy: IsoDate; late: boolean } {
  const leadTime = item.purchase?.leadTimeDays ?? 0;
  const latest = addDays(neededOn, -leadTime);
  const supplier = item.purchase ? findSupplier(db, item.purchase.supplierId) : undefined;
  const openOn = supplier?.deliveryDays;

  if (!openOn || openOn.length === 0) {
    return { orderBy: maxDate(asOf, latest), late: latest < asOf };
  }

  // Walk back from the last useful day to today, looking for an open day.
  for (let date = latest; date >= asOf; date = addDays(date, -1)) {
    if (openOn.includes(weekdayIndex(date))) return { orderBy: date, late: false };
  }

  // Nothing in the window: report the first opening after it, so the plan shows
  // the real constraint rather than an impossible instruction.
  for (let i = 0; i < 14; i += 1) {
    const date = addDays(asOf, i);
    if (openOn.includes(weekdayIndex(date))) return { orderBy: date, late: true };
  }
  return { orderBy: maxDate(asOf, latest), late: true };
}

/**
 * Batches already committed to be cooked, within the planning window.
 *
 * These play both roles an open works order plays in an ERP: they are supply
 * against the demand that caused them, so the same ragù is not planned twice,
 * and they are demand against their own components, because somebody still has
 * to buy the mince.
 */
function firmProductionOrders(db: Database, itemId: ItemId, until: IsoDate): ProductionOrder[] {
  return db.productionOrders.filter(
    (order) => order.status === 'open' && order.itemId === itemId && order.dueOn <= until,
  );
}

/**
 * Push one level of dependent demand down from a parent order.
 *
 * Exactly one level: the children are themselves planned later in the
 * low-level-code sweep, which is what keeps the netting correct.
 */
function explodeOneLevel(
  db: Database,
  itemId: ItemId,
  qty: number,
  dueOn: IsoDate,
  level: number,
  pegging: readonly string[],
  addDemand: (demand: Demand) => void,
  includeOptional = false,
): void {
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  if (!recipe) return;

  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  const batches = batchQty === 0 ? 0 : qty / batchQty;

  for (const component of recipe.components) {
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child) continue;

    const scaled = component.scalable === false ? component.qty : component.qty * batches;
    const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
    const gross = component.lossPct ? net / (1 - component.lossPct) : net;

    addDemand({
      itemId: child.id,
      qty: gross,
      dueOn,
      source: pegging[0] ?? itemId,
      level: level + 1,
    });
  }
}

/**
 * Firm up the make side of a planning run: planned production becomes open
 * production orders, which later runs treat as commitments.
 *
 * The buy side is firmed up separately by `raisePurchaseOrders`, because that
 * needs pack rounding and supplier grouping first.
 */
export function commitProduction(db: Database, result: MrpResult): ProductionOrder[] {
  const created: ProductionOrder[] = [];
  for (const planned of result.production) {
    const order: ProductionOrder = {
      id: nextId('PRD', [...db.productionOrders, ...created]),
      itemId: planned.itemId,
      qty: planned.qty,
      dueOn: planned.dueOn,
      startOn: planned.startOn,
      status: 'open',
      ...(planned.pegging[0] ? { pegging: planned.pegging[0] } : {}),
    };
    created.push(order);
    db.productionOrders.push(order);
  }
  return created;
}
