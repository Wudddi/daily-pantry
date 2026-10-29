import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-18T01:00:00.000Z';
const LATER = '2026-10-18T02:00:00.000Z';
function fixture() {
  const main = validateItem({ id: 'main', name: '分袋备餐', category: 'prepared', quantity: 10, unit: '袋', ingredients: '主餐配方原文', nutrition: { basisAmount: 1, basisUnit: '袋', kcal: 100, protein: 10, carbs: 10, fat: 3, source: 'label', sourceText: '标签每袋数据' } }, NOW);
  const fish = validateItem({ id: 'fish', name: '测试补给', category: 'supplement', quantity: 10, unit: '粒', supplementFacts: '每粒：测试成分200mg，非整粒重量', nutrition: { basisAmount: 1, basisUnit: '粒', kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } }, NOW);
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, items: [main, fish], plans: [], events: [], operationIds: [], preferences: ['保留全天库存依据'], futureExtension: { mustSurvive: true } };
}
function meal(id, quantity) { return { id, slot: id === 'lunch' ? 'lunch' : 'dinner', title: id, plannedTime: id === 'lunch' ? '12:00' : '18:00', plannedItems: [{ id: `${id}-main`, itemId: 'main', quantity }] }; }
function plan() { return { id: 'day-one', date: '2026-10-17', title: '分餐最终版', meals: [meal('lunch', 2), meal('dinner', 3)], supplementDoses: [{ id: 'fish-dose', itemId: 'fish', plannedQuantity: 1, plannedMealId: 'lunch' }] }; }
function mutate(state, action, payload = {}, operationId = `${action}-${state.revision}`, at = NOW) { return applyMutation(state, { action, operationId, expectedRevision: state.revision, ...payload }, at); }
const quantity = (state, id = 'main') => state.items.find((item) => item.id === id).quantity;
function committed() { const draft = mutate(fixture(), 'save_meal_plan_draft', { plan: plan() }); return mutate(draft, 'commit_meal_plan', { planId: 'day-one', confirmed: true }); }

test('diet actions use the same inventory revision, retry ledger, event history and persistent state extensions', () => {
  const original = fixture();
  const draft = mutate(original, 'save_meal_plan_draft', { plan: plan() });
  assert.equal(quantity(draft), 10);
  assert.equal(draft.revision, 1);
  assert.equal(draft.events.at(-1).action, 'save_meal_plan_draft');
  assert.equal(draft.futureExtension.mustSurvive, true);
  const payload = { action: 'commit_meal_plan', planId: 'day-one', confirmed: true, operationId: 'finalize-once', expectedRevision: draft.revision };
  const after = applyMutation(draft, payload, NOW);
  assert.equal(quantity(after), 10);
  assert.equal(quantity(after, 'fish'), 10);
  assert.equal(after.revision, 2);
  assert.equal(after.plans[0].format, 'meals_v1');
  assert.equal(after.plans[0].meals[0].plannedItems[0].nutritionSnapshot.ingredients, '主餐配方原文');
  assert.equal(after.plans[0].supplementDoses[0].nutritionSnapshot.supplementFacts, fixture().items[1].supplementFacts);
  assert.strictEqual(applyMutation(after, payload, LATER), after);
  assert.strictEqual(mutate(after, 'commit_meal_plan', { planId: 'day-one', confirmed: true }, 'new-id-same-final'), after);
  assert.throws(() => applyMutation(after, { ...payload, operationId: 'different-stale-id' }, LATER), (error) => error.status === 409 && error.code === 'REVISION_CONFLICT');
  assert.equal(quantity(original), 10);
});

test('legacy cancellation of a new meal plan delegates safely, refunds once and preserves the new format', () => {
  const state = committed();
  const cancelled = mutate(state, 'cancel_plan', { planId: 'day-one', confirmed: true });
  assert.equal(quantity(cancelled), 10);
  assert.equal(quantity(cancelled, 'fish'), 10);
  assert.equal(cancelled.plans[0].status, 'cancelled');
  assert.equal(cancelled.events.at(-1).action, 'cancel_meal_plan');
  assert.strictEqual(mutate(cancelled, 'cancel_plan', { planId: 'day-one', confirmed: true }), cancelled);
  assert.equal(cancelled.futureExtension.mustSurvive, true);
});

test('old full-day cancellation cannot refund reported actuals; cancelling remaining reservations preserves them', () => {
  const state = committed();
  const actual = mutate(state, 'record_meal_intake', { planId: 'day-one', mealId: 'lunch', mode: 'complete', entries: [{ id: 'lunch-actual', itemId: 'main', quantity: 1, sourceText: '用户实际午餐只吃一袋' }] });
  assert.equal(quantity(actual), 9);
  assert.equal(actual.plans[0].meals[0].actualTime, null);
  assert.equal(actual.plans[0].meals[0].plannedTime, '12:00');
  assert.throws(() => mutate(actual, 'cancel_plan', { planId: 'day-one', confirmed: true }), (error) => error.code === 'PLAN_HAS_ACTUALS');
  const cancelled = mutate(actual, 'cancel_remaining_meals', { planId: 'day-one', confirmed: true });
  assert.equal(quantity(cancelled), 9);
  assert.equal(quantity(cancelled, 'fish'), 10);
  assert.equal(cancelled.plans[0].status, 'closed_with_actuals');
  assert.equal(cancelled.plans[0].meals[0].actualEntries[0].sourceText, '用户实际午餐只吃一袋');
  assert.equal(cancelled.futureExtension.mustSurvive, true);
});

test('actual intake retries distinguish the same report from a changed report using the same operation ID', () => {
  const state = committed();
  const payload = { action: 'record_meal_intake', planId: 'day-one', mealId: 'lunch', mode: 'complete', entries: [{ id: 'reported-once', itemId: 'main', quantity: 1, sourceText: '实际一袋' }], operationId: 'meal-report-identity', expectedRevision: state.revision };
  const after = applyMutation(state, payload, NOW);
  assert.strictEqual(applyMutation(after, { ...payload, expectedRevision: after.revision }, LATER), after);
  assert.throws(() => applyMutation(after, { ...payload, entries: [{ ...payload.entries[0], quantity: 2, sourceText: '现在改成两袋' }] }, LATER), (error) => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  assert.equal(quantity(after), 9);
  assert.equal(after.plans[0].meals[0].actualEntries.length, 1);
  assert.equal(after.plans[0].meals[0].actualEntries[0].quantity, 1);
});

test('a direct consume cannot double-debit reserved meal ingredients unless explicitly outside the plan', () => {
  const state = committed();
  assert.throws(() => mutate(state, 'consume', { id: 'main', quantity: 1 }), (error) => error.status === 409 && error.code === 'MEAL_INTAKE_REQUIRED');
  assert.equal(quantity(state), 10);
  const outside = mutate(state, 'consume', { id: 'main', quantity: 1, outsidePlan: true, note: '用户明确报告菜单外额外吃一袋' });
  assert.equal(quantity(outside), 9);
  const cancelled = mutate(outside, 'cancel_plan', { planId: 'day-one', confirmed: true });
  assert.equal(quantity(cancelled), 9);
  assert.equal(cancelled.futureExtension.mustSurvive, true);
});

test('label updates preserve meal accounting and stored nutrition snapshots, while absolute recounts block stale refunds', () => {
  const state = committed();
  const labelled = mutate(state, 'upsert', { item: { id: 'main', nutrition: { kcal: 110, source: 'label', sourceText: '新标签更正每袋110' } } }, 'new-label', LATER);
  assert.equal(labelled.plans[0].meals[0].plannedItems[0].nutritionSnapshot.nutrition.kcal, 100);
  assert.equal(labelled.items[0].nutrition.kcal, 110);
  assert.equal(labelled.items[0].confirmedAt, state.items[0].confirmedAt);
  assert.equal(labelled.futureExtension.mustSurvive, true);
  assert.equal(quantity(mutate(labelled, 'cancel_meal_plan', { planId: 'day-one', confirmed: true })), 10);
  const recounted = mutate(labelled, 'set_quantity', { id: 'main', quantity: 4 });
  const cancelled=mutate(recounted, 'cancel_meal_plan', { planId: 'day-one', confirmed: true }); assert.equal(quantity(cancelled),4); assert.deepEqual(cancelled.plans[0].accountedDebits,[]);
});

test('meal and supplement intake are atomic through the shared entry point and legacy finalization cannot overwrite new plans', () => {
  const state = committed();
  assert.throws(() => mutate(state, 'record_meal_intake', { planId: 'day-one', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, supplements: [{ doseId: 'missing', mode: 'complete', matchesPlannedDose: true }] }), (error) => error.code === 'DOSE_NOT_FOUND');
  assert.equal(state.plans[0].meals[0].actualEntries.length, 0);
  assert.equal(quantity(state), 10);
  const actual = mutate(state, 'record_meal_intake', { planId: 'day-one', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, supplements: [{ doseId: 'fish-dose', mode: 'complete', matchesPlannedDose: true }] });
  assert.equal(quantity(actual), 8);
  assert.equal(quantity(actual, 'fish'), 9);
  assert.equal(actual.plans[0].supplementDoses[0].state, 'completed');
  assert.equal(actual.plans[0].supplementDoses[0].actualTime, null);
  assert.throws(() => mutate(actual, 'commit_plan', { confirmed: true, plan: { id: 'day-one', title: '不能覆盖', date: '2026-10-17', items: [{ itemId: 'main', quantity: 1 }] } }), (error) => error.code === 'MEAL_PLAN_ACTION_REQUIRED');
});
