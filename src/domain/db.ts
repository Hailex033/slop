/** Database construction, lookup helpers and integrity validation. */

import { NotFoundError, ValidationError } from './errors.js';
import { canConvert, dimensionOf, isUomCode, type ConversionContext, type UomCode } from './units.js';
import { isIsoDate } from './date.js';
import { MEAL_SLOTS, ORDER_STATUSES, SOURCINGS } from './types.js';
import type {
  Database,
  Item,
  ItemId,
  MealPlanEntry,
  Recipe,
  Settings,
  Supplier,
  SupplierId,
} from './types.js';

export const DEFAULT_SETTINGS: Settings = {
  currency: 'GBP',
  household: [{ name: 'You', appetite: 1 }],
  overheadPerHour: 0,
  planningHorizonDays: 7,
};

export function emptyDb(settings: Partial<Settings> = {}): Database {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    items: [],
    recipes: [],
    suppliers: [],
    lots: [],
    ledger: [],
    mealPlan: [],
    purchaseOrders: [],
    productionOrders: [],
  };
}

/**
 * Lookup indexes. Built lazily and cached per database object so that the hot
 * paths (explosion, MRP) do not run linear scans inside their recursion.
 */
interface Indexes {
  itemsById: Map<ItemId, Item>;
  recipesByOutput: Map<ItemId, Recipe>;
  suppliersById: Map<SupplierId, Supplier>;
  /** itemId -> recipes that consume it directly. Powers where-used. */
  usedBy: Map<ItemId, Recipe[]>;
}

interface CacheEntry {
  items: readonly Item[];
  recipes: readonly Recipe[];
  suppliers: readonly Supplier[];
  lengths: string;
  indexes: Indexes;
}

const INDEX_CACHE = new WeakMap<Database, CacheEntry>();

/**
 * The cache is only valid while the collections are the same arrays *and* the
 * same length. Identity catches wholesale reassignment (`db.items = db.items
 * .map(...)`); length catches push and splice. Mutating a field on an item
 * already in the index needs neither, because the index stores references.
 */
function isFresh(cached: CacheEntry, db: Database): boolean {
  return (
    cached.items === db.items &&
    cached.recipes === db.recipes &&
    cached.suppliers === db.suppliers &&
    cached.lengths === lengthsOf(db)
  );
}

function lengthsOf(db: Database): string {
  return `${db.items.length}:${db.recipes.length}:${db.suppliers.length}`;
}

function buildIndexes(db: Database): Indexes {
  const itemsById = new Map<ItemId, Item>();
  for (const item of db.items) itemsById.set(item.id, item);

  const recipesByOutput = new Map<ItemId, Recipe>();
  const usedBy = new Map<ItemId, Recipe[]>();
  for (const recipe of db.recipes) {
    recipesByOutput.set(recipe.outputItemId, recipe);
    for (const component of recipe.components) {
      const list = usedBy.get(component.itemId);
      if (list) list.push(recipe);
      else usedBy.set(component.itemId, [recipe]);
    }
  }

  const suppliersById = new Map<SupplierId, Supplier>();
  for (const supplier of db.suppliers) suppliersById.set(supplier.id, supplier);

  return { itemsById, recipesByOutput, suppliersById, usedBy };
}

export function indexes(db: Database): Indexes {
  const cached = INDEX_CACHE.get(db);
  if (cached && isFresh(cached, db)) return cached.indexes;
  const built = buildIndexes(db);
  INDEX_CACHE.set(db, {
    items: db.items,
    recipes: db.recipes,
    suppliers: db.suppliers,
    lengths: lengthsOf(db),
    indexes: built,
  });
  return built;
}

/** Call after mutating items/recipes/suppliers in place. */
export function invalidateIndexes(db: Database): void {
  INDEX_CACHE.delete(db);
}

export function findItem(db: Database, id: ItemId): Item | undefined {
  return indexes(db).itemsById.get(id);
}

export function mustItem(db: Database, id: ItemId): Item {
  const item = findItem(db, id);
  if (!item) throw new NotFoundError('item', id);
  return item;
}

export function recipeFor(db: Database, itemId: ItemId): Recipe | undefined {
  return indexes(db).recipesByOutput.get(itemId);
}

export function mustRecipe(db: Database, itemId: ItemId): Recipe {
  const recipe = recipeFor(db, itemId);
  if (!recipe) throw new NotFoundError('recipe for item', itemId);
  return recipe;
}

export function findSupplier(db: Database, id: SupplierId): Supplier | undefined {
  return indexes(db).suppliersById.get(id);
}

/** Recipes that directly consume `itemId`. */
export function directParents(db: Database, itemId: ItemId): readonly Recipe[] {
  return indexes(db).usedBy.get(itemId) ?? [];
}

/**
 * Merge a parsed, possibly partial database onto the defaults, so a file or
 * localStorage blob written by an older version still loads with every
 * collection present. Settings merge *after* the top-level spread: spreading
 * the partial last would put its incomplete settings object back over the
 * defaults and hand undefined horizons and households to the planner. Both
 * loaders — the CLI's file store and the browser's localStorage — go
 * through here, so neither can drift.
 */
export function normalizeDb(parsed: Partial<Database>): Database {
  const base = emptyDb();
  const merged = {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings ?? {}) },
  } as Database;
  // An earlier schema pegged an order to a single source string; lift it
  // into today's list so those files keep loading with their trail intact.
  merged.productionOrders = merged.productionOrders.map((order) => {
    const peg = (order as { pegging?: unknown }).pegging;
    return typeof peg === 'string' ? { ...order, pegging: [peg] } : order;
  });
  return merged;
}

/**
 * Portions of a plan entry not yet served.
 *
 * `servedOn` with no quantity — data written before `servedServings`
 * existed, or a hand edit — means fully served: the completion marker must
 * not be quietly outvoted by a missing number, or planning re-buys meals
 * already recorded as eaten.
 */
export function remainingServings(entry: MealPlanEntry): number {
  const served = entry.servedServings ?? (entry.servedOn ? entry.servings : 0);
  return entry.servings - served;
}

/** True when the item has a recipe and should be expanded rather than bought. */
export function isMade(item: Item): boolean {
  return item.sourcing === 'manufactured' || item.sourcing === 'phantom';
}

/** Phantoms are never stocked: explosion passes straight through them. */
export function isStocked(item: Item): boolean {
  return item.sourcing !== 'phantom';
}

/** The coefficients this item contributes to unit conversion. */
export function conversionContext(item: Item): ConversionContext {
  const ctx: ConversionContext = { label: item.name };
  return {
    ...ctx,
    ...(item.densityGPerMl !== undefined ? { densityGPerMl: item.densityGPerMl } : {}),
    ...(item.unitWeightG !== undefined ? { unitWeightG: item.unitWeightG } : {}),
    ...(item.unitVolumeMl !== undefined ? { unitVolumeMl: item.unitVolumeMl } : {}),
  };
}

/**
 * Resolve a human reference — an id, an exact name, or a unique
 * case-insensitive prefix/substring of a name — to a single item.
 */
export function resolveItem(db: Database, ref: string): Item {
  const direct = findItem(db, ref);
  if (direct) return direct;

  const needle = ref.trim().toLowerCase();
  const exact = db.items.filter((i) => i.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;

  const slug = needle.replace(/[\s_]+/g, '-');
  const byId = db.items.filter((i) => i.id.toLowerCase() === slug);
  if (byId.length === 1) return byId[0]!;

  const partial = db.items.filter(
    (i) => i.name.toLowerCase().includes(needle) || i.id.toLowerCase().includes(slug),
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    const names = partial.slice(0, 8).map((i) => `${i.id} (${i.name})`).join(', ');
    throw new NotFoundError(
      'unambiguous item',
      `${ref}" — matches ${partial.length}: ${names}${partial.length > 8 ? ', ...' : ''}`,
    );
  }
  throw new NotFoundError('item', ref);
}

/** Default servings for the household, from the sum of appetites. */
export function householdServings(db: Database): number {
  const total = db.settings.household.reduce((sum, m) => sum + m.appetite, 0);
  return Math.max(1, Math.round(total * 10) / 10);
}

/**
 * Structural integrity check. Deliberately separate from explosion so that a
 * half-finished database still loads and can be inspected; `mise doctor`
 * surfaces the issues instead of the engine crashing on them.
 */
export function validate(db: Database): string[] {
  const issues: string[] = [];

  // The supplier index keeps one entry per id, so a silent duplicate means
  // purchase names and delivery-day scheduling depend on array order.
  // Settings feed defaults and rates everywhere, so a mangled number here
  // surfaces far from its cause — null servings on a saved plan entry, NaN
  // in every cost. (A zero appetite eats nothing and harms nothing.)
  for (const member of db.settings.household) {
    if (!Number.isFinite(member.appetite) || member.appetite < 0) {
      issues.push(`Household member "${member.name}" has an invalid appetite of ${member.appetite}.`);
    }
  }
  if (!Number.isFinite(db.settings.overheadPerHour) || db.settings.overheadPerHour < 0) {
    issues.push(`Settings overheadPerHour is invalid (${db.settings.overheadPerHour}).`);
  }
  if (!Number.isInteger(db.settings.planningHorizonDays) || db.settings.planningHorizonDays < 1) {
    issues.push(`Settings planningHorizonDays is invalid (${db.settings.planningHorizonDays}).`);
  }

  const seenSupplierIds = new Set<SupplierId>();
  for (const supplier of db.suppliers) {
    if (seenSupplierIds.has(supplier.id)) issues.push(`Duplicate supplier id "${supplier.id}".`);
    seenSupplierIds.add(supplier.id);
    if (!Number.isFinite(supplier.leadTimeDays) || supplier.leadTimeDays < 0) {
      issues.push(`Supplier "${supplier.id}" has an invalid leadTimeDays of ${supplier.leadTimeDays}.`);
    }
    // A delivery day outside 0-6 can never match a real weekday: every
    // requirement from the supplier reports late and no order commits,
    // even though an ordinary shopping day was intended.
    for (const day of supplier.deliveryDays ?? []) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        issues.push(`Supplier "${supplier.id}" has an invalid delivery day ${day} (weekdays are 0-6).`);
      }
    }
  }

  const seenItemIds = new Set<ItemId>();

  for (const item of db.items) {
    if (seenItemIds.has(item.id)) issues.push(`Duplicate item id "${item.id}".`);
    seenItemIds.add(item.id);

    if (!isUomCode(item.stockUom)) {
      issues.push(`Item "${item.id}" has unknown stock unit "${item.stockUom}".`);
      continue;
    }
    // Every make-or-buy decision switches on the three known sourcings, and
    // a typo'd one ("manufactued") matches none of them: isMade() says buy,
    // isStocked() says net, and MRP routes a recipe-backed shortage to
    // purchasing — a spurious missing supplier, or worse, a stale purchase
    // record buying the finished dish.
    if (!(SOURCINGS as readonly string[]).includes(item.sourcing)) {
      issues.push(`Item "${item.id}" has unknown sourcing "${item.sourcing}".`);
    }
    // Conversion coefficients must be positive and finite: a negative
    // density converts a recipe line into a negative requirement, which the
    // whole engine reads as "needs nothing" — a dish planned and cooked
    // without one of its ingredients.
    for (const [field, value] of [
      ['densityGPerMl', item.densityGPerMl],
      ['unitWeightG', item.unitWeightG],
      ['unitVolumeMl', item.unitVolumeMl],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        issues.push(`Item "${item.id}" has a non-positive ${field} of ${value}.`);
      }
    }
    // A negative shelf life expires food before it arrives; a negative
    // safety stock is a floor below empty. Both poison every keeping and
    // netting window they touch. (Zero is fine for each: use-today food,
    // and no buffer.)
    if (item.shelfLifeDays !== undefined && (!Number.isFinite(item.shelfLifeDays) || item.shelfLifeDays < 0)) {
      issues.push(`Item "${item.id}" has an invalid shelfLifeDays of ${item.shelfLifeDays}.`);
    }
    if (item.safetyStock !== undefined && (!Number.isFinite(item.safetyStock) || item.safetyStock < 0)) {
      issues.push(`Item "${item.id}" has an invalid safetyStock of ${item.safetyStock}.`);
    }
    // NaN arithmetic is quiet: one "oops" kcal renders NaN calories on
    // every dish containing the item, in a database doctor approved.
    if (item.nutrientsPer100g) {
      for (const [field, value, required] of [
        ['kcal', item.nutrientsPer100g.kcal, true],
        ['proteinG', item.nutrientsPer100g.proteinG, true],
        ['fatG', item.nutrientsPer100g.fatG, true],
        ['carbG', item.nutrientsPer100g.carbG, true],
        ['satFatG', item.nutrientsPer100g.satFatG, false],
        ['sugarG', item.nutrientsPer100g.sugarG, false],
        ['fibreG', item.nutrientsPer100g.fibreG, false],
        ['sodiumMg', item.nutrientsPer100g.sodiumMg, false],
      ] as const) {
        if (value === undefined) {
          if (required) issues.push(`Item "${item.id}" is missing nutrient ${field} (per 100 g).`);
        } else if (!Number.isFinite(value) || value < 0) {
          issues.push(`Item "${item.id}" has an invalid nutrient ${field} of ${value}.`);
        }
      }
    }
    if (item.sourcing === 'purchased' && !item.purchase) {
      issues.push(`Purchased item "${item.id}" has no purchase info (supplier, pack, price).`);
    }
    if (item.purchase) {
      const { packUom, packQty, packPrice, supplierId, leadTimeDays } = item.purchase;
      if (!isUomCode(packUom)) {
        issues.push(`Item "${item.id}" has unknown pack unit "${packUom}".`);
      } else if (!canConvert(packUom, item.stockUom, conversionContext(item))) {
        issues.push(
          `Item "${item.id}" buys in ${packUom} (${dimensionOf(packUom)}) but stocks in ` +
            `${item.stockUom} (${dimensionOf(item.stockUom)}), and no density/unit weight bridges them.`,
        );
      }
      // 1e309 is valid JSON and Infinity in memory: packsFor would round
      // the shortage to zero packs and the commit would silently skip it.
      if (!Number.isFinite(packQty) || packQty <= 0) {
        issues.push(`Item "${item.id}" has an invalid packQty of ${packQty}.`);
      }
      // `null < 0` is false: an unpriced-by-accident item would coerce to
      // zero in every cost, and shop --commit would snapshot free orders.
      if (!Number.isFinite(packPrice) || packPrice < 0) {
        issues.push(`Item "${item.id}" has an invalid packPrice of ${packPrice}.`);
      }
      // A negative lead time schedules the shop *after* the food is needed,
      // and the committed order arrives before it was placed.
      if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) {
        issues.push(`Item "${item.id}" has an invalid leadTimeDays of ${leadTimeDays}.`);
      }
      // A mangled MOQ reaches Math.max in pack rounding as NaN, the commit
      // guard misses it, and the order serialises its packs as null.
      if (
        item.purchase.moqPacks !== undefined &&
        (!Number.isInteger(item.purchase.moqPacks) || item.purchase.moqPacks < 0)
      ) {
        issues.push(`Item "${item.id}" has an invalid moqPacks of ${item.purchase.moqPacks}.`);
      }
      if (!findSupplier(db, supplierId)) {
        issues.push(`Item "${item.id}" references unknown supplier "${supplierId}".`);
      }
    }
    if (isMade(item) && !recipeFor(db, item.id)) {
      issues.push(`Item "${item.id}" is ${item.sourcing} but has no recipe.`);
    }
    if (item.sourcing === 'purchased' && recipeFor(db, item.id)) {
      issues.push(`Item "${item.id}" is purchased but also has a recipe; it will never be expanded.`);
    }
  }

  const seenRecipeIds = new Set<string>();
  const seenOutputs = new Set<ItemId>();
  for (const recipe of db.recipes) {
    if (seenRecipeIds.has(recipe.id)) issues.push(`Duplicate recipe id "${recipe.id}".`);
    seenRecipeIds.add(recipe.id);
    // The recipe index keeps exactly one recipe per output item, so a second
    // one silently loses — and every explosion, costing and plan would then
    // depend on array order while doctor called the database valid.
    if (seenOutputs.has(recipe.outputItemId)) {
      issues.push(
        `Item "${recipe.outputItemId}" has more than one recipe ` +
          `("${recipe.id}" among them); only one would ever be used.`,
      );
    }
    seenOutputs.add(recipe.outputItemId);

    const output = findItem(db, recipe.outputItemId);
    if (!output) {
      issues.push(`Recipe "${recipe.id}" produces unknown item "${recipe.outputItemId}".`);
      continue;
    }
    // NaN slips through every ordered comparison — `NaN <= 0` is false — so
    // each numeric check here starts from finiteness.
    if (!Number.isFinite(recipe.yieldQty) || recipe.yieldQty <= 0) {
      issues.push(`Recipe "${recipe.id}" has an invalid yield of ${recipe.yieldQty}.`);
    }
    if (!Number.isFinite(recipe.servings) || recipe.servings <= 0) {
      issues.push(`Recipe "${recipe.id}" has an invalid serving count of ${recipe.servings}.`);
    }
    if (!canConvert(recipe.yieldUom as UomCode, output.stockUom, conversionContext(output))) {
      issues.push(
        `Recipe "${recipe.id}" yields ${recipe.yieldUom} but "${output.id}" stocks in ` +
          `${output.stockUom}, and no conversion bridges them.`,
      );
    }
    if (
      recipe.massYield !== undefined &&
      (!Number.isFinite(recipe.massYield) || recipe.massYield <= 0 || recipe.massYield > 1.5)
    ) {
      issues.push(`Recipe "${recipe.id}" has an implausible massYield of ${recipe.massYield}.`);
    }
    if (recipe.components.length === 0) {
      issues.push(`Recipe "${recipe.id}" has no components.`);
    }
    // Step durations feed straight into backward scheduling: a negative
    // minute starts a long recipe too late, and NaN poisons the dates.
    for (const step of recipe.steps ?? []) {
      for (const [field, value] of [
        ['activeMin', step.activeMin],
        ['passiveMin', step.passiveMin],
      ] as const) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          issues.push(`Recipe "${recipe.id}" has a step with an invalid ${field} of ${value}.`);
        }
      }
    }

    for (const component of recipe.components) {
      const child = findItem(db, component.itemId);
      if (!child) {
        issues.push(`Recipe "${recipe.id}" references unknown item "${component.itemId}".`);
        continue;
      }
      if (!Number.isFinite(component.qty) || component.qty < 0) {
        // Production would convert this to NaN, issue a NaN off the lots,
        // and still book the dish with a NaN cost — all without a shortage.
        issues.push(`Recipe "${recipe.id}" has an invalid quantity (${component.qty}) of "${component.itemId}".`);
      }
      if (!canConvert(component.uom, child.stockUom, conversionContext(child))) {
        issues.push(
          `Recipe "${recipe.id}" calls for ${component.uom} of "${child.id}" which stocks in ` +
            `${child.stockUom}; add densityGPerMl or unitWeightG to "${child.id}".`,
        );
      }
      if (
        component.lossPct !== undefined &&
        (!Number.isFinite(component.lossPct) || component.lossPct < 0 || component.lossPct >= 1)
      ) {
        issues.push(`Recipe "${recipe.id}" has an out-of-range lossPct for "${component.itemId}".`);
      }
    }
  }

  // Dates are compared as strings throughout the engine, so a value that is
  // not a real ISO date — "tomorrow", "2026-02-30" — sorts and schedules as
  // nonsense while formatting may show a different calendar day entirely.
  // Everything looked up or referenced by id must have exactly one owner of
  // that id: `.find()` only ever reaches the first, leaving its twin
  // unreachable, and shared ids make ledger origins and pegs ambiguous.
  const seenLotIds = new Set<string>();
  for (const lot of db.lots) {
    if (seenLotIds.has(lot.id)) issues.push(`Duplicate lot id "${lot.id}".`);
    seenLotIds.add(lot.id);
    if (!findItem(db, lot.itemId)) issues.push(`Lot "${lot.id}" references unknown item "${lot.itemId}".`);
    // MRP feeds this straight into Math.min: a NaN quantity silently turns
    // the remaining requirement into NaN, and no shortfall is ever emitted.
    if (!Number.isFinite(lot.qty) || lot.qty < 0) {
      issues.push(`Lot "${lot.id}" has an invalid quantity (${lot.qty}).`);
    }
    // The same rule receive enforces: a negative or non-finite cost turns
    // the pantry valuation, and every meal drawing on the lot, into nonsense.
    if (lot.unitCost !== undefined && (!Number.isFinite(lot.unitCost) || lot.unitCost < 0)) {
      issues.push(`Lot "${lot.id}" has an invalid unitCost of ${lot.unitCost}.`);
    }
    if (!isIsoDate(lot.receivedOn)) {
      issues.push(`Lot "${lot.id}" has an invalid receivedOn date "${lot.receivedOn}".`);
    }
    if (lot.expiresOn !== undefined && !isIsoDate(lot.expiresOn)) {
      issues.push(`Lot "${lot.id}" has an invalid expiresOn date "${lot.expiresOn}".`);
    }
  }
  const seenEntryIds = new Set<string>();
  for (const entry of db.mealPlan) {
    if (seenEntryIds.has(entry.id)) issues.push(`Duplicate meal plan entry id "${entry.id}".`);
    seenEntryIds.add(entry.id);
    const planned = findItem(db, entry.itemId);
    if (!planned) {
      issues.push(`Meal plan entry "${entry.id}" references unknown item "${entry.itemId}".`);
    } else if (planned.sourcing === 'phantom') {
      // A phantom is never stocked, so the entry can never be served: its
      // demand would out-live every shop and every cook, quietly poisoning
      // each planning run with a dinner that cannot happen.
      issues.push(
        `Meal plan entry "${entry.id}" plans "${planned.name}", a phantom — ` +
          `phantoms are made inline and cannot be served; plan a dish that uses it.`,
      );
    }
    // NaN slips the <= comparison, remainingServings turns NaN, and the
    // demand filter silently drops the meal — dinner vanishes from every
    // plan while doctor calls the file valid.
    if (!Number.isFinite(entry.servings) || entry.servings <= 0) {
      issues.push(`Meal plan entry "${entry.id}" has invalid servings of ${entry.servings}.`);
    }
    if (!MEAL_SLOTS.includes(entry.slot)) {
      issues.push(`Meal plan entry "${entry.id}" has unknown slot "${entry.slot}".`);
    }
    if (!isIsoDate(entry.date)) {
      issues.push(`Meal plan entry "${entry.id}" has an invalid date "${entry.date}".`);
    }
    // remainingServings turns a bad served count into phantom demand (below
    // zero) or a silent suppression (above the booking) — neither of which
    // is a real state of a dinner.
    if (
      entry.servedServings !== undefined &&
      (!Number.isFinite(entry.servedServings) ||
        entry.servedServings < 0 ||
        entry.servedServings > entry.servings + 1e-9)
    ) {
      issues.push(
        `Meal plan entry "${entry.id}" has an invalid servedServings of ` +
          `${entry.servedServings} (servings: ${entry.servings}).`,
      );
    }
    if (entry.servedOn !== undefined) {
      // Any truthy servedOn reads as "fully served" on legacy entries, so a
      // malformed one silently retires the dinner from every plan.
      if (!isIsoDate(entry.servedOn)) {
        issues.push(`Meal plan entry "${entry.id}" has an invalid servedOn date "${entry.servedOn}".`);
      } else if (entry.servedServings !== undefined && entry.servedServings < entry.servings - 1e-9) {
        // servedOn is the completion marker: paired with a partial count,
        // the plan display hides an entry MRP still plans the rest of.
        issues.push(
          `Meal plan entry "${entry.id}" is marked served on ${entry.servedOn} but only ` +
            `${entry.servedServings} of ${entry.servings} servings are recorded eaten.`,
        );
      }
    }
  }

  // The order book holds references too. A deleted item inside an open
  // order makes the receipt throw at mustItem — an order that can never be
  // received, in a database doctor called valid.
  const seenPoIds = new Set<string>();
  for (const order of db.purchaseOrders) {
    // receivePurchaseOrder resolves by `.find()`: a duplicate id leaves the
    // second commitment unreachable and its receipt impossible.
    if (seenPoIds.has(order.id)) issues.push(`Duplicate purchase order id "${order.id}".`);
    seenPoIds.add(order.id);
    if (!findSupplier(db, order.supplierId)) {
      issues.push(`Purchase order "${order.id}" references unknown supplier "${order.supplierId}".`);
    }
    // Order dates drive the netting windows; a malformed one silently
    // distorts every comparison it takes part in.
    if (!isIsoDate(order.orderedOn)) {
      issues.push(`Purchase order "${order.id}" has an invalid orderedOn date "${order.orderedOn}".`);
    }
    if (!isIsoDate(order.expectedOn)) {
      issues.push(`Purchase order "${order.id}" has an invalid expectedOn date "${order.expectedOn}".`);
    }
    if (isIsoDate(order.orderedOn) && isIsoDate(order.expectedOn) && order.expectedOn < order.orderedOn) {
      issues.push(
        `Purchase order "${order.id}" is expected on ${order.expectedOn}, before it was ordered (${order.orderedOn}).`,
      );
    }
    // An open order with nothing on it can never be received: the receipt
    // refuses to close a commitment with no lot or ledger evidence.
    if (order.status === 'open' && order.lines.length === 0) {
      issues.push(`Purchase order "${order.id}" has no lines.`);
    }
    // A mistyped status is invisible to MRP and prep — which select only
    // "open" and would plan duplicate supply — yet the receipt still
    // accepts it, since it rejects only received and cancelled.
    if (!(ORDER_STATUSES as readonly string[]).includes(order.status)) {
      issues.push(`Purchase order "${order.id}" has unknown status "${order.status}".`);
    }
    for (const line of order.lines) {
      if (!findItem(db, line.itemId)) {
        issues.push(`Purchase order "${order.id}" has a line for unknown item "${line.itemId}".`);
      }
      // A zero or negative line books nothing: receiving would either erase
      // the commitment or refuse — either way the data needs fixing first.
      if (!Number.isFinite(line.packs) || line.packs <= 0) {
        issues.push(`Purchase order "${order.id}" has a line with invalid packs (${line.packs}).`);
      }
      if (line.packQty !== undefined && (!Number.isFinite(line.packQty) || line.packQty <= 0)) {
        issues.push(`Purchase order "${order.id}" has a line with invalid packQty (${line.packQty}).`);
      }
      // Zero is a price; a negative one turns lots and meals negative.
      if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
        issues.push(`Purchase order "${order.id}" has a line with an invalid unitPrice (${line.unitPrice}).`);
      }
      // A snapshotted unit the engine cannot bridge makes runMrp throw on
      // the inbound supply and the receipt refuse to close the order.
      if (line.packUom !== undefined) {
        const lineItem = findItem(db, line.itemId);
        if (!isUomCode(line.packUom)) {
          issues.push(`Purchase order "${order.id}" has a line with unknown unit "${line.packUom}".`);
        } else if (lineItem && !canConvert(line.packUom, lineItem.stockUom, conversionContext(lineItem))) {
          issues.push(
            `Purchase order "${order.id}" line for "${lineItem.id}" is in ${line.packUom}, ` +
              `which does not convert to ${lineItem.stockUom}.`,
          );
        }
      }
    }
  }
  const seenPrdIds = new Set<string>();
  for (const order of db.productionOrders) {
    if (seenPrdIds.has(order.id)) issues.push(`Duplicate production order id "${order.id}".`);
    seenPrdIds.add(order.id);
    const target = findItem(db, order.itemId);
    if (!target) {
      issues.push(`Production order "${order.id}" references unknown item "${order.itemId}".`);
    } else if (target.sourcing !== 'manufactured') {
      // MRP would credit the order as inbound supply — suppressing the real
      // purchase or production — while execution can never complete it: a
      // purchased item has no recipe, and a phantom cannot enter stock.
      issues.push(
        `Production order "${order.id}" is for "${target.name}", which is ${target.sourcing} — ` +
          `only manufactured items are made.`,
      );
    }
    // A zero or negative batch cannot be cooked — produce refuses it — yet
    // MRP and prep would keep processing the commitment forever, in a
    // database doctor called valid.
    if (!Number.isFinite(order.qty) || order.qty <= 0) {
      issues.push(`Production order "${order.id}" has an invalid qty (${order.qty}).`);
    }
    if (!isIsoDate(order.dueOn)) {
      issues.push(`Production order "${order.id}" has an invalid dueOn date "${order.dueOn}".`);
    }
    if (!isIsoDate(order.startOn)) {
      issues.push(`Production order "${order.id}" has an invalid startOn date "${order.startOn}".`);
    }
    // MRP counts the output as supply from dueOn while prep schedules the
    // work at startOn: inverted, the supply exists before the batch could,
    // quietly suppressing the replacement production and purchasing.
    if (isIsoDate(order.dueOn) && isIsoDate(order.startOn) && order.startOn > order.dueOn) {
      issues.push(
        `Production order "${order.id}" starts on ${order.startOn}, after it is due (${order.dueOn}).`,
      );
    }
    if (!(ORDER_STATUSES as readonly string[]).includes(order.status)) {
      issues.push(`Production order "${order.id}" has unknown status "${order.status}".`);
    }
  }
  // History references items too. The ledger is read-only, so a hole here
  // cannot corrupt anything — but the report should render it by id rather
  // than abort, and doctor should say the master lost something the books
  // still mention.
  for (const txn of db.ledger) {
    if (!findItem(db, txn.itemId)) {
      issues.push(`Ledger entry "${txn.id}" references unknown item "${txn.itemId}".`);
    }
    // The audit trail is rendered and reconciled as numbers: a string qty
    // crashes the report's formatter mid-table, and NaN totals reconcile
    // nothing. Sign is meaningful — issues are negative — so only
    // finiteness is required.
    if (!Number.isFinite(txn.qty)) {
      issues.push(`Ledger entry "${txn.id}" has an invalid qty (${txn.qty}).`);
    }
  }

  return issues;
}

export function assertValid(db: Database): void {
  const issues = validate(db);
  if (issues.length > 0) throw new ValidationError(issues);
}
