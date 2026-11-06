import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { inventoryBalanceBoundary } from '../lib/inventory-balance-boundary.mjs';

const DAY = '2026-10-31';
const INITIAL = '2026-10-30T16:00:00.000Z';
const MORNING = DAY + 'T14:00:00.000Z';
const COUNTED = DAY + 'T23:50:00.000Z';
const MIDNIGHT = '2026-11-01T04:00:00.000Z';
let sequence = 0;
const copy = value => structuredClone(value);
const stock = (state, id) => state.items.find(item => item.id === id);
const plan = (state, date = DAY) => state.plans.find(value => value.id === 'daily-food-' + date);
const credit = (state, id, date = DAY) => plan(state, date).accountedDebits.find(line => line.itemId === id);
function change(state, action, fields = {}, at = MORNING) {
  return applyMutation(state, { action, operationId: 'daily-delta-' + (++sequence), expectedRevision: state.revision, ...fields }, at);
}
function item(id, quantity, unit = 'g', category = 'protein') {
  return validateItem({ id, name: id, quantity, unit, category,
    nutrition: { basisAmount: 1, basisUnit: unit, kcal: 1, protein: 0, carbs: 0, fat: 0, source: 'estimate' } }, INITIAL);
}
function menu(date = DAY) {
  return { id: 'daily-food-' + date, date, title: "Local fixture: day-end settles only the outstanding difference", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedItems: [{ id: 'banana-b', itemId: 'banana', quantity: 2, unit: '条' }] },
    { id: 'lunch', slot: 'lunch', title: "Lunch", plannedItems: [{ id: 'rice-l', itemId: 'rice', quantity: 100, unit: 'g' }, { id: 'milk-l', itemId: 'milk', quantity: 150, unit: 'ml' }] },
    { id: 'dinner', slot: 'dinner', title: "Dinner", plannedItems: [{ id: 'rice-d', itemId: 'rice', quantity: 100, unit: 'g' }] },
  ], supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, unit: 'g' }] };
}
function fixture(date = DAY) {
  return change({ schemaVersion: 1, revision: 0, updatedAt: INITIAL, preferences: [], events: [], operationIds: [], plans: [],
    items: [item('banana', 3, '条', 'fruit'), item('rice', 1000), item('milk', 1000, 'ml'), item('creatine', 100, 'g', 'supplement')],
    dailyMenuSettlementPolicy: { version: 1, enabled: true, timeZone: 'America/Toronto', startsOn: date,
      updatedAt: INITIAL, sourceText: "Local fixture: settle the saved menu at day-end, credit prior debits" },
  }, 'save_meal_plan_draft', { plan: menu(date) });
}
function settle(state, fields = {}, at = MIDNIGHT) {
  return change(state, 'settle_daily_menu', { planId: plan(state).id, effectiveDate: DAY,
    policyStartDate: DAY, confirmed: true, ...fields }, at);
}
function report(state, mealId, entries, mode = 'append', at = MORNING, date = DAY) {
  return change(state, 'record_meal_intake', { planId: plan(state, date).id, mealId, mode, entries,
    sourceText: "Local fixture: explicit actual intake report" }, at);
}
const entry = (id, itemId, quantity, unit = 'g') => ({ id, itemId, quantity, unit, sourceText: "Local fixture: explicit actual quantity" });

test('same-day menu edits never debit stock and midnight uses only the latest saved amounts', () => {
  let state = fixture();
  const originalItems = copy(state.items), originalDoses = copy(plan(state).supplementDoses);
  for (const quantity of [90, 120, 70]) state = change(state, 'patch_meal_plan', {
    planId: plan(state).id, mode: 'draft', mealPatches: [{ id: 'lunch', itemPatches: [{ id: 'rice-l', quantity }] }],
  });
  assert.deepEqual(state.items, originalItems);
  assert.deepEqual(plan(state).accountedDebits, []);
  state = settle(state);
  assert.equal(stock(state, 'rice').quantity, 830);
  assert.equal(credit(state, 'rice').quantity, 170);
  assert.deepEqual(plan(state).supplementDoses, originalDoses);
  assert.equal(stock(state, 'creatine').quantity, 100);
});

test('a partial actual debit is reused and midnight adds only the remaining meal and other meal amounts', () => {
  let state = report(fixture(), 'lunch', [entry('rice-progress', 'rice', 60)]);
  assert.equal(stock(state, 'rice').quantity, 940);
  assert.equal(credit(state, 'rice').quantity, 60);
  const facts = copy(plan(state).meals);
  state = settle(state);
  assert.equal(stock(state, 'rice').quantity, 800);
  assert.equal(credit(state, 'rice').quantity, 200);
  assert.equal(stock(state, 'milk').quantity, 850);
  assert.deepEqual(plan(state).meals, facts);
});

test('a completed meal uses actual portions instead of charging the unconsumed planned remainder', () => {
  let state = report(fixture(), 'lunch', [entry('rice-finished', 'rice', 60)], 'complete');
  const facts = copy(plan(state).meals);
  state = settle(state);
  assert.equal(stock(state, 'rice').quantity, 840);
  assert.equal(stock(state, 'milk').quantity, 1000);
  assert.equal(credit(state, 'rice').quantity, 160);
  assert.deepEqual(plan(state).meals, facts);
});

test('replaying the same request or a new daily settlement request never charges the date twice', () => {
  let state = fixture();
  const payload = { action: 'settle_daily_menu', operationId: 'daily-delta-exact-retry', expectedRevision: state.revision,
    planId: plan(state).id, effectiveDate: DAY, policyStartDate: DAY, confirmed: true };
  state = applyMutation(state, payload, MIDNIGHT);
  const before = copy(state);
  assert.strictEqual(applyMutation(state, payload, MIDNIGHT), state);
  assert.strictEqual(settle(state), state);
  assert.deepEqual(state, before);
});

for (const action of ['restock', 'set_quantity']) {
  test('a later ' + action + ' balance already includes the completed breakfast and midnight preserves its old credit', () => {
    let state = report(fixture(), 'breakfast', [entry('banana-eaten-before-' + action, 'banana', 2, '条')], 'complete');
    assert.equal(stock(state, 'banana').quantity, 1);
    const oldCredit = copy(credit(state, 'banana'));
    state = change(state, action, action === 'restock' ? { itemId: 'banana', quantity: 7 } : { id: 'banana', quantity: 7 }, COUNTED);
    const physical = copy(stock(state, 'banana')), facts = copy(plan(state).meals);
    state = settle(state);
    assert.deepEqual(stock(state, 'banana'), physical);
    assert.equal(stock(state, 'banana').quantity, 7);
    assert.deepEqual(credit(state, 'banana'), oldCredit);
    assert.equal(stock(state, 'rice').quantity, 800);
    assert.deepEqual(plan(state).meals, facts);
  });
}

test('legacy actuals with missing credit cannot be charged again across a newer physical count', () => {
  let state = report(fixture(), 'breakfast', [entry('legacy-banana-eaten', 'banana', 2, '条')], 'complete');
  // Reproduce an existing legacy receipt whose intake facts survived but whose
  // old per-item credit is absent; never invent new intake to repair that gap.
  state = copy(state);
  plan(state).accountedDebits = plan(state).accountedDebits.filter(line => line.itemId !== 'banana');
  plan(state).items = plan(state).items.filter(line => line.itemId !== 'banana');
  state = change(state, 'restock', { itemId: 'banana', quantity: 7 }, COUNTED);
  const physical = copy(stock(state, 'banana')), facts = copy(plan(state).meals);
  state = settle(state);
  assert.deepEqual(stock(state, 'banana'), physical);
  assert.equal(stock(state, 'rice').quantity, 800);
  assert.equal(stock(state, 'milk').quantity, 850);
  assert.deepEqual(plan(state).meals, facts);
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'banana' && issue.code === 'BALANCE_COVERAGE_REQUIRES_REVIEW'));
  assert.ok(plan(state).accountingIssues.every(issue => issue.itemId === 'banana'));
  assert.equal(plan(state).dailySettlement.accounting, 'pending_reconciliation');
  assert.strictEqual(settle(state), state);
});

test('a confirmed empty balance is not overridden by an older automatic assumption or a manufactured shortfall', () => {
  let state = fixture();
  state = change(state, 'set_quantity', { id: 'banana', quantity: 0 }, COUNTED);
  const facts = copy(plan(state).meals);
  state = settle(state);
  assert.equal(stock(state, 'banana').quantity, 0);
  assert.equal(stock(state, 'banana').status, 'depleted');
  assert.equal(credit(state, 'banana'), undefined);
  assert.ok(!(plan(state).accountingWarnings ?? []).some(warning => warning.itemId === 'banana'));
  assert.ok(!(plan(state).accountingAdjustmentHistory ?? []).some(adjustment => adjustment.itemId === 'banana'));
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'banana' && issue.code === 'BALANCE_COVERAGE_REQUIRES_REVIEW'));
  assert.equal(stock(state, 'rice').quantity, 800);
  assert.equal(stock(state, 'milk').quantity, 850);
  assert.deepEqual(plan(state).meals, facts);
});

test('manual actual reports made after a same-day count still debit normally without an invented time', () => {
  let state = change(fixture(), 'set_quantity', { id: 'banana', quantity: 7 }, COUNTED);
  state = report(state, 'breakfast', [entry('banana-after-count', 'banana', 1, '条')], 'complete', DAY + 'T23:55:00.000Z');
  assert.equal(stock(state, 'banana').quantity, 6);
  assert.equal(credit(state, 'banana').quantity, 1);
  assert.equal(plan(state).meals[0].actualTime, null);
  assert.equal(plan(state).inventoryAccounting, 'settled');
  state = settle(state);
  assert.equal(stock(state, 'banana').quantity, 6);
});

test('midnight metadata does not block later manual corrections of an actual-only item already debited on the current baseline', () => {
  let state = change(fixture(), 'set_quantity', { id: 'banana', quantity: 7 }, COUNTED);
  state = report(state, 'breakfast', [entry('banana-manual-current-baseline', 'banana', 1, '条')], 'complete', DAY + 'T23:55:00.000Z');
  assert.equal(stock(state, 'banana').quantity, 6);
  const originalToken = credit(state, 'banana').baselineToken;
  state = settle(state);
  assert.equal(stock(state, 'banana').quantity, 6);
  state = report(state, 'breakfast', [entry('banana-manual-current-baseline', 'banana', 2, '条')], 'correct', '2026-11-01T05:00:00.000Z');
  assert.equal(stock(state, 'banana').quantity, 5);
  assert.equal(credit(state, 'banana').quantity, 2);
  assert.equal(credit(state, 'banana').baselineToken, originalToken);
  state = report(state, 'breakfast', [entry('banana-manual-current-baseline', 'banana', 1, '条')], 'correct', '2026-11-01T05:05:00.000Z');
  assert.equal(stock(state, 'banana').quantity, 6);
  assert.equal(credit(state, 'banana').quantity, 1);
  assert.equal(plan(state).inventoryAccounting, 'settled');
  assert.equal(plan(state).dailySettlement.accounting, 'settled');
  assert.equal(plan(state).meals[0].actualTime, null);
  assert.equal(plan(state).meals[0].actualEntries[0].correctionHistory.length, 2);
});

test('later actual corrections change only the settled difference on the same baseline', () => {
  let state = report(fixture(), 'lunch', [entry('rice-correctable', 'rice', 60)], 'complete');
  state = settle(state);
  assert.equal(stock(state, 'rice').quantity, 840);
  const milk = copy(stock(state, 'milk')), banana = copy(stock(state, 'banana'));
  state = report(state, 'lunch', [entry('rice-correctable', 'rice', 80)], 'correct', '2026-11-01T05:00:00.000Z');
  assert.equal(stock(state, 'rice').quantity, 820);
  state = report(state, 'lunch', [entry('rice-correctable', 'rice', 50)], 'correct', '2026-11-01T05:05:00.000Z');
  assert.equal(stock(state, 'rice').quantity, 850);
  assert.equal(credit(state, 'rice').quantity, 150);
  assert.deepEqual(stock(state, 'milk'), milk);
  assert.deepEqual(stock(state, 'banana'), banana);
  assert.equal(plan(state).meals[1].actualEntries[0].correctionHistory.length, 2);
  assert.strictEqual(settle(state), state);
});

test('an old actual correction cannot refund a newer physical count while an independent food delta still settles', () => {
  let state = report(fixture(), 'lunch', [entry('old-rice', 'rice', 60), entry('old-milk', 'milk', 50, 'ml')], 'complete');
  state = change(state, 'set_quantity', { id: 'rice', quantity: 500 }, COUNTED);
  const beforeCredit = copy(credit(state, 'rice'));
  state = report(state, 'lunch', [entry('old-rice', 'rice', 40), entry('old-milk', 'milk', 80, 'ml')], 'correct', '2026-11-01T05:00:00.000Z');
  assert.equal(stock(state, 'rice').quantity, 500);
  assert.deepEqual(credit(state, 'rice'), beforeCredit);
  assert.equal(stock(state, 'milk').quantity, 920);
  assert.equal(credit(state, 'milk').quantity, 80);
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'rice' && issue.code === 'BASELINE_REQUIRES_REVIEW'));
  assert.ok(plan(state).accountingIssues.every(issue => issue.itemId === 'rice'));
});

test('a new day can consume the newer baseline without reopening the previous day accounting', () => {
  let state = report(fixture(), 'breakfast', [entry('old-breakfast-banana', 'banana', 2, '条')], 'complete');
  state = change(state, 'restock', { itemId: 'banana', quantity: 7 }, COUNTED);
  state = settle(state);
  const oldPlan = copy(plan(state));
  state = change(state, 'save_meal_plan_draft', { plan: menu('2026-11-01') }, '2026-11-01T05:00:00.000Z');
  state = report(state, 'breakfast', [entry('new-day-banana', 'banana', 1, '条')], 'complete', '2026-11-01T14:00:00.000Z', '2026-11-01');
  assert.equal(stock(state, 'banana').quantity, 6);
  assert.equal(credit(state, 'banana', '2026-11-01').quantity, 1);
  assert.deepEqual(plan(state), oldPlan);
});

for (const archived of [false, true]) {
  test('a legacy physical baseline is protected through its exact ' + (archived ? 'archived' : 'recent') + ' event even without new metadata', () => {
    let state = change(fixture(), 'set_quantity', { id: 'banana', quantity: 7 }, COUNTED);
    delete stock(state, 'banana').quantityBaselineAt;
    delete stock(state, 'banana').quantityBaselineSource;
    if (archived) {
      state.eventHistory = [...(state.eventHistory ?? []), ...state.events];
      state.events = [];
    }
    state = settle(state);
    assert.equal(stock(state, 'banana').quantity, 7);
    assert.equal(credit(state, 'banana'), undefined);
    assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'banana' && issue.code === 'BALANCE_COVERAGE_REQUIRES_REVIEW'));
    assert.equal(stock(state, 'rice').quantity, 800);
  });
}

test('late settlement of an unreported October 30 menu cannot consume an October 31 restock, including legacy metadata', () => {
  const oldDate = '2026-10-30';
  let state = change(fixture(oldDate), 'restock', { itemId: 'banana', quantity: 7 }, COUNTED);
  // This is the native restock event and exact baseline token, not a fabricated
  // timestamp or acknowledgement of unreported historical intake.
  delete stock(state, 'banana').quantityBaselineAt;
  delete stock(state, 'banana').quantityBaselineSource;
  const physical = copy(stock(state, 'banana'));
  const facts = copy(plan(state, oldDate).meals);
  state = change(state, 'settle_daily_menu', { planId: plan(state, oldDate).id,
    effectiveDate: oldDate, policyStartDate: oldDate, confirmed: true }, MIDNIGHT);
  assert.deepEqual(stock(state, 'banana'), physical);
  assert.equal(stock(state, 'banana').quantity, 7);
  assert.equal(credit(state, 'banana', oldDate), undefined);
  assert.equal(stock(state, 'rice').quantity, 800);
  assert.equal(stock(state, 'milk').quantity, 850);
  assert.deepEqual(plan(state, oldDate).meals, facts);
  assert.ok(plan(state, oldDate).meals.every(meal => meal.actualEntries.length === 0));
  assert.ok(plan(state, oldDate).accountingIssues.some(issue => issue.itemId === 'banana' && issue.code === 'BALANCE_COVERAGE_REQUIRES_REVIEW'));
  assert.ok(plan(state, oldDate).accountingIssues.every(issue => issue.itemId === 'banana'));
  assert.equal(plan(state, oldDate).dailySettlement.accounting, 'pending_reconciliation');
  assert.ok(!(plan(state, oldDate).accountingWarnings ?? []).some(warning => warning.itemId === 'banana'));
});

test('a timestamp-like token is not treated as a physical count without matching evidence', () => {
  const state = fixture();
  const banana = stock(state, 'banana');
  delete banana.quantityBaselineAt;
  delete banana.quantityBaselineSource;
  banana.quantityBaselineToken = 'unverified-balance@' + COUNTED;
  banana.confirmedAt = COUNTED;
  assert.equal(inventoryBalanceBoundary(state, banana), null);
});

test('label edits and ordinary consumption do not turn their receipt times into physical count boundaries', () => {
  let state = change(fixture(), 'upsert', { item: { id: 'banana', notes: "Local fixture: add label source only, without a physical count" } }, COUNTED);
  assert.equal(inventoryBalanceBoundary(state, stock(state, 'banana')), null);
  state = change(state, 'consume', { id: 'banana', quantity: 1, outsidePlan: true, note: "Local fixture: explicitly ate one extra item outside the menu" }, COUNTED);
  assert.equal(stock(state, 'banana').confirmedAt, COUNTED);
  assert.equal(inventoryBalanceBoundary(state, stock(state, 'banana')), null);
  state = settle(state);
  assert.equal(stock(state, 'banana').quantity, 0);
  assert.equal(credit(state, 'banana').quantity, 2);
  assert.equal(plan(state).inventoryAccounting, 'settled');
});

test('an explicit initial balance on the menu date does not block the first automatic settlement', () => {
  let state = fixture();
  stock(state, 'banana').quantityBaselineSource = 'initial';
  stock(state, 'banana').quantityBaselineAt = MORNING;
  stock(state, 'banana').confirmedAt = MORNING;
  assert.equal(inventoryBalanceBoundary(state, stock(state, 'banana')), null);
  state = settle(state);
  assert.equal(stock(state, 'banana').quantity, 1);
  assert.equal(credit(state, 'banana').quantity, 2);
  assert.equal(plan(state).inventoryAccounting, 'settled');
});

test('a late manual report for an older date cannot debit a newer physical count by its receipt time', () => {
  let state = change(fixture(), 'restock', { itemId: 'banana', quantity: 7 }, '2026-11-01T05:00:00.000Z');
  state = change(state, 'record_meal_intake', { planId: plan(state).id, meals: [
    { mealId: 'breakfast', mode: 'complete', entries: [entry('late-old-banana', 'banana', 2, '条')], sourceText: "Local fixture: late report for yesterday's breakfast" },
    { mealId: 'lunch', mode: 'complete', entries: [entry('late-old-rice', 'rice', 60)], sourceText: "Local fixture: late report for yesterday's lunch" },
  ] }, '2026-11-01T06:00:00.000Z');
  assert.equal(stock(state, 'banana').quantity, 7);
  assert.equal(credit(state, 'banana'), undefined);
  assert.equal(stock(state, 'rice').quantity, 940);
  assert.equal(credit(state, 'rice').quantity, 60);
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'banana' && issue.code === 'BALANCE_COVERAGE_REQUIRES_REVIEW'));
  assert.ok(plan(state).accountingIssues.every(issue => issue.itemId === 'banana'));
  assert.equal(plan(state).meals[0].actualEntries[0].quantity, 2);
  assert.equal(plan(state).meals[0].actualTime, null);
});

test('changing a menu timezone cannot reinterpret the Toronto day of a physical count', () => {
  let state = change(fixture(), 'save_meal_plan_draft', { plan: { ...menu(), timeZone: 'Pacific/Honolulu' } });
  state = change(state, 'restock', { itemId: 'banana', quantity: 7 }, '2026-11-01T05:00:00.000Z');
  state = report(state, 'breakfast', [entry('old-day-timezone-banana', 'banana', 2, '条')], 'complete', '2026-11-01T06:00:00.000Z');
  assert.equal(stock(state, 'banana').quantity, 7);
  assert.equal(credit(state, 'banana'), undefined);
  assert.ok(plan(state).accountingIssues.some(issue => issue.itemId === 'banana' && issue.code === 'BALANCE_COVERAGE_REQUIRES_REVIEW'));
});
