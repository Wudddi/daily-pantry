import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
import { readFoodPlanEditContext, foodPlanNutritionSummary } from '../lib/diet-edit-read.mjs';

const NOW = '2026-10-19T12:00:00Z';
function item(id, category, unit, quantity, kcal, basisAmount = 1) {
  return validateItem({ id, name: id, category, unit, quantity, status: 'available', gramsPerUnit: unit === '袋' ? 250 : null,
    ingredients: 'PRIVATE full ingredients never returned', notes: 'PRIVATE stock notes never returned',
    nutrition: { basisAmount, basisUnit: unit, kcal, protein: 0, carbs: 0, fat: 0, source: 'label',
      sourceText: 'PRIVATE full label never returned' } }, NOW);
}
function input() {
  return { id: 'day', date: '2026-10-19', title: '全天原菜单', meals: [
    { id: 'breakfast', slot: 'breakfast', title: '早餐', plannedItems: [{ id: 'breakfast-a', itemId: 'a', quantity: 1 }] },
    { id: 'lunch', slot: 'lunch', title: '午餐', plannedItems: [{ id: 'lunch-a', itemId: 'a', quantity: 2 }, { id: 'lunch-mushroom', itemId: 'mushroom', quantity: 200 }] },
    { id: 'dinner', slot: 'dinner', title: '晚餐', plannedItems: [{ id: 'dinner-b', itemId: 'b', quantity: 3 },
      { id: 'sauce', itemId: null, name: '常备酱', quantity: 15, unit: 'g', nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 120,
        protein: 0, carbs: 0, fat: 0, source: 'estimate', sourceText: 'PRIVATE sauce estimate original' } }] },
  ], supplementDoses: Array.from({ length: 15 }, (_, index) => ({ id: `dose-${index}`, itemId: 'fish', plannedQuantity: 1,
    timingSlot: 'breakfast', requirement: 'daily', instruction: 'PRIVATE 15-dose timetable not needed for editing lunch' })) };
}
function mutate(state, action, payload) {
  return applyMutation(state, { action, ...payload, expectedRevision: state.revision, operationId: `${action}-${state.revision}` }, NOW);
}
function fixture() {
  let state = { schemaVersion: 1, revision: 0, updatedAt: NOW, events: [], preferences: [], operationIds: [], plans: [], items: [
    item('a', 'prepared', '袋', 20, 100), item('b', 'prepared', '袋', 20, 120),
    item('mushroom', 'vegetable', 'g', 1000, 22, 100), item('tomato', 'vegetable', 'g', 500, 20, 100),
    item('fish', 'supplement', '粒', 100, 10), item('empty-bread', 'bread', '片', 0, 50),
  ] };
  state = mutate(state, 'save_meal_plan_draft', { plan: input() });
  return mutate(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
}
const kcal = values => values.find(total => total.key === 'kcal');

test('replacement search follows verified aliases and current soft priorities while explicit choices keep first place', () => {
  const state = fixture();
  const yogurt = { ...item('pc-yogurt', 'protein', 'g', 1000, 60, 100), name: 'PC Plain Greek Yogurt 0% M.F.（原味无脂希腊酸奶1kg）', aliases: ['0%希腊酸奶'] };
  const regular = { ...item('beef-regular', 'prepared', '袋', 5, 250), name: '牛肉标准袋' };
  const tail = { ...item('beef-tail', 'prepared', '袋', 1, 240), name: '牛肉127g尾袋' };
  state.items.push(yogurt, regular, tail);
  const before = structuredClone(state);
  const yogurtResult = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'], foodQuery: '0%希腊酸奶' });
  const row = yogurtResult.inventoryCandidates.items.find(item => item.id === yogurt.id);
  assert.equal(row.name, yogurt.name);
  assert.deepEqual(row.aliases, ['0%希腊酸奶']);
  row.aliases.push('只改响应');
  assert.deepEqual(state, before);
  const result = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'], candidateItemIds: ['tomato'], foodQuery: '牛肉' });
  assert.deepEqual(result.inventoryCandidates.items.slice(0, 3).map(item => item.id), ['tomato', 'beef-tail', 'beef-regular']);
  assert.deepEqual(result.inventoryCandidates.items[1].planningHints, ['named_tail_bag', 'last_prepared_bag']);
  assert.equal(result.otherMeals.preserve, true);
  assert.equal(result.supplements.preserve, true);
  assert.deepEqual(result.preferences, state.preferences);
  assert.deepEqual(state, before);
});

test('one focused read returns stable target lines, small explicit candidates and shared totals without full-day or supplement text', () => {
  const state = fixture(), before = structuredClone(state);
  const result = readFoodPlanEditContext(state, { date: '2026-10-19', mealIds: ['lunch'], candidateItemIds: ['tomato', 'empty-bread', 'fish'] });
  assert.equal(result.revision, state.revision);
  assert.deepEqual(result.preferences, []);
  assert.equal(result.preferencesComplete, true);
  assert.equal(result.preferencesCount, 0);
  assert.equal(result.preferencesRevision, state.revision);
  assert.equal(result.plan.id, 'day');
  assert.equal(result.plan.editBase, 'active');
  assert.deepEqual(result.meals.map(meal => meal.id), ['lunch']);
  assert.deepEqual(result.meals[0].plannedItems.map(line => line.id), ['lunch-a', 'lunch-mushroom']);
  assert.equal(result.meals[0].plannedItems[0].gramsPerUnit, 250);
  assert.equal(result.meals[0].plannedItems[1].nutrition.basisAmount, 100);
  assert.equal(kcal(result.meals[0].nutritionTotals).value, 244);
  assert.deepEqual(result.inventoryCandidates.items.map(row => row.id), ['tomato', 'empty-bread', 'a', 'mushroom']);
  assert.equal(result.inventoryCandidates.items.find(row => row.id === 'empty-bread').canUse, false);
  assert.deepEqual(result.inventoryCandidates.excludedSupplementItemIds, ['fish']);
  assert.equal(result.inventoryCandidates.items.find(item => item.id === 'a').quantity, 20, 'saved and adopted menus do not reserve their three planned bags');
  assert.equal(result.inventoryCandidates.items.find(item => item.id === 'a').accountedByThisPlan, null);
  assert.equal(result.otherMeals.preserve, true); assert.equal(result.otherMeals.count, 2);
  assert.deepEqual(result.supplements, { preserve: true, count: 15, actualDoseCount: 0, reportedDoseCount: 0 });
  assert.equal(kcal(result.dailyNutritionSummary.totals).value, resolveDietDays(state.plans)[0].totals.find(total => total.key === 'kcal').value);
  assert.equal(result.completeForPatch, true);
  const encoded = JSON.stringify(result);
  assert.ok(encoded.length < 16000);
  for (const secret of ['PRIVATE', 'sourceText\":', 'correctionHistory', 'supplementDoses']) assert.equal(encoded.includes(secret), false, secret);
  assert.deepEqual(state, before);
});

test('focused edits receive every latest preference from the same revision without changing stock or saved facts', () => {
  let state = fixture();
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true,
    sourceText: 'PRIVATE completed lunch original' });
  state = mutate(state, 'preferences', { preferences: ['优先整袋主餐，不强求每天吃遍库存。', '一天甜点最多两份；也可以零份。'] });
  const before = structuredClone(state);
  const first = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'], expectedRevision: state.revision });
  assert.deepEqual(first.preferences, state.preferences);
  assert.equal(first.preferencesComplete, true);
  assert.equal(first.preferencesCount, 2);
  assert.equal(first.preferencesRevision, first.revision);
  assert.equal(first.preferencesLastChangedAt, new Date(NOW).toISOString());
  assert.equal(first.preferencesLastChangedRevision, state.revision);
  assert.match(first.preferenceWorkflow, /patch_food_preferences/);
  assert.equal(first.meals[0].hasActualFacts, true);
  assert.equal(first.meals[0].actualEntries.length, 2);
  assert.equal(first.meals[0].canRemove, false);
  assert.deepEqual(state, before);
  first.preferences[0] = 'caller-local change';
  assert.deepEqual(state, before, 'returned preferences must not alias stored preferences');

  const latest = mutate(state, 'preferences', { preferences: ['主餐优先整袋；当前不想吃甜点。'] });
  const result = readFoodPlanEditContext(latest, { planId: 'day', mealIds: ['lunch'], expectedRevision: latest.revision });
  assert.deepEqual(result.preferences, latest.preferences);
  assert.equal(result.preferencesCount, 1);
  assert.equal(result.preferencesRevision, latest.revision);
  assert.equal(result.revision, latest.revision);
  assert.throws(() => readFoodPlanEditContext(latest, { planId: 'day', expectedRevision: state.revision }), error => error.code === 'REVISION_CONFLICT');
  assert.deepEqual(latest.items, state.items);
  assert.deepEqual(latest.plans, state.plans);
});

test('complete escaped preferences have their own measured budget and never displace candidates or other meals', () => {
  const state = fixture();
  state.items.push(...Array.from({ length: 12 }, (_, index) => item(`replacement-${index}`, 'vegetable', 'g', 100, 20, 100)));
  const filters = { planId: 'day', mealIds: ['lunch'], foodQuery: 'replacement-' };
  const baseline = readFoodPlanEditContext(state, filters);
  state.preferences = Array.from({ length: 60 }, (_, index) => `${index}:"${'\u0000'.repeat(490)}结束`.padEnd(500, '字'));
  assert.ok(state.preferences.every(value => value.length === 500));
  const before = structuredClone(state), result = readFoodPlanEditContext(state, filters);
  assert.deepEqual(result.preferences, state.preferences);
  assert.equal(result.preferencesCount, 60);
  assert.equal(result.preferencesComplete, true);
  assert.equal(result.preferencesRevision, state.revision);
  assert.equal(result.preferencesJsonCharacters, JSON.stringify(state.preferences).length);
  assert.ok(result.preferencesJsonCharacters > 96000, 'JSON escaping is counted, not raw preference length');
  assert.equal(result.contextCharBudget, 24000);
  assert.ok(JSON.stringify(result).length <= result.charBudget);
  assert.deepEqual(result.inventoryCandidates, baseline.inventoryCandidates);
  assert.deepEqual(result.otherMeals, baseline.otherMeals);
  assert.deepEqual(result.meals, baseline.meals);
  assert.deepEqual(result.dailyNutritionSummary, baseline.dailyNutritionSummary);
  assert.equal(result.truncated, baseline.truncated);
  assert.deepEqual(state, before);
});

test('unreadable preferences and oversized actual facts reject instead of claiming complete empty or truncated context', () => {
  for (const bad of [undefined, null, '旧习惯原文', ['正常习惯', null]]) {
    const state = fixture(); state.preferences = bad;
    assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] }), error => error.status === 503 && error.code === 'PREFERENCES_UNAVAILABLE');
  }
  const state = fixture(), meal = state.plans[0].meals[1];
  state.preferences = ['必须完整保留的长期习惯。'.repeat(20)];
  meal.state = 'completed';
  meal.actualEntries = Array.from({ length: 100 }, (_, index) => ({ id: `actual-${index}`, itemId: 'a',
    name: '\u0000'.repeat(200), quantity: 1, unit: '袋', sourceText: 'PRIVATE original facts',
    nutritionSnapshot: structuredClone(meal.plannedItems[0].nutritionSnapshot) }));
  const before = structuredClone(state);
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] }), error => error.status === 413 && error.code === 'EDIT_CONTEXT_TOO_LARGE');
  assert.deepEqual(state, before);
});

test('saved edits immediately become the current menu in both default and active reads without reserving stock', () => {
  const state = fixture(), changed = input(); changed.meals[1].plannedItems[0].quantity = 3;
  const draftState = mutate(state, 'save_meal_plan_draft', { plan: changed }), before = structuredClone(draftState);
  const draft = readFoodPlanEditContext(draftState, { planId: 'day', mealSlots: ['lunch'] });
  const active = readFoodPlanEditContext(draftState, { planId: 'day', mealIds: ['lunch'], view: 'active' });
  assert.equal(draft.plan.hasDraft, false); assert.equal(draft.plan.editBase, 'active');
  assert.equal(draft.plan.canPatch, true); assert.equal(draft.plan.canApply, true);
  assert.deepEqual(draft.plan.applyProtectionReasons, []);
  assert.equal(readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] }).plan.canApply, true);
  assert.equal(draft.meals[0].plannedItems[0].quantity, 3);
  assert.equal(active.meals[0].plannedItems[0].quantity, 3);
  assert.equal(draft.dailyNutritionSummary.basis, 'confirmed_daily_plan');
  assert.equal(active.dailyNutritionSummary.basis, 'confirmed_daily_plan');
  assert.equal(kcal(draft.dailyNutritionSummary.totals).value, kcal(active.dailyNutritionSummary.totals).value);
  assert.equal(kcal(draft.dailyNutritionSummary.totals).value,
    kcal(readFoodPlanEditContext(state, { planId: 'day' }).dailyNutritionSummary.totals).value + 100);
  assert.deepEqual(draftState.items, state.items);
  assert.deepEqual(foodPlanNutritionSummary(draftState, 'day'), draft.dailyNutritionSummary);
  assert.deepEqual(foodPlanNutritionSummary(draftState, 'day', 'active'), active.dailyNutritionSummary);
  assert.deepEqual(draftState, before);
});

test('legacy nested menu drafts read as the current menu while retaining explicit prior active view and all original facts', () => {
  const state = fixture();
  state.plans[0].draft = { ...structuredClone(state.plans[0]), patchDraft: true };
  state.plans[0].draft.meals[1].plannedItems[0].quantity = 3;
  const before = structuredClone(state);
  const current = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] });
  const previous = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'], view: 'active' });
  assert.equal(current.plan.hasDraft, true);
  assert.equal(current.plan.canPatch, true);
  assert.equal(current.plan.canApply, true, 'a saved legacy draft does not require confirmation before another menu edit');
  assert.equal(current.meals[0].plannedItems[0].quantity, 3);
  assert.equal(previous.meals[0].plannedItems[0].quantity, 2);
  assert.equal(kcal(current.dailyNutritionSummary.totals).value, kcal(previous.dailyNutritionSummary.totals).value + 100);
  assert.deepEqual(state, before);
});

test('actual facts and pending or closed protection remain visible without returning original reports and audits', () => {
  let state = fixture();
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true,
    actualTime: '12:40', sourceText: 'PRIVATE actual original must stay in its ledger' });
  state = mutate(state, 'set_supplement_check', { planId: 'day', doseId: 'dose-0', checked: true });
  const result = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] });
  assert.equal(result.meals[0].hasActualFacts, true);
  assert.equal(result.meals[0].canPatch, true);
  assert.equal(result.meals[0].canRemove, false);
  assert.equal(result.meals[0].actualFactsImmutable, true);
  assert.equal(result.meals[0].actualTime, '12:40');
  assert.equal(result.meals[0].actualEntryIds.length, 2);
  assert.equal(result.meals[0].reportCount, 1);
  assert.equal(result.supplements.actualDoseCount, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const timeOnly = structuredClone(state); timeOnly.plans[0].meals[0].actualTimeText = 'PRIVATE time-only fact';
  timeOnly.plans[0].meals[0].actualEntries = []; timeOnly.plans[0].meals[0].actualTime = null;
  timeOnly.plans[0].meals[0].completionReportedAt = null; timeOnly.plans[0].meals[0].reportHistory = [];
  assert.equal(readFoodPlanEditContext(timeOnly, { planId: 'day', mealIds: ['breakfast'] }).meals[0].hasActualFacts, true);
  const pending = structuredClone(state); pending.plans[0].inventoryAccounting = 'pending_reconciliation';
  pending.plans[0].accountingIssues = [{ code: 'BASELINE_REQUIRES_REVIEW', itemId: 'a', message: 'PRIVATE issue details' }];
  const blocked = readFoodPlanEditContext(pending, { planId: 'day', mealIds: ['dinner'] });
  assert.equal(blocked.plan.canPatch, true, 'pending facts remain in place while an unconsumed meal may be drafted without settling stock');
  assert.equal(blocked.plan.canApply, true, 'menu edits do not settle or overwrite an existing accounting issue');
  assert.deepEqual(blocked.plan.applyProtectionReasons, []);
  assert.equal(blocked.meals[0].canPatch, true);
  assert.equal(blocked.plan.accountingIssues[0].code, 'BASELINE_REQUIRES_REVIEW');
  const closed = structuredClone(state); closed.plans[0].status = 'closed_with_actuals';
  assert.deepEqual(readFoodPlanEditContext(closed, { planId: 'day' }).plan.protectionReasons, ['PLAN_CLOSED']);
});

test('missing nutrition remains null with coverage and individual sources instead of fabricated zero totals', () => {
  const state = fixture(), line = state.plans[0].meals[1].plannedItems[0];
  line.nutritionSnapshot.nutrition.protein = null;
  line.nutritionSnapshot.nutrition.kcal = 110;
  line.nutritionSnapshot.nutrition.nutrientSources.kcal = 'estimate';
  const result = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] });
  assert.equal(result.meals[0].plannedItems[0].nutrition.protein, null);
  assert.equal(result.meals[0].plannedItems[0].nutrition.nutrientSources.kcal, 'estimate');
  const protein = result.dailyNutritionSummary.totals.find(total => total.key === 'protein');
  assert.equal(protein.partial, true); assert.equal(protein.completeValue, null);
  assert.equal(kcal(result.dailyNutritionSummary.totals).estimated, true);
});

test('candidate query returns matched foods only, caps twelve and retains explicit unavailable or missing IDs', () => {
  const state = fixture();
  state.items.push(...Array.from({ length: 20 }, (_, index) => item(`match-${index}`, 'vegetable', 'g', 100, 20, 100)));
  const result = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'], foodQuery: 'MATCH-', candidateItemIds: ['absent'] });
  assert.equal(result.inventoryCandidates.items.length, 12);
  assert.equal(result.inventoryCandidates.total, 22);
  assert.equal(result.inventoryCandidates.truncated, true);
  assert.deepEqual(result.inventoryCandidates.missingItemIds, ['absent']);
  assert.equal(result.inventoryCandidates.items.some(item => item.id === 'b'), false);
  assert.equal(result.inventoryCandidates.items[0].id, 'match-0', 'replacement matches take priority over original target foods');
  assert.equal(result.truncated, true);
  assert.equal(result.completeForPatch, true, 'candidate limit does not omit any target meal or line');
});

test('unknown balance and a changed baseline remain explicit for an actual debit in the latest candidate stock', () => {
  const state = mutate(fixture(), 'record_meal_intake', { planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true,
    sourceText: '午餐实际吃完两袋主餐和200g蘑菇' });
  state.items.find(item => item.id === 'a').quantity = null;
  state.items.find(item => item.id === 'a').quantityBaselineToken = 'new-absolute-recount';
  const result = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] });
  const current = result.inventoryCandidates.items.find(item => item.id === 'a');
  assert.equal(current.quantity, null);
  assert.equal(current.accountedByThisPlan.baselineMatches, false);
});

test('budget is checked after escaping and oversized target meals reject instead of omitting their lines', () => {
  const state = fixture(), meal = state.plans[0].meals[1], original = meal.plannedItems[0];
  meal.plannedItems = Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(original), id: 'large-' + index,
    nutritionSnapshot: { ...structuredClone(original.nutritionSnapshot), name: '\u0000'.repeat(200) } }));
  const before = structuredClone(state);
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] }), error => error.status === 413 && error.code === 'EDIT_CONTEXT_TOO_LARGE');
  assert.deepEqual(state, before);
});

test('a pure supplement canonical record stays a non-menu and short receipt survives removed meal IDs', () => {
  const state = fixture(), plan = state.plans[0]; plan.supplementOnly = true; plan.supplementAccounting = 'actual_only'; plan.meals = [];
  const result = readFoodPlanEditContext(state, { planId: 'day' });
  assert.equal(result.plan.supplementOnly, true);
  assert.deepEqual(result.meals, []);
  assert.deepEqual(result.dailyNutritionSummary.totals, []);
  assert.equal(result.dailyNutritionSummary.partial, true);
  assert.equal(foodPlanNutritionSummary(state, 'day').totals.length, 0);
  const ordinary = fixture(); ordinary.plans[0].meals = ordinary.plans[0].meals.filter(meal => meal.id !== 'lunch');
  assert.equal(foodPlanNutritionSummary(ordinary, 'day', 'active').date, '2026-10-19');
});

test('selection validates revision, canonical ambiguity, plan format and selectors before returning an edit context', () => {
  const state = fixture(), before = structuredClone(state);
  assert.throws(() => readFoodPlanEditContext(state, {}), error => error.status === 400);
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'missing' }), error => error.status === 404);
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', date: '2026-10-20' }), error => error.code === 'PLAN_DATE_CONFLICT');
  assert.throws(() => readFoodPlanEditContext(state, { date: '2026-02-30' }), error => error.status === 400);
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', expectedRevision: state.revision - 1 }), error => error.code === 'REVISION_CONFLICT');
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', mealIds: ['missing'] }), error => error.code === 'MEAL_NOT_FOUND');
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'], mealSlots: ['dinner'] }), error => error.code === 'MEAL_NOT_FOUND');
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', candidateItemIds: Array(13).fill('a') }), error => error.status === 400);
  assert.throws(() => readFoodPlanEditContext(state, { planId: 'day', view: 'guessed' }), error => error.status === 400);
  assert.deepEqual(state, before);
  const ambiguous = structuredClone(state); ambiguous.plans.push({ ...structuredClone(state.plans[0]), id: 'second-owner' });
  assert.throws(() => readFoodPlanEditContext(ambiguous, { date: '2026-10-19' }), error => error.status === 409 && error.code === 'AMBIGUOUS_DAILY_PLAN');
  const legacy = structuredClone(state); delete legacy.plans[0].format;
  assert.throws(() => readFoodPlanEditContext(legacy, { planId: 'day' }), error => error.code === 'PLAN_FORMAT_NOT_EDITABLE');
});
