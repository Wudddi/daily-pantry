import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { applyMutation, planningSnapshot, validateItem } from '../lib/inventory.mjs';
import { readDietRecords, dietContext, getDailySupplementView } from '../lib/diet.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';

const NOW = '2026-10-19T13:00:00Z';
function mutate(state, action, payload) {
  return applyMutation(state, { action, ...payload, expectedRevision: state.revision, operationId: `${action}-${state.revision}` }, NOW);
}
function foodPlan(id, date) {
  return { id, date, title: '已确认三餐', meals: [{ id: 'lunch', slot: 'lunch', title: '午餐',
    plannedItems: [{ id: 'main', itemId: 'food', quantity: 2 }] }], supplementDoses: [] };
}
function fixture() {
  const items = [
    { id: 'food', name: '主餐', category: 'prepared', unit: '袋', quantity: 20, kcal: 100 },
    { id: 'fish', name: '鱼油', category: 'supplement', unit: '粒', quantity: 30, kcal: 10 },
    { id: 'beta', name: 'Beta', category: 'supplement', unit: 'g', quantity: 100, kcal: 0 },
  ].map(({ kcal, ...item }) => validateItem({ ...item, status: 'available', nutrition: {
    basisAmount: 1, basisUnit: item.unit, kcal, protein: 0, carbs: 0, fat: 0, source: 'label',
  } }, NOW));
  let state = { schemaVersion: 1, revision: 0, updatedAt: NOW, items, plans: [], preferences: [], events: [], operationIds: [] };
  const plan = foodPlan('routine-source', '2026-10-18');
  plan.supplementDoses = [
    { id: 'fish-breakfast', itemId: 'fish', plannedQuantity: 1, timingSlot: 'breakfast', instruction: '随早餐', requirement: 'daily' },
    { id: 'beta-pre', itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'pre_workout', requirement: 'daily', trainingDayOnly: true },
  ];
  state = mutate(state, 'save_meal_plan_draft', { plan });
  state = mutate(state, 'commit_meal_plan', { planId: plan.id, confirmed: true });
  return mutate(state, 'save_supplement_routine', { sourcePlanId: plan.id, confirmed: true });
}

test('a supplement-only day remains readable with actual facts but contributes no fake complete menu or calendar day', () => {
  const before = fixture(), after = mutate(before, 'set_daily_supplement_check', { date: '2026-10-20', doseId: 'fish-breakfast', checked: true });
  const owner = after.plans.find(plan => plan.date === '2026-10-20'), snapshot = structuredClone(after);
  assert.equal(owner.supplementOnly, true);
  assert.deepEqual(owner.meals, []);
  assert.deepEqual(resolveDietDays(after.plans).map(row => row.date), ['2026-10-18']);
  const listed = readDietRecords(after, { date: owner.date });
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].supplementOnly, true);
  assert.equal(listed.records[0].supplementDoses[0].actualEntries[0].quantity, 1);
  assert.deepEqual(listed.dailyNutritionSummaries, []);
  const context = dietContext(after, owner.date);
  assert.equal(context.records[0].id, owner.id);
  assert.equal(context.records[0].supplementOnly, true);
  assert.equal(context.records[0].supplementAccounting, 'actual_only');
  assert.equal(context.records[0].supplementDoses[0].checked, true);
  assert.deepEqual(context.dailyNutritionSummaries, []);
  const detail = readDietRecords(after, { recordId: owner.id });
  assert.equal(JSON.parse(detail.text).supplementDoses[0].actualEntries[0].quantity, 1);
  assert.deepEqual(detail.dailyNutritionSummaries, []);
  assert.deepEqual(after, snapshot, 'all read paths remain non-mutating');
});

test('upgrading the same canonical day restores menu summaries without duplicating its already-reported supplement', () => {
  let state = mutate(fixture(), 'set_daily_supplement_check', { date: '2026-10-20', doseId: 'fish-breakfast', checked: true });
  const owner = state.plans.find(plan => plan.date === '2026-10-20'), originalEntry = structuredClone(owner.supplementDoses[0].actualEntries[0]);
  const fishBefore = state.items.find(item => item.id === 'fish').quantity;
  state = mutate(state, 'save_meal_plan_draft', { plan: foodPlan(owner.id, owner.date) });
  assert.equal(resolveDietDays(state.plans, [], state.items).some(row => row.date === owner.date), true, 'the saved menu is immediately visible alongside actual supplements');
  assert.deepEqual(state.plans.find(plan => plan.id === owner.id).supplementDoses[0].actualEntries[0], originalEntry);
  assert.equal(state.items.find(item => item.id === 'food').quantity, 20, 'saving the menu does not reserve food');
  state = mutate(state, 'commit_meal_plan', { planId: owner.id, confirmed: true });
  const row = resolveDietDays(state.plans).find(day => day.date === owner.date);
  assert.ok(row);
  assert.equal(row.plan.id, owner.id);
  assert.equal(row.plan.supplementOnly, false);
  assert.equal(row.totals.find(total => total.key === 'kcal').value, 210);
  assert.equal(state.items.find(item => item.id === 'fish').quantity, fishBefore);
  assert.equal(state.items.find(item => item.id === 'food').quantity, 20, 'adopting the menu does not deduct food');
  assert.deepEqual(row.plan.supplementDoses[0].actualEntries[0], originalEntry);
  assert.equal(state.plans.filter(plan => plan.date === owner.date).length, 1);
});

test('stored routine takes precedence over newer meal schedules and reference contains only arrangement fields', () => {
  const state = fixture(), saved = structuredClone(state);
  const later = structuredClone(state.plans[0]); later.id = 'newer-different-source'; later.date = '2026-10-25';
  later.supplementDoses.push({ ...structuredClone(later.supplementDoses[0]), id: 'extra-dose' });
  state.plans.push(later);
  const reference = planningSnapshot(state, NOW).supplementScheduleReference;
  assert.equal(reference.sourcePlanId, 'routine-source');
  assert.equal(reference.routineSource, 'saved');
  assert.equal(reference.doses.length, 2);
  assert.equal(reference.doses[1].trainingDayOnly, true);
  assert.match(reference.instructions, /没有三餐菜单也可按日期/);
  for (const dose of reference.doses) for (const key of ['actualEntries', 'actualTime', 'checked', 'reportHistory', 'state'])
    assert.equal(Object.hasOwn(dose, key), false, key);
  assert.deepEqual(state.supplementRoutine, saved.supplementRoutine);
  const beforeView = structuredClone(state);
  for (const date of ['2026-10-26', '2026-11-01']) assert.equal(getDailySupplementView(state, date).virtual, true);
  assert.deepEqual(state, beforeView);
});

test('routine projection stays bounded and explicitly truncated even when its source plan is no longer available', () => {
  const state = fixture();
  state.supplementRoutine.sourcePlanId = 'source-not-in-returned-plans';
  state.supplementRoutine.supplementDoses = Array.from({ length: 40 }, (_, index) => ({
    ...state.supplementRoutine.supplementDoses[0], id: `dose-${index}`, sourceText: '\u0000'.repeat(6000), instruction: '\u0000'.repeat(1000),
  }));
  const before = structuredClone(state), reference = planningSnapshot(state, NOW).supplementScheduleReference;
  assert.equal(reference.date, null);
  assert.equal(reference.routineSource, 'saved');
  assert.ok(JSON.stringify(reference).length <= 10000);
  assert.ok(reference.doses.length <= 32);
  assert.equal(reference.total, 40);
  assert.equal(reference.truncated, true);
  assert.equal(reference.textTruncated, true);
  assert.deepEqual(state, before);
});

test('pure supplement records do not replace an independently valid historical menu for the same date', () => {
  const state = mutate(fixture(), 'set_daily_supplement_check', { date: '2026-10-20', doseId: 'fish-breakfast', checked: true });
  const historical = { id: 'old-menu', date: '2026-10-20', confirmation: 'final_plan', meals: [], supplements: [], nutrition: { kcal: 1900, source: 'estimate' } };
  const rows = resolveDietDays(state.plans, [historical]);
  const day = rows.find(row => row.date === '2026-10-20');
  assert.equal(day.recordType, 'diet_history');
  assert.equal(day.id, 'old-menu');
  assert.equal(day.totals.find(total => total.key === 'kcal').value, 1900);
});

test('large supplement-only records retain their identity in bounded list and context fallbacks', () => {
  const state = mutate(fixture(), 'set_daily_supplement_check', { date: '2026-10-20', doseId: 'fish-breakfast', checked: true });
  const owner = state.plans.find(plan => plan.date === '2026-10-20'), original = owner.supplementDoses[0];
  owner.supplementDoses = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(original), id: `large-dose-${index}`,
    instruction: '\u0000'.repeat(1000), actualEntries: original.actualEntries.map(entry => ({ ...entry, id: `actual-${index}`, sourceText: '\u0000'.repeat(9000) })) }));
  const before = structuredClone(state), listed = readDietRecords(state, { date: owner.date }), context = dietContext(state, owner.date);
  assert.equal(listed.records[0].recordTruncated, true);
  assert.equal(listed.records[0].supplementOnly, true);
  assert.equal(listed.records[0].supplementAccounting, 'actual_only');
  assert.equal(context.records[0].detailRequired, true);
  assert.equal(context.records[0].supplementOnly, true);
  assert.equal(context.records[0].supplementAccounting, 'actual_only');
  assert.deepEqual(context.dailyNutritionSummaries, []);
  assert.ok(JSON.stringify(listed).length <= 63000);
  assert.ok(JSON.stringify(context).length <= 24000);
  assert.deepEqual(state, before);
});

test('MCP tools support routine save and date-based checks without requiring a meal plan ID', async () => {
  const source = await readFile(new URL('../lib/diet-mcp.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { dietTools, dietToolActions } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const check = dietTools.find(tool => tool.name === 'set_daily_supplement_check');
  assert.equal(dietToolActions[check.name], 'set_daily_supplement_check');
  assert.deepEqual(check.inputSchema.required, ['operationId', 'expectedRevision', 'date', 'doseId', 'checked']);
  assert.equal(check.inputSchema.additionalProperties, false);
  assert.equal(check.inputSchema.properties.planId, undefined);
  assert.equal(new RegExp(check.inputSchema.properties.date.pattern).test('2026-10-20'), true);
  const save = dietTools.find(tool => tool.name === 'save_supplement_routine');
  assert.equal(dietToolActions[save.name], 'save_supplement_routine');
  assert.deepEqual(save.inputSchema.required, ['operationId', 'expectedRevision', 'sourcePlanId', 'confirmed']);
  assert.equal(save.inputSchema.properties.confirmed.const, true);
  assert.match(dietTools.find(tool => tool.name === 'read_diet_records').description, /canonical planId/);
  const draft = dietTools.find(tool => tool.name === 'save_food_plan_draft').description;
  assert.match(draft, /canonical planId/);
  assert.match(draft, /保存后当天立即可见/);
  assert.match(draft, /菜单保存、采用、修改均不预留或扣库存/);
});
