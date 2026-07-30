/**
 * The browser front end.
 *
 * It imports the same engine modules the CLI does — no server, no API, no
 * duplicated logic. The database lives in memory (persisted to localStorage so
 * a reload keeps your pantry), and every figure on screen is recomputed from it
 * on each render.
 */

import { seedDatabase } from '../src/data/seed.js';
import { formatDate, today, type IsoDate } from '../src/domain/date.js';
import { householdServings, mustItem, recipeFor } from '../src/domain/db.js';
import { MiseError } from '../src/domain/errors.js';
import type { Database, Item, ItemId } from '../src/domain/types.js';
import type { UomCode } from '../src/domain/units.js';
import { aggregate, explode, quantityForServings, type BomNode } from '../src/engine/explode.js';
import { lowLevelCodes, recipeDepth, whereUsed, type WhereUsedNode } from '../src/engine/graph.js';
import { availableOn, expiring, stockReport, stockValue } from '../src/engine/inventory.js';
import { runMrp } from '../src/engine/mrp.js';
import { bySupplier, shoppingList } from '../src/engine/procurement.js';
import { almostCookable, cook, cookableNow, prepSchedule } from '../src/engine/production.js';
import { costOf, nutritionOf, rollupAllergens, rollupTime, rollupUnitCost } from '../src/engine/rollup.js';
import { minutes, money, num, percent, qty } from '../src/report/format.js';

// ---------------------------------------------------------------------------
// Tiny DOM helper
// ---------------------------------------------------------------------------

type Child = Node | string | number | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((event: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') node.addEventListener(key.replace(/^on/, ''), value as EventListener);
    else if (value === false || value === undefined) continue;
    else if (key === 'class') node.className = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const badge = (text: string, kind = 'plain'): HTMLElement => el('span', { class: `badge ${kind}` }, text);

function tableOf<T>(
  rows: readonly T[],
  columns: { head: string; cell: (row: T) => Child; num?: boolean }[],
  emptyText = 'Nothing here.',
): HTMLElement {
  if (rows.length === 0) return el('p', { class: 'empty' }, emptyText);
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { class: c.num ? 'num' : '' }, c.head)))),
      el(
        'tbody',
        {},
        ...rows.map((row) =>
          el('tr', {}, ...columns.map((c) => el('td', { class: c.num ? 'num' : '' }, c.cell(row)))),
        ),
      ),
    ),
  );
}

const stat = (key: string, value: Child, sub?: Child): HTMLElement =>
  el('div', { class: 'stat' }, el('div', { class: 'k' }, key), el('div', { class: 'v' }, value),
    sub ? el('div', { class: 's' }, sub) : null);

const meter = (fraction: number): HTMLElement =>
  el('span', { class: 'meter' }, el('span', { style: `width:${Math.min(100, Math.max(0, fraction * 100))}%` }));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type View = 'recipes' | 'pantry' | 'plan' | 'mrp' | 'shop' | 'prep' | 'cook';

interface State {
  db: Database;
  view: View;
  itemId: ItemId;
  servings: number;
  showCosts: boolean;
  includeOptional: boolean;
  flash?: string;
}

const STORAGE_KEY = 'mise.db.v1';

function loadState(): Database {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Database;
  } catch {
    /* corrupt or unavailable storage: fall back to the seed */
  }
  return seedDatabase();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db));
  } catch {
    /* private browsing, quota, whatever — the app still works in memory */
  }
}

const seed = loadState();
const state: State = {
  db: seed,
  view: 'recipes',
  itemId: seed.items.some((i) => i.id === 'lasagne') ? 'lasagne' : (seed.items[0]?.id ?? ''),
  servings: 6,
  showCosts: true,
  includeOptional: false,
};

const currency = (): string => state.db.settings.currency;
const cash = (value: number): string => money(value, currency());

function dishes(db: Database): Item[] {
  return db.items
    .filter((item) => recipeFor(db, item.id))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function sourcingBadge(item: Item): HTMLElement {
  if (item.sourcing === 'phantom') return badge('phantom', 'phantom');
  if (item.sourcing === 'manufactured') return badge('make', 'make');
  return badge('buy', 'buy');
}

/** The recursion tree, collapsible, with the aligned quantity column. */
function renderTree(root: BomNode, costs: Map<ItemId, number>): HTMLElement {
  const build = (node: BomNode, isRoot: boolean): HTMLElement => {
    const hasChildren = node.children.length > 0;
    const tags: HTMLElement[] = [];
    if (node.phantom) tags.push(badge('phantom', 'phantom'));
    else if (node.recipe) tags.push(badge(`${num(node.batches ?? 1)}× batch`, 'make'));
    else if (!hasChildren && node.item.sourcing === 'purchased') tags.push(badge('buy', 'buy'));
    if (node.line?.scalable === false) tags.push(badge('fixed', 'plain'));
    if (node.line?.lossPct) tags.push(badge(`+${percent(node.line.lossPct)} loss`, 'warn'));
    if (node.optional) tags.push(badge('optional', 'plain'));

    const item = el(
      'li',
      { class: isRoot ? '' : '' },
      el(
        'div',
        { class: `node ${node.recipe ? 'is-made' : ''}` },
        hasChildren
          ? el('button', {
              class: 'twist',
              type: 'button',
              title: 'Collapse',
              onclick: (event: Event) => {
                const li = (event.currentTarget as HTMLElement).closest('li');
                li?.classList.toggle('collapsed');
                const twist = event.currentTarget as HTMLElement;
                twist.textContent = li?.classList.contains('collapsed') ? '▸' : '▾';
              },
            }, '▾')
          : el('span', { class: 'twist leaf' }, '·'),
        el('span', { class: 'name' }, node.item.name),
        el('span', { class: 'rule' }),
        el('span', { class: 'tags' }, ...tags),
        el('span', { class: 'qty' }, qty(node.grossQty, node.uom)),
        state.showCosts
          ? el('span', { class: 'cost' }, cash((costs.get(node.itemId) ?? 0) * node.grossQty))
          : null,
      ),
      hasChildren ? el('ul', {}, ...node.children.map((child) => build(child, false))) : null,
    );
    return item;
  };

  return el('div', { class: 'tree' }, el('ul', {}, build(root, true)));
}

function viewRecipes(): HTMLElement[] {
  const db = state.db;
  const item = mustItem(db, state.itemId);
  const target = quantityForServings(db, state.itemId, state.servings);

  const tree = explode(db, {
    itemId: state.itemId,
    qty: target.qty,
    uom: target.uom,
    includeOptional: state.includeOptional,
  });

  const costs = new Map<ItemId, number>();
  for (const entry of db.items) {
    try {
      costs.set(entry.id, rollupUnitCost(db, entry.id).total);
    } catch {
      /* unpriceable item; the tree just shows nothing for it */
    }
  }

  const cost = costOf(db, state.itemId, target.qty, target.uom);
  const facts = nutritionOf(db, state.itemId, target.qty, target.uom);
  const time = rollupTime(db, state.itemId);
  const leaves = aggregate(tree, { level: 'leaves', includeOptional: state.includeOptional });
  const allergens = rollupAllergens(db, state.itemId);
  const depth = recipeDepth(db, state.itemId);

  const controls = el(
    'div',
    { class: 'controls' },
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'dish' }, 'Dish or sub-recipe'),
      el(
        'select',
        {
          id: 'dish',
          onchange: (event: Event) => {
            state.itemId = (event.target as HTMLSelectElement).value;
            const recipe = recipeFor(state.db, state.itemId);
            if (recipe) state.servings = recipe.servings;
            render();
          },
        },
        ...dishes(db).map((entry) =>
          el('option', { value: entry.id, ...(entry.id === state.itemId ? { selected: 'selected' } : {}) },
            `${entry.name}${entry.sourcing === 'phantom' ? ' (sub-recipe)' : ''}`),
        ),
      ),
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'servings' }, `Servings — ${num(state.servings)}`),
      el('input', {
        id: 'servings',
        type: 'range',
        min: '1',
        max: '24',
        step: '1',
        value: String(state.servings),
        oninput: (event: Event) => {
          state.servings = Number((event.target as HTMLInputElement).value);
          render();
        },
      }),
    ),
    el(
      'div',
      { class: 'field' },
      el('label', {}, 'Show'),
      el(
        'div',
        { style: 'display:flex; gap:8px' },
        el('button', {
          class: 'ghost',
          type: 'button',
          onclick: () => {
            state.showCosts = !state.showCosts;
            render();
          },
        }, state.showCosts ? '✓ costs' : 'costs'),
        el('button', {
          class: 'ghost',
          type: 'button',
          onclick: () => {
            state.includeOptional = !state.includeOptional;
            render();
          },
        }, state.includeOptional ? '✓ optional' : 'optional'),
      ),
    ),
  );

  const stats = el(
    'div',
    { class: 'stats' },
    stat('Nesting depth', `${depth} levels`, `${leaves.length} things to buy`),
    stat('Cost', cash(cost.total), `${cash(cost.perServing)} per serving`),
    stat('Energy', `${num(facts.perServing.kcal)} kcal`, 'per serving'),
    stat('Time', minutes(time.criticalPathMin), `${minutes(time.activeMin)} hands-on`),
  );

  const used = whereUsed(db, state.itemId);
  const usedList = (node: WhereUsedNode): HTMLElement =>
    el('ul', {}, ...node.children.map((child) =>
      el('li', {},
        el('div', { class: 'node' },
          el('span', { class: 'twist leaf' }, '·'),
          el('span', { class: 'name' }, child.name),
          el('span', { class: 'rule' }),
          el('span', { class: 'qty' }, child.qtyPerBatch !== undefined ? `${num(child.qtyPerBatch)} ${child.qtyUom}` : ''),
        ),
        child.children.length > 0 ? usedList(child) : null,
      ),
    ));

  return [
    el('h1', {}, item.name),
    el('p', { class: 'lede' },
      'Every line below is the same kind of thing: an item. Some happen to have a recipe, ' +
        'so the engine expands them — and expands whatever those contain, without any idea how deep it will go.'),
    controls,
    stats,
    el('div', { class: 'panel' }, renderTree(tree, costs)),

    el('h2', {}, 'Rolled up to what you actually buy'),
    el('div', { class: 'panel' },
      tableOf(leaves, [
        { head: 'Ingredient', cell: (r) => r.item.name },
        { head: 'Total', cell: (r) => qty(r.qty, r.uom), num: true },
        { head: 'Paths', cell: (r) => String(r.occurrences), num: true },
        { head: 'Reached via', cell: (r) => el('span', { class: 'dim' }, [...r.usedIn].map((id) => mustItem(db, id).name).sort().join(', ')) },
        { head: 'Cost', cell: (r) => cash((costs.get(r.itemId) ?? 0) * r.qty), num: true },
        { head: 'In stock', cell: (r) => {
          const have = availableOn(db, r.itemId, today());
          return have >= r.qty ? badge('yes', 'ok') : el('span', { class: 'dim' }, qty(have, r.uom));
        } },
      ])),

    el('h2', {}, 'Where this is used'),
    el('div', { class: 'panel' },
      used.children.length === 0
        ? el('p', { class: 'empty' }, 'Nothing else uses this — it is a top-level dish.')
        : el('div', { class: 'tree' }, usedList(used))),

    allergens.length > 0
      ? el('div', {},
          el('h2', {}, 'Allergens'),
          el('div', { class: 'panel' },
            ...allergens.map((hit) =>
              el('span', { style: 'margin-right:8px' },
                badge(hit.allergen, hit.onlyOptional ? 'plain' : 'warn'),
                el('span', { class: 'dim', style: 'font-size:12px; margin-left:4px' },
                  `via ${hit.fromItems.map((id) => mustItem(db, id).name).join(', ')}`)))))
      : null,
  ].filter(Boolean) as HTMLElement[];
}

function viewPantry(): HTMLElement[] {
  const db = state.db;
  const lines = stockReport(db);
  const soon = expiring(db, 5);

  return [
    el('h1', {}, 'Pantry'),
    el('p', { class: 'lede' },
      'Stock is held as lots, each with its own expiry and its own actual cost. ' +
        'Issues take the soonest-expiring lot first, which is what makes waste and true cost measurable.'),
    el('div', { class: 'stats' },
      stat('Items on hand', String(lines.length)),
      stat('Value at cost', cash(stockValue(db))),
      stat('Expiring in 5 days', String(soon.length), soon.length > 0 ? soon.slice(0, 3).map((s) => s.item.name).join(', ') : 'nothing'),
      stat('Below safety stock', String(lines.filter((l) => l.belowSafety).length)),
    ),
    soon.length > 0
      ? el('div', {},
          el('h2', {}, 'Use these first'),
          el('div', { class: 'panel' },
            tableOf(soon, [
              { head: 'Item', cell: (r) => r.item.name },
              { head: 'Quantity', cell: (r) => qty(r.lot.qty, r.item.stockUom), num: true },
              { head: 'Use by', cell: (r) => formatDate(r.lot.expiresOn as IsoDate) },
              { head: '', cell: (r) => r.daysLeft < 0 ? badge(`${-r.daysLeft}d over`, 'bad') : badge(`${r.daysLeft}d left`, r.daysLeft <= 2 ? 'warn' : 'plain') },
            ])))
      : null,
    el('h2', {}, 'Everything in the house'),
    el('div', { class: 'panel' },
      tableOf(lines, [
        { head: 'Item', cell: (l) => l.item.name },
        { head: 'Category', cell: (l) => el('span', { class: 'dim' }, l.item.category) },
        { head: 'On hand', cell: (l) => qty(l.qty, l.uom), num: true },
        { head: 'Lots', cell: (l) => String(l.lots), num: true },
        { head: 'Value', cell: (l) => cash(l.value), num: true },
        { head: 'Next expiry', cell: (l) => l.nextExpiry ? formatDate(l.nextExpiry) : el('span', { class: 'dim' }, '—') },
        { head: '', cell: (l) => l.belowSafety ? badge('low', 'warn') : null },
      ])),
  ].filter(Boolean) as HTMLElement[];
}

function viewPlan(): HTMLElement[] {
  const db = state.db;
  const from = today();
  const entries = [...db.mealPlan].sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));

  const costOfEntry = (itemId: ItemId, servings: number): number => {
    const target = quantityForServings(db, itemId, servings);
    return costOf(db, itemId, target.qty, target.uom).total;
  };

  const total = entries.filter((e) => e.date >= from).reduce((sum, e) => sum + costOfEntry(e.itemId, e.servings), 0);
  const servingsPlanned = entries.filter((e) => e.date >= from).reduce((sum, e) => sum + e.servings, 0);

  return [
    el('h1', {}, 'Meal plan'),
    el('p', { class: 'lede' },
      'In ERP terms this is the master production schedule. Everything downstream — the shopping ' +
        'list, the prep timetable, the netting against your pantry — is derived from it.'),
    el('div', { class: 'stats' },
      stat('Meals planned', String(entries.filter((e) => e.date >= from).length)),
      stat('Servings', num(servingsPlanned)),
      stat('Food cost', cash(total), servingsPlanned > 0 ? `${cash(total / servingsPlanned)} per serving` : ''),
      stat('Household', num(householdServings(db)), db.settings.household.map((m) => m.name).join(', ')),
    ),
    el('div', { class: 'panel' },
      tableOf(entries, [
        { head: 'Date', cell: (e) => formatDate(e.date) },
        { head: 'Slot', cell: (e) => el('span', { class: 'dim' }, e.slot) },
        { head: 'Dish', cell: (e) => el('a', {
            href: '#',
            style: 'color:inherit',
            onclick: (event: Event) => {
              event.preventDefault();
              state.itemId = e.itemId;
              state.servings = e.servings;
              state.view = 'recipes';
              render();
            },
          }, mustItem(db, e.itemId).name) },
        { head: 'Servings', cell: (e) => num(e.servings), num: true },
        { head: 'Cost', cell: (e) => cash(costOfEntry(e.itemId, e.servings)), num: true },
        { head: '', cell: (e) => el('span', { class: 'dim' }, e.note ?? '') },
      ], 'No meals planned.')),
  ];
}

function viewMrp(): HTMLElement[] {
  const db = state.db;
  const result = runMrp(db);
  const codes = lowLevelCodes(db);

  return [
    el('h1', {}, 'Requirements plan'),
    el('p', { class: 'lede' },
      'Gross requirement, less what is in the pantry, less what is already on order, equals what ' +
        'must happen. Items are processed in low-level-code order, so an ingredient reached by ' +
        'several recipes is collected in full before it is netted — and therefore bought once.'),
    el('div', { class: 'stats' },
      stat('Horizon', `${result.horizonDays} days`, `from ${formatDate(result.asOf)}`),
      stat('To cook', String(result.production.length), 'batches'),
      stat('To buy', String(result.purchases.length), 'lines'),
      stat('Deepest level', String(Math.max(0, ...codes.values())), 'levels of nesting'),
    ),
    el('div', { class: 'panel' },
      tableOf(result.lines, [
        { head: 'Lvl', cell: (l) => el('span', { class: 'dim' }, String(l.level)), num: true },
        { head: 'Item', cell: (l) => l.name },
        { head: 'Gross', cell: (l) => qty(l.gross, l.uom as UomCode), num: true },
        { head: 'On hand', cell: (l) => qty(l.onHand, l.uom as UomCode), num: true },
        { head: 'Safety', cell: (l) => l.safetyStock > 0 ? qty(l.safetyStock, l.uom as UomCode) : el('span', { class: 'dim' }, '—'), num: true },
        { head: 'Net', cell: (l) => l.net > 0 ? qty(l.net, l.uom as UomCode) : el('span', { class: 'dim' }, '—'), num: true },
        { head: 'Action', cell: (l) =>
            l.action === 'buy' ? badge('buy', 'buy')
            : l.action === 'make' ? badge('make', 'make')
            : l.action === 'phantom' ? badge('pass through', 'phantom')
            : badge('covered', 'ok') },
      ])),
    ...result.problems.map((problem) => el('p', { class: 'error' }, `✗ ${problem}`)),
    ...result.conflicts.map((conflict) =>
      el('p', { class: 'error', style: 'color:var(--warn)' }, `⚠ ${conflict}`)),
  ];
}

function viewShop(): HTMLElement[] {
  const db = state.db;
  const list = shoppingList(db, runMrp(db));
  const groups = bySupplier(list);

  return [
    el('h1', {}, 'Shopping list'),
    el('p', { class: 'lede' },
      'Net requirements rounded up to what shops actually sell. The spare column is the surplus ' +
        'pack rounding creates — real stock, which next week’s plan will net against.'),
    el('div', { class: 'stats' },
      stat('Total', cash(list.total)),
      stat('Lines', String(list.lines.length)),
      stat('Trips', String(groups.length), groups.map((g) => g.supplier).join(', ')),
    ),
    ...groups.flatMap((group) => [
      el('h2', {}, `${group.supplier} — ${cash(group.total)}`),
      el('div', { class: 'panel' },
        tableOf(group.lines, [
          { head: 'Item', cell: (l) => l.name },
          { head: 'Need', cell: (l) => qty(l.needQty, l.uom), num: true },
          { head: 'Buy', cell: (l) => `${num(l.packs)} × ${l.packLabel}`, num: true },
          { head: 'Cost', cell: (l) => cash(l.lineCost), num: true },
          { head: 'Spare', cell: (l) => l.leftover > 0.01 ? el('span', { class: 'dim' }, qty(l.leftover, l.uom)) : '', num: true },
          { head: 'For', cell: (l) => el('span', { class: 'dim' }, l.forDishes.join(', ')) },
        ])),
    ]),
  ];
}

function viewPrep(): HTMLElement[] {
  const db = state.db;
  const days = prepSchedule(db, runMrp(db));

  return [
    el('h1', {}, 'Prep schedule'),
    el('p', { class: 'lede' },
      'Backward-scheduled from when each dish is due, then sorted deepest-first within a day: ' +
        'the roux before the béchamel before the lasagne. The level column is how far down the ' +
        'recipe graph that task sits.'),
    days.length === 0
      ? el('p', { class: 'empty' }, 'Nothing to cook — the plan is already covered by what you have.')
      : el('div', {}, ...days.map((day) =>
          el('div', { class: 'day' },
            el('div', { class: 'day-head' },
              el('span', { class: 'date' }, formatDate(day.date)),
              el('span', { class: 'dim', style: 'font-size:12.5px' },
                `${minutes(day.activeMin)} hands-on · ${minutes(day.passiveMin)} waiting`)),
            ...day.tasks.map((task) =>
              el('div', {},
                el('div', { class: 'task' },
                  el('span', { class: 'lvl' }, `L${task.level}`),
                  el('span', {}, task.name),
                  el('span', { class: 'rule', style: 'flex:1' }),
                  el('span', { class: 'qty', style: 'font-family:var(--mono); font-size:12.5px; color:var(--accent)' },
                    qty(task.qty, task.uom as UomCode)),
                  task.dueOn !== day.date ? badge(`for ${formatDate(task.dueOn)}`, 'plain') : null),
                task.steps.length > 0
                  ? el('div', { class: 'steps' }, task.steps.join(' → '))
                  : null)),
          ))),
  ];
}

function viewCook(): HTMLElement[] {
  const db = state.db;
  const now = cookableNow(db);
  const near = almostCookable(db, 3);

  const cookButton = (itemId: ItemId, servings: number): HTMLElement =>
    el('button', {
      class: 'action',
      type: 'button',
      onclick: () => {
        try {
          const result = cook(state.db, itemId, servings, { allowShortages: true });
          state.flash = `Made ${num(result.servings)} servings of ${result.name} for ${cash(result.cost)}. Ingredients issued from stock.`;
          persist();
        } catch (error) {
          state.flash = error instanceof MiseError ? error.message : String(error);
        }
        render();
      },
    }, `Cook ${num(servings)}`);

  return [
    el('h1', {}, 'Cook now'),
    el('p', { class: 'lede' },
      'Feasibility is computed against pooled requirements, so an ingredient used in two branches ' +
        'is judged on its total. Cooking issues stock first-expired-first-out, cascades into any ' +
        'sub-recipe you do not already have, and books the result back in at what it actually cost.'),
    state.flash ? el('div', { class: 'panel' }, el('span', { class: 'flash' }, state.flash)) : null,

    el('h2', {}, 'Ready to go'),
    el('div', { class: 'panel' },
      tableOf(now, [
        { head: 'Dish', cell: (r) => r.name },
        { head: 'Servings possible', cell: (r) => num(Math.floor(r.servings * 10) / 10), num: true },
        { head: 'Start to finish', cell: (r) => minutes(r.criticalPathMin), num: true },
        { head: '', cell: (r) => cookButton(r.itemId, Math.max(1, Math.floor(r.servings))) },
      ], 'Nothing is fully covered by stock right now.')),

    el('h2', {}, 'Nearly there'),
    el('div', { class: 'panel' },
      tableOf(near, [
        { head: 'Dish', cell: (r) => r.name },
        { head: 'Coverage', cell: (r) => el('span', {}, meter(r.coverage), el('span', { class: 'dim', style: 'margin-left:8px' }, percent(r.coverage))) },
        { head: 'Missing', cell: (r) => r.missing.map((m) => `${m.name} (${qty(m.short, m.uom as UomCode)})`).join(', ') },
      ], 'Nothing is close.')),
  ].filter(Boolean) as HTMLElement[];
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const VIEWS: { id: View; label: string; count?: (db: Database) => string }[] = [
  { id: 'recipes', label: 'Recipes', count: (db) => String(db.recipes.length) },
  { id: 'pantry', label: 'Pantry', count: (db) => String(stockReport(db).length) },
  { id: 'plan', label: 'Meal plan', count: (db) => String(db.mealPlan.length) },
  { id: 'mrp', label: 'Requirements' },
  { id: 'shop', label: 'Shopping list' },
  { id: 'prep', label: 'Prep schedule' },
  { id: 'cook', label: 'Cook now' },
];

function render(): void {
  const nav = document.getElementById('nav')!;
  nav.replaceChildren(
    ...VIEWS.map((view) =>
      el('button', {
        type: 'button',
        'aria-current': String(view.id === state.view),
        onclick: () => {
          state.view = view.id;
          state.flash = undefined;
          render();
        },
      }, el('span', {}, view.label), view.count ? el('span', { class: 'count' }, view.count(state.db)) : null),
    ),
  );

  const main = document.getElementById('main')!;
  try {
    const content =
      state.view === 'recipes' ? viewRecipes()
      : state.view === 'pantry' ? viewPantry()
      : state.view === 'plan' ? viewPlan()
      : state.view === 'mrp' ? viewMrp()
      : state.view === 'shop' ? viewShop()
      : state.view === 'prep' ? viewPrep()
      : viewCook();
    main.replaceChildren(...content);
  } catch (error) {
    main.replaceChildren(
      el('h1', {}, 'Something went wrong'),
      el('p', { class: 'error' }, error instanceof Error ? error.message : String(error)),
    );
  }
  main.scrollTo?.({ top: 0 });
}

document.getElementById('reset')?.addEventListener('click', () => {
  state.db = seedDatabase();
  state.itemId = 'lasagne';
  state.servings = 6;
  state.flash = 'Reset to the seed household.';
  persist();
  render();
});

render();
