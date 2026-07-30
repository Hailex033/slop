/** Small hand-built databases, so assertions can be exact rather than plausible. */

import { emptyDb } from '../src/domain/db.js';
import type { Database, Item, Recipe } from '../src/domain/types.js';

export function purchased(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id,
    name: id,
    category: 'Test',
    sourcing: 'purchased',
    stockUom: 'g',
    purchase: { supplierId: 'shop', packQty: 100, packUom: 'g', packPrice: 1, leadTimeDays: 0 },
    ...overrides,
  };
}

export function made(id: string, overrides: Partial<Item> = {}): Item {
  return { id, name: id, category: 'Test', sourcing: 'manufactured', stockUom: 'g', ...overrides };
}

export function phantom(id: string, overrides: Partial<Item> = {}): Item {
  return { id, name: id, category: 'Test', sourcing: 'phantom', stockUom: 'g', ...overrides };
}

export function recipe(
  outputItemId: string,
  yieldQty: number,
  components: Recipe['components'],
  overrides: Partial<Recipe> = {},
): Recipe {
  return {
    id: `r-${outputItemId}`,
    outputItemId,
    yieldQty,
    yieldUom: 'g',
    servings: 1,
    components,
    ...overrides,
  };
}

export function db(items: Item[], recipes: Recipe[] = []): Database {
  const database = emptyDb();
  database.suppliers = [{ id: 'shop', name: 'Shop', leadTimeDays: 0 }];
  database.items = items;
  database.recipes = recipes;
  return database;
}

/**
 * A four-level tree with a shared node, in miniature:
 *
 *   dish ─┬─ sauce ── roux ─┬─ butter
 *         │                 └─ flour
 *         ├─ crust ─────────┬─ butter    (butter reachable two ways)
 *         │                 └─ flour
 *         └─ cheese
 */
export function nestedDb(): Database {
  return db(
    [
      purchased('butter'),
      purchased('flour'),
      purchased('cheese'),
      phantom('roux'),
      made('sauce'),
      made('crust'),
      made('dish'),
    ],
    [
      recipe('roux', 200, [
        { itemId: 'butter', qty: 100, uom: 'g' },
        { itemId: 'flour', qty: 100, uom: 'g' },
      ]),
      recipe('sauce', 1000, [{ itemId: 'roux', qty: 200, uom: 'g' }]),
      recipe('crust', 300, [
        { itemId: 'butter', qty: 100, uom: 'g' },
        { itemId: 'flour', qty: 200, uom: 'g' },
      ]),
      recipe('dish', 1500, [
        { itemId: 'sauce', qty: 1000, uom: 'g' },
        { itemId: 'crust', qty: 300, uom: 'g' },
        { itemId: 'cheese', qty: 200, uom: 'g' },
      ], { servings: 4 }),
    ],
  );
}

/** Within a whisker of each other — for anything that has been through a unit conversion. */
export function close(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}
