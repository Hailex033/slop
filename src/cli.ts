#!/usr/bin/env node
/**
 * The Mise command line.
 *
 * Two families of commands, which is the whole thesis of the app:
 *   - recipe-side  : tree, where-used, cost, nutrition, scale
 *   - household-side: stock, plan, mrp, shop, prep, cook, serve
 * They are the same data, read in two directions.
 */

import {
  conversionContext,
  findItem,
  findSupplier,
  householdServings,
  mustItem,
  recipeFor,
  remainingServings,
  resolveItem,
  validate,
} from './domain/db.js';
import { addDays, formatDate, parseDate, today, type IsoDate } from './domain/date.js';
import { MiseError } from './domain/errors.js';
import { nextId } from './domain/ids.js';
import { convert, parseQuantity, parseUom, type UomCode } from './domain/units.js';
import { MEAL_SLOTS } from './domain/types.js';
import type { Database, ItemId, MealSlot } from './domain/types.js';
import { seedDatabase } from './data/seed.js';
import { aggregate, explode, quantityForServings, servingsForQuantity, type BomNode } from './engine/explode.js';
import { findCycles, lowLevelCodes, recipeDepth, whereUsed } from './engine/graph.js';
import {
  availableOn,
  expiring,
  receive,
  stockReport,
  stockValue,
  sweepExpired,
} from './engine/inventory.js';
import { commitProduction, runMrp } from './engine/mrp.js';
import { bySupplier, raisePurchaseOrders, receivePurchaseOrder, shoppingList } from './engine/procurement.js';
import {
  almostCookable,
  cook,
  cookableNow,
  executeOrder,
  feasibility,
  prepSchedule,
  serve,
} from './engine/production.js';
import {
  costOf,
  dietaryConflicts,
  nutritionOf,
  purchaseUnitCost,
  rollupAllergens,
  rollupTime,
  rollupUnitCost,
} from './engine/rollup.js';
import * as f from './report/format.js';
import { defaultDbPath, dbExists, loadDb, saveDb } from './store.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  readonly positionals: string[];
  readonly flags: Record<string, string | boolean>;
}

const SHORT: Record<string, string> = {
  s: 'servings',
  q: 'qty',
  u: 'uom',
  d: 'days',
  n: 'limit',
  h: 'horizon',
};

/**
 * A token that can serve as a flag's value: anything that is not another flag.
 * Negative numbers count — `-q -5` should reach the parser and be rejected
 * there, rather than being silently dropped and the command quietly doing
 * something else.
 */
function isValue(token: string | undefined): token is string {
  return token !== undefined && (!token.startsWith('-') || /^-\d/.test(token));
}

/**
 * Flags that never take a value, on any command. A flag missing from this
 * list (and from the command's own `booleanFlags`) will consume the next
 * token as its value — which is exactly what turned `--optional lasagne`
 * into an optional of "lasagne" and a command with no item.
 */
const COMMON_BOOLEAN_FLAGS = [
  'optional',
  'dry',
  'force',
  'commit',
  'low',
  'almost',
  'ignore-stock',
  'bare',
  'no-color',
] as const;

export function parseArgs(argv: readonly string[], booleans: ReadonlySet<string> = new Set()): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      // Split at the *first* `=` only, keeping the rest of the value intact:
      // split-with-limit truncates, so `--db=/tmp/mise=prod.json` would
      // quietly become /tmp/mise and overwrite an unrelated file.
      const raw = token.slice(2);
      const eq = raw.indexOf('=');
      const key = eq === -1 ? raw : raw.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (!booleans.has(key) && isValue(argv[i + 1])) {
        flags[key] = argv[i + 1]!;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const key = SHORT[token.slice(1)] ?? token.slice(1);
      if (!booleans.has(key) && isValue(argv[i + 1])) {
        flags[key] = argv[i + 1]!;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

export function numberFlag(args: Args, name: string, fallback: number): number {
  const raw = args.flags[name];
  if (raw === undefined) return fallback;
  // Supplied is supplied: a bare `--horizon` or `--horizon nope` must not
  // quietly plan — and commit — a different horizon than the one asked for.
  // The empty string would sail through as Number('') === 0.
  if (raw === true || raw === '') throw new MiseError(`--${name} needs a number.`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new MiseError(`--${name} must be a number, not "${raw}".`);
  }
  return parsed;
}

export function stringFlag(args: Args, name: string): string | undefined {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  // The same rule for words: a bare `--db` parses as boolean true, and
  // falling back to the default path would mutate the very database the
  // flag was there to steer away from.
  if (typeof raw !== 'string' || raw === '') throw new MiseError(`--${name} needs a value.`);
  return raw;
}

function boolFlag(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

/** A `--horizon` that could actually be planned: whole days, at least one. */
export function horizonFlag(args: Args, fallback: number): number {
  const days = numberFlag(args, 'horizon', fallback);
  // Zero ends the window yesterday and reports an empty plan — and a
  // successful zero-order commit — while a fraction breaks day arithmetic.
  if (!Number.isInteger(days) || days < 1) {
    throw new MiseError(`--horizon must be a whole number of days, at least 1 — not ${days}.`);
  }
  return days;
}

// `mise tree lasagne | head` closes stdout early. That is the reader saying
// "enough", not an error: exit quietly instead of dying with an EPIPE stack,
// the way every other well-behaved CLI does.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Ctx {
  db: Database;
  args: Args;
  path: string;
  dirty: boolean;
}

/** Resolve the item argument and the amount wanted, in one place. */
function targetOf(ctx: Ctx, ref: string): { itemId: ItemId; qty: number; uom: UomCode; servings: number } {
  const item = resolveItem(ctx.db, ref);
  const servingsFlag = stringFlag(ctx.args, 'servings');
  const qtyFlag = stringFlag(ctx.args, 'qty');

  if (qtyFlag !== undefined) {
    const uom = (stringFlag(ctx.args, 'uom') ? parseUom(stringFlag(ctx.args, 'uom')!) : item.stockUom) as UomCode;
    const amount = parseQuantity(qtyFlag);
    return {
      itemId: item.id,
      qty: amount,
      uom,
      servings: servingsForQuantity(ctx.db, item.id, amount, uom),
    };
  }

  const recipe = recipeFor(ctx.db, item.id);
  const servings =
    servingsFlag !== undefined ? parseQuantity(servingsFlag) : (recipe?.servings ?? 1);
  const resolved = quantityForServings(ctx.db, item.id, servings);
  return { itemId: item.id, qty: resolved.qty, uom: resolved.uom, servings };
}

function costMap(db: Database, includeOptional = false): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of db.items) {
    try {
      map.set(item.id, rollupUnitCost(db, item.id, { includeOptional }).total);
    } catch {
      /* leave it out of the map; the list simply won't annotate it */
    }
  }
  return map;
}

/**
 * Per-node tree pricing: cost the node's own quantity, not unit rate × qty.
 * A fixed component does not repeat per batch, so a two-batch node with one
 * bay leaf inside costs one leaf — the same answer `mise cost` and the cook
 * itself give. (The flat map above stays right for leaf tables: purchased
 * items really are linear.)
 */
function nodeCoster(db: Database, includeOptional: boolean): (node: BomNode) => number | undefined {
  return (node) => {
    try {
      return costOf(db, node.itemId, node.grossQty, node.uom, { includeOptional }).total;
    } catch {
      return undefined; // no conversion path — this node goes unannotated
    }
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Command = {
  readonly usage: string;
  readonly summary: string;
  readonly group: 'recipes' | 'pantry' | 'planning' | 'admin';
  readonly needsDb?: boolean;
  /**
   * Valueless flags specific to this command, beyond COMMON_BOOLEAN_FLAGS.
   * Needed when a name is boolean here but takes a value elsewhere —
   * `tree --cost` shows costs, `stock add --cost 2` records £2.
   */
  readonly booleanFlags?: readonly string[];
  readonly run: (ctx: Ctx) => void;
};

const commands: Record<string, Command> = {
  init: {
    usage: 'mise init [--force] [--bare]',
    summary: 'Create a database, seeded with a worked example household.',
    group: 'admin',
    needsDb: false,
    run: (ctx) => {
      if (dbExists(ctx.path) && !boolFlag(ctx.args, 'force')) {
        throw new MiseError(`${ctx.path} already exists. Pass --force to overwrite it.`);
      }
      const db = seedDatabase({ bare: boolFlag(ctx.args, 'bare') });
      saveDb(db, ctx.path);
      out(`${f.style('✓', 'green')} Wrote ${ctx.path}`);
      out(
        `  ${db.items.length} items, ${db.recipes.length} recipes, ` +
          `${db.lots.length} lots, ${db.mealPlan.length} planned meals.`,
      );
      out();
      out(`  Try: ${f.style('mise tree lasagne', 'cyan')}`);
      out(`       ${f.style('mise mrp', 'cyan')}`);
      out(`       ${f.style('mise shop', 'cyan')}`);
    },
  },

  // ---- recipe side -------------------------------------------------------

  tree: {
    usage: 'mise tree <item> [-s servings | -q qty -u uom] [--cost] [--depth N] [--optional] [--stop <item,...>]',
    summary: 'Explode a recipe into its full recursive tree.',
    group: 'recipes',
    booleanFlags: ['cost'],
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise tree <item>');
      const target = targetOf(ctx, ref);
      const item = mustItem(ctx.db, target.itemId);

      const stopAt = stringFlag(ctx.args, 'stop');
      const tree = explode(ctx.db, {
        itemId: target.itemId,
        qty: target.qty,
        uom: target.uom,
        includeOptional: boolFlag(ctx.args, 'optional'),
        ...(stopAt
          ? { stopAt: new Set(stopAt.split(',').map((s) => resolveItem(ctx.db, s.trim()).id)) }
          : {}),
      });

      const depth = recipeDepth(ctx.db, target.itemId);
      out(f.heading(`${item.name} — ${f.qty(target.qty, target.uom)}, ${f.num(target.servings)} servings`));
      out();
      out(
        f.renderTree(tree, {
          ...(boolFlag(ctx.args, 'cost')
            ? { costOfNode: nodeCoster(ctx.db, boolFlag(ctx.args, 'optional')) }
            : {}),
          currency: ctx.db.settings.currency,
          ...(ctx.args.flags['depth'] ? { maxDepth: numberFlag(ctx.args, 'depth', 99) } : {}),
        }),
      );

      const leaves = aggregate(tree, { level: 'leaves' });
      // Same toggle as the tree above it: with --optional the branch is
      // displayed, so its minutes belong in the headline too.
      const time = rollupTime(ctx.db, target.itemId, target.qty, target.uom, {
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      out();
      out(
        f.style(
          `  ${depth} levels deep · ${leaves.length} things to buy · ` +
            `${f.minutes(time.activeMin)} hands-on, ${f.minutes(time.criticalPathMin)} start to finish`,
          'grey',
        ),
      );
    },
  },

  ingredients: {
    usage: 'mise ingredients <item> [-s servings]',
    summary: 'Flat, aggregated ingredient list — the tree rolled up to what you buy.',
    group: 'recipes',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise ingredients <item>');
      const target = targetOf(ctx, ref);
      const item = mustItem(ctx.db, target.itemId);
      const tree = explode(ctx.db, {
        itemId: target.itemId,
        qty: target.qty,
        uom: target.uom,
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      const requirements = aggregate(tree, { level: 'leaves' });
      const costs = costMap(ctx.db, boolFlag(ctx.args, 'optional'));

      out(f.heading(`${item.name} — ingredients for ${f.num(target.servings)} servings`));
      out(
        f.table(requirements, [
          { header: 'Ingredient', get: (r) => r.item.name },
          { header: 'Quantity', get: (r) => f.qty(r.qty, r.uom), align: 'right' },
          { header: 'Cost', get: (r) => f.money((costs.get(r.itemId) ?? 0) * r.qty, ctx.db.settings.currency), align: 'right' },
          { header: 'In stock', get: (r) => f.qty(availableOn(ctx.db, r.itemId, today()), r.uom), align: 'right' },
          {
            header: 'Used in',
            get: (r) =>
              [...r.usedIn]
                .map((id) => mustItem(ctx.db, id).name)
                .sort()
                .join(', '),
          },
        ]),
      );
    },
  },

  'where-used': {
    usage: 'mise where-used <item>',
    summary: 'Reverse explosion: every recipe that depends on an ingredient.',
    group: 'recipes',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise where-used <item>');
      const item = resolveItem(ctx.db, ref);
      const tree = whereUsed(ctx.db, item.id);
      out(f.heading(`Where "${item.name}" is used`));
      out();
      out(f.renderWhereUsed(tree));
      const codes = lowLevelCodes(ctx.db);
      out();
      out(f.style(`  Low-level code ${codes.get(item.id) ?? 0} — planned after everything that contains it.`, 'grey'));
    },
  },

  cost: {
    usage: 'mise cost <item> [-s servings] [--optional]',
    summary: 'Rolled-up cost, broken down by where the money goes.',
    group: 'recipes',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise cost <item>');
      const target = targetOf(ctx, ref);
      const item = mustItem(ctx.db, target.itemId);
      const report = costOf(ctx.db, target.itemId, target.qty, target.uom, {
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      const currency = ctx.db.settings.currency;

      out(f.heading(`${item.name} — cost of ${f.qty(report.qty, report.uom)}`));
      out();
      out(`  Materials     ${f.money(report.materials, currency)}`);
      if (report.overhead > 0) out(`  Energy        ${f.money(report.overhead, currency)}`);
      out(`  ${f.style('Total', 'bold')}         ${f.style(f.money(report.total, currency), 'bold', 'green')}`);
      out(`  Per serving   ${f.style(f.money(report.perServing, currency), 'green')} (${f.num(report.servings)} servings)`);
      out();
      out(
        f.table(report.lines.filter((line) => line.cost > 0.001), [
          { header: 'Ingredient', get: (l) => l.name },
          { header: 'Quantity', get: (l) => f.qty(l.qty, l.uom), align: 'right' },
          { header: 'Cost', get: (l) => f.money(l.cost, currency), align: 'right' },
          { header: 'Share', get: (l) => `${f.bar(l.share, 12)} ${f.pad(f.percent(l.share), 4, 'right')}` },
        ]),
      );
      if (!report.complete) {
        out();
        out(f.style(`  ! No price for: ${report.missing.join(', ')}`, 'yellow'));
      }
    },
  },

  nutrition: {
    usage: 'mise nutrition <item> [-s servings] [--optional]',
    summary: 'Nutrition rolled up through every sub-recipe.',
    group: 'recipes',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise nutrition <item>');
      const target = targetOf(ctx, ref);
      const item = mustItem(ctx.db, target.itemId);
      const facts = nutritionOf(ctx.db, target.itemId, target.qty, target.uom, {
        includeOptional: boolFlag(ctx.args, 'optional'),
      });

      out(f.heading(`${item.name} — nutrition`));
      out();
      const rows = [
        { label: 'Energy', per: `${f.num(facts.perServing.kcal)} kcal`, hundred: `${f.num(facts.per100g.kcal)} kcal` },
        { label: 'Protein', per: `${f.num(facts.perServing.proteinG)} g`, hundred: `${f.num(facts.per100g.proteinG)} g` },
        { label: 'Fat', per: `${f.num(facts.perServing.fatG)} g`, hundred: `${f.num(facts.per100g.fatG)} g` },
        { label: '  of which saturates', per: `${f.num(facts.perServing.satFatG ?? 0)} g`, hundred: `${f.num(facts.per100g.satFatG ?? 0)} g` },
        { label: 'Carbohydrate', per: `${f.num(facts.perServing.carbG)} g`, hundred: `${f.num(facts.per100g.carbG)} g` },
        { label: '  of which sugars', per: `${f.num(facts.perServing.sugarG ?? 0)} g`, hundred: `${f.num(facts.per100g.sugarG ?? 0)} g` },
        { label: 'Fibre', per: `${f.num(facts.perServing.fibreG ?? 0)} g`, hundred: `${f.num(facts.per100g.fibreG ?? 0)} g` },
        { label: 'Salt', per: `${f.num(((facts.perServing.sodiumMg ?? 0) * 2.5) / 1000)} g`, hundred: `${f.num(((facts.per100g.sodiumMg ?? 0) * 2.5) / 1000)} g` },
      ];
      out(
        f.table(rows, [
          { header: '', get: (r) => r.label },
          { header: 'Per serving', get: (r) => r.per, align: 'right' },
          { header: 'Per 100 g', get: (r) => r.hundred, align: 'right' },
        ]),
      );
      out();
      out(f.style(`  ${f.num(facts.servings)} servings · ${f.qty(facts.grams, 'g')} total`, 'grey'));

      const allergens = rollupAllergens(ctx.db, target.itemId);
      if (allergens.length > 0) {
        out();
        out(
          `  Allergens: ${allergens
            .map((a) => (a.onlyOptional ? f.style(`${a.allergen} (optional only)`, 'grey') : f.style(a.allergen, 'yellow')))
            .join(', ')}`,
        );
      }
      const conflicts = dietaryConflicts(ctx.db, target.itemId, {
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      for (const conflict of conflicts) {
        out(f.style(`  ! ${conflict.member} avoids ${conflict.allergens.join(', ')}`, 'red'));
      }
      if (!facts.complete) {
        out();
        out(f.style(`  ! No nutrition data for: ${facts.missing.join(', ')}`, 'yellow'));
      }
    },
  },

  scale: {
    usage: 'mise scale <item> -s <servings>',
    summary: 'Rewrite a recipe for a different number of people.',
    group: 'recipes',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise scale <item> -s <servings>');
      const item = resolveItem(ctx.db, ref);
      const recipe = recipeFor(ctx.db, item.id);
      if (!recipe) throw new MiseError(`"${item.name}" has no recipe to scale.`);

      const wanted = numberFlag(ctx.args, 'servings', householdServings(ctx.db));
      const factor = wanted / recipe.servings;

      out(f.heading(`${item.name} — scaled from ${recipe.servings} to ${f.num(wanted)} servings (×${f.num(factor)})`));
      out(
        f.table(recipe.components, [
          { header: 'Component', get: (c) => mustItem(ctx.db, c.itemId).name },
          { header: 'Original', get: (c) => `${f.num(c.qty)} ${c.uom}`, align: 'right' },
          {
            header: 'Scaled',
            get: (c) => f.style(`${f.num(c.scalable === false ? c.qty : c.qty * factor)} ${c.uom}`, 'bold'),
            align: 'right',
          },
          { header: '', get: (c) => (c.scalable === false ? f.style('fixed', 'blue') : c.prep ? f.style(c.prep, 'grey') : '') },
        ]),
      );
      out();
      out(f.style(`  Yields ${f.qty(recipe.yieldQty * factor, recipe.yieldUom as UomCode)}`, 'grey'));
    },
  },

  // ---- pantry ------------------------------------------------------------

  stock: {
    usage: 'mise stock [--expiring N] [--low] | stock add <item> <qty> [uom] [--expires DATE] [--cost TOTAL]',
    summary: 'What is in the house, by lot, with expiry.',
    group: 'pantry',
    run: (ctx) => {
      if (ctx.args.positionals[0] === 'add') {
        const [, ref, rawQty, rawUom] = ctx.args.positionals;
        if (!ref || !rawQty) throw new MiseError('Usage: mise stock add <item> <qty> [uom]');
        const item = resolveItem(ctx.db, ref);
        const uom = rawUom ? parseUom(rawUom) : item.stockUom;
        const expires = stringFlag(ctx.args, 'expires');
        const cost = stringFlag(ctx.args, 'cost');
        const amount = parseQuantity(rawQty);
        // `--cost` is what the whole lot cost. Lots store cost per *stock*
        // unit, so divide by the converted quantity, not the entered one:
        // "1 kg for £2" is £0.002 a gram, not £2 a gram.
        const inStockUnits = convert(amount, uom, item.stockUom, conversionContext(item));

        let unitCost: number | undefined;
        if (typeof cost === 'string') {
          const total = Number(cost);
          // A typo must not reach the ledger: NaN survives arithmetic, then
          // serialises to null, and the pantry quietly values itself at zero.
          if (!Number.isFinite(total) || total < 0) {
            throw new MiseError(`--cost must be a non-negative number, not "${cost}".`);
          }
          if (inStockUnits > 0) unitCost = total / inStockUnits;
        }

        const lot = receive(ctx.db, item.id, {
          qty: amount,
          uom,
          ...(expires ? { expiresOn: parseDate(expires) } : {}),
          ...(unitCost !== undefined ? { unitCost } : {}),
        });
        ctx.dirty = true;
        out(`${f.style('✓', 'green')} ${lot.id}: ${f.qty(lot.qty, item.stockUom)} of ${item.name}` +
          (lot.expiresOn ? f.style(` (use by ${formatDate(lot.expiresOn)})`, 'grey') : ''));
        return;
      }

      const soon = numberFlag(ctx.args, 'expiring', -1);
      if (soon >= 0) {
        const rows = expiring(ctx.db, soon);
        out(f.heading(`Expiring within ${soon} days`));
        out(
          f.table(rows, [
            { header: 'Item', get: (r) => r.item.name },
            { header: 'Qty', get: (r) => f.qty(r.lot.qty, r.item.stockUom), align: 'right' },
            { header: 'Use by', get: (r) => formatDate(r.lot.expiresOn!) },
            {
              header: '',
              get: (r) =>
                r.daysLeft < 0
                  ? f.style(`${-r.daysLeft}d over`, 'red')
                  : f.style(`${r.daysLeft}d left`, r.daysLeft <= 2 ? 'yellow' : 'grey'),
            },
          ]),
        );
        return;
      }

      const lines = stockReport(ctx.db).filter((line) => !boolFlag(ctx.args, 'low') || line.belowSafety);
      out(f.heading('Pantry'));
      out(
        f.table(lines, [
          { header: 'Item', get: (l) => (l.belowSafety ? f.style(l.item.name, 'yellow') : l.item.name) },
          { header: 'Category', get: (l) => f.style(l.item.category, 'grey') },
          { header: 'On hand', get: (l) => f.qty(l.qty, l.uom), align: 'right' },
          {
            header: 'Usable',
            get: (l) =>
              l.usable < l.qty - 1e-9
                ? f.style(f.qty(l.usable, l.uom), 'yellow')
                : f.style('all', 'grey'),
            align: 'right',
          },
          { header: 'Lots', get: (l) => String(l.lots), align: 'right' },
          { header: 'Value', get: (l) => f.money(l.value, ctx.db.settings.currency), align: 'right' },
          { header: 'Next expiry', get: (l) => (l.nextExpiry ? formatDate(l.nextExpiry) : f.style('—', 'grey')) },
        ]),
      );
      out();
      out(f.style(`  ${lines.length} items · ${f.money(stockValue(ctx.db), ctx.db.settings.currency)} at cost`, 'grey'));
    },
  },

  waste: {
    usage: 'mise waste',
    summary: 'Write off anything past its date, and count the cost.',
    group: 'pantry',
    run: (ctx) => {
      const wasted = sweepExpired(ctx.db);
      ctx.dirty = wasted.length > 0;
      if (wasted.length === 0) {
        out(`${f.style('✓', 'green')} Nothing has gone off.`);
        return;
      }
      out(f.heading('Written off'));
      out(
        f.table(wasted, [
          { header: 'Item', get: (w) => mustItem(ctx.db, w.itemId).name },
          { header: 'Qty', get: (w) => f.qty(w.qty, mustItem(ctx.db, w.itemId).stockUom), align: 'right' },
          { header: 'Cost', get: (w) => f.money(w.cost, ctx.db.settings.currency), align: 'right' },
        ]),
      );
      out();
      out(
        f.style(
          `  ${f.money(wasted.reduce((sum, w) => sum + w.cost, 0), ctx.db.settings.currency)} binned.`,
          'red',
        ),
      );
    },
  },

  feasible: {
    usage: 'mise feasible [--almost]',
    summary: 'What you could cook right now, from stock alone.',
    group: 'pantry',
    run: (ctx) => {
      if (boolFlag(ctx.args, 'almost')) {
        const near = almostCookable(ctx.db, numberFlag(ctx.args, 'missing', 2));
        out(f.heading('Nearly there'));
        out(
          f.table(near, [
            { header: 'Dish', get: (r) => r.name },
            { header: 'Have', get: (r) => `${f.bar(r.coverage, 10)} ${f.pad(f.percent(r.coverage), 4, 'right')}` },
            {
              header: 'Missing',
              get: (r) => r.missing.map((m) => `${m.name} (${f.qty(m.short, m.uom as UomCode)})`).join(', '),
            },
          ]),
        );
        return;
      }

      const options = cookableNow(ctx.db);
      out(f.heading('Cookable now'));
      out(
        f.table(options, [
          { header: 'Dish', get: (r) => r.name },
          { header: 'Servings', get: (r) => f.num(Math.floor(r.servings * 10) / 10), align: 'right' },
          { header: 'Start to finish', get: (r) => f.minutes(r.criticalPathMin), align: 'right' },
        ]),
      );
      if (options.length === 0) {
        out(f.style('  Nothing is fully covered. Try `mise feasible --almost`.', 'grey'));
      }
    },
  },

  // ---- planning ----------------------------------------------------------

  plan: {
    usage: 'mise plan [add <date> <slot> <item> [servings] | rm <id>]',
    summary: 'The meal plan — this app’s master production schedule.',
    group: 'planning',
    run: (ctx) => {
      const [action] = ctx.args.positionals;

      if (action === 'add') {
        const [, rawDate, rawSlot, ref, rawServings] = ctx.args.positionals;
        if (!rawDate || !rawSlot || !ref) {
          throw new MiseError('Usage: mise plan add <date> <slot> <item> [servings]');
        }
        const item = resolveItem(ctx.db, ref);
        const servings = rawServings ? parseQuantity(rawServings) : householdServings(ctx.db);
        // Zero would persist too: the plan would show a meal, MRP would
        // silently skip it, and doctor would call the file invalid — all
        // from one well-formed command. Infinity — a mangled household
        // appetite summed into the default — serialises to null.
        if (!Number.isFinite(servings) || servings <= 0) {
          throw new MiseError(`A meal needs a positive number of servings, not ${servings}.`);
        }
        // "supper" would persist, survive saves, and pass doctor — a typo
        // must not become a permanent fifth meal slot.
        if (!(MEAL_SLOTS as readonly string[]).includes(rawSlot)) {
          throw new MiseError(`Unknown slot "${rawSlot}". Use one of: ${MEAL_SLOTS.join(', ')}.`);
        }
        // A phantom is never stocked, so a plan entry for one could never be
        // cooked into stock or served: MRP would buy its ingredients for a
        // dinner that cannot happen, and the entry would sit as demand forever.
        if (item.sourcing === 'phantom') {
          throw new MiseError(
            `"${item.name}" is a phantom sub-recipe, made inline by the dishes that use it — plan one of those instead.`,
          );
        }
        const entry = {
          // Removed entries whose ids live on in order pegs stay reserved:
          // a recycled id would make old commitments point at the new meal,
          // misattributing their ingredients and their settlements.
          id: nextId('MP', ctx.db.mealPlan, ctx.db.productionOrders.flatMap((o) => o.pegging ?? [])),
          date: parseDate(rawDate),
          slot: rawSlot as MealSlot,
          itemId: item.id,
          servings,
        };
        ctx.db.mealPlan.push(entry);
        ctx.dirty = true;
        out(`${f.style('✓', 'green')} ${entry.id}: ${item.name} × ${f.num(servings)} on ${formatDate(entry.date)} (${entry.slot})`);
        return;
      }

      if (action === 'rm') {
        const id = ctx.args.positionals[1];
        if (!id) throw new MiseError('Usage: mise plan rm <id>');
        const before = ctx.db.mealPlan.length;
        ctx.db.mealPlan = ctx.db.mealPlan.filter((entry) => entry.id !== id);
        if (ctx.db.mealPlan.length === before) throw new MiseError(`No plan entry "${id}".`);
        ctx.dirty = true;
        out(`${f.style('✓', 'green')} Removed ${id}.`);
        return;
      }

      const from = today();
      const horizon = horizonFlag(ctx.args, 14);
      // Same inclusive window as MRP: a 7-day horizon is today plus six, so
      // the plan shown here and the plan `mrp`/`shop`/`prep` act on agree
      // about which entries are in scope.
      // The same predicate demandFromPlan uses: a meal with nothing left to
      // serve is history — whether its completion marker was written or a
      // hand-edit only recorded the count — and listing it in the upcoming
      // count and food-cost total would disagree with the planning that
      // already considers it done.
      const entries = ctx.db.mealPlan
        .filter(
          (entry) =>
            remainingServings(entry) > 1e-9 && entry.date >= from && entry.date <= addDays(from, horizon - 1),
        )
        .sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));

      out(f.heading('Meal plan'));
      // Portions still to serve, not the original booking: after one plate
      // of a six-portion entry, five remain — the number planning uses.
      out(
        f.table(entries, [
          { header: 'Id', get: (e) => f.style(e.id, 'grey') },
          { header: 'Date', get: (e) => formatDate(e.date) },
          { header: 'Slot', get: (e) => e.slot },
          { header: 'Dish', get: (e) => mustItem(ctx.db, e.itemId).name },
          { header: 'Servings', get: (e) => f.num(remainingServings(e)), align: 'right' },
          {
            header: 'Cost',
            get: (e) => {
              const target = quantityForServings(ctx.db, e.itemId, remainingServings(e));
              return f.money(costOf(ctx.db, e.itemId, target.qty, target.uom).total, ctx.db.settings.currency);
            },
            align: 'right',
          },
          { header: '', get: (e) => f.style(e.note ?? '', 'grey', 'italic') },
        ]),
      );

      const total = entries.reduce((sum, entry) => {
        const target = quantityForServings(ctx.db, entry.itemId, remainingServings(entry));
        return sum + costOf(ctx.db, entry.itemId, target.qty, target.uom).total;
      }, 0);
      out();
      out(f.style(`  ${entries.length} meals · ${f.money(total, ctx.db.settings.currency)} of food`, 'grey'));
    },
  },

  mrp: {
    usage: 'mise mrp [--horizon N] [--ignore-stock] [--optional] [--commit]',
    summary: 'Net the plan against the pantry and work out what must happen.',
    group: 'planning',
    run: (ctx) => {
      const result = runMrp(ctx.db, {
        horizonDays: horizonFlag(ctx.args, ctx.db.settings.planningHorizonDays),
        ignoreStock: boolFlag(ctx.args, 'ignore-stock'),
        includeOptional: boolFlag(ctx.args, 'optional'),
      });

      out(f.heading(`Requirements plan — ${result.horizonDays} days from ${formatDate(result.asOf)}`));
      out(
        f.table(result.lines, [
          { header: 'Lvl', get: (l) => f.style(String(l.level), 'grey'), align: 'right' },
          { header: 'Item', get: (l) => l.name },
          { header: 'Gross', get: (l) => f.qty(l.gross, l.uom as UomCode), align: 'right' },
          { header: 'On hand', get: (l) => f.qty(l.onHand, l.uom as UomCode), align: 'right' },
          { header: 'On order', get: (l) => (l.onOrder > 0 ? f.qty(l.onOrder, l.uom as UomCode) : f.style('—', 'grey')), align: 'right' },
          { header: 'Net', get: (l) => (l.net > 0 ? f.style(f.qty(l.net, l.uom as UomCode), 'bold') : f.style('—', 'grey')), align: 'right' },
          {
            header: 'Action',
            get: (l) =>
              l.action === 'buy'
                ? f.style('buy', 'yellow')
                : l.action === 'make'
                  ? f.style('make', 'blue')
                  : l.action === 'phantom'
                    ? f.style('pass through', 'magenta')
                    : f.style('covered', 'green'),
          },
        ]),
      );

      out();
      out(
        f.style(
          `  ${result.production.length} things to cook · ${result.purchases.length} things to buy`,
          'grey',
        ),
      );
      for (const problem of result.problems) out(f.style(`  ✗ ${problem}`, 'red'));
      for (const conflict of result.conflicts) out(f.style(`  ⚠ ${conflict}`, 'yellow'));

      if (boolFlag(ctx.args, 'commit')) {
        const orders = commitProduction(ctx.db, result);
        ctx.dirty = true;
        out();
        out(`${f.style('✓', 'green')} Raised ${orders.length} production orders.`);
      }
    },
  },

  shop: {
    usage: 'mise shop [--horizon N] [--optional] [--commit]',
    summary: 'The shopping list: net requirements rounded to what shops actually sell.',
    group: 'planning',
    run: (ctx) => {
      const mrp = runMrp(ctx.db, {
        horizonDays: horizonFlag(ctx.args, ctx.db.settings.planningHorizonDays),
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      const list = shoppingList(ctx.db, mrp);
      const currency = ctx.db.settings.currency;

      out(f.heading(`Shopping list — ${formatDate(list.asOf)}`));
      for (const group of bySupplier(list)) {
        out();
        out(
          `  ${f.style(group.supplier, 'bold')} ` +
            f.style(`— ${formatDate(group.orderBy)} — ${f.money(group.total, currency)}`, 'grey'),
        );
        out(
          f.table(group.lines, [
            { header: 'Item', get: (l) => l.name },
            { header: 'Need', get: (l) => f.qty(l.needQty, l.uom), align: 'right' },
            { header: 'Buy', get: (l) => f.style(`${f.num(l.packs)} × ${l.packLabel}`, 'bold'), align: 'right' },
            { header: 'Cost', get: (l) => f.money(l.lineCost, currency), align: 'right' },
            { header: 'Spare', get: (l) => (l.leftover > 0.01 ? f.style(f.qty(l.leftover, l.uom), 'grey') : ''), align: 'right' },
            { header: 'When', get: (l) => (l.late ? f.style(`${formatDate(l.orderBy)} — late`, 'red') : formatDate(l.orderBy)) },
            { header: 'For', get: (l) => f.style(l.forDishes.join(', '), 'grey') },
          ]),
        );
      }

      out();
      out(`  ${f.style('Total', 'bold')} ${f.style(f.money(list.total, currency), 'bold', 'green')}`);
      for (const line of list.unresolved) {
        out(f.style(`  ✗ ${line.name}: ${line.problem}`, 'red'));
      }
      if (mrp.conflicts.length > 0) {
        out();
        out(f.style('  Shop opening days make these tight:', 'yellow'));
        for (const conflict of mrp.conflicts) out(f.style(`    ⚠ ${conflict}`, 'yellow'));
      }

      if (boolFlag(ctx.args, 'commit')) {
        const orders = raisePurchaseOrders(ctx.db, list);
        ctx.dirty = true;
        out();
        out(`${f.style('✓', 'green')} Raised ${orders.length} purchase orders: ${orders.map((o) => o.id).join(', ')}`);
      }
    },
  },

  prep: {
    usage: 'mise prep [--horizon N] [--optional]',
    summary: 'Day-by-day prep schedule, deepest sub-recipe first.',
    group: 'planning',
    run: (ctx) => {
      const mrp = runMrp(ctx.db, {
        horizonDays: horizonFlag(ctx.args, ctx.db.settings.planningHorizonDays),
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      const days = prepSchedule(ctx.db, mrp);

      out(f.heading('Prep schedule'));
      if (days.length === 0) {
        out(f.style('  Nothing to cook — the plan is covered by what you already have.', 'grey'));
        return;
      }
      for (const day of days) {
        out();
        out(
          `  ${f.style(formatDate(day.date), 'bold')} ` +
            f.style(`— ${f.minutes(day.activeMin)} hands-on, ${f.minutes(day.passiveMin)} waiting`, 'grey'),
        );
        for (const task of day.tasks) {
          const forWhen = task.dueOn === day.date ? '' : f.style(` → for ${formatDate(task.dueOn)}`, 'grey');
          out(
            `    ${f.style('·', 'grey')} ${task.name} ${f.style(f.qty(task.qty, task.uom as UomCode), 'cyan')}` +
              ` ${f.style(`[L${task.level}]`, 'grey')}${forWhen}`,
          );
        }
      }
      out();
      out(f.style('  Tasks within a day are listed in the order they must happen.', 'grey'));
    },
  },

  cook: {
    usage: 'mise cook <item> [-s servings] [--dry] [--force] [--optional]',
    summary: 'Make something: issue the ingredients, book in the result.',
    group: 'planning',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise cook <item> [-s servings]');
      const target = targetOf(ctx, ref);

      if (boolFlag(ctx.args, 'dry')) {
        // From scratch, because that is what the real command below does: it
        // always makes a new batch. Counting finished stock of the dish here
        // would say "everything is in the house" right before the actual
        // cook, which ignores that stock, fails for missing ingredients.
        const check = feasibility(
          ctx.db,
          target.itemId,
          target.servings,
          undefined,
          true,
          boolFlag(ctx.args, 'optional'),
        );
        out(f.heading(`Dry run — ${check.name} × ${f.num(target.servings)}`));
        out();
        out(`  Coverage: ${f.bar(check.coverage, 20)} ${f.percent(check.coverage)}`);
        if (check.missing.length > 0) {
          out();
          out(
            f.table(check.missing, [
              { header: 'Short of', get: (m) => m.name },
              { header: 'By', get: (m) => f.qty(m.short, m.uom as UomCode), align: 'right' },
            ]),
          );
        } else {
          out(f.style('  Everything is in the house.', 'green'));
        }
        return;
      }

      // The garnish the plan was shopped with must reach the pan: without
      // this, `cook --optional` silently made the plain dish and left the
      // bought extras on the shelf.
      const result = cook(ctx.db, target.itemId, target.servings, {
        allowShortages: boolFlag(ctx.args, 'force'),
        includeOptional: boolFlag(ctx.args, 'optional'),
      });
      ctx.dirty = true;

      out(f.heading(`Made ${result.name} — ${f.qty(result.qty, result.uom as UomCode)}`));
      out(
        f.table(result.consumed, [
          { header: 'Used', get: (c) => c.name },
          { header: 'Qty', get: (c) => f.qty(c.qty, c.uom as UomCode), align: 'right' },
          { header: 'Cost', get: (c) => f.money(c.cost, ctx.db.settings.currency), align: 'right' },
          {
            header: '',
            get: (c) =>
              c.shortfall > 0.001
                ? f.style(`short ${f.qty(c.shortfall, c.uom as UomCode)}`, 'red')
                : c.madeToOrder
                  ? f.style('made to order', 'blue')
                  : '',
          },
        ]),
      );
      out();
      out(`  Actual cost ${f.style(f.money(result.cost, ctx.db.settings.currency), 'green')} · ${f.minutes(result.minutes)}`);
      if (result.lotId) out(f.style(`  Booked in as ${result.lotId}.`, 'grey'));
      for (const shortage of result.shortages) {
        out(f.style(`  ! Short ${f.qty(shortage.short, shortage.uom as UomCode)} of ${shortage.name}`, 'red'));
      }
    },
  },

  serve: {
    usage: 'mise serve <item> [-s servings] [--force] [--optional]',
    summary: 'Eat it: cook if needed, then take it out of stock.',
    group: 'planning',
    run: (ctx) => {
      const ref = ctx.args.positionals[0];
      if (!ref) throw new MiseError('Usage: mise serve <item> [-s servings]');
      const target = targetOf(ctx, ref);
      // Without --force this throws rather than inventing a meal out of an
      // empty pantry. Recording food as eaten that was never there corrupts
      // the ledger, the cost history and every future planning run.
      const force = boolFlag(ctx.args, 'force');
      const result = serve(ctx.db, target.itemId, target.servings, {
        allowShortages: force,
        // Only an explicit flag overrides: a plain serve lets a committed
        // batch keep the optional policy it was committed with.
        ...(boolFlag(ctx.args, 'optional') ? { includeOptional: true } : {}),
      });
      ctx.dirty = true;

      if (result.shortages.length > 0) {
        out(f.style(`! Served ${f.num(target.servings)} of ${result.name}, but short:`, 'yellow'));
        for (const shortage of result.shortages) {
          out(f.style(`    ${shortage.name} — ${f.qty(shortage.short, shortage.uom as UomCode)}`, 'red'));
        }
        out(f.style('  The ledger records this as consumed anyway; run `mise stock` to correct it.', 'grey'));
        return;
      }

      out(
        `${f.style('✓', 'green')} Served ${f.num(target.servings)} of ${result.name} ` +
          f.style(`(${f.money(result.cost, ctx.db.settings.currency)})`, 'grey'),
      );
    },
  },

  orders: {
    usage: 'mise orders',
    summary: 'Open purchase and production orders.',
    group: 'planning',
    run: (ctx) => {
      const open = ctx.db.purchaseOrders.filter((order) => order.status === 'open');
      const cooking = ctx.db.productionOrders.filter((order) => order.status === 'open');

      out(f.heading('Purchase orders'));
      out(
        f.table(open, [
          { header: 'Id', get: (o) => o.id },
          { header: 'Supplier', get: (o) => findSupplier(ctx.db, o.supplierId)?.name ?? o.supplierId },
          { header: 'Expected', get: (o) => formatDate(o.expectedOn) },
          { header: 'Lines', get: (o) => String(o.lines.length), align: 'right' },
          {
            header: 'Value',
            get: (o) =>
              f.money(
                o.lines.reduce((sum, line) => sum + line.packs * line.unitPrice, 0),
                ctx.db.settings.currency,
              ),
            align: 'right',
          },
        ]),
      );

      out(f.heading('Production orders'));
      out(
        f.table(cooking, [
          { header: 'Id', get: (o) => o.id },
          { header: 'Item', get: (o) => mustItem(ctx.db, o.itemId).name },
          { header: 'Qty', get: (o) => f.qty(o.qty, mustItem(ctx.db, o.itemId).stockUom), align: 'right' },
          { header: 'Start', get: (o) => formatDate(o.startOn) },
          { header: 'Due', get: (o) => formatDate(o.dueOn) },
        ]),
      );
      out();
      out(f.style('  Close one out with `mise receive <id>`.', 'grey'));
    },
  },

  receive: {
    usage: 'mise receive <PO-id | PRD-id>',
    summary: 'Book in a delivery, or make a planned batch.',
    group: 'planning',
    run: (ctx) => {
      const id = ctx.args.positionals[0];
      if (!id) throw new MiseError('Usage: mise receive <PO-0001 | PRD-0001>');

      if (id.startsWith('PRD')) {
        const result = executeOrder(ctx.db, id, { allowShortages: boolFlag(ctx.args, 'force') });
        ctx.dirty = true;
        out(
          `${f.style('✓', 'green')} Made ${f.qty(result.qty, result.uom as UomCode)} of ${result.name} ` +
            f.style(`(${f.money(result.cost, ctx.db.settings.currency)} actual)`, 'grey'),
        );
        for (const shortage of result.shortages) {
          out(f.style(`  ! Short ${f.qty(shortage.short, shortage.uom as UomCode)} of ${shortage.name}`, 'red'));
        }
        return;
      }

      const receipt = receivePurchaseOrder(ctx.db, id);
      ctx.dirty = true;
      out(f.heading(`Received ${receipt.orderId}`));
      out(
        f.table(receipt.lots, [
          { header: 'Lot', get: (l) => l.id },
          { header: 'Item', get: (l) => mustItem(ctx.db, l.itemId).name },
          { header: 'Qty', get: (l) => f.qty(l.qty, mustItem(ctx.db, l.itemId).stockUom), align: 'right' },
          { header: 'Use by', get: (l) => (l.expiresOn ? formatDate(l.expiresOn) : f.style('—', 'grey')) },
        ]),
      );
      out();
      out(`  ${f.money(receipt.cost, ctx.db.settings.currency)} of stock booked in.`);
    },
  },

  // ---- admin -------------------------------------------------------------

  doctor: {
    usage: 'mise doctor',
    summary: 'Check the database: cycles, dangling refs, impossible conversions.',
    group: 'admin',
    run: (ctx) => {
      const issues = validate(ctx.db);
      const cycles = findCycles(ctx.db);

      out(f.heading('Diagnostics'));
      out();
      if (cycles.length === 0) {
        out(`  ${f.style('✓', 'green')} Recipe graph is acyclic.`);
      } else {
        for (const cycle of cycles) {
          out(`  ${f.style('✗', 'red')} Cycle: ${cycle.path.join(' → ')}`);
        }
      }

      if (issues.length === 0) {
        out(`  ${f.style('✓', 'green')} No structural problems.`);
      } else {
        for (const issue of issues) out(`  ${f.style('✗', 'red')} ${issue}`);
      }

      // Low-level codes are only defined for an acyclic graph — computing
      // them on the very database doctor just diagnosed as cyclic would
      // throw through the generic handler and eat the report.
      const deepest =
        cycles.length === 0
          ? [...lowLevelCodes(ctx.db).entries()].sort((a, b) => b[1] - a[1])[0]
          : undefined;
      out();
      out(
        f.style(
          `  ${ctx.db.items.length} items · ${ctx.db.recipes.length} recipes · ` +
            `deepest nesting ${deepest ? `${deepest[1]} (${mustItem(ctx.db, deepest[0]).name})` : cycles.length > 0 ? 'n/a (cyclic)' : '0'}`,
          'grey',
        ),
      );
      if (issues.length > 0 || cycles.length > 0) process.exitCode = 1;
    },
  },

  items: {
    usage: 'mise items [filter]',
    summary: 'The item master.',
    group: 'admin',
    run: (ctx) => {
      const needle = ctx.args.positionals[0]?.toLowerCase();
      const codes = lowLevelCodes(ctx.db);
      const items = ctx.db.items
        .filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.id.includes(needle))
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

      out(f.heading('Item master'));
      out(
        f.table(items, [
          { header: 'Id', get: (i) => f.style(i.id, 'grey') },
          { header: 'Name', get: (i) => i.name },
          { header: 'Category', get: (i) => i.category },
          {
            header: 'Source',
            get: (i) =>
              i.sourcing === 'purchased'
                ? f.style('buy', 'yellow')
                : i.sourcing === 'phantom'
                  ? f.style('phantom', 'magenta')
                  : f.style('make', 'blue'),
          },
          { header: 'Uom', get: (i) => i.stockUom },
          { header: 'LLC', get: (i) => String(codes.get(i.id) ?? 0), align: 'right' },
          { header: 'On hand', get: (i) => f.qty(availableOn(ctx.db, i.id, today()), i.stockUom), align: 'right' },
          {
            header: 'Unit cost',
            get: (i) => {
              const unit = i.sourcing === 'purchased' ? purchaseUnitCost(i) : rollupUnitCost(ctx.db, i.id).total;
              return unit === undefined ? f.style('—', 'grey') : f.money(unit, ctx.db.settings.currency);
            },
            align: 'right',
          },
        ]),
      );
    },
  },

  ledger: {
    usage: 'mise ledger [-n 20]',
    summary: 'The inventory ledger, most recent last.',
    group: 'admin',
    run: (ctx) => {
      const limit = numberFlag(ctx.args, 'limit', 25);
      const entries = ctx.db.ledger.slice(-limit);
      out(f.heading('Inventory ledger'));
      out(
        f.table(entries, [
          { header: 'Id', get: (e) => f.style(e.id, 'grey') },
          { header: 'Date', get: (e) => formatDate(e.at) },
          { header: 'Type', get: (e) => e.type },
          // History outlives the item master: a deleted item's transactions
          // still render, by id, instead of aborting the report that shows
          // them. Doctor flags the dangling reference separately.
          { header: 'Item', get: (e) => findItem(ctx.db, e.itemId)?.name ?? `${e.itemId} (deleted)` },
          {
            header: 'Qty',
            get: (e) => {
              // The same tolerance as the Item column: history renders even
              // when the master lost the item — bare number, no unit.
              const uom = findItem(ctx.db, e.itemId)?.stockUom;
              const amount = uom ? f.qty(e.qty, uom) : f.num(e.qty);
              return f.style(`${e.qty > 0 ? '+' : ''}${amount}`, e.qty > 0 ? 'green' : 'red');
            },
            align: 'right',
          },
          { header: 'Ref', get: (e) => f.style(e.ref ?? e.note ?? '', 'grey') },
        ]),
      );
    },
  },

  report: {
    usage: 'mise report',
    summary: 'One-page household dashboard.',
    group: 'admin',
    run: (ctx) => {
      const currency = ctx.db.settings.currency;
      const mrp = runMrp(ctx.db);
      const list = shoppingList(ctx.db, mrp);
      const soon = expiring(ctx.db, 3);
      // The same remaining-portions predicate the demand planner and the
      // plan listing use: a meal counted out by hand-edit is done whether
      // or not its completion marker was written.
      const meals = ctx.db.mealPlan.filter((e) => remainingServings(e) > 1e-9 && e.date >= today());

      out(f.heading('Household'));
      out();
      out(`  Pantry value       ${f.money(stockValue(ctx.db), currency)} across ${stockReport(ctx.db).length} items`);
      out(`  Planned meals      ${meals.length} upcoming`);
      out(`  To buy             ${list.lines.length} lines, ${f.money(list.total, currency)}`);
      // Committed batches are supply to the planning run, not entries in
      // mrp.production — but they are still outstanding cooking, exactly as
      // the prep schedule shows them.
      const openBatches = ctx.db.productionOrders.filter((order) => order.status === 'open').length;
      out(`  To cook            ${mrp.production.length + openBatches} batches`);
      out(
        `  Expiring soon      ${soon.length > 0 ? f.style(String(soon.length), 'yellow') : f.style('none', 'green')}` +
          (soon.length > 0 ? f.style(` (${soon.map((s) => s.item.name).slice(0, 4).join(', ')})`, 'grey') : ''),
      );

      const weekCost = meals.reduce((sum, entry) => {
        const target = quantityForServings(ctx.db, entry.itemId, remainingServings(entry));
        return sum + costOf(ctx.db, entry.itemId, target.qty, target.uom).total;
      }, 0);
      const totalServings = meals.reduce((sum, entry) => sum + remainingServings(entry), 0);
      out(
        `  Cost per serving   ${totalServings > 0 ? f.money(weekCost / totalServings, currency) : '—'}` +
          f.style(`  (${f.num(totalServings)} servings planned)`, 'grey'),
      );

      if (soon.length > 0) {
        out();
        out(f.style('  Use these up:', 'yellow'));
        for (const entry of soon.slice(0, 5)) {
          out(
            `    ${entry.item.name} — ${f.qty(entry.lot.qty, entry.item.stockUom)}, ` +
              (entry.daysLeft < 0 ? f.style('past its date', 'red') : `${entry.daysLeft} days left`),
          );
        }
      }
    },
  },

  help: {
    usage: 'mise help',
    summary: 'This message.',
    group: 'admin',
    needsDb: false,
    run: () => printHelp(),
  },
};

const ALIASES: Record<string, string> = {
  bom: 'tree',
  explode: 'tree',
  whereused: 'where-used',
  used: 'where-used',
  buy: 'shop',
  make: 'cook',
  pantry: 'stock',
  check: 'doctor',
  '--help': 'help',
  '-h': 'help',
};

function printHelp(): void {
  out();
  out(`  ${f.style('mise', 'bold', 'cyan')} — a recursive recipe engine and home ERP`);
  out();

  const groups: { key: Command['group']; title: string }[] = [
    { key: 'recipes', title: 'Recipes' },
    { key: 'pantry', title: 'Pantry' },
    { key: 'planning', title: 'Planning' },
    { key: 'admin', title: 'Admin' },
  ];

  for (const group of groups) {
    out(`  ${f.style(group.title, 'bold')}`);
    const entries = Object.entries(commands).filter(([, command]) => command.group === group.key);
    const widest = Math.max(...entries.map(([, command]) => f.width(command.usage.replace('mise ', ''))));
    for (const [, command] of entries) {
      out(`    ${f.pad(command.usage.replace('mise ', ''), widest)}  ${f.style(command.summary, 'grey')}`);
    }
    out();
  }

  out(f.style(`  Database: ${defaultDbPath()}  (override with MISE_DB)`, 'grey'));
  out();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(argv: readonly string[]): number {
  const [rawName, ...rest] = argv;
  const name = ALIASES[rawName ?? ''] ?? rawName;

  if (!name) {
    printHelp();
    return 0;
  }

  const command = commands[name];
  if (!command) {
    out(f.style(`Unknown command "${rawName}". Run \`mise help\`.`, 'red'));
    return 1;
  }

  const args = parseArgs(rest, new Set([...COMMON_BOOLEAN_FLAGS, ...(command.booleanFlags ?? [])]));
  if (boolFlag(args, 'no-color')) f.setColour(false);

  const path = stringFlag(args, 'db') ?? defaultDbPath();
  const ctx: Ctx = {
    db: command.needsDb === false ? seedDatabase() : loadDb(path),
    args,
    path,
    dirty: false,
  };

  command.run(ctx);
  if (ctx.dirty) saveDb(ctx.db, ctx.path);
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('mise'));

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MiseError) {
      out(f.style(`✗ ${error.message}`, 'red'));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
