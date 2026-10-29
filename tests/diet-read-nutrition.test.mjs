import test from 'node:test';
import assert from 'node:assert/strict';
import { readDietRecords, dietContext } from '../lib/diet.mjs';

const DAY = '2026-10-18';
const fullNutrition = { kcal: 1943.2067, protein: 146.524, carbs: 242.295, fat: 51.692, source: 'estimate' };
function plan(id = 'live', day = DAY) {
  return { id, format: 'meals_v1', date: day, title: '最终全天菜单', status: 'reserved', intakeBasis: 'confirmed_daily_plan',
    inventoryAccounting: 'settled', accountingIssues: [], supplementDoses: [],
    meals: [{ id: 'lunch', slot: 'lunch', title: '全天备餐', state: 'reserved', plannedTime: null, actualTime: null, completionReportedAt: null, actualEntries: [],
      plannedItems: [{ id: 'food', itemId: null, name: '完整主餐', quantity: 1, unit: '份', nutritionSnapshot: { name: '完整主餐', unit: '份', gramsPerUnit: null,
        nutrition: { basisAmount: 1, basisUnit: '份', kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } } }] }],
    createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z' };
}
function history(id = 'archive', day = DAY) {
  return { id, date: day, title: '原聊天终稿', confirmation: 'final_plan', recordType: 'diet_history', inventoryEffect: 'none',
    nutrition: { ...fullNutrition }, supplements: [],
    meals: [{ id: 'lunch', name: '全天备餐', status: 'planned', items: [{ id: 'food', name: '完整主餐', quantity: 1, plannedQuantity: 1, actualQuantity: null,
      quantitySource: 'unknown', unit: '份', nutrition: { kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } }] }] };
}
function state(plans = [plan()], dietHistory = [history()]) { return { items: [], plans, dietHistory }; }
const kcal = summary => summary.totals.find(total => total.key === 'kcal');

test('MCP list, plan detail and today context share matched full-day nutrition without changing saved records', () => {
  const s = state(); const original = JSON.stringify(s);
  const listed = readDietRecords(s, { date: DAY }); const byId = readDietRecords(s, { planId: 'live' }); const context = dietContext(s, DAY);
  assert.equal(listed.records.length, 2); assert.equal(listed.dailyNutritionSummaries.length, 1);
  const summary = listed.dailyNutritionSummaries[0];
  assert.equal(summary.recordId, 'live'); assert.equal(summary.planId, 'live'); assert.equal(summary.historyId, 'archive');
  assert.equal(summary.basis, 'confirmed_plan'); assert.equal(summary.partial, false);
  assert.equal(kcal(summary).value, fullNutrition.kcal); assert.equal(kcal(summary).source, 'matched_history_total'); assert.equal(kcal(summary).estimated, true);
  assert.deepEqual(byId.dailyNutritionSummaries, listed.dailyNutritionSummaries); assert.deepEqual(context.dailyNutritionSummaries, listed.dailyNutritionSummaries);
  assert.equal(listed.records.find(record => record.id === 'live').meals[0].plannedItems[0].nutritionSnapshot.nutrition.kcal, null);
  assert.equal(summary.record, undefined); assert.equal(summary.plan, undefined); assert.equal(summary.history, undefined);
  assert.equal(JSON.stringify(s), original);
});

test('unknown or changed portions stay partial rather than receiving a mismatched historical full-day value', () => {
  const p = plan(); const unknown = structuredClone(p.meals[0].plannedItems[0]); unknown.id = 'unknown'; unknown.name = '未补营养的常备食品';
  p.meals[0].plannedItems[0].nutritionSnapshot.nutrition = { basisAmount: 1, basisUnit: '份', kcal: 943, protein: null, carbs: null, fat: null, source: 'estimate' };
  p.meals[0].plannedItems.push(unknown);
  const result = readDietRecords(state([p]), { date: DAY }).dailyNutritionSummaries[0];
  assert.equal(result.partial, true); assert.equal(kcal(result).value, 943); assert.equal(kcal(result).partial, true);
  assert.equal(result.historyId, null); assert.ok(result.issues.some(issue => issue.code === 'HISTORY_MENU_MISMATCH'));
  const changed = plan(); changed.meals[0].plannedItems[0].quantity = 2;
  const mismatch = readDietRecords(state([changed]), { planId: changed.id }).dailyNutritionSummaries[0];
  assert.equal(kcal(mismatch).value, null); assert.equal(kcal(mismatch).partial, true);
});

test('summary scope follows each list page, date range and exact record lookup', () => {
  const s = state([plan('oct18'), plan('oct17', '2026-10-17'), plan('sep30', '2026-09-30')], []);
  const first = readDietRecords(s, { limit: 1 }); assert.deepEqual(first.dailyNutritionSummaries.map(summary => summary.date), [DAY]);
  const next = readDietRecords(s, { limit: 1, cursor: first.nextCursor }); assert.deepEqual(next.dailyNutritionSummaries.map(summary => summary.date), ['2026-10-17']);
  const range = readDietRecords(s, { from: '2026-10-17', to: DAY }); assert.deepEqual(range.dailyNutritionSummaries.map(summary => summary.date), [DAY, '2026-10-17']);
  const lookup = readDietRecords(s, { recordId: 'sep30' }); assert.deepEqual(lookup.dailyNutritionSummaries.map(summary => summary.date), ['2026-09-30']);
  assert.deepEqual(readDietRecords(s, { date: '2026-01-01' }).dailyNutritionSummaries, []);
});

test('unknown supplement nutrition preserves the resolver flags without inventing food gaps or zero calories', () => {
  const p = plan(); p.meals = [];
  p.supplementDoses = [{ id: 'dose', itemId: 'supplement', plannedQuantity: 1, unit: '粒', state: 'reserved', actualEntries: [],
    nutritionSnapshot: { name: '未知宏量补给', unit: '粒', nutrition: { basisAmount: 1, basisUnit: '粒', kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } } }];
  const result = readDietRecords(state([p], [])).dailyNutritionSummaries[0];
  assert.equal(result.partial, false); assert.equal(result.supplementPartial, true);
  assert.equal(kcal(result).value, null); assert.equal(kcal(result).partial, false); assert.equal(kcal(result).missing, 0); assert.equal(kcal(result).supplementMissing, 1);
});

test('daily metadata does not enter lossless JSON fragments and every encoded response stays within its budget', () => {
  const s = state(); s.plans[0].notes = '\u0000'.repeat(16000) + '保留原话'; const original = JSON.stringify(s.plans[0]);
  let offset = 0, encoded = '';
  do {
    const part = readDietRecords(s, { recordId: 'live', offset }); assert.ok(JSON.stringify({ available: true, revision: 88, ...part }).length <= 64000);
    assert.equal(kcal(part.dailyNutritionSummaries[0]).value, fullNutrition.kcal); encoded += part.text; offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(encoded, original); assert.equal(JSON.parse(encoded).dailyNutritionSummaries, undefined);
  const listed = readDietRecords(s, { planId: 'live' }); assert.equal(listed.records[0].recordTruncated, true); assert.ok(JSON.stringify({ available: true, revision: 88, ...listed }).length <= 64000);
  assert.equal(kcal(listed.dailyNutritionSummaries[0]).value, fullNutrition.kcal);
  const many = state(Array.from({ length: 40 }, (_, i) => plan(`day-${i}`, `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`)), []);
  const page = readDietRecords(many, { limit: 50 }); assert.ok(JSON.stringify(page).length <= 64000);
  assert.ok(JSON.stringify({ dailyNutritionSummaries: page.dailyNutritionSummaries, dailyNutritionSummaryTotal: page.dailyNutritionSummaryTotal, dailyNutritionSummariesTruncated: page.dailyNutritionSummariesTruncated }).length <= 8000);
  assert.equal(page.dailyNutritionSummariesTruncated, true); assert.ok(page.dailyNutritionSummaryTotal > page.dailyNutritionSummaries.length);
  const large = state(); large.plans[0].meals[0].plannedItems = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(plan().meals[0].plannedItems[0]), id: `food-${i}`, name: '长食品名称'.repeat(35) }));
  const context = dietContext(large, DAY); assert.ok(JSON.stringify(context).length <= 24000); assert.equal(context.truncated, true);
  assert.equal(context.records[0].recordId, 'live'); assert.equal(context.records[0].detailRequired, true); assert.ok(context.dailyNutritionSummaries.length > 0);
});
