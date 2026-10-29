import test from 'node:test';
import assert from 'node:assert/strict';
import { mealPatternContext } from '../lib/meal-pattern-context.mjs';

const DATE = '2026-10-26';
const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 20, carbs: 15, fat: 6, source: 'estimate',
  nutrientSources: { kcal: 'label', protein: 'recipe', carbs: 'estimate', fat: 'label' }, sourceText: 'FROZEN_LABEL_SECRET' };
function entry(id, overrides = {}) {
  return { id, itemId: 'beef', name: '实际牛肉', quantity: 100, unit: 'g', quantitySource: 'reported', sourceText: 'ACTUAL_SOURCE_SECRET',
    nutritionSnapshot: { name: '实际快照牛肉', unit: '袋', gramsPerUnit: 125, nutrition: structuredClone(nutrition) }, ...overrides };
}
function meal(id, slot, overrides = {}) {
  return { id, slot, state: 'completed', actualEntries: [entry(id + '-actual')], plannedTime: '12:30', actualTime: '13:00',
    plannedItems: [{ id: 'PLANNED_SECRET', itemId: 'pasta', name: '没有实际吃的意面', quantity: 110 }], ...overrides };
}
function plan(date = DATE, overrides = {}) {
  return { id: 'day-' + date, format: 'meals_v1', date, status: 'reserved', title: 'AI_PLAN_TITLE_SECRET', notes: 'PLAN_NOTES_SECRET',
    meals: ['breakfast', 'lunch', 'dinner'].map(slot => meal(date + '-' + slot, slot)),
    supplementDoses: [{ id: 'SUPPLEMENT_SECRET', state: 'completed', actualEntries: [entry('SUPPLEMENT_ACTUAL_SECRET')] }], ...overrides };
}
function state(plans = [plan()], items = [{ id: 'beef', name: '当前牛肉SKU', category: 'prepared', status: 'available', quantity: 600, unit: 'g', location: '冷藏', gramsPerUnit: 200, nutrition: { ...nutrition, kcal: 999 } }]) {
  return { revision: 41, items, plans, preferences: ['USER_HABIT_SECRET'], dietHistory: [{ date: DATE, confirmation: 'reported_completed', meals: [meal('HISTORY_SECRET', 'breakfast')] }] };
}

test('a draft-status day with real completed primary meals qualifies using exact actual identities and frozen portions', () => {
  const original = state([plan(DATE, { status: 'draft' })]), before = structuredClone(original);
  const result = mealPatternContext(original, DATE), reference = result.completeDayReferences[0], food = reference.meals[0].actualEntries[0];
  assert.equal(result.referenceMode, 'completed_primary_days');
  assert.equal(result.hasCompleteDayReference, true);
  assert.equal(reference.date, DATE); assert.equal(reference.planId, 'day-' + DATE);
  assert.deepEqual(reference.meals.map(row => row.slot), ['breakfast', 'lunch', 'dinner']);
  assert.equal(reference.meals[0].mealId, DATE + '-breakfast');
  assert.equal(food.id, DATE + '-breakfast-actual'); assert.equal(food.itemId, 'beef');
  assert.equal(food.name, '实际牛肉'); assert.equal(food.quantity, 100); assert.equal(food.unit, 'g');
  assert.equal(food.gramsPerUnit, 125, 'the old portion conversion stays attached to its frozen nutrition');
  assert.equal(food.nutrition.kcal, 200, 'current SKU nutrition cannot rewrite historical food');
  assert.deepEqual(food.nutrition.nutrientSources, nutrition.nutrientSources);
  assert.deepEqual(food.currentInventory, { matched: true, status: 'available', location: '冷藏', quantity: 600, unit: 'g', available: true, unitMatchesActual: true });
  assert.doesNotMatch(JSON.stringify(result), /PLANNED_SECRET|意面|AI_PLAN_TITLE_SECRET|PLAN_NOTES_SECRET|SUPPLEMENT_SECRET|SUPPLEMENT_ACTUAL_SECRET|ACTUAL_SOURCE_SECRET|FROZEN_LABEL_SECRET|HISTORY_SECRET|USER_HABIT_SECRET|12:30|13:00/);
  food.nutrition.nutrientSources.kcal = 'unknown'; food.currentInventory.quantity = 1;
  assert.deepEqual(original, before);
});

test('new planned edits and nested drafts cannot replace already executed food or enter references', () => {
  const original = state(), current = original.plans[0];
  current.draft = { meals: [meal('DRAFT_ONLY_SECRET', 'breakfast', { actualEntries: [entry('DRAFT_ACTUAL_SECRET')] })] };
  current.meals[2].actualEntries = [entry('real-bagel', { itemId: null, name: '实际贝果', quantity: 1, unit: '个', nutritionSnapshot: null })];
  const result = mealPatternContext(original, DATE), dinner = result.completeDayReferences[0].meals[2];
  assert.deepEqual(dinner.actualEntries.map(row => row.id), ['real-bagel']);
  assert.equal(dinner.actualEntries[0].name, '实际贝果');
  assert.equal(dinner.actualEntries[0].nutrition.kcal, null);
  assert.equal(dinner.actualEntries[0].currentInventory.matched, false);
  assert.doesNotMatch(JSON.stringify(result), /DRAFT_ONLY_SECRET|DRAFT_ACTUAL_SECRET|PLANNED_SECRET/);
});

test('the fourteen-calendar-day window is inclusive and never derives native execution from history or supplements', () => {
  const original = state([plan('2026-10-13'), plan('2026-10-12'), plan('2026-10-27'), plan('2026-02-30'),
    { ...plan('2026-10-25'), format: 'legacy' }, plan('2026-10-24', { supplementOnly: true })]);
  const result = mealPatternContext(original, DATE);
  assert.equal(result.from, '2026-10-13'); assert.equal(result.to, DATE);
  assert.deepEqual(result.completeDayReferences.map(row => row.date), ['2026-10-13']);
  assert.deepEqual(result.coverage.excludedPlanCounts, { nonNative: 1, supplementOnly: 1, invalidDate: 1, future: 1, outsideWindow: 1, ambiguousDate: 0, ambiguousMealSlots: 0 });
});

test('uncompleted, cancelled and zero-only meals are not a complete day; completed singles remain clearly labelled fallback', () => {
  const original = state([plan(DATE, { meals: [
    meal('breakfast-real', 'breakfast'), meal('lunch-not-finished', 'lunch', { state: 'in_progress' }),
    meal('dinner-cancelled', 'dinner', { state: 'cancelled' }), meal('zero-snack', 'snack', { actualEntries: [entry('zero', { quantity: 0 })] }),
  ] })]);
  const result = mealPatternContext(original, DATE);
  assert.equal(result.hasCompleteDayReference, false); assert.deepEqual(result.completeDayReferences, []);
  assert.equal(result.referenceMode, 'completed_meals_only');
  assert.equal(result.noCompleteDayReason, 'NO_COMPLETED_PRIMARY_DAY_IN_WINDOW');
  assert.deepEqual(result.recentCompletedMealReferences.map(row => row.mealId), ['breakfast-real']);
  assert.doesNotMatch(JSON.stringify(result), /lunch-not-finished|dinner-cancelled|zero-snack/);
});

test('unknown actual portions remain null, invalid negative portions are excluded and incomplete coverage stays explicit', () => {
  const original = state(), meals = original.plans[0].meals;
  meals[0].actualEntries = [entry('unknown', { quantity: null })];
  meals[1].actualEntries.push(entry('negative-invalid', { quantity: -20 }), entry('not-eaten', { quantity: 0 }));
  const result = mealPatternContext(original, DATE), day = result.completeDayReferences[0];
  assert.equal(day.primaryMealsComplete, true); assert.equal(day.quantitiesComplete, false);
  assert.equal(day.meals[0].actualEntries[0].quantity, null); assert.equal(day.meals[0].actualEntries[0].quantityKnown, false);
  assert.equal(day.meals[1].excludedInvalidActualEntryCount, 1); assert.equal(day.meals[1].quantitiesComplete, false);
  assert.deepEqual(day.meals[1].actualEntries.map(row => row.id), [DATE + '-lunch-actual']);
  const invalidOnly = state([plan(DATE, { meals: [meal('invalid-only', 'breakfast', { actualEntries: [entry('bad', { quantity: -1 })] })] })]);
  assert.deepEqual(mealPatternContext(invalidOnly, DATE).recentCompletedMealReferences, []);
});

test('exact SKU matching distinguishes depleted, pending, archived, missing and external foods without guessing availability', () => {
  const foods = [entry('zero-stock', { itemId: 'empty' }), entry('pending-stock', { itemId: 'pending' }),
    entry('archived-stock', { itemId: 'archived' }), entry('missing-stock', { itemId: 'old-sku', name: '同名酸奶' }),
    entry('external-food', { itemId: null, name: '外面买的食物' }), entry('unknown-stock', { itemId: 'unknown' })];
  const original = state([plan(DATE, { meals: [meal('reference', 'breakfast', { actualEntries: foods })] })], [
    { id: 'empty', name: '已用完', status: 'available', quantity: 0, unit: 'g', location: '冷藏' },
    { id: 'pending', name: '待核', status: 'pending', quantity: 10, unit: 'g', location: '' },
    { id: 'archived', name: '已归档', status: 'archived', quantity: 10, unit: 'g', location: '冷冻' },
    { id: 'new-sku', name: '同名酸奶', status: 'available', quantity: 500, unit: 'g', location: '冷藏' },
    { id: 'unknown', name: '有货余量未知', status: 'available', quantity: null, unit: 'g', location: '常温' },
  ]);
  const rows = mealPatternContext(original, DATE).recentCompletedMealReferences[0].actualEntries;
  assert.deepEqual(rows.map(row => row.currentInventory.available), [false, false, false, false, false, true]);
  assert.deepEqual(rows.map(row => row.currentInventory.matched), [true, true, true, false, false, true]);
  assert.equal(rows[3].itemId, 'old-sku'); assert.equal(rows[3].currentInventory.status, null);
  assert.equal(rows[4].itemId, null); assert.equal(rows[5].currentInventory.quantity, null);
});

test('current unit differences are visible and never convert frozen food quantities or fill unknown old nutrition', () => {
  const original = state(); original.items[0].unit = 'ml';
  original.plans[0].meals[0].actualEntries[0].nutritionSnapshot.nutrition.carbs = null;
  const food = mealPatternContext(original, DATE).completeDayReferences[0].meals[0].actualEntries[0];
  assert.equal(food.unit, 'g'); assert.equal(food.quantity, 100);
  assert.equal(food.currentInventory.unit, 'ml'); assert.equal(food.currentInventory.unitMatchesActual, false);
  assert.equal(food.nutrition.carbs, null); assert.equal(food.nutrition.nutrientSources.carbs, 'unknown');
  assert.equal(food.nutritionComplete, false);
});

test('duplicate meal slots and duplicate native dates skip ambiguous days instead of mixing meals across plans', () => {
  const repeated = plan(DATE); repeated.meals.push(meal('another-breakfast', 'breakfast', { state: 'reserved' }));
  const result = mealPatternContext(state([repeated, plan('2026-10-25'), plan('2026-10-25', { id: 'other-plan-same-day' })]), DATE);
  assert.deepEqual(result.completeDayReferences, []); assert.deepEqual(result.recentCompletedMealReferences, []);
  assert.equal(result.coverage.excludedPlanCounts.ambiguousMealSlots, 1);
  assert.equal(result.coverage.excludedPlanCounts.ambiguousDate, 2);
});

test('at most three recent complete days are included with explicit atomic omissions', () => {
  const original = state(Array.from({ length: 6 }, (_, index) => plan(`2026-10-${26 - index}`))), before = structuredClone(original);
  const result = mealPatternContext(original, DATE);
  assert.deepEqual(result.completeDayReferences.map(row => row.date), ['2026-10-26', '2026-10-25', '2026-10-24']);
  assert.ok(result.completeDayReferences.every(row => row.meals.length === 3));
  assert.equal(result.coverage.eligibleCompleteDayCount, 6); assert.equal(result.coverage.includedCompleteDayCount, 3);
  assert.equal(result.coverage.omittedCompleteDayCount, 3); assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length <= result.charBudget); assert.deepEqual(original, before);
});

test('the encoded budget omits a whole oversized day, retaining a smaller older day without partial meal or food truncation', () => {
  const huge = plan(); huge.meals[0].actualEntries = Array.from({ length: 100 }, (_, index) => entry('huge-' + index, { name: '\u0000'.repeat(150) }));
  const original = state([huge, plan('2026-10-25')]), before = structuredClone(original);
  const result = mealPatternContext(original, DATE);
  assert.deepEqual(result.completeDayReferences.map(row => row.date), ['2026-10-25']);
  assert.equal(result.completeDayReferences[0].meals.length, 3);
  assert.equal(result.coverage.omittedCompleteDayCount, 1); assert.equal(result.truncated, true);
  assert.deepEqual(result.recentCompletedMealReferences, []);
  assert.ok(JSON.stringify(result).length <= result.charBudget); assert.deepEqual(original, before);
  assert.deepEqual(result.omittedCompleteDayReferences, [{ date: DATE, planId: 'day-' + DATE,
    referenceEvidence: 'reported_actual', actualIntakeProven: true,
    detail: { tool: 'read_diet_records', date: DATE, planId: 'day-' + DATE } }]);
  const onlyHuge = mealPatternContext(state([huge]), DATE);
  assert.deepEqual(onlyHuge.completeDayReferences, []); assert.deepEqual(onlyHuge.recentCompletedMealReferences, []);
  assert.equal(onlyHuge.noCompleteDayReason, 'COMPLETED_PRIMARY_DAYS_EXCEED_CONTEXT_BUDGET');
  assert.equal(onlyHuge.omittedCompleteDayReferences[0].detail.planId, 'day-' + DATE);
});

function settledAutomatic(date = '2026-10-25') {
  const original = plan(date, { meals: ['breakfast', 'lunch', 'dinner'].map(slot => meal(date + '-' + slot, slot, {
    state: 'reserved', actualEntries: [], plannedItems: [{ id: 'planned-' + slot, itemId: 'beef', name: '可修改的新计划名字', quantity: 999, unit: 'g', nutritionSnapshot: { nutrition } }],
  })) });
  original.dailySettlement = { version: 1, date, effectiveDate: date, source: 'automatic_menu', basis: 'auto_planned',
    accounting: 'settled', settledAt: '2026-10-26T04:00:00.000Z',
    plannedMeals: original.meals.map(row => ({ mealId: row.id, plannedItems: [{ id: 'frozen-' + row.slot, itemId: 'beef', quantity: 100, unit: 'g' }] })) };
  return original;
}

test('settled automatic menus are lower-confidence references with stable planned IDs and no invented actual nutrition', () => {
  const original = state([settledAutomatic()]), before = structuredClone(original), result = mealPatternContext(original, DATE);
  const reference = result.completeDayReferences[0], breakfast = reference.meals[0];
  assert.equal(result.referenceMode, 'automatic_menu_assumptions');
  assert.equal(reference.referenceEvidence, 'automatic_menu_assumption'); assert.equal(reference.actualIntakeProven, false);
  assert.equal(breakfast.state, 'automatic_menu_settled'); assert.equal(breakfast.actualIntakeProven, false);
  assert.deepEqual(breakfast.actualEntries, []);
  assert.equal(breakfast.mealId, '2026-10-25-breakfast');
  assert.equal(breakfast.plannedEntries[0].id, 'frozen-breakfast');
  assert.equal(breakfast.plannedEntries[0].quantity, 100, 'the settled portion wins over later mutable plannedItems');
  assert.equal(breakfast.plannedEntries[0].nutrition.kcal, null, 'current SKU and mutable planned nutrition are not a frozen old label');
  assert.equal(breakfast.plannedEntries[0].currentInventory.unitMatchesActual, null);
  assert.equal(reference.nutritionComplete, false); assert.equal(result.coverage.eligibleAutomaticCompleteDayCount, 1);
  assert.deepEqual(original, before); assert.ok(JSON.stringify(result).length <= result.charBudget);
});

test('personal checkbox reminders never change automatic reference selection, amounts or evidence', () => {
  const original = state([settledAutomatic()]), first = mealPatternContext(original, DATE);
  original.plans[0].personalFoodChecks = { 'frozen-breakfast': true };
  original.plans[0].meals[0].personalChecked = true;
  assert.deepEqual(mealPatternContext(original, DATE), first);
  const forbidden = () => { throw new Error('personal reminder must not be read'); };
  Object.defineProperty(original.plans[0], 'personalFoodChecks', { get: forbidden });
  Object.defineProperty(original.plans[0].meals[0], 'personalChecked', { get: forbidden });
  assert.deepEqual(mealPatternContext(original, DATE), first);
});

test('pending, unattempted and future automatic menus are not accepted; reported days still precede settled defaults', () => {
  const pending = settledAutomatic('2026-10-24'); pending.dailySettlement.accounting = 'pending_reconciliation';
  const unattempted = settledAutomatic('2026-10-23'); unattempted.dailySettlement.settledAt = null;
  const future = settledAutomatic('2026-10-27');
  const result = mealPatternContext(state([pending, unattempted, future]), DATE);
  assert.deepEqual(result.completeDayReferences, []); assert.deepEqual(result.recentCompletedMealReferences, []);
  const mixed = mealPatternContext(state([settledAutomatic(), plan('2026-10-24')]), DATE);
  assert.deepEqual(mixed.completeDayReferences.map(row => [row.date, row.referenceEvidence]), [
    ['2026-10-24', 'reported_actual'], ['2026-10-25', 'automatic_menu_assumption'],
  ]);
  assert.equal(mixed.referenceMode, 'mixed_primary_days');
  assert.equal(mixed.completeDayReferences[0].actualIntakeProven, true);
  assert.equal(mixed.completeDayReferences[1].actualIntakeProven, false);
});

test('explicit actual zero or a corrected replacement overrides settled menu defaults without persisting synthesized facts', () => {
  const settled = settledAutomatic();
  settled.meals[0].actualEntries = [entry('reported-zero', { quantity: 0 })];
  settled.meals[0].reportHistory = [{ mode: 'correct', entryIds: ['reported-zero'] }];
  settled.meals[1].actualEntries = [entry('reported-half', { quantity: 40 })];
  settled.meals[1].reportHistory = [{ mode: 'append', entryIds: ['reported-half'] }];
  const original = state([settled]), before = structuredClone(original), result = mealPatternContext(original, DATE);
  assert.equal(result.hasCompleteDayReference, false, 'explicit zero does not become a full default breakfast');
  const lunch = result.recentCompletedMealReferences.find(row => row.slot === 'lunch');
  assert.equal(lunch.referenceEvidence, 'automatic_menu_assumption'); assert.equal(lunch.actualIntakeProven, false);
  assert.equal(lunch.actualEntries[0].id, 'reported-half'); assert.equal(lunch.actualEntries[0].quantity, 40);
  assert.equal(lunch.plannedEntries[0].quantity, 60);
  assert.deepEqual(original, before);
});

test('a realistic complete day with twenty-four long-named SKU portions fits atomically', () => {
  const actualFoods = Array.from({ length: 24 }, (_, index) => entry(`actual-${index}-`.padEnd(100, 'i'), {
    itemId: `sku-${index}-`.padEnd(100, 's'), name: `${index} 原味产品完整名称 `.padEnd(160, '品'),
  }));
  const original = state([plan(DATE, { meals: ['breakfast', 'lunch', 'dinner'].map((slot, index) =>
    meal(`meal-${slot}`.padEnd(100, 'm'), slot, { actualEntries: actualFoods.slice(index * 8, (index + 1) * 8) })) })],
  actualFoods.map(food => ({ id: food.itemId, name: food.name, status: 'available', quantity: 1000, unit: 'g', location: '冷藏' })));
  const before = structuredClone(original), result = mealPatternContext(original, DATE);
  assert.equal(result.completeDayReferences.length, 1);
  assert.equal(result.completeDayReferences[0].meals.reduce((sum, row) => sum + row.actualEntries.length, 0), 24);
  assert.equal(result.truncated, false); assert.deepEqual(result.omittedCompleteDayReferences, []);
  assert.ok(JSON.stringify(result).length <= 24000);
  assert.deepEqual(original, before);
});

test('single-meal fallback remains bounded without claiming a complete-day template', () => {
  const original = state(Array.from({ length: 8 }, (_, index) => plan(`2026-10-${26 - index}`, { meals: [meal('single-' + index, 'breakfast')] })));
  const result = mealPatternContext(original, DATE);
  assert.equal(result.recentCompletedMealReferences.length, 6); assert.equal(result.hasCompleteDayReference, false);
  assert.equal(result.coverage.eligibleCompletedMealCount, 8); assert.equal(result.coverage.omittedFallbackMealCount, 2);
  assert.equal(result.truncated, true); assert.ok(JSON.stringify(result).length <= result.charBudget);
});

test('derivation avoids full plan, time, supplement, habit and historical transcript fields entirely', () => {
  const original = state();
  const forbidden = () => { throw new Error('Unneeded transcript accessed'); };
  for (const key of ['draft', 'notes', 'title', 'supplementDoses']) Object.defineProperty(original.plans[0], key, { get: forbidden });
  for (const key of ['preferences', 'dietHistory']) Object.defineProperty(original, key, { get: forbidden });
  for (const row of original.plans[0].meals) for (const key of ['plannedItems', 'plannedTime', 'actualTime', 'sourceText', 'reportHistory']) Object.defineProperty(row, key, { get: forbidden });
  assert.equal(mealPatternContext(original, DATE).completeDayReferences.length, 1);
  assert.throws(() => mealPatternContext(original, '2026-02-30'), error => error.status === 400 && error.code === 'INVALID_REFERENCE_DATE');
  assert.throws(() => mealPatternContext({ revision: 1, items: [], plans: null }, DATE), error => error.status === 503);
});
