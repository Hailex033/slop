/** Terminal rendering: quantity formatting, colour, tables and trees. */

import { dimensionOf, type UomCode } from '../domain/units.js';
import type { BomNode } from '../engine/explode.js';
import type { WhereUsedNode } from '../engine/graph.js';

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const CODES = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  italic: '[3m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  grey: '[90m',
} as const;

export type StyleName = keyof typeof CODES;

let colourEnabled =
  typeof process !== 'undefined' &&
  process.stdout?.isTTY === true &&
  !process.env['NO_COLOR'] &&
  process.env['TERM'] !== 'dumb';

export function setColour(enabled: boolean): void {
  colourEnabled = enabled;
}

export function style(text: string, ...names: StyleName[]): string {
  if (!colourEnabled || names.length === 0) return text;
  return `${names.map((n) => CODES[n]).join('')}${text}${CODES.reset}`;
}

/** Printable width, ignoring escape sequences. */
export function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '').length;
}

export function pad(text: string, to: number, align: 'left' | 'right' = 'left'): string {
  const spaces = ' '.repeat(Math.max(0, to - width(text)));
  return align === 'left' ? text + spaces : spaces + text;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function trim(value: number, dp: number): string {
  return value
    .toFixed(dp)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

/** Round to a sensible number of digits for the magnitude. */
export function num(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return trim(value, 0);
  if (abs >= 10) return trim(value, 1);
  if (abs >= 1) return trim(value, 2);
  if (abs >= 0.01) return trim(value, 3);
  return value === 0 ? '0' : value.toPrecision(2);
}

/**
 * Format a quantity, promoting to a larger unit when that reads better:
 * 1500 g becomes 1.5 kg, 2000 ml becomes 2 l.
 */
export function qty(value: number, uom: UomCode): string {
  const dimension = dimensionOf(uom);
  if (dimension === 'mass' && uom === 'g') {
    if (Math.abs(value) >= 1000) return `${num(value / 1000)} kg`;
    if (Math.abs(value) < 1 && value !== 0) return `${num(value * 1000)} mg`;
  }
  if (dimension === 'volume' && uom === 'ml' && Math.abs(value) >= 1000) {
    return `${num(value / 1000)} l`;
  }
  if (uom === 'ea') {
    const rounded = Math.abs(value - Math.round(value)) < 0.05 ? Math.round(value) : value;
    return `${num(rounded)} ×`;
  }
  return `${num(value)} ${uom}`;
}

const SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$', JPY: '¥' };

export function money(value: number, currency = 'GBP'): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const sign = value < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(value).toFixed(2)}`;
}

export function minutes(total: number): string {
  const rounded = Math.round(total);
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function percent(fraction: number, dp = 0): string {
  return `${(fraction * 100).toFixed(dp)}%`;
}

/** A unicode meter, for coverage and cost-share columns. */
export function bar(fraction: number, cells = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  return '█'.repeat(filled) + style('░'.repeat(cells - filled), 'grey');
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface Column<T> {
  readonly header: string;
  readonly get: (row: T) => string;
  readonly align?: 'left' | 'right';
}

export function table<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (rows.length === 0) return style('  (nothing)', 'grey');
  const cells = rows.map((row) => columns.map((column) => column.get(row)));
  const widths = columns.map((column, index) =>
    Math.max(width(column.header), ...cells.map((row) => width(row[index] ?? ''))),
  );

  const header = columns
    .map((column, index) => style(pad(column.header, widths[index]!, column.align), 'bold'))
    .join('  ');
  const rule = style(widths.map((w) => '─'.repeat(w)).join('  '), 'grey');
  const body = cells.map((row) =>
    row.map((cell, index) => pad(cell, widths[index]!, columns[index]!.align)).join('  '),
  );

  return [`  ${header}`, `  ${rule}`, ...body.map((line) => `  ${line}`)].join('\n');
}

export function heading(text: string): string {
  return `\n${style(text, 'bold', 'cyan')}\n${style('─'.repeat(width(text)), 'grey')}`;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeOptions {
  /** Show cost per node. */
  readonly costs?: Map<string, number>;
  readonly currency?: string;
  /** Collapse below this depth. */
  readonly maxDepth?: number;
}

/**
 * Render an exploded BOM as an indented tree.
 *
 * The right-hand column is aligned across the whole tree, which is what makes
 * a deep explosion readable rather than a wall of parentheses.
 */
export function renderTree(root: BomNode, options: TreeOptions = {}): string {
  interface Line {
    prefix: string;
    label: string;
    qty: string;
    note: string;
  }
  const lines: Line[] = [];

  const walk = (node: BomNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    if (options.maxDepth !== undefined && node.depth > options.maxDepth) return;

    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    const notes: string[] = [];

    if (node.phantom) notes.push(style('phantom', 'magenta'));
    else if (node.recipe) notes.push(style(`${num(node.batches ?? 1)}× batch`, 'grey'));
    if (node.stopped) notes.push(style('not expanded', 'yellow'));
    if (node.optional) notes.push(style('optional', 'grey'));
    if (node.line?.scalable === false) notes.push(style('fixed', 'blue'));
    if (node.line?.lossPct) {
      notes.push(style(`+${percent(node.line.lossPct)} loss`, 'yellow'));
    }
    if (node.line?.prep) notes.push(style(node.line.prep, 'italic', 'grey'));

    const cost = options.costs?.get(node.itemId);
    if (cost !== undefined && cost > 0) {
      notes.push(style(money(cost * node.grossQty, options.currency), 'green'));
    }

    lines.push({
      prefix: prefix + connector,
      label: node.recipe || node.children.length > 0 ? style(node.item.name, 'bold') : node.item.name,
      qty: qty(node.grossQty, node.uom),
      note: notes.join(' '),
    });

    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    node.children.forEach((child, index) => {
      walk(child, childPrefix, index === node.children.length - 1, false);
    });
  };

  walk(root, '', true, true);

  const labelWidth = Math.max(...lines.map((line) => width(line.prefix) + width(line.label)));
  const qtyWidth = Math.max(...lines.map((line) => width(line.qty)));

  return lines
    .map((line) => {
      const left = pad(line.prefix + line.label, labelWidth);
      const quantity = pad(line.qty, qtyWidth, 'right');
      return `  ${left}  ${style(quantity, 'cyan')}${line.note ? `  ${line.note}` : ''}`;
    })
    .join('\n');
}

/** Render an upward where-used tree. */
export function renderWhereUsed(root: WhereUsedNode): string {
  const lines: string[] = [];

  const walk = (node: WhereUsedNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    const via = node.qtyPerBatch !== undefined ? style(` (${num(node.qtyPerBatch)} ${node.qtyUom} per batch)`, 'grey') : '';
    lines.push(`  ${prefix}${connector}${isRoot ? style(node.name, 'bold') : node.name}${via}`);
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    node.children.forEach((child, index) => {
      walk(child, childPrefix, index === node.children.length - 1, false);
    });
  };

  walk(root, '', true, true);
  return lines.join('\n');
}
