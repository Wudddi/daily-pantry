import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { previewFoodPlanSync } from '../lib/sync-food-plan.mjs';
import { intakeDraftView } from '../lib/intake-draft.mjs';

const AT = '2026-02-12T16:00:00.000Z';
const planId = 'demo-weighed-sync-day';
let sequence = 0;
const mutate = (state, action, payload) => applyMutation(state,
  { operationId: 'demo-weighed-operation-' + ++sequence, expectedRevision: state.revision, action, ...payload }, AT);
function fixture() {
  const make = id => validateItem({ id, name: 'DEMO prepared food ' + id, category: 'prepared', quantity: 5, unit: '袋', gramsPerUnit: 100,
    nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 20, carbs: 20, fat: 4, source: 'label' } }, AT);
  let state = { schemaVersion: 1, revision: 0, updatedAt: AT, events: [], operationIds: [], preferences: [],
    items: [make('demo-native-bag'), make('demo-other-bag')], plans: [] };
  state = mutate(state, 'save_meal_plan_draft', { plan: { id: planId, date: '2026-02-12', title: 'DEMO weighed food',
    meals: [{ id: 'breakfast', slot: 'breakfast', title: 'Breakfast', plannedItems: [{ id: 'bf-bag', itemId: 'demo-native-bag', quantity: 1 }] }] } });
  state = mutate(state, 'record_meal_intake', { planId, mealId: 'breakfast', mode: 'complete',
    entries: [{ id: 'demo-weighed-actual', itemId: 'demo-native-bag', quantity: 60, unit: 'g', sourceText: 'DEMO explicit measured portion: 60 g.' }] });
  const preview = previewFoodPlanSync(state.plans[0], state.items);
  assert.equal(preview.canApply, true);
  return mutate(state, 'sync_food_plan', { planId, expectedFingerprint: preview.fingerprint });
}

test('a synchronized weighed line can be edited in its saved non-native unit without altering actuals or inventory', () => {
  const state = fixture(), before = structuredClone(state), meal = state.plans[0].meals[0], line = meal.plannedItems[0];
  assert.equal(line.unit, 'g');
  assert.deepEqual(line.syncActualEntryIds, ['demo-weighed-actual']);
  const after = mutate(state, 'patch_meal_plan', { planId, mode: 'draft', mealPatches: [{ id: meal.id,
    itemPatches: [{ id: line.id, quantity: 70 }] }] });
  const changed = after.plans[0].meals[0];
  assert.equal(changed.plannedItems[0].quantity, 70);
  assert.equal(changed.plannedItems[0].unit, 'g');
  assert.deepEqual(changed.plannedItems[0].syncActualEntryIds, line.syncActualEntryIds);
  assert.deepEqual(changed.plannedItems[0].nutritionSnapshot, line.nutritionSnapshot);
  assert.deepEqual(changed.actualEntries, meal.actualEntries);
  assert.deepEqual(after.items, before.items);
  for (const key of ['accountedDebits', 'accountingIssues', 'inventoryAccounting', 'allocationAdjustments']) {
    assert.deepEqual(after.plans[0][key], before.plans[0][key]);
  }
  const row = intakeDraftView(after.plans[0], after.items).meals[0].rows[0];
  assert.equal(row.reportedQuantity, 60);
  assert.equal(row.unknown, false);
});

test('saved synchronization links cannot authorize a replacement, a new foreign unit, or forged client metadata', () => {
  const state = fixture(), before = structuredClone(state), line = state.plans[0].meals[0].plannedItems[0];
  const patch = itemPatches => mutate(state, 'patch_meal_plan', { planId, mode: 'draft', mealPatches: [{ id: 'breakfast', itemPatches }] });
  assert.throws(() => patch([{ id: line.id, itemId: 'demo-other-bag', quantity: 70, unit: 'g' }]), /unit/);
  assert.throws(() => patch([{ id: line.id, quantity: 70, unit: 'ml' }]), /unit/);
  assert.throws(() => patch([{ id: 'forged-sync', itemId: 'demo-native-bag', quantity: 70, unit: 'g', syncActualEntryIds: ['demo-weighed-actual'] }]), /unsupported fields/);
  assert.throws(() => mutate(state, 'save_meal_plan_draft', { plan: { id: 'demo-forged-day', date: '2026-02-13', title: 'DEMO invalid links',
    meals: [{ id: 'breakfast', slot: 'breakfast', title: 'Breakfast', plannedItems: [{ id: 'forged', itemId: 'demo-native-bag', quantity: 70,
      unit: 'g', syncActualEntryIds: ['demo-weighed-actual'] }] }] } }), /unit/);
  assert.deepEqual(state, before);
});
