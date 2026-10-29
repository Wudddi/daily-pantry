import test from 'node:test';
import assert from 'node:assert/strict';
import { nutritionFactor, planNutritionTotals } from '../lib/diet-nutrition.mjs';

function snapshot(nutrition = {}, extra = {}) {
  return { name: '测试食物', unit: 'g', gramsPerUnit: null, ingredients: '', supplementFacts: '', nutrition: { basisAmount: 100, basisUnit: 'g', kcal: null, protein: null, carbs: null, fat: null, source: 'label', ...nutrition }, ...extra };
}
function supplement(nutrition, quantity = 1) {
  return { nutritionSnapshot: snapshot({ basisAmount: 1, basisUnit: '粒', ...nutrition }, { name: '测试补给', unit: '粒' }), plannedQuantity: quantity, unit: '粒' };
}
const byKey = totals => Object.fromEntries(totals.map(total => [total.key, total]));

test('supplement-only plans with unknown macros display no numeric total', () => {
  const plan = { meals: [], supplementDoses: [supplement({})] };
  const before = structuredClone(plan);
  for (const total of planNutritionTotals(plan)) {
    assert.equal(total.value, null);
    assert.equal(total.knownCount, 0);
    assert.equal(total.missing, 0);
    assert.equal(total.supplementMissing, 1);
  }
  assert.deepEqual(plan, before, 'reading totals must not replace unknown snapshot values with zero');
});

test('explicit supplement zeros remain known zeros', () => {
  for (const total of planNutritionTotals({ meals: [], supplementDoses: [supplement({ kcal: 0, protein: 0, carbs: 0, fat: 0 }, 2)] })) {
    assert.equal(total.value, 0);
    assert.equal(total.knownCount, 1);
    assert.equal(total.missing, 0);
    assert.equal(total.supplementMissing, 0);
  }
});

test('food plus fish oil adds known calories and fat while keeping unprovided supplement macros separate', () => {
  const plan = {
    meals: [{ plannedItems: [{ quantity: 150, unit: 'g', nutritionSnapshot: snapshot({ kcal: 200, protein: 20, carbs: 10, fat: 8 }) }] }],
    supplementDoses: [supplement({ kcal: 10, fat: 1, nutrientSources: { kcal: 'estimate', fat: 'label' } }, 2)],
  };
  const totals = byKey(planNutritionTotals(plan));
  assert.deepEqual(Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, total.value])), { kcal: 320, protein: 30, carbs: 15, fat: 14 });
  assert.equal(totals.kcal.knownCount, 2);
  assert.equal(totals.kcal.estimated, true);
  assert.equal(totals.fat.estimated, false);
  for (const key of ['protein', 'carbs']) {
    assert.equal(totals[key].knownCount, 1);
    assert.equal(totals[key].missing, 0);
    assert.equal(totals[key].supplementMissing, 1);
  }
});

test('known zero remains numeric even when a food line is unknown', () => {
  const plan = { meals: [{ plannedItems: [{ quantity: 100, unit: 'g', nutritionSnapshot: snapshot() }] }], supplementDoses: [supplement({ kcal: 0, protein: 0, carbs: 0, fat: 0 })] };
  for (const total of planNutritionTotals(plan)) {
    assert.equal(total.value, 0);
    assert.equal(total.knownCount, 1);
    assert.equal(total.missing, 1);
    assert.equal(total.supplementMissing, 0);
  }
});

test('saved unit weights support mass conversion and incompatible units stay unknown', () => {
  const food = snapshot({}, { gramsPerUnit: 250 });
  assert.equal(nutritionFactor(food, 2, '袋'), 5);
  assert.equal(nutritionFactor(snapshot({ basisAmount: 1, basisUnit: '袋' }, { gramsPerUnit: 250 }), 125, 'g'), 0.5);
  assert.equal(nutritionFactor(food, 10, 'ml'), null);
  assert.equal(nutritionFactor(snapshot(), 1, '袋'), null);
  assert.equal(nutritionFactor(null, 1, '粒'), null);
});
