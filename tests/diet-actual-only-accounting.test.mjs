import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDietAction, getDailySupplementView, materializeDietPlanForEdit } from '../lib/diet.mjs';
import { projectCurrentDietPlan } from '../lib/diet-current-plan.mjs';

const NOW = '2026-10-22T12:48:00.000Z';
const LATER = '2026-10-22T23:00:00.000Z';
const copy = value => structuredClone(value);
function item(id, quantity, unit = 'g', category = 'prepared') {
  return { id, name: id, quantity, unit, category, status: 'available', quantityBaselineToken: 'original', confirmedAt: NOW, updatedAt: NOW, gramsPerUnit: null, nutrition: { basisAmount: 100, basisUnit: unit, kcal: 200, protein: 10, carbs: 20, fat: 5, source: 'label' } };
}
function fixture() { return { revision: 0, items: [item('rice', 2000), item('bagel', 10, '个', 'bread'), item('creatine', 100, 'g', 'supplement'), item('beta', 100, 'g', 'supplement')], plans: [] }; }
function input() {
  return { id: 'daily-food-2026-10-22', date: '2026-10-22', title: '四餐菜单', meals: ['breakfast', 'lunch', 'snack', 'dinner'].map((id, i) => ({ id, slot: id, title: id, plannedTime: ['08:30', '12:00', '15:00', '19:00'][i], plannedItems: [{ id: `${id}-rice`, itemId: 'rice', quantity: 100 }] })), supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, timingSlot: 'breakfast' }, { id: 'beta-am', itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'breakfast' }] };
}
function mutate(state, action, fields = {}, at = NOW) { const result = applyDietAction(state, { action, ...fields }, at); return result.noChange ? state : { ...state, items: result.items, plans: result.plans, ...(result.supplementRoutine ? { supplementRoutine: result.supplementRoutine } : {}) }; }
const draft = () => mutate(fixture(), 'save_meal_plan_draft', { plan: input() });
const plan = state => state.plans[0];
const stock = (state, id = 'rice') => state.items.find(item => item.id === id).quantity;
const report = (mealId, quantity = 100) => ({ mealId, mode: 'complete', entries: [{ id: `actual-${mealId}-rice`, itemId: 'rice', quantity, unit: 'g', sourceText: `${mealId}实际${quantity}g` }], sourceText: '用户明确报告吃完' });
const patch = (state, fields) => mutate(state, 'patch_meal_plan', { planId: plan(state).id, mode: 'draft', ...fields });

test('saved four-meal menu is immediately current and confirm/edit never debit or reserve any inventory', () => {
  let state = draft();
  assert.equal(plan(state).meals.length, 4); assert.equal(plan(state).foodAccounting, 'actual_only');
  assert.equal(plan(state).draft, undefined); assert.deepEqual(state.items, fixture().items); assert.deepEqual(plan(state).accountedDebits, []);
  state = mutate(state, 'commit_meal_plan', { planId: plan(state).id, confirmed: true });
  state = patch(state, { mealPatches: [{ id: 'lunch', plannedTime: '13:00', itemPatches: [{ id: 'lunch-rice', quantity: 150 }] }] });
  assert.equal(plan(state).meals[1].plannedItems[0].quantity, 150); assert.equal(plan(state).meals[1].plannedTime, '13:00');
  assert.equal(plan(state).draft, undefined); assert.deepEqual(state.items, fixture().items); assert.deepEqual(plan(state).accountedDebits, []);
  assert.equal(plan(state).meals[1].planRevisionHistory[0].previous.plannedItems[0].quantity, 100);
});

test('checking two supplements beside an unconfirmed menu retains all meals, canonical IDs, draft status and independent actuals', () => {
  let state = draft(); const before = copy(plan(state).meals), canonicalId = plan(state).id;
  for (const doseId of ['creatine-am', 'beta-am']) state = mutate(state, 'set_daily_supplement_check', { date: '2026-10-22', doseId, checked: true });
  assert.equal(state.plans.length, 1); assert.equal(plan(state).id, canonicalId); assert.equal(plan(state).status, 'draft');
  assert.deepEqual(plan(state).meals, before); assert.equal(stock(state), 2000); assert.equal(stock(state, 'creatine'), 95); assert.equal(stock(state, 'beta'), 98.4);
  const saved = copy(state);
  state = mutate(state, 'set_daily_supplement_check', { date: '2026-10-22', doseId: 'creatine-am', checked: true }, LATER);
  assert.deepEqual(state, saved);
  assert.equal(plan(state).supplementDoses.filter(dose => dose.actualEntries.length).length, 2);
  assert.equal(getDailySupplementView(state, '2026-10-22').plan.meals.length, 4);
});

test('unconfirmed menu actual completion debits once, retry with identical business IDs is a no-op, correction settles only delta', () => {
  let state = draft(); const payload = { planId: plan(state).id, ...report('lunch', 80) };
  state = mutate(state, 'record_meal_intake', payload); assert.equal(stock(state), 1920); assert.equal(plan(state).meals[1].state, 'completed');
  const first = state; state = mutate(state, 'record_meal_intake', payload, LATER); assert.equal(state, first);
  state = mutate(state, 'record_meal_intake', { ...payload, mode: 'correct', entries: [{ ...payload.entries[0], quantity: 70, sourceText: '核对后实际70g' }] }, LATER);
  assert.equal(stock(state), 1930); assert.equal(plan(state).meals[1].actualEntries[0].correctionHistory[0].quantity, 80);
});

test('planned food swap after partial intake changes no stock or actuals and later completion settles only explicitly reported additions', () => {
  let state = mutate(draft(), 'record_meal_intake', { planId: input().id, mealId: 'dinner', entries: [{ id: 'dinner-rice-actual', itemId: 'rice', quantity: 30, sourceText: '实际先吃30g米饭' }] });
  const facts = copy(plan(state).meals[3].actualEntries);
  state = patch(state, { mealPatches: [{ id: 'dinner', itemPatches: [{ id: 'dinner-rice', itemId: 'bagel', quantity: 1 }] }] });
  assert.equal(stock(state), 1970); assert.equal(stock(state, 'bagel'), 10); assert.deepEqual(plan(state).meals[3].actualEntries, facts);
  state = mutate(state, 'record_meal_intake', { planId: input().id, mealId: 'dinner', mode: 'complete', entries: [{ id: 'dinner-bagel-actual', itemId: 'bagel', quantity: 1, sourceText: '后来实际吃1个贝果' }] });
  assert.equal(stock(state), 1970); assert.equal(stock(state, 'bagel'), 9);
});

test('whole-day report atomically completes four meals, retries do not debit twice and supplements are preserved', () => {
  let state = mutate(draft(), 'set_daily_supplement_check', { date: '2026-10-22', doseId: 'creatine-am', checked: true });
  const actualDoses = copy(plan(state).supplementDoses);
  const payload = { planId: input().id, meals: input().meals.map(meal => report(meal.id)) };
  state = mutate(state, 'record_meal_intake', payload, LATER);
  assert.equal(stock(state), 1600); assert.ok(plan(state).meals.every(meal => meal.state === 'completed')); assert.deepEqual(plan(state).supplementDoses, actualDoses);
  const first = state; assert.equal(mutate(state, 'record_meal_intake', payload, LATER), first);
});

test('invalid or ambiguous whole-day reports leave original state intact', () => {
  const state = draft(), before = copy(state);
  for (const fields of [{ meals: [] }, { mealId: 'lunch', meals: [report('lunch')] }, { mode: 'complete', meals: [report('lunch')] }, { sourceText: '顶层原话不能静默丢弃', meals: [report('lunch')] }, { meals: [{ ...report('lunch'), supplements: [] }] }, { meals: [report('lunch'), report('lunch')] }, { meals: [report('breakfast'), report('missing')] }]) assert.throws(() => mutate(state, 'record_meal_intake', { planId: input().id, ...fields }));
  assert.deepEqual(state, before);
});

test('full saves preserve stable dose facts, completed food reports and accounting even if caller includes forged actuals', () => {
  let state = mutate(draft(), 'record_meal_intake', { planId: input().id, ...report('breakfast') });
  state = mutate(state, 'set_daily_supplement_check', { date: '2026-10-22', doseId: 'creatine-am', checked: true });
  const before = copy(state); const raw = input(); raw.title = '更新午晚餐'; raw.meals[0].actualEntries = []; raw.meals[0].state = 'reserved'; raw.meals[0].plannedItems[0].quantity = 60; delete raw.supplementDoses;
  state = mutate(state, 'save_meal_plan_draft', { plan: raw }, LATER);
  assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).accountedDebits, plan(before).accountedDebits);
  assert.deepEqual(plan(state).meals[0].actualEntries, plan(before).meals[0].actualEntries); assert.equal(plan(state).meals[0].state, 'completed');
  assert.deepEqual(plan(state).supplementDoses, plan(before).supplementDoses);
});

test('legacy incident supplement-only owner adopts four hidden draft meals with no food debit and keeps prior dose entries', () => {
  let state = draft(); const old = copy(plan(state));
  state = mutate(state, 'set_daily_supplement_check', { date: old.date, doseId: 'creatine-am', checked: true });
  const parent = plan(state); parent.status = 'reserved'; parent.supplementOnly = true; delete parent.foodAccounting;
  parent.draft = { id: parent.id, date: parent.date, title: old.title, timeZone: old.timeZone, notes: old.notes, meals: old.meals, supplementDoses: old.supplementDoses };
  parent.meals = [];
  const beforeDose = copy(parent.supplementDoses[0].actualEntries);
  state = mutate(state, 'set_daily_supplement_check', { date: old.date, doseId: 'beta-am', checked: true });
  assert.equal(plan(state).meals.length, 4); assert.equal(plan(state).foodAccounting, 'actual_only'); assert.equal(plan(state).supplementOnly, false);
  assert.equal(plan(state).draft, undefined); assert.equal(stock(state), 2000); assert.deepEqual(plan(state).supplementDoses[0].actualEntries, beforeDose);
  assert.equal(stock(state, 'creatine'), 95); assert.equal(stock(state, 'beta'), 98.4);
});

function legacyReserved() {
  const state = draft(); const p = plan(state); p.status = 'reserved'; delete p.foodAccounting; delete p.supplementAccounting;
  const reservation = [['rice', 400], ['creatine', 5], ['beta', 1.6]].map(([id, quantity]) => { const food = state.items.find(item => item.id === id); food.quantity -= quantity; return { itemId: id, quantity, unit: food.unit, name: food.name, baselineToken: food.quantityBaselineToken, unknownBalance: false }; });
  p.accountedDebits = copy(reservation); p.items = copy(reservation); p.intakeBasis = 'confirmed_daily_plan'; return state;
}

test('legacy planned edits preserve old debits exactly and a supplement check cannot reserve replacement foods or refund original meals', () => {
  let state = legacyReserved(); const before = copy(state.items), credits = copy(plan(state).accountedDebits);
  state = patch(state, { mealPatches: [{ id: 'lunch', itemPatches: [{ id: 'lunch-rice', itemId: 'bagel', quantity: 1 }] }] });
  assert.deepEqual(state.items, before); assert.deepEqual(plan(state).accountedDebits, credits); assert.ok(plan(state).legacyReservations);
  state = mutate(state, 'set_daily_supplement_check', { date: input().date, doseId: 'creatine-am', checked: true });
  assert.deepEqual(state.items, before); assert.deepEqual(plan(state).accountedDebits, credits); assert.equal(stock(state, 'bagel'), 10);
  state = mutate(state, 'record_meal_intake', { planId: input().id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '午餐改为1个贝果并实际吃完' });
  assert.equal(stock(state), 1700); assert.equal(stock(state, 'bagel'), 9);
  const done = state; assert.equal(mutate(state, 'record_meal_intake', { planId: input().id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '午餐改为1个贝果并实际吃完' }), done);
});

test('legacy completed actual correction adjusts only its delta while historical credits stay intact', () => {
  let state = legacyReserved(); state = mutate(state, 'record_meal_intake', { planId: input().id, ...report('lunch', 80) });
  assert.equal(stock(state), 1620); const before = copy(plan(state).accountedDebits);
  state = patch(state, { mealPatches: [{ id: 'lunch', itemPatches: [{ id: 'lunch-rice', quantity: 50 }] }] });
  assert.equal(stock(state), 1620); assert.deepEqual(plan(state).accountedDebits, before);
  state = mutate(state, 'record_meal_intake', { planId: input().id, mealId: 'lunch', mode: 'correct', entries: [{ ...report('lunch', 70).entries[0], sourceText: '原实际80g更正为70g' }] });
  assert.equal(stock(state), 1630);
});

test('JSON reload and date view switches preserve current menu and actual supplement records without mutations', () => {
  let state = mutate(draft(), 'set_daily_supplement_check', { date: input().date, doseId: 'beta-am', checked: true });
  state = JSON.parse(JSON.stringify(state)); const before = copy(state);
  for (const day of ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-22']) {
    getDailySupplementView(state, day);
    for (const record of state.plans.filter(p => p.date === day)) assert.equal(projectCurrentDietPlan(record, state.items).meals.length, 4);
  }
  assert.equal(materializeDietPlanForEdit(state, input().id).meals.length, 4); assert.deepEqual(state, before);
});

test('independent supplements on a cancelled menu never reopen the food lifecycle or refund actuals', () => {
  let state = draft(); state = mutate(state, 'cancel_meal_plan', { planId: input().id, confirmed: true });
  state = mutate(state, 'set_daily_supplement_check', { date: input().date, doseId: 'beta-am', checked: true });
  assert.equal(plan(state).status, 'cancelled'); assert.ok(plan(state).meals.every(meal => meal.state === 'cancelled')); assert.equal(stock(state), 2000); assert.equal(stock(state, 'beta'), 98.4);
});

test('closed or cancelled dates retain their canonical account and cannot be duplicated under a new plan ID', () => {
  for (const status of ['cancelled', 'closed_with_actuals']) {
    const state = draft(); plan(state).status = status; const before = copy(state);
    assert.throws(() => mutate(state, 'save_meal_plan_draft', { plan: { ...input(), id: 'second-day-ledger' } }), error => error.code === 'DAY_PLAN_CONFLICT' && error.canonicalPlanId === input().id);
    assert.deepEqual(state, before);
  }
});

test('supplement checks preserve legacy food credits even when a closed historical menu has inconsistent planned state', () => {
  let state = legacyReserved(); const p = plan(state); p.status = 'closed_with_actuals';
  for (const meal of p.meals) meal.plannedItems[0].quantity = 200;
  const before = copy(state.items), mealFacts = copy(p.meals), foodDebit = copy(p.accountedDebits.find(line => line.itemId === 'rice'));
  state = mutate(state, 'set_daily_supplement_check', { date: input().date, doseId: 'creatine-am', checked: true });
  assert.deepEqual(state.items, before); assert.deepEqual(plan(state).meals, mealFacts); assert.equal(plan(state).status, 'closed_with_actuals');
  assert.deepEqual(plan(state).accountedDebits.find(line => line.itemId === 'rice'), foodDebit);
});

test('independent supplement checking never retries pending food accounting and keeps food reconciliation visible', () => {
  let state = mutate(draft(), 'record_meal_intake', { planId: input().id, ...report('lunch', null) });
  assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation');
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'rice' && issue.code === 'ACTUAL_QUANTITY_UNKNOWN'));
  state.items.find(item => item.id === 'rice').quantity = 5000;
  const issues = copy(plan(state).accountingIssues), foodFacts = copy(plan(state).meals);
  state = mutate(state, 'set_daily_supplement_check', { date: input().date, doseId: 'beta-am', checked: true });
  assert.equal(stock(state), 5000); assert.equal(stock(state, 'beta'), 98.4); assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation');
  assert.deepEqual(plan(state).meals, foodFacts); assert.deepEqual(plan(state).accountingIssues, issues);
  assert.equal(plan(state).accountedDebits.some(line => line.itemId === 'rice'), false);
});

test('existing canonical date cannot be moved by full-save, while title and timezone remain editable without stock changes', () => {
  const state = draft(), before = copy(state);
  assert.throws(() => mutate(state, 'save_meal_plan_draft', { plan: { ...input(), date: '2026-10-23' } }), { code: 'PLAN_DATE_CONFLICT' });
  assert.deepEqual(state, before);
  const after = mutate(state, 'save_meal_plan_draft', { plan: { ...input(), title: '合法的新标题', timeZone: 'America/Vancouver' } });
  assert.equal(plan(after).date, input().date); assert.equal(plan(after).id, input().id); assert.equal(plan(after).title, '合法的新标题'); assert.equal(plan(after).timeZone, 'America/Vancouver');
  assert.deepEqual(after.items, state.items);
});

test('explicit supplement reports remain independent on cancelled food dates and retry without reopening or duplicating debits', () => {
  let state = mutate(draft(), 'cancel_meal_plan', { planId: input().id, confirmed: true });
  const meals = copy(plan(state).meals);
  const payload = { planId: input().id, doseId: 'beta-am', mode: 'complete', entries: [{ id: 'actual-beta-cancelled-day', itemId: 'beta', quantity: 1.6, sourceText: '当天仍实际服用β丙氨酸1.6g' }] };
  state = mutate(state, 'record_supplement_intake', payload);
  assert.equal(plan(state).status, 'cancelled'); assert.deepEqual(plan(state).meals, meals); assert.equal(stock(state), 2000); assert.equal(stock(state, 'beta'), 98.4);
  const saved = state; assert.equal(mutate(state, 'record_supplement_intake', payload), saved);
});
