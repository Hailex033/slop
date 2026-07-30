/**
 * BOM explosion — recipe recursion.
 *
 * `explode()` takes "I want 8 servings of lasagne" and walks the recipe graph
 * downward, converting units at every hop and multiplying quantities by the
 * batch factor of each sub-recipe, until it reaches things you can actually
 * buy. Nothing in the walk cares whether a component is an ingredient or
 * another recipe; that is decided by the component's item, one level at a time,
 * which is why the recursion is uniform and arbitrarily deep.
 *
 * Two subtleties carry real weight:
 *
 *  - **Prep loss.** A recipe calling for 200 g of peeled onion needs more than
 *    200 g of onion bought. Loss is applied on the way *down*, so the demand
 *    that reaches the shopping list is gross, not net.
 *  - **Fixed components.** Doubling a batch does not double the bay leaf.
 *    Components marked `scalable: false` pass through unmultiplied.
 */

import {
  conversionContext,
  findItem,
  isMade,
  mustItem,
  recipeFor,
} from '../domain/db.js';
import { CycleError } from '../domain/errors.js';
import { convert, type UomCode } from '../domain/units.js';
import type { Component, Database, Item, ItemId, Recipe } from '../domain/types.js';

export interface BomNode {
  readonly itemId: ItemId;
  readonly item: Item;
  /** 0 for the item you asked for. */
  readonly depth: number;
  /** Item ids from the root down to and including this node. */
  readonly path: readonly ItemId[];
  /** Quantity the parent recipe calls for, in this item's stock unit. */
  readonly netQty: number;
  /** `netQty` grossed up for this line's prep loss — what you must actually have. */
  readonly grossQty: number;
  readonly uom: UomCode;
  /** The recipe line that produced this node. Absent on the root. */
  readonly line?: Component;
  /** The recipe used to expand this node, if it was expanded. */
  readonly recipe?: Recipe;
  /** How many batches of `recipe` the requirement works out to. */
  readonly batches?: number;
  /** True when this node is a made item that was deliberately not expanded. */
  readonly stopped: boolean;
  /** Phantom sub-recipes are structural only — never stocked, never ordered. */
  readonly phantom: boolean;
  readonly optional: boolean;
  readonly children: readonly BomNode[];
}

export interface ExplodeOptions {
  /** Include components marked `optional`. Default false. */
  readonly includeOptional?: boolean;
  /** Safety valve for pathological data. Default 16. */
  readonly maxDepth?: number;
  /** Items to treat as leaves — "I'll buy the pasta sheets rather than make them". */
  readonly stopAt?: ReadonlySet<ItemId>;
}

export interface ExplodeRequest extends ExplodeOptions {
  readonly itemId: ItemId;
  /** Quantity wanted. Mutually exclusive with `servings`. */
  readonly qty?: number;
  readonly uom?: UomCode;
  /** Portions wanted; converted via the recipe's own servings-per-batch. */
  readonly servings?: number;
}

/** Convert a servings count into a quantity of the item, using its recipe. */
export function quantityForServings(
  db: Database,
  itemId: ItemId,
  servings: number,
): { qty: number; uom: UomCode } {
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  if (!recipe) {
    // A purchased item planned by the portion: one serving is one stock unit
    // unless the item tells us otherwise.
    return { qty: servings, uom: item.stockUom };
  }
  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  return { qty: (batchQty * servings) / recipe.servings, uom: item.stockUom };
}

/** How many servings a given quantity of an item represents. */
export function servingsForQuantity(db: Database, itemId: ItemId, qty: number, uom: UomCode): number {
  const item = mustItem(db, itemId);
  const recipe = recipeFor(db, itemId);
  const inStock = convert(qty, uom, item.stockUom, conversionContext(item));
  if (!recipe) return inStock;
  const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
  return batchQty === 0 ? 0 : (inStock / batchQty) * recipe.servings;
}

/**
 * Explode a requirement into a full recipe tree.
 *
 * Throws `CycleError` if the graph turns out to contain a loop on the path
 * actually walked — cheap insurance even though `mise doctor` checks globally.
 */
export function explode(db: Database, request: ExplodeRequest): BomNode {
  const { itemId, includeOptional = false, maxDepth = 16, stopAt } = request;
  const rootItem = mustItem(db, itemId);

  let qty: number;
  if (request.servings !== undefined) {
    qty = quantityForServings(db, itemId, request.servings).qty;
  } else if (request.qty !== undefined) {
    const uom = request.uom ?? rootItem.stockUom;
    qty = convert(request.qty, uom, rootItem.stockUom, conversionContext(rootItem));
  } else {
    qty = quantityForServings(db, itemId, 1).qty;
  }

  const build = (
    item: Item,
    required: number,
    depth: number,
    path: readonly ItemId[],
    line: Component | undefined,
    optionalAncestor: boolean,
  ): BomNode => {
    if (path.includes(item.id)) throw new CycleError([...path, item.id]);

    const lossPct = line?.lossPct ?? 0;
    const grossQty = lossPct > 0 ? required / (1 - lossPct) : required;
    const nextPath = [...path, item.id];
    const optional = optionalAncestor || line?.optional === true;

    const base = {
      itemId: item.id,
      item,
      depth,
      path: nextPath,
      netQty: required,
      grossQty,
      uom: item.stockUom,
      optional,
      ...(line ? { line } : {}),
    };

    const recipe = isMade(item) ? recipeFor(db, item.id) : undefined;
    const stopped = Boolean(recipe) && (depth >= maxDepth || stopAt?.has(item.id) === true);

    if (!recipe || stopped) {
      return { ...base, stopped, phantom: false, children: [] };
    }

    // Scale: how many batches of this recipe does the requirement represent?
    const batchQty = convert(recipe.yieldQty, recipe.yieldUom, item.stockUom, conversionContext(item));
    const batches = batchQty === 0 ? 0 : grossQty / batchQty;

    const children: BomNode[] = [];
    for (const component of recipe.components) {
      if (component.optional && !includeOptional) continue;
      const childItem = findItem(db, component.itemId);
      if (!childItem) continue; // validate() reports these; don't crash the tree

      const scaled = component.scalable === false ? component.qty : component.qty * batches;
      const inChildStockUom = convert(
        scaled,
        component.uom,
        childItem.stockUom,
        conversionContext(childItem),
      );
      children.push(build(childItem, inChildStockUom, depth + 1, nextPath, component, optional));
    }

    return {
      ...base,
      recipe,
      batches,
      stopped: false,
      phantom: item.sourcing === 'phantom',
      children,
    };
  };

  return build(rootItem, qty, 0, [], undefined, false);
}

/** Depth-first list of every node in the tree, root first. */
export function flatten(node: BomNode): BomNode[] {
  const out: BomNode[] = [node];
  for (const child of node.children) out.push(...flatten(child));
  return out;
}

export interface Requirement {
  readonly itemId: ItemId;
  readonly item: Item;
  /** Total gross quantity required across every place it appears, in stock units. */
  qty: number;
  readonly uom: UomCode;
  /** How many distinct recipe lines demanded it. */
  occurrences: number;
  /** The recipes that called for it, for "why am I buying this?" */
  readonly usedIn: Set<ItemId>;
  readonly optional: boolean;
}

export interface AggregateOptions {
  /**
   * `leaves` — only things you must buy or already have: purchased items plus
   *            any made item whose expansion was stopped.
   * `stocked` — leaves plus stockable sub-recipes (excludes phantoms).
   * `all`    — every node including phantoms.
   */
  readonly level?: 'leaves' | 'stocked' | 'all';
  readonly includeOptional?: boolean;
}

/**
 * Roll a tree up into one line per item.
 *
 * This is where recursion pays for itself: butter appearing in the roux, in
 * the pastry and in the topping comes back as a single "310 g butter", with a
 * record of all three parents.
 */
export function aggregate(root: BomNode, options: AggregateOptions = {}): Requirement[] {
  const { level = 'leaves', includeOptional = true } = options;
  const totals = new Map<ItemId, Requirement>();

  const include = (node: BomNode): boolean => {
    if (node.optional && !includeOptional) return false;
    if (node.depth === 0 && level !== 'all') return false;
    switch (level) {
      case 'leaves':
        return node.children.length === 0;
      case 'stocked':
        return !node.phantom;
      case 'all':
        return true;
    }
  };

  for (const node of flatten(root)) {
    if (!include(node)) continue;
    const existing = totals.get(node.itemId);
    const parent = node.path.length >= 2 ? node.path[node.path.length - 2]! : node.itemId;
    if (existing) {
      existing.qty += node.grossQty;
      existing.occurrences += 1;
      existing.usedIn.add(parent);
    } else {
      totals.set(node.itemId, {
        itemId: node.itemId,
        item: node.item,
        qty: node.grossQty,
        uom: node.uom,
        occurrences: 1,
        usedIn: new Set([parent]),
        optional: node.optional,
      });
    }
  }

  return [...totals.values()].sort(
    (a, b) => a.item.category.localeCompare(b.item.category) || a.item.name.localeCompare(b.item.name),
  );
}

/** Merge several explosions — a whole week's meals — into one requirement list. */
export function aggregateAll(roots: readonly BomNode[], options: AggregateOptions = {}): Requirement[] {
  const merged = new Map<ItemId, Requirement>();
  for (const root of roots) {
    for (const requirement of aggregate(root, options)) {
      const existing = merged.get(requirement.itemId);
      if (existing) {
        existing.qty += requirement.qty;
        existing.occurrences += requirement.occurrences;
        for (const parent of requirement.usedIn) existing.usedIn.add(parent);
      } else {
        merged.set(requirement.itemId, { ...requirement, usedIn: new Set(requirement.usedIn) });
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) => a.item.category.localeCompare(b.item.category) || a.item.name.localeCompare(b.item.name),
  );
}
