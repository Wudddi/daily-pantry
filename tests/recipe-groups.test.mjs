import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { materializeDietPlanForEdit, readDietRecords } from '../lib/diet.mjs';
import { projectCurrentDietPlan } from '../lib/diet-current-plan.mjs';
import { intakePlanFingerprint, intakeDraftVersion } from '../lib/intake-draft.mjs';
import { normalizeRecipeGroups, pruneRecipeGroups } from '../lib/recipe-groups.mjs';

const DAY = '2026-11-02', AT = DAY + 'T16:00:00.000Z';
let sequence = 0;
const copy = value => structuredClone(value);
const current = state => state.plans[0];
const breakfast = state => current(state).meals[0];
const grouped = [{ id: 'brownie', name: "Banana chocolate brownies", lineIds: ['banana-in', 'cocoa-in'] }];
const mutate = (state, action, fields) => applyMutation(state,
  { action, ...fields, operationId: 'recipe-group-test-' + (++sequence), expectedRevision: state.revision }, AT);
function menu() {
  return { id: 'day', date: DAY, title: "Dishes and separate fruit", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedItems: [
      { id: 'banana-in', itemId: 'banana', quantity: 100 }, { id: 'cocoa-in', itemId: 'cocoa', quantity: 5 },
      { id: 'banana-side', itemId: 'banana', quantity: 50 }, { id: 'milk-side', itemId: 'milk', quantity: 150 },
    ], recipeGroups: copy(grouped) },
    { id: 'dinner', slot: 'dinner', title: "Dinner", plannedItems: [] },
  ], supplementDoses: [] };
}
function fixture() {
  const items = ['banana', 'cocoa', 'milk'].map(id => validateItem({ id, name: id, category: 'other', quantity: 1000,
    unit: id === 'milk' ? 'ml' : 'g', nutrition: { basisAmount: 1, basisUnit: id === 'milk' ? 'ml' : 'g',
      kcal: 1, protein: 0, carbs: 0, fat: 0, source: 'estimate' } }, AT));
  return mutate({ schemaVersion: 1, revision: 0, updatedAt: AT, items, plans: [], preferences: [], events: [], operationIds: [],
    dailyMenuSettlementPolicy: { version: 1, enabled: false, timeZone: 'America/Toronto', startsOn: DAY, updatedAt: AT, sourceText: "Keep disabled" } },
  'save_meal_plan_draft', { plan: menu() });
}
function patch(state, mealPatch) {
  return mutate(state, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [mealPatch] });
}

test('recipe metadata validates references to planned line IDs without grouping the same SKU side portion', () => {
  const input = copy(grouped), lines = menu().meals[0].plannedItems;
  assert.deepEqual(normalizeRecipeGroups(input, lines), grouped);
  assert.deepEqual(input, grouped);
  assert.deepEqual(pruneRecipeGroups(input, lines.filter(line => line.id !== 'banana-in')),
    [{ id: 'brownie', name: "Banana chocolate brownies", lineIds: ['cocoa-in'] }]);
  assert.deepEqual(pruneRecipeGroups(input, [{ id: 'banana-side' }]), []);
  for (const invalid of [
    null, [{ ...grouped[0], quantity: 1 }], [{ ...grouped[0], nutrition: { kcal: 1 } }],
    [{ ...grouped[0], name: '' }], [{ ...grouped[0], name: "x".repeat(101) }],
    [{ ...grouped[0], id: 'x'.repeat(101) }], [{ ...grouped[0], lineIds: [] }],
    [{ ...grouped[0], lineIds: ['banana-in', 'banana-in'] }],
    [{ ...grouped[0], lineIds: ['line-in-another-meal'] }],
    [...grouped, { id: 'another', name: "Another dish", lineIds: ['banana-in'] }],
    [...grouped, { ...grouped[0], lineIds: ['banana-side'] }],
    Array.from({ length: 21 }, (_, index) => ({ id: 'g' + index, name: "Dish", lineIds: ['banana-in'] })),
  ]) assert.throws(() => normalizeRecipeGroups(invalid, lines), error => error.code === 'INVALID_RECIPE_GROUPS');
});

test('grouped saves retain flat stable food lines and expose the metadata in detached edit and record reads', () => {
  const state = fixture(), original = copy(state);
  assert.deepEqual(breakfast(state).recipeGroups, grouped);
  assert.deepEqual(breakfast(state).plannedItems.map(line => line.id), ['banana-in', 'cocoa-in', 'banana-side', 'milk-side']);
  assert.equal(state.items.length, 3);
  assert.ok(state.items.every(item => item.quantity === 1000));
  assert.deepEqual(current(state).accountedDebits, []);
  assert.deepEqual(readDietRecords(state, { planId: 'day' }).records[0].meals[0].recipeGroups, grouped);
  const edit = materializeDietPlanForEdit(state, 'day');
  edit.meals[0].recipeGroups[0].name = "Local edit";
  assert.deepEqual(state, original);
});

test('metadata-only patches preserve omitted groups, support explicit clearing and retain exact no-op semantics', () => {
  let state = fixture();
  state = patch(state, { id: 'breakfast', title: "New breakfast title" });
  assert.deepEqual(breakfast(state).recipeGroups, grouped);
  assert.strictEqual(patch(state, { id: 'breakfast', recipeGroups: copy(grouped) }), state);
  state = patch(state, { id: 'breakfast', recipeGroups: [] });
  assert.deepEqual(breakfast(state).recipeGroups, []);
  assert.ok(state.items.every(item => item.quantity === 1000));
});

test('a single patch can add a meal, its ingredient lines and groups without referencing an intermediate empty meal', () => {
  const state = patch(fixture(), { id: 'snack', slot: 'snack', title: "Basque cheesecake", itemPatches: [
    { id: 'snack-milk', itemId: 'milk', quantity: 50 }, { id: 'snack-cocoa', itemId: 'cocoa', quantity: 3 },
  ], recipeGroups: [{ id: 'basque', name: "Cocoa Basque cheesecake", lineIds: ['snack-milk', 'snack-cocoa'] }] });
  assert.deepEqual(current(state).meals.find(meal => meal.id === 'snack').recipeGroups,
    [{ id: 'basque', name: "Cocoa Basque cheesecake", lineIds: ['snack-milk', 'snack-cocoa'] }]);
});

test('full saves that omit groups preserve them and ingredient removal prunes inherited references and empty dishes', () => {
  let state = fixture();
  const full = menu(); delete full.meals[0].recipeGroups;
  full.meals[0].title = "Full save omitting metadata";
  state = mutate(state, 'save_meal_plan_draft', { plan: full });
  assert.deepEqual(breakfast(state).recipeGroups, grouped);
  state = patch(state, { id: 'breakfast', itemPatches: [{ id: 'banana-in', remove: true }] });
  assert.deepEqual(breakfast(state).recipeGroups, [{ ...grouped[0], lineIds: ['cocoa-in'] }]);
  state = patch(state, { id: 'breakfast', itemPatches: [{ id: 'cocoa-in', remove: true }] });
  assert.deepEqual(breakfast(state).recipeGroups, []);
  assert.deepEqual(breakfast(state).plannedItems.map(line => line.id), ['banana-side', 'milk-side']);
});

test('explicit invalid references are rejected atomically instead of silently pruned as inherited metadata', () => {
  const state = fixture(), before = copy(state);
  for (const fields of [
    { recipeGroups: [{ ...grouped[0], lineIds: ['not-in-this-meal'] }] },
    { itemPatches: [{ id: 'banana-in', remove: true }], recipeGroups: copy(grouped) },
    { recipeGroups: [{ ...grouped[0], inventoryItemId: 'new-recipe' }] },
  ]) assert.throws(() => patch(state, { id: 'breakfast', ...fields }), error => error.code === 'INVALID_RECIPE_GROUPS');
  assert.deepEqual(state, before);
});

test('adopted meal revision history retains the previous dish membership without rewriting inventory', () => {
  let state = mutate(fixture(), 'commit_meal_plan', { planId: 'day', confirmed: true });
  const items = copy(state.items), previous = copy(breakfast(state).plannedItems);
  state = patch(state, { id: 'breakfast', recipeGroups: [{ ...grouped[0], name: "Banana cocoa cake" }] });
  assert.deepEqual(breakfast(state).planRevisionHistory.at(-1).previous.recipeGroups, grouped);
  assert.deepEqual(breakfast(state).plannedItems, previous);
  assert.deepEqual(state.items, items);
});

test('legacy draft projection retains named recipes and prunes removed ingredients without mutating either source', () => {
  const state = fixture(), source = copy(current(state));
  source.draft = menu(); delete source.draft.meals[0].recipeGroups;
  source.draft.meals[0].plannedItems = source.draft.meals[0].plannedItems.filter(line => line.id !== 'cocoa-in');
  const original = copy(source), projected = projectCurrentDietPlan(source, state.items);
  assert.deepEqual(projected.meals[0].recipeGroups, [{ ...grouped[0], lineIds: ['banana-in'] }]);
  assert.deepEqual(source, original);
  source.draft.meals[0].recipeGroups = [];
  assert.deepEqual(projectCurrentDietPlan(source, state.items).meals[0].recipeGroups, []);
});

test('display grouping keeps intake drafts current and transfer-only submission prunes zero source rows without accounting', () => {
  let state = fixture();
  const fingerprint = intakePlanFingerprint(current(state), state.items);
  state = patch(state, { id: 'breakfast', recipeGroups: [{ ...grouped[0], name: "Rename dish" }] });
  assert.equal(intakePlanFingerprint(current(state), state.items), fingerprint);
  const items = copy(state.items), policy = copy(state.dailyMenuSettlementPolicy);
  state = mutate(state, 'save_intake_draft', { planId: 'day', expectedDraftVersion: null, draft: {
    id: 'transfer-only', baseFingerprint: fingerprint, consumed: [], completedMealIds: [],
    transfers: [{ id: 'move-banana', fromMealId: 'breakfast', lineId: 'banana-in', toMealId: 'dinner', quantity: 100 },
      { id: 'move-cocoa', fromMealId: 'breakfast', lineId: 'cocoa-in', toMealId: 'dinner', quantity: 5 }],
  } });
  const draft = current(state).intakeDraft;
  state = mutate(state, 'submit_intake_draft', { planId: 'day', draftId: draft.id,
    baseFingerprint: draft.baseFingerprint, expectedDraftVersion: intakeDraftVersion(draft) });
  assert.deepEqual(breakfast(state).recipeGroups, []);
  assert.deepEqual(breakfast(state).plannedItems.map(line => line.id), ['banana-side', 'milk-side']);
  assert.equal(current(state).meals[1].plannedItems.length, 2);
  assert.equal(current(state).meals[1].recipeGroups, undefined);
  assert.deepEqual(state.items, items);
  assert.deepEqual(current(state).accountedDebits, []);
  assert.deepEqual(state.dailyMenuSettlementPolicy, policy);
});
