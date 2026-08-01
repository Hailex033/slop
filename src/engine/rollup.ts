/**
 * Recursive rollups: cost, nutrition, allergens and time.
 *
 * Each of these is the same shape of computation as explosion, run bottom-up
 * instead of top-down: a made item's value is a function of its components'
 * values, all the way to the purchased leaves where the value is known. Costing
 * a lasagne means costing the béchamel, which means costing the roux, which
 * means knowing the price of a block of butter.
 *
 * Nutrition deliberately uses the *net* quantity rather than the gross: onion
 * peel is bought and paid for, but it is not eaten.
 */

import { conversionContext, findItem, isMade, mustItem, recipeFor } from '../domain/db.js';
import { MiseError } from '../domain/errors.js';
import { convert, type UomCode } from '../domain/units.js';
import type { Database, Item, ItemId, Nutrients, Recipe } from '../domain/types.js';

/**
 * Whether a rollup counts components marked `optional`.
 *
 * Defaults to **false**, matching `explode`, the shopping list and MRP: the
 * default view of a recipe is the one you would actually make, without the
 * garnish. Having the rollups default the other way meant the headline cost
 * and calories described a different dish from the tree printed under them.
 */
export interface RollupOptions {
  readonly includeOptional?: boolean;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface UnitCost {
  readonly itemId: ItemId;
  /** Cost of one stock unit of this item, materials only. */
  readonly materials: number;
  /** Energy/overhead absorbed by making it, per stock unit. */
  readonly overhead: number;
  readonly total: number;
  /** False when some purchased leaf below has no price. */
  readonly complete: boolean;
  /** Purchased items below here with no price attached. */
  readonly missing: readonly ItemId[];
}

/** Price of one stock unit of a purchased item, from its pack price. */
export function purchaseUnitCost(item: Item): number | undefined {
  if (!item.purchase) return undefined;
  const { packQty, packUom, packPrice } = item.purchase;
  const qtyInStockUom = convert(packQty, packUom, item.stockUom, conversionContext(item));
  return qtyInStockUom === 0 ? undefined : packPrice / qtyInStockUom;
}

/** Cost per stock unit, rolled recursively through every sub-recipe. */
export function rollupUnitCost(db: Database, itemId: ItemId, options: RollupOptions = {}): UnitCost {
  return unitCostInner(db, itemId, options.includeOptional === true, new Map(), new Set());
}

function unitCostInner(
  db: Database,
  itemId: ItemId,
  includeOptional: boolean,
  memo: Map<ItemId, UnitCost>,
  seen: ReadonlySet<ItemId>,
): UnitCost {
  const cached = memo.get(itemId);
  if (cached) return cached;

  const item = mustItem(db, itemId);
  const recipe = isMade(item) ? recipeFor(db, itemId) : undefined;

  if (!recipe || seen.has(itemId)) {
    const unit = purchaseUnitCost(item);
    const result: UnitCost = {
      itemId,
      materials: unit ?? 0,
      overhead: 0,
      total: unit ?? 0,
      complete: unit !== undefined,
      missing: unit === undefined ? [itemId] : [],
    };
    memo.set(itemId, result);
    return result;
  }

  const nextSeen = new Set(seen).add(itemId);
  let materialsPerBatch = 0;
  let overheadPerBatch = 0;
  const missing = new Set<ItemId>();
  let complete = true;

  for (const component of recipe.components) {
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child) {
      complete = false;
      missing.add(component.itemId);
      continue;
    }
    const childCost = unitCostInner(db, child.id, includeOptional, memo, nextSeen);
    if (!childCost.complete) {
      complete = false;
      for (const id of childCost.missing) missing.add(id);
    }
    const net = convert(component.qty, component.uom, child.stockUom, conversionContext(child));
    // You pay for what you buy, so cost uses the gross quantity including loss.
    const gross = component.lossPct ? net / (1 - component.lossPct) : net;
    // Keep the materials/overhead split intact as it propagates up the tree,
    // so a sub-recipe's energy cost is still reported as overhead at the top.
    materialsPerBatch += gross * childCost.materials;
    overheadPerBatch += gross * childCost.overhead;
  }

  const minutes = recipeMinutes(recipe);
  overheadPerBatch += ((minutes.active + minutes.passive) / 60) * db.settings.overheadPerHour;

  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  const perUnit = (value: number): number => (batchQty === 0 ? 0 : value / batchQty);

  const result: UnitCost = {
    itemId,
    materials: perUnit(materialsPerBatch),
    overhead: perUnit(overheadPerBatch),
    total: perUnit(materialsPerBatch + overheadPerBatch),
    complete,
    missing: [...missing],
  };
  memo.set(itemId, result);
  return result;
}

export interface CostLine {
  readonly itemId: ItemId;
  readonly name: string;
  readonly qty: number;
  readonly uom: UomCode;
  readonly unitCost: number;
  readonly cost: number;
  readonly share: number;
}

export interface CostReport {
  readonly itemId: ItemId;
  readonly qty: number;
  readonly uom: UomCode;
  readonly servings: number;
  readonly materials: number;
  readonly overhead: number;
  readonly total: number;
  readonly perServing: number;
  readonly complete: boolean;
  readonly missing: readonly ItemId[];
  /** Purchased leaves, biggest contributor first — where the money actually goes. */
  readonly lines: readonly CostLine[];
}

/**
 * Cost a specific quantity, with a leaf-level breakdown.
 *
 * The totals are derived from the same quantity-aware walk as the breakdown
 * rather than from scaling the per-unit rollup. That matters as soon as a
 * recipe has a `scalable: false` component: costing two batches must charge one
 * bay leaf, not two, and the headline figure has to agree with the lines under
 * it. `rollupUnitCost` remains the per-unit *standard* cost, which is a
 * linearisation and is used where a single rate is what's wanted.
 */
export function costOf(
  db: Database,
  itemId: ItemId,
  qty: number,
  uom?: UomCode,
  options: RollupOptions = {},
): CostReport {
  const includeOptional = options.includeOptional === true;
  const item = mustItem(db, itemId);
  if (qty < 0) throw new MiseError(`Cannot cost a negative quantity (${qty}) of "${item.name}".`);
  const inStock = convert(qty, uom ?? item.stockUom, item.stockUom, conversionContext(item));

  const leafTotals = new Map<ItemId, number>();
  const missing = new Set<ItemId>();
  let overhead = 0;

  const walk = (id: ItemId, quantity: number, seen: ReadonlySet<ItemId>): void => {
    // No food, no cost. Descending on a zero requirement would still charge
    // the `scalable: false` components, which do not shrink with the batch.
    if (quantity <= 1e-9) return;
    const current = mustItem(db, id);
    const recipe = isMade(current) && !seen.has(id) ? recipeFor(db, id) : undefined;
    if (!recipe) {
      leafTotals.set(id, (leafTotals.get(id) ?? 0) + quantity);
      if (purchaseUnitCost(current) === undefined) missing.add(id);
      return;
    }
    const nextSeen = new Set(seen).add(id);
    const batchQty = convert(
      recipe.yieldQty,
      recipe.yieldUom,
      current.stockUom,
      conversionContext(current),
    );
    const batches = batchQty === 0 ? 0 : quantity / batchQty;

    const time = recipeMinutes(recipe);
    overhead += ((time.active + time.passive) / 60) * db.settings.overheadPerHour * batches;

    for (const component of recipe.components) {
      if (component.optional && !includeOptional) continue;
      const child = findItem(db, component.itemId);
      if (!child) continue;
      const scaled = component.scalable === false ? component.qty : component.qty * batches;
      const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
      const gross = component.lossPct ? net / (1 - component.lossPct) : net;
      walk(child.id, gross, nextSeen);
    }
  };
  walk(itemId, inStock, new Set());

  const priced: CostLine[] = [...leafTotals.entries()]
    .map(([leafId, leafQty]) => {
      const leaf = mustItem(db, leafId);
      const leafUnitCost = purchaseUnitCost(leaf) ?? 0;
      return {
        itemId: leafId,
        name: leaf.name,
        qty: leafQty,
        uom: leaf.stockUom,
        unitCost: leafUnitCost,
        cost: leafUnitCost * leafQty,
        share: 0,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const materials = priced.reduce((sum, line) => sum + line.cost, 0);
  const total = materials + overhead;
  const lines: CostLine[] = priced.map((line) => ({
    ...line,
    share: total > 0 ? line.cost / total : 0,
  }));

  const recipe = recipeFor(db, itemId);
  const servings = recipe
    ? (inStock /
        convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item))) *
      recipe.servings
    : inStock;

  return {
    itemId,
    qty: inStock,
    uom: item.stockUom,
    servings,
    materials,
    overhead,
    total,
    perServing: servings > 0 ? total / servings : total,
    complete: missing.size === 0,
    missing: [...missing],
    lines,
  };
}

// ---------------------------------------------------------------------------
// Nutrition
// ---------------------------------------------------------------------------

const ZERO: Nutrients = { kcal: 0, proteinG: 0, fatG: 0, satFatG: 0, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 0 };

function addNutrients(a: Nutrients, b: Nutrients, factor: number): Nutrients {
  return {
    kcal: a.kcal + b.kcal * factor,
    proteinG: a.proteinG + b.proteinG * factor,
    fatG: a.fatG + b.fatG * factor,
    satFatG: (a.satFatG ?? 0) + (b.satFatG ?? 0) * factor,
    carbG: a.carbG + b.carbG * factor,
    sugarG: (a.sugarG ?? 0) + (b.sugarG ?? 0) * factor,
    fibreG: (a.fibreG ?? 0) + (b.fibreG ?? 0) * factor,
    sodiumMg: (a.sodiumMg ?? 0) + (b.sodiumMg ?? 0) * factor,
  };
}

export interface NutritionRollup {
  /** Absolute nutrients contained in one stock unit of the item. */
  readonly perStockUnit: Nutrients;
  /** Grams of edible output per stock unit, for per-100 g figures. */
  readonly gramsPerStockUnit: number;
  readonly complete: boolean;
  readonly missing: readonly ItemId[];
}

/** Grams of an item, if we can get there from its stock unit. */
function gramsOf(item: Item, qty: number): number | undefined {
  try {
    return convert(qty, item.stockUom, 'g', conversionContext(item));
  } catch {
    return undefined;
  }
}

export function rollupNutrition(
  db: Database,
  itemId: ItemId,
  options: RollupOptions = {},
): NutritionRollup {
  return nutritionInner(db, itemId, options.includeOptional === true, new Map(), new Set());
}

function nutritionInner(
  db: Database,
  itemId: ItemId,
  includeOptional: boolean,
  memo: Map<ItemId, NutritionRollup>,
  seen: ReadonlySet<ItemId>,
): NutritionRollup {
  const cached = memo.get(itemId);
  if (cached) return cached;

  const item = mustItem(db, itemId);
  const recipe = isMade(item) && !seen.has(itemId) ? recipeFor(db, itemId) : undefined;

  if (!recipe) {
    const grams = gramsOf(item, 1);
    const per100 = item.nutrientsPer100g;
    const result: NutritionRollup = {
      perStockUnit: per100 && grams !== undefined ? addNutrients(ZERO, per100, grams / 100) : ZERO,
      gramsPerStockUnit: grams ?? 0,
      complete: Boolean(per100) && grams !== undefined,
      missing: per100 && grams !== undefined ? [] : [itemId],
    };
    memo.set(itemId, result);
    return result;
  }

  const nextSeen = new Set(seen).add(itemId);
  let perBatch = ZERO;
  let inputGrams = 0;
  let complete = true;
  const missing = new Set<ItemId>();

  for (const component of recipe.components) {
    if (component.optional && !includeOptional) continue;
    const child = findItem(db, component.itemId);
    if (!child) continue;
    const childRollup = nutritionInner(db, child.id, includeOptional, memo, nextSeen);
    if (!childRollup.complete) {
      complete = false;
      for (const id of childRollup.missing) missing.add(id);
    }
    // Net, not gross: peel and trim are paid for but not eaten.
    const net = convert(component.qty, component.uom, child.stockUom, conversionContext(child));
    perBatch = addNutrients(perBatch, childRollup.perStockUnit, net);
    inputGrams += childRollup.gramsPerStockUnit * net;
  }

  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  // Output mass: prefer a declared mass yield, else assume water loss only.
  const declaredGrams = gramsOf(item, batchQty);
  const outputGrams = declaredGrams ?? inputGrams * (recipe.massYield ?? 1);

  const scale = batchQty === 0 ? 0 : 1 / batchQty;
  const result: NutritionRollup = {
    perStockUnit: addNutrients(ZERO, perBatch, scale),
    gramsPerStockUnit: batchQty === 0 ? 0 : outputGrams / batchQty,
    complete,
    missing: [...missing],
  };
  memo.set(itemId, result);
  return result;
}

export interface NutritionFacts {
  readonly total: Nutrients;
  readonly perServing: Nutrients;
  readonly per100g: Nutrients;
  readonly servings: number;
  readonly grams: number;
  readonly complete: boolean;
  readonly missing: readonly ItemId[];
}

/**
 * Nutrition for a specific quantity.
 *
 * Like `costOf`, this walks the tree at the requested quantity rather than
 * scaling the per-unit rollup, because a `scalable: false` component does not
 * grow with the batch: two batches of a dough containing one egg contain one
 * egg, and should not report two eggs' worth of protein.
 */
export function nutritionOf(
  db: Database,
  itemId: ItemId,
  qty: number,
  uom?: UomCode,
  options: RollupOptions = {},
): NutritionFacts {
  const includeOptional = options.includeOptional === true;
  const item = mustItem(db, itemId);
  if (qty < 0) throw new MiseError(`Cannot analyse a negative quantity (${qty}) of "${item.name}".`);
  const inStock = convert(qty, uom ?? item.stockUom, item.stockUom, conversionContext(item));
  const recipe = recipeFor(db, itemId);

  let total = ZERO;
  const missing = new Set<ItemId>();

  const walk = (id: ItemId, quantity: number, seen: ReadonlySet<ItemId>): void => {
    // Nothing eaten, nothing to count — including the fixed components.
    if (quantity <= 1e-9) return;
    const current = mustItem(db, id);
    const currentRecipe = isMade(current) && !seen.has(id) ? recipeFor(db, id) : undefined;

    if (!currentRecipe) {
      const grams = gramsOf(current, quantity);
      const per100 = current.nutrientsPer100g;
      if (per100 && grams !== undefined) total = addNutrients(total, per100, grams / 100);
      else missing.add(id);
      return;
    }

    const nextSeen = new Set(seen).add(id);
    const batchQty = convert(
      currentRecipe.yieldQty,
      currentRecipe.yieldUom,
      current.stockUom,
      conversionContext(current),
    );
    const batches = batchQty === 0 ? 0 : quantity / batchQty;

    for (const component of currentRecipe.components) {
      if (component.optional && !includeOptional) continue;
      const child = findItem(db, component.itemId);
      if (!child) continue;
      const scaled = component.scalable === false ? component.qty : component.qty * batches;
      // Net, not gross: peel and trim are paid for but not eaten.
      const net = convert(scaled, component.uom, child.stockUom, conversionContext(child));
      walk(child.id, net, nextSeen);
    }
  };
  walk(itemId, inStock, new Set());

  // Output mass: prefer the item's own conversion, else fall back to the
  // per-unit rollup, which knows about reduction.
  const grams =
    gramsOf(item, inStock) ?? rollupNutrition(db, itemId, options).gramsPerStockUnit * inStock;
  const servings = recipe
    ? (inStock /
        convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item))) *
      recipe.servings
    : inStock;

  return {
    total,
    perServing: addNutrients(ZERO, total, servings > 0 ? 1 / servings : 0),
    per100g: addNutrients(ZERO, total, grams > 0 ? 100 / grams : 0),
    servings,
    grams,
    complete: missing.size === 0,
    missing: [...missing],
  };
}

// ---------------------------------------------------------------------------
// Allergens
// ---------------------------------------------------------------------------

export interface AllergenHit {
  readonly allergen: string;
  /** Items carrying it, and whether every path to them is optional. */
  readonly fromItems: readonly ItemId[];
  readonly onlyOptional: boolean;
}

/** Union of allergens across the whole recipe tree, with provenance. */
export function rollupAllergens(db: Database, itemId: ItemId): AllergenHit[] {
  const hits = new Map<string, { items: Set<ItemId>; required: boolean }>();

  const walk = (id: ItemId, optional: boolean, seen: ReadonlySet<ItemId>): void => {
    if (seen.has(id)) return;
    const item = findItem(db, id);
    if (!item) return;
    for (const allergen of item.allergens ?? []) {
      const entry = hits.get(allergen) ?? { items: new Set<ItemId>(), required: false };
      entry.items.add(id);
      if (!optional) entry.required = true;
      hits.set(allergen, entry);
    }
    const recipe = isMade(item) ? recipeFor(db, id) : undefined;
    if (!recipe) return;
    const nextSeen = new Set(seen).add(id);
    for (const component of recipe.components) {
      walk(component.itemId, optional || component.optional === true, nextSeen);
    }
  };

  walk(itemId, false, new Set());

  return [...hits.entries()]
    .map(([allergen, entry]) => ({
      allergen,
      fromItems: [...entry.items],
      onlyOptional: !entry.required,
    }))
    .sort((a, b) => a.allergen.localeCompare(b.allergen));
}

/** Which household members can't eat this, and why. */
export function dietaryConflicts(
  db: Database,
  itemId: ItemId,
): { member: string; allergens: string[] }[] {
  const present = new Set(rollupAllergens(db, itemId).filter((h) => !h.onlyOptional).map((h) => h.allergen));
  return db.settings.household
    .map((member) => ({
      member: member.name,
      allergens: (member.avoids ?? []).filter((a) => present.has(a)),
    }))
    .filter((conflict) => conflict.allergens.length > 0);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Wall-clock minutes for a run of `batches` of a recipe.
 *
 * Hands-on time scales with the batch count — twenty lots of mince have to be
 * browned twenty times — while unattended time does not, because batches prove
 * and simmer alongside one another. Planning and execution both call this, so
 * `mise prep` and `mise cook` cannot report different days' work for the same
 * job.
 */
export function runMinutes(
  recipe: Recipe,
  batches: number,
): { active: number; passive: number; total: number } {
  const perBatch = recipeMinutes(recipe);
  const active = perBatch.active * batches;
  return { active, passive: perBatch.passive, total: active + perBatch.passive };
}

export function recipeMinutes(recipe: Recipe): { active: number; passive: number } {
  let active = 0;
  let passive = 0;
  for (const step of recipe.steps ?? []) {
    active += step.activeMin ?? 0;
    passive += step.passiveMin ?? 0;
  }
  return { active, passive };
}

export interface TimeRollup {
  /** Hands-on minutes summed over every recipe in the tree. */
  readonly activeMin: number;
  readonly passiveMin: number;
  /**
   * Longest dependency chain in minutes: you cannot start the béchamel before
   * the roux is made, so this is the earliest the dish can possibly be ready
   * even with infinite hands.
   */
  readonly criticalPathMin: number;
  /** The chain that sets the critical path, deepest-first. */
  readonly criticalPath: readonly ItemId[];
}

/**
 * Time for a required quantity of an item, over its whole recipe tree.
 *
 * The batch policy is `runMinutes`': hands-on time scales with the batch
 * count — twenty batches of mince are browned twenty times — while unattended
 * time does not, because batches prove and simmer alongside one another.
 * Omitting `qty` reads the tree at one batch of the root, with sub-recipes
 * scaled to what that one batch actually calls for.
 */
export function rollupTime(
  db: Database,
  itemId: ItemId,
  qty?: number,
  uom?: UomCode,
  options: RollupOptions = {},
): TimeRollup {
  const { includeOptional = false } = options;
  const root = mustItem(db, itemId);
  if (qty !== undefined && qty < 0) {
    throw new MiseError(`Cannot time a negative quantity (${qty}) of "${root.name}".`);
  }
  const rootQty =
    qty === undefined ? undefined : convert(qty, uom ?? root.stockUom, root.stockUom, conversionContext(root));

  let activeMin = 0;
  let passiveMin = 0;

  // `required` is in the item's stock unit; undefined means "one batch of
  // whatever this recipe makes" — the reading a bare recipe card gives.
  const longest = (
    id: ItemId,
    required: number | undefined,
    seen: ReadonlySet<ItemId>,
  ): { minutes: number; path: ItemId[] } => {
    const item = findItem(db, id);
    if (!item) return { minutes: 0, path: [id] };
    const recipe = isMade(item) && !seen.has(id) ? recipeFor(db, id) : undefined;
    // No food, no work: a zero requirement takes zero minutes.
    if (!recipe || (required !== undefined && required <= 1e-9)) return { minutes: 0, path: [id] };

    const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
    const batches = required === undefined ? 1 : batchQty === 0 ? 0 : required / batchQty;

    const nextSeen = new Set(seen).add(id);
    const own = recipeMinutes(recipe);
    activeMin += own.active * batches;
    passiveMin += own.passive;

    let best = { minutes: 0, path: [] as ItemId[] };
    for (const component of recipe.components) {
      if (component.optional && !includeOptional) continue;
      const child = findItem(db, component.itemId);
      if (!child) continue;
      const scaled = component.scalable === false ? component.qty : component.qty * batches;
      const inChildUnits = convert(scaled, component.uom, child.stockUom, conversionContext(child));
      const grossed = component.lossPct ? inChildUnits / (1 - component.lossPct) : inChildUnits;
      const result = longest(component.itemId, grossed, nextSeen);
      if (result.minutes > best.minutes) best = result;
    }
    return { minutes: own.active * batches + own.passive + best.minutes, path: [id, ...best.path] };
  };

  const critical = longest(itemId, rootQty, new Set());
  return {
    activeMin,
    passiveMin,
    criticalPathMin: critical.minutes,
    criticalPath: critical.path,
  };
}
