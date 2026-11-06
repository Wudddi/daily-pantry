import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { planNutritionTotals } from '../lib/diet-nutrition.mjs';
import { dailyFoodRollup } from '../lib/daily-food-rollup.mjs';
import { intakeDraftVersion, intakeDraftView, intakePlanFingerprint, intakeEntryId } from '../lib/intake-draft.mjs';
import { recipeGroupEditView } from '../lib/recipe-group-actions.mjs';

const DAY = '2026-11-06', AT = DAY + 'T14:00:00.000Z', LATER = DAY + 'T18:00:00.000Z';
let sequence = 0;
const copy = value => structuredClone(value);
const plan = state => state.plans[0];
const meal = (state, id = 'breakfast') => plan(state).meals.find(value => value.id === id);
const ingredient = (state, lineId, mealId = 'breakfast') => meal(state, mealId).plannedItems.find(line => line.id === lineId);
const stock = (state, id) => state.items.find(value => value.id === id);
const nutrientAmounts = totals => totals.map(({ knownCount, ...total }) => total);
function mutate(state, action, fields = {}, at = AT) {
  return applyMutation(state, { action, operationId: 'recipe-portion-' + (++sequence), expectedRevision: state.revision, ...fields }, at);
}
function food(id, quantity = 1000, unit = 'g', category = 'protein', gramsPerUnit = null) {
  return validateItem({ id, name: id, quantity, unit, category, gramsPerUnit,
    nutrition: { basisAmount: 100, basisUnit: unit === '袋' ? 'g' : unit, kcal: 100, protein: 10, carbs: 15, fat: 2, source: 'label' } }, AT);
}
function fixture() {
  return mutate({ schemaVersion: 1, revision: 0, updatedAt: AT, items: [
    food('yogurt'), food('milk', 1000, 'ml'), food('beef', 10, '袋', 'prepared', 132),
    food('apple', 6, '个', 'fruit'), food('creatine', 100, 'g', 'supplement'), food('unknown-balance', null),
  ], plans: [], events: [], operationIds: [], preferences: [],
    dailyMenuSettlementPolicy: { version: 1, enabled: false, timeZone: 'America/Toronto', startsOn: DAY,
      updatedAt: AT, sourceText: "Local fixture: automatic settlement remains disabled" },
  }, 'save_meal_plan_draft', { plan: { id: 'daily-food-' + DAY, date: DAY, title: "Local fixture: whole-dish adjustment", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedItems: [
      { id: 'dish-yogurt', itemId: 'yogurt', quantity: 200, unit: 'g' },
      { id: 'dish-milk', itemId: 'milk', quantity: 100, unit: 'ml' },
      { id: 'dish-beef', itemId: 'beef', quantity: 1, unit: '袋' },
      { id: 'side-yogurt', itemId: 'yogurt', quantity: 80, unit: 'g' },
    ], recipeGroups: [{ id: 'dish', name: "Original recipe dish", lineIds: ['dish-yogurt', 'dish-milk', 'dish-beef'] }] },
    { id: 'lunch', slot: 'lunch', title: "Lunch", plannedItems: [{ id: 'lunch-yogurt', itemId: 'yogurt', quantity: 50, unit: 'g' }],
      recipeGroups: [{ id: 'dish', name: "Original recipe dish", lineIds: ['lunch-yogurt'] }] },
    { id: 'dinner', slot: 'dinner', title: "Dinner", plannedItems: [{ id: 'apple-dinner', itemId: 'apple', quantity: 1, unit: '个' }] },
  ], supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, timingSlot: 'breakfast' }] } });
}
function scale(state, targetPortion, fields = {}) {
  return mutate(state, 'scale_recipe_group', { planId: plan(state).id, mealId: 'breakfast', groupId: 'dish', targetPortion, ...fields }, LATER);
}
function move(state, fractionOfRemaining = 1, fields = {}) {
  return mutate(state, 'move_recipe_group', { planId: plan(state).id, fromMealId: 'breakfast', groupId: 'dish',
    toMealId: 'lunch', fractionOfRemaining, ...fields }, LATER);
}
function add(state, itemId = 'apple', quantity = 1, fields = {}) {
  return mutate(state, 'add_food_to_meal', { planId: plan(state).id, mealId: 'breakfast', itemId, quantity, ...fields }, LATER);
}
function report(state, mealId, entries, mode = 'append') {
  return mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId, mode, entries,
    sourceText: "Local fixture: the user explicitly reported actual portions" });
}
function ledger(state) {
  return { items: copy(state.items), credits: copy(plan(state).accountedDebits), accountingItems: copy(plan(state).items),
    inventoryAccounting: plan(state).inventoryAccounting, accountingIssues: copy(plan(state).accountingIssues),
    accountingWarnings: copy(plan(state).accountingWarnings), personalFoodChecks: copy(plan(state).personalFoodChecks),
    supplements: copy(plan(state).supplementDoses), policy: copy(state.dailyMenuSettlementPolicy),
    facts: plan(state).meals.map(value => ({ id: value.id, state: value.state, actualEntries: copy(value.actualEntries),
      actualTime: value.actualTime, completionReportedAt: value.completionReportedAt, reportHistory: copy(value.reportHistory) })) };
}
function savedDraft(state) {
  return mutate(state, 'save_intake_draft', { planId: plan(state).id, expectedDraftVersion: null,
    draft: { id: 'pending-recipe-intake', baseFingerprint: intakePlanFingerprint(plan(state), state.items),
      consumed: [{ mealId: 'breakfast', lineId: 'side-yogurt', quantity: 20, unit: 'g' },
        { mealId: 'dinner', lineId: 'apple-dinner', quantity: 0.75, unit: '个' }],
      transfers: [{ id: 'pending-apple-quarter', fromMealId: 'dinner', lineId: 'apple-dinner', toMealId: 'lunch', quantity: 0.25, unit: '个' }],
      completedMealIds: ['dinner'] } });
}

test('absolute half and full recipe portions restore the original ingredients without touching side portions, snapshots or accounting', () => {
  let state = mutate(fixture(), 'set_food_personal_check', { planId: 'daily-food-' + DAY, mealId: 'breakfast', lineIds: ['dish-yogurt'], checked: true });
  const before = ledger(state), source = copy(meal(state).plannedItems), originalNutrition = planNutritionTotals(plan(state));
  state = scale(state, 0.5);
  assert.deepEqual(['dish-yogurt', 'dish-milk', 'dish-beef'].map(id => ingredient(state, id).quantity), [100, 50, 0.5]);
  assert.equal(ingredient(state, 'side-yogurt').quantity, 80);
  assert.deepEqual(ledger(state), before);
  const half = copy(state);
  assert.strictEqual(scale(state, 0.5), state);
  assert.deepEqual(state, half);
  state = scale(state, 1);
  assert.deepEqual(meal(state).plannedItems, source);
  assert.deepEqual(planNutritionTotals(plan(state)), originalNutrition);
  assert.deepEqual(ledger(state), before);
  assert.equal(state.dailyMenuSettlementPolicy.enabled, false);
});

test('renaming a half recipe does not replace its server scaling baseline with the half quantities', () => {
  let state = scale(fixture(), 0.5);
  state = mutate(state, 'patch_meal_plan', { planId: plan(state).id, mode: 'draft', mealPatches: [{ id: 'breakfast',
    recipeGroups: [{ id: 'dish', name: "Renamed dish", lineIds: ['dish-yogurt', 'dish-milk', 'dish-beef'] }] }] });
  state = scale(state, 1);
  assert.equal(meal(state).recipeGroups[0].name, "Renamed dish");
  assert.deepEqual(['dish-yogurt', 'dish-milk', 'dish-beef'].map(id => ingredient(state, id).quantity), [200, 100, 1]);
});

test('half and full recipe movement preserves total nutrition and accounting despite same names and duplicate SKUs at the destination', () => {
  let state = fixture();
  const before = ledger(state), total = dailyFoodRollup(plan(state), state.items), originals = copy(meal(state).plannedItems);
  state = move(state, 0.5, { transferId: 'half-mixed-unit-recipe' });
  const destination = meal(state, 'lunch');
  assert.equal(destination.recipeGroups.length, 2);
  assert.ok(destination.recipeGroups.every(group => group.name === "Original recipe dish"));
  assert.equal(new Set(destination.recipeGroups.map(group => group.id)).size, 2);
  assert.equal(destination.plannedItems.find(line => line.id === 'lunch-yogurt').quantity, 50);
  const transferred = destination.recipeGroups.find(group => group.id !== 'dish');
  assert.equal(transferred.lineIds.length, 3);
  for (const id of transferred.lineIds) {
    const line = destination.plannedItems.find(value => value.id === id);
    const source = originals.find(value => value.itemId === line.itemId && value.id.startsWith('dish-'));
    assert.ok(id.startsWith('ui-transfer-'));
    assert.equal(line.quantity, source.quantity / 2);
    assert.equal(line.unit, source.unit);
    assert.deepEqual(line.nutritionSnapshot, source.nutritionSnapshot);
  }
  assert.deepEqual(nutrientAmounts(planNutritionTotals(plan(state))), nutrientAmounts(total.totals));
  assert.deepEqual(ledger(state), before);
  state = move(state, 1, { transferId: 'remaining-mixed-unit-recipe' });
  assert.deepEqual(meal(state).plannedItems.map(line => line.id), ['side-yogurt']);
  assert.deepEqual(meal(state).recipeGroups, []);
  assert.equal(meal(state, 'lunch').recipeGroups.length, 3);
  assert.deepEqual(nutrientAmounts(planNutritionTotals(plan(state))), nutrientAmounts(total.totals));
  assert.deepEqual(ledger(state), before);
});

test('a recipe movement retry is idempotent and reusing its transfer ID cannot move the remaining half twice', () => {
  let state = fixture();
  const payload = { action: 'move_recipe_group', operationId: 'one-recipe-gesture', expectedRevision: state.revision,
    planId: plan(state).id, fromMealId: 'breakfast', groupId: 'dish', toMealId: 'lunch', fractionOfRemaining: 0.5, transferId: 'one-transfer' };
  state = applyMutation(state, payload, LATER);
  const before = copy(state);
  assert.strictEqual(applyMutation(state, payload, LATER), state);
  assert.throws(() => move(state, 0.5, { transferId: 'one-transfer' }), error => error.code === 'RECIPE_TRANSFER_ALREADY_APPLIED');
  assert.deepEqual(state, before);
});

test('moving an uneaten recipe into a completed meal preserves its existing actuals and adds only explicit incoming plan lines', () => {
  let state = mutate(fixture(), 'record_meal_intake', { planId: 'daily-food-' + DAY, mealId: 'lunch', mode: 'complete',
    matchesPlannedFood: true, sourceText: "Local fixture: the original lunch yogurt was already eaten" });
  const before = ledger(state), nutrition = nutrientAmounts(planNutritionTotals(plan(state)));
  state = move(state, 1, { transferId: 'recipe-into-finished-lunch' });
  assert.equal(meal(state, 'lunch').state, 'completed');
  assert.equal(meal(state, 'lunch').actualEntries.length, 1);
  assert.equal(meal(state, 'lunch').plannedItems.filter(line => line.id.startsWith('ui-transfer-')).length, 3);
  assert.deepEqual(ledger(state), before);
  assert.deepEqual(nutrientAmounts(planNutritionTotals(plan(state))), nutrition);
});

test('already eaten ingredient quantities stay put and scaling below them fails atomically for the recipe', () => {
  let state = fixture();
  const entryId = intakeEntryId(plan(state).id, 'breakfast', 'dish-yogurt');
  state = report(state, 'breakfast', [{ id: entryId, itemId: 'yogurt', quantity: 60, unit: 'g', sourceText: "Local fixture: 60 g of recipe yogurt was eaten" }]);
  const before = ledger(state), original = copy(state);
  assert.throws(() => scale(state, 0.25), error => error.code === 'RECIPE_BELOW_ACTUAL');
  assert.deepEqual(state, original);
  state = move(state, 1, { transferId: 'only-uneaten-ingredients' });
  assert.equal(ingredient(state, 'dish-yogurt').quantity, 60);
  assert.deepEqual(meal(state).recipeGroups[0].lineIds, ['dish-yogurt']);
  assert.equal(meal(state, 'lunch').plannedItems.filter(line => line.itemId === 'yogurt').reduce((sum, line) => sum + line.quantity, 0), 190);
  assert.deepEqual(ledger(state), before);
});

test('an unrelated pending actual does not mechanically block scaling another recipe or settle the pending inventory', () => {
  let state = report(fixture(), 'dinner', [{ id: 'unknown-apple', itemId: 'apple', quantity: null, unit: '个', sourceText: "Local fixture: actual apple quantity unknown" }], 'complete');
  assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation');
  const before = ledger(state);
  state = scale(state, 0.5);
  assert.equal(ingredient(state, 'dish-yogurt').quantity, 100);
  assert.deepEqual(ledger(state), before);
});

test('stale recipe fingerprints reject the whole gesture before changing any ingredient or accounting', () => {
  let state = fixture();
  const oldView = recipeGroupEditView(plan(state), state.items, 'breakfast', 'dish');
  state = scale(state, 0.5);
  const before = copy(state);
  assert.throws(() => scale(state, 1, { expectedFingerprint: oldView.fingerprint }), error => error.code === 'RECIPE_GROUP_STALE');
  assert.deepEqual(state, before);
});

test('adding an inventory food creates only one new stable plan row and leaves an existing same-SKU row alone', () => {
  let state = fixture();
  const before = ledger(state), original = copy(meal(state).plannedItems);
  const payload = { action: 'add_food_to_meal', operationId: 'one-add-gesture', expectedRevision: state.revision,
    planId: plan(state).id, mealId: 'breakfast', itemId: 'yogurt', quantity: 35 };
  state = applyMutation(state, payload, LATER);
  assert.equal(meal(state).plannedItems.length, original.length + 1);
  assert.deepEqual(meal(state).plannedItems.slice(0, original.length), original);
  const added = meal(state).plannedItems.at(-1);
  assert.equal(added.itemId, 'yogurt'); assert.equal(added.quantity, 35); assert.equal(added.unit, 'g');
  assert.ok(added.id.startsWith('menu-add-'));
  assert.deepEqual(added.nutritionSnapshot.nutrition, stock(state, 'yogurt').nutrition);
  assert.deepEqual(ledger(state), before);
  assert.strictEqual(applyMutation(state, payload, LATER), state);
});

test('inventory addition uses the native stock unit and freezes its nutrition instead of mutating an existing package conversion', () => {
  let state = add(fixture(), 'beef', 0.5);
  const added = copy(meal(state).plannedItems.at(-1));
  assert.equal(added.unit, '袋'); assert.equal(added.quantity, 0.5); assert.equal(added.nutritionSnapshot.gramsPerUnit, 132);
  state = mutate(state, 'upsert', { item: { id: 'beef', gramsPerUnit: 160, nutrition: { kcal: 300 } } });
  assert.deepEqual(meal(state).plannedItems.at(-1), added);
  assert.equal(stock(state, 'beef').quantity, 10);
});

for (const status of ['depleted', 'pending', 'archived']) {
  test('inventory addition rejects only the selected unavailable ' + status + ' item and leaves all saved facts intact', () => {
    let state = fixture();
    state = mutate(state, 'upsert', { item: { id: 'apple', ...(status === 'depleted' ? { quantity: 0 } : {}), status } });
    const before = copy(state);
    assert.throws(() => add(state, 'apple'), error => error.code === 'ITEM_UNAVAILABLE');
    assert.deepEqual(state, before);
    state = add(state, 'yogurt', 25);
    assert.equal(meal(state).plannedItems.at(-1).itemId, 'yogurt');
    assert.deepEqual(state.items, before.items);
  });
}

test('the food picker refuses supplements but accepts confirmed available food with an unknown physical balance', () => {
  const initial = fixture(), before = copy(initial);
  assert.throws(() => add(initial, 'creatine', 5), error => error.code === 'ITEM_UNAVAILABLE');
  assert.deepEqual(initial, before);
  const state = add(initial, 'unknown-balance', 25);
  assert.equal(meal(state).plannedItems.at(-1).itemId, 'unknown-balance');
  assert.equal(stock(state, 'unknown-balance').quantity, null);
  assert.deepEqual(plan(state).accountedDebits, []);
});

test('adding a plan comparison to an already completed meal does not reopen it, invent intake or change actual nutrition', () => {
  let state = mutate(fixture(), 'record_meal_intake', { planId: 'daily-food-' + DAY, mealId: 'breakfast', mode: 'complete',
    matchesPlannedFood: true, sourceText: "Local fixture: explicitly completed breakfast" });
  const before = ledger(state), nutrition = planNutritionTotals(plan(state));
  state = add(state, 'apple', 1);
  assert.equal(meal(state).plannedItems.at(-1).itemId, 'apple');
  assert.equal(meal(state).state, 'completed');
  assert.deepEqual(ledger(state), before);
  assert.deepEqual(planNutritionTotals(plan(state)), nutrition);
});

test('adding food rebases a valid saved intake draft without submitting or changing any of its consumed or transfer instructions', () => {
  let state = savedDraft(fixture());
  const before = ledger(state), draft = copy(plan(state).intakeDraft);
  state = add(state, 'apple', 1, { expectedDraftVersion: intakeDraftVersion(draft) });
  assert.deepEqual(plan(state).intakeDraft.consumed, draft.consumed);
  assert.deepEqual(plan(state).intakeDraft.transfers, draft.transfers);
  assert.deepEqual(plan(state).intakeDraft.completedMealIds, draft.completedMealIds);
  assert.equal(plan(state).intakeDraft.id, draft.id);
  assert.equal(plan(state).intakeDraft.baseFingerprint, intakePlanFingerprint(plan(state), state.items));
  assert.equal(intakeDraftView(plan(state), state.items).stale, false);
  assert.equal(intakeDraftView(plan(state), state.items).canSubmit, true);
  assert.deepEqual(ledger(state), before);
});

test('an old stale draft stays stale when food is added, and a mismatched draft version fails atomically', () => {
  let state = savedDraft(fixture());
  const originalDraft = copy(plan(state).intakeDraft);
  state = mutate(state, 'patch_meal_plan', { planId: plan(state).id, mode: 'draft', mealPatches: [{ id: 'breakfast',
    itemPatches: [{ id: 'side-yogurt', quantity: 90 }] }] });
  assert.equal(intakeDraftView(plan(state), state.items).stale, true);
  const before = copy(state);
  assert.throws(() => add(state, 'apple', 1, { expectedDraftVersion: 'outdated-version' }), error => error.code === 'INTAKE_DRAFT_CONFLICT');
  assert.deepEqual(state, before);
  state = add(state, 'apple', 1, { expectedDraftVersion: intakeDraftVersion(originalDraft) });
  assert.deepEqual(plan(state).intakeDraft, originalDraft);
  assert.equal(intakeDraftView(plan(state), state.items).stale, true);
});

test('recipe plan changes retain an unsubmitted draft as stale instead of silently submitting its tentative food and transfers', () => {
  let state = savedDraft(fixture());
  const before = ledger(state), draft = copy(plan(state).intakeDraft);
  state = scale(state, 0.5);
  assert.deepEqual(plan(state).intakeDraft, draft);
  assert.equal(intakeDraftView(plan(state), state.items).stale, true);
  assert.deepEqual(ledger(state), before);
});

test('invalid added quantities cannot partially create an ingredient or affect inventory', () => {
  const state = fixture(), before = copy(state);
  for (const quantity of [0, -1, NaN, Infinity, null, '35']) assert.throws(() => add(state, 'yogurt', quantity));
  assert.deepEqual(state, before);
});
