/**
 * The recipe graph.
 *
 * Recipes form a directed acyclic graph over the item master. Before anything
 * recursive is safe to run we need three things from it: proof that it really
 * is acyclic, each item's *low-level code*, and the ability to walk it upward
 * as well as downward.
 *
 * The low-level code is the deepest level at which an item appears anywhere in
 * the graph. Butter used directly in a lasagne (level 1) and also inside a roux
 * inside a béchamel inside that lasagne (level 3) has a low-level code of 3.
 * MRP processes items in low-level-code order so that by the time it nets
 * butter, *every* recipe that could demand butter has already contributed its
 * requirement. Without it you would order butter twice.
 */

import { conversionContext, directParents, findItem, isMade, mustItem, recipeFor } from '../domain/db.js';
import { CycleError } from '../domain/errors.js';
import { convert } from '../domain/units.js';
import type { Database, ItemId, Recipe } from '../domain/types.js';

export interface Cycle {
  /** Item ids from the first repeated node back around to itself. */
  readonly path: readonly ItemId[];
}

/**
 * Find every cycle reachable in the recipe graph, without throwing.
 * `mise doctor` reports these; the explosion engine refuses to run with any.
 */
export function findCycles(db: Database): Cycle[] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<ItemId, number>();
  const stack: ItemId[] = [];
  const cycles: Cycle[] = [];
  const reported = new Set<string>();

  const visit = (itemId: ItemId): void => {
    const state = colour.get(itemId) ?? WHITE;
    if (state === BLACK) return;
    if (state === GREY) {
      const start = stack.indexOf(itemId);
      const path = [...stack.slice(start), itemId];
      // Normalise rotation so the same cycle found from two entry points is
      // only reported once.
      const key = [...path.slice(0, -1)].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        cycles.push({ path });
      }
      return;
    }

    colour.set(itemId, GREY);
    stack.push(itemId);
    const recipe = recipeFor(db, itemId);
    if (recipe) {
      for (const component of recipe.components) {
        if (findItem(db, component.itemId)) visit(component.itemId);
      }
    }
    stack.pop();
    colour.set(itemId, BLACK);
  };

  for (const item of db.items) visit(item.id);
  return cycles;
}

export function assertAcyclic(db: Database): void {
  const cycles = findCycles(db);
  if (cycles.length > 0) throw new CycleError(cycles[0]!.path);
}

/**
 * Low-level code per item: 0 for items nothing else uses, otherwise one more
 * than the deepest parent that uses them.
 */
export function lowLevelCodes(db: Database): Map<ItemId, number> {
  assertAcyclic(db);
  const codes = new Map<ItemId, number>();

  const compute = (itemId: ItemId, seen: Set<ItemId>): number => {
    const cached = codes.get(itemId);
    if (cached !== undefined) return cached;
    if (seen.has(itemId)) return 0; // unreachable: assertAcyclic already ran
    seen.add(itemId);

    const parents = directParents(db, itemId);
    let code = 0;
    for (const parent of parents) {
      code = Math.max(code, compute(parent.outputItemId, seen) + 1);
    }
    seen.delete(itemId);
    codes.set(itemId, code);
    return code;
  };

  for (const item of db.items) compute(item.id, new Set());
  return codes;
}

/**
 * Items in dependency order: every item appears before anything it contains.
 * This is exactly low-level-code order, which is what MRP needs.
 */
export function planningOrder(db: Database): ItemId[] {
  const codes = lowLevelCodes(db);
  return [...codes.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([itemId]) => itemId);
}

/** Items that no recipe consumes — the things you actually plan to eat. */
export function topLevelItems(db: Database): ItemId[] {
  return db.items.filter((item) => directParents(db, item.id).length === 0).map((item) => item.id);
}

/** Every item reachable below `itemId`, itself excluded. */
export function descendants(db: Database, itemId: ItemId): Set<ItemId> {
  const out = new Set<ItemId>();
  const walk = (id: ItemId): void => {
    const recipe = recipeFor(db, id);
    if (!recipe) return;
    for (const component of recipe.components) {
      if (out.has(component.itemId)) continue;
      out.add(component.itemId);
      walk(component.itemId);
    }
  };
  walk(itemId);
  return out;
}

export interface WhereUsedNode {
  readonly itemId: ItemId;
  readonly name: string;
  readonly depth: number;
  /** The recipe through which the child is reached from this parent. */
  readonly viaRecipe?: Recipe;
  /** How much of the child one batch of this parent consumes. */
  readonly qtyPerBatch?: number;
  readonly qtyUom?: string;
  readonly children: WhereUsedNode[];
}

/**
 * Reverse explosion: "if I throw out this jar of anchovies, what breaks?"
 * Walks upward from an item to every recipe that transitively depends on it.
 */
export function whereUsed(db: Database, itemId: ItemId, maxDepth = 12): WhereUsedNode {
  const build = (id: ItemId, depth: number, seen: Set<ItemId>): WhereUsedNode => {
    const item = mustItem(db, id);
    const node: WhereUsedNode = {
      itemId: id,
      name: item.name,
      depth,
      children: [],
    };
    if (depth >= maxDepth || seen.has(id)) return node;
    const nextSeen = new Set(seen).add(id);

    // One entry per parent recipe, whatever the line count: flour in the
    // dough and flour for dusting is one relationship with a combined
    // per-batch quantity, not the same parent printed twice at the first
    // line's amount. (The used-by index lists a recipe once per line.)
    const seenParents = new Set<string>();
    for (const parent of directParents(db, id)) {
      if (seenParents.has(parent.id)) continue;
      seenParents.add(parent.id);

      const lines = parent.components.filter((c) => c.itemId === id);
      let quantity: { qtyPerBatch: number; qtyUom: string } | undefined;
      if (lines.length === 1) {
        quantity = { qtyPerBatch: lines[0]!.qty, qtyUom: lines[0]!.uom };
      } else if (lines.length > 1) {
        if (lines.every((line) => line.uom === lines[0]!.uom)) {
          quantity = {
            qtyPerBatch: lines.reduce((sum, line) => sum + line.qty, 0),
            qtyUom: lines[0]!.uom,
          };
        } else {
          // Mixed units sum in the item's own stock unit.
          quantity = {
            qtyPerBatch: lines.reduce(
              (sum, line) => sum + convert(line.qty, line.uom, item.stockUom, conversionContext(item)),
              0,
            ),
            qtyUom: item.stockUom,
          };
        }
      }

      const child = build(parent.outputItemId, depth + 1, nextSeen);
      node.children.push({
        ...child,
        viaRecipe: parent,
        ...(quantity ?? {}),
      });
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    return node;
  };

  return build(itemId, 0, new Set());
}

/** How deep the recipe tree under this item goes. 0 for a purchased item. */
export function recipeDepth(db: Database, itemId: ItemId): number {
  const memo = new Map<ItemId, number>();
  const walk = (id: ItemId, seen: Set<ItemId>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const item = findItem(db, id);
    const recipe = item && isMade(item) ? recipeFor(db, id) : undefined;
    if (!recipe || seen.has(id)) return 0;
    const nextSeen = new Set(seen).add(id);
    let depth = 0;
    for (const component of recipe.components) {
      depth = Math.max(depth, walk(component.itemId, nextSeen) + 1);
    }
    memo.set(id, depth);
    return depth;
  };
  return walk(itemId, new Set());
}
