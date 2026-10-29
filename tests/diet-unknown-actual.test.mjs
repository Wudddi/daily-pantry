import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDietAction } from '../lib/diet.mjs';

const FIRST = '2026-10-18T16:00:00.000Z';
const LATER = '2026-10-18T17:00:00.000Z';
const WORDS = '午饭之后吃了鱼油，实际粒数未知，不将计划1粒当实服。';
function item(id, quantity, supplement = false) {
  const unit = supplement ? '粒' : '袋';
  return { id, name: id, quantity, unit, category: supplement ? 'supplement' : 'prepared', status: 'available', quantityBaselineToken: 'initial', confirmedAt: FIRST, updatedAt: FIRST, gramsPerUnit: null, nutrition: { basisAmount: 1, basisUnit: unit, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } };
}
function plan(id = 'today', date = '2026-10-18') {
  return { id, date, title: id, meals: [{ id: 'lunch', slot: 'lunch', title: '午饭', plannedItems: [{ id: 'food', itemId: 'food', quantity: 2 }] }], supplementDoses: [{ id: 'oil', itemId: 'fish-oil', plannedQuantity: 1 }] };
}
function apply(state, payload, at = FIRST) {
  const result = applyDietAction(state, payload, at);
  return result.noChange ? state : { ...state, items: result.items, plans: result.plans };
}
function ready(balance = null) {
  let state = { items: [item('food', 10), item('fish-oil', balance, true)], plans: [] };
  state = apply(state, { action: 'save_meal_plan_draft', plan: plan() });
  return apply(state, { action: 'commit_meal_plan', planId: 'today', confirmed: true });
}
const stock = (state, id = 'fish-oil') => state.items.find(item => item.id === id);
const dose = state => state.plans.find(plan => plan.id === 'today').supplementDoses[0];
const unknownEntry = (overrides = {}) => ({ id: 'actual-oil', itemId: 'fish-oil', quantity: null, unit: '粒', sourceText: WORDS, ...overrides });
function report(state, overrides = {}) {
  return apply(state, { action: 'record_supplement_intake', planId: 'today', doseId: 'oil', mode: 'complete', entries: [unknownEntry()], sourceText: '用户确认午饭后服用了鱼油，未报告粒数。', actualTime: '13:20', actualTimeText: '午饭之后', actualMealId: 'lunch', ...overrides });
}
function legacyPending(state) {
  const next = structuredClone(state);
  next.plans[0].inventoryAccounting = 'pending_reconciliation';
  next.plans[0].accountingIssues = [{ code: 'ACTUAL_QUANTITY_UNKNOWN', itemId: 'fish-oil', message: '实际已吃但数量未知，保留原话等待核对。' }];
  next.items.find(item => item.id === 'fish-oil').status = 'pending';
  return next;
}

test('unknown balance and unknown actual dose preserve facts without locking inventory or independent meal completion', () => {
  const before = ready();
  let state = report(before);
  assert.equal(stock(state).quantity, null);
  assert.equal(stock(state).status, 'available');
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
  assert.deepEqual(state.plans[0].accountingIssues, []);
  assert.equal(dose(state).actualEntries[0].quantity, null);
  assert.equal(dose(state).actualEntries[0].quantitySource, 'unknown');
  assert.equal(dose(state).actualEntries[0].sourceText, WORDS);
  assert.equal(dose(state).plannedQuantity, 1);
  assert.equal(dose(state).actualTime, '13:20');
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  state = apply(state, { action: 'record_meal_intake', planId: 'today', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '午饭按计划吃完了' }, LATER);
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
  assert.equal(stock(state).status, 'available');
  assert.equal(stock(state).quantity, null);
  assert.equal(stock(state, 'food').quantity, 8);
});

test('time-only unknown-balance dose keeps original words without inventing an actual quantity', () => {
  const state = report(ready(), { mode: 'append', entries: [] });
  assert.equal(stock(state).quantity, null);
  assert.equal(stock(state).status, 'available');
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
  assert.deepEqual(dose(state).actualEntries, []);
  assert.equal(dose(state).reportSourceText, '用户确认午饭后服用了鱼油，未报告粒数。');
  assert.equal(dose(state).actualTime, '13:20');
});

test('known balance with unknown actual dose remains pending and does not refund or fabricate its quantity', () => {
  const before = ready(10);
  const state = report(before);
  assert.equal(stock(state).quantity, 10);
  assert.equal(stock(state).status, 'available');
  assert.deepEqual(state.items, before.items, 'accounting uncertainty leaves physical inventory unchanged');
  assert.equal(state.plans[0].inventoryAccounting, 'pending_reconciliation');
  assert.ok(state.plans[0].accountingIssues.some(issue => issue.code === 'ACTUAL_QUANTITY_UNKNOWN'));
  assert.deepEqual(state.plans[0].accountedDebits, before.plans[0].accountedDebits);
  assert.equal(dose(state).actualEntries[0].quantity, null);
  assert.equal(dose(state).actualEntries[0].sourceText, WORDS);
});

test('a food shortfall settles independently of an unknown-balance unknown dose without inventing its quantity', () => {
  const before = ready();
  const state = apply(before, { action: 'record_meal_intake', planId: 'today', mealId: 'lunch', mode: 'complete', entries: [{ id: 'extra-food', itemId: 'food', quantity: 20, sourceText: '实际吃了20袋' }], supplements: [{ doseId: 'oil', mode: 'complete', entries: [unknownEntry()] }] });
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
  assert.deepEqual(state.plans[0].accountingIssues, []);
  assert.equal(stock(state, 'food').quantity, 0);
  assert.equal(stock(state, 'food').status, 'depleted');
  assert.equal(state.plans[0].accountedDebits.find(line => line.itemId === 'food').shortfallQuantity, 10);
  assert.ok(state.plans[0].accountingWarnings.some(issue => issue.itemId === 'food' && issue.code === 'STOCK_SHORTFALL_RECORDED'));
  assert.equal(stock(state).quantity, null);
  assert.equal(stock(state).status, 'available');
  assert.equal(state.plans[0].accountedDebits.some(line => line.itemId === 'fish-oil'), false);
  assert.equal(dose(state).actualEntries[0].quantity, null);
});

test('explicit incompatible units still block an unknown dose even when completion removes its target debit', () => {
  for (const mode of ['append', 'complete']) {
    const before = ready();
    const state = report(before, { mode, entries: [unknownEntry({ unit: 'g' })] });
    assert.equal(stock(state).quantity, null);
    assert.equal(stock(state).status, 'available');
    assert.deepEqual(state.items, before.items);
    assert.equal(state.plans[0].inventoryAccounting, 'pending_reconciliation');
    assert.ok(state.plans[0].accountingIssues.some(issue => issue.code === 'UNIT_CONFLICT' && issue.itemId === 'fish-oil'));
    assert.deepEqual(state.plans[0].accountedDebits, before.plans[0].accountedDebits);
    assert.equal(dose(state).actualEntries[0].quantity, null);
    assert.equal(dose(state).actualEntries[0].unit, 'g');
  }
});

test('a changed stock baseline is still blocking when both balances and actual quantity are unknown', () => {
  const before = report(ready(), { entries: [unknownEntry({ quantity: 1, sourceText: '用户明确实际1粒' })] });
  stock(before).quantityBaselineToken = 'new-count';
  const state = report(before, { mode: 'correct' });
  assert.equal(stock(state).quantity, null);
  assert.equal(stock(state).status, 'available');
  assert.deepEqual(state.items, before.items);
  assert.ok(state.plans[0].accountingIssues.some(issue => issue.code === 'BASELINE_REQUIRES_REVIEW'));
  assert.equal(state.plans[0].inventoryAccounting, 'pending_reconciliation');
  assert.deepEqual(state.plans[0].accountedDebits, before.plans[0].accountedDebits);
});

test('an unrelated draft cannot relock a user-restored available item from a legacy soft-only issue', () => {
  const before = ready();
  let state = legacyPending(report(before));
  // Old code left the reservation intact while saving the actual report.
  state.plans[0].accountedDebits = structuredClone(before.plans[0].accountedDebits);
  state.plans[0].items = structuredClone(before.plans[0].items);
  stock(state).status = 'available';
  const priorItems = structuredClone(state.items);
  const priorActual = structuredClone(dose(state));
  state = apply(state, { action: 'save_meal_plan_draft', plan: plan('tomorrow', '2026-10-19') }, LATER);
  assert.deepEqual(state.items, priorItems);
  assert.deepEqual(dose(state), priorActual);
  assert.equal(stock(state).status, 'available');
  state = apply(state, { action: 'commit_meal_plan', planId: 'tomorrow', confirmed: true }, LATER);
  assert.equal(stock(state).status, 'available');
  assert.equal(stock(state).quantity, null);
  assert.equal(state.plans[1].inventoryAccounting, 'settled');
});

test('safe append replay can reconcile a legacy ledger without restoring its independently pending physical status', () => {
  const before = ready();
  let state = legacyPending(report(before));
  state.plans[0].accountedDebits = structuredClone(before.plans[0].accountedDebits);
  state.plans[0].items = structuredClone(before.plans[0].items);
  const priorDose = structuredClone(dose(state));
  const quantities = state.items.map(item => [item.id, item.quantity]);
  const command = { action: 'record_supplement_intake', planId: 'today', doseId: 'oil', mode: 'append', entries: [unknownEntry({ name: priorDose.actualEntries[0].name })] };
  state = apply(state, command, LATER);
  assert.equal(state.plans[0].inventoryAccounting, 'settled');
  assert.deepEqual(state.plans[0].accountingIssues, []);
  assert.equal(stock(state).status, 'pending');
  assert.deepEqual(state.items.map(item => [item.id, item.quantity]), quantities);
  assert.deepEqual(dose(state), priorDose);
  assert.equal(dose(state).actualEntries.length, 1);
  assert.equal(dose(state).reportHistory.length, 1);
  assert.equal(apply(state, command, LATER), state);
});

test('a different plan true issue stays on that ledger without relocking explicitly restored physical inventory', () => {
  for (const code of ['UNIT_CONFLICT', 'BASELINE_REQUIRES_REVIEW', 'INSUFFICIENT_STOCK', 'ATOMIC_ACCOUNTING_PENDING']) {
    let state = legacyPending(report(ready()));
    const other = structuredClone(state.plans[0]);
    other.id = 'other-issue'; other.date = '2026-10-17';
    other.supplementDoses[0].actualEntries = [];
    other.accountingIssues = [{ code, itemId: 'fish-oil', message: '真实账务异常待核' }];
    state.plans.push(other);
    stock(state).status = 'available';
    state = apply(state, { action: 'save_meal_plan_draft', plan: plan('tomorrow', '2026-10-19') }, LATER);
    assert.equal(stock(state).status, 'available', code);
    assert.equal(stock(state).quantity, null, code);
    assert.deepEqual(state.plans.find(plan=>plan.id==='other-issue').accountingIssues,other.accountingIssues);
  }
});

test('saving another draft does not rewrite physical status or the unresolved legacy actual unit conflict', () => {
  let state = legacyPending(report(ready()));
  dose(state).actualEntries[0].unit = 'g';
  stock(state).status = 'available';
  const priorDose = structuredClone(dose(state));
  state = apply(state, { action: 'save_meal_plan_draft', plan: plan('tomorrow', '2026-10-19') }, LATER);
  assert.equal(stock(state).status, 'available');
  assert.equal(stock(state).quantity, null);
  assert.deepEqual(dose(state), priorDose);
});
