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
  remainingServings,
} from '../domain/db.js';
import { addDays, daysBetween, maxDate, today, weekdayIndex, type IsoDate } from '../domain/date.js';
import { MiseError } from '../domain/errors.js';
import { nextId } from '../domain/ids.js';
import { convert } from '../domain/units.js';
import type { Database, Item, ItemId, MealPlanEntry, ProductionOrder } from '../domain/types.js';
import { quantityForServings } from './explode.js';
import { lowLevelCodes } from './graph.js';
import { availableOn } from './inventory.js';
import { runMinutesWithPhantoms } from './rollup.js';

/** Hours in a day you can realistically be cooking. Used for backward scheduling. */
const COOKING_MINUTES_PER_DAY = 8 * 60;

export interface Demand {
  readonly itemId: ItemId;
  readonly qty: number;
  /** The date the quantity is needed *by*. */
  readonly dueOn: IsoDate;
  /**
   * Where the demand came from: meal plan entry ids, or parent order ids.
   * A production run that serves several meals passes *all* of them down to
   * its components, so the shopping list can answer "what is this for?"
   * completely rather than naming whichever meal happened to be first.
   */
  readonly sources: readonly string[];
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
  /**
   * True when no reachable trip works: the earliest lands after the food is
   * needed, or the only ones early enough land food that spoils before then.
   */
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
  /** Total wall-clock minutes for the whole run, not for one batch. */
  readonly minutes: number;
  /** Hands-on minutes, which scale with the number of batches. */
  readonly activeMin: number;
  /** Unattended minutes, which do not: batches prove and simmer in parallel. */
  readonly passiveMin: number;
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
  /** The optional-components choice this run was made with, so downstream
   *  views (prep timing, steps) describe the same plan. */
  readonly includeOptional: boolean;
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
  /**
   * Plan as if the pantry were empty. Commitments are not pantry: firm
   * production orders and open purchase orders still count as supply and
   * still demand their components, because they happen whether or not the
   * shelves are bare — dropping them would plan (and a commit would then
   * duplicate) work that is already firmly ordered.
   */
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
    // Demand is what remains to be served. A fully served entry is history;
    // a partially served one still wants its other portions.
    .map((entry) => ({ entry, remaining: remainingServings(entry) }))
    .filter(({ remaining }) => remaining > 1e-9)
    .map(({ entry, remaining }) => ({
      itemId: entry.itemId,
      qty: quantityForServings(db, entry.itemId, remaining).qty,
      dueOn: entry.date,
      sources: [entry.id],
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

  // A recipe can reference an item a hand edit has deleted. Each hole is one
  // problem, however many runs explode through it.
  const missingReported = new Set<string>();
  const reportMissing = (recipeName: string, componentId: ItemId): void => {
    const key = `${recipeName}:${componentId}`;
    if (missingReported.has(key)) return;
    missingReported.add(key);
    problems.push(
      `Recipe for "${recipeName}" calls for unknown item "${componentId}"; ` +
        `its demand cannot be planned — fix the data (mise doctor).`,
    );
  };

  const horizonEnd = addDays(asOf, horizonDays - 1);

  for (const itemId of order) {
    const item = mustItem(db, itemId);
    const demands = demandsByItem.get(itemId) ?? [];
    // Orders already firmed up by a previous run. They are supply for this
    // item *and* a source of demand for its components — and they survive
    // `ignoreStock`, which empties the pantry, not the order book.
    const firmOrders = firmProductionOrders(db, itemId, horizonEnd);

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

      // A phantom is made fresh each time it is wanted, so it keeps for zero
      // days: every distinct date is its own making. Collapsing them onto the
      // earliest date would buy perishables far too early for the later meal,
      // and would count a `scalable: false` component once for what are really
      // several separate batches.
      const passes = batchShortfalls(
        [...demands]
          .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
          .map((demand) => ({ qty: demand.qty, dueOn: demand.dueOn, sources: demand.sources })),
        0,
      );
      for (const pass of passes) {
        explodeOneLevel(db, itemId, pass.qty, pass.dueOn, level, pass.sources, addDemand, options.includeOptional, reportMissing);
      }
      continue;
    }

    // Net date by date. A carton that goes off on Thursday is supply for
    // Wednesday's dinner and not for Friday's, so a single lump comparison
    // against the earliest due date would let one carton cover the whole week.
    const requirements = [...demands];
    if (safety > 0) {
      // Safety stock is a floor on the balance. Normally that bites at the end
      // of the horizon, after everything planned has been eaten — but a buffer
      // that is *already* short is short today, and telling someone to restock
      // on day seven leaves the minimum unmet all week.
      const shortNow = !options.ignoreStock && availableOn(db, itemId, asOf) + 1e-9 < safety;
      requirements.push({
        itemId,
        qty: safety,
        dueOn: shortNow ? asOf : horizonEnd,
        sources: [SAFETY_STOCK],
        level,
      });
    }
    requirements.sort((a, b) => a.dueOn.localeCompare(b.dueOn));

    const allocation = allocate(supplyFor(db, item, firmOrders, options, asOf), requirements);
    const net = allocation.shortfalls.reduce((sum, short) => sum + short.qty, 0);
    // Shortfalls far enough apart that one order could not cover both become
    // separate orders — buying a week of salad on Monday is not a plan.
    const runs = batchShortfalls(allocation.shortfalls, item.shelfLifeDays);

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
      // An overdue order cooks today, so its ingredients are needed today —
      // not on the startOn that already slipped past, where stock received
      // since then is invisible to the dated allocator and gets bought twice.
      // The order's own optional policy governs its components: a batch
      // committed with its garnish keeps demanding the garnish, whatever
      // flag this run happens to use.
      explodeOneLevel(db, itemId, firm.qty, maxDate(asOf, firm.startOn), level, [firm.id], addDemand, firm.includeOptional === true, reportMissing);
    }

    if (net <= 1e-9) continue;

    if (isMade(item)) {
      const recipe = recipeFor(db, itemId);
      if (!recipe) {
        problems.push(`"${item.name}" is made but has no recipe; cannot plan ${net.toFixed(0)} ${item.stockUom}.`);
        continue;
      }
      const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
      for (const run of runs) {
        // Timing is per *run*, not per batch — see `runMinutes` — and it
        // includes the phantoms this run will make inline: the dough is
        // kneaded and rested on the sheets' clock, since it has no run of
        // its own.
        const batches = batchQty === 0 ? 0 : run.qty / batchQty;
        const { active: activeMin, passive: passiveMin, total: minutes } = runMinutesWithPhantoms(
          db,
          item,
          recipe,
          batches,
          options.includeOptional === true,
        );

        // Backward-schedule against a usable cooking day. A four-hour braise
        // still finishes the same day; an overnight prove does not.
        const daysNeeded = Math.max(1, Math.ceil(minutes / COOKING_MINUTES_PER_DAY));
        const wantedStart = addDays(run.dueOn, -(daysNeeded - 1));
        // You cannot start yesterday. If the recipe's own timings say the
        // deadline has already passed, say so instead of quietly printing a
        // prep task on a day that has gone — the same courtesy the buy side
        // gets when a shop cannot deliver in time.
        const startOn = maxDate(asOf, wantedStart);
        if (wantedStart < asOf) {
          conflicts.push(
            `${item.name} needs ${Math.round(minutes / 60)}h and is due ${run.dueOn}, so it should ` +
              `have been started on ${wantedStart} — the earliest it can now begin is ${startOn}.`,
          );
        }

        production.push({
          itemId,
          name: item.name,
          qty: run.qty,
          uom: item.stockUom,
          servings: batches * recipe.servings,
          dueOn: run.dueOn,
          startOn,
          minutes,
          activeMin,
          passiveMin,
          level,
          pegging: run.sources,
        });

        // Dependent demand, due when production starts rather than when it ends.
        explodeOneLevel(db, itemId, run.qty, startOn, level, run.sources, addDemand, options.includeOptional, reportMissing);
      }
      continue;
    }

    // Purchased: schedule the shopping trip by lead time and shop opening days.
    if (!item.purchase) {
      problems.push(`"${item.name}" is short by ${net.toFixed(1)} ${item.stockUom} but has no supplier.`);
    }
    for (const run of runs) {
      const trip = schedulePurchase(db, item, run.dueOn, asOf);
      if (trip.late) {
        const supplier = item.purchase ? findSupplier(db, item.purchase.supplierId) : undefined;
        conflicts.push(
          trip.spoils
            ? `${item.name} is needed ${run.dueOn}, but the nearest ${supplier?.name ?? 'supplier'} ` +
                `trip is ${trip.orderBy} and it only keeps ${item.shelfLifeDays} days — it would ` +
                `spoil before it is wanted.`
            : `${item.name} is needed ${run.dueOn}, but ${supplier?.name ?? 'the supplier'} cannot supply ` +
                `it in time — the earliest trip is ${trip.orderBy}.`,
        );
      }
      purchases.push({
        itemId,
        name: item.name,
        qty: run.qty,
        uom: item.stockUom,
        neededOn: run.dueOn,
        orderBy: trip.orderBy,
        late: trip.late,
        ...(item.purchase ? { supplierId: item.purchase.supplierId } : {}),
        pegging: run.sources,
      });
    }
  }

  return {
    asOf,
    horizonDays,
    includeOptional: options.includeOptional === true,
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

interface OrderRun {
  qty: number;
  readonly dueOn: IsoDate;
  readonly sources: string[];
}

/**
 * Gather dated shortfalls into runs that a single order could actually cover.
 *
 * Netting per date tells you *when* you are short; it does not follow that one
 * trip can fix it. Salad wanted on the 2nd and again on the 6th, with a two-day
 * shelf life, is two shopping trips — buying it all on the 2nd would leave half
 * of it rotting. A shortfall joins the run in progress only if the food would
 * still be good when it is wanted; an item with no shelf life keeps, so
 * everything merges into one order.
 */
function batchShortfalls(
  shortfalls: readonly Shortfall[],
  shelfLifeDays: number | undefined,
): OrderRun[] {
  const runs: OrderRun[] = [];
  for (const short of shortfalls) {
    const current = runs[runs.length - 1];
    const stillGood =
      current !== undefined &&
      (shelfLifeDays === undefined || daysBetween(current.dueOn, short.dueOn) <= shelfLifeDays);

    if (current && stillGood) {
      current.qty += short.qty;
      for (const source of short.sources) {
        if (!current.sources.includes(source)) current.sources.push(source);
      }
    } else {
      runs.push({ qty: short.qty, dueOn: short.dueOn, sources: [...short.sources] });
    }
  }
  return runs;
}

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
  asOf: IsoDate,
): SupplyBucket[] {
  const buckets: SupplyBucket[] = [];

  // `ignoreStock` empties the shelves for the what-if; the order book below
  // is untouched by it, because placed orders arrive either way.
  if (!options.ignoreStock) {
    for (const lot of db.lots) {
      if (lot.itemId !== item.id || lot.qty <= 0) continue;
      buckets.push({
        qty: lot.qty,
        // A lot booked in for a future date has not arrived yet, so it is no
        // more available today than an open delivery is. Almost every lot is
        // dated in the past, where this bound is simply inert.
        from: lot.receivedOn,
        kind: 'stock',
        ...(lot.expiresOn ? { until: lot.expiresOn } : {}),
      });
    }
  }

  // Inbound supply is perishable too. A delivery that lands on Tuesday with a
  // two-day shelf life becomes a lot expiring Thursday, so it is not supply for
  // Saturday — the window has to be closed at both ends, not just opened.
  const spoilsOn = (arrival: IsoDate): IsoDate | undefined =>
    item.shelfLifeDays === undefined ? undefined : addDays(arrival, item.shelfLifeDays);

  for (const order of db.purchaseOrders) {
    if (order.status !== 'open') continue;
    for (const line of order.lines) {
      if (line.itemId !== item.id) continue;
      // Inbound quantity comes from the terms recorded on the order, exactly
      // as the receipt will book it in — the live master is only a fallback
      // for orders saved before lines carried their own pack terms.
      const packQty = line.packQty ?? item.purchase?.packQty;
      const packUom = line.packUom ?? item.purchase?.packUom;
      if (packQty === undefined || packUom === undefined) continue;
      // An overdue delivery lands today at the earliest, and its shelf life
      // runs from the day it actually arrives — the same re-dating firm
      // production gets. On the historical dates a late perishable delivery
      // looked spoiled in transit and was ordered again.
      const lands = maxDate(asOf, order.expectedOn);
      const until = spoilsOn(lands);
      buckets.push({
        qty: convert(line.packs * packQty, packUom, item.stockUom, conversionContext(item)),
        from: lands,
        ...(until ? { until } : {}),
        kind: 'order',
      });
    }
  }

  for (const order of firmOrders) {
    // An overdue order is executed today, not on its historical due date —
    // the prep schedule already re-dates it — so its output exists from
    // today and keeps from today. Left on the old dates, a perishable
    // overdue batch looked spoiled-before-needed and the same quantity was
    // planned a second time while the order still sat open.
    const lands = maxDate(asOf, order.dueOn);
    const until = spoilsOn(lands);
    buckets.push({ qty: order.qty, from: lands, ...(until ? { until } : {}), kind: 'order' });
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
  readonly sources: readonly string[];
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
      shortfalls.push({ qty: remaining, dueOn: requirement.dueOn, sources: requirement.sources });
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
 * than quietly printing an impossible date. The constraint cuts both ways:
 * a trip can also be too *early* — salad bought at Wednesday's market is
 * compost by Saturday's dinner — so an open day only counts if the food
 * would still be good when it is wanted.
 */
function schedulePurchase(
  db: Database,
  item: Item,
  neededOn: IsoDate,
  asOf: IsoDate,
): { orderBy: IsoDate; late: boolean; spoils?: boolean } {
  const leadTime = item.purchase?.leadTimeDays ?? 0;
  const latest = addDays(neededOn, -leadTime);
  const supplier = item.purchase ? findSupplier(db, item.purchase.supplierId) : undefined;
  const openOn = supplier?.deliveryDays;

  if (!openOn || openOn.length === 0) {
    // Unconstrained suppliers are visited as late as possible, so the arrival
    // is never earlier than the need and freshness cannot be the problem.
    return { orderBy: maxDate(asOf, latest), late: latest < asOf };
  }

  const keepsUntilNeeded = (tripDay: IsoDate): boolean =>
    item.shelfLifeDays === undefined ||
    daysBetween(addDays(tripDay, leadTime), neededOn) <= item.shelfLifeDays;

  // Walk back from the last useful day to today, looking for an open day.
  for (let date = latest; date >= asOf; date = addDays(date, -1)) {
    if (!openOn.includes(weekdayIndex(date))) continue;
    if (keepsUntilNeeded(date)) return { orderBy: date, late: false };
    // Walking further back only lands the food earlier and staler. This open
    // day is the best real option; commit to it, but say what it costs.
    return { orderBy: date, late: true, spoils: true };
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
    // An order whose cooking *starts* inside the window belongs to this run
    // even when it finishes beyond it — the mince still has to be bought this
    // week. Filtering on dueOn dropped exactly those straddlers, and their
    // ingredients with them. The output side needs no special case: the
    // supply bucket opens at `dueOn`, so a straddler supplies nothing to any
    // demand that falls inside this horizon.
    (order) => order.status === 'open' && order.itemId === itemId && order.startOn <= until,
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
  onMissing?: (recipeName: string, componentId: ItemId) => void,
): void {
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  if (!recipe) return;

  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  const batches = batchQty === 0 ? 0 : qty / batchQty;

  for (const component of recipe.components) {
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child) {
      // Planning around the hole would print a confident shopping list
      // that is missing an ingredient production will refuse to cook
      // without. Say so, and keep planning everything else.
      onMissing?.(item.name, component.itemId);
      continue;
    }

    const scaled = component.scalable === false ? component.qty : component.qty * batches;
    const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
    const gross = component.lossPct ? net / (1 - component.lossPct) : net;

    // Every source, not just the first: a run that serves Tuesday's lasagne
    // and Thursday's leftovers must peg its mince to both, or the shopping
    // list's "what is this for?" answer silently loses meals.
    addDemand({
      itemId: child.id,
      qty: gross,
      dueOn,
      sources: pegging.length > 0 ? pegging : [itemId],
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
  // A run with data problems planned around holes — a recipe referencing a
  // deleted item, an unsourceable requirement. Firming it would persist
  // orders executeOrder refuses to cook, which then count as supply and
  // suppress replanning of the very dish that is broken. Fix the data, run
  // again, then commit.
  if (result.problems.length > 0) {
    throw new MiseError(
      `Cannot commit a plan with data problems:\n  - ${result.problems.join('\n  - ')}`,
    );
  }
  const created: ProductionOrder[] = [];
  for (const planned of result.production) {
    const order: ProductionOrder = {
      id: nextId('PRD', [...db.productionOrders, ...created]),
      itemId: planned.itemId,
      qty: planned.qty,
      dueOn: planned.dueOn,
      startOn: planned.startOn,
      status: 'open',
      // The plan's optional policy travels with the commitment, so later
      // runs and the eventual execution cook the batch that was planned.
      includeOptional: result.includeOptional,
      ...(planned.pegging[0] ? { pegging: planned.pegging[0] } : {}),
    };
    created.push(order);
    db.productionOrders.push(order);
  }
  return created;
}
