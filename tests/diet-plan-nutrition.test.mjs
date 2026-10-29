import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { nutritionFactor, planNutritionTotals } from '../lib/diet-nutrition.mjs';

const NOW = '2026-10-18T13:00:00.000Z';
function fixture() {
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, preferences: [], events: [], operationIds: [], plans: [], items: [validateItem({ id: 'tuna', name: "Ocean's 金枪鱼", category: 'protein', quantity: 3, unit: '罐', gramsPerUnit: null, nutrition: { basisAmount: 55, basisUnit: 'g', kcal: 60, protein: 13, carbs: 0, fat: 0.5, source: 'label', sourceText: '原包装每55g营养，整罐沥干重尚未确认' } }, NOW)] };
}
function estimate(patch = {}) {
  return { basisAmount: 1, basisUnit: '罐', kcal: 80, protein: 17.6, carbs: 0, fat: 0.7, source: 'estimate', sourceNote: '按本次菜单的一罐份量暂估；不是已确认的整罐标签或沥干克重。', ...patch };
}
function plan(nutrition = estimate()) {
  return { id: 'day-oct18', date: '2026-10-18', title: '金枪鱼沙拉', meals: [{ id: 'dinner', slot: 'dinner', title: '晚餐', plannedItems: [{ id: 'tuna-line', itemId: 'tuna', quantity: 1, unit: '罐', ...(nutrition === undefined ? {} : { nutrition }) }] }], supplementDoses: [] };
}
function apply(state, action, payload, operationId = `${action}-${state.revision}`) {
  return applyMutation(state, { action, ...payload, operationId, expectedRevision: state.revision }, NOW);
}
function saved(state) { return state.plans[0].meals[0].plannedItems[0]; }

test('tracked can gets a sourced plan-only nutrition estimate while the inventory g label stays unchanged', () => {
  const before = fixture();
  const state = apply(before, 'save_meal_plan_draft', { plan: plan() });
  assert.deepEqual(state.items, before.items);
  assert.equal(saved(state).nutritionSnapshot.nutrition.basisUnit, '罐');
  assert.equal(saved(state).nutritionSnapshot.nutrition.kcal, 80);
  assert.equal(saved(state).nutritionSnapshot.nutrition.source, 'estimate');
  assert.match(saved(state).nutritionSnapshot.nutrition.sourceNote, /仅本次计划口径估算/);
  assert.deepEqual(saved(state).nutrition, saved(state).nutritionSnapshot.nutrition);
  assert.equal(nutritionFactor(saved(state).nutritionSnapshot, 1, '罐'), 1);
  assert.equal(planNutritionTotals(state.plans[0])[0].value, 80);
  assert.equal(state.items[0].nutrition.basisUnit, 'g');
  assert.equal(state.items[0].nutrition.basisAmount, 55);
  assert.equal(state.items[0].gramsPerUnit, null);
});

test('saving, confirming and reporting as planned preserve the estimate and deduct exactly one can once', () => {
  const original = fixture(), input = plan();
  let state = apply(original, 'save_meal_plan_draft', { plan: input });
  assert.equal(apply(state, 'save_meal_plan_draft', { plan: input }, 'same-draft'), state);
  const snapshot = structuredClone(saved(state).nutritionSnapshot);
  state = apply(state, 'commit_meal_plan', { planId: input.id, confirmed: true });
  assert.equal(state.items[0].quantity, 3);
  assert.deepEqual(saved(state).nutritionSnapshot, snapshot);
  assert.equal(apply(state, 'save_meal_plan_draft', { plan: input }, 'same-reserved-draft'), state);
  assert.equal(apply(state, 'commit_meal_plan', { planId: input.id, confirmed: true }, 'repeat-confirmation'), state);
  const report = { planId: input.id, mealId: 'dinner', mode: 'complete', matchesPlannedFood: true, sourceText: '晚饭按已确认计划吃完；没有报告时间' };
  state = apply(state, 'record_meal_intake', report);
  const actual = state.plans[0].meals[0].actualEntries[0];
  assert.deepEqual(actual.nutritionSnapshot, snapshot);
  assert.equal(actual.quantitySource, 'confirmed_plan_portion');
  assert.equal(state.plans[0].meals[0].actualTime, null);
  assert.equal(state.items[0].quantity, 2);
  assert.equal(apply(state, 'record_meal_intake', report, 'repeat-report'), state);
  assert.deepEqual(state.items[0].nutrition, original.items[0].nutrition);
  assert.equal(state.items[0].gramsPerUnit, null);
});

test('plan-only estimate survives normalized content round trips without duplicating its disclosure', () => {
  let state = apply(fixture(), 'save_meal_plan_draft', { plan: plan() });
  const normalized = structuredClone(state.plans[0]);
  assert.equal(apply(state, 'save_meal_plan_draft', { plan: normalized }), state);
  state = apply(state, 'commit_meal_plan', { planId: normalized.id, confirmed: true });
  assert.equal((saved(state).nutrition.sourceNote.match(/仅本次计划口径估算/g) || []).length, 1);
});

test('missing evidence, misleading sources and invalid or incompatible nutrition bases reject atomically', () => {
  const invalid = [
    estimate({ source: undefined }), estimate({ source: 'unknown' }), estimate({ source: 'label' }),
    estimate({ nutrientSources: { protein: 'label' } }),
    estimate({ sourceNote: '', sourceText: '' }), estimate({ sourceNote: ' \n ', sourceText: '  ' }),
    estimate({ basisAmount: 0 }), estimate({ basisAmount: -1 }), estimate({ basisAmount: undefined }),
    estimate({ basisUnit: undefined }), estimate({ basisUnit: 'g' }), estimate({ basisUnit: '无效单位' }),
    estimate({ kcal: null, protein: null, carbs: null, fat: null }),
  ];
  for (const nutrition of invalid) {
    const before = fixture(), copy = structuredClone(before);
    assert.throws(() => apply(before, 'save_meal_plan_draft', { plan: plan(nutrition) }));
    assert.deepEqual(before, copy);
  }
  const sourceTextOnly = estimate({ sourceNote: '', sourceText: '本次菜谱按整罐份量估算，包装仍只有55g口径。' });
  assert.equal(saved(apply(fixture(), 'save_meal_plan_draft', { plan: plan(sourceTextOnly) })).nutrition.kcal, 80);
});

test('tracked food without an override still snapshots its existing inventory nutrition', () => {
  const before = fixture(), input = plan(); delete input.meals[0].plannedItems[0].nutrition;
  let state = apply(before, 'save_meal_plan_draft', { plan: input });
  assert.equal(Object.hasOwn(saved(state), 'nutrition'), false);
  assert.deepEqual(saved(state).nutritionSnapshot.nutrition, before.items[0].nutrition);
  assert.equal(nutritionFactor(saved(state).nutritionSnapshot, 1, '罐'), null);
  state = apply(state, 'commit_meal_plan', { planId: input.id, confirmed: true });
  state = apply(state, 'record_meal_intake', { planId: input.id, mealId: 'dinner', mode: 'complete', matchesPlannedFood: true });
  assert.deepEqual(state.plans[0].meals[0].actualEntries[0].nutritionSnapshot.nutrition, before.items[0].nutrition);
  assert.equal(state.items[0].quantity, 2);
});

test('ordinary actual reports ignore fabricated client snapshots and inherit only the unique confirmed server override', () => {
  let state = apply(fixture(), 'save_meal_plan_draft', { plan: plan() });
  state = apply(state, 'commit_meal_plan', { planId: state.plans[0].id, confirmed: true });
  const label = structuredClone(state.items[0].nutrition);
  const fake = { name: '虚构营养', nutrition: estimate({ kcal: 999 }), gramsPerUnit: 1 };
  state = apply(state, 'record_meal_intake', { planId: state.plans[0].id, mealId: 'dinner', mode: 'complete', matchesPlannedFood: 'true', entries: [{ id: 'ordinary-actual', itemId: 'tuna', quantity: 1, unit: '罐', sourceText: '另行报告吃了一罐', nutritionSnapshot: fake, nutrition: estimate({ kcal: 999 }) }] });
  const actual = state.plans[0].meals[0].actualEntries[0];
  assert.deepEqual(actual.nutritionSnapshot.nutrition, state.plans[0].meals[0].plannedItems[0].nutritionSnapshot.nutrition);
  assert.equal(actual.nutritionSnapshot.nutrition.kcal, 80);
  assert.deepEqual(state.items[0].nutrition, label);
  assert.equal(actual.quantitySource, 'reported');
  assert.equal(state.items[0].quantity, 2);
});
