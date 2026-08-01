/**
 * The Mise domain model.
 *
 * The central idea: **there is no separate "ingredient" and "recipe" table.**
 * Everything is an `Item` in a single item master, exactly as a manufacturing
 * ERP models parts. An item is either bought (`purchased`) or made
 * (`manufactured` / `phantom`). A made item has a `Recipe`, which is a bill of
 * materials whose components point at other items — which may themselves be
 * made. That single indirection is what produces recipe recursion: a béchamel
 * is an ingredient of a lasagne, and a roux is an ingredient of the béchamel.
 */

import type { IsoDate } from './date.js';
import type { UomCode } from './units.js';

export type ItemId = string;
export type RecipeId = string;
export type SupplierId = string;
export type LotId = string;

/**
 * How an item comes into existence.
 *
 * - `purchased`   — bought from a supplier. A leaf of every explosion.
 * - `manufactured`— made from a recipe, and *stocked*: you can have a tub of it
 *                   in the fridge, and MRP will net demand against that stock.
 * - `phantom`     — made from a recipe but never stocked. Explosion always
 *                   passes straight through it to its components. This is the
 *                   classic ERP phantom assembly, and it is precisely how a
 *                   sub-recipe behaves when you never keep it around: you don't
 *                   have "soffritto" in the fridge, you have onions and carrots.
 */
export type Sourcing = 'purchased' | 'manufactured' | 'phantom';

export type Storage = 'pantry' | 'fridge' | 'freezer' | 'counter';

export interface Nutrients {
  /** Kilocalories per 100 g. */
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly satFatG?: number;
  readonly carbG: number;
  readonly sugarG?: number;
  readonly fibreG?: number;
  readonly sodiumMg?: number;
}

export interface PurchaseInfo {
  readonly supplierId: SupplierId;
  /** The unit you buy in — a 500 g bag, a 1 l carton, a dozen eggs. */
  readonly packQty: number;
  readonly packUom: UomCode;
  /** Price of one pack, in the database's currency. */
  readonly packPrice: number;
  /** Minimum order quantity, in packs. */
  readonly moqPacks?: number;
  readonly leadTimeDays: number;
}

export interface Item {
  readonly id: ItemId;
  readonly name: string;
  /** Supermarket aisle / pantry section. Drives shopping-list ordering. */
  readonly category: string;
  readonly sourcing: Sourcing;
  /** The unit this item is counted in on the shelf and in the ledger. */
  readonly stockUom: UomCode;

  /** Grams per millilitre — lets the engine convert `1 cup` of this to grams. */
  readonly densityGPerMl?: number;
  /** Grams for one `ea` — one egg, one onion. */
  readonly unitWeightG?: number;
  /** Millilitres for one `ea`, when a countable thing is measured by volume. */
  readonly unitVolumeMl?: number;

  readonly purchase?: PurchaseInfo;
  readonly storage?: Storage;
  /** Days from production/purchase until it should be eaten. */
  readonly shelfLifeDays?: number;
  readonly allergens?: readonly string[];
  readonly nutrientsPer100g?: Nutrients;
  /** Keep at least this much on hand; MRP tops it back up. */
  readonly safetyStock?: number;
  readonly tags?: readonly string[];
  readonly note?: string;
}

/**
 * One line of a bill of materials.
 *
 * `itemId` may reference a purchased item (a leaf) or a made item (a branch,
 * expanded recursively). Nothing in this type distinguishes the two cases — that
 * is the whole point.
 */
export interface Component {
  readonly itemId: ItemId;
  readonly qty: number;
  readonly uom: UomCode;
  /**
   * Scale with batch size? A pinch of salt and a single bay leaf famously do
   * not double when you double the batch. Defaults to true.
   */
  readonly scalable?: boolean;
  /** Optional garnish etc. Excluded from MRP demand unless explicitly included. */
  readonly optional?: boolean;
  /**
   * Preparation loss for *this line*, as a fraction: peeling an onion loses
   * ~10 % of what you bought, so you must buy 1/(1-0.1) times what the recipe
   * calls for. Applied on the way down the explosion.
   */
  readonly lossPct?: number;
  /** "finely diced", "at room temperature". Free text, shown in the tree. */
  readonly prep?: string;
}

export interface RecipeStep {
  readonly text: string;
  /** Hands-on minutes. */
  readonly activeMin?: number;
  /** Unattended minutes — simmering, proving, chilling. Drives scheduling. */
  readonly passiveMin?: number;
}

export interface Recipe {
  readonly id: RecipeId;
  /** The item this recipe produces. One recipe per manufactured item. */
  readonly outputItemId: ItemId;
  /** What one batch makes, e.g. 1.2 kg of ragù or 12 ea of buns. */
  readonly yieldQty: number;
  readonly yieldUom: UomCode;
  /** Portions one batch serves. Meal-plan demand is expressed in servings. */
  readonly servings: number;
  readonly components: readonly Component[];
  readonly steps?: readonly RecipeStep[];
  /**
   * Mass retained after cooking, as a fraction of the input mass. A sauce
   * reduced by a third has `massYield: 0.67`; a strained stock keeps only
   * what passes the sieve.
   *
   * `yieldQty` is the ground truth for output — it already states the
   * post-reduction quantity, and per-100 g nutrition concentrates through
   * it. `massYield` is the *fallback* mass model, used when the output mass
   * cannot be derived from the item (no density, no unit weight), and
   * should agree with `yieldQty` over the recipe's input mass.
   */
  readonly massYield?: number;
  readonly source?: string;
  readonly note?: string;
}

export interface Supplier {
  readonly id: SupplierId;
  readonly name: string;
  readonly leadTimeDays: number;
  /** Days of the week this supplier is available, e.g. a Saturday market. */
  readonly deliveryDays?: readonly number[];
  readonly note?: string;
}

/**
 * A physical quantity of a physical thing, sitting in a physical place.
 * Inventory is lot-tracked so that expiry (FEFO) and actual cost are real.
 */
export interface Lot {
  readonly id: LotId;
  readonly itemId: ItemId;
  /** Remaining quantity, in the item's `stockUom`. */
  qty: number;
  readonly receivedOn: IsoDate;
  readonly expiresOn?: IsoDate;
  /** What this actually cost per `stockUom`, for actual (not standard) costing. */
  readonly unitCost?: number;
  readonly location?: Storage;
  /** Production order or purchase order that created it. */
  readonly origin?: string;
}

export type TxnType = 'receipt' | 'issue' | 'produce' | 'adjust' | 'waste';

/** The inventory ledger. Append-only; stock levels are derived from lots. */
export interface InventoryTxn {
  readonly id: string;
  readonly at: IsoDate;
  readonly type: TxnType;
  readonly itemId: ItemId;
  /** Signed quantity in the item's `stockUom`: positive in, negative out. */
  readonly qty: number;
  readonly lotId?: LotId;
  readonly unitCost?: number;
  readonly ref?: string;
  readonly note?: string;
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** The master production schedule: what the household intends to eat, and when. */
export interface MealPlanEntry {
  readonly id: string;
  readonly date: IsoDate;
  readonly slot: MealSlot;
  readonly itemId: ItemId;
  readonly servings: number;
  /**
   * Set when the meal has actually been served. A served entry is history,
   * not demand: without this, serving tonight's dinner and re-running MRP
   * planned a replacement batch for food already eaten.
   */
  servedOn?: IsoDate;
  readonly note?: string;
}

export type OrderStatus = 'planned' | 'open' | 'received' | 'cancelled';

export interface PurchaseOrderLine {
  readonly itemId: ItemId;
  /** Number of packs, not loose quantity — you buy bags, not grams. */
  readonly packs: number;
  /**
   * The pack size as it stood when the order was raised. An order is a record
   * of a commitment, not a view over the live item master: editing an item's
   * pack from 100 g to 250 g must not retroactively turn a one-pack order into
   * a 250 g receipt. Optional only for orders saved before this was recorded —
   * readers fall back to the current master for those.
   */
  readonly packQty?: number;
  readonly packUom?: UomCode;
  readonly unitPrice: number;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly supplierId: SupplierId;
  readonly orderedOn: IsoDate;
  readonly expectedOn: IsoDate;
  status: OrderStatus;
  readonly lines: readonly PurchaseOrderLine[];
}

/** A firm intention to cook something — the make-side counterpart of a PO. */
export interface ProductionOrder {
  readonly id: string;
  readonly itemId: ItemId;
  /**
   * Quantity still to make, in the item's `stockUom`. Mutable for the same
   * reason a lot's quantity is: a cascade that fulfils *part* of this order
   * has already fed that part to its parent, so the remaining commitment is
   * genuinely smaller.
   */
  qty: number;
  readonly dueOn: IsoDate;
  readonly startOn: IsoDate;
  status: OrderStatus;
  /** The meal plan entry or parent order that created the demand. */
  readonly pegging?: string;
  /**
   * The optional-components policy of the run that committed this order.
   * Planning and execution both reuse it: a batch committed with its
   * garnish keeps its garnish, whatever flag a later run happens to use.
   * Absent on orders saved before this was recorded — treated as false.
   */
  readonly includeOptional?: boolean;
}

export interface HouseholdMember {
  readonly name: string;
  /** Portion multiplier. A teenager is 1.5; a toddler is 0.4. */
  readonly appetite: number;
  readonly avoids?: readonly string[];
}

export interface Settings {
  readonly currency: string;
  readonly household: readonly HouseholdMember[];
  /** Energy/overhead absorbed per hour of cooking, for full recipe costing. */
  readonly overheadPerHour: number;
  /** Days of cover MRP plans for by default. */
  readonly planningHorizonDays: number;
}

/** The whole home ERP, in one serialisable object. */
export interface Database {
  settings: Settings;
  items: Item[];
  recipes: Recipe[];
  suppliers: Supplier[];
  lots: Lot[];
  ledger: InventoryTxn[];
  mealPlan: MealPlanEntry[];
  purchaseOrders: PurchaseOrder[];
  productionOrders: ProductionOrder[];
}
