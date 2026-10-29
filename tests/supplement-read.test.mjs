import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { planNutritionLines, planNutritionTotals } from '../lib/diet-nutrition.mjs';
import { planningSnapshot, validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-19T12:00:00Z';
function snapshot(known = true) {
  return { name: '鱼油', unit: '粒', gramsPerUnit: null, ingredients: '', supplementFacts: '',
    nutrition: { basisAmount: 1, basisUnit: '粒', kcal: known ? 10 : null, protein: known ? 0 : null,
      carbs: known ? 0 : null, fat: known ? 1 : null, source: known ? 'label' : 'unknown' } };
}
function dose(overrides = {}) {
  return { id: 'fish-oil', itemId: 'fish', plannedQuantity: 1, unit: '粒', nutritionSnapshot: snapshot(), actualEntries: [], state: 'reserved', ...overrides };
}
function plan(id, date, doses, extra = {}) {
  return { id, format: 'meals_v1', title: id, date, timeZone: 'America/Toronto', status: 'reserved', items: [],
    meals: [], supplementDoses: doses, updatedAt: NOW, ...extra };
}
function state(plans = []) {
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, items: [validateItem({ id: 'fish', name: '鱼油',
    category: 'supplement', quantity: null, unit: '粒', status: 'available' }, NOW)],
    plans, preferences: [], events: [], operationIds: [] };
}
const totals = input => Object.fromEntries(planNutritionTotals(input).map(total => [total.key, total]));

test('unscheduled optional and label-pending candidates do not create planned nutrients or missing-supplement alerts', () => {
  const candidates = [
    dose({ id: 'optional', requirement: 'optional', nutritionSnapshot: snapshot(false) }),
    dose({ id: 'needed', requirement: 'as_needed', nutritionSnapshot: snapshot(false) }),
    dose({ id: 'pending', requirement: 'label_pending', plannedQuantity: null, nutritionSnapshot: snapshot(false) }),
    dose({ id: 'daily-off', requirement: 'daily', scheduled: false, nutritionSnapshot: snapshot(false) }),
    dose({ id: 'unknown-dose', requirement: 'daily', plannedQuantity: null, nutritionSnapshot: snapshot(false) }),
  ];
  const input = plan('optional-day', '2026-10-19', candidates), before = structuredClone(input);
  assert.deepEqual(planNutritionLines(input), []);
  for (const total of Object.values(totals(input))) {
    assert.equal(total.value, 0);
    assert.equal(total.supplementMissing, 0);
    assert.equal(total.supplementPartial, false);
  }
  assert.deepEqual(input, before);
});

test('an optional actual dose counts exactly once and an unknown actual stays unknown', () => {
  const actual = { id: 'actual-fish', itemId: 'fish', name: '鱼油', quantity: 2, unit: '粒', nutritionSnapshot: snapshot() };
  for (const state of ['reserved', 'in_progress', 'completed', 'cancelled']) {
    const d = dose({ requirement: 'optional', scheduled: false, actualEntries: [actual], state });
    const input = plan('optional-day', '2026-10-19', [d]);
    assert.equal(planNutritionLines(input).length, 1, state);
    assert.equal(totals(input).kcal.value, 20, state);
    assert.equal(totals(input).fat.value, 2, state);
  }
  const unknown = plan('pending-day', '2026-10-19', [dose({ requirement: 'label_pending', plannedQuantity: null,
    actualEntries: [{ ...actual, quantity: null }], state: 'completed' })]);
  for (const total of Object.values(totals(unknown))) {
    assert.equal(total.value, null);
    assert.equal(total.supplementMissing, 1);
  }
});

test('explicitly scheduled optional doses and legacy doses preserve normal menu nutrition and reported replacement', () => {
  for (const d of [dose(), dose({ requirement: 'daily' }), dose({ requirement: 'optional', scheduled: true }), dose({ requirement: 'label_pending', scheduled: true })]) {
    assert.equal(totals(plan('day', '2026-10-19', [d])).kcal.value, 10);
    const completed = { ...d, state: 'completed', actualEntries: [{ id: 'eaten', itemId: 'fish', quantity: 1, unit: '粒', nutritionSnapshot: snapshot() }] };
    assert.equal(planNutritionLines(plan('day', '2026-10-19', [completed])).length, 1);
    assert.equal(totals(plan('day', '2026-10-19', [completed])).kcal.value, 10);
  }
  const legacyUnknown = totals(plan('legacy', '2026-10-18', [dose({ nutritionSnapshot: snapshot(false) })]));
  assert.equal(legacyUnknown.kcal.value, null);
  assert.equal(legacyUnknown.kcal.supplementMissing, 1);
  const knownPhysicalDoseUnknownLabel = totals(plan('d3', '2026-10-19', [dose({ requirement: 'label_pending', scheduled: true, nutritionSnapshot: snapshot(false) })]));
  assert.equal(knownPhysicalDoseUnknownLabel.kcal.value, null);
  assert.equal(knownPhysicalDoseUnknownLabel.kcal.supplementMissing, 1, 'known one-pill schedule survives an unknown IU or nutrition label');
});

test('schedule reference selects latest eligible date then update, excludes cancelled and legacy-only plans', () => {
  const arranged = dose({ timingSlot: 'dinner', requirement: 'optional', instruction: '需要时随晚餐服用', trainingDayOnly: true });
  const input = state([
    plan('older-date-new-update', '2026-10-17', [arranged], { updatedAt: '2026-10-25T12:00:00Z' }),
    plan('latest-old-update', '2026-10-18', [arranged], { updatedAt: '2026-10-18T12:00:00Z' }),
    plan('chosen', '2026-10-18', [arranged], { updatedAt: '2026-10-18T13:00:00Z' }),
    plan('cancelled', '2026-10-19', [arranged], { status: 'cancelled' }),
    plan('future-legacy', '2026-10-25', [dose()]),
  ]);
  const before = structuredClone(input), reference = planningSnapshot(input, NOW).supplementScheduleReference;
  assert.equal(reference.sourcePlanId, 'chosen');
  assert.equal(reference.date, '2026-10-18');
  assert.equal(reference.doses[0].scheduled, false);
  assert.equal(reference.doses[0].trainingDayOnly, true);
  assert.equal(reference.doses[0].instruction, arranged.instruction);
  assert.equal(reference.truncated, false);
  assert.equal(planningSnapshot(state([plan('old', '2026-10-18', [dose()])]), NOW).supplementScheduleReference, null);
  assert.deepEqual(input, before);
});

test('schedule reference never copies previous-day checkmarks, actual entries, report history or actual times', () => {
  const consumed = dose({ timingSlot: 'post_workout', requirement: 'daily', actualTime: '16:30', actualTimeText: '刚练完喝了',
    actualEntries: [{ id: 'past-intake', quantity: 1, reportedAt: NOW }], state: 'completed', completionReportedAt: NOW,
    reportHistory: [{ sourceText: '旧日已服' }], checked: true, reportSourceText: '原报告', sourceText: '练后1粒' });
  const reference = planningSnapshot(state([plan('yesterday', '2026-10-18', [consumed])]), NOW).supplementScheduleReference;
  assert.equal(reference.doses[0].id, consumed.id);
  assert.equal(reference.doses[0].plannedQuantity, 1);
  assert.equal(reference.doses[0].sourceText, consumed.sourceText);
  for (const key of ['checked', 'actualEntries', 'actualTime', 'actualTimeText', 'state', 'completionReportedAt', 'reportHistory', 'reportSourceText'])
    assert.equal(Object.hasOwn(reference.doses[0], key), false, key);
  assert.match(reference.instructions, /不代表今天已服/);
});

test('schedule reference has explicit truncation and stays within 10000 encoded characters with escaped source text', () => {
  const entries = Array.from({ length: 40 }, (_, index) => dose({ id: `dose-${index}`,
    timingSlot: 'other', requirement: 'label_pending', plannedQuantity: null,
    sourceText: '\u0000'.repeat(6000), instruction: '\u0000'.repeat(1000), plannedTimeText: '\u0000'.repeat(300) }));
  const input = state([plan('long-reference', '2026-10-18', entries)]), before = structuredClone(input);
  const reference = planningSnapshot(input, NOW).supplementScheduleReference;
  assert.ok(JSON.stringify(reference).length <= 10000);
  assert.ok(reference.doses.length <= 32);
  assert.equal(reference.total, 40);
  assert.equal(reference.included, reference.doses.length);
  assert.equal(reference.truncated, true);
  assert.equal(reference.textTruncated, true);
  assert.equal(reference.doses[0].plannedQuantity, null);
  assert.deepEqual(input, before);
});

test('MCP schemas expose nullable schedule metadata and the narrow idempotent checklist action', async () => {
  const source = await readFile(new URL('../lib/diet-mcp.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { dietTools, dietToolActions } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const draft = dietTools.find(tool => tool.name === 'save_food_plan_draft');
  const doses = draft.inputSchema.properties.plan.properties.supplementDoses;
  assert.equal(doses.maxItems, 32);
  assert.deepEqual(doses.items.properties.plannedQuantity.type, ['number', 'null']);
  assert.deepEqual(doses.items.properties.requirement.enum, ['daily', 'optional', 'as_needed', 'label_pending']);
  for (const name of ['timingSlot', 'scheduled', 'instruction', 'trainingDayOnly']) assert.ok(doses.items.properties[name], name);
  const tool = dietTools.find(tool => tool.name === 'set_supplement_check');
  assert.equal(dietToolActions.set_supplement_check, 'set_supplement_check');
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['operationId', 'expectedRevision', 'planId', 'doseId', 'checked']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['checked', 'doseId', 'expectedRevision', 'operationId', 'planId']);
  assert.match(tool.description, /实际服用/);
  assert.match(draft.description, /不能复制旧日已服状态或时间/);
});
