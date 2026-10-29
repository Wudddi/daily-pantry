import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { previewFoodBalanceReconciliation } from '../lib/food-balance-reconciliation.mjs';

const AT = '2026-10-27T12:00:00.000Z', DAY = '2026-10-26';
let seq = 0;
const copy = value => structuredClone(value);
const mutate = (state, action, fields, operationId = `reconciliation-test-${++seq}`) => applyMutation(state, { action, ...fields, operationId, expectedRevision: state.revision }, AT);
const balance = (state, id = 'food') => state.items.find(item => item.id === id);
const current = state => state.plans[0];
const report = (state, quantity) => mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'correct', entries: [{ id: 'actual-food', itemId: 'food', quantity, unit: 'g', sourceText: `用户更正实际吃了${quantity}g。` }], sourceText: '明确更正原实际数量。' });

function fixture(name = '西兰花', actualQuantity = 200) {
  let state = { schemaVersion: 1, revision: 0, updatedAt: AT, preferences: ['旧习惯保留'], items: [validateItem({ id: 'food', name, category: 'vegetable', quantity: null, unit: 'g', nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 30, protein: 3, carbs: 5, fat: 0, source: 'label' } }, AT), validateItem({ id: 'other', name: '其他食物', category: 'vegetable', quantity: 500, unit: 'g' }, AT)], plans: [], events: [], operationIds: [], dietHistory: [{ id: 'history', sourceText: '不可覆盖的历史原话' }] };
  state = mutate(state, 'save_meal_plan_draft', { plan: { id: 'day', date: DAY, title: '既有菜单', meals: [{ id: 'dinner', slot: 'dinner', title: '晚餐', plannedItems: [{ id: 'line-food', itemId: 'food', quantity: actualQuantity, unit: 'g' }] }], supplementDoses: [] } });
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'complete', entries: [{ id: 'actual-food', itemId: 'food', quantity: actualQuantity, unit: 'g', sourceText: '用户明确报告实际食用。' }], sourceText: '晚餐吃完。' });
  return state;
}
const reconcile = (state, quantity, extra = {}) => mutate(state, 'reconcile_food_inventory', { itemId: 'food', quantity, confirmed: true, sourceText: '用户明确盘点/计算后的当前余量，已经包含这些旧进食。', planIds: previewFoodBalanceReconciliation(state, 'food', AT).planIds, ...extra });

test('Kensington unknown-balance60g credit is acknowledged at620g without a second subtraction and later corrections settle only their delta', () => {
  const before = fixture('Kensington Sourdough', 60), old = copy(before), oldActual = copy(current(before).meals);
  assert.equal(current(before).accountedDebits[0].unknownBalance, true);
  const preview = previewFoodBalanceReconciliation(before, 'food', AT);
  assert.deepEqual(preview.planIds, ['day']); assert.equal(preview.recordedQuantity, 60); assert.equal(preview.canReconcile, true);
  let state = reconcile(before, 620);
  assert.equal(balance(state).quantity, 620, 'do not subtract the historical60g again');
  assert.equal(current(state).accountedDebits[0].quantity, 60);
  assert.equal(current(state).accountedDebits[0].unknownBalance, false);
  assert.equal(current(state).accountedDebits[0].baselineToken, balance(state).quantityBaselineToken);
  assert.deepEqual(current(state).meals, oldActual);
  assert.deepEqual(state.inventoryReconciliationHistory[0].itemBefore, balance(before));
  assert.deepEqual(state.inventoryReconciliationHistory[0].itemAfter, balance(state));
  assert.deepEqual(state.inventoryReconciliationHistory[0].planCreditBeforeAfter[0].before.accountedDebits, current(before).accountedDebits);
  state = report(state, 80); assert.equal(balance(state).quantity, 600);
  state = report(state, 50); assert.equal(balance(state).quantity, 630);
  assert.deepEqual(before, old);
});

test('broccoli200g saved but uncredited actual can be acknowledged at300g once, preserving original facts and enabling delta refunds', () => {
  const before = fixture('PC Broccoli Florets500g', 200);
  current(before).accountedDebits = []; current(before).items = [];
  current(before).inventoryAccounting = 'pending_reconciliation'; current(before).accountingIssues = [{ itemId: 'food', code: 'ATOMIC_ACCOUNTING_PENDING', message: '同次其他食物待核，200g未扣。' }];
  balance(before).status = 'pending';
  const actual = copy(current(before).meals), other = copy(balance(before, 'other'));
  let state = reconcile(before, 300, { sourceText: '原袋500g完整，实际已吃200g，无其他使用，所以当前300g；这200g已经包含在当前余量中。' });
  assert.equal(balance(state).quantity, 300); assert.equal(balance(state).status, 'available');
  assert.equal(current(state).inventoryAccounting, 'settled'); assert.deepEqual(current(state).accountingIssues, []);
  assert.equal(current(state).accountedDebits[0].quantity, 200); assert.equal(current(state).items[0].quantity, 200);
  assert.deepEqual(current(state).meals, actual); assert.deepEqual(balance(state, 'other'), other);
  assert.equal(state.inventoryReconciliationHistory[0].sourceText, '原袋500g完整，实际已吃200g，无其他使用，所以当前300g；这200g已经包含在当前余量中。');
  state = report(state, 180); assert.equal(balance(state).quantity, 320);
  state = report(state, 180); assert.equal(balance(state).quantity, 320, 'same desired actual does not refund twice');
});

test('other item debits, unknown problems, actuals and historical records remain unchanged', () => {
  const before = fixture();
  const otherLine = { itemId: 'other', name: 'other', quantity: 20, unit: 'g', unknownBalance: false, baselineToken: 'old-token' };
  current(before).accountedDebits.push(copy(otherLine)); current(before).items.push(copy(otherLine));
  current(before).inventoryAccounting = 'pending_reconciliation'; current(before).accountingIssues = [{ itemId: 'food', code: 'ATOMIC_ACCOUNTING_PENDING', message: '目标问题' }, { itemId: 'other', code: 'BASELINE_REQUIRES_REVIEW', message: '其他问题不能顺便解锁' }];
  balance(before, 'other').status = 'pending';
  const old = copy(before), state = reconcile(before, 300);
  assert.deepEqual(balance(state, 'other'), balance(before, 'other'));
  assert.deepEqual(current(state).accountedDebits.find(line => line.itemId === 'other'), otherLine);
  assert.deepEqual(current(state).items.find(line => line.itemId === 'other'), otherLine);
  assert.deepEqual(current(state).accountingIssues, [old.plans[0].accountingIssues[1]]);
  assert.equal(current(state).inventoryAccounting, 'pending_reconciliation');
  for (const key of ['meals', 'supplementDoses', 'status', 'foodAccounting']) assert.deepEqual(current(state)[key], current(before)[key]);
  assert.deepEqual(state.dietHistory, before.dietHistory); assert.deepEqual(state.preferences, before.preferences);
  assert.deepEqual(before, old);
});

test('every related day and credit must be covered and unknown or incompatible facts fail atomically', () => {
  const base = fixture();
  const second = copy(current(base)); second.id = 'earlier'; second.date = '2026-10-25'; second.meals[0].actualEntries[0].id = 'earlier-actual'; base.plans.push(second);
  const preview = previewFoodBalanceReconciliation(base, 'food', AT);
  assert.deepEqual(preview.planIds, ['day', 'earlier']); assert.equal(preview.recordedQuantity, 400);
  const old = copy(base);
  assert.throws(() => reconcile(base, 100, { planIds: ['day'] }), error => error.status === 409 && error.code === 'RECONCILIATION_PLAN_COVERAGE_CONFLICT');
  for (const alter of [
    state => { current(state).meals[0].actualEntries[0].quantity = null; },
    state => { current(state).meals[0].actualEntries[0].unit = '袋'; },
    state => { current(state).accountedDebits[0].unit = '袋'; },
    state => { current(state).date = '2026-10-28'; },
    state => { delete current(state).foodAccounting; current(state).meals[0].state = 'reserved'; },
    state => { current(state).meals[0].actualEntries[0].id = undefined; },
    state => { state.plans[1].meals[0].actualEntries[0].id = 'actual-food'; },
  ]) {
    const invalid = copy(base); alter(invalid); const before = copy(invalid);
    const result = previewFoodBalanceReconciliation(invalid, 'food', AT); assert.equal(result.canReconcile, false); assert(result.errors.length);
    assert.throws(() => reconcile(invalid, 100), error => error.status === 409);
    assert.deepEqual(invalid, before);
  }
  const reconciled = reconcile(base, 100);
  assert(reconciled.plans.every(plan => plan.accountedDebits[0].baselineToken === balance(reconciled).quantityBaselineToken));
  assert.deepEqual(base, old);
});

test('confirmation, source, explicit numbers and allowed fields are required; zero balance remains genuine zero', () => {
  const before = fixture(), old = copy(before);
  for (const change of [{ confirmed: false }, { sourceText: '' }, { sourceText: '字'.repeat(1001) }, { quantity: null }, { quantity: -1 }, { quantity: NaN }, { quantity: '300' }, { unit: '袋' }, { planIds: ['day', 'day'] }]) assert.throws(() => reconcile(before, 300, change));
  assert.deepEqual(before, old);
  const zero = reconcile(before, 0); assert.equal(balance(zero).quantity, 0); assert.equal(balance(zero).status, 'depleted');
  assert.equal(current(zero).accountedDebits[0].quantity, 200);
});

test('durable original-payload retries survive short ledger eviction without restoring old balances or duplicating history', () => {
  let state = fixture();
  const payload = { action: 'reconcile_food_inventory', itemId: 'food', quantity: 300, confirmed: true, sourceText: '用户明确当前300g，包含原200g消耗。', planIds: ['day'], operationId: 'reconcile-once', expectedRevision: state.revision };
  state = applyMutation(state, payload, AT);
  const firstHistory = copy(state.inventoryReconciliationHistory);
  for (let i = 0; i < 1001; i++) state = mutate(state, 'set_quantity', { id: 'food', quantity: 310 + i % 2 });
  assert.equal(state.operationIds.some(op => op.id === payload.operationId), false);
  const old = copy(state);
  assert.strictEqual(applyMutation(state, payload, AT), state);
  assert.strictEqual(applyMutation(state, { ...payload, expectedRevision: state.revision }, AT), state);
  assert.throws(() => applyMutation(state, { ...payload, quantity: 301, expectedRevision: state.revision }, AT), error => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  assert.throws(() => applyMutation(state, { ...payload, operationId: 'stale-new-operation' }, AT), error => error.status === 409 && error.code === 'REVISION_CONFLICT');
  assert.deepEqual(state.inventoryReconciliationHistory, firstHistory); assert.deepEqual(state, old);
});

test('reconciliation history is retained across later calibration and invalid history is never silently repaired', () => {
  const first = reconcile(fixture(), 300), firstAudit = copy(first.inventoryReconciliationHistory[0]);
  const second = reconcile(first, 290);
  assert.deepEqual(second.inventoryReconciliationHistory[0], firstAudit);
  assert.equal(second.inventoryReconciliationHistory.length, 2);
  for (const alter of [state => { state.inventoryReconciliationHistory = {}; }, state => { state.inventoryReconciliationHistory[0].sourceText = ''; }, state => { state.inventoryReconciliationHistory[0].itemAfter.unit = '袋'; }, state => { state.inventoryReconciliationHistory.push(copy(state.inventoryReconciliationHistory[0])); }]) {
    const invalid = copy(second); alter(invalid); const before = copy(invalid);
    assert.throws(() => mutate(invalid, 'set_quantity', { id: 'other', quantity: 400 }), error => error.status === 503 && error.code === 'INVALID_INVENTORY_RECONCILIATION_HISTORY');
    assert.deepEqual(invalid, before);
  }
});

test('automatic menu assumptions cannot be silently erased as if their unreported portions were zero actual', () => {
  const state = fixture();
  current(state).meals[0].state = 'in_progress'; current(state).dailySettlement = { source: 'automatic_menu', date: DAY, plannedMeals: [{ mealId: 'dinner', plannedItems: [{ id: 'line-food', itemId: 'food', quantity: 300, unit: 'g' }] }] };
  const before = copy(state), preview = previewFoodBalanceReconciliation(state, 'food', AT);
  assert.equal(preview.canReconcile, false); assert(preview.errors.some(error => error.code === 'AUTOMATIC_BASIS_REQUIRES_REVIEW'));
  assert.throws(() => reconcile(state, 300), error => error.code === 'AUTOMATIC_BASIS_REQUIRES_REVIEW');
  assert.deepEqual(state, before);
});
