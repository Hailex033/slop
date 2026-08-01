/**
 * The argument parser's contract. The full commands run against a real
 * database file, so they are exercised by the smoke tests; the parser is the
 * part with sharp edges worth pinning down.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberFlag, parseArgs, stringFlag } from '../src/cli.js';
import { MiseError } from '../src/domain/errors.js';

test('a boolean flag before a positional does not eat it', () => {
  const args = parseArgs(['--optional', 'lasagne'], new Set(['optional']));
  assert.deepEqual(args.positionals, ['lasagne']);
  assert.equal(args.flags['optional'], true);
});

test('a value flag still consumes the next token', () => {
  const args = parseArgs(['--horizon', '7', 'lasagne'], new Set(['optional']));
  assert.equal(args.flags['horizon'], '7');
  assert.deepEqual(args.positionals, ['lasagne']);
});

test('the same name can be boolean on one command and take a value on another', () => {
  // `tree --cost` shows costs…
  const asTree = parseArgs(['--cost', 'lasagne'], new Set(['cost']));
  assert.equal(asTree.flags['cost'], true);
  assert.deepEqual(asTree.positionals, ['lasagne']);

  // …while `stock add --cost 2` records what the lot cost.
  const asStock = parseArgs(['add', 'flour', '500', '--cost', '2'], new Set());
  assert.equal(asStock.flags['cost'], '2');
  assert.deepEqual(asStock.positionals, ['add', 'flour', '500']);
});

test('short boolean names respect the boolean set too', () => {
  const args = parseArgs(['-x', 'lasagne'], new Set(['x']));
  assert.equal(args.flags['x'], true);
  assert.deepEqual(args.positionals, ['lasagne']);
});

test('a negative-looking value is consumed, not dropped', () => {
  // The value reaches the command to be rejected there — `-q -5` must not
  // quietly fall back to a default quantity.
  const args = parseArgs(['-q', '-5'], new Set());
  assert.equal(args.flags['qty'], '-5');
});

test('a supplied numeric flag must actually be a number', () => {
  // Absent falls back; supplied-but-broken must not quietly plan (and
  // commit) with a different value than the one asked for.
  assert.equal(numberFlag({ positionals: [], flags: {} }, 'horizon', 7), 7);
  assert.equal(numberFlag({ positionals: [], flags: { horizon: '14' } }, 'horizon', 7), 14);
  assert.throws(() => numberFlag({ positionals: [], flags: { horizon: 'nope' } }, 'horizon', 7), MiseError);
  assert.throws(() => numberFlag({ positionals: [], flags: { horizon: true } }, 'horizon', 7), MiseError);
});

test('an empty numeric value is rejected, not read as zero', () => {
  // `--horizon=` would otherwise slip through as Number('') === 0 and plan
  // an empty horizon nobody asked for.
  assert.throws(() => numberFlag({ positionals: [], flags: { horizon: '' } }, 'horizon', 7), MiseError);
});

test('an inline value keeps every character after the first =', () => {
  // split-with-limit truncates: `--db=/tmp/mise=prod.json` must not quietly
  // become /tmp/mise and overwrite whatever lives there.
  const args = parseArgs(['--db=/tmp/mise=prod.json'], new Set());
  assert.equal(args.flags['db'], '/tmp/mise=prod.json');

  // The empty inline value still reads as supplied-but-empty, not boolean.
  assert.equal(parseArgs(['--db='], new Set()).flags['db'], '');
});

test('a supplied string flag must actually have a value', () => {
  // `mise init --db --force`: bare `--db` parses as boolean true, and a
  // silent fall-back to the default path would overwrite the very database
  // the flag was trying to steer away from. Refuse before anything moves.
  assert.equal(stringFlag({ positionals: [], flags: {} }, 'db'), undefined);
  assert.equal(stringFlag({ positionals: [], flags: { db: 'other.json' } }, 'db'), 'other.json');
  assert.throws(() => stringFlag({ positionals: [], flags: { db: true } }, 'db'), MiseError);
  assert.throws(() => stringFlag({ positionals: [], flags: { db: '' } }, 'db'), MiseError);
});
