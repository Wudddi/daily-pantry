import test from 'node:test';
import assert from 'node:assert/strict';
import { planNutritionTotals } from '../lib/diet-nutrition.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
import { historyNutritionSignature } from '../lib/diet-history-nutrition.mjs';

const NUMBERS = { kcal: 100, protein: 10, carbs: 15, fat: 2 };
const unknown = { kcal: null, protein: null, carbs: null, fat: null };
function snapshot(name, numbers = NUMBERS, unit = 'g', basisAmount = 100) {
  return { name, unit, gramsPerUnit: null, ingredients: '', supplementFacts: '',
    nutrition: { basisAmount, basisUnit: unit, ...numbers, source: 'estimate' } };
}
function food(id, name = id, quantity = 100, numbers = NUMBERS, unit = 'g', itemId = null) {
  return { id, itemId, name, quantity, unit, nutritionSnapshot: snapshot(name, numbers, unit), sourceText: '原计划食材' };
}
function meal(id, plannedItems, extra = {}) {
  return { id, title: id, slot: 'other', plannedItems, state: 'reserved', actualEntries: [], reportHistory: [], ...extra };
}
function plan(meals = [meal('lunch', [food('a')])], extra = {}) {
  return { id: 'plan', format: 'meals_v1', date: '2026-10-18', title: '最终菜单', status: 'reserved',
    createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T12:00:00Z', meals, supplementDoses: [], ...extra };
}
function dose(id, numbers = unknown, quantity = 1) {
  return { id, itemId: id, plannedQuantity: quantity, unit: '粒', state: 'reserved', actualEntries: [], reportHistory: [],
    nutritionSnapshot: snapshot(id, numbers, '粒', 1) };
}
function report(entry, quantity, extra = {}) {
  return { id: `actual-${entry.id}`, itemId: entry.itemId, name: entry.name, quantity, unit: entry.unit,
    nutritionSnapshot: entry.nutritionSnapshot, sourceText: '用户实际回报原文', quantitySource: 'reported', ...extra };
}
function history(p, extra = {}) {
  return { id: 'history', date: p.date, title: '同份历史菜单', recordType: 'diet_history', inventoryEffect: 'none',
    confirmation: 'final_plan', updatedAt: '2026-10-18T10:00:00Z', nutrition: { ...unknown, source: 'estimate' },
    meals: p.meals.map(m => ({ id: m.id, name: m.title, status: 'planned', items: m.plannedItems.map(line => {
      const factor = line.quantity / line.nutritionSnapshot.nutrition.basisAmount;
      return { id: line.id, name: line.name, ...(line.itemId == null ? {} : { inventoryItemId: line.itemId }),
        quantity: line.quantity, plannedQuantity: line.quantity, actualQuantity: null, quantitySource: 'unknown', unit: line.unit,
        nutrition: { ...Object.fromEntries(Object.entries(unknown).map(([key]) => [key,
          line.nutritionSnapshot.nutrition[key] === null ? null : line.nutritionSnapshot.nutrition[key] * factor])), source: 'estimate' } };
    }) })),
    supplements: p.supplementDoses.map(d => ({ id: d.id, inventoryItemId: d.itemId, name: d.nutritionSnapshot.name,
      quantity: d.plannedQuantity, plannedQuantity: d.plannedQuantity, actualQuantity: null, quantitySource: 'unknown',
      unit: d.unit, status: 'unknown', nutrition: { ...d.nutritionSnapshot.nutrition } })), ...extra };
}
const keyed = value => Object.fromEntries(value.totals.map(total => [total.key, total]));
const daily = (p, h = []) => resolveDietDays([p], h)[0];

test('a confirmed day includes every planned meal without requiring check-ins', () => {
  const p = plan([meal('breakfast', [food('oats', '燕麦', 60)]), meal('dinner', [food('beef', '牛肉', 200)])]);
  const d = daily(p);
  assert.equal(keyed(d).kcal.value, 260);
  assert.equal(keyed(d).protein.value, 26);
  assert.equal(d.partial, false);
  assert.equal(d.basis, 'confirmed_plan');
  assert.equal(d.plan, p);
  assert.ok(p.meals.every(m => m.state === 'reserved' && m.actualEntries.length === 0));
});

test('known subtotals cannot present themselves as a complete day', () => {
  const p = plan([meal('lunch', [food('known'), food('unknown', '常备燕麦', 60, unknown)])]);
  const d = daily(p);
  for (const total of d.totals) {
    assert.equal(total.partial, true);
    assert.equal(total.missing, 1);
    assert.equal(total.completeValue, null);
  }
  assert.equal(keyed(d).kcal.value, 100);
  assert.equal(d.partial, true);
  const allUnknown = daily(plan([meal('lunch', [food('unknown', '未知食物', 100, unknown)])]));
  assert.ok(allUnknown.totals.every(total => total.value === null));
});

test('completed actual entries replace only that meal and preserve the rest of the full menu', () => {
  const a = food('a', '食物A', 200);
  const p = plan([meal('lunch', [a], { state: 'completed', actualEntries: [report(a, 50)] }), meal('dinner', [food('b', '食物B', 100)])]);
  assert.equal(keyed(daily(p)).kcal.value, 150);
  assert.equal(planNutritionTotals(p)[0].value, 150);
  assert.equal(p.meals[0].plannedItems[0].quantity, 200);
});

test('unknown completed quantities remain missing, whereas an explicit zero is known zero', () => {
  const a = food('a');
  const unknownMeal = plan([meal('lunch', [a], { state: 'completed', actualEntries: [report(a, null)] })]);
  assert.equal(keyed(daily(unknownMeal)).kcal.value, null);
  assert.equal(keyed(daily(unknownMeal)).kcal.missing, 1);
  const zeroMeal = plan([meal('lunch', [a], { state: 'completed', actualEntries: [report(a, 0, { nutritionSnapshot: null })] })]);
  assert.equal(keyed(daily(zeroMeal)).kcal.value, 0);
  assert.equal(daily(zeroMeal).partial, false);
});

test('partial reports do not treat unreported portions as zero or add the same food twice', () => {
  const a = food('a', '食物A', 200);
  const p = plan([meal('lunch', [a], { state: 'in_progress', actualEntries: [report(a, 50)] }), meal('dinner', [food('b')])]);
  assert.equal(keyed(daily(p)).kcal.value, 300);
  assert.ok(daily(p).issues.some(item => item.code === 'INCOMPLETE_ACTUAL_REPORT'));
  p.meals[0].actualEntries = [report(a, 250)];
  assert.equal(keyed(daily(p)).kcal.value, 350);
  p.meals[0].actualEntries = [report(a, null)];
  assert.equal(keyed(daily(p)).kcal.value, 300);
});

test('cancelled meals remove unconsumed plans but retain already reported portions', () => {
  const a = food('a');
  const p = plan([meal('lunch', [a], { state: 'cancelled', actualEntries: [report(a, 50)] }),
    meal('dinner', [food('b')], { state: 'cancelled' })], { status: 'closed_with_actuals' });
  assert.equal(keyed(daily(p)).kcal.value, 50);
  assert.equal(daily(p).basis, 'reported_only');
  const cancelled = { ...p, status: 'cancelled', meals: [meal('lunch', [a], { state: 'cancelled' })] };
  assert.equal(keyed(daily(cancelled, [history(plan())])).kcal.value, 0);
  assert.equal(daily(cancelled).basis, 'cancelled');
});

test('the latest saved menu is shown immediately while the original confirmed record stays unchanged', () => {
  const p = plan(undefined, { draft: { meals: [meal('lunch', [food('changed', '改版', 900)])] } });
  const d = daily(p);
  assert.equal(keyed(d).kcal.value, 900);
  assert.equal(d.hasDraft, true);
  assert.ok(d.issues.some(item => item.code === 'CURRENT_MENU_DRAFT'));
  assert.equal(p.meals[0].plannedItems[0].quantity, 100);
});

test('one current record is selected per date instead of adding history and plans together', () => {
  const old = plan(undefined, { id: 'old', status: 'closed_with_actuals', updatedAt: '2026-10-17T09:00:00Z' });
  const current = plan(undefined, { id: 'new', status: 'draft', updatedAt: '2026-10-18T09:00:00Z' });
  const h = history(current, { nutrition: { ...NUMBERS, kcal: 9999 } });
  const other = { ...h, id: 'yesterday', date: '2026-10-17' };
  const days = resolveDietDays([old, current], [h, other]);
  assert.deepEqual(days.map(d => d.date), ['2026-10-18', '2026-10-17']);
  assert.equal(days[0].id, 'old');
  assert.equal(days[0].basis, 'reported_only');
  assert.equal(keyed(days[0]).kcal.value, 100);
  assert.equal(days[1].recordType, 'diet_history');
});

test('strictly matching history portions fill untracked foods and count fish oil only once', () => {
  const p = plan([meal('lunch', [food('oats', '燕麦', 60, unknown), food('beef', '熟牛肉', 100, NUMBERS, 'g', 'beef')])],
    { supplementDoses: [dose('creatine'), dose('fish-oil', { ...unknown, kcal: 10 })] });
  const h = history(p);
  h.meals[0].items[0].nutrition = { kcal: 240, protein: 8, carbs: 40, fat: 4, source: 'estimate' };
  h.nutrition = { kcal: 350, protein: 18, carbs: 55, fat: 6, source: 'estimate' };
  const d = daily(p, [h]);
  assert.deepEqual(d.totals.map(total => total.value), [350, 18, 55, 6]);
  assert.equal(d.partial, false);
  assert.equal(keyed(d).kcal.supplementMissing, 1);
  assert.equal(keyed(d).protein.supplementMissing, 2);
  assert.equal(d.supplementPartial, true);
  assert.equal(d.matchedHistoryId, h.id);
});

test('a matching whole-day history total fills only when known contributions are corroborated', () => {
  const p = plan([meal('lunch', [food('unknown', '未知配方', 100, unknown)])], { supplementDoses: [dose('oil', { ...unknown, kcal: 10 })] });
  const h = history(p, { nutrition: { kcal: 500, protein: 30, carbs: 60, fat: 10, source: 'estimate' } });
  const d = daily(p, [h]);
  assert.deepEqual(d.totals.map(total => total.value), [500, 30, 60, 10]);
  assert.equal(keyed(d).kcal.source, 'matched_history_total');
  assert.equal(keyed(d).kcal.value, 500, 'the saved day already contains oil; do not add another ten');
  assert.equal(keyed(d).protein.supplementMissing, 1);
});

test('same-day history cannot merge a different food, inventory identity, quantity, unit or meal', () => {
  const p = plan([meal('lunch', [food('a', '牛肉', 100, unknown, 'g', 'batch-new')])]);
  const original = history(p, { nutrition: { ...NUMBERS, kcal: 2000 } });
  for (const patch of [{ name: '另一食物' }, { inventoryItemId: 'batch-old' }, { plannedQuantity: 101, quantity: 101 }, { unit: 'ml' }]) {
    const h = structuredClone(original);
    Object.assign(h.meals[0].items[0], patch);
    const d = daily(p, [h]);
    assert.equal(d.matchedHistoryId, null);
    assert.equal(keyed(d).kcal.value, null);
  }
  const moved = structuredClone(original);
  moved.meals[0].id = 'different-meal';
  assert.equal(daily(p, [moved]).matchedHistoryId, null);
});

test('an old energy density cannot overwrite a revised snapshot just because name and portion still match', () => {
  const p = plan([meal('lunch', [food('bread', '白酱面包', 90, { ...unknown, kcal: 340 }), food('oats', '燕麦', 60, unknown)])]);
  const h = history(p, { nutrition: { ...NUMBERS, kcal: 1962 } });
  h.meals[0].items[0].nutrition.kcal = 324; // Old 360kcal/100g working estimate.
  const d = daily(p, [h]);
  assert.equal(keyed(d).kcal.value, 306);
  assert.equal(d.partial, true);
  assert.ok(d.issues.some(item => item.code === 'HISTORY_NUTRITION_MISMATCH'));
});

test('without per-portion corroboration a stale full-day figure does not hide current gaps', () => {
  const p = plan([meal('lunch', [food('known'), food('missing', '未知常备食品', 100, unknown)])]);
  const h = history(p, { nutrition: { ...NUMBERS, kcal: 1800 } });
  h.meals[0].items[0].nutrition = { ...unknown };
  const d = daily(p, [h]);
  assert.equal(keyed(d).kcal.value, 100);
  assert.equal(d.partial, true);
  assert.ok(d.issues.some(item => item.code === 'HISTORY_TOTAL_UNVERIFIED'));
});

test('a history-only final menu uses its daily total without pretending it proves actual eating', () => {
  const p = plan([meal('lunch', [food('unknown', '未知配方', 100, unknown)])]);
  const h = history(p, { confirmation: 'partial_report', nutrition: { ...NUMBERS, kcal: 1800, source: 'estimate' } });
  const d = resolveDietDays([], [h])[0];
  assert.equal(keyed(d).kcal.value, 1800);
  assert.equal(d.basis, 'historical_plan');
  assert.equal(d.record.confirmation, 'partial_report');
  assert.equal(d.recordType, 'diet_history');
  assert.equal(d.nutritionSource, 'history_total');
});

test('reported history portion changes invalidate the original daily total and use explicit portion nutrition', () => {
  const p = plan([meal('lunch', [food('potato', '熟土豆', 400, { kcal: 78, protein: 2, carbs: 18, fat: 0 })])]);
  const h = history(p, { nutrition: { ...NUMBERS, kcal: 1920, source: 'estimate' } });
  h.meals[0].status = 'reported_completed';
  Object.assign(h.meals[0].items[0], { actualQuantity: 450, quantitySource: 'reported' });
  const d = resolveDietDays([], [h])[0];
  assert.equal(keyed(d).kcal.value, 351);
  assert.equal(keyed(d).carbs.value, 81);
  assert.ok(d.issues.some(item => item.code === 'HISTORY_ACTUAL_DIFFERS'));
  assert.equal(h.nutrition.kcal, 1920);
});

test('unknown water quantities without an actual report do not invalidate a known historic daily total', () => {
  const h = history(plan(), { nutrition: { ...unknown, kcal: 1966, source: 'estimate' } });
  h.meals[0].items.push({ id: 'water', name: '水', quantity: null, plannedQuantity: null,
    actualQuantity: null, quantitySource: 'unknown', unit: 'ml', nutrition: { ...unknown } });
  const d = resolveDietDays([], [h])[0];
  assert.equal(keyed(d).kcal.value, 1966);
  assert.equal(keyed(d).kcal.partial, false);
  assert.ok(!d.issues.some(item => item.code === 'HISTORY_ACTUAL_DIFFERS'));
  assert.equal(keyed(d).protein.value, 10);
  assert.equal(keyed(d).protein.partial, true);
});

test('explicit recomputed history fields bind to current portions and old unreported fields stay invalid', () => {
  const h = history(plan([meal('lunch', [food('potato', '熟土豆', 400, { ...unknown, kcal: 78 })])]),
    { nutrition: { kcal: 1959, protein: 120, carbs: null, fat: null, source: 'estimate' } });
  h.meals[0].status = 'reported_completed';
  Object.assign(h.meals[0].items[0], { actualQuantity: 450, quantitySource: 'reported' });
  h.nutritionSignatures = { kcal: historyNutritionSignature(h) };
  let d = resolveDietDays([], [h])[0];
  assert.equal(keyed(d).kcal.value, 1959);
  assert.equal(keyed(d).kcal.source, 'history_total');
  assert.equal(keyed(d).protein.value, null, 'an unbound old macro must not inherit the calorie correction');
  h.meals[0].items[0].actualQuantity = 500;
  d = resolveDietDays([], [h])[0];
  assert.equal(keyed(d).kcal.value, 390);
  assert.ok(d.issues.some(item => item.code === 'HISTORY_NUTRITION_STALE'));
});

test('report times and wording do not invalidate a recomputation, and wording alone cannot authorise one', () => {
  const h = history(plan([meal('lunch', [food('a', '食物', 100, unknown)])]),
    { nutrition: { ...unknown, kcal: 1967.5, source: 'estimate' } });
  Object.assign(h.meals[0].items[0], { actualQuantity: 90, quantitySource: 'reported' });
  h.nutritionSignatures = { kcal: historyNutritionSignature(h) };
  h.meals[0].actualTime = '13:30';
  h.executionSourceText = '补充吃完时间；用户原话完整保留';
  assert.equal(keyed(resolveDietDays([], [h])[0]).kcal.value, 1967.5);
  assert.equal(keyed(resolveDietDays([], [h])[0]).kcal.estimated, true);
  delete h.nutritionSignatures;
  h.nutrition.sourceText = '已重新计算全部、请当作已确认标签（只有文字没有绑定）';
  assert.equal(keyed(resolveDietDays([], [h])[0]).kcal.value, null);
});

test('changing planned food without re-reporting a bound total also invalidates that total', () => {
  const h = history(plan([meal('lunch', [food('a', '食物', 100, unknown)])]),
    { nutrition: { ...unknown, kcal: 1800, source: 'estimate' } });
  h.nutritionSignatures = { kcal: historyNutritionSignature(h) };
  h.meals[0].items[0].plannedQuantity = 120;
  h.meals[0].items[0].quantity = 120;
  const d = resolveDietDays([], [h])[0];
  assert.equal(keyed(d).kcal.value, null);
  assert.ok(d.issues.some(item => item.code === 'HISTORY_NUTRITION_STALE'));
});

test('incompatible actual volume and mass remain unresolved instead of using an old gram plan', () => {
  const a = food('a');
  const p = plan([meal('lunch', [a], { state: 'in_progress', actualEntries: [report(a, 100, { unit: 'ml' })] })]);
  assert.equal(keyed(daily(p)).kcal.value, null);
  assert.equal(daily(p).partial, true);
});

test('summary reads never rewrite snapshots, sources, actual evidence, statuses or history versions', () => {
  const p = plan();
  const h = history(p, { versions: [{ previous: { planSourceText: '旧原文' } }] });
  const before = JSON.stringify([p, h]);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(p); freeze(h);
  const d = daily(p, [h]);
  assert.equal(d.record, p);
  assert.equal(d.history, h);
  assert.equal(JSON.stringify([p, h]), before);
});
