/**
 * Production: prep scheduling, and actually cooking things.
 *
 * `executeProduction` is where the recursion stops being a report and starts
 * moving stock. Cooking a béchamel issues butter, flour and milk out of real
 * lots and books a real tub of béchamel back in, at the cost of the lots it
 * actually came from. If the roux it needs isn't in the fridge, it makes the
 * roux first — a cascading, make-to-order backflush that falls straight out of
 * the same recursive structure the shopping list uses.
 */

import { conversionContext, findItem, isMade, isStocked, mustItem, recipeFor } from '../domain/db.js';
import { addDays, today, type IsoDate } from '../domain/date.js';
import { MiseError, NotFoundError } from '../domain/errors.js';
import { convert } from '../domain/units.js';
import { nextId } from '../domain/ids.js';
import type { Database, ItemId, ProductionOrder } from '../domain/types.js';
import { quantityForServings, servingsForQuantity } from './explode.js';
import { lowLevelCodes } from './graph.js';
import { availableOn, isUsableOn, issue, receive, transactionally } from './inventory.js';
import type { MrpResult, PlannedProduction } from './mrp.js';
import { runMinutes } from './rollup.js';

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface PrepTask {
  readonly itemId: ItemId;
  readonly name: string;
  readonly qty: number;
  readonly uom: string;
  readonly servings: number;
  readonly on: IsoDate;
  readonly dueOn: IsoDate;
  readonly activeMin: number;
  readonly passiveMin: number;
  /** Depth in the recipe graph — deeper tasks must happen first. */
  readonly level: number;
  readonly forDish?: string;
  readonly steps: readonly string[];
}

export interface PrepDay {
  readonly date: IsoDate;
  readonly tasks: readonly PrepTask[];
  readonly activeMin: number;
  readonly passiveMin: number;
}

/**
 * Turn planned production into a day-by-day prep plan.
 *
 * Within a day tasks are ordered deepest-first, which is the only order that
 * works: the roux before the béchamel before the lasagne.
 */
export function prepSchedule(db: Database, mrp: MrpResult): PrepDay[] {
  const byDate = new Map<IsoDate, PrepTask[]>();
  const add = (task: PrepTask): void => {
    const list = byDate.get(task.on);
    if (list) list.push(task);
    else byDate.set(task.on, [task]);
  };

  for (const planned of mrp.production) add(toPrepTask(db, planned));

  // Committed batches are supply to the planning run, so they no longer
  // appear in `mrp.production` — but somebody still has to cook them.
  // Without this, `mrp --commit` followed by `prep` says "nothing to cook"
  // while the order book is full. Every open order whose cooking falls
  // inside the window joins the schedule alongside the newly planned work.
  const horizonEnd = addDays(mrp.asOf, mrp.horizonDays - 1);
  const codes = lowLevelCodes(db);
  for (const order of db.productionOrders) {
    if (order.status !== 'open') continue;
    if (order.startOn > horizonEnd || order.dueOn < mrp.asOf) continue;
    add(firmPrepTask(db, order, codes.get(order.itemId) ?? 0));
  }

  return [...byDate.entries()]
    .map(([date, tasks]) => {
      const ordered = [...tasks].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
      return {
        date,
        tasks: ordered,
        activeMin: ordered.reduce((sum, t) => sum + t.activeMin, 0),
        passiveMin: ordered.reduce((sum, t) => sum + t.passiveMin, 0),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A prep task reconstructed from a firm order rather than a fresh plan. */
function firmPrepTask(db: Database, order: ProductionOrder, level: number): PrepTask {
  const item = mustItem(db, order.itemId);
  const recipe = recipeFor(db, order.itemId);
  const batchQty = recipe
    ? convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item))
    : 0;
  const batches = recipe && batchQty > 0 ? order.qty / batchQty : 0;
  // Same batch policy as planning used when the order was cut: hands-on
  // scales with batches, unattended does not.
  const minutes = recipe ? runMinutes(recipe, batches) : { active: 0, passive: 0, total: 0 };

  return {
    itemId: order.itemId,
    name: item.name,
    qty: order.qty,
    uom: item.stockUom,
    servings: recipe ? batches * recipe.servings : 0,
    on: order.startOn,
    dueOn: order.dueOn,
    activeMin: minutes.active,
    passiveMin: minutes.passive,
    level,
    steps: (recipe?.steps ?? []).map((step) => step.text),
  };
}

function toPrepTask(db: Database, planned: PlannedProduction): PrepTask {
  const recipe = recipeFor(db, planned.itemId);
  return {
    itemId: planned.itemId,
    name: planned.name,
    qty: planned.qty,
    uom: planned.uom,
    servings: planned.servings,
    on: planned.startOn,
    dueOn: planned.dueOn,
    // Straight from the planning run, which already scaled hands-on time by
    // the batch count. Recomputing from the recipe here would quietly report
    // a twenty-batch day as a one-batch day.
    activeMin: planned.activeMin,
    passiveMin: planned.passiveMin,
    level: planned.level,
    steps: (recipe?.steps ?? []).map((step) => step.text),
  };
}

// ---------------------------------------------------------------------------
// Feasibility — "what can I actually cook right now?"
// ---------------------------------------------------------------------------

export interface Feasibility {
  readonly itemId: ItemId;
  readonly name: string;
  /** Servings you could make from stock alone. */
  readonly servings: number;
  /** Fraction of the required ingredients (by count) that you have. */
  readonly coverage: number;
  readonly missing: readonly Shortage[];
  /** Longest unavoidable wait, in minutes, including sub-recipes. */
  readonly criticalPathMin: number;
}

/** A quantity of something that was needed and not there. */
export interface Shortage {
  readonly itemId: ItemId;
  readonly name: string;
  readonly short: number;
  readonly uom: string;
}

/**
 * Free stock per item, as a working balance that a walk can draw down.
 * Counts only lots you could actually reach on the day — nothing past its
 * date, and nothing that has not arrived yet.
 */
function stockBalances(db: Database, asOf: IsoDate): Map<ItemId, number> {
  const balances = new Map<ItemId, number>();
  for (const lot of db.lots) {
    if (!isUsableOn(lot, asOf)) continue;
    balances.set(lot.itemId, (balances.get(lot.itemId) ?? 0) + lot.qty);
  }
  return balances;
}

/**
 * Net a requirement against stock at *every* level, recording what is still
 * missing at the bottom, and returning how long the part that still has to be
 * made would actually take.
 *
 * The two properties that matter, and that a plain explode-then-compare gets
 * wrong in opposite directions:
 *
 *  - A sub-recipe you already have is taken off the shelf and *not* exploded.
 *    A tub of ragù in the fridge means you do not need mince, even though a
 *    naive explosion would insist on it.
 *  - Stock is a shared balance drawn down as the walk proceeds, so butter
 *    needed by two different branches is measured against one tub of butter
 *    rather than being credited the same 100 g twice.
 */
function netRequirements(
  db: Database,
  itemId: ItemId,
  qty: number,
  balances: Map<ItemId, number>,
  shortfalls: Map<ItemId, number>,
  seen: ReadonlySet<ItemId> = new Set(),
): number {
  if (qty <= 1e-9) return 0;
  const item = mustItem(db, itemId);

  // Phantoms are never on a shelf, whatever the ledger might say.
  const available = isStocked(item) ? (balances.get(itemId) ?? 0) : 0;
  const taken = Math.min(available, qty);
  if (taken > 0) balances.set(itemId, available - taken);

  const remaining = qty - taken;
  // Covered off the shelf: nothing to make, so nothing to wait for. A sauce
  // that simmered for two hours last week costs nothing today.
  if (remaining <= 1e-9) return 0;

  const recipe = isMade(item) && !seen.has(itemId) ? recipeFor(db, itemId) : undefined;
  if (!recipe) {
    shortfalls.set(itemId, (shortfalls.get(itemId) ?? 0) + remaining);
    return 0;
  }

  const nextSeen = new Set(seen).add(itemId);
  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  const batches = batchQty === 0 ? 0 : remaining / batchQty;

  // Sub-recipes can be made alongside one another, so the wait is set by the
  // slowest branch, not the sum — the same rule `rollupTime` uses.
  let slowestBranch = 0;
  for (const component of recipe.components) {
    if (component.optional) continue;
    const child = findItem(db, component.itemId);
    if (!child) continue;
    const scaled = component.scalable === false ? component.qty : component.qty * batches;
    const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
    const gross = component.lossPct ? net / (1 - component.lossPct) : net;
    slowestBranch = Math.max(slowestBranch, netRequirements(db, child.id, gross, balances, shortfalls, nextSeen));
  }

  return runMinutes(recipe, batches).total + slowestBranch;
}

/**
 * What you would still have to buy to make `servings` of something, and how
 * long the cooking that remains would take.
 */
function shortfallsFor(
  db: Database,
  itemId: ItemId,
  servings: number,
  asOf: IsoDate,
  fromScratch = false,
): { shortfalls: Map<ItemId, number>; minutes: number } {
  const shortfalls = new Map<ItemId, number>();
  const { qty } = quantityForServings(db, itemId, servings);
  const balances = stockBalances(db, asOf);
  // "Can I cook this?" is a different question from "can I put it on a plate?"
  // A tin of soup in the cupboard answers the second and not the first, so for
  // cooking we ignore any finished stock of the dish itself and price the job
  // from its ingredients.
  if (fromScratch) balances.delete(itemId);
  const minutes = netRequirements(db, itemId, qty, balances, shortfalls);
  return { shortfalls, minutes };
}

/**
 * Largest serving count that needs nothing bought.
 *
 * Requirements are non-decreasing in servings — fixed components stay put, the
 * rest grow — so "needs nothing" is monotone and bisection is exact to the
 * tolerance it runs to.
 */
function maxFeasibleServings(
  db: Database,
  itemId: ItemId,
  probe: number,
  asOf: IsoDate,
  fromScratch: boolean,
): number {
  const ok = (servings: number): boolean =>
    shortfallsFor(db, itemId, servings, asOf, fromScratch).shortfalls.size === 0;

  let low = 0;
  let high = probe;
  if (ok(probe)) {
    // We can already do the probe; find out how much further stock stretches.
    low = probe;
    high = probe * 2;
    for (let i = 0; i < 8 && ok(high); i += 1) {
      low = high;
      high *= 2;
    }
    if (ok(high)) return high;
  }

  for (let i = 0; i < 24 && high - low > 1e-4; i += 1) {
    const mid = (low + high) / 2;
    if (ok(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * How much of something you could make from what's in the house, counting
 * sub-recipes you already have as the finished thing rather than insisting on
 * their raw ingredients.
 */
export function feasibility(
  db: Database,
  itemId: ItemId,
  targetServings?: number,
  asOf: IsoDate = today(),
  fromScratch = false,
): Feasibility {
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  const probe = targetServings ?? recipe?.servings ?? 1;

  const probed = shortfallsFor(db, itemId, probe, asOf, fromScratch);
  const shortfalls = probed.shortfalls;
  // The same walk against an empty pantry gives the denominator for coverage:
  // everything this dish needs, whether or not it happens to be in.
  const everything = new Map<ItemId, number>();
  netRequirements(db, itemId, quantityForServings(db, itemId, probe).qty, new Map(), everything);


  const missing: Shortage[] = [...shortfalls.entries()].map(([shortId, short]) => {
    const shortItem = mustItem(db, shortId);
    return { itemId: shortId, name: shortItem.name, short, uom: shortItem.stockUom };
  });

  return {
    itemId,
    name: item.name,
    servings: maxFeasibleServings(db, itemId, probe, asOf, fromScratch),
    coverage: everything.size === 0 ? 1 : 1 - missing.length / everything.size,
    missing: missing.sort((a, b) => b.short - a.short),
    // Only the cooking that actually remains — a stocked sub-recipe is lifted
    // off the shelf, not simmered again.
    criticalPathMin: probed.minutes,
  };
}

/** Rank everything you could plausibly cook tonight. */
export function cookableNow(db: Database, minServings = 1, asOf: IsoDate = today()): Feasibility[] {
  return db.items
    .filter((item) => isMade(item) && isStocked(item) && recipeFor(db, item.id))
    .map((item) => feasibility(db, item.id, undefined, asOf, true))
    .filter((result) => result.servings >= minServings)
    .sort((a, b) => b.servings - a.servings || a.criticalPathMin - b.criticalPathMin);
}

/** The near-misses: dishes one or two ingredients away from being possible. */
export function almostCookable(db: Database, maxMissing = 2, asOf: IsoDate = today()): Feasibility[] {
  return db.items
    .filter((item) => isMade(item) && isStocked(item) && recipeFor(db, item.id))
    .map((item) => feasibility(db, item.id, undefined, asOf, true))
    .filter((result) => result.servings < 1 && result.missing.length > 0 && result.missing.length <= maxMissing)
    .sort((a, b) => a.missing.length - b.missing.length || b.coverage - a.coverage);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ConsumedLine {
  readonly itemId: ItemId;
  readonly name: string;
  readonly qty: number;
  readonly uom: string;
  readonly cost: number;
  readonly shortfall: number;
  /** True when this component had to be cooked on the spot rather than taken from stock. */
  readonly madeToOrder: boolean;
}

export interface ProductionResult {
  readonly itemId: ItemId;
  readonly name: string;
  readonly qty: number;
  readonly uom: string;
  readonly servings: number;
  /** Actual cost from the lots consumed, not standard cost. */
  readonly cost: number;
  readonly consumed: readonly ConsumedLine[];
  readonly lotId?: string;
  readonly shortages: readonly Shortage[];
  readonly minutes: number;
}

export interface ProduceOptions {
  readonly on?: IsoDate;
  /** Make missing sub-recipes on the spot instead of failing. Default true. */
  readonly cascade?: boolean;
  /** Consume ingredients that aren't in stock, recording the shortfall. Default false. */
  readonly allowShortages?: boolean;
  readonly includeOptional?: boolean;
  readonly ref?: string;
  /** Don't book the output into stock — used when a dish is eaten immediately. */
  readonly consumeImmediately?: boolean;
}

/**
 * Cook something: issue the components, book in the output.
 *
 * Sub-recipes are handled exactly as an ERP handles subassemblies. If the
 * component is stocked and present, it is issued. If it is stocked but short,
 * the shortfall is produced first (recursively). If it is a phantom, there is
 * nothing to issue — we go straight through to *its* components.
 */
export function produce(
  db: Database,
  itemId: ItemId,
  qty: number,
  options: ProduceOptions = {},
): ProductionResult {
  // A run of nothing is not a run. Without this a zero-sized batch would still
  // issue every `scalable: false` component — the pinch of salt that does not
  // scale — and book a zero-quantity lot and ledger receipt for output nobody
  // asked for.
  if (!(qty > 0)) {
    throw new MiseError(`Cannot make ${qty} ${mustItem(db, itemId).stockUom} of "${mustItem(db, itemId).name}".`);
  }
  // The outermost call owns the rollback boundary; the recursion below calls
  // `produceInner` directly so a cascade is undone as one unit with its parent.
  return transactionally(db, () => produceInner(db, itemId, qty, options));
}

function produceInner(
  db: Database,
  itemId: ItemId,
  qty: number,
  options: ProduceOptions = {},
): ProductionResult {
  const { cascade = true, allowShortages = false, includeOptional = false } = options;
  const on = options.on ?? today();
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  const ref = options.ref ?? `make:${itemId}`;

  if (!recipe) {
    throw new MiseError(`"${item.name}" has no recipe; it can only be bought.`);
  }

  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  const batches = batchQty === 0 ? 0 : qty / batchQty;

  const consumed: ConsumedLine[] = [];
  const shortages: Shortage[] = [];
  let cost = 0;
  // Anything cooked on the spot to satisfy this order was still cooked by this
  // order, so its time belongs in the total.
  let cascadedMinutes = 0;

  for (const component of recipe.components) {
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child) continue;

    const scaled = component.scalable === false ? component.qty : component.qty * batches;
    const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
    const need = component.lossPct ? net / (1 - component.lossPct) : net;
    if (need <= 1e-9) continue;

    // Phantom: nothing to take off a shelf, so make it inline and charge its
    // components to this order.
    if (!isStocked(child)) {
      const inner = produceInner(db, child.id, need, {
        ...options,
        on,
        ref,
        consumeImmediately: true,
      });
      cost += inner.cost;
      cascadedMinutes += inner.minutes;
      shortages.push(...inner.shortages);
      consumed.push({
        itemId: child.id,
        name: child.name,
        qty: need,
        uom: child.stockUom,
        cost: inner.cost,
        shortfall: 0,
        madeToOrder: true,
      });
      continue;
    }

    let madeToOrder = false;
    const available = availableOn(db, child.id, on);
    if (available + 1e-9 < need && isMade(child) && cascade) {
      const gap = need - available;
      const inner = produceInner(db, child.id, gap, { ...options, on, ref });
      cascadedMinutes += inner.minutes;
      shortages.push(...inner.shortages);
      madeToOrder = true;
    }

    // `consumeImmediately` decides whether the *output* gets booked into stock.
    // It must not quietly relax the caller's shortage policy: a recipe that
    // happens to contain a phantom should fail exactly as loudly as one that
    // does not.
    const result = issue(db, child.id, { qty: need, on, ref, allowNegative: allowShortages });
    cost += result.cost;
    if (result.shortfall > 1e-9) {
      shortages.push({ itemId: child.id, name: child.name, short: result.shortfall, uom: child.stockUom });
    }
    consumed.push({
      itemId: child.id,
      name: child.name,
      qty: need,
      uom: child.stockUom,
      cost: result.cost,
      shortfall: result.shortfall,
      madeToOrder,
    });
  }

  // The same per-run timing planning uses, so `mise cook` and `mise prep`
  // never disagree about how long the same job takes.
  const minutes = runMinutes(recipe, batches);
  const unitCost = qty > 0 ? cost / qty : 0;

  let lotId: string | undefined;
  if (!options.consumeImmediately) {
    const lot = receive(db, itemId, {
      qty,
      on,
      unitCost,
      type: 'produce',
      origin: ref,
      note: `made ${qty.toFixed(0)} ${item.stockUom}`,
    });
    lotId = lot.id;
  }

  return {
    itemId,
    name: item.name,
    qty,
    uom: item.stockUom,
    servings: servingsForQuantity(db, itemId, qty, item.stockUom),
    cost,
    consumed,
    ...(lotId ? { lotId } : {}),
    shortages,
    minutes: minutes.total + cascadedMinutes,
  };
}

/** Cook by portions rather than by weight. */
export function cook(
  db: Database,
  itemId: ItemId,
  servings: number,
  options: ProduceOptions = {},
): ProductionResult {
  const { qty } = quantityForServings(db, itemId, servings);
  return produce(db, itemId, qty, options);
}

/**
 * Serve a meal: cook it if needed, then take it out of stock for good.
 * This is what closes the loop between the plan and the pantry.
 */
export function serve(
  db: Database,
  itemId: ItemId,
  servings: number,
  options: ProduceOptions = {},
): ProductionResult {
  if (!(servings > 0)) {
    throw new MiseError(`Cannot serve ${servings} of "${mustItem(db, itemId).name}".`);
  }
  // Cook-and-eat is one operation: if the cooking fails, the ingredients it
  // had already taken go back on the shelf, exactly as for `produce`.
  return transactionally(db, () => serveInner(db, itemId, servings, options));
}

function serveInner(
  db: Database,
  itemId: ItemId,
  servings: number,
  options: ProduceOptions = {},
): ProductionResult {
  const on = options.on ?? today();
  const { qty } = quantityForServings(db, itemId, servings);
  const available = availableOn(db, itemId, on);

  let result: ProductionResult;
  if (available + 1e-9 >= qty) {
    result = {
      itemId,
      name: mustItem(db, itemId).name,
      qty,
      uom: mustItem(db, itemId).stockUom,
      servings,
      cost: 0,
      consumed: [],
      shortages: [],
      minutes: 0,
    };
  } else {
    result = produceInner(db, itemId, qty - available, { ...options, on });
  }

  // The cost of a meal is the cost of the lots it came out of, whether those
  // were cooked a moment ago or have been sitting in the fridge since Sunday.
  const eaten = issue(db, itemId, { qty, on, ref: `serve:${itemId}`, allowNegative: true });
  return { ...result, qty, servings, cost: eaten.cost };
}

/** Close out an open production order by actually making it. */
export function executeOrder(db: Database, orderId: string, options: ProduceOptions = {}): ProductionResult {
  const order = db.productionOrders.find((o) => o.id === orderId);
  if (!order) throw new NotFoundError('production order', orderId);
  if (order.status === 'received') throw new MiseError(`Production order "${orderId}" is already done.`);
  const result = produce(db, order.itemId, order.qty, { ...options, ref: orderId });
  order.status = 'received';
  return result;
}

/** Raise a one-off production order without running MRP. */
export function raiseProductionOrder(
  db: Database,
  itemId: ItemId,
  qty: number,
  dueOn: IsoDate,
): ProductionOrder {
  const order: ProductionOrder = {
    id: nextId('PRD', db.productionOrders),
    itemId,
    qty,
    dueOn,
    startOn: dueOn,
    status: 'open',
  };
  db.productionOrders.push(order);
  return order;
}
