/**
 * Human-readable, deterministic ids: `LOT-0007`, `PO-0003`.
 *
 * Deterministic rather than random so that two runs over the same database
 * produce the same ids, which keeps tests and diffs of the JSON store stable.
 */

export function nextId(
  prefix: string,
  existing: Iterable<{ id: string }>,
  retired: Iterable<string> = [],
): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  const bump = (id: string): void => {
    const match = pattern.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  };
  for (const { id } of existing) bump(id);
  // Ids that live on only in history — ledger lot references, order pegs —
  // stay reserved: reusing one would graft a new row onto an old audit
  // trail. Ids of a different shape are simply ignored.
  for (const id of retired) bump(id);
  return `${prefix}-${String(highest + 1).padStart(4, '0')}`;
}

/** `Ragù alla Bolognese` -> `ragu-alla-bolognese`. */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    // Strip combining diacritics so "Ragù" and "Ragu" slug identically.
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A slug that does not collide with anything already present. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const base = slugify(name) || 'item';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
