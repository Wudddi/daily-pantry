import test from 'node:test';
import assert from 'node:assert/strict';
import { planNutritionLines, planNutritionTotals, transferredFoodRemainders } from '../lib/diet-nutrition.mjs';
import { mealNutritionView } from '../lib/meal-nutrition-view.mjs';
import { dailyFoodRollup } from '../lib/daily-food-rollup.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
import { intakeEntryId } from '../lib/intake-draft.mjs';

const nutrition = kcal => ({ basisAmount: 100, basisUnit: 'g', kcal, protein: 10, carbs: 20, fat: 5, source: 'label' });
const snapshot = kcal => ({ name: '测试酸奶', unit: 'g', gramsPerUnit: null, ingredients: '', supplementFacts: '', nutrition: nutrition(kcal) });
const line = (id, quantity, kcal = 200) => ({ id, itemId: 'yogurt', quantity, unit: 'g', sourceText: '本机合成记录', nutritionSnapshot: snapshot(kcal) });
const original = line('breakfast-yogurt', 100);
const transfer = line('ui-transfer-for-test', 80, 400);
const actual = (id, quantity, fields = {}) => ({ ...line(id, quantity), sourceText: '原实际记录', ...fields });
const meal = (patch = {}) => ({ id: 'breakfast', slot: 'breakfast', title: '早餐', state: 'completed', plannedItems: [original, transfer],
  actualEntries: [actual('chat-breakfast-yogurt', 50)], actualTime: '08:30', completionReportedAt: '2026-10-26T13:00:00Z',
  reportHistory: [{ sourceText: '原完成报告' }], ...patch });
const plan = (input, patch = {}) => ({ id: 'daily-test', format: 'meals_v1', date: '2026-10-26', status: 'reserved', title: '本机测试菜单',
  meals: [input], supplementDoses: [], accountedDebits: [{ itemId: 'yogurt', quantity: 50, unit: 'g' }], ...patch });
const kcal = p => planNutritionTotals(p).find(total => total.key === 'kcal').value;

test('finished meal adds explicit incoming uneaten food without reviving its old untouched plan', () => {
  const input = meal(), p = plan(input), before = structuredClone(p);
  assert.equal(kcal(p), 420); // old actual 50g*2 plus explicit incoming 80g*4; no old remaining 50g.
  assert.deepEqual(transferredFoodRemainders(p.id, input).map(row => [row.id, row.quantity]), [[transfer.id, 80]]);
  assert.deepEqual(planNutritionLines(p).map(row => [row.lineId, row.quantity, row.origin]), [['chat-breakfast-yogurt', 50, 'reported'], [transfer.id, 80, 'planned']]);
  assert.deepEqual(p, before);
});

test('linked incoming actual is deducted from that exact line once using its frozen recipe', () => {
  const input = meal({ actualEntries: [actual('old', 50), actual('incoming', 30, { intakeLineId: transfer.id, nutritionSnapshot: snapshot(400) })] });
  assert.equal(transferredFoodRemainders('daily-test', input)[0].quantity, 50);
  assert.equal(kcal(plan(input)), 420);
  assert.equal(kcal(plan(meal({ ...input, actualEntries: [actual('old', 50), actual('incoming', 80, { intakeLineId: transfer.id, nutritionSnapshot: snapshot(400) })] }))), 420);
});

test('stable UI and legacy planned actual IDs associate the incoming line without relying on line order', () => {
  for (const prefix of ['ui-intake-', 'planned-']) {
    const id = intakeEntryId('daily-test', 'breakfast', transfer.id).replace('ui-intake-', prefix);
    const input = meal({ plannedItems: [transfer, original], actualEntries: [actual('old', 50), actual(id, 20, { nutritionSnapshot: snapshot(400) })] });
    assert.equal(transferredFoodRemainders('daily-test', input)[0].quantity, 60);
    assert.equal(kcal(plan(input)), 420);
  }
});

test('old same-SKU unanchored actual stays with the unique original rather than eating newly incoming food', () => {
  const input = meal({ plannedItems: [transfer, original] });
  assert.equal(transferredFoodRemainders('daily-test', input)[0].quantity, 80);
  assert.equal(kcal(plan(input)), 420);
});

test('several incoming recipes with an unanchored actual retain unknown allocation instead of assuming both remain', () => {
  const input = meal({ plannedItems: [transfer, line('ui-transfer-second', 40, 300)], actualEntries: [actual('unknown-line-link', 20)] });
  assert.deepEqual(transferredFoodRemainders('daily-test', input).map(row => row.quantity), [null, null]);
  const total = planNutritionTotals(plan(input))[0];
  assert.equal(total.value, 40); assert.equal(total.partial, true); assert.equal(total.missing, 2);
});

test('unknown or incompatible incoming actual cannot become a guessed known remaining quantity', () => {
  for (const fields of [{ quantity: null }, { quantity: 1, unit: '袋' }]) {
    const input = meal({ actualEntries: [actual('old', 50), actual('new', 20, { intakeLineId: transfer.id, ...fields })] });
    assert.equal(transferredFoodRemainders('daily-test', input)[0].quantity, null);
    assert.equal(planNutritionTotals(plan(input))[0].partial, true);
  }
});

test('cancelled or explicitly ended days retain actual-only nutrition and a no-content completion preserves old fallback', () => {
  const input = meal();
  assert.equal(kcal(plan(input, { status: 'cancelled' })), 100);
  assert.equal(kcal(plan(input, { status: 'closed_with_actuals' })), 100);
  assert.equal(kcal(plan(meal({ state: 'cancelled' }))), 100);
  assert.equal(kcal(plan(meal({ actualEntries: [] }))), 520);
});

test('per-meal details, full-day rollup and calendar totals share the same mixed actual-plus-incoming contribution', () => {
  const input = meal(), p = plan(input), before = structuredClone(p);
  const view = mealNutritionView(input, { planId: p.id, planStatus: p.status });
  assert.equal(view.mode, 'partial'); assert.equal(view.basisLabel, '已报告＋重新分配');
  assert.equal(view.totals[0].value, 420); assert.deepEqual(view.remainingRows.map(row => [row.id, row.quantity]), [[transfer.id, 80]]);
  assert.equal(view.actualRows[0].quantity, 50);
  assert.deepEqual(view.totals, planNutritionTotals(p));
  assert.equal(dailyFoodRollup(p).totals[0].value, 420);
  assert.equal(resolveDietDays([p], [])[0].totals[0].value, 420);
  assert.deepEqual(p, before);
});

test('incoming zero and fully consumed allocations disappear from remaining but original actuals remain', () => {
  const input = meal({ plannedItems: [original, line('ui-transfer-zero', 0, 400), transfer],
    actualEntries: [actual('old', 50), actual('incoming', 80, { intakeLineId: transfer.id, nutritionSnapshot: snapshot(400) })] });
  assert.deepEqual(transferredFoodRemainders('daily-test', input), []);
  const view = mealNutritionView(input, { planId: 'daily-test' });
  assert.equal(view.mode, 'actual'); assert.equal(view.totals[0].value, 420); assert.equal(view.remainingRows.length, 0);
});
