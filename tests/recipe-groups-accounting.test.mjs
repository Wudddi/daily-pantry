import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { readDietRecords } from '../lib/diet.mjs';
import { projectCurrentDietPlan } from '../lib/diet-current-plan.mjs';
import { readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';
import { planNutritionLines, planNutritionTotals } from '../lib/diet-nutrition.mjs';
import { dailyFoodRollup } from '../lib/daily-food-rollup.mjs';
import { intakeDraftView, intakeDraftVersion, intakePlanFingerprint } from '../lib/intake-draft.mjs';
import { personalFoodChecklistView } from '../lib/personal-food-view.mjs';
import { groupChecklistRows } from '../lib/checklist-actions.mjs';
import { groupMealRecipeRows } from '../lib/meal-recipe-groups-view.mjs';

const DAY = '2026-11-02', AT = DAY + 'T14:00:00.000Z', LATER = DAY + 'T16:00:00.000Z';
let sequence = 0;
const copy = value => structuredClone(value);
const plan = state => state.plans.find(value => value.id === 'daily-food-' + DAY);
const breakfast = state => plan(state).meals.find(meal => meal.id === 'breakfast');
const recipeGroups = () => [{ id: 'bowl', name: "Oat yogurt bowl", lineIds: ['yogurt-bowl-a', 'oats', 'yogurt-bowl-b'] }];
function mutate(state, action, fields, at = AT) {
  return applyMutation(state, { action, operationId: 'recipe-accounting-' + (++sequence), expectedRevision: state.revision, ...fields }, at);
}
function food(id, quantity = 1000, unit = 'g', category = 'protein') {
  return validateItem({ id, name: id, quantity, unit, category,
    nutrition: { basisAmount: 100, basisUnit: unit, kcal: 100, protein: 10, carbs: 15, fat: 2, source: 'label' } }, AT);
}
function rawPlan(groups) {
  return { id: 'daily-food-' + DAY, date: DAY, title: "Local fixture: dish names are display groups only", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedTime: '08:30', plannedItems: [
      { id: 'yogurt-bowl-a', itemId: 'yogurt', quantity: 100, unit: 'g' },
      { id: 'oats', itemId: null, name: "Rolled oats", quantity: 40, unit: 'g', nutrition: {
        basisAmount: 100, basisUnit: 'g', kcal: 380, protein: 13, carbs: 66, fat: 6,
        source: 'estimate', sourceText: "Local fixture: user-authorized pantry oat estimate",
      } },
      { id: 'yogurt-bowl-b', itemId: 'yogurt', quantity: 20, unit: 'g' },
      { id: 'yogurt-side', itemId: 'yogurt', quantity: 80, unit: 'g' },
      { id: 'apple-side', itemId: 'apple', quantity: 1, unit: '个' },
    ], ...(groups === undefined ? {} : { recipeGroups: groups }) },
    { id: 'lunch', slot: 'lunch', title: "Lunch", plannedItems: [{ id: 'milk-lunch', itemId: 'milk', quantity: 150, unit: 'ml' }] },
  ], supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, unit: 'g', timingSlot: 'breakfast' }] };
}
function fixture(groups) {
  return mutate({ schemaVersion: 1, revision: 0, updatedAt: AT, preferences: [], events: [], operationIds: [], plans: [],
    items: [food('yogurt'), food('apple', 6, '个', 'fruit'), food('milk', 1000, 'ml'), food('creatine', 100, 'g', 'supplement')],
    dailyMenuSettlementPolicy: { version: 1, enabled: false, timeZone: 'America/Toronto', startsOn: DAY,
      updatedAt: AT, sourceText: "Local fixture: automatic settlement remains disabled" },
  }, 'save_meal_plan_draft', { plan: rawPlan(groups) });
}
function patchGroups(state, groups, extra = {}) {
  return mutate(state, 'patch_meal_plan', { planId: plan(state).id, mode: 'draft',
    mealPatches: [{ id: 'breakfast', recipeGroups: groups }], ...extra }, LATER);
}
function invariantSnapshot(state) {
  const current = projectCurrentDietPlan(plan(state), state.items);
  return { items: copy(state.items), policy: copy(state.dailyMenuSettlementPolicy),
    planStatus: plan(state).status, personalFoodChecks: copy(plan(state).personalFoodChecks),
    credits: copy(plan(state).accountedDebits), accountingItems: copy(plan(state).items),
    inventoryAccounting: plan(state).inventoryAccounting, accountingIssues: copy(plan(state).accountingIssues),
    accountingWarnings: copy(plan(state).accountingWarnings), supplements: copy(plan(state).supplementDoses),
    facts: current.meals.map(meal => ({ id: meal.id, state: meal.state, actualEntries: copy(meal.actualEntries),
      actualTime: meal.actualTime, actualTimeText: meal.actualTimeText, completionReportedAt: meal.completionReportedAt,
      sourceText: meal.sourceText, reportHistory: copy(meal.reportHistory), plannedItems: copy(meal.plannedItems) })),
    nutrition: planNutritionTotals(current), rollup: dailyFoodRollup(current, state.items),
  };
}

test('saving identical ingredients with recipe groups never creates extra inventory, servings or nutrient contributions', () => {
  const plain = fixture(), grouped = fixture(recipeGroups());
  assert.deepEqual(grouped.items, plain.items);
  assert.deepEqual(plan(grouped).accountedDebits, []);
  assert.deepEqual(plan(grouped).meals.map(meal => meal.actualEntries), [[], []]);
  assert.deepEqual(planNutritionTotals(plan(grouped)), planNutritionTotals(plan(plain)));
  assert.deepEqual(dailyFoodRollup(plan(grouped), grouped.items), dailyFoodRollup(plan(plain), plain.items));
  assert.equal(grouped.dailyMenuSettlementPolicy.enabled, false);
  assert.equal(grouped.items.length, 4);
});

test('adding, renaming, reordering and clearing groups preserves completed facts, credits, checks and all nutrition', () => {
  let state = mutate(fixture(), 'set_food_personal_check', { planId: 'daily-food-' + DAY,
    mealId: 'breakfast', lineIds: ['yogurt-bowl-a', 'yogurt-side'], checked: true });
  state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast',
    mode: 'complete', matchesPlannedFood: true, sourceText: "Local fixture: the user explicitly finished the breakfast ingredient quantities" });
  state = mutate(state, 'set_supplement_check', { planId: plan(state).id, doseId: 'creatine-am', checked: true });
  const invariant = invariantSnapshot(state);
  for (const groups of [recipeGroups(), [{ id: 'bowl', name: "Renamed yogurt bowl", lineIds: ['yogurt-bowl-b', 'oats', 'yogurt-bowl-a'] },
    { id: 'fruit', name: "Fruit", lineIds: ['apple-side'] }], []]) {
    state = patchGroups(state, groups);
    assert.deepEqual(breakfast(state).recipeGroups, groups);
    assert.deepEqual(invariantSnapshot(state), invariant);
    assert.equal(state.dailyMenuSettlementPolicy.enabled, false);
  }
});

test('display regrouping does not stale, discard or submit an existing intake draft', () => {
  let state = fixture();
  state = mutate(state, 'save_intake_draft', { planId: plan(state).id, expectedDraftVersion: null,
    draft: { id: 'recipe-existing-intake-draft', baseFingerprint: intakePlanFingerprint(plan(state), state.items),
      consumed: [{ mealId: 'breakfast', lineId: 'yogurt-bowl-a', quantity: 25, unit: 'g' }], transfers: [], completedMealIds: [] } });
  const saved = copy(plan(state).intakeDraft), version = intakeDraftVersion(plan(state).intakeDraft);
  const before = invariantSnapshot(state), fingerprint = intakePlanFingerprint(plan(state), state.items);
  state = patchGroups(state, recipeGroups());
  assert.deepEqual(plan(state).intakeDraft, saved);
  assert.equal(intakeDraftVersion(plan(state).intakeDraft), version);
  assert.equal(intakePlanFingerprint(plan(state), state.items), fingerprint);
  assert.equal(intakeDraftView(plan(state), state.items).stale, false);
  assert.equal(intakeDraftView(plan(state), state.items).canSubmit, true);
  assert.deepEqual(invariantSnapshot(state), before);
});

test('equal SKUs inside and outside a dish retain separate display membership and every original line exactly once', () => {
  const state = fixture(recipeGroups()), meal = breakfast(state);
  const rows = personalFoodChecklistView(plan(state), state.items).meals.find(value => value.id === 'breakfast').rows;
  const sections = groupMealRecipeRows(meal, rows, { planId: plan(state).id });
  assert.deepEqual(sections.flatMap(section => section.rows).map(row => row.lineId).sort(), meal.plannedItems.map(line => line.id).sort());
  const dish = sections.find(section => section.kind === 'recipe');
  assert.equal(dish.name, "Oat yogurt bowl");
  assert.deepEqual(dish.lineIds, ['yogurt-bowl-a', 'oats', 'yogurt-bowl-b']);
  const insideYogurt = groupChecklistRows({ rows: dish.rows }).find(row => row.itemId === 'yogurt');
  assert.equal(insideYogurt.plannedQuantity, 120);
  assert.deepEqual(insideYogurt.lineIds, ['yogurt-bowl-a', 'yogurt-bowl-b']);
  const loose = sections.filter(section => section.kind === 'food').flatMap(section => section.rows);
  assert.equal(loose.find(row => row.lineId === 'yogurt-side').plannedQuantity, 80);
  assert.ok(!dish.rows.some(row => row.lineId === 'yogurt-side'));
  const dailyYogurt = dailyFoodRollup(plan(state), state.items).rows.find(row => row.itemId === 'yogurt');
  assert.equal(dailyYogurt.quantity, 200);
});

test('completed stable actual IDs map to their dishes without moving same-SKU side portions or altering actual quantities', () => {
  let state = fixture(recipeGroups());
  state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast',
    mode: 'complete', matchesPlannedFood: true, sourceText: "Local fixture: the user actually finished the original menu" });
  const before = copy(state), meal = breakfast(state);
  const lines = planNutritionLines(plan(state)).filter(line => line.entityId === 'breakfast');
  const sections = groupMealRecipeRows(meal, lines, { planId: plan(state).id });
  const dish = sections.find(section => section.kind === 'recipe');
  assert.equal(dish.rows.length, 3);
  assert.deepEqual(dish.lineIds, ['yogurt-bowl-a', 'oats', 'yogurt-bowl-b']);
  const looseYogurt = sections.filter(section => section.kind === 'food').flatMap(section => section.rows).filter(row => row.itemId === 'yogurt');
  assert.equal(looseYogurt.length, 1);
  assert.equal(looseYogurt[0].quantity, 80);
  assert.deepEqual(sections.flatMap(section => section.rows).map(row => row.lineId).sort(), lines.map(line => line.lineId).sort());
  assert.deepEqual(state, before);
});

test('an unanchored cumulative actual spanning a dish and a side stays loose instead of being relabelled as both', () => {
  let state = fixture(recipeGroups());
  state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast', mode: 'complete',
    entries: [{ id: 'chat-cumulative-yogurt', itemId: 'yogurt', quantity: 200, unit: 'g', sourceText: "Local fixture: actual yogurt total is 200 g, with ingredient lines unspecified" }] });
  const before = copy(state), meal = breakfast(state);
  const lines = planNutritionLines(plan(state)).filter(line => line.entityId === meal.id);
  const sections = groupMealRecipeRows(meal, lines, { planId: plan(state).id });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, 'food');
  assert.equal(sections[0].rows[0].quantity, 200);
  assert.equal(sections[0].rows[0].lineId, 'chat-cumulative-yogurt');
  assert.equal(plan(state).accountedDebits.find(line => line.itemId === 'yogurt').quantity, 200);
  assert.deepEqual(state, before);
});

test('legacy saved drafts project their latest groups while parent actuals, credits and private checks remain authoritative', () => {
  let state = fixture(recipeGroups());
  state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast',
    mode: 'complete', matchesPlannedFood: true, sourceText: "Local fixture: reported breakfast" });
  state = mutate(state, 'set_food_personal_check', { planId: plan(state).id, mealId: 'breakfast', lineIds: ['yogurt-side'], checked: true });
  state = copy(state);
  const current = plan(state), draft = rawPlan([{ id: 'new-bowl', name: "Latest draft dish name", lineIds: ['oats', 'yogurt-bowl-a', 'yogurt-bowl-b'] }]);
  current.draft = copy(draft);
  const before = copy(state), projected = projectCurrentDietPlan(current, state.items);
  assert.equal(projected.meals[0].recipeGroups[0].name, "Latest draft dish name");
  assert.deepEqual(projected.meals[0].actualEntries, current.meals[0].actualEntries);
  assert.deepEqual(projected.accountedDebits, current.accountedDebits);
  assert.deepEqual(projected.personalFoodChecks, current.personalFoodChecks);
  const context = readFoodPlanEditContext(state, { planId: current.id, mealIds: ['breakfast'], candidateItemIds: [] });
  assert.deepEqual(context.meals[0].recipeGroups.map(({ id, name, lineIds }) => ({ id, name, lineIds })), projected.meals[0].recipeGroups);
  assert.equal(context.meals[0].recipeGroups[0].portion, 1);
  assert.equal(context.meals[0].recipeGroups[0].legacyBasis, true);
  assert.equal(typeof context.meals[0].recipeGroups[0].editFingerprint, 'string');
  const records = readDietRecords(state, { planId: current.id });
  // Raw-history reads preserve the parent and its nested draft separately;
  // only the current-menu projection selects the latest display metadata.
  assert.deepEqual(records.records[0].meals[0].recipeGroups, current.meals[0].recipeGroups);
  assert.deepEqual(records.records[0].draft.meals[0].recipeGroups, projected.meals[0].recipeGroups);
  const reload = JSON.parse(JSON.stringify(state));
  assert.deepEqual(projectCurrentDietPlan(plan(reload), reload.items), projected);
  assert.deepEqual(state, before);
});

test('a grouping-only edit on a pending ledger never settles or erases the existing per-item issue', () => {
  let state = fixture();
  state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast', mode: 'complete',
    entries: [{ id: 'unknown-apple', itemId: 'apple', quantity: null, unit: '个', sourceText: "Local fixture: apple eaten but original actual quantity is pending review" }] });
  assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation');
  const before = invariantSnapshot(state);
  state = patchGroups(state, recipeGroups());
  assert.deepEqual(invariantSnapshot(state), before);
  assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation');
});
