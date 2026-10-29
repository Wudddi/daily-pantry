import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryAccountingContext, inventoryAccountingFields } from '../lib/inventory-accounting-context.mjs';
const item = (id, quantity = 10, status = 'available') => ({ id, quantity, status, unit: 'g' });
const plan = (id, issues, extra = {}) => ({ id, format: 'meals_v1', inventoryAccounting: 'pending_reconciliation', accountingIssues: issues, ...extra });
const issue = (itemId, code = 'ATOMIC_ACCOUNTING_PENDING') => ({ itemId, code, message: '保留原始账务问题' });

test('a shared transaction marks balances uncertain while preserving physical availability and original book quantities', () => {
  const state = { items: [item('banana', 8.5), item('yogurt', 300)], plans: [plan('day', [issue('banana', 'BASELINE_REQUIRES_REVIEW'), issue('yogurt')])] };
  const before = structuredClone(state), context = inventoryAccountingContext(state);
  assert.equal(context.pendingItemCount, 2);
  assert.deepEqual(inventoryAccountingFields(state.items[0], context), { accountingContext: { balanceReliable: false, planIds: ['day'], codes: ['BASELINE_REQUIRES_REVIEW'] }, bookQuantity: 8.5, quantity: null });
  const projected = { ...state.items[1], ...inventoryAccountingFields(state.items[1], context) };
  assert.equal(projected.status, 'available'); assert.equal(projected.quantity, null); assert.equal(projected.bookQuantity, 300);
  assert.deepEqual(state, before);
});

test('legacy physical pending, depleted and archived statuses are never promoted or silently migrated', () => {
  for (const status of ['pending', 'depleted', 'archived']) {
    const current = item('food', status === 'depleted' ? 0 : 10, status);
    const context = inventoryAccountingContext({ items: [current], plans: [plan('day', [issue('food')])] });
    const projected = { ...current, ...inventoryAccountingFields(current, context) };
    assert.equal(projected.status, status); assert.equal(projected.quantity, current.quantity); assert.equal(projected.bookQuantity, current.quantity);
  }
});

test('all pending owners and distinct codes are returned without old sources or actual payloads', () => {
  const current = item('food');
  const state = { items: [current], plans: [plan('b', [issue('food'), issue('food')]), plan('a', [issue('food', 'UNIT_CONFLICT')]), plan('settled', [issue('food')], { inventoryAccounting: 'settled' })] };
  const context = inventoryAccountingContext(state);
  assert.deepEqual(context.byItemId.food, { balanceReliable: false, planIds: ['a', 'b'], codes: ['ATOMIC_ACCOUNTING_PENDING', 'UNIT_CONFLICT'] });
  const copy = inventoryAccountingFields(current, context); copy.accountingContext.planIds.push('changed');
  assert.deepEqual(context.byItemId.food.planIds, ['a', 'b']);
  Object.defineProperty(state.plans[0], 'meals', { get() { throw new Error('full meals should not be read'); } });
  assert.equal(inventoryAccountingContext(state).pendingItemCount, 1);
});

test('unknown actual quantity against unknown balance remains soft while genuine errors stay visible', () => {
  const state = { items: [item('unknown', null), item('known', 10)], plans: [plan('day', [issue('unknown', 'ACTUAL_QUANTITY_UNKNOWN'), issue('known', 'ACTUAL_QUANTITY_UNKNOWN')])] };
  let context = inventoryAccountingContext(state);
  assert.deepEqual(inventoryAccountingFields(state.items[0], context), {});
  assert.equal(context.byItemId.known.balanceReliable, false);
  state.plans[0].accountingIssues.push(issue('unknown', 'UNIT_CONFLICT'));
  context = inventoryAccountingContext(state);
  assert.deepEqual(inventoryAccountingFields(state.items[0], context), { accountingContext: { balanceReliable: false, planIds: ['day'], codes: ['UNIT_CONFLICT'] }, bookQuantity: null });
});

test('ordinary legacy state remains unchanged while malformed pending issues fail visibly', () => {
  const current = item('food');
  const context = inventoryAccountingContext({ items: [current] });
  assert.deepEqual(context, { byItemId: {}, pendingPlanIds: [], pendingItemCount: 0 });
  assert.deepEqual(inventoryAccountingFields(current, context), {});
  for (const state of [{ items: null }, { items: [current], plans: {} }, { items: [current], plans: [plan('day', null)] }, { items: [current], plans: [plan('day', [{ itemId: 'food' }])] }]) {
    assert.throws(() => inventoryAccountingContext(state), error => error.status === 503 && error.code === 'INVENTORY_ACCOUNTING_CONTEXT_UNAVAILABLE');
  }
});
