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

import { conversionContext, findItem, isMade, isStocked, mustItem, recipeFor, remainingServings } from '../domain/db.js';
import { addDays, daysBetween, maxDate, today, type IsoDate } from '../domain/date.js';
import { CycleError, MiseError, NotFoundError } from '../domain/errors.js';
import { convert } from '../domain/units.js';
import { nextId } from '../domain/ids.js';
import type { Database, Item, ItemId, MealPlanEntry, ProductionOrder } from '../domain/types.js';
import { quantityForServings, servingsForQuantity } from './explode.js';
import { lowLevelCodes } from './graph.js';
import { availableOn, isUsableOn, issue, receive, transactionally } from './inventory.js';
import type { MrpResult, PlannedProduction } from './mrp.js';
import { runMinutes, runMinutesWithPhantoms } from './rollup.js';

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

  // Each planned run carries its own policy — possibly stricter than the
  // MRP run's flag, when it replaces a commitment made with the optionals.
  for (const planned of mrp.production) add(toPrepTask(db, planned, planned.includeOptional ?? mrp.includeOptional));

  // Committed batches are supply to the planning run, so they no longer
  // appear in `mrp.production` — but somebody still has to cook them.
  // Without this, `mrp --commit` followed by `prep` says "nothing to cook"
  // while the order book is full. Every open order whose cooking falls
  // inside the window joins the schedule alongside the newly planned work —
  // including overdue ones: an order past its due date and still open is
  // late, not gone, and MRP is counting its output as supply. It cannot be
  // cooked in the past, so it lands on today's list.
  const horizonEnd = addDays(mrp.asOf, mrp.horizonDays - 1);
  const codes = lowLevelCodes(db);
  for (const order of db.productionOrders) {
    if (order.status !== 'open') continue;
    if (order.startOn > horizonEnd) continue;
    // Each firm order keeps the optional policy it was committed with.
    add(firmPrepTask(db, order, codes.get(order.itemId) ?? 0, mrp.asOf, order.includeOptional === true));
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

/**
 * The steps for a run, with the phantoms it makes inline folded in first:
 * the dough is kneaded before the sheets are rolled, and a schedule that
 * hides the kneading starts the evening late. Stocked sub-recipes are their
 * own tasks and keep their own steps.
 */
function stepsWithPhantoms(
  db: Database,
  itemId: ItemId,
  includeOptional: boolean,
  seen: ReadonlySet<ItemId> = new Set(),
): string[] {
  const recipe = recipeFor(db, itemId);
  if (!recipe) return [];
  const steps: string[] = [];
  for (const component of recipe.components) {
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child || isStocked(child) || seen.has(child.id)) continue;
    const inner = stepsWithPhantoms(db, child.id, includeOptional, new Set(seen).add(itemId));
    steps.push(...inner.map((text) => `${child.name}: ${text}`));
  }
  steps.push(...(recipe.steps ?? []).map((step) => step.text));
  return steps;
}

/** A prep task reconstructed from a firm order rather than a fresh plan. */
function firmPrepTask(db: Database, order: ProductionOrder, level: number, earliest: IsoDate, includeOptional: boolean): PrepTask {
  const item = mustItem(db, order.itemId);
  const recipe = recipeFor(db, order.itemId);
  const batchQty = recipe
    ? convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item))
    : 0;
  const batches = recipe && batchQty > 0 ? order.qty / batchQty : 0;
  // Same timing policy as planning used when the order was cut: hands-on
  // scales with batches, unattended does not, and the phantoms this run
  // makes inline are on its clock.
  const minutes = recipe
    ? runMinutesWithPhantoms(db, item, recipe, batches, includeOptional)
    : { active: 0, passive: 0, total: 0 };

  return {
    itemId: order.itemId,
    name: item.name,
    qty: order.qty,
    uom: item.stockUom,
    servings: recipe ? batches * recipe.servings : 0,
    on: maxDate(earliest, order.startOn),
    dueOn: order.dueOn,
    activeMin: minutes.active,
    passiveMin: minutes.passive,
    level,
    steps: stepsWithPhantoms(db, order.itemId, includeOptional),
  };
}

function toPrepTask(db: Database, planned: PlannedProduction, includeOptional: boolean): PrepTask {
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
    steps: stepsWithPhantoms(db, planned.itemId, includeOptional),
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
  includeOptional = false,
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
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child) {
      // A dangling reference is a hard shortfall: production refuses to cook
      // this recipe, so feasibility must not advertise it as makeable —
      // "Cook now" offering unlimited servings of a dish that fails on click.
      const wanted = component.scalable === false ? component.qty : component.qty * batches;
      shortfalls.set(component.itemId, (shortfalls.get(component.itemId) ?? 0) + wanted);
      continue;
    }
    const scaled = component.scalable === false ? component.qty : component.qty * batches;
    const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
    const gross = component.lossPct ? net / (1 - component.lossPct) : net;
    slowestBranch = Math.max(
      slowestBranch,
      netRequirements(db, child.id, gross, balances, shortfalls, nextSeen, includeOptional),
    );
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
  includeOptional = false,
): { shortfalls: Map<ItemId, number>; minutes: number } {
  const shortfalls = new Map<ItemId, number>();
  const { qty } = quantityForServings(db, itemId, servings);
  const balances = stockBalances(db, asOf);
  // "Can I cook this?" is a different question from "can I put it on a plate?"
  // A tin of soup in the cupboard answers the second and not the first, so for
  // cooking we ignore any finished stock of the dish itself and price the job
  // from its ingredients.
  if (fromScratch) balances.delete(itemId);
  const minutes = netRequirements(db, itemId, qty, balances, shortfalls, new Set(), includeOptional);
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
  includeOptional = false,
): number {
  const ok = (servings: number): boolean =>
    shortfallsFor(db, itemId, servings, asOf, fromScratch, includeOptional).shortfalls.size === 0;

  let low = 0;
  let high = probe;
  if (ok(probe)) {
    // We can already do the probe; find out how much further stock stretches.
    // Keep doubling until the answer is "no" — stopping while it is still
    // "yes" would report the search bound as the limit, telling someone with
    // stock for a thousand servings that they can make 512. Forty doublings
    // is a factor of 10^12: a recipe still feasible there consumes
    // effectively nothing per serving, and the bound is as honest an answer
    // as any finite number.
    low = probe;
    high = probe * 2;
    for (let i = 0; ok(high); i += 1) {
      if (i >= 40) return high;
      low = high;
      high *= 2;
    }
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
  includeOptional = false,
): Feasibility {
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  const probe = targetServings ?? recipe?.servings ?? 1;

  const probed = shortfallsFor(db, itemId, probe, asOf, fromScratch, includeOptional);
  const shortfalls = probed.shortfalls;
  // The same walk against an empty pantry gives the denominator for coverage:
  // everything this dish needs, whether or not it happens to be in.
  const everything = new Map<ItemId, number>();
  netRequirements(
    db,
    itemId,
    quantityForServings(db, itemId, probe).qty,
    new Map(),
    everything,
    new Set(),
    includeOptional,
  );


  const missing: Shortage[] = [...shortfalls.entries()].map(([shortId, short]) => {
    // A shortfall can name an item a hand edit has deleted; report it by id
    // rather than crashing the report that exists to reveal it.
    const shortItem = findItem(db, shortId);
    return {
      itemId: shortId,
      name: shortItem?.name ?? `${shortId} (not in the item master)`,
      short,
      uom: shortItem?.stockUom ?? '?',
    };
  });

  const servings = maxFeasibleServings(db, itemId, probe, asOf, fromScratch, includeOptional);
  // The time answers for the servings on offer, not the probe: "you can make
  // forty" next to one batch's minutes is an invitation to a very long
  // evening. Only the cooking that actually remains counts — a stocked
  // sub-recipe is lifted off the shelf, not simmered again.
  const minutes =
    Math.abs(servings - probe) < 1e-9
      ? probed.minutes
      : shortfallsFor(db, itemId, servings, asOf, fromScratch, includeOptional).minutes;

  return {
    itemId,
    name: item.name,
    servings,
    coverage: everything.size === 0 ? 1 : 1 - missing.length / everything.size,
    missing: missing.sort((a, b) => b.short - a.short),
    criticalPathMin: minutes,
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
  /**
   * The earliest meal plan entry this serving fulfilled, when any matched.
   * A serving bigger than one entry retires the following due entries too.
   */
  readonly servedPlanEntryId?: string;
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
  /**
   * Serving only: the meal plan entry this serving fulfils. Omitted, the
   * earliest unserved entry for the item dated on or before the serve date
   * is matched automatically; pass an id to be explicit.
   */
  readonly planEntryId?: string;
  /**
   * Settle open production orders the making meets, and round inline makes
   * up to committed batch boundaries. Set by order execution and by a serve
   * that fulfils planned demand — both are commitments being met. A cook or
   * serve with no plan behind it leaves the order book alone: its output
   * goes into today's dish, not into the future the standing orders were
   * raised for.
   */
  readonly settleOrders?: boolean;
  /**
   * The demand the settlement is on behalf of: meal plan entry ids (a
   * serve's matched entries, or an executed order's own pegs). An order
   * pegged to *other* meals is neither swept into the making nor settled —
   * its batch belongs to the dinners it was committed for. Orders with no
   * pegs recorded stand for the item generally and always participate.
   */
  readonly settlePegs?: readonly string[];
  /**
   * The date this making's finished output books into stock, when it
   * differs from the cook date: a multi-day batch completes — and starts
   * aging — later than it starts. Applies to this making's own output
   * only; children cooked inline book at their cook date.
   */
  readonly outputOn?: IsoDate;
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
  path: readonly ItemId[] = [],
): ProductionResult {
  const { cascade = true, allowShortages = false, includeOptional = false } = options;
  // The completion date belongs to this making alone — a child cooked
  // inline books at its cook date, not at the parent's finish line.
  const { outputOn, ...inherited } = options;
  const on = options.on ?? today();
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  const ref = options.ref ?? `make:${itemId}`;

  // The same guard explosion carries: a hand-edited database can contain a
  // recipe loop, and with nothing in stock the cascade would chase it until
  // the call stack ran out. Name the loop instead.
  if (path.includes(itemId)) throw new CycleError([...path, itemId]);
  const nextPath = [...path, itemId];

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
    if (!child) {
      // Explosion tolerates a dangling reference so a broken database can
      // still be inspected; production moves real stock and must not cook a
      // recipe with a hole in it — half the ingredients issued, full output
      // booked, no shortage reported. Throwing rolls the whole batch back.
      throw new MiseError(
        `Recipe for "${item.name}" calls for unknown item "${component.itemId}" — ` +
          `fix the data (mise doctor) before cooking.`,
      );
    }

    const scaled = component.scalable === false ? component.qty : component.qty * batches;
    const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
    const need = component.lossPct ? net / (1 - component.lossPct) : net;
    if (need <= 1e-9) continue;

    // Phantom: nothing to take off a shelf, so make it inline and charge its
    // components to this order.
    if (!isStocked(child)) {
      const inner = produceInner(
        db,
        child.id,
        need,
        { ...inherited, on, ref, consumeImmediately: true },
        nextPath,
      );
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
      let gap = need - available;
      if (options.settleOrders === true) {
        // A committed order is the making MRP planned: one run, one dose of
        // every `scalable: false` input, however many meals share it.
        // Cooking only this parent's share would leave the rest of the run
        // to be cooked again for the next parent — a second dose of fixed
        // inputs that were planned, and bought, once. Round the cascade up
        // to the boundary of the last order it touches; the surplus is
        // banked for the siblings the merged run was planned to feed.
        gap = committedMakeQty(db, child, gap, on, options.settlePegs).qty;
      }
      // The child books its own tub whatever frame asked for it: a phantom
      // parent consumes *its* output immediately, but a stocked child under
      // one is still issued from stock below, so its output must land there
      // first — inheriting the flag would strand the fresh batch nowhere
      // and fail that issue against an empty shelf.
      const inner = produceInner(db, child.id, gap, { ...inherited, on, ref, consumeImmediately: false }, nextPath);
      cascadedMinutes += inner.minutes;
      shortages.push(...inner.shortages);
      madeToOrder = true;
      // While a committed parent is being executed, cooking the gap inline
      // has, in fact, executed the committed child order that stood for it.
      // Left open, that order would be cooked again — duplicate stock —
      // while MRP and prep kept counting a commitment already met. An ad-hoc
      // cook is different: its sauce went into *this* dish, not into the
      // future meal the order book is holding, so it settles nothing.
      if (options.settleOrders === true) settleCommittedOrders(db, child.id, gap, options.settlePegs);
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
      on: outputOn ?? on,
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

  const on = options.on ?? today();

  // An explicit plan entry is validated *before* anything moves: a stale or
  // mistaken id must not silently retire a different dish's demand — and
  // discovering that after the food is issued would be too late to refuse.
  let entries: MealPlanEntry[];
  if (options.planEntryId !== undefined) {
    const entry = db.mealPlan.find((candidate) => candidate.id === options.planEntryId);
    if (!entry || entry.itemId !== itemId || remainingServings(entry) <= 1e-9) {
      throw new MiseError(
        `Plan entry "${options.planEntryId}" is not an unserved entry for "${mustItem(db, itemId).name}".`,
      );
    }
    // Explicit is explicit: portions beyond this entry are seconds, not a
    // licence to retire other meals' demand.
    entries = [entry];
  } else {
    entries = db.mealPlan
      .filter(
        (candidate) =>
          candidate.itemId === itemId && remainingServings(candidate) > 1e-9 && candidate.date <= on,
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // Cook-and-eat is one operation: if the cooking fails, the ingredients it
  // had already taken go back on the shelf, exactly as for `produce`.
  // A serve that fulfils plan entries is committed demand being met, so any
  // cooking it triggers executes the committed batches — whole, with their
  // orders settled — exactly as `receive PRD-x` would. A serve with no plan
  // behind it stays ad-hoc and leaves the order book alone.
  const fulfillingPlan = entries.length > 0;
  // The pegs are the entries these portions actually reach — the same
  // earliest-first walk that marks them served afterwards. A due entry the
  // portions never get to is not being fulfilled, and a batch committed
  // for it must not be cooked, or closed, on its behalf.
  const servedIds: string[] = [];
  let claimed = 0;
  for (const entry of entries) {
    if (claimed + 1e-9 >= servings) break;
    servedIds.push(entry.id);
    claimed += remainingServings(entry);
  }
  const result = transactionally(db, () =>
    serveInner(db, itemId, servings, {
      settleOrders: fulfillingPlan,
      settlePegs: servedIds,
      ...options,
    }),
  );

  // Only after the serve has actually happened: what was eaten stops being
  // demand — otherwise the next planning run would buy and cook a
  // replacement. Deliberately outside the transaction boundary, so a failed
  // serve leaves the plan intact. Portions count: one plate from a
  // six-portion entry leaves five still planned, and the entry only becomes
  // history when the last of them goes. A serving that spans entries walks
  // them earliest-first — four portions against two two-portion dinners
  // retires both, not one plus two portions lost to the cap.
  let left = servings;
  let firstServedId: string | undefined;
  for (const entry of entries) {
    if (left <= 1e-9) break;
    const portion = Math.min(remainingServings(entry), left);
    entry.servedServings = Math.min(entry.servings, (entry.servedServings ?? 0) + portion);
    if (remainingServings(entry) <= 1e-9) entry.servedOn = on;
    firstServedId ??= entry.id;
    left -= portion;
  }
  if (firstServedId !== undefined) return { ...result, servedPlanEntryId: firstServedId };
  return result;
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
  } else if (!recipeFor(db, itemId) && options.allowShortages === true) {
    // A purchased, ready-to-eat item that is short cannot be cooked into
    // existence. With shortages allowed, the serve itself is the record: the
    // forced issue below consumes what is there and posts the gap to the
    // ledger, instead of produceInner refusing for want of a recipe.
    const item = mustItem(db, itemId);
    result = {
      itemId,
      name: item.name,
      qty,
      uom: item.stockUom,
      servings,
      cost: 0,
      consumed: [],
      shortages: [{ itemId, name: item.name, short: qty - available, uom: item.stockUom }],
      minutes: 0,
    };
  } else {
    // The dish's own committed batch is the making unit here too: serving
    // Friday's half of a merged two-dinner order cooks the whole batch —
    // one making, one dose of its fixed inputs — and banks Sunday's half,
    // then closes the order the making has met. Without this, serving each
    // meal cooked the run again and consumed fixed ingredients the plan
    // bought once. Only orders pegged to the meals being served (or pegged
    // to nothing) participate: a dinner added after the commit must not
    // eat a batch committed for another meal.
    let make = qty - available;
    let makeOptions = { ...options, on };
    if (options.settleOrders === true) {
      const committed = committedMakeQty(db, mustItem(db, itemId), make, on, options.settlePegs);
      make = committed.qty;
      // The batch is cooked as it was committed: a plain serve inherits the
      // order's optional policy exactly as `receive PRD-x` does, and an
      // explicit choice from the caller still wins.
      if (options.includeOptional === undefined && committed.includeOptional) {
        makeOptions = { ...makeOptions, includeOptional: true };
      }
    }
    result = produceInner(db, itemId, make, makeOptions);
    if (options.settleOrders === true) settleCommittedOrders(db, itemId, make, options.settlePegs);
  }

  // The cost of a meal is the cost of the lots it came out of, whether those
  // were cooked a moment ago or have been sitting in the fridge since Sunday.
  const eaten = issue(db, itemId, { qty, on, ref: `serve:${itemId}`, allowNegative: true });
  return { ...result, qty, servings, cost: eaten.cost };
}

/** Open production orders for an item, earliest-due-first — settlement order. */
function openOrdersFor(db: Database, itemId: ItemId): ProductionOrder[] {
  return db.productionOrders
    .filter((order) => order.status === 'open' && order.itemId === itemId)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/**
 * The open orders a settlement on behalf of `pegs` may touch. An order
 * pegged to other meals belongs to those dinners — a meal added after the
 * commit must not eat it. No filter, or an order with no pegs recorded,
 * means everything participates.
 */
function settleableOrders(db: Database, itemId: ItemId, pegs?: readonly string[]): ProductionOrder[] {
  return openOrdersFor(db, itemId).filter(
    (order) =>
      pegs === undefined ||
      order.pegging === undefined ||
      order.pegging.length === 0 ||
      order.pegging.some((peg) => pegs.includes(peg)),
  );
}

/**
 * Round an inline making up to the boundary of the open committed orders it
 * touches: the committed run is the making unit, with one dose of every
 * `scalable: false` input, however many meals share it. Perishable orders
 * whose planned start is later than the cook date are left standing — the
 * shelf-life proof behind a merge is anchored at its planned start, and a
 * batch made early may not keep for the meals the proof promised. Also
 * reports whether any swept order was committed with its optional
 * components, so the batch can be cooked as it was committed.
 */
function committedMakeQty(
  db: Database,
  item: Item,
  gap: number,
  on: IsoDate,
  pegs?: readonly string[],
): { qty: number; includeOptional: boolean } {
  let boundary = 0;
  let includeOptional = false;
  for (const order of settleableOrders(db, item.id, pegs)) {
    if (boundary + 1e-9 >= gap) break;
    if (item.shelfLifeDays !== undefined && on < order.startOn) break;
    boundary += order.qty;
    if (order.includeOptional === true) includeOptional = true;
  }
  return { qty: boundary > gap ? boundary : gap, includeOptional };
}

/**
 * Apply quantity cooked against the open orders it fulfilled. Only order
 * execution and a serve fulfilling planned demand reach here — the cascade
 * of an ad-hoc cook fulfils nothing on the order book.
 *
 * Orders are settled earliest-due-first, whatever their scheduled start: a
 * parent executed ahead of plan cooks its child ahead of plan too, and the
 * child's not-yet-opened order is exactly the commitment that work met.
 * (Freshness is no objection here — the cascaded output went straight into
 * the parent, not onto a shelf to age.) An order the cooked quantity only
 * partially covers — an off-plan quantity, or an early execution of a
 * perishable run, since a committed cascade otherwise rounds itself up to
 * order boundaries — is *reduced*,
 * not left standing: there is no lot for a later planning run to
 * reconcile, so the remainder is the only part of the commitment still
 * real.
 */
function settleCommittedOrders(
  db: Database,
  itemId: ItemId,
  cooked: number,
  pegs?: readonly string[],
): void {
  let remaining = cooked;
  for (const order of settleableOrders(db, itemId, pegs)) {
    if (remaining <= 1e-9) break;
    if (remaining + 1e-9 >= order.qty) {
      remaining -= order.qty;
      order.status = 'received';
    } else {
      order.qty -= remaining;
      remaining = 0;
    }
  }
}

/** Close out an open production order by actually making it. */
export function executeOrder(db: Database, orderId: string, options: ProduceOptions = {}): ProductionResult {
  const order = db.productionOrders.find((o) => o.id === orderId);
  if (!order) throw new NotFoundError('production order', orderId);
  if (order.status === 'received') throw new MiseError(`Production order "${orderId}" is already done.`);
  // The same rule the purchase-order receipt applies: a cancelled order is a
  // decision already made, not a batch waiting to be cooked.
  if (order.status === 'cancelled') throw new MiseError(`Production order "${orderId}" was cancelled.`);
  // The order carries the optional policy it was committed with; an explicit
  // caller choice still wins.
  // A making that spans days finishes later than it starts: the sourdough
  // begun Friday is bread on Sunday, and it ages from Sunday. Book the
  // output at the making's completion — the planned span offset from the
  // actual start — which is also the arrival date MRP promised the supply
  // for when it merged later meals into this batch.
  const startedOn = options.on ?? today();
  const completion = addDays(startedOn, Math.max(0, daysBetween(order.startOn, order.dueOn)));
  const result = produce(db, order.itemId, order.qty, {
    includeOptional: order.includeOptional === true,
    ...options,
    ref: orderId,
    settleOrders: true,
    outputOn: completion,
    // Child settlements act on behalf of this order's meals: sibling child
    // orders pegged to other dinners keep their batches.
    ...(order.pegging ? { settlePegs: order.pegging } : {}),
  });
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
  const item = mustItem(db, itemId);
  // MRP would credit the order as inbound supply — suppressing the real
  // purchase — while execution can never complete it: a purchased item has
  // no recipe to cook, and a phantom's output cannot enter stock.
  if (item.sourcing !== 'manufactured') {
    throw new MiseError(
      `"${item.name}" is ${item.sourcing} — only manufactured items can go on a production order.`,
    );
  }
  // The same rule produce applies at execution, enforced before the order
  // book holds a batch of nothing that doctor immediately calls invalid.
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new MiseError(`Cannot raise an order for ${qty} ${item.stockUom} of "${item.name}".`);
  }
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
