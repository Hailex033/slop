import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversionError } from '../src/domain/errors.js';
import { canConvert, convert, parseQuantity, parseUom } from '../src/domain/units.js';

test('converts within a dimension', () => {
  assert.equal(convert(1, 'kg', 'g'), 1000);
  assert.equal(convert(500, 'g', 'kg'), 0.5);
  assert.equal(convert(1, 'l', 'ml'), 1000);
  assert.ok(Math.abs(convert(1, 'cup', 'ml') - 236.5882365) < 1e-6);
  assert.ok(Math.abs(convert(3, 'tsp', 'tbsp') - 1) < 1e-9);
});

test('bridges volume to mass with a density', () => {
  // A cup of flour at 0.53 g/ml is famously about 125 g.
  const grams = convert(1, 'cup', 'g', { densityGPerMl: 0.53 });
  assert.ok(Math.abs(grams - 125.4) < 0.5, `expected ~125 g, got ${grams}`);
  assert.ok(Math.abs(convert(grams, 'g', 'cup', { densityGPerMl: 0.53 }) - 1) < 1e-9);
});

test('bridges count to mass with a unit weight', () => {
  assert.equal(convert(3, 'ea', 'g', { unitWeightG: 58 }), 174);
  assert.equal(convert(174, 'g', 'ea', { unitWeightG: 58 }), 3);
  assert.equal(convert(1, 'doz', 'g', { unitWeightG: 58 }), 696);
});

test('bridges count to volume through mass and density', () => {
  const ml = convert(2, 'ea', 'ml', { unitWeightG: 50, densityGPerMl: 0.5 });
  assert.equal(ml, 200);
});

test('refuses to guess when the coefficient is missing, and says which one', () => {
  assert.throws(
    () => convert(1, 'cup', 'g', { label: 'Sugar' }),
    (error: unknown) => {
      assert.ok(error instanceof ConversionError);
      assert.match(error.message, /densityGPerMl/);
      assert.match(error.message, /Sugar/);
      return true;
    },
  );
  assert.equal(canConvert('cup', 'g'), false);
  assert.equal(canConvert('cup', 'g', { densityGPerMl: 1 }), true);
});

test('parses units people actually type', () => {
  assert.equal(parseUom('grams'), 'g');
  assert.equal(parseUom('Tablespoons'), 'tbsp');
  assert.equal(parseUom('ML'), 'ml');
  assert.throws(() => parseUom('smidgen'), ConversionError);
});

test('parses quantities off a recipe card', () => {
  assert.equal(parseQuantity('1.5'), 1.5);
  assert.equal(parseQuantity('3/4'), 0.75);
  assert.equal(parseQuantity('1 1/2'), 1.5);
  assert.equal(parseQuantity('½'), 0.5);
  assert.equal(parseQuantity('2½'), 2.5);
  assert.throws(() => parseQuantity('some'), ConversionError);
});
