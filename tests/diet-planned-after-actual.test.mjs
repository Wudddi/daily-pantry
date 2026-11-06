import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { materializeDietPlanForEdit } from '../lib/diet.mjs';
import { planNutritionTotals } from '../lib/diet-nutrition.mjs';

const NOW = '2026-10-20T14:00:00.000Z';
const LATER = '2026-10-20T22:00:00.000Z';
const copy = value => structuredClone(value);
const FACT_KEYS = ['actualEntries', 'actualTime', 'actualTimeText', 'completionReportedAt', 'sourceText', 'reportHistory', 'state'];
const facts = meal => Object.fromEntries(FACT_KEYS.map(key => [key, meal[key]]));
function food(id, quantity, unit, category = 'prepared') {
  return validateItem({ id, name: id, quantity, unit, category, nutrition: { basisAmount: 1, basisUnit: unit, kcal: 100, protein: 10, carbs: 12, fat: 2, source: 'label', sourceText: "Original food label and verified basis" } }, NOW);
}
function fixture() {
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, events: [], operationIds: [], preferences: [], plans: [], items: [food('pasta', 1000, 'g'), food('bagel', 5, '个', 'bread'), food('beef', 10, '袋'), food('veg', 1000, 'g', 'vegetable'), food('oil', 10, '粒', 'supplement'), food('beta', 100, 'g', 'supplement')] };
}
function input() {
  return { id: 'day', date: '2026-10-20', title: "Complete three-meal menu", notes: "Original daily menu", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedTime: '08:00', plannedItems: [{ id: 'beef-line', itemId: 'beef', quantity: 1, sourceText: "Original breakfast" }] },
    { id: 'lunch', slot: 'lunch', title: "Lunch", plannedTime: '12:00', plannedItems: [{ id: 'veg-line', itemId: 'veg', quantity: 200, sourceText: "Original lunch" }] },
    { id: 'dinner', slot: 'dinner', title: "Dinner", plannedTime: '19:30', plannedTimeText: "Post-workout dinner", plannedItems: [{ id: 'dinner-food', itemId: 'pasta', quantity: 110, sourceText: "Originally planned 110 g dry pasta" }] },
  ], supplementDoses: [{ id: 'fish-oil', itemId: 'oil', plannedQuantity: 1, timingSlot: 'breakfast', plannedMealId: 'breakfast', sourceText: "Original fish-oil arrangement" }, { id: 'beta-pre', itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'pre_workout', requirement: 'optional', scheduled: false, sourceText: "Optional dose" }] };
}
function apply(state, action, payload = {}, operationId = action + '-' + state.revision) { return applyMutation(state, { action, ...payload, operationId, expectedRevision: state.revision }, LATER); }
function ready() { return apply(apply(fixture(), 'save_meal_plan_draft', { plan: input() }), 'commit_meal_plan', { planId: 'day', confirmed: true }); }
function legacyReady() {
  const state = ready(), saved = state.plans[0];
  delete saved.foodAccounting;
  saved.supplementAccounting = 'full_plan';
  saved.accountedDebits = [['beef', 1], ['veg', 200], ['pasta', 110], ['oil', 1]].map(([itemId, amount]) => {
    const item = state.items.find(item => item.id === itemId);
    item.quantity -= amount;
    return { itemId, name: item.name, quantity: amount, unit: item.unit, unknownBalance: false,
      baselineToken: item.quantityBaselineToken ?? item.confirmedAt ?? 'initial' };
  });
  saved.items = copy(saved.accountedDebits);
  return state;
}
const plan = state => state.plans[0];
const dinner = state => plan(state).meals.find(meal => meal.id === 'dinner');
const quantity = (state, id) => state.items.find(item => item.id === id).quantity;
const oldDinnerPlan = meal => Object.fromEntries(['slot', 'title', 'plannedTime', 'plannedTimeText', 'plannedItems'].map(key => [key, copy(meal[key])]));
const replacement = { id: 'dinner', itemPatches: [{ id: 'dinner-food', itemId: 'bagel', quantity: 1, sourceText: "The user chose a last-minute swap to 1 bagel" }] };
function patch(state, mode, fields = {}, operationId) { return apply(state, 'patch_meal_plan', { planId: 'day', mode, ...(mode === 'apply' ? { confirmed: true } : {}), mealPatches: [replacement], ...fields }, operationId); }
function completed(state) {
  return apply(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'complete', actualTime: '20:10', actualTimeText: "Actual dinner at 20:10", sourceText: "Last-minute swap: no pasta; ate 1 bagel", entries: [{ id: 'actual-pasta-zero', itemId: 'pasta', quantity: 0, unit: 'g', sourceText: "Actual dry pasta: 0 g, not eaten" }, { id: 'actual-bagel-one', itemId: 'bagel', quantity: 1, unit: '个', sourceText: "Actually ate 1 bagel" }] });
}
function assertOtherRecords(after, before) {
  assert.deepEqual(plan(after).meals.filter(meal => meal.id !== 'dinner'), plan(before).meals.filter(meal => meal.id !== 'dinner'));
  assert.deepEqual(plan(after).supplementDoses, plan(before).supplementDoses);
}
function assertActualUnchanged(after, before) { assert.deepEqual(facts(dinner(after)), facts(dinner(before))); }
function changedMealInput(state) {
  const raw = copy(dinner(state)); raw.plannedItems = [{ id: 'dinner-food', itemId: 'bagel', quantity: 1, unit: '个', sourceText: "The user confirmed the bagel swap" }]; return raw;
}

test('saved menu changes appear before eating and optional adoption after actual intake cannot re-debit either food', () => {
  const original = ready(), previousPlan = oldDinnerPlan(dinner(original));
  let state = patch(original, 'draft');
  assert.equal(quantity(state, 'pasta'), 1000); assert.equal(quantity(state, 'bagel'), 5);
  assert.equal(dinner(state).plannedItems[0].itemId, 'bagel');
  assert.equal(dinner(state).planRevisionHistory.length, 1);
  state = completed(state); const before = copy(state);
  assert.equal(quantity(state, 'pasta'), 1000); assert.equal(quantity(state, 'bagel'), 4);
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).accountedDebits, plan(before).accountedDebits);
  assertActualUnchanged(state, before); assertOtherRecords(state, before);
  assert.equal(dinner(state).plannedItems[0].itemId, 'bagel'); assert.equal(dinner(state).state, 'completed');
  assert.deepEqual(dinner(state).planRevisionHistory, [{ at: LATER, previous: previousPlan }]);
  assert.ok(!plan(state).draft);
});

test('completed dinner may save a current full-plan replacement while exact actual evidence and old snapshots stay intact', () => {
  let state = completed(ready()); const before = copy(state), previousPlan = oldDinnerPlan(dinner(state));
  const raw = copy(plan(state)); raw.meals = raw.meals.map(meal => meal.id === 'dinner' ? changedMealInput(state) : meal);
  state = apply(state, 'save_meal_plan_draft', { plan: raw });
  assert.deepEqual(state.items, before.items); assertActualUnchanged(state, before);
  assert.equal(dinner(state).planRevisionHistory.length, 1, 'the saved current menu change is audited immediately');
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  assert.deepEqual(state.items, before.items); assertActualUnchanged(state, before); assertOtherRecords(state, before);
  assert.deepEqual(dinner(state).planRevisionHistory[0].previous, previousPlan);
  assert.equal(dinner(state).planRevisionHistory[0].previous.plannedItems[0].nutritionSnapshot.nutrition.sourceText, "Original food label and verified basis");
});

test('direct patch and legacy revision both allow completed planned changes and retain actual quantities, times, sources and status', () => {
  for (const action of ['patch_meal_plan', 'revise_unconsumed_meals']) {
    const before = completed(ready());
    const after = action === 'patch_meal_plan' ? patch(before, 'apply') : apply(before, action, { planId: 'day', confirmed: true, meals: [changedMealInput(before)] });
    assertActualUnchanged(after, before); assertOtherRecords(after, before); assert.deepEqual(after.items, before.items);
    assert.deepEqual(plan(after).accountedDebits, plan(before).accountedDebits);
    assert.equal(dinner(after).planRevisionHistory.length, 1);
    assert.equal(dinner(after).planRevisionHistory[0].previous.plannedItems[0].quantity, 110);
  }
});

test('partial actual intake deducts only the reported30g; a new planned bagel remains unconsumed through optional adoption', () => {
  let state = patch(ready(), 'draft');
  state = apply(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', entries: [{ id: 'actual-pasta30', itemId: 'pasta', quantity: 30, unit: 'g', sourceText: "Already ate 30 g dry pasta" }], actualTime: '19:50', sourceText: "Ate part, then swapped the remainder to a bagel" });
  const before = copy(state);
  assert.equal(dinner(state).state, 'in_progress'); assert.equal(quantity(state, 'pasta'), 970);
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  assert.equal(quantity(state, 'pasta'), 970); assert.equal(quantity(state, 'bagel'), 5);
  assert.equal(plan(state).accountedDebits.find(line => line.itemId === 'pasta').quantity, 30);
  assertActualUnchanged(state, before); assertOtherRecords(state, before);
});

test('nutrition retains max planned/actual while inventory reflects only actual30g regardless of subsequent planned quantity', () => {
  let state = apply(ready(), 'record_meal_intake', { planId: 'day', mealId: 'dinner', entries: [{ id: 'actual-pasta30', itemId: 'pasta', quantity: 30, unit: 'g', sourceText: "Actually ate 30 g" }] });
  const originalFacts = facts(dinner(state));
  state = patch(state, 'apply', { mealPatches: [{ id: 'dinner', itemPatches: [{ id: 'dinner-food', quantity: 80 }] }] });
  assert.equal(quantity(state, 'pasta'), 970);
  assert.equal(planNutritionTotals({ meals: [dinner(state)], supplementDoses: [] })[0].value, 8000);
  state = patch(state, 'apply', { mealPatches: [{ id: 'dinner', itemPatches: [{ id: 'dinner-food', quantity: 10 }] }] });
  assert.equal(quantity(state, 'pasta'), 970);
  assert.equal(planNutritionTotals({ meals: [dinner(state)], supplementDoses: [] })[0].value, 3000);
  assert.deepEqual(facts(dinner(state)), originalFacts);
  assert.equal(dinner(state).planRevisionHistory.length, 2);
  state = apply(state, 'cancel_remaining_meals', { planId: 'day', confirmed: true });
  assert.equal(quantity(state, 'pasta'), 970); assert.deepEqual(dinner(state).actualEntries, originalFacts.actualEntries);
});

test('explicit actual0 pasta never creates a debit or refund and repeated adoption cannot resurrect or consume it', () => {
  const before = ready(); let state = completed(before);
  assert.equal(quantity(state, 'pasta') - quantity(before, 'pasta'), 0);
  const actualZero = copy(dinner(state).actualEntries.find(entry => entry.itemId === 'pasta'));
  state = patch(state, 'draft'); const revision = state.revision;
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true }, 'confirm-swapped-dinner');
  const after = state;
  assert.equal(applyMutation(state, { action: 'commit_meal_plan', planId: 'day', confirmed: true, operationId: 'confirm-swapped-dinner', expectedRevision: revision }, LATER), state);
  assert.equal(apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true }, 'confirm-again'), state);
  assert.equal(patch(state, 'apply', {}, 'repeat-same-planned-patch'), state);
  assert.equal(quantity(state, 'pasta'), 1000); assert.equal(quantity(state, 'bagel'), 4);
  assert.equal(dinner(state).planRevisionHistory.length, 1);
  assert.deepEqual(dinner(state).actualEntries.find(entry => entry.itemId === 'pasta'), actualZero);
  assert.equal(state, after);
});

test('full save and patch still reject deleting or renaming the ID of a meal with facts, preserving the whole input state', () => {
  const before = completed(ready());
  for (const mode of ['draft', 'apply']) {
    assert.throws(() => patch(before, mode, { mealPatches: [{ id: 'dinner', remove: true }] }), { code: 'CONSUMED_MEAL_CONFLICT', status: 409 });
  }
  for (const rename of [false, true]) {
    const raw = copy(plan(before)); raw.meals = rename ? raw.meals.map(meal => meal.id === 'dinner' ? { ...meal, id: 'new-dinner-id' } : meal) : raw.meals.filter(meal => meal.id !== 'dinner');
    assert.throws(() => apply(before, 'save_meal_plan_draft', { plan: raw }), { code: 'CONSUMED_MEAL_CONFLICT', status: 409 });
  }
  assert.deepEqual(before, completed(ready()));
});

test('already reported supplement identity/amount remains protected while meal planned food is independently editable', () => {
  const before = apply(completed(ready()), 'set_supplement_check', { planId: 'day', doseId: 'fish-oil', checked: true });
  const after = patch(before, 'apply');
  assert.deepEqual(plan(after).supplementDoses, plan(before).supplementDoses);
  for (const mode of ['draft', 'apply']) assert.throws(() => patch(before, mode, { mealPatches: undefined, supplementPatches: [{ id: 'fish-oil', plannedQuantity: 2 }] }), { code: 'CONSUMED_MEAL_CONFLICT', status: 409 });
  const raw = copy(plan(before)); raw.supplementDoses[0].plannedQuantity = 2;
  assert.throws(() => apply(before, 'save_meal_plan_draft', { plan: raw }), { code: 'CONSUMED_MEAL_CONFLICT', status: 409 });
});

test('server audit immediately records saved current changes and survives normalization without trusting caller histories or actual fields', () => {
  let state = patch(completed(ready()), 'apply'); const before = copy(state);
  const raw = copy(plan(state)); const changed = raw.meals.find(meal => meal.id === 'dinner'); changed.title = "Second plan-title edit"; changed.planRevisionHistory = [{ at: NOW, previous: { title: "Fabricated history" } }]; changed.actualEntries = []; changed.actualTime = null; changed.sourceText = "Fabricated intake source text"; changed.state = 'reserved';
  state = apply(state, 'save_meal_plan_draft', { plan: raw });
  assert.equal(dinner(state).planRevisionHistory.length, 2); assertActualUnchanged(state, before);
  const view = materializeDietPlanForEdit(state, 'day');
  assert.deepEqual(view.meals.find(meal => meal.id === 'dinner').planRevisionHistory, dinner(state).planRevisionHistory);
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  assert.equal(dinner(state).planRevisionHistory.length, 2); assert.equal(dinner(state).planRevisionHistory[1].previous.title, "Dinner");
  assertActualUnchanged(state, before); assert.deepEqual(state.items, before.items);
  assert.equal(dinner(state).title, "Second plan-title edit");
});

test('unknown actual nutrition and correction history are immutable during planned edits instead of being filled from a new plan', () => {
  const before = completed(ready()); const actual = dinner(before).actualEntries.find(entry => entry.itemId === 'bagel');
  actual.nutritionSnapshot = null; actual.correctionHistory = [{ ...copy(actual), quantity: 2, sourceText: "Previously overreported by 2 items", correctionHistory: undefined }];
  const after = patch(before, 'apply');
  assertActualUnchanged(after, before);
  assert.equal(dinner(after).actualEntries.find(entry => entry.itemId === 'bagel').nutritionSnapshot, null);
});

test('legacy nested drafts remain the current edit base without losing other meal edits or existing actual facts', () => {
  for (const action of ['patch_meal_plan', 'revise_unconsumed_meals']) {
    const state = completed(ready());
    plan(state).draft = { ...copy(plan(state)), patchDraft: true };
    plan(state).draft.meals.find(meal => meal.id === 'lunch').title = "Lunch already edited in the legacy draft";
    const before = copy(state);
    const after = action === 'patch_meal_plan' ? patch(state, 'apply', { mealPatches: [{ ...replacement, title: "Current bagel dinner" }] })
      : apply(state, action, { planId: 'day', confirmed: true, meals: [{ ...changedMealInput(state), title: "Current bagel dinner" }] });
    assert.equal(plan(after).meals.find(meal => meal.id === 'lunch').title, "Lunch already edited in the legacy draft");
    assert.equal(dinner(after).plannedItems[0].itemId, 'bagel');
    assert.equal(dinner(after).title, "Current bagel dinner");
    assertActualUnchanged(after, before);
    assert.deepEqual(after.items, before.items);
    assert.equal(plan(after).draft, undefined);
    assert.deepEqual(state, before);
  }
});

test('plan history limit rejects atomically and retained history cannot be erased by a client plan payload', () => {
  let state = completed(ready()); const previous = oldDinnerPlan(dinner(state));
  dinner(state).planRevisionHistory = Array.from({ length: 200 }, () => ({ at: NOW, previous: copy(previous) }));
  const before = copy(state);
  assert.throws(() => patch(state, 'apply'), { code: 'MEAL_PLAN_HISTORY_LIMIT', status: 409 });
  assert.deepEqual(state, before);
  const raw = copy(plan(state)); raw.meals.find(meal => meal.id === 'dinner').planRevisionHistory = [];
  raw.meals.find(meal => meal.id === 'dinner').title = "Proposal saved at the audit limit";
  assert.throws(() => apply(state, 'save_meal_plan_draft', { plan: raw }), { code: 'MEAL_PLAN_HISTORY_LIMIT', status: 409 });
  assert.deepEqual(state, before);
  const forgedHistoryOnly = copy(plan(state)); forgedHistoryOnly.meals.find(meal => meal.id === 'dinner').planRevisionHistory = [];
  assert.equal(apply(state, 'save_meal_plan_draft', { plan: forgedHistoryOnly }), state, 'caller history fields cannot erase server audit even in a no-op save');
});

test('legacy prepaid inventory remains frozen through a menu edit and supplement check, then settles only the actual difference once', () => {
  const original = legacyReady();
  assert.equal(quantity(original, 'pasta'), 890);
  let state = patch(original, 'draft');
  assert.deepEqual(state.items, original.items, 'adopting a new current bagel menu does not re-reserve or refund historical stock');
  assert.equal(plan(state).legacyReservations.meals.find(meal => meal.id === 'dinner').plannedItems[0].itemId, 'pasta');
  state = apply(state, 'set_supplement_check', { planId: 'day', doseId: 'fish-oil', checked: true });
  assert.deepEqual(state.items, original.items, 'already credited fish oil and frozen food balances are not charged again');
  state = completed(state);
  assert.equal(quantity(state, 'pasta'), 1000);
  assert.equal(quantity(state, 'bagel'), 4);
  assert.equal(quantity(state, 'beef'), 9, 'unreported historical meal credit is preserved');
  assert.equal(quantity(state, 'veg'), 800);
  const actualSaved = copy(state), replay = completed(state);
  assert.deepEqual(replay.items, actualSaved.items);
  assert.deepEqual(plan(replay).accountedDebits, plan(actualSaved).accountedDebits);
  state = apply(replay, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'correct', entries: [
    { id: 'actual-bagel-one', itemId: 'bagel', quantity: 2, unit: '个', sourceText: "Correct actual intake to two bagels" },
  ] });
  assert.equal(quantity(state, 'bagel'), 3, 'correction deducts only one additional actual bagel');
  assert.equal(quantity(state, 'pasta'), 1000);
  assert.equal(dinner(state).actualEntries.find(entry => entry.id === 'actual-bagel-one').correctionHistory.at(-1).quantity, 1);
});

test('a changed legacy stock baseline retains its old credit while an independent actual replacement settles once', () => {
  let state = patch(legacyReady(), 'draft');
  state = apply(state, 'set_quantity', { id: 'pasta', quantity: 200 });
  const before = copy(state);
  state = completed(state);
  assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation');
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'pasta' && issue.code === 'BASELINE_REQUIRES_REVIEW'));
  assert.equal(plan(state).accountingIssues.some(issue => issue.itemId === 'bagel'), false);
  assert.equal(quantity(state, 'pasta'), 200);
  assert.equal(quantity(state, 'bagel'), 4);
  assert.deepEqual(plan(state).accountedDebits.find(line => line.itemId === 'pasta'), plan(before).accountedDebits.find(line => line.itemId === 'pasta'));
  assert.equal(plan(state).accountedDebits.find(line => line.itemId === 'bagel').quantity, 1);
  assert.equal(dinner(state).state, 'completed');
  assert.equal(dinner(state).actualEntries.find(entry => entry.itemId === 'bagel').quantity, 1);
  const retry = completed(state);
  assert.equal(quantity(retry, 'pasta'), 200);
  assert.equal(quantity(retry, 'bagel'), 4);
  assert.deepEqual(plan(retry).accountedDebits, plan(state).accountedDebits);
});
