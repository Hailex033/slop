/**
 * The argument parser's contract. The full commands run against a real
 * database file, so they are exercised by the smoke tests; the parser is the
 * part with sharp edges worth pinning down.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/cli.js';

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
