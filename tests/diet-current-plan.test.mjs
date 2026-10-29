import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCurrentDietPlan } from '../lib/diet-current-plan.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';

const at = '2026-10-22T12:48:00Z';
const nutrition = (kcal = 100, unit = 'g') => ({ basisAmount: unit === 'g' ? 100 : 1,
  basisUnit: unit, kcal, protein: 10, carbs: 15, fat: 2, source: 'label' });
const snapshot = (id, kcal = 100, unit = 'g') => ({ name: id, unit, nutrition: nutrition(kcal, unit),
  gramsPerUnit: null, ingredients: '', supplementFacts: '' });
const food = (id, quantity = 100) => ({ id: `line-${id}`, itemId: id, quantity, unit: 'g', sourceText: '用户菜单' });
const meal = (id, quantity = 100) => ({ id, slot: id === 'snack' ? 'snack' : id, title: id,
  plannedTime: '12:00', plannedItems: [food(id, quantity)] });
const actual = (id, quantity = 50) => ({ id: `actual-${id}`, itemId: id, name: id, quantity,
  unit: 'g', nutritionSnapshot: snapshot(id), reportedAt: at, sourceText: '明确吃完',
  quantitySource: 'reported', correctionHistory: [] });
function materialized(id, quantity = 100) {
  const raw = meal(id, quantity);
  return { ...raw, plannedTimeText: '', plannedItems: raw.plannedItems.map(line => ({ ...line, nutritionSnapshot: snapshot(id) })),
    state: 'reserved', actualEntries: [], reportHistory: [], actualTime: null, actualTimeText: '',
    sourceText: '', completionReportedAt: null };
}
function dose(id, quantity = 5) {
  return { id: `dose-${id}`, itemId: id, unit: 'g', plannedQuantity: quantity, plannedTime: null,
    timingSlot: 'breakfast', requirement: 'daily', scheduled: true, plannedMealId: null,
    nutritionSnapshot: snapshot(id, 0), actualEntries: [{ ...actual(id, quantity), nutritionSnapshot: snapshot(id, 0) }], state: 'completed',
    completionReportedAt: at, reportHistory: [{ reportedAt: at, mode: 'complete', sourceText: '用户打卡' }] };
}
const items = ['breakfast', 'lunch', 'snack', 'dinner', 'creatine', 'beta'].map(id => ({ id,
  ...snapshot(id, ['creatine', 'beta'].includes(id) ? 0 : 100), quantity: 1000, category: 'staple' }));
function incident() {
  const doses = [dose('creatine'), dose('beta', 1.6)];
  return { id: 'daily-food-2026-10-22', date: '2026-10-22', format: 'meals_v1', status: 'reserved',
    title: '每日补给记录', timeZone: 'America/Toronto', notes: '', meals: [], supplementDoses: doses,
    supplementOnly: true, supplementAccounting: 'actual_only', intakeBasis: 'reported_only',
    createdAt: at, updatedAt: at, items: [], accountedDebits: [{ itemId: 'creatine', quantity: 5 }],
    inventoryAccounting: 'settled', accountingIssues: [], allocationAdjustments: {},
    draft: { id: 'daily-food-2026-10-22', date: '2026-10-22', title: '已保存四餐', timeZone: 'America/Toronto',
      notes: '原菜单备注', meals: [meal('breakfast', 100), meal('lunch', 200), meal('snack', 50), meal('dinner', 300)],
      supplementDoses: doses.map(({ actualEntries, reportHistory, state, completionReportedAt, nutritionSnapshot, ...planned }) => planned) } };
}
const kcal = summary => summary.totals.find(total => total.key === 'kcal').value;
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test('legacy supplement-only owner projects all four saved meals with the same canonical IDs and actual supplement facts', () => {
  const source = incident(), before = structuredClone(source);
  const current = projectCurrentDietPlan(freeze(source), freeze(structuredClone(items)));
  assert.equal(current.id, source.id);
  assert.equal(current.status, 'reserved');
  assert.equal(current.title, '已保存四餐');
  assert.equal(current.supplementOnly, false);
  assert.deepEqual(current.meals.map(row => row.id), ['breakfast', 'lunch', 'snack', 'dinner']);
  assert.deepEqual(current.meals.map(row => row.plannedItems[0].id), ['line-breakfast', 'line-lunch', 'line-snack', 'line-dinner']);
  assert.ok(current.meals.every(row => row.actualEntries.length === 0 && row.completionReportedAt === null));
  assert.deepEqual(current.supplementDoses.map(row => row.actualEntries), source.supplementDoses.map(row => row.actualEntries));
  assert.deepEqual(current.accountedDebits, source.accountedDebits);
  assert.deepEqual(source, before);
  const summary = resolveDietDays([source], [], items)[0];
  assert.equal(summary.id, source.id);
  assert.equal(kcal(summary), 650);
  assert.equal(summary.partial, false);
  assert.equal(summary.hasDraft, true);
  assert.equal(summary.plan.meals.length, 4);
});

test('date switching and JSON reload project the same four-meal menu without creating records or altering quantities', () => {
  const source = incident(), tomorrow = { ...structuredClone(source), id: 'tomorrow', date: '2026-10-23',
    draft: { ...structuredClone(source.draft), id: 'tomorrow', date: '2026-10-23' } };
  const state = { plans: [source, tomorrow], items: structuredClone(items) }, before = structuredClone(state);
  const first = resolveDietDays(state.plans, [], state.items);
  const reload = JSON.parse(JSON.stringify(state));
  const next = resolveDietDays(reload.plans, [], reload.items);
  assert.deepEqual(first, next);
  assert.deepEqual(first.map(day => day.date), ['2026-10-23', '2026-10-22']);
  assert.deepEqual(state, before);
});

test('current draft planning changes never overwrite completed meals, reports, corrections or supplement actuals', () => {
  const source = incident();
  source.meals = [materialized('breakfast', 100)];
  Object.assign(source.meals[0], { state: 'completed', actualEntries: [actual('breakfast', 80)],
    actualTime: '09:17', actualTimeText: '九点多', completionReportedAt: at,
    reportHistory: [{ reportedAt: at, mode: 'complete', sourceText: '早餐吃了80克' }] });
  source.draft.meals[0].plannedItems[0].quantity = 999;
  source.draft.meals[0].actualEntries = [actual('breakfast', 999)];
  source.draft.meals[0].state = 'reserved';
  source.draft.meals[0].actualTime = '15:00';
  source.draft.meals[0].plannedItems[0].actualEntries = [actual('breakfast', 999)];
  source.draft.supplementDoses[0].actualEntries = [];
  source.draft.supplementDoses[0].state = 'cancelled';
  source.draft.supplementDoses[0].completionReportedAt = null;
  source.draft.supplementDoses[0].actualTime = '22:00';
  source.draft.status = 'cancelled'; source.draft.accountedDebits = [];
  const current = projectCurrentDietPlan(source, items);
  assert.equal(current.meals[0].plannedItems[0].quantity, 999);
  assert.equal(current.meals[0].actualEntries[0].quantity, 80);
  assert.equal(current.meals[0].state, 'completed');
  assert.equal(current.meals[0].actualTime, '09:17');
  assert.equal(current.meals[0].plannedItems[0].actualEntries, undefined);
  assert.deepEqual(current.meals[0].reportHistory, source.meals[0].reportHistory);
  assert.deepEqual(current.supplementDoses[0].actualEntries, source.supplementDoses[0].actualEntries);
  assert.equal(current.supplementDoses[0].state, 'completed');
  assert.equal(current.supplementDoses[0].completionReportedAt, at);
  assert.equal(current.supplementDoses[0].actualTime, null);
  assert.equal(current.status, 'reserved');
  assert.deepEqual(current.accountedDebits, source.accountedDebits);
  assert.equal(kcal(resolveDietDays([source], [], items)[0]), 630);
});

test('partial reports retain the greater current planned or reported quantity instead of summing them twice', () => {
  const source = incident();
  source.meals = [materialized('lunch', 200)];
  Object.assign(source.meals[0], { state: 'in_progress', actualEntries: [actual('lunch', 250)] });
  assert.equal(kcal(resolveDietDays([source], [], items)[0]), 700);
  source.meals[0].actualEntries[0].quantity = 50;
  assert.equal(kcal(resolveDietDays([source], [], items)[0]), 650);
});

test('removed factual meal and dose entities remain visible with their actual facts; removed unconsumed meals stay removed', () => {
  const source = incident();
  source.supplementOnly = false;
  source.meals = [materialized('breakfast'), materialized('lunch')];
  Object.assign(source.meals[0], { state: 'completed', actualEntries: [actual('breakfast', 80)] });
  source.draft.meals = [];
  source.draft.supplementDoses = [];
  const current = projectCurrentDietPlan(source, items);
  assert.deepEqual(current.meals.map(row => row.id), ['breakfast']);
  assert.deepEqual(current.supplementDoses.map(row => row.id), ['dose-creatine', 'dose-beta']);
  assert.equal(kcal(resolveDietDays([source], [], items)[0]), 80);
});

test('draft snapshots remain frozen before inventory fallback, and replaced food cannot inherit an old line snapshot', () => {
  const source = incident();
  source.meals = [materialized('breakfast')];
  source.draft.meals = [meal('breakfast')];
  source.draft.meals[0].plannedItems[0].nutritionSnapshot = snapshot('saved-breakfast', 123);
  const live = structuredClone(items); live[0].nutrition.kcal = 999;
  assert.equal(kcal(resolveDietDays([source], [], live)[0]), 123);
  delete source.draft.meals[0].plannedItems[0].nutritionSnapshot;
  assert.equal(kcal(resolveDietDays([source], [], live)[0]), 100, 'same stable line uses its saved snapshot');
  source.draft.meals[0].plannedItems[0].itemId = 'new-unlabelled';
  assert.equal(resolveDietDays([source], [], live)[0].partial, true);
  assert.equal(kcal(resolveDietDays([source], [], live)[0]), 0, 'only known zero-energy supplements remain');
});

test('new untracked draft food uses its explicit portion nutrition without requiring inventory ownership', () => {
  const source = incident();
  source.draft.meals = [meal('breakfast')];
  source.draft.meals[0].plannedItems[0] = { id: 'untracked', itemId: null, name: '自制点心', unit: 'g',
    quantity: 50, nutrition: nutrition(200) };
  assert.equal(kcal(resolveDietDays([source], [], items)[0]), 100);
});

test('unchecked routine doses remain plans rather than fabricated actual intake', () => {
  const source = incident();
  source.supplementDoses.push({ ...dose('fish', 1), actualEntries: [], state: 'reserved',
    completionReportedAt: null, reportHistory: [], unit: '粒', nutritionSnapshot: snapshot('fish', 10, '粒') });
  const current = projectCurrentDietPlan(source, items);
  const fish = current.supplementDoses.find(row => row.id === 'dose-fish');
  assert.equal(fish.state, 'reserved');
  assert.deepEqual(fish.actualEntries, []);
  assert.equal(fish.completionReportedAt, null);
  assert.equal(kcal(resolveDietDays([source], [], items)[0]), 660);
});

test('projection does not revive a closed historical record or change canonical identity/accounting metadata', () => {
  const source = incident();
  source.draft.id = 'different-plan'; source.draft.date = '2030-01-01';
  source.foodAccounting = 'actual_only'; source.legacyReservations = [{ itemId: 'food', quantity: 2 }];
  const current = projectCurrentDietPlan(source, items);
  assert.equal(current.id, source.id);
  assert.equal(current.date, source.date);
  assert.equal(current.foodAccounting, source.foodAccounting);
  assert.deepEqual(current.legacyReservations, source.legacyReservations);
  for (const status of ['closed_with_actuals', 'cancelled']) {
    const historical = { ...source, status };
    assert.equal(projectCurrentDietPlan(historical, items), historical);
  }
  const native = { ...source }; delete native.draft;
  assert.equal(projectCurrentDietPlan(native, items), native);
});
