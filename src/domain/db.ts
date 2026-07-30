/** Database construction, lookup helpers and integrity validation. */

import { NotFoundError, ValidationError } from './errors.js';
import { canConvert, dimensionOf, isUomCode, type ConversionContext, type UomCode } from './units.js';
import type {
  Database,
  Item,
  ItemId,
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
  const seenItemIds = new Set<ItemId>();

  for (const item of db.items) {
    if (seenItemIds.has(item.id)) issues.push(`Duplicate item id "${item.id}".`);
    seenItemIds.add(item.id);

    if (!isUomCode(item.stockUom)) {
      issues.push(`Item "${item.id}" has unknown stock unit "${item.stockUom}".`);
      continue;
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
  for (const recipe of db.recipes) {
    if (seenRecipeIds.has(recipe.id)) issues.push(`Duplicate recipe id "${recipe.id}".`);
    seenRecipeIds.add(recipe.id);

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

  for (const lot of db.lots) {
    if (!findItem(db, lot.itemId)) issues.push(`Lot "${lot.id}" references unknown item "${lot.itemId}".`);
    if (lot.qty < 0) issues.push(`Lot "${lot.id}" has a negative quantity.`);
  }
  for (const entry of db.mealPlan) {
    if (!findItem(db, entry.itemId)) {
      issues.push(`Meal plan entry "${entry.id}" references unknown item "${entry.itemId}".`);
    }
    if (entry.servings <= 0) issues.push(`Meal plan entry "${entry.id}" has non-positive servings.`);
  }

  return issues;
}

export function assertValid(db: Database): void {
  const issues = validate(db);
  if (issues.length > 0) throw new ValidationError(issues);
}
