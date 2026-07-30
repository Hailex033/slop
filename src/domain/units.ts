/**
 * Units of measure.
 *
 * Every quantity in Mise is stored as a number plus a unit code. Internally the
 * engine normalises to a *base unit* per dimension: grams, millilitres, each.
 *
 * The interesting part is cross-dimension conversion. "200 ml of flour" only
 * means something in grams if we know flour's density; "3 eggs" only means
 * something in grams if we know what an egg weighs. Those coefficients live on
 * the item master, and callers pass them in as a `ConversionContext`.
 */

import { ConversionError } from './errors.js';

export type Dimension = 'mass' | 'volume' | 'count';

export interface UnitDef {
  readonly name: string;
  readonly plural: string;
  readonly dimension: Dimension;
  /** How many base units (g / ml / ea) make up one of this unit. */
  readonly toBase: number;
}

const UNIT_TABLE = {
  // ---- mass (base: gram) ----
  mg: { name: 'milligram', plural: 'milligrams', dimension: 'mass', toBase: 0.001 },
  g: { name: 'gram', plural: 'grams', dimension: 'mass', toBase: 1 },
  kg: { name: 'kilogram', plural: 'kilograms', dimension: 'mass', toBase: 1000 },
  oz: { name: 'ounce', plural: 'ounces', dimension: 'mass', toBase: 28.349523125 },
  lb: { name: 'pound', plural: 'pounds', dimension: 'mass', toBase: 453.59237 },

  // ---- volume (base: millilitre) ----
  ml: { name: 'millilitre', plural: 'millilitres', dimension: 'volume', toBase: 1 },
  cl: { name: 'centilitre', plural: 'centilitres', dimension: 'volume', toBase: 10 },
  dl: { name: 'decilitre', plural: 'decilitres', dimension: 'volume', toBase: 100 },
  l: { name: 'litre', plural: 'litres', dimension: 'volume', toBase: 1000 },
  tsp: { name: 'teaspoon', plural: 'teaspoons', dimension: 'volume', toBase: 4.92892159375 },
  tbsp: { name: 'tablespoon', plural: 'tablespoons', dimension: 'volume', toBase: 14.78676478125 },
  floz: { name: 'fluid ounce', plural: 'fluid ounces', dimension: 'volume', toBase: 29.5735295625 },
  cup: { name: 'cup', plural: 'cups', dimension: 'volume', toBase: 236.5882365 },
  pt: { name: 'pint', plural: 'pints', dimension: 'volume', toBase: 473.176473 },
  qt: { name: 'quart', plural: 'quarts', dimension: 'volume', toBase: 946.352946 },
  gal: { name: 'gallon', plural: 'gallons', dimension: 'volume', toBase: 3785.411784 },
  pinch: { name: 'pinch', plural: 'pinches', dimension: 'volume', toBase: 0.30805759961 },
  dash: { name: 'dash', plural: 'dashes', dimension: 'volume', toBase: 0.61611519922 },

  // ---- count (base: each) ----
  ea: { name: 'each', plural: 'each', dimension: 'count', toBase: 1 },
  doz: { name: 'dozen', plural: 'dozen', dimension: 'count', toBase: 12 },
} as const satisfies Record<string, UnitDef>;

export type UomCode = keyof typeof UNIT_TABLE;

export const UNITS: Readonly<Record<UomCode, UnitDef>> = UNIT_TABLE;

const BASE_UNIT: Record<Dimension, UomCode> = { mass: 'g', volume: 'ml', count: 'ea' };

/** Alternative spellings accepted on input (CLI, importers). */
const ALIASES: Record<string, UomCode> = {
  gram: 'g', grams: 'g', gr: 'g', gramme: 'g', grammes: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', millilitre: 'ml', milliliters: 'ml', millilitres: 'ml',
  liter: 'l', litre: 'l', liters: 'l', litres: 'l', lt: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', t: 'tsp', tsps: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbsps: 'tbsp', T: 'tbsp',
  'fluid ounce': 'floz', 'fl oz': 'floz', flozs: 'floz',
  cups: 'cup', c: 'cup',
  pint: 'pt', pints: 'pt',
  quart: 'qt', quarts: 'qt',
  gallon: 'gal', gallons: 'gal',
  each: 'ea', unit: 'ea', units: 'ea', piece: 'ea', pieces: 'ea', pc: 'ea', pcs: 'ea', x: 'ea',
  dozen: 'doz',
};

export function isUomCode(code: string): code is UomCode {
  return Object.prototype.hasOwnProperty.call(UNIT_TABLE, code);
}

/** Resolve a user-supplied unit string to a canonical code. Throws if unknown. */
export function parseUom(input: string): UomCode {
  const raw = input.trim();
  if (isUomCode(raw)) return raw;
  const lower = raw.toLowerCase();
  if (isUomCode(lower)) return lower;
  const alias = ALIASES[raw] ?? ALIASES[lower];
  if (alias) return alias;
  throw new ConversionError(`Unknown unit "${input}".`);
}

export function unitDef(code: UomCode): UnitDef {
  const def = UNIT_TABLE[code];
  if (!def) throw new ConversionError(`Unknown unit "${code}".`);
  return def;
}

export function dimensionOf(code: UomCode): Dimension {
  return unitDef(code).dimension;
}

export function baseUnitFor(dimension: Dimension): UomCode {
  return BASE_UNIT[dimension];
}

/**
 * Item-specific coefficients that let us cross between dimensions.
 * All are optional; conversion fails with a descriptive error when the one it
 * needs is absent, which is what `mise doctor` reports on.
 */
export interface ConversionContext {
  /** Grams per millilitre. Water is 1.0, flour ~0.53, honey ~1.42. */
  readonly densityGPerMl?: number;
  /** Grams for one `ea` — one egg, one onion, one clove of garlic. */
  readonly unitWeightG?: number;
  /** Millilitres displaced by one `ea`, if measured by volume rather than mass. */
  readonly unitVolumeMl?: number;
  /** Item name, used only to make error messages actionable. */
  readonly label?: string;
}

function bridge(qtyInBase: number, from: Dimension, to: Dimension, ctx: ConversionContext): number {
  const { densityGPerMl: density, unitWeightG: unitWeight, unitVolumeMl: unitVolume } = ctx;
  const who = ctx.label ? ` for "${ctx.label}"` : '';

  const need = (what: string, field: string): never => {
    throw new ConversionError(
      `Cannot convert ${from} to ${to}${who}: no ${what} defined. ` +
        `Set \`${field}\` on the item to enable this conversion.`,
    );
  };

  switch (`${from}->${to}`) {
    case 'volume->mass':
      return density ? qtyInBase * density : need('density', 'densityGPerMl');
    case 'mass->volume':
      return density ? qtyInBase / density : need('density', 'densityGPerMl');
    case 'count->mass':
      return unitWeight ? qtyInBase * unitWeight : need('unit weight', 'unitWeightG');
    case 'mass->count':
      return unitWeight ? qtyInBase / unitWeight : need('unit weight', 'unitWeightG');
    case 'count->volume':
      if (unitVolume) return qtyInBase * unitVolume;
      if (unitWeight && density) return (qtyInBase * unitWeight) / density;
      return need('unit volume (or unit weight + density)', 'unitVolumeMl');
    case 'volume->count':
      if (unitVolume) return qtyInBase / unitVolume;
      if (unitWeight && density) return (qtyInBase * density) / unitWeight;
      return need('unit volume (or unit weight + density)', 'unitVolumeMl');
    default:
      throw new ConversionError(`Unsupported conversion ${from} -> ${to}${who}.`);
  }
}

/** Convert a quantity between any two units, bridging dimensions when possible. */
export function convert(qty: number, from: UomCode, to: UomCode, ctx: ConversionContext = {}): number {
  const f = unitDef(from);
  const t = unitDef(to);
  const inBase = qty * f.toBase;
  const converted = f.dimension === t.dimension ? inBase : bridge(inBase, f.dimension, t.dimension, ctx);
  return converted / t.toBase;
}

/** Convert to the base unit of the quantity's own dimension (g / ml / ea). */
export function toBase(qty: number, from: UomCode): number {
  return qty * unitDef(from).toBase;
}

/** True when a conversion is possible without throwing. */
export function canConvert(from: UomCode, to: UomCode, ctx: ConversionContext = {}): boolean {
  try {
    convert(1, from, to, ctx);
    return true;
  } catch {
    return false;
  }
}

const VULGAR: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

/**
 * Parse quantities the way people write them on a recipe card:
 * `1.5`, `1 1/2`, `3/4`, `1½`, `½`.
 */
export function parseQuantity(input: string): number {
  const text = input.trim();
  if (!text) throw new ConversionError('Empty quantity.');

  let total = 0;
  let matched = false;
  let rest = text;

  for (const [glyph, value] of Object.entries(VULGAR)) {
    if (rest.includes(glyph)) {
      total += value;
      matched = true;
      rest = rest.replace(glyph, ' ');
    }
  }

  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const fraction = /^(\d+)\/(\d+)$/.exec(token);
    if (fraction) {
      const denominator = Number(fraction[2]);
      if (denominator === 0) throw new ConversionError(`Division by zero in quantity "${input}".`);
      total += Number(fraction[1]) / denominator;
      matched = true;
      continue;
    }
    if (/^\d*\.?\d+$/.test(token)) {
      total += Number(token);
      matched = true;
      continue;
    }
    throw new ConversionError(`Cannot parse quantity "${input}".`);
  }

  if (!matched) throw new ConversionError(`Cannot parse quantity "${input}".`);
  return total;
}
