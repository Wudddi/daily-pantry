import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { dietContext, getDailySupplementView, getSupplementRoutine } from '../lib/diet.mjs';

const NOW = '2026-10-19T13:00:00.000Z';
function fixture() {
  const items = [{ id: 'food', name: '主餐', category: 'prepared', quantity: 20, unit: '袋' }, { id: 'fish', name: '鱼油', category: 'supplement', quantity: 30, unit: '粒' }, { id: 'beta', name: 'Beta', category: 'supplement', quantity: 100, unit: 'g' }, { id: 'mag', name: '镁', category: 'supplement', quantity: null, unit: '片' }].map(item => validateItem({ ...item, nutrition: { basisAmount: 1, basisUnit: item.unit, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' } }, NOW));
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, items, plans: [], events: [], preferences: [], operationIds: [] };
}
function mutate(state, action, payload = {}, operationId = `${action}-${state.revision}`) { return applyMutation(state, { action, operationId, expectedRevision: state.revision, ...payload }, NOW); }
function foodPlan(id, date, supplementDoses = []) { return { id, date, title: '三餐计划', meals: [{ id: 'lunch', slot: 'lunch', title: '午饭', plannedItems: [{ id: 'food-line', itemId: 'food', quantity: 2 }] }], supplementDoses }; }
const entries = () => [{ id: 'oil', itemId: 'fish', plannedQuantity: 1, timingSlot: 'breakfast', plannedMealId: 'lunch' }, { id: 'beta-am', itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'breakfast' }, { id: 'beta-pre', itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'pre_workout', trainingDayOnly: true }, { id: 'mag', itemId: 'mag', plannedQuantity: null, timingSlot: 'bedtime', requirement: 'label_pending' }];
function source(saved = true) {
  let state = mutate(fixture(), 'save_meal_plan_draft', { plan: foodPlan('source', '2026-10-18', entries()) });
  state = mutate(state, 'commit_meal_plan', { planId: 'source', confirmed: true });
  return saved ? mutate(state, 'save_supplement_routine', { sourcePlanId: 'source', confirmed: true }) : state;
}
const stock = (state, id) => state.items.find(item => item.id === id);
const owner = (state, date = '2026-10-20') => state.plans.find(plan => plan.date === date);
const daily = (state, doseId, checked = true, date = '2026-10-20', operationId) => mutate(state, 'set_daily_supplement_check', { date, doseId, checked }, operationId);

test('saving a reusable routine strips every actual field and meal link without changing inventory, source plan or historical facts', () => {
  let state = source(false);
  state = mutate(state, 'set_supplement_check', { planId: 'source', doseId: 'oil', checked: true });
  state = mutate(state, 'record_supplement_intake', { planId: 'source', doseId: 'oil', actualTime: '08:15', sourceText: '昨天08:15已服，不能复制成今天实际' });
  const before = structuredClone(state);
  state = mutate(state, 'save_supplement_routine', { sourcePlanId: 'source', confirmed: true });
  assert.deepEqual(state.items, before.items);
  assert.deepEqual(state.plans, before.plans);
  assert.equal(state.supplementRoutine.sourcePlanId, 'source');
  assert.equal(state.supplementRoutine.supplementDoses[0].plannedMealId, null);
  for (const dose of state.supplementRoutine.supplementDoses) for (const field of ['actualEntries', 'reportHistory', 'actualTime', 'actualMealId', 'completionReportedAt', 'state', 'accountedDebits']) assert.equal(Object.hasOwn(dose, field), false);
  assert.strictEqual(mutate(state, 'save_supplement_routine', { sourcePlanId: 'source', confirmed: true }, 'same-routine-fresh-op'), state);
});

test('browsing many menu-less dates returns a complete unchecked routine without persisting a plan, revision or stock change', () => {
  const state = source(), before = structuredClone(state);
  for (let day = 1; day <= 28; day++) {
    const view = getDailySupplementView(state, `2026-11-${String(day).padStart(2, '0')}`);
    assert.equal(view.virtual, true);
    assert.equal(view.plan.supplementOnly, true);
    assert.equal(view.plan.supplementAccounting, 'actual_only');
    assert.equal(view.plan.supplementDoses.length, 4);
    assert.deepEqual(view.plan.meals, []);
    assert.ok(view.plan.supplementDoses.every(dose => dose.actualEntries.length === 0 && dose.actualTime === null));
    view.plan.supplementDoses[0].instruction = '修改投影不改原数据';
  }
  assert.deepEqual(state, before);
});

test('first check without a menu creates one actual-only owner and debits only that dose, not other daily reminders', () => {
  const before = source();
  const payload = { action: 'set_daily_supplement_check', date: '2026-10-20', doseId: 'oil', checked: true, operationId: 'first-daily-check', expectedRevision: before.revision };
  const state = applyMutation(before, payload, NOW);
  assert.equal(owner(state).id, 'supplements-2026-10-20');
  assert.equal(owner(state).supplementOnly, true);
  assert.equal(owner(state).supplementAccounting, 'actual_only');
  assert.equal(owner(state).supplementDoses.length, 4);
  assert.equal(owner(state).supplementDoses[0].actualEntries.length, 1);
  assert.ok(owner(state).supplementDoses.slice(1).every(dose => dose.actualEntries.length === 0));
  assert.equal(stock(state, 'fish').quantity, stock(before, 'fish').quantity - 1);
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  assert.equal(stock(state, 'beta').quantity, stock(before, 'beta').quantity);
  assert.strictEqual(applyMutation(state, payload, NOW), state);
  assert.strictEqual(daily(state, 'oil', true, '2026-10-20', 'same-dose-fresh-op'), state);
  assert.strictEqual(daily(before, 'oil', false), before);
});

test('each date has independent check state and stable unique actual IDs while old source time is never copied', () => {
  let state = source();
  state = mutate(state, 'set_supplement_check', { planId: 'source', doseId: 'oil', checked: true });
  state = mutate(state, 'record_supplement_intake', { planId: 'source', doseId: 'oil', actualTime: '08:15', sourceText: '旧日实际时间' });
  state = daily(state, 'oil');
  const first = structuredClone(owner(state).supplementDoses[0]);
  const unchecked = getDailySupplementView(state, '2026-10-21').plan;
  assert.equal(unchecked.supplementDoses[0].actualEntries.length, 0);
  state = daily(state, 'oil', true, '2026-10-21');
  const second = owner(state, '2026-10-21').supplementDoses[0];
  assert.notEqual(first.actualEntries[0].id, second.actualEntries[0].id);
  assert.equal(first.actualTime, null);
  assert.equal(second.actualTime, null);
  state = daily(state, 'oil', false);
  assert.equal(owner(state).supplementDoses[0].actualEntries[0].quantity, 0);
  assert.equal(second.actualEntries[0].quantity, 1);
  assert.equal(owner(state, '2026-10-18').supplementDoses[0].actualTime, '08:15');
});

test('an unknown magnesium dose remains null, settled and usable on a menu-less date', () => {
  let state = daily(source(), 'mag');
  const dose = owner(state).supplementDoses.find(dose => dose.id === 'mag');
  assert.equal(dose.plannedQuantity, null);
  assert.equal(dose.actualEntries[0].quantity, null);
  assert.equal(dose.actualEntries[0].quantitySource, 'unknown');
  assert.equal(dose.actualTime, null);
  assert.equal(stock(state, 'mag').quantity, null);
  assert.equal(stock(state, 'mag').status, 'available');
  assert.equal(owner(state).inventoryAccounting, 'settled');
  state = daily(state, 'mag', false);
  assert.equal(stock(state, 'mag').quantity, null);
  assert.equal(owner(state).supplementDoses.find(dose => dose.id === 'mag').actualEntries[0].correctionHistory[0].quantity, null);
});

test('first explicit check durably saves the fallback routine but reads and unused check states never do', () => {
  const before = source(false);
  assert.equal(before.supplementRoutine, undefined);
  assert.equal(getSupplementRoutine(before).supplementDoses.length, 4);
  assert.equal(before.supplementRoutine, undefined);
  assert.strictEqual(daily(before, 'oil', false), before);
  const state = daily(before, 'oil');
  assert.equal(state.supplementRoutine.supplementDoses.length, 4);
  assert.equal(state.supplementRoutine.sourcePlanId, 'source');
});

test('an existing food owner keeps its original ID, actual evidence and reservations; missing routine doses debit only when individually checked', () => {
  let state = source();
  state = mutate(state, 'save_meal_plan_draft', { plan: foodPlan('native', '2026-10-20', [{ id: 'old-oil-id', itemId: 'fish', plannedQuantity: 1, timingSlot: 'breakfast' }]) });
  state = mutate(state, 'commit_meal_plan', { planId: 'native', confirmed: true });
  state = mutate(state, 'set_supplement_check', { planId: 'native', doseId: 'old-oil-id', checked: true });
  state = mutate(state, 'record_supplement_intake', { planId: 'native', doseId: 'old-oil-id', actualTime: '08:15', sourceText: '今天原有实服' });
  const before = structuredClone(state), view = getDailySupplementView(state, '2026-10-20');
  assert.equal(view.plan.supplementDoses.filter(dose => dose.itemId === 'fish').length, 1);
  assert.equal(view.plan.supplementDoses.find(dose => dose.itemId === 'fish').id, 'old-oil-id');
  state = daily(state, 'beta-pre');
  assert.equal(owner(state).id, 'native');
  assert.deepEqual(owner(state).meals, owner(before).meals);
  assert.deepEqual(owner(state).supplementDoses[0], owner(before).supplementDoses[0]);
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  assert.equal(stock(state, 'fish').quantity, stock(before, 'fish').quantity);
  assert.equal(stock(state, 'beta').quantity, stock(before, 'beta').quantity - 1.6);
  assert.equal(owner(state).supplementDoses.some(dose => dose.id === 'beta-am'), false);
});

test('later food menus reuse the canonical owner and are immediately saved without reserving food or duplicating prior intake', () => {
  let state = daily(source(), 'oil');
  const id = owner(state).id, before = structuredClone(state), actual = structuredClone(owner(state).supplementDoses[0]);
  assert.throws(() => mutate(state, 'save_meal_plan_draft', { plan: foodPlan('different-id', '2026-10-20') }), error => error.code === 'DAY_PLAN_CONFLICT' && error.canonicalPlanId === id && error.message.includes(id));
  assert.deepEqual(state, before);
  state = mutate(state, 'save_meal_plan_draft', { plan: foodPlan(id, '2026-10-20', [{ id: 'different-oil-id', itemId: 'fish', plannedQuantity: 1, timingSlot: 'breakfast' }]) });
  assert.deepEqual(state.items, before.items);
  state = mutate(state, 'commit_meal_plan', { planId: id, confirmed: true });
  assert.equal(owner(state).supplementOnly, false);
  assert.equal(owner(state).supplementAccounting, 'actual_only');
  assert.equal(owner(state).foodAccounting, 'actual_only');
  assert.equal(owner(state).meals.length, 1);
  assert.equal(state.plans.filter(plan => plan.date === '2026-10-20').length, 1);
  assert.equal(owner(state).supplementDoses.filter(dose => dose.itemId === 'fish').length, 1);
  assert.deepEqual(owner(state).supplementDoses[0].actualEntries, actual.actualEntries);
  assert.equal(stock(state, 'fish').quantity, stock(before, 'fish').quantity);
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  assert.equal(stock(state, 'beta').quantity, stock(before, 'beta').quantity);
});

test('checking beside a saved food menu preserves all meal content without moving it into a hidden supplement-only draft', () => {
  let state = source();
  state = mutate(state, 'save_meal_plan_draft', { plan: foodPlan('unconfirmed-food', '2026-10-20') });
  const before = structuredClone(state);
  state = daily(state, 'oil');
  assert.equal(owner(state).id, 'unconfirmed-food');
  assert.notEqual(owner(state).supplementOnly, true);
  assert.deepEqual(owner(state).meals, owner(before).meals);
  assert.equal(owner(state).meals[0].plannedItems[0].quantity, 2);
  assert.equal(owner(state).draft, undefined);
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  const actual = structuredClone(owner(state).supplementDoses.find(dose => dose.id === 'oil').actualEntries);
  state = mutate(state, 'commit_meal_plan', { planId: 'unconfirmed-food', confirmed: true });
  assert.notEqual(owner(state).supplementOnly, true);
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  assert.deepEqual(owner(state).supplementDoses.find(dose => dose.id === 'oil').actualEntries, actual);
});

test('daily supplement reports are independent of a cancelled food menu without reopening meals or permitting a second daily account', () => {
  let state = source();
  state = mutate(state, 'save_meal_plan_draft', { plan: foodPlan('cancelled-food', '2026-10-20') });
  state = mutate(state, 'commit_meal_plan', { planId: 'cancelled-food', confirmed: true });
  state = mutate(state, 'cancel_meal_plan', { planId: 'cancelled-food', confirmed: true });
  const before = structuredClone(state);
  state = daily(state, 'oil');
  assert.equal(owner(state).status, 'cancelled');
  assert.deepEqual(owner(state).meals, owner(before).meals);
  assert.equal(stock(state, 'food').quantity, stock(before, 'food').quantity);
  assert.equal(stock(state, 'fish').quantity, stock(before, 'fish').quantity - 1);
  assert.equal(getDailySupplementView(state, '2026-10-20').plan.status, 'reserved');
  assert.throws(() => mutate(state, 'save_meal_plan_draft', { plan: foodPlan('second-ledger', '2026-10-20') }), { code: 'DAY_PLAN_CONFLICT' });
});

test('raw food inputs cannot forge supplement-only identity and saved menus do not reserve any food or supplements', () => {
  let state = fixture();
  state = mutate(state, 'save_meal_plan_draft', { plan: { ...foodPlan('forged', '2026-10-20', entries()), supplementOnly: true, supplementAccounting: 'actual_only' } });
  state = mutate(state, 'commit_meal_plan', { planId: 'forged', confirmed: true });
  assert.equal(owner(state).supplementOnly, undefined);
  assert.equal(owner(state).foodAccounting, 'actual_only');
  assert.equal(stock(state, 'food').quantity, 20);
  assert.equal(stock(state, 'fish').quantity, 30);
  assert.equal(stock(state, 'beta').quantity, 100);
});

test('daily checks retain shared revision, business retry identity, stock insufficiency and recount protections', () => {
  const before = source();
  let state = daily(before, 'oil');
  assert.throws(() => applyMutation(state, { action: 'set_daily_supplement_check', date: '2026-10-20', doseId: 'beta-am', checked: true, operationId: 'stale-tab', expectedRevision: before.revision }, NOW), { code: 'REVISION_CONFLICT' });
  state = mutate(state, 'set_quantity', { id: 'fish', quantity: 5 });
  state = daily(state, 'oil', false);
  assert.equal(stock(state, 'fish').quantity, 5);
  assert.ok(owner(state).accountingIssues.some(issue => issue.code === 'BASELINE_REQUIRES_REVIEW'));
  let depleted = source(); depleted = mutate(depleted, 'set_quantity', { id: 'fish', quantity: 0 });
  depleted = daily(depleted, 'oil');
  assert.equal(stock(depleted, 'fish').quantity, 0);
  assert.ok(owner(depleted).accountingIssues.some(issue => issue.code === 'INSUFFICIENT_STOCK'));
});

test('multiple legacy same-day actual owners are visible as an issue and reject every daily write without selecting or merging one', () => {
  const state = daily(source(), 'oil');
  const duplicate = structuredClone(owner(state));
  duplicate.id = 'second-legacy-owner';
  duplicate.supplementDoses[0].actualEntries[0].id = 'different-old-actual';
  duplicate.supplementDoses[0].actualEntries[0].sourceText = '另一个旧记录的原话，不能丢失或猜测合并';
  state.plans.push(duplicate);
  const before = structuredClone(state);
  assert.ok(getDailySupplementView(state, '2026-10-20').issues.some(issue => issue.code === 'DAILY_SUPPLEMENT_OWNER_CONFLICT'));
  for (const checked of [true, false]) assert.throws(() => daily(state, 'oil', checked), { status: 409, code: 'DAILY_SUPPLEMENT_OWNER_CONFLICT' });
  assert.deepEqual(state, before);
});

test('a different active food record cannot hide an older closed record with real supplement facts', () => {
  const state = daily(source(), 'oil');
  owner(state).status = 'closed_with_actuals';
  const competing = structuredClone(owner(state));
  competing.id = 'different-active-record'; competing.status = 'reserved';
  competing.supplementDoses = []; competing.accountedDebits = []; competing.items = [];
  state.plans.push(competing);
  const before = structuredClone(state);
  assert.throws(() => daily(state, 'oil'), { code: 'DAILY_SUPPLEMENT_OWNER_CONFLICT' });
  assert.deepEqual(state, before);
});

test('ambiguous same-item timing matches do not guess which old beta dose should be copied or debited', () => {
  let state = source();
  state = mutate(state, 'save_meal_plan_draft', { plan: foodPlan('ambiguous', '2026-10-20', ['old-a', 'old-b'].map(id => ({ id, itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'breakfast' }))) });
  state = mutate(state, 'commit_meal_plan', { planId: 'ambiguous', confirmed: true });
  const before = structuredClone(state);
  const view = getDailySupplementView(state, '2026-10-20');
  assert.ok(view.issues.some(issue => issue.doseId === 'beta-am' && issue.code === 'SUPPLEMENT_DOSE_AMBIGUOUS'));
  assert.throws(() => daily(state, 'beta-am'), { code: 'SUPPLEMENT_DOSE_AMBIGUOUS' });
  assert.deepEqual(state, before);
});

test('AI context marks a supplement-only ledger and explains canonical-ID reuse without presenting it as a full meal menu', () => {
  const state = daily(source(), 'oil');
  const context = dietContext(state, '2026-10-20');
  const record = context.records.find(record => record.id === 'supplements-2026-10-20');
  assert.equal(record.supplementOnly, true);
  assert.equal(record.supplementAccounting, 'actual_only');
  assert.deepEqual(record.meals, []);
  assert.ok(context.instructions.some(text => text.includes('canonical planId') && text.includes('稳定的mealId') && text.includes('doseId')));
  assert.ok(context.instructions.some(text => text.includes('supplementOnly') && text.includes('不能遗漏或重建三餐')));
});
