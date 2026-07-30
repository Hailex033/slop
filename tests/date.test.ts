import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, daysBetween, formatDate, isIsoDate, parseDate, weekdayOf } from '../src/domain/date.js';
import { MiseError } from '../src/domain/errors.js';

test('accepts real calendar dates', () => {
  assert.equal(isIsoDate('2026-07-30'), true);
  assert.equal(isIsoDate('2024-02-29'), true, '2024 is a leap year');
  assert.equal(isIsoDate('2026-12-31'), true);
});

test('rejects dates that would silently roll forward', () => {
  // Date.parse happily normalises these, which would store one date and
  // display another — the meal plan and the calendar would disagree.
  for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10']) {
    assert.equal(isIsoDate(bad), false, `${bad} should be rejected`);
  }
});

test('rejects anything that is not a plain YYYY-MM-DD', () => {
  for (const bad of ['30-07-2026', '2026-7-30', '2026-07-30T12:00:00Z', 'tomorrow', '']) {
    assert.equal(isIsoDate(bad), false, `${bad} should be rejected`);
  }
});

test('parseDate refuses an impossible date rather than shifting it', () => {
  assert.throws(() => parseDate('2026-02-30'), MiseError);
});

test('parses the shorthands people actually type', () => {
  assert.equal(parseDate('today', '2026-07-30'), '2026-07-30');
  assert.equal(parseDate('tomorrow', '2026-07-30'), '2026-07-31');
  assert.equal(parseDate('+3', '2026-07-30'), '2026-08-02');
  assert.equal(parseDate('2026-08-04', '2026-07-30'), '2026-08-04');
  // 30 July 2026 is a Thursday, so the next Saturday is the 1st.
  assert.equal(parseDate('sat', '2026-07-30'), '2026-08-01');
  assert.equal(parseDate('thu', '2026-07-30'), '2026-07-30', 'today counts');
});

test('date arithmetic crosses months and years', () => {
  assert.equal(addDays('2026-07-30', 3), '2026-08-02');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(daysBetween('2026-07-30', '2026-08-02'), 3);
  assert.equal(daysBetween('2026-08-02', '2026-07-30'), -3);
});

test('formatting is stable and timezone-independent', () => {
  assert.equal(weekdayOf('2026-07-30'), 'Thu');
  assert.equal(formatDate('2026-07-30'), 'Thu 30 Jul');
});
