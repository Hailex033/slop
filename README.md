# mise

A culinary app built on one observation: **MealBoard's recipe recursion and an
ERP's bill of materials are the same data structure.**

In MealBoard, a recipe can be used as an ingredient in another recipe, as deep
as you like, and scaling propagates down through the nesting. In manufacturing,
that is a multi-level BOM, and there is fifty years of well-understood machinery
built on top of it — explosion, where-used, low-level codes, netting, MRP,
pegging, backflushing.

Mise implements the recursion properly and then runs that machinery over your
kitchen. Your meal plan is a master production schedule. Your pantry is
lot-tracked inventory. Your shopping list is a purchase requisition run.

```
Lasagne al forno              3 kg  1× batch
├─ Ragù alla bolognese      1.4 kg  1× batch
│  ├─ Soffritto              300 g  phantom
│  │  ├─ Onion               167 g  +10% loss   ← 150 g in the pan, 167 g bought
│  │  ├─ Carrot             88.2 g  +15% loss
│  │  ├─ Celery             83.3 g  +10% loss
│  │  └─ Olive oil         29.6 ml
│  ├─ Beef mince (10%)       500 g
│  ├─ Bay leaf                 2 ×  fixed       ← does not double with the batch
│  └─ …
├─ Besciamella                 1 l  1× batch
│  ├─ Roux                   200 g  phantom
│  │  ├─ Butter              100 g
│  │  └─ Plain flour         100 g
│  └─ Whole milk               1 l
├─ Fresh pasta sheets        500 g  0.833× batch
│  └─ Fresh pasta dough      517 g  phantom
│     ├─ "00" pasta flour    333 g
│     └─ Egg                3.33 ×
└─ Parmigiano Reggiano       120 g
```

Nothing in the engine knows that lasagne is four levels deep — or that the
seed's chicken chasseur is seven (chasseur → sauce chasseur → demi-glace →
espagnole → brown stock → mirepoix → carrot, straight out of Escoffier). It
expands an item, finds some of its components are themselves items with
recipes, and expands those. That is the whole trick, and everything else
falls out of it.

## Quick start

```bash
npm install          # only @types/node and typescript, both dev-only
npm run build
npm test             # 276 tests, no runtime dependencies

node dist/src/cli.js init      # writes mise.db.json, seeded with a worked example
node dist/src/cli.js tree lasagne
node dist/src/cli.js mrp
node dist/src/cli.js shop
```

For the browser UI:

```bash
npm run web          # http://localhost:4173
```

The web app imports the *same* engine modules as the CLI, as plain ES modules.
There is no server, no API layer and no second implementation — the page runs
the engine directly and persists to `localStorage`.

## What makes the recursion non-trivial

A recipe tree is easy. A recipe tree you can plan a week's shopping from is not.
The parts that carry real weight:

**Units bridge dimensions.** Recipes call for cups, shops sell kilos, stock is
held in grams. Converting `1 cup` of flour to grams needs flour's density;
converting `3 eggs` to grams needs an egg's weight. Those coefficients live on
the item, and a conversion that cannot be made fails loudly with the name of the
field you need to fill in, rather than silently guessing.

**Prep loss is grossed up on the way down.** A recipe calling for 200 g of
peeled onion needs 222 g of onion bought. Loss applies to procurement and to
cost, but *not* to nutrition — you pay for the peel and you do not eat it.

**Fixed components don't scale.** Doubling the batch does not double the bay
leaf. Components marked `scalable: false` pass through unmultiplied — and a
dish cooked twice needs that pinch twice, so each separate making counts it
again.

**Optional means optional, everywhere.** Explosion, the shopping list, MRP,
cost and nutrition all exclude `optional` components by default, so the
headline figures always describe the same dish as the tree beneath them. Pass
`--optional` to include them.

**Phantoms are structural, not stocked.** Nobody keeps a tub of soffritto in the
fridge. It is a genuine sub-recipe with genuine structure, but explosion always
passes straight through it to onions and carrots, and MRP never nets it against
stock or puts it on a list. This is the classic ERP phantom assembly, and it is
exactly how a sub-recipe behaves when you never keep it around.

**Low-level codes make netting correct.** Butter is used directly in the lasagne
*and* three levels down inside the roux inside the béchamel. If you netted
butter against your stock the first time you met it, decided you had enough, and
then met it again with the stock already spoken for, you would buy it twice. MRP
processes items strictly in low-level-code order, so every demand for an item is
collected before that item is planned. In the seed data butter is reachable by
nine distinct paths and appears exactly once on the shopping list.

## The same graph, read both ways

```
$ mise where-used butter

  Butter
  ├─ Chicken and leek pie (25 g per batch)
  ├─ Lasagne al forno (20 g per batch)
  ├─ Roux (100 g per batch)
  │  ├─ Besciamella (200 g per batch)
  │  │  └─ Lasagne al forno (1000 ml per batch)
  │  └─ Velouté (120 g per batch)
  │     └─ Chicken and leek pie (600 ml per batch)
  └─ Shortcrust pastry (150 g per batch)
     └─ Chicken and leek pie (500 g per batch)

  Low-level code 3 — planned after everything that contains it.
```

## The ERP half

```
$ mise mrp

  Lvl  Item                   Gross  On hand  On order      Net  Action
    0  Lasagne al forno        4 kg      0 g         —     4 kg  make
    1  Besciamella           1.33 l     0 ml         —   1.33 l  make
    1  Ragù alla bolognese  1.87 kg      0 g         —  1.87 kg  make
    2  Chicken stock         2.92 l      1 l         —   1.93 l  make
    2  Roux                   357 g      0 g         —    357 g  pass through
    3  Butter                 380 g    180 g         —    300 g  buy
```

`gross + safety stock − on hand − on order = net`, then buy it or cook it. The
run is fully auditable: every line shows its working, and every planned order is
pegged back to the meal that caused it.

Three details do a lot of work here. **On hand means still edible on the day it
is wanted** — netting is date by date, so milk that goes off on Thursday is
supply for Wednesday's dinner and not for Saturday's lasagne. **Being short on
two distant dates is two orders**, not one big early one: salad wanted on the
2nd and the 6th, with a two-day shelf life, is two shopping trips, because
buying it all on the 2nd would leave half of it rotting. And **safety stock is
demand in its own right** — a floor on the closing balance that gets rebuilt
whether or not anything is planned.

From there:

- `mise shop` rounds net requirements up to what shops actually sell (250 g
  blocks, boxes of six), applies minimum order quantities, groups by supplier
  and reports the leftover that rounding creates — which is real stock the next
  run will net against. Trips are scheduled onto days the shop is actually
  open, so a Saturday-only market cannot silently be told to supply Thursday's
  dinner; when it can't, the plan says so rather than printing an impossible
  date. Those are reported as *conflicts* — the plan needs a decision — and
  kept separate from *problems*, which mean an item has no source at all.
- `mise prep` backward-schedules from each due date and orders tasks
  deepest-first within a day: the roux before the béchamel before the lasagne.
  A sourdough needing an overnight retard gets scheduled two days out.
- `mise cook lasagne` issues ingredients first-expired-first-out, cascades into
  any sub-recipe you don't already have in the fridge, and books the result back
  in at what the lots it consumed *actually* cost, not list price. If something
  is missing it refuses and rolls back rather than cooking a dish out of an
  empty pantry; `--force` records it anyway and tells you exactly what was
  short, because a ledger that claims food was eaten when it never existed is
  worse than no ledger.
- `mise feasible` answers "what can I make right now" by netting against stock
  at every level: a tub of ragù in the fridge counts as ragù rather than being
  exploded into mince you no longer have, while a shared ingredient is drawn
  from one balance so two branches can't both be credited the same butter. The
  time it quotes is the cooking that actually remains — a sauce that simmered
  for two hours last week is lifted off the shelf, not simmered again.

The loop closes: `shop --commit` raises purchase orders → `receive PO-0001`
turns packs into lots with expiry dates → `cook` consumes them → `serve` takes
the dish out of stock → the next `mrp` sees the new position.

## Commands

| | |
|---|---|
| **Recipes** | |
| `tree <item> [-s n] [--cost] [--stop x,y]` | Full recursive explosion |
| `ingredients <item> [-s n]` | Flat, aggregated, pooled across paths |
| `where-used <item>` | Reverse explosion |
| `cost <item> [-s n] [--optional]` | Rolled-up cost, by where the money goes |
| `nutrition <item> [-s n] [--optional]` | Nutrition and allergens through every sub-recipe |
| `scale <item> -s n` | Rewrite a recipe for a different number of people |
| **Pantry** | |
| `stock [--expiring n] [--low]` | Lot-level stock, value, expiry |
| `stock add <item> <qty> [uom]` | Book something in |
| `waste` | Write off what's past its date, and count the cost |
| `feasible [--almost]` | What you could cook right now |
| **Planning** | |
| `plan [add \| rm]` | The meal plan |
| `mrp [--horizon n] [--commit]` | Net the plan against the pantry |
| `shop [--commit]` | Costed shopping list, by supplier |
| `prep` | Day-by-day prep timetable |
| `orders`, `receive <id>` | Open orders; book in a delivery or a batch |
| `cook <item> [-s n] [--dry] [--force]` | Make it |
| `serve <item> [-s n] [--force]` | Eat it |
| **Admin** | |
| `doctor` | Cycles, dangling refs, impossible conversions |
| `items`, `ledger`, `report` | Item master, transaction log, dashboard |

Set `MISE_DB` to point at a different database file.

## Layout

```
src/domain/       units, dates, ids, types, database + validation
src/engine/       graph        low-level codes, cycles, where-used
                  explode      the recursion
                  rollup       cost, nutrition, allergens, critical path
                  inventory    lots, FEFO, ledger
                  mrp          netting, planned orders, backward scheduling
                  procurement  pack rounding, suppliers, purchase orders
                  production   prep schedule, feasibility, cooking
src/data/seed.ts  a worked example household
src/cli.ts        the terminal front end
web/              the browser front end, same engine
tests/            276 tests
```

The engine layer imports nothing from Node and nothing from npm, which is why
the browser can run it unmodified.

## Design notes

**Everything is an item.** There is no separate ingredients table and recipes
table. There is one item master, and an item is either bought, made, or a
phantom. A recipe is a bill of materials attached to a made item. This is why
the recursion is uniform: a component is just an item id, and whether it expands
is a property of that item, discovered one level at a time.

**Cycles are caught, not survived.** A sourdough starter fed with starter is a
real cycle. `mise doctor` reports every cycle in the graph; explosion throws
`CycleError` with the path if it walks into one. The seed models a starter as a
standing purchased item for exactly this reason, and there's a test that proves
the detection fires when you don't.

**Cost keeps materials and overhead separate all the way up.** Energy absorbed
by a three-hour ragù simmer is still labelled overhead when it surfaces in the
lasagne's total, rather than being laundered into materials.

**Reduction concentrates nutrition without inventing calories.** A sauce with
`massYield: 0.67` keeps its totals and raises its per-100 g figures.

## Limitations

- Nutrition and prices in the seed data are plausible reference values, not
  authoritative ones. Don't count carbs on them.
- MRP buckets demand by day and nets across the whole horizon at once; it
  doesn't compute time-phased projected-on-hand balances period by period.
- Backward scheduling assumes eight usable cooking hours a day and no contention
  for the oven. Capacity is not modelled.
- No recipe import, no photos, no sync. The database is a JSON file.
- `stock add` and `plan add` are the only write commands for master data;
  changing items and recipes means editing the JSON or the seed file.
