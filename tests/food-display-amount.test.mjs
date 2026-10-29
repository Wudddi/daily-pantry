import test from 'node:test';
import assert from 'node:assert/strict';
import { foodDisplayAmount } from '../lib/food-display-amount.mjs';

test('frozen package weight presents grams without changing original inventory quantities', () => {
  const line = { quantity: .025, unit: '袋', nutritionSnapshot: { unit: '袋', gramsPerUnit: 1000, nutrition: { basisUnit: 'g' } } };
  const before = structuredClone(line), value = foodDisplayAmount(Object.freeze(line));
  assert.equal(value.text, '25 g');
  assert.equal(value.quantity, 25); assert.equal(value.unit, 'g');
  assert.deepEqual(line, before);
  assert.equal(foodDisplayAmount({ ...line, quantity: .1, unit: '个', nutritionSnapshot: { ...line.nutritionSnapshot, unit: '个', gramsPerUnit: 200 } }).text, '20 g');
});

test('drink volumes normalize to mL and never assume liquid density or package volume', () => {
  assert.equal(foodDisplayAmount({ quantity: 25, unit: 'ml' }).text, '25 mL');
  assert.equal(foodDisplayAmount({ quantity: 150, unit: 'mL' }).text, '150 mL');
  assert.equal(foodDisplayAmount({ quantity: .1, unit: '罐', nutritionSnapshot: { unit: '罐', gramsPerUnit: 200, nutrition: { basisUnit: 'ml' } } }).text, '0.1 罐');
});

test('missing conversions keep original evidence, and a conversion for another physical unit is never borrowed', () => {
  assert.equal(foodDisplayAmount({ quantity: .125, unit: '袋' }).text, '0.125 袋');
  assert.equal(foodDisplayAmount({ quantity: .1, unit: '个', nutritionSnapshot: { unit: '袋', gramsPerUnit: 1000 } }).text, '0.1 个');
  assert.equal(foodDisplayAmount({ quantity: null, unit: 'g' }).text, '用量未报');
  assert.equal(foodDisplayAmount({ quantity: 0, unit: 'g' }).text, '0 g');
});

test('precomputed row display units are presentation only and do not convert a second time', () => {
  assert.equal(foodDisplayAmount({ quantity: .025, unit: '袋', displayQuantity: 25, displayUnit: 'g' }).text, '25 g');
});
