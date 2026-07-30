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
  isMade,
  isStocked,
  mustItem,
  recipeFor,
} from '../domain/db.js';
import { addDays, maxDate, today, type IsoDate } from '../domain/date.js';
import { nextId } from '../domain/ids.js';
import { convert } from '../domain/units.js';
import type { Database, ItemId, MealPlanEntry, ProductionOrder } from '../domain/types.js';
import { quantityForServings } from './explode.js';
import { lowLevelCodes } from './graph.js';
import { onHand, onOrder } from './inventory.js';
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
  /** Items with a net requirement and no way to get them. */
  readonly problems: readonly string[];
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
  const consumedStock = new Map<ItemId, number>();

  for (const itemId of order) {
    const demands = demandsByItem.get(itemId);
    if (!demands || demands.length === 0) continue;

    const item = mustItem(db, itemId);
    const level = codes.get(itemId) ?? 0;
    const gross = demands.reduce((sum, d) => sum + d.qty, 0);
    const dueOn = demands.reduce<IsoDate>((earliest, d) => (d.dueOn < earliest ? d.dueOn : earliest), demands[0]!.dueOn);
    const pegging = [...new Set(demands.map((d) => d.source))];

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
      explodeOneLevel(db, itemId, gross, dueOn, level, pegging, addDemand, options.includeOptional);
      continue;
    }

    const stock = options.ignoreStock ? 0 : Math.max(0, onHand(db, itemId) - (consumedStock.get(itemId) ?? 0));
    const incoming = options.ignoreStock
      ? 0
      : onOrder(db, itemId, dueOn) + onProductionOrder(db, itemId, dueOn);
    const safety = item.safetyStock ?? 0;
    const net = Math.max(0, gross + safety - stock - incoming);

    consumedStock.set(itemId, (consumedStock.get(itemId) ?? 0) + Math.min(stock, gross));

    const action: MrpLine['action'] = net <= 1e-9 ? 'covered' : isMade(item) ? 'make' : 'buy';
    lines.push({
      itemId,
      name: item.name,
      level,
      gross,
      onHand: stock,
      onOrder: incoming,
      safetyStock: safety,
      net,
      uom: item.stockUom,
      action,
    });

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

    // Purchased: schedule the shopping trip by lead time.
    const leadTime = item.purchase?.leadTimeDays ?? 0;
    const orderBy = maxDate(asOf, addDays(dueOn, -leadTime));
    if (!item.purchase) {
      problems.push(`"${item.name}" is short by ${net.toFixed(1)} ${item.stockUom} but has no supplier.`);
    }
    purchases.push({
      itemId,
      name: item.name,
      qty: net,
      uom: item.stockUom,
      neededOn: dueOn,
      orderBy,
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
  };
}

/**
 * Quantity already committed to be cooked and due on or before `by`.
 *
 * Without this, firming up a plan with `commitProduction` and then re-running
 * MRP would plan the same batch of ragù a second time.
 */
function onProductionOrder(db: Database, itemId: ItemId, by: IsoDate): number {
  let total = 0;
  for (const order of db.productionOrders) {
    if (order.status !== 'open' || order.itemId !== itemId || order.dueOn > by) continue;
    total += order.qty;
  }
  return total;
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
