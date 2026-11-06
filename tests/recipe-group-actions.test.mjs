import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { recipeGroupEditView, previewRecipeGroupAction } from '../lib/recipe-group-actions.mjs';

const DAY = '2026-11-06', AT = DAY + 'T16:00:00.000Z';
let sequence = 0;
const copy = value => structuredClone(value);
const plan = state => state.plans[0], meal = state => plan(state).meals[0];
const group = state => meal(state).recipeGroups[0];
const amount = (state, lineId) => meal(state).plannedItems.find(line => line.id === lineId)?.quantity;
function mutate(state, action, fields, operationId = 'recipe-action-test-' + (++sequence)) {
  return applyMutation(state, { action, ...fields, operationId, expectedRevision: state.revision }, AT);
}
function fixture() {
  const items = ['banana', 'cocoa', 'milk'].map(id => validateItem({ id, name: id, quantity: 1000,
    unit: id === 'milk' ? 'ml' : 'g', category: 'other', nutrition: { basisAmount: 1, basisUnit: id === 'milk' ? 'ml' : 'g',
      kcal: 1, protein: 0, carbs: 0, fat: 0, source: 'estimate' } }, AT));
  return mutate({ schemaVersion: 1, revision: 0, updatedAt: AT, items, plans: [], preferences: [], events: [], operationIds: [],
    dailyMenuSettlementPolicy: { version: 1, enabled: false, timeZone: 'America/Toronto', startsOn: DAY, updatedAt: AT, sourceText: "Automatic settlement disabled" } },
  'save_meal_plan_draft', { plan: { id: 'day', date: DAY, title: "Recipe adjustment", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedItems: [
      { id: 'banana-in', itemId: 'banana', quantity: 101 }, { id: 'cocoa-in', itemId: 'cocoa', quantity: 5.5 },
      { id: 'banana-side', itemId: 'banana', quantity: 30 }, { id: 'milk-in', itemId: 'milk', quantity: 100 },
    ], recipeGroups: [{ id: 'brownie', name: "Banana chocolate brownies", lineIds: ['banana-in', 'cocoa-in', 'milk-in'] }] },
    { id: 'dinner', slot: 'dinner', title: "Dinner", plannedItems: [{ id: 'banana-dinner', itemId: 'banana', quantity: 50 }],
      recipeGroups: [{ id: 'existing-brownie', name: "Banana chocolate brownies", lineIds: ['banana-dinner'] }] },
  ], supplementDoses: [] } });
}
const scale = (state, targetPortion) => mutate(state, 'scale_recipe_group', { planId: 'day', mealId: 'breakfast', groupId: 'brownie', targetPortion });

test('absolute recipe portions use the preserved original basis and do not multiply an already halved recipe again', () => {
  const original = fixture(); let state = scale(original, 0.5);
  assert.equal(amount(state, 'banana-in'), 50.5); assert.equal(amount(state, 'cocoa-in'), 2.75);
  assert.equal(amount(state, 'milk-in'), 50); assert.equal(amount(state, 'banana-side'), 30);
  assert.equal(group(state).portion, 0.5);
  assert.strictEqual(scale(state, 0.5), state);
  state = scale(state, 0.125); state = scale(state, 1);
  assert.deepEqual(meal(state).plannedItems, meal(original).plannedItems);
  assert.deepEqual(state.items, original.items);
  assert.equal(state.dailyMenuSettlementPolicy.enabled, false);
});

test('a Chat-declared half portion establishes a full-portion basis without changing ingredient quantities', () => {
  let state = fixture();
  state = mutate(state, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'breakfast',
    recipeGroups: [{ id: 'brownie', name: "Already planned half portion", lineIds: ['banana-in', 'cocoa-in', 'milk-in'], portion: 0.5 }] }] });
  assert.equal(amount(state, 'banana-in'), 101);
  state = scale(state, 1); assert.equal(amount(state, 'banana-in'), 202); assert.equal(amount(state, 'cocoa-in'), 11);
});

test('rename retains the basis, while an explicit manual ingredient edit deliberately rebuilds that ingredient basis', () => {
  let state = scale(fixture(), 0.5);
  state = mutate(state, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'breakfast',
    recipeGroups: [{ id: 'brownie', name: "Renamed brownies", lineIds: ['banana-in', 'cocoa-in', 'milk-in'] }] }] });
  assert.equal(group(state).portion, 0.5);
  assert.equal(group(state).baseQuantities.find(row => row.lineId === 'banana-in').quantity, 101);
  state = mutate(state, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'cocoa-in', quantity: 4 }] }] });
  state = scale(state, 1);
  assert.equal(amount(state, 'banana-in'), 101); assert.equal(amount(state, 'cocoa-in'), 8);
  const before = copy(state);
  assert.throws(() => mutate(state, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'breakfast',
    recipeGroups: [{ ...group(state), baseQuantities: [{ lineId: 'banana-in', quantity: 999 }] }] }] }), error => error.code === 'INVALID_RECIPE_GROUPS');
  assert.deepEqual(state, before);
});

test('preview is detached, validates a stable fingerprint and rejects amounts smaller than recorded intake', () => {
  let state = fixture();
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'breakfast', mode: 'append', entries: [
    { id: 'actual-cocoa', itemId: 'cocoa', quantity: 4, unit: 'g', sourceText: "Actually ate 4 g cocoa" },
  ] });
  const view = recipeGroupEditView(plan(state), state.items, 'breakfast', 'brownie'), original = copy(state);
  assert.equal(view.canMove, true);
  assert.throws(() => scale(state, 0.5), error => error.code === 'RECIPE_BELOW_ACTUAL');
  const action = { action: 'scale_recipe_group', planId: 'day', mealId: 'breakfast', groupId: 'brownie', targetPortion: 2,
    expectedFingerprint: view.fingerprint };
  assert.equal(previewRecipeGroupAction(plan(state), state.items, action).plan.meals[0].plannedItems[0].quantity, 202);
  assert.throws(() => previewRecipeGroupAction(plan(state), state.items, { ...action, expectedFingerprint: 'stale' }), error => error.code === 'RECIPE_GROUP_STALE');
  assert.deepEqual(state, original);
});

test('moving a half recipe preserves mixed units, frozen ingredient snapshots and same-name target groups without SKU merging', () => {
  let state = fixture(); const original = copy(state), targetBefore = copy(plan(state).meals[1]);
  state = mutate(state, 'move_recipe_group', { planId: 'day', fromMealId: 'breakfast', groupId: 'brownie', toMealId: 'dinner',
    fractionOfRemaining: 0.5, transferId: 'half-recipe' });
  assert.equal(amount(state, 'banana-in'), 50.5); assert.equal(amount(state, 'banana-side'), 30);
  const target = plan(state).meals[1], moved = target.recipeGroups.find(value => value.id !== 'existing-brownie');
  assert.equal(moved.name, "Banana chocolate brownies"); assert.equal(moved.portion, 0.5); assert.equal(group(state).portion, 0.5);
  assert.equal(target.plannedItems.length, 4); assert.deepEqual(target.plannedItems[0], targetBefore.plannedItems[0]);
  for (const [index, id] of ['banana-in', 'cocoa-in', 'milk-in'].entries()) {
    const source = meal(original).plannedItems.find(line => line.id === id), line = target.plannedItems[index + 1];
    assert.deepEqual(line.nutritionSnapshot, source.nutritionSnapshot); assert.equal(line.unit, source.unit);
  }
  assert.deepEqual(state.items, original.items); assert.deepEqual(plan(state).accountedDebits, []);
  const before = copy(state); state.operationIds = [];
  assert.throws(() => mutate(state, 'move_recipe_group', { planId: 'day', fromMealId: 'breakfast', groupId: 'brownie', toMealId: 'dinner',
    fractionOfRemaining: 0.5, transferId: 'half-recipe' }), error => error.code === 'RECIPE_TRANSFER_ALREADY_APPLIED');
  assert.deepEqual(state.plans, before.plans);
});

test('only the selected dish is protected by ambiguous actuals; a different dish remains editable', () => {
  let state = fixture();
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'breakfast', mode: 'append', entries: [
    { id: 'ambiguous-banana', itemId: 'banana', quantity: 10, unit: 'g', sourceText: "Actually ate 10 g banana, without specifying recipe or side food" },
  ] });
  assert.equal(recipeGroupEditView(plan(state), state.items, 'breakfast', 'brownie').canScale, false);
  state = mutate(state, 'scale_recipe_group', { planId: 'day', mealId: 'dinner', groupId: 'existing-brownie', targetPortion: 0.5 });
  assert.equal(plan(state).meals[1].plannedItems[0].quantity, 25);
});
