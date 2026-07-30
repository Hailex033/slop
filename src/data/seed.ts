/**
 * A worked example household.
 *
 * The dataset is chosen to exercise the parts of the engine that matter:
 *
 *  - **Depth.** Lasagne → béchamel → roux → butter is four levels. Nothing in
 *    the engine knows the number four.
 *  - **Sharing.** Roux appears under both the béchamel and the velouté;
 *    soffritto under both the ragù and the minestrone; chicken stock under the
 *    velouté and the minestrone. Butter is reachable by five distinct paths.
 *    Aggregation has to pool all of them, and MRP has to net them once.
 *  - **Phantoms.** Nobody keeps a tub of soffritto. It is a real sub-recipe with
 *    real structure that is never stocked and never ordered.
 *  - **Loss and fixed lines.** Onions are peeled; the bay leaf does not double
 *    when the batch does.
 *
 * Prices are plausible UK supermarket prices in GBP; nutrition is per 100 g
 * from standard reference values. Both are illustrative, not authoritative.
 */

import { addDays, today, type IsoDate } from '../domain/date.js';
import { emptyDb } from '../domain/db.js';
import type { Database, Item, MealPlanEntry, Recipe, Supplier } from '../domain/types.js';
import { receive } from '../engine/inventory.js';

const SUPPLIERS: Supplier[] = [
  { id: 'super', name: 'Supermarket', leadTimeDays: 0, note: 'Ten minutes away, open daily.' },
  {
    id: 'market',
    name: 'Saturday market',
    leadTimeDays: 0,
    deliveryDays: [6],
    note: 'Better produce, but only on Saturdays — plan ahead.',
  },
  { id: 'butcher', name: 'Butcher', leadTimeDays: 1, note: 'Orders placed a day ahead.' },
  { id: 'tap', name: 'The tap', leadTimeDays: 0 },
];

const PURCHASED: Item[] = [
  // ---- produce -----------------------------------------------------------
  {
    id: 'onion', name: 'Onion', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    unitWeightG: 150, storage: 'pantry', shelfLifeDays: 30, safetyStock: 300,
    purchase: { supplierId: 'market', packQty: 1000, packUom: 'g', packPrice: 1.05, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 40, proteinG: 1.1, fatG: 0.1, satFatG: 0, carbG: 9.3, sugarG: 4.2, fibreG: 1.7, sodiumMg: 4 },
  },
  {
    id: 'carrot', name: 'Carrot', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    unitWeightG: 80, storage: 'fridge', shelfLifeDays: 21, safetyStock: 200,
    purchase: { supplierId: 'market', packQty: 1000, packUom: 'g', packPrice: 0.9, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 41, proteinG: 0.9, fatG: 0.2, satFatG: 0, carbG: 9.6, sugarG: 4.7, fibreG: 2.8, sodiumMg: 69 },
  },
  {
    id: 'celery', name: 'Celery', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    unitWeightG: 60, storage: 'fridge', shelfLifeDays: 14,
    purchase: { supplierId: 'super', packQty: 400, packUom: 'g', packPrice: 0.85, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 16, proteinG: 0.7, fatG: 0.2, satFatG: 0, carbG: 3, sugarG: 1.3, fibreG: 1.6, sodiumMg: 80 },
  },
  {
    id: 'garlic', name: 'Garlic', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    unitWeightG: 5, storage: 'pantry', shelfLifeDays: 60,
    purchase: { supplierId: 'market', packQty: 100, packUom: 'g', packPrice: 0.9, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 149, proteinG: 6.4, fatG: 0.5, satFatG: 0.1, carbG: 33, sugarG: 1, fibreG: 2.1, sodiumMg: 17 },
  },
  {
    id: 'leek', name: 'Leek', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    unitWeightG: 200, storage: 'fridge', shelfLifeDays: 12,
    purchase: { supplierId: 'market', packQty: 500, packUom: 'g', packPrice: 1.4, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 61, proteinG: 1.5, fatG: 0.3, satFatG: 0, carbG: 14, sugarG: 3.9, fibreG: 1.8, sodiumMg: 20 },
  },
  {
    id: 'courgette', name: 'Courgette', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    unitWeightG: 200, storage: 'fridge', shelfLifeDays: 10,
    purchase: { supplierId: 'market', packQty: 500, packUom: 'g', packPrice: 1.6, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 17, proteinG: 1.2, fatG: 0.3, satFatG: 0.1, carbG: 3.1, sugarG: 2.5, fibreG: 1, sodiumMg: 8 },
  },
  {
    id: 'parsley', name: 'Flat-leaf parsley', category: 'Produce', sourcing: 'purchased', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 7,
    purchase: { supplierId: 'super', packQty: 30, packUom: 'g', packPrice: 0.8, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 36, proteinG: 3, fatG: 0.8, satFatG: 0.1, carbG: 6.3, sugarG: 0.9, fibreG: 3.3, sodiumMg: 56 },
  },

  // ---- dairy & chilled ---------------------------------------------------
  {
    id: 'butter', name: 'Butter', category: 'Dairy', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.911, storage: 'fridge', shelfLifeDays: 60, safetyStock: 100,
    allergens: ['milk'],
    purchase: { supplierId: 'super', packQty: 250, packUom: 'g', packPrice: 2.2, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 717, proteinG: 0.85, fatG: 81, satFatG: 51, carbG: 0.06, sugarG: 0.06, fibreG: 0, sodiumMg: 643 },
  },
  {
    id: 'milk', name: 'Whole milk', category: 'Dairy', sourcing: 'purchased', stockUom: 'ml',
    densityGPerMl: 1.03, storage: 'fridge', shelfLifeDays: 8, safetyStock: 500,
    allergens: ['milk'],
    purchase: { supplierId: 'super', packQty: 2, packUom: 'l', packPrice: 1.45, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 61, proteinG: 3.2, fatG: 3.3, satFatG: 1.9, carbG: 4.8, sugarG: 5.1, fibreG: 0, sodiumMg: 43 },
  },
  {
    id: 'cream', name: 'Double cream', category: 'Dairy', sourcing: 'purchased', stockUom: 'ml',
    densityGPerMl: 1.0, storage: 'fridge', shelfLifeDays: 12,
    allergens: ['milk'],
    purchase: { supplierId: 'super', packQty: 300, packUom: 'ml', packPrice: 1.6, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 449, proteinG: 2.1, fatG: 48, satFatG: 30, carbG: 2.8, sugarG: 2.8, fibreG: 0, sodiumMg: 38 },
  },
  {
    id: 'egg', name: 'Egg', category: 'Dairy', sourcing: 'purchased', stockUom: 'ea',
    unitWeightG: 58, storage: 'fridge', shelfLifeDays: 21, safetyStock: 4,
    allergens: ['egg'],
    purchase: { supplierId: 'market', packQty: 6, packUom: 'ea', packPrice: 1.95, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 143, proteinG: 12.6, fatG: 9.5, satFatG: 3.1, carbG: 0.7, sugarG: 0.4, fibreG: 0, sodiumMg: 142 },
  },
  {
    id: 'parmesan', name: 'Parmigiano Reggiano', category: 'Dairy', sourcing: 'purchased', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 90,
    allergens: ['milk'],
    purchase: { supplierId: 'super', packQty: 200, packUom: 'g', packPrice: 4.5, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 392, proteinG: 35.8, fatG: 25, satFatG: 16, carbG: 3.2, sugarG: 0.8, fibreG: 0, sodiumMg: 1600 },
  },

  // ---- meat --------------------------------------------------------------
  {
    id: 'beef-mince', name: 'Beef mince (10%)', category: 'Meat', sourcing: 'purchased', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 3,
    purchase: { supplierId: 'butcher', packQty: 500, packUom: 'g', packPrice: 4.25, leadTimeDays: 1 },
    nutrientsPer100g: { kcal: 217, proteinG: 18.6, fatG: 15, satFatG: 6, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 66 },
  },
  {
    id: 'pork-mince', name: 'Pork mince', category: 'Meat', sourcing: 'purchased', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 3,
    purchase: { supplierId: 'butcher', packQty: 500, packUom: 'g', packPrice: 3.6, leadTimeDays: 1 },
    nutrientsPer100g: { kcal: 263, proteinG: 17, fatG: 21, satFatG: 7.7, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 60 },
  },
  {
    id: 'pancetta', name: 'Pancetta', category: 'Meat', sourcing: 'purchased', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 14,
    purchase: { supplierId: 'butcher', packQty: 130, packUom: 'g', packPrice: 2.4, leadTimeDays: 1 },
    nutrientsPer100g: { kcal: 458, proteinG: 20, fatG: 42, satFatG: 15, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 1800 },
  },
  {
    id: 'chicken-thigh', name: 'Chicken thigh (boneless)', category: 'Meat', sourcing: 'purchased', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 3,
    purchase: { supplierId: 'butcher', packQty: 1000, packUom: 'g', packPrice: 5.5, leadTimeDays: 1 },
    nutrientsPer100g: { kcal: 209, proteinG: 17.9, fatG: 15, satFatG: 4.2, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 84 },
  },
  {
    id: 'chicken-wings', name: 'Chicken wings', category: 'Meat', sourcing: 'purchased', stockUom: 'g',
    storage: 'freezer', shelfLifeDays: 120,
    purchase: { supplierId: 'butcher', packQty: 1000, packUom: 'g', packPrice: 3.2, leadTimeDays: 1 },
    nutrientsPer100g: { kcal: 203, proteinG: 18.3, fatG: 14, satFatG: 3.9, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 82 },
  },

  // ---- store cupboard ----------------------------------------------------
  {
    id: 'flour', name: 'Plain flour', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.53, storage: 'pantry', shelfLifeDays: 365, safetyStock: 250,
    allergens: ['gluten'],
    purchase: { supplierId: 'super', packQty: 1.5, packUom: 'kg', packPrice: 1.45, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 364, proteinG: 10, fatG: 1, satFatG: 0.2, carbG: 76, sugarG: 0.3, fibreG: 2.7, sodiumMg: 2 },
  },
  {
    id: 'flour-00', name: '"00" pasta flour', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.55, storage: 'pantry', shelfLifeDays: 365,
    allergens: ['gluten'],
    purchase: { supplierId: 'super', packQty: 1, packUom: 'kg', packPrice: 2.3, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 350, proteinG: 11, fatG: 1, satFatG: 0.2, carbG: 72, sugarG: 0.3, fibreG: 2.5, sodiumMg: 2 },
  },
  {
    id: 'bread-flour', name: 'Strong white flour', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.55, storage: 'pantry', shelfLifeDays: 365,
    allergens: ['gluten'],
    purchase: { supplierId: 'super', packQty: 1.5, packUom: 'kg', packPrice: 1.95, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 361, proteinG: 12, fatG: 1.5, satFatG: 0.2, carbG: 73, sugarG: 0.3, fibreG: 2.7, sodiumMg: 2 },
  },
  {
    id: 'olive-oil', name: 'Olive oil', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'ml',
    densityGPerMl: 0.911, storage: 'pantry', shelfLifeDays: 540, safetyStock: 150,
    purchase: { supplierId: 'super', packQty: 750, packUom: 'ml', packPrice: 6.5, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 884, proteinG: 0, fatG: 100, satFatG: 14, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 2 },
  },
  {
    id: 'passata', name: 'Tomato passata', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'ml',
    densityGPerMl: 1.03, storage: 'pantry', shelfLifeDays: 400,
    purchase: { supplierId: 'super', packQty: 500, packUom: 'ml', packPrice: 0.95, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 35, proteinG: 1.6, fatG: 0.2, satFatG: 0, carbG: 6, sugarG: 5, fibreG: 1.3, sodiumMg: 12 },
  },
  {
    id: 'chopped-tomatoes', name: 'Chopped tomatoes', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 1.03, storage: 'pantry', shelfLifeDays: 500,
    purchase: { supplierId: 'super', packQty: 400, packUom: 'g', packPrice: 0.85, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 22, proteinG: 1.1, fatG: 0.2, satFatG: 0, carbG: 3.6, sugarG: 3.3, fibreG: 1, sodiumMg: 9 },
  },
  {
    id: 'borlotti', name: 'Borlotti beans (tinned)', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    storage: 'pantry', shelfLifeDays: 700,
    purchase: { supplierId: 'super', packQty: 400, packUom: 'g', packPrice: 0.9, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 91, proteinG: 6.2, fatG: 0.5, satFatG: 0.1, carbG: 12, sugarG: 0.5, fibreG: 5, sodiumMg: 240 },
  },
  {
    id: 'ditalini', name: 'Ditalini pasta', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    storage: 'pantry', shelfLifeDays: 500,
    allergens: ['gluten'],
    purchase: { supplierId: 'super', packQty: 500, packUom: 'g', packPrice: 1.1, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 371, proteinG: 13, fatG: 1.5, satFatG: 0.3, carbG: 75, sugarG: 2.7, fibreG: 3.2, sodiumMg: 6 },
  },
  {
    id: 'red-wine', name: 'Red wine', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'ml',
    densityGPerMl: 0.99, storage: 'pantry', shelfLifeDays: 1000,
    allergens: ['sulphites'],
    purchase: { supplierId: 'super', packQty: 750, packUom: 'ml', packPrice: 7.0, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 85, proteinG: 0.1, fatG: 0, satFatG: 0, carbG: 2.6, sugarG: 0.6, fibreG: 0, sodiumMg: 4 },
  },
  {
    id: 'salt', name: 'Fine sea salt', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 1.2, storage: 'pantry', shelfLifeDays: 3000,
    purchase: { supplierId: 'super', packQty: 500, packUom: 'g', packPrice: 0.75, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 0, proteinG: 0, fatG: 0, satFatG: 0, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 38758 },
  },
  {
    id: 'pepper', name: 'Black pepper', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.5, storage: 'pantry', shelfLifeDays: 900,
    purchase: { supplierId: 'super', packQty: 50, packUom: 'g', packPrice: 2.1, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 251, proteinG: 10, fatG: 3.3, satFatG: 1.4, carbG: 64, sugarG: 0.6, fibreG: 25, sodiumMg: 20 },
  },
  {
    id: 'nutmeg', name: 'Nutmeg', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.5, storage: 'pantry', shelfLifeDays: 900,
    purchase: { supplierId: 'super', packQty: 30, packUom: 'g', packPrice: 2.5, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 525, proteinG: 5.8, fatG: 36, satFatG: 25, carbG: 49, sugarG: 28, fibreG: 20.8, sodiumMg: 16 },
  },
  {
    id: 'bay-leaf', name: 'Bay leaf', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'ea',
    unitWeightG: 0.2, storage: 'pantry', shelfLifeDays: 900,
    purchase: { supplierId: 'super', packQty: 20, packUom: 'ea', packPrice: 1.1, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 313, proteinG: 7.6, fatG: 8.4, satFatG: 2.3, carbG: 75, sugarG: 0, fibreG: 26, sodiumMg: 23 },
  },
  {
    id: 'thyme', name: 'Thyme', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 0.35, storage: 'pantry', shelfLifeDays: 700,
    purchase: { supplierId: 'super', packQty: 20, packUom: 'g', packPrice: 1.3, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 276, proteinG: 9, fatG: 7.4, satFatG: 2.7, carbG: 64, sugarG: 1.7, fibreG: 37, sodiumMg: 55 },
  },
  {
    id: 'starter', name: 'Sourdough starter', category: 'Store cupboard', sourcing: 'purchased', stockUom: 'g',
    densityGPerMl: 1.05, storage: 'fridge',
    allergens: ['gluten'],
    // Modelled as purchased rather than made: a starter is fed from itself,
    // which would be a genuine cycle in the recipe graph. The engine detects
    // that case (see the cycle test) — here we treat the jar as a standing
    // item that is replenished by feeding, not by a bill of materials.
    purchase: { supplierId: 'super', packQty: 100, packUom: 'g', packPrice: 0, leadTimeDays: 0 },
    note: 'Fed daily. Standing item — never actually bought.',
    nutrientsPer100g: { kcal: 180, proteinG: 6, fatG: 0.6, satFatG: 0.1, carbG: 38, sugarG: 0.2, fibreG: 1.5, sodiumMg: 3 },
  },
  {
    id: 'water', name: 'Water', category: 'Basics', sourcing: 'purchased', stockUom: 'ml',
    densityGPerMl: 1.0, storage: 'pantry',
    purchase: { supplierId: 'tap', packQty: 1000, packUom: 'ml', packPrice: 0.0015, leadTimeDays: 0 },
    nutrientsPer100g: { kcal: 0, proteinG: 0, fatG: 0, satFatG: 0, carbG: 0, sugarG: 0, fibreG: 0, sodiumMg: 0 },
  },
];

/** Items that are made rather than bought. Their recipes follow. */
const MADE: Item[] = [
  {
    id: 'soffritto', name: 'Soffritto', category: 'Sub-recipe', sourcing: 'phantom', stockUom: 'g',
    densityGPerMl: 0.85,
    note: 'Never kept. Chopped fresh every time, so it explodes straight through.',
  },
  {
    id: 'roux', name: 'Roux', category: 'Sub-recipe', sourcing: 'phantom', stockUom: 'g',
    densityGPerMl: 0.9,
    allergens: [],
    note: 'Made in the pan, used within the minute. The classic phantom assembly.',
  },
  {
    id: 'pasta-dough', name: 'Fresh pasta dough', category: 'Sub-recipe', sourcing: 'phantom', stockUom: 'g',
    densityGPerMl: 0.75,
  },
  {
    id: 'levain', name: 'Levain', category: 'Sub-recipe', sourcing: 'phantom', stockUom: 'g',
    densityGPerMl: 0.9,
  },
  {
    id: 'pasta-sheets', name: 'Fresh pasta sheets', category: 'Prepared', sourcing: 'manufactured', stockUom: 'g',
    storage: 'fridge', shelfLifeDays: 2,
  },
  {
    id: 'ragu', name: 'Ragù alla bolognese', category: 'Prepared', sourcing: 'manufactured', stockUom: 'g',
    densityGPerMl: 1.02, storage: 'fridge', shelfLifeDays: 4,
    note: 'Freezes well. Worth making double.',
  },
  {
    id: 'besciamella', name: 'Besciamella', category: 'Prepared', sourcing: 'manufactured', stockUom: 'ml',
    densityGPerMl: 1.04, storage: 'fridge', shelfLifeDays: 3,
  },
  {
    id: 'chicken-stock', name: 'Chicken stock', category: 'Prepared', sourcing: 'manufactured', stockUom: 'ml',
    densityGPerMl: 1.0, storage: 'freezer', shelfLifeDays: 90,
  },
  {
    id: 'veloute', name: 'Velouté', category: 'Prepared', sourcing: 'manufactured', stockUom: 'ml',
    densityGPerMl: 1.02, storage: 'fridge', shelfLifeDays: 3,
  },
  {
    id: 'shortcrust', name: 'Shortcrust pastry', category: 'Prepared', sourcing: 'manufactured', stockUom: 'g',
    densityGPerMl: 0.95, storage: 'fridge', shelfLifeDays: 3,
  },
  {
    id: 'lasagne', name: 'Lasagne al forno', category: 'Dish', sourcing: 'manufactured', stockUom: 'g',
    densityGPerMl: 1.0, storage: 'fridge', shelfLifeDays: 3,
  },
  {
    id: 'chicken-pie', name: 'Chicken and leek pie', category: 'Dish', sourcing: 'manufactured', stockUom: 'g',
    densityGPerMl: 0.95, storage: 'fridge', shelfLifeDays: 3,
  },
  {
    id: 'minestrone', name: 'Minestrone', category: 'Dish', sourcing: 'manufactured', stockUom: 'ml',
    densityGPerMl: 1.0, storage: 'fridge', shelfLifeDays: 4,
  },
  {
    id: 'sourdough', name: 'Sourdough loaf', category: 'Dish', sourcing: 'manufactured', stockUom: 'g',
    densityGPerMl: 0.35, storage: 'counter', shelfLifeDays: 4,
  },
];

const RECIPES: Recipe[] = [
  {
    id: 'r-soffritto',
    outputItemId: 'soffritto',
    yieldQty: 300,
    yieldUom: 'g',
    servings: 4,
    massYield: 0.8,
    components: [
      // Loss is the peel and the trim: buy 1/(1-loss) times what goes in the pan.
      { itemId: 'onion', qty: 150, uom: 'g', lossPct: 0.1, prep: 'finely diced' },
      { itemId: 'carrot', qty: 75, uom: 'g', lossPct: 0.15, prep: 'finely diced' },
      { itemId: 'celery', qty: 75, uom: 'g', lossPct: 0.1, prep: 'finely diced' },
      { itemId: 'olive-oil', qty: 2, uom: 'tbsp' },
    ],
    steps: [
      { text: 'Dice the vegetables to an even 3 mm.', activeMin: 12 },
      { text: 'Sweat gently in the oil until soft and sweet, not coloured.', activeMin: 3, passiveMin: 15 },
    ],
  },
  {
    id: 'r-roux',
    outputItemId: 'roux',
    yieldQty: 200,
    yieldUom: 'g',
    servings: 8,
    components: [
      { itemId: 'butter', qty: 100, uom: 'g' },
      { itemId: 'flour', qty: 100, uom: 'g' },
    ],
    steps: [{ text: 'Melt the butter, stir in the flour, cook out for two minutes.', activeMin: 5 }],
    note: 'Used by both the besciamella and the velouté — the shared node in this dataset.',
  },
  {
    id: 'r-pasta-dough',
    outputItemId: 'pasta-dough',
    yieldQty: 620,
    yieldUom: 'g',
    servings: 6,
    components: [
      { itemId: 'flour-00', qty: 400, uom: 'g' },
      { itemId: 'egg', qty: 4, uom: 'ea' },
      { itemId: 'olive-oil', qty: 1, uom: 'tbsp' },
      { itemId: 'salt', qty: 1, uom: 'tsp', scalable: false },
    ],
    steps: [
      { text: 'Bring to a smooth dough and knead.', activeMin: 10 },
      { text: 'Rest, wrapped, at room temperature.', passiveMin: 30 },
    ],
  },
  {
    id: 'r-pasta-sheets',
    outputItemId: 'pasta-sheets',
    yieldQty: 600,
    yieldUom: 'g',
    servings: 6,
    massYield: 0.97,
    components: [
      { itemId: 'pasta-dough', qty: 620, uom: 'g' },
      { itemId: 'flour-00', qty: 30, uom: 'g', prep: 'for dusting' },
    ],
    steps: [{ text: 'Roll down to the second-thinnest setting and cut to fit the dish.', activeMin: 25 }],
  },
  {
    id: 'r-ragu',
    outputItemId: 'ragu',
    yieldQty: 1400,
    yieldUom: 'g',
    servings: 6,
    massYield: 0.72,
    components: [
      { itemId: 'soffritto', qty: 300, uom: 'g' },
      { itemId: 'pancetta', qty: 100, uom: 'g', prep: 'diced' },
      { itemId: 'beef-mince', qty: 500, uom: 'g' },
      { itemId: 'pork-mince', qty: 250, uom: 'g' },
      { itemId: 'red-wine', qty: 200, uom: 'ml' },
      { itemId: 'passata', qty: 500, uom: 'ml' },
      { itemId: 'milk', qty: 250, uom: 'ml' },
      // One bay leaf is one bay leaf, whether you make one batch or four.
      { itemId: 'bay-leaf', qty: 2, uom: 'ea', scalable: false },
      { itemId: 'salt', qty: 1.5, uom: 'tsp' },
      { itemId: 'pepper', qty: 1, uom: 'g' },
    ],
    steps: [
      { text: 'Render the pancetta, add the soffritto.', activeMin: 8 },
      { text: 'Brown the meat hard, in batches.', activeMin: 15 },
      { text: 'Deglaze with the wine and let it reduce away.', activeMin: 3, passiveMin: 10 },
      { text: 'Add passata and milk; simmer, barely bubbling.', activeMin: 5, passiveMin: 180 },
    ],
    source: 'Adapted from the Accademia Italiana della Cucina registered recipe.',
  },
  {
    id: 'r-besciamella',
    outputItemId: 'besciamella',
    yieldQty: 1000,
    yieldUom: 'ml',
    servings: 6,
    components: [
      { itemId: 'roux', qty: 200, uom: 'g' },
      { itemId: 'milk', qty: 1, uom: 'l' },
      { itemId: 'nutmeg', qty: 0.5, uom: 'g', scalable: false, prep: 'grated' },
      { itemId: 'salt', qty: 0.5, uom: 'tsp' },
    ],
    steps: [
      { text: 'Beat the warm milk into the roux a ladle at a time.', activeMin: 10 },
      { text: 'Simmer until it coats a spoon; season with nutmeg.', activeMin: 5, passiveMin: 5 },
    ],
  },
  {
    id: 'r-chicken-stock',
    outputItemId: 'chicken-stock',
    yieldQty: 1500,
    yieldUom: 'ml',
    servings: 6,
    massYield: 0.6,
    components: [
      { itemId: 'chicken-wings', qty: 800, uom: 'g' },
      { itemId: 'onion', qty: 150, uom: 'g', lossPct: 0.1 },
      { itemId: 'carrot', qty: 100, uom: 'g', lossPct: 0.15 },
      { itemId: 'celery', qty: 100, uom: 'g', lossPct: 0.1 },
      { itemId: 'bay-leaf', qty: 2, uom: 'ea', scalable: false },
      { itemId: 'thyme', qty: 2, uom: 'g', scalable: false, optional: true },
      { itemId: 'water', qty: 2.5, uom: 'l' },
    ],
    steps: [
      { text: 'Roast the wings until deeply coloured.', activeMin: 5, passiveMin: 40 },
      { text: 'Cover with cold water, bring to a bare tremble, skim.', activeMin: 10, passiveMin: 240 },
      { text: 'Strain, cool fast, freeze in 500 ml blocks.', activeMin: 10 },
    ],
  },
  {
    id: 'r-veloute',
    outputItemId: 'veloute',
    yieldQty: 800,
    yieldUom: 'ml',
    servings: 4,
    components: [
      { itemId: 'roux', qty: 120, uom: 'g' },
      { itemId: 'chicken-stock', qty: 700, uom: 'ml' },
      { itemId: 'cream', qty: 100, uom: 'ml' },
      { itemId: 'salt', qty: 0.5, uom: 'tsp' },
      { itemId: 'pepper', qty: 0.5, uom: 'g' },
    ],
    steps: [{ text: 'Whisk the hot stock into the roux, simmer, finish with cream.', activeMin: 12, passiveMin: 8 }],
  },
  {
    id: 'r-shortcrust',
    outputItemId: 'shortcrust',
    yieldQty: 500,
    yieldUom: 'g',
    servings: 4,
    components: [
      { itemId: 'flour', qty: 300, uom: 'g' },
      { itemId: 'butter', qty: 150, uom: 'g', prep: 'cold, cubed' },
      { itemId: 'egg', qty: 1, uom: 'ea' },
      { itemId: 'water', qty: 30, uom: 'ml' },
      { itemId: 'salt', qty: 0.5, uom: 'tsp', scalable: false },
    ],
    steps: [
      { text: 'Rub the butter into the flour to coarse crumbs.', activeMin: 8 },
      { text: 'Bring together with egg and water; chill.', activeMin: 4, passiveMin: 60 },
    ],
  },
  {
    id: 'r-lasagne',
    outputItemId: 'lasagne',
    yieldQty: 3000,
    yieldUom: 'g',
    servings: 6,
    massYield: 0.9,
    components: [
      { itemId: 'ragu', qty: 1400, uom: 'g' },
      { itemId: 'besciamella', qty: 1000, uom: 'ml' },
      { itemId: 'pasta-sheets', qty: 500, uom: 'g' },
      { itemId: 'parmesan', qty: 120, uom: 'g', prep: 'grated' },
      { itemId: 'butter', qty: 20, uom: 'g', prep: 'for the dish' },
    ],
    steps: [
      { text: 'Layer: ragù, sheets, besciamella, parmesan. Repeat five times.', activeMin: 20 },
      { text: 'Bake at 180 °C until the top is bronzed and the edges bubble.', passiveMin: 45 },
      { text: 'Rest before cutting, or it will slump.', passiveMin: 20 },
    ],
  },
  {
    id: 'r-chicken-pie',
    outputItemId: 'chicken-pie',
    yieldQty: 1600,
    yieldUom: 'g',
    servings: 4,
    massYield: 0.88,
    components: [
      { itemId: 'shortcrust', qty: 500, uom: 'g' },
      { itemId: 'veloute', qty: 600, uom: 'ml' },
      { itemId: 'chicken-thigh', qty: 600, uom: 'g', prep: 'in 3 cm pieces' },
      { itemId: 'leek', qty: 300, uom: 'g', lossPct: 0.2, prep: 'sliced, washed well' },
      { itemId: 'butter', qty: 25, uom: 'g' },
      { itemId: 'egg', qty: 1, uom: 'ea', scalable: false, prep: 'beaten, to glaze' },
      { itemId: 'parsley', qty: 10, uom: 'g', optional: true },
    ],
    steps: [
      { text: 'Colour the chicken, soften the leeks in the same pan.', activeMin: 15 },
      { text: 'Fold through the velouté, cool completely before it meets pastry.', activeMin: 5, passiveMin: 45 },
      { text: 'Line, fill, lid, glaze, bake at 190 °C.', activeMin: 15, passiveMin: 40 },
    ],
  },
  {
    id: 'r-minestrone',
    outputItemId: 'minestrone',
    yieldQty: 2000,
    yieldUom: 'ml',
    servings: 4,
    components: [
      { itemId: 'soffritto', qty: 300, uom: 'g' },
      { itemId: 'chicken-stock', qty: 1200, uom: 'ml' },
      { itemId: 'chopped-tomatoes', qty: 400, uom: 'g' },
      { itemId: 'borlotti', qty: 400, uom: 'g', prep: 'drained' },
      { itemId: 'courgette', qty: 200, uom: 'g', lossPct: 0.05 },
      { itemId: 'ditalini', qty: 120, uom: 'g' },
      { itemId: 'parmesan', qty: 40, uom: 'g', optional: true, prep: 'to serve' },
      { itemId: 'olive-oil', qty: 2, uom: 'tbsp' },
      { itemId: 'salt', qty: 1, uom: 'tsp' },
    ],
    steps: [
      { text: 'Soffritto, then tomatoes and stock; simmer.', activeMin: 10, passiveMin: 25 },
      { text: 'Beans and courgette in, pasta last so it keeps its bite.', activeMin: 5, passiveMin: 12 },
    ],
  },
  {
    id: 'r-levain',
    outputItemId: 'levain',
    yieldQty: 300,
    yieldUom: 'g',
    servings: 8,
    components: [
      { itemId: 'starter', qty: 50, uom: 'g' },
      { itemId: 'bread-flour', qty: 125, uom: 'g' },
      { itemId: 'water', qty: 125, uom: 'ml' },
    ],
    steps: [{ text: 'Mix and leave until domed and just past peak.', activeMin: 3, passiveMin: 300 }],
  },
  {
    id: 'r-sourdough',
    outputItemId: 'sourdough',
    yieldQty: 900,
    yieldUom: 'g',
    servings: 8,
    massYield: 0.85,
    components: [
      { itemId: 'levain', qty: 200, uom: 'g' },
      { itemId: 'bread-flour', qty: 500, uom: 'g' },
      { itemId: 'water', qty: 350, uom: 'ml' },
      { itemId: 'salt', qty: 10, uom: 'g' },
    ],
    steps: [
      { text: 'Mix, autolyse, then fold every 30 minutes for three hours.', activeMin: 20, passiveMin: 180 },
      { text: 'Shape and retard in the fridge overnight.', activeMin: 10, passiveMin: 720 },
      { text: 'Bake from cold, lid on 20 minutes, lid off 20 minutes.', activeMin: 5, passiveMin: 40 },
    ],
  },
];

/** Opening pantry stock: enough to make the planning run interesting. */
interface SeedLot {
  itemId: string;
  qty: number;
  ageDays: number;
  expiresInDays?: number;
  unitCost?: number;
}

const OPENING_STOCK: SeedLot[] = [
  { itemId: 'flour', qty: 900, ageDays: 40, unitCost: 0.00097 },
  { itemId: 'flour-00', qty: 250, ageDays: 20, unitCost: 0.0023 },
  { itemId: 'bread-flour', qty: 1200, ageDays: 12, unitCost: 0.0013 },
  { itemId: 'olive-oil', qty: 400, ageDays: 60, unitCost: 0.00867 },
  { itemId: 'salt', qty: 380, ageDays: 200, unitCost: 0.0015 },
  { itemId: 'pepper', qty: 40, ageDays: 200, unitCost: 0.042 },
  { itemId: 'nutmeg', qty: 25, ageDays: 300, unitCost: 0.083 },
  { itemId: 'bay-leaf', qty: 14, ageDays: 300, unitCost: 0.055 },
  { itemId: 'thyme', qty: 15, ageDays: 120, unitCost: 0.065 },
  { itemId: 'passata', qty: 500, ageDays: 30, unitCost: 0.0019 },
  { itemId: 'chopped-tomatoes', qty: 800, ageDays: 45, unitCost: 0.0021 },
  { itemId: 'borlotti', qty: 400, ageDays: 60, unitCost: 0.00225 },
  { itemId: 'ditalini', qty: 500, ageDays: 30, unitCost: 0.0022 },
  { itemId: 'red-wine', qty: 550, ageDays: 5, unitCost: 0.00933 },
  { itemId: 'starter', qty: 180, ageDays: 2, expiresInDays: 30, unitCost: 0 },
  { itemId: 'water', qty: 50_000, ageDays: 0, unitCost: 0.0000015 },
  // Chilled, and going off soon — this is what the expiry report should catch.
  { itemId: 'butter', qty: 180, ageDays: 20, expiresInDays: 9, unitCost: 0.0088 },
  { itemId: 'milk', qty: 1200, ageDays: 4, expiresInDays: 3, unitCost: 0.000725 },
  { itemId: 'egg', qty: 5, ageDays: 9, expiresInDays: 11, unitCost: 0.325 },
  { itemId: 'parmesan', qty: 90, ageDays: 15, expiresInDays: 40, unitCost: 0.0225 },
  { itemId: 'onion', qty: 450, ageDays: 6, expiresInDays: 20, unitCost: 0.00105 },
  { itemId: 'carrot', qty: 300, ageDays: 6, expiresInDays: 12, unitCost: 0.0009 },
  { itemId: 'celery', qty: 200, ageDays: 6, expiresInDays: 6, unitCost: 0.002125 },
  { itemId: 'garlic', qty: 60, ageDays: 10, expiresInDays: 40, unitCost: 0.009 },
  // A block of stock in the freezer: MRP should net against this rather than
  // planning a five-hour stock-making session.
  { itemId: 'chicken-stock', qty: 1000, ageDays: 30, expiresInDays: 60, unitCost: 0.0021 },
];

export interface SeedOptions {
  /** The Monday-ish anchor for the sample meal plan. Defaults to today. */
  readonly from?: IsoDate;
  /** Skip the sample meal plan and opening stock — item master only. */
  readonly bare?: boolean;
}

/** Build the demo database. */
export function seedDatabase(options: SeedOptions = {}): Database {
  const from = options.from ?? today();

  const db = emptyDb({
    currency: 'GBP',
    overheadPerHour: 0.42,
    planningHorizonDays: 7,
    household: [
      { name: 'Ada', appetite: 1 },
      { name: 'Ben', appetite: 1.1, avoids: ['shellfish'] },
      { name: 'Cleo', appetite: 0.6, avoids: ['milk'] },
    ],
  });

  db.suppliers = [...SUPPLIERS];
  db.items = [...PURCHASED, ...MADE];
  db.recipes = [...RECIPES];

  if (options.bare) return db;

  for (const seed of OPENING_STOCK) {
    receive(db, seed.itemId, {
      qty: seed.qty,
      on: addDays(from, -seed.ageDays),
      ...(seed.expiresInDays !== undefined ? { expiresOn: addDays(from, seed.expiresInDays) } : {}),
      ...(seed.unitCost !== undefined ? { unitCost: seed.unitCost } : {}),
      note: 'opening stock',
    });
  }

  const plan: Omit<MealPlanEntry, 'id'>[] = [
    { date: addDays(from, 1), slot: 'dinner', itemId: 'minestrone', servings: 4 },
    { date: addDays(from, 2), slot: 'dinner', itemId: 'lasagne', servings: 6, note: 'Ada’s parents over' },
    { date: addDays(from, 3), slot: 'lunch', itemId: 'lasagne', servings: 2, note: 'leftovers' },
    { date: addDays(from, 4), slot: 'dinner', itemId: 'chicken-pie', servings: 4 },
    { date: addDays(from, 5), slot: 'breakfast', itemId: 'sourdough', servings: 4 },
    { date: addDays(from, 6), slot: 'dinner', itemId: 'minestrone', servings: 4 },
  ];
  db.mealPlan = plan.map((entry, index) => ({ ...entry, id: `MP-${String(index + 1).padStart(4, '0')}` }));

  return db;
}
