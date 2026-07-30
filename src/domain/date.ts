/**
 * Dates are plain `YYYY-MM-DD` strings throughout. A meal plan is a calendar,
 * not a timestamp log, and keeping dates as strings makes the whole database
 * trivially serialisable and timezone-stable.
 */

import { MiseError } from './errors.js';

export type IsoDate = string & { readonly __isoDate?: unique symbol };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function isoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10) as IsoDate;
}

export function today(now: Date = new Date()): IsoDate {
  return isoDate(now);
}

function toUtc(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return isoDate(new Date(toUtc(date) + days * 86_400_000));
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** Inclusive range of dates. */
export function dateRange(from: IsoDate, days: number): IsoDate[] {
  return Array.from({ length: Math.max(0, days) }, (_, i) => addDays(from, i));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function weekdayOf(date: IsoDate): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[new Date(toUtc(date)).getUTCDay()]!;
}

/** "Thu 30 Jul" — compact and unambiguous for terminal tables. */
export function formatDate(date: IsoDate): string {
  const d = new Date(toUtc(date));
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${weekdayOf(date)} ${String(d.getUTCDate()).padStart(2, '0')} ${month}`;
}

/**
 * Parse the date shorthands a person actually types at a prompt:
 * `today`, `tomorrow`, `+3`, `mon`, or a literal `2026-08-04`.
 */
export function parseDate(input: string, now: IsoDate = today()): IsoDate {
  const text = input.trim().toLowerCase();
  if (isIsoDate(text)) return text as IsoDate;
  if (text === 'today') return now;
  if (text === 'tomorrow') return addDays(now, 1);
  if (text === 'yesterday') return addDays(now, -1);

  const offset = /^([+-]\d+)d?$/.exec(text);
  if (offset) return addDays(now, Number(offset[1]));

  const weekdayIndex = WEEKDAYS.findIndex((d) => d.toLowerCase() === text.slice(0, 3));
  if (weekdayIndex >= 0) {
    // The next occurrence of that weekday, today included.
    for (let i = 0; i < 7; i += 1) {
      const candidate = addDays(now, i);
      if (new Date(toUtc(candidate)).getUTCDay() === weekdayIndex) return candidate;
    }
  }

  throw new MiseError(`Cannot parse date "${input}". Try YYYY-MM-DD, today, tomorrow, +3 or mon.`);
}
