/** Database construction, lookup helpers and integrity validation. */

import { NotFoundError, ValidationError } from './errors.js';
import { canConvert, dimensionOf, isUomCode, type ConversionContext, type UomCode } from './units.js';
import { isIsoDate } from './date.js';
import { MEAL_SLOTS } from './types.js';
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
  const seenSupplierIds = new Set<SupplierId>();
  for (const supplier of db.suppliers) {
    if (seenSupplierIds.has(supplier.id)) issues.push(`Duplicate supplier id "${supplier.id}".`);
    seenSupplierIds.add(supplier.id);
  }

  const seenItemIds = new Set<ItemId>();

  for (const item of db.items) {
    if (seenItemIds.has(item.id)) issues.push(`Duplicate item id "${item.id}".`);
    seenItemIds.add(item.id);

    if (!isUomCode(item.stockUom)) {
      issues.push(`Item "${item.id}" has unknown stock unit "${item.stockUom}".`);
      continue;
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
    if (item.sourcing === 'purchased' && !item.purchase) {
      issues.push(`Purchased item "${item.id}" has no purchase info (supplier, pack, price).`);
    }
    if (item.purchase) {
      const { packUom, packQty, packPrice, supplierId } = item.purchase;
      if (!isUomCode(packUom)) {
        issues.push(`Item "${item.id}" has unknown pack unit "${packUom}".`);
      } else if (!canConvert(packUom, item.stockUom, conversionContext(item))) {
        issues.push(
          `Item "${item.id}" buys in ${packUom} (${dimensionOf(packUom)}) but stocks in ` +
            `${item.stockUom} (${dimensionOf(item.stockUom)}), and no density/unit weight bridges them.`,
        );
      }
      if (packQty <= 0) issues.push(`Item "${item.id}" has a non-positive pack quantity.`);
      if (packPrice < 0) issues.push(`Item "${item.id}" has a negative pack price.`);
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
    if (recipe.yieldQty <= 0) issues.push(`Recipe "${recipe.id}" has a non-positive yield.`);
    if (recipe.servings <= 0) issues.push(`Recipe "${recipe.id}" has a non-positive serving count.`);
    if (!canConvert(recipe.yieldUom as UomCode, output.stockUom, conversionContext(output))) {
      issues.push(
        `Recipe "${recipe.id}" yields ${recipe.yieldUom} but "${output.id}" stocks in ` +
          `${output.stockUom}, and no conversion bridges them.`,
      );
    }
    if (recipe.massYield !== undefined && (recipe.massYield <= 0 || recipe.massYield > 1.5)) {
      issues.push(`Recipe "${recipe.id}" has an implausible massYield of ${recipe.massYield}.`);
    }
    if (recipe.components.length === 0) {
      issues.push(`Recipe "${recipe.id}" has no components.`);
    }

    for (const component of recipe.components) {
      const child = findItem(db, component.itemId);
      if (!child) {
        issues.push(`Recipe "${recipe.id}" references unknown item "${component.itemId}".`);
        continue;
      }
      if (component.qty < 0) {
        issues.push(`Recipe "${recipe.id}" has a negative quantity of "${component.itemId}".`);
      }
      if (!canConvert(component.uom, child.stockUom, conversionContext(child))) {
        issues.push(
          `Recipe "${recipe.id}" calls for ${component.uom} of "${child.id}" which stocks in ` +
            `${child.stockUom}; add densityGPerMl or unitWeightG to "${child.id}".`,
        );
      }
      if (component.lossPct !== undefined && (component.lossPct < 0 || component.lossPct >= 1)) {
        issues.push(`Recipe "${recipe.id}" has an out-of-range lossPct for "${component.itemId}".`);
      }
    }
  }

  // Dates are compared as strings throughout the engine, so a value that is
  // not a real ISO date — "tomorrow", "2026-02-30" — sorts and schedules as
  // nonsense while formatting may show a different calendar day entirely.
  for (const lot of db.lots) {
    if (!findItem(db, lot.itemId)) issues.push(`Lot "${lot.id}" references unknown item "${lot.itemId}".`);
    if (lot.qty < 0) issues.push(`Lot "${lot.id}" has a negative quantity.`);
    if (!isIsoDate(lot.receivedOn)) {
      issues.push(`Lot "${lot.id}" has an invalid receivedOn date "${lot.receivedOn}".`);
    }
    if (lot.expiresOn !== undefined && !isIsoDate(lot.expiresOn)) {
      issues.push(`Lot "${lot.id}" has an invalid expiresOn date "${lot.expiresOn}".`);
    }
  }
  for (const entry of db.mealPlan) {
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
    if (entry.servings <= 0) issues.push(`Meal plan entry "${entry.id}" has non-positive servings.`);
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
  }

  // The order book holds references too. A deleted item inside an open
  // order makes the receipt throw at mustItem — an order that can never be
  // received, in a database doctor called valid.
  for (const order of db.purchaseOrders) {
    if (!findSupplier(db, order.supplierId)) {
      issues.push(`Purchase order "${order.id}" references unknown supplier "${order.supplierId}".`);
    }
    for (const line of order.lines) {
      if (!findItem(db, line.itemId)) {
        issues.push(`Purchase order "${order.id}" has a line for unknown item "${line.itemId}".`);
      }
    }
  }
  for (const order of db.productionOrders) {
    if (!findItem(db, order.itemId)) {
      issues.push(`Production order "${order.id}" references unknown item "${order.itemId}".`);
    }
  }

  return issues;
}

export function assertValid(db: Database): void {
  const issues = validate(db);
  if (issues.length > 0) throw new ValidationError(issues);
}
