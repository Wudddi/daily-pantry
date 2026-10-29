import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyMenuSettlementSummary } from '../lib/daily-menu-settlement-context.mjs';
import { readPlanningInventory } from '../lib/inventory-planning-read.mjs';
import { readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';
import { applyMutation, validateItem } from '../lib/inventory.mjs';

const AT = '2026-10-27T12:00:00.000Z';
const settlement = (accounting = 'settled') => ({ version: 1, date: '2026-10-26', effectiveDate: '2026-10-26', source: 'automatic_menu', basis: 'auto_planned',
  policyStartDate: '2026-10-26', attemptedAt: '2026-10-27T04:00:00.000Z', settledAt: accounting === 'settled' ? '2026-10-27T04:00:00.000Z' : null,
  lastReconciledAt: '2026-10-27T04:00:00.000Z', plannedFingerprint: 'private-fingerprint', assumedMealIds: ['lunch'],
  plannedMeals: [{ mealId: 'lunch', plannedItems: [{ id: 'food-line', itemId: 'food', quantity: 100, unit: 'g' }] }], accounting });
function fixture() {
  return applyMutation({ schemaVersion: 1, revision: 0, updatedAt: AT, preferences: [], events: [], operationIds: [], plans: [],
    items: [validateItem({ id: 'food', name: '正常食物', category: 'vegetable', quantity: 300, unit: 'g', nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 30, protein: 3, carbs: 5, fat: 0, source: 'label' } }, AT)] },
  { action: 'save_meal_plan_draft', operationId: 'save-existing-plan', expectedRevision: 0, plan: { id: 'day', date: '2026-10-26', title: '既有当天菜单', meals: [{ id: 'lunch', slot: 'lunch', title: '午餐', plannedItems: [{ id: 'food-line', itemId: 'food', quantity: 100, unit: 'g' }] }], supplementDoses: [] } }, AT);
}

test('automatic settlement summaries explicitly distinguish accounting from actual intake and never read personal reminders', () => {
  const plan = { dailySettlement: settlement() };
  Object.defineProperty(plan, 'personalFoodChecks', { get() { throw new Error('private reminder was accessed'); } });
  const result = dailyMenuSettlementSummary(plan);
  assert.equal(result.accounting, 'settled'); assert.equal(result.actualReportsIndependent, true);
  assert.equal(result.assumedMealCount, 1); assert.equal(result.plannedMealCount, 1);
  assert.match(result.instructions, /不证明实际吃完/); assert.match(result.instructions, /不能再次扣旧账/);
  assert.equal(Object.hasOwn(result, 'plannedMeals'), false); assert.equal(Object.hasOwn(result, 'personalFoodChecks'), false);
  assert.equal(dailyMenuSettlementSummary({}), undefined);
});

test('summary size is independent of frozen meal bodies and IDs and unknown metadata does not manufacture success', () => {
  const metadata = settlement('pending_reconciliation');
  metadata.plannedMeals = Array(10000).fill({ secret: 'PRIVATE_FROZEN_BODY'.repeat(1000) });
  metadata.assumedMealIds = Array(10000).fill('PRIVATE_MEAL_ID'.repeat(1000));
  const result = dailyMenuSettlementSummary({ dailySettlement: metadata });
  assert.equal(result.accounting, 'pending_reconciliation'); assert.equal(result.settledAt, null);
  assert.equal(result.assumedMealCount, 10000); assert.equal(result.plannedMealCount, 10000);
  assert(JSON.stringify(result).length < 800); assert(!JSON.stringify(result).includes('PRIVATE_'));
  const unknown = dailyMenuSettlementSummary({ dailySettlement: { source: 'automatic_menu' } });
  assert.equal(unknown.accounting, 'unknown'); assert.equal(unknown.basis, 'unknown'); assert.equal(unknown.attemptedAt, null);
  assert.throws(() => dailyMenuSettlementSummary({ dailySettlement: { source: 'invented' } }), error => error.status === 503);
});

test('compact planning index exposes bounded auto settlement receipts while continuations and legacy plans remain clean', () => {
  const state = fixture(); state.plans[0].dailySettlement = settlement('pending_reconciliation');
  state.plans[0].personalFoodChecks = { secret: 'PRIVATE_PERSONAL_MARK' };
  state.items.push(validateItem({ id: 'other', name: '其他食物', category: 'vegetable', quantity: 10, unit: 'g' }, AT));
  const before = structuredClone(state), first = readPlanningInventory(state, { limit: 1 }, AT);
  assert.equal(first.plans[0].dailySettlement.accounting, 'pending_reconciliation');
  assert.equal(first.plans[0].dailySettlement.source, 'automatic_menu');
  assert(!JSON.stringify(first).includes('PRIVATE_PERSONAL_MARK')); assert(!JSON.stringify(first).includes('personalFoodChecks'));
  assert(JSON.stringify(first).length <= first.charBudget);
  const next = readPlanningInventory(state, { cursor: first.nextCursor, expectedRevision: first.revision }, AT);
  assert.equal(Object.hasOwn(next, 'plans'), false);
  const ordinary = fixture(); assert.equal(Object.hasOwn(readPlanningInventory(ordinary, {}, AT).plans[0], 'dailySettlement'), false);
  assert.deepEqual(state, before);
});

test('focused edits include auto settlement state alongside independent actual facts and accounting uncertainty', () => {
  const state = fixture(); state.plans[0].dailySettlement = settlement('pending_reconciliation');
  state.plans[0].personalFoodChecks = { secret: 'PRIVATE_PERSONAL_MARK' };
  state.plans[0].inventoryAccounting = 'pending_reconciliation'; state.plans[0].accountingIssues = [{ itemId: 'food', code: 'BASELINE_REQUIRES_REVIEW', message: '需核对余额' }];
  const before = structuredClone(state), read = readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] });
  assert.equal(read.plan.dailySettlement.accounting, 'pending_reconciliation');
  assert.equal(read.plan.dailySettlement.actualReportsIndependent, true); assert.equal(read.meals[0].actualEntryCount, 0);
  const food = read.inventoryCandidates.items.find(item => item.id === 'food');
  assert.equal(food.accountingContext.balanceReliable, false); assert.equal(food.quantity, null); assert.equal(food.bookQuantity, 300);
  assert(!JSON.stringify(read).includes('PRIVATE_PERSONAL_MARK')); assert(!JSON.stringify(read).includes('personalFoodChecks'));
  assert(JSON.stringify(read).length <= read.charBudget); assert.deepEqual(state, before);
  const ordinary = readFoodPlanEditContext(fixture(), { planId: 'day' }); assert.equal(Object.hasOwn(ordinary.plan, 'dailySettlement'), false);
});
