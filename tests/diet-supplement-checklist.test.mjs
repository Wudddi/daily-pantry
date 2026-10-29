import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { dietContext, isDietAction, supplementChecked } from '../lib/diet.mjs';

const NOW = '2026-10-19T12:00:00.000Z';
const LATER = '2026-10-19T13:00:00.000Z';
function fixture() {
  const raw = [
    { id: 'food', name: '分袋主餐', category: 'prepared', quantity: 10, unit: '袋' },
    { id: 'beta', name: 'Beta Alanine', category: 'supplement', quantity: 100, unit: 'g' },
    { id: 'fish', name: '鱼油', category: 'supplement', quantity: 10, unit: '粒' },
    { id: 'magnesium', name: '镁', category: 'supplement', quantity: null, unit: '片' },
  ];
  const items = raw.map(item => validateItem({ ...item, nutrition: { basisAmount: 1, basisUnit: item.unit, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } }, NOW));
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, items, plans: [], operationIds: [], events: [], preferences: [] };
}
function input(doses = []) {
  return { id: 'day', date: '2026-10-19', title: '当日餐次与补给', meals: [{ id: 'lunch', slot: 'lunch', title: '午饭', plannedItems: [{ id: 'main', itemId: 'food', quantity: 2 }] }], supplementDoses: doses };
}
function mutate(state, action, payload = {}, operationId = `${action}-${state.revision}`, at = NOW) { return applyMutation(state, { action, operationId, expectedRevision: state.revision, ...payload }, at); }
function committed(doses = [], state = fixture()) {
  state = mutate(state, 'save_meal_plan_draft', { plan: input(doses) });
  return mutate(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
}
/** A persisted pre-upgrade record whose planned portions were already debited. */
function historicalReserved(doses = []) {
  const state = committed(doses), plan = state.plans[0];
  delete plan.foodAccounting; delete plan.supplementAccounting;
  const allocations = [{ itemId: 'food', quantity: 2 }, ...doses.filter(dose => dose.scheduled ?? (dose.requirement ?? 'daily') === 'daily').map(dose => ({ itemId: dose.itemId, quantity: dose.plannedQuantity }))].filter(line => line.quantity !== null);
  plan.accountedDebits = allocations.map(line => { const item = state.items.find(item => item.id === line.itemId); item.quantity -= line.quantity; return { ...line, name: item.name, unit: item.unit, unknownBalance: false, baselineToken: item.quantityBaselineToken ?? item.confirmedAt ?? 'initial' }; });
  plan.items = structuredClone(plan.accountedDebits);
  return state;
}
const stock = (state, id = 'food') => state.items.find(item => item.id === id);
const dose = (state, id = 'oil') => state.plans[0].supplementDoses.find(dose => dose.id === id);
const oil = (overrides = {}) => ({ id: 'oil', itemId: 'fish', plannedQuantity: 1, ...overrides });
const check = (state, checked, doseId = 'oil', operationId) => mutate(state, 'set_supplement_check', { planId: 'day', doseId, checked }, operationId);

test('default daily doses stay scheduled but saving optional and daily doses never reserves stock', () => {
  const doses = [oil(), ...['optional', 'as_needed', 'label_pending'].map((requirement, index) => ({ id: `candidate-${index}`, itemId: 'beta', plannedQuantity: 3.2, requirement }))];
  const state = committed(doses);
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(stock(state, 'beta').quantity, 100);
  assert.equal(dose(state).scheduled, true);
  assert.equal(dose(state).requirement, 'daily');
  assert.equal(dose(state).timingSlot, 'other');
  for (const candidate of state.plans[0].supplementDoses.slice(1)) assert.equal(candidate.scheduled, false);
  assert.equal(state.plans[0].accountedDebits.some(line => line.itemId === 'beta'), false);
  assert.equal(stock(state).quantity, 10);
});

test('schedule metadata survives normalized drafts, confirmation and compact AI context without turning mg or IU instructions into stock quantities', () => {
  const raw = oil({ requirement: 'optional', scheduled: true, timingSlot: 'dinner', trainingDayOnly: true, instruction: '标签待核；保留原文200mg / 1000IU，不作粒数换算。', plannedTime: '19:00', sourceText: '用户自行决定当天是否服用' });
  let state = mutate(fixture(), 'save_meal_plan_draft', { plan: input([raw]) });
  state = mutate(state, 'save_meal_plan_draft', { plan: { ...state.plans[0], title: '修改标题' } });
  state = mutate(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  const compact = dietContext(state, '2026-10-19').records[0].supplementDoses[0];
  for (const key of ['requirement', 'scheduled', 'timingSlot', 'trainingDayOnly', 'instruction']) assert.equal(compact[key], raw[key]);
  assert.equal(compact.checked, false);
  assert.equal(compact.plannedQuantity, 1);
  assert.equal(stock(state, 'fish').quantity, 10);
  state = mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [oil()] });
  for (const key of ['requirement', 'scheduled', 'timingSlot', 'trainingDayOnly', 'instruction']) assert.equal(dose(state)[key], raw[key]);
});

test('explicit scheduling is retained for every requirement without reserving inventory', () => {
  const state = committed([oil({ requirement: 'label_pending', scheduled: true, instruction: '用户确认1粒，IU未知，未推测。' }), { id: 'daily-opt-out', itemId: 'beta', plannedQuantity: 3.2, requirement: 'daily', scheduled: false }]);
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(stock(state, 'beta').quantity, 100);
  assert.equal(dose(state).requirement, 'label_pending');
  assert.equal(dose(state).scheduled, true);
  assert.equal(dose(state).plannedQuantity, 1);
});

test('a user can select and deselect an optional dose before actual reporting without inventory changes', () => {
  let state = committed([oil({ requirement: 'optional' })]);
  state = mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [oil({ requirement: 'optional', scheduled: true })] });
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(stock(state).quantity, 10);
  assert.equal(supplementChecked(dose(state)), false);
  state = mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [oil({ requirement: 'optional', scheduled: false })] });
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(stock(state).quantity, 10);
  assert.deepEqual(dose(state).actualEntries, []);
});

test('pre-existing doses without metadata retain their daily reservation and do not create a spurious draft or duplicate debit', () => {
  const state = historicalReserved([oil()]);
  for (const key of ['requirement', 'scheduled', 'timingSlot', 'trainingDayOnly', 'instruction']) delete dose(state)[key];
  const before = structuredClone(state);
  assert.strictEqual(mutate(state, 'save_meal_plan_draft', { plan: input([oil()]) }), state);
  const contextDose = dietContext(state, '2026-10-19').records[0].supplementDoses[0];
  assert.equal(contextDose.scheduled, true);
  assert.equal(contextDose.requirement, 'daily');
  assert.equal(contextDose.timingSlot, 'other');
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.deepEqual(state, before);
});

test('separate beta doses retain independent timing IDs and only actual checks affect their shared inventory balance', () => {
  let state = committed(['breakfast', 'pre_workout', 'dinner'].map((timingSlot, index) => ({ id: `beta-${index}`, itemId: 'beta', plannedQuantity: 1.6, timingSlot })));
  assert.equal(stock(state, 'beta').quantity, 100);
  state = check(state, true, 'beta-1');
  assert.equal(stock(state, 'beta').quantity, 98.4);
  assert.equal(supplementChecked(dose(state, 'beta-1')), true);
  assert.equal(supplementChecked(dose(state, 'beta-0')), false);
  assert.equal(supplementChecked(dose(state, 'beta-2')), false);
  assert.equal(dose(state, 'beta-1').actualTime, null);
  state = check(state, false, 'beta-1');
  assert.equal(stock(state, 'beta').quantity, 100);
  assert.equal(dose(state, 'beta-0').state, 'reserved');
  assert.equal(dose(state, 'beta-2').state, 'reserved');
});

test('check retries, uncheck and recheck use one stable actual entry with full correction history and never re-debit food', () => {
  let state = committed([oil()]);
  const mealBefore = structuredClone(state.plans[0].meals);
  const command = { action: 'set_supplement_check', planId: 'day', doseId: 'oil', checked: true, operationId: 'checked-once', expectedRevision: state.revision };
  state = applyMutation(state, command, NOW);
  assert.equal(isDietAction('set_supplement_check'), true);
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.equal(stock(state).quantity, 10);
  assert.equal(dose(state).actualEntries.length, 1);
  const stableId = dose(state).actualEntries[0].id;
  assert.equal(dose(state).actualEntries[0].quantitySource, 'confirmed_plan_portion');
  assert.equal(dose(state).actualTime, null);
  assert.strictEqual(applyMutation(state, command, LATER), state);
  assert.strictEqual(check(state, true, 'oil', 'second-click'), state);
  state = check(state, false);
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(dose(state).actualEntries[0].quantity, 0);
  assert.equal(dose(state).actualEntries[0].correctionHistory[0].quantity, 1);
  assert.equal(dose(state).actualEntries[0].correctionHistory[0].quantitySource, 'confirmed_plan_portion');
  assert.strictEqual(check(state, false, 'oil', 'second-uncheck'), state);
  state = check(state, true);
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.equal(stock(state).quantity, 10);
  assert.deepEqual(state.plans[0].meals, mealBefore);
  assert.equal(dose(state).actualEntries.length, 1);
  assert.equal(dose(state).actualEntries[0].id, stableId);
  assert.deepEqual(dose(state).actualEntries[0].correctionHistory.map(entry => entry.quantity), [1, 0]);
});

test('checking an optional unscheduled dose records only the chosen dose without reserving other optional doses', () => {
  let state = committed([oil({ requirement: 'optional' }), { id: 'beta-as-needed', itemId: 'beta', plannedQuantity: 1.6, requirement: 'as_needed' }]);
  assert.equal(stock(state, 'fish').quantity, 10);
  state = check(state, true);
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.equal(stock(state, 'beta').quantity, 100);
  assert.equal(dose(state).scheduled, false);
  assert.equal(dose(state).actualEntries[0].quantity, 1);
  state = check(state, false);
  assert.equal(stock(state, 'fish').quantity, 10);
});

test('existing positive or unknown actual reports are already checked and never copied by a later checkbox', () => {
  for (const quantity of [2, null]) {
    let state = committed([oil()]);
    state = mutate(state, 'record_supplement_intake', { planId: 'day', doseId: 'oil', mode: 'append', entries: [{ id: 'chat-report', itemId: 'fish', quantity, sourceText: '用户已在聊天报告实服；保留原文' }], actualTime: '12:30' });
    const previous = structuredClone(dose(state));
    assert.equal(supplementChecked(dose(state)), true);
    assert.strictEqual(check(state, true), state);
    assert.deepEqual(dose(state), previous);
  }
});

test('unchecking a dose corrects all its existing actual entries and preserves other dose, meal and original evidence', () => {
  let state = committed([oil(), { id: 'beta-dose', itemId: 'beta', plannedQuantity: 3.2 }]);
  state = check(state, true, 'beta-dose');
  state = mutate(state, 'record_supplement_intake', { planId: 'day', doseId: 'oil', entries: [{ id: 'first', itemId: 'fish', quantity: 1, sourceText: '午饭后1粒' }, { id: 'second', itemId: 'fish', quantity: 1, sourceText: '稍后又补1粒' }], actualTime: '12:30' });
  const other = structuredClone(dose(state, 'beta-dose'));
  const meals = structuredClone(state.plans[0].meals);
  state = check(state, false);
  assert.equal(supplementChecked(dose(state)), false);
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.deepEqual(dose(state).actualEntries.map(entry => entry.quantity), [0, 0]);
  assert.deepEqual(dose(state).actualEntries.map(entry => entry.correctionHistory[0].sourceText), ['午饭后1粒', '稍后又补1粒']);
  assert.equal(dose(state).actualTime, '12:30');
  assert.deepEqual(dose(state, 'beta-dose'), other);
  assert.deepEqual(state.plans[0].meals, meals);
});

test('unknown planned dose stays null through check and undo, with unknown balance remaining usable', () => {
  let state = committed([{ id: 'mag', itemId: 'magnesium', plannedQuantity: null, requirement: 'label_pending', timingSlot: 'bedtime' }]);
  assert.equal(dose(state, 'mag').plannedQuantity, null);
  assert.equal(state.plans[0].accountedDebits.some(line => line.itemId === 'magnesium'), false);
  state = check(state, true, 'mag');
  assert.equal(dose(state, 'mag').actualEntries[0].quantity, null);
  assert.equal(dose(state, 'mag').actualEntries[0].quantitySource, 'unknown');
  assert.equal(dose(state, 'mag').actualTime, null);
  assert.equal(stock(state, 'magnesium').quantity, null);
  assert.equal(stock(state, 'magnesium').status, 'available');
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
  state = check(state, false, 'mag');
  assert.equal(stock(state, 'magnesium').quantity, null);
  assert.equal(stock(state, 'magnesium').status, 'available');
  assert.equal(dose(state, 'mag').actualEntries[0].correctionHistory[0].quantity, null);
  assert.equal(dose(state, 'mag').plannedQuantity, null);
});

test('unknown actual dose against a known balance remains pending, and correction to zero resolves without inventing consumption', () => {
  let state = committed([oil({ plannedQuantity: null })]);
  assert.equal(stock(state, 'fish').quantity, 10);
  state = check(state, true);
  assert.equal(dose(state).actualEntries[0].quantity, null);
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(stock(state, 'fish').status, 'available');
  assert.equal(state.plans[0].inventoryAccounting, 'pending_reconciliation');
  state = check(state, false);
  assert.equal(stock(state, 'fish').quantity, 10);
  assert.equal(stock(state, 'fish').status, 'available');
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
});

test('adding a new dose preserves all earlier dose facts and food debits, and cannot overwrite a reported identity or amount', () => {
  let state = check(committed([oil()]), true);
  const before = structuredClone(dose(state));
  const meals = structuredClone(state.plans[0].meals);
  state = mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [{ id: 'new-beta', itemId: 'beta', plannedQuantity: 3.2, timingSlot: 'pre_workout' }] });
  assert.equal(stock(state).quantity, 10);
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.equal(stock(state, 'beta').quantity, 100);
  assert.deepEqual(dose(state), before);
  assert.deepEqual(state.plans[0].meals, meals);
  assert.throws(() => mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [oil({ plannedQuantity: 2 })] }), { code: 'CONSUMED_MEAL_CONFLICT' });
  assert.throws(() => mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [oil({ itemId: 'magnesium', unit: '片' })] }), { code: 'CONSUMED_MEAL_CONFLICT' });
});

test('the shared revision gate rejects stale checkbox writes and reused operation IDs with changed check states', () => {
  let state = committed([oil()]);
  const originalRevision = state.revision;
  state = check(state, true, 'oil', 'checkbox-business-event');
  assert.throws(() => applyMutation(state, { action: 'set_supplement_check', planId: 'day', doseId: 'oil', checked: false, operationId: 'other-tab-stale', expectedRevision: originalRevision }, LATER), { status: 409, code: 'REVISION_CONFLICT' });
  assert.throws(() => applyMutation(state, { action: 'set_supplement_check', planId: 'day', doseId: 'oil', checked: false, operationId: 'checkbox-business-event', expectedRevision: state.revision }, LATER), { status: 409, code: 'OPERATION_ID_CONFLICT' });
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.equal(dose(state).actualEntries.length, 1);
});

test('supplement checks are independent of the meal lifecycle and malformed check states do not write', () => {
  const state = committed([oil()]);
  for (const status of ['cancelled', 'closed_with_actuals', 'draft']) {
    const changed = structuredClone(state); changed.plans[0].status = status;
    const saved = check(changed, true);
    assert.equal(saved.plans[0].status, status);
    assert.deepEqual(saved.plans[0].meals, changed.plans[0].meals);
    assert.equal(saved.plans[0].supplementDoses[0].actualEntries.length, 1);
    assert.equal(stock(saved, 'fish').quantity, 9);
    assert.equal(stock(saved).quantity, 10);
    assert.deepEqual(changed.plans[0].supplementDoses[0].actualEntries, []);
  }
  assert.throws(() => check(state, 'true'));
  assert.throws(() => check(state, true, 'missing'), { code: 'DOSE_NOT_FOUND' });
});

test('checkbox settlement retains baseline, incompatible-unit and insufficient-stock safeguards atomically', () => {
  let state = check(committed([oil()]), true);
  state = mutate(state, 'set_quantity', { id: 'fish', quantity: 6 }, 'new-count', LATER);
  const unchangedFood = stock(state).quantity;
  state = check(state, false);
  assert.equal(stock(state, 'fish').quantity, 6);
  assert.equal(stock(state, 'fish').status, 'available');
  assert.ok(state.plans[0].accountingIssues.some(issue => issue.code === 'BASELINE_REQUIRES_REVIEW'));
  assert.equal(stock(state).quantity, unchangedFood);
  let empty = fixture(); stock(empty, 'fish').quantity = 0; stock(empty, 'fish').status = 'depleted';
  empty = check(committed([oil({ requirement: 'optional' })], empty), true);
  assert.equal(stock(empty, 'fish').quantity, 0);
  assert.equal(stock(empty, 'fish').status, 'depleted');
  assert.ok(empty.plans[0].accountingIssues.some(issue => issue.code === 'INSUFFICIENT_STOCK'));
  let unitChanged = committed([oil()]);
  unitChanged = mutate(unitChanged, 'upsert', { item: { id: 'fish', unit: 'g' } }, 'changed-unit', LATER);
  unitChanged = check(unitChanged, true);
  assert.equal(dose(unitChanged).actualEntries[0].unit, '粒');
  assert.ok(unitChanged.plans[0].accountingIssues.some(issue => issue.code === 'UNIT_CONFLICT'));
});

test('dose metadata and quantity validation reject malformed inputs and the 32-dose limit without partial writes', () => {
  for (const patch of [{ plannedQuantity: -1 }, { plannedQuantity: 0 }, { plannedQuantity: '1' }, { requirement: 'sometimes' }, { timingSlot: 'anytime' }, { scheduled: 'yes' }, { trainingDayOnly: 'true' }, { instruction: 'x'.repeat(1001) }, { instruction: null }]) assert.throws(() => committed([oil(patch)]));
  let state = committed(Array.from({ length: 32 }, (_, index) => oil({ id: `oil-${index}`, requirement: 'optional' })));
  const before = structuredClone(state);
  assert.throws(() => mutate(state, 'revise_unconsumed_meals', { planId: 'day', confirmed: true, supplementDoses: [oil({ id: 'extra', requirement: 'optional' })] }));
  assert.deepEqual(state, before);
});

test('a Chat time-only supplement report after a page check preserves the exact actual entry and every inventory quantity', () => {
  let state = check(committed([oil()]), true);
  const entries = structuredClone(dose(state).actualEntries);
  const quantities = state.items.map(item => [item.id, item.quantity]);
  const priorHistory = structuredClone(dose(state).reportHistory);
  state = mutate(state, 'record_supplement_intake', { planId: 'day', doseId: 'oil', actualTime: '08:15', sourceText: '刚才网页勾过这一次；实际是早上08:15服用，只补时间。' }, 'chat-time-only', LATER);
  assert.deepEqual(dose(state).actualEntries, entries);
  assert.deepEqual(state.items.map(item => [item.id, item.quantity]), quantities);
  assert.equal(dose(state).actualTime, '08:15');
  assert.equal(dose(state).reportHistory.length, priorHistory.length + 1);
  assert.deepEqual(dose(state).reportHistory.slice(0, -1), priorHistory);
  assert.deepEqual(dose(state).reportHistory.at(-1).entryIds, []);
  assert.equal(dose(state).reportSourceText, '刚才网页勾过这一次；实际是早上08:15服用，只补时间。');
});

test('a Chat whole-dose as-planned report after a page check rejects duplication without increasing revision or changing evidence', () => {
  const state = check(committed([oil()]), true);
  const before = structuredClone(state);
  assert.throws(() => mutate(state, 'record_supplement_intake', { planId: 'day', doseId: 'oil', mode: 'complete', matchesPlannedDose: true, sourceText: '这一次按计划服用了' }, 'chat-cannot-report-same-dose-again', LATER), { status: 409, code: 'ACTUAL_PLAN_DUPLICATION' });
  assert.deepEqual(state, before);
  assert.equal(state.revision, before.revision);
  assert.equal(stock(state, 'fish').quantity, 9);
  assert.equal(dose(state).actualEntries.length, 1);
});

test('a page check after a Chat actual report is a complete no-op even with a fresh page operation ID', () => {
  let state = committed([oil()]);
  state = mutate(state, 'record_supplement_intake', { planId: 'day', doseId: 'oil', mode: 'complete', entries: [{ id: 'chat-actual-dose', itemId: 'fish', quantity: 1, unit: '粒', sourceText: '用户明确报告午饭后服用1粒鱼油' }], actualTime: '12:45' }, 'chat-reported-first', LATER);
  const before = structuredClone(state);
  assert.strictEqual(check(state, true, 'oil', 'page-check-after-chat'), state);
  assert.deepEqual(state, before);
  assert.equal(state.revision, before.revision);
  assert.equal(dose(state).actualEntries[0].id, 'chat-actual-dose');
  assert.equal(dose(state).actualTime, '12:45');
  assert.equal(stock(state, 'fish').quantity, 9);
});

test('Chat corrects the existing checkbox actual ID for a real quantity and time change with an auditable before value and one stock delta', () => {
  let state = check(committed([oil()]), true);
  const original = structuredClone(dose(state).actualEntries[0]);
  const meals = structuredClone(state.plans[0].meals);
  const payload = { planId: 'day', doseId: 'oil', mode: 'correct', entries: [{ id: original.id, itemId: original.itemId, name: original.name, quantity: 2, unit: original.unit, sourceText: '更正刚才网页那一次：实际服用2粒，并非计划1粒，不是额外另一剂。' }], actualTime: '08:15', sourceText: '用户明确更正同一次的实际量和时间' };
  state = mutate(state, 'record_supplement_intake', payload, 'chat-correction-on-checkbox-entry', LATER);
  assert.equal(dose(state).actualEntries.length, 1);
  assert.equal(dose(state).actualEntries[0].id, original.id);
  assert.equal(dose(state).actualEntries[0].quantity, 2);
  assert.equal(dose(state).actualEntries[0].quantitySource, 'reported');
  const { correctionHistory, ...beforeValue } = original;
  assert.deepEqual(dose(state).actualEntries[0].correctionHistory, [...correctionHistory, beforeValue]);
  assert.equal(dose(state).actualTime, '08:15');
  assert.equal(dose(state).plannedQuantity, 1);
  assert.equal(stock(state, 'fish').quantity, 8);
  assert.equal(stock(state).quantity, 10);
  assert.deepEqual(state.plans[0].meals, meals);
  assert.strictEqual(mutate(state, 'record_supplement_intake', payload, 'chat-correction-on-checkbox-entry', LATER), state);
  assert.strictEqual(mutate(state, 'record_supplement_intake', payload, 'chat-same-correction-fresh-op', LATER), state);
});
