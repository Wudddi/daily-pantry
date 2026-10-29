import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { readIntakeDraft, readDietRecords } from '../lib/diet.mjs';
import { intakeDraftView, intakeDraftVersion, intakeEntryId, intakeTransferLineId, intakePlanFingerprint } from '../lib/intake-draft.mjs';
import { planNutritionTotals } from '../lib/diet-nutrition.mjs';

const NOW = '2026-10-26T15:00:00.000Z', LATER = '2026-10-26T19:00:00.000Z';
const copy = value => structuredClone(value);
let sequence = 0;
function item(id, quantity = 1000, unit = 'g', gramsPerUnit = null) {
  return validateItem({ id, name: id, quantity, unit, gramsPerUnit, category: id === 'creatine' ? 'supplement' : 'prepared',
    nutrition: { basisAmount: 100, basisUnit: unit === '袋' ? 'g' : unit, kcal: 200, protein: 10, carbs: 20, fat: 5, source: 'label' } }, NOW);
}
function menu() { return { id: 'daily-food-2026-10-26', date: '2026-10-26', title: '本机验证四餐',
  meals: ['breakfast', 'lunch', 'snack', 'dinner'].map(id => ({ id, slot: id, title: id, plannedItems: [{ id: `${id}-rice`, itemId: 'rice', quantity: 100 }] })),
  supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, timingSlot: 'breakfast' }] }; }
function mutate(state, action, fields = {}, at = NOW) { return applyMutation(state, { action, operationId: `intake-test-${++sequence}`, expectedRevision: state.revision, ...fields }, at); }
function fixture(foods = [item('rice'), item('creatine')], raw = menu()) {
  return mutate({ schemaVersion: 1, revision: 0, updatedAt: NOW, items: foods, plans: [], events: [], operationIds: [], preferences: [] }, 'save_meal_plan_draft', { plan: raw });
}
const plan = state => state.plans[0];
const stock = (state, id = 'rice') => state.items.find(item => item.id === id).quantity;
function draft(state, fields = {}) { return { id: `manual-draft-${++sequence}`, baseFingerprint: intakePlanFingerprint(plan(state), state.items), consumed: [], transfers: [], completedMealIds: [], ...fields }; }
function save(state, value) { return mutate(state, 'save_intake_draft', { planId: plan(state).id, draft: value, expectedDraftVersion: intakeDraftVersion(plan(state).intakeDraft) }); }
function submit(state, fields = {}) { return mutate(state, 'submit_intake_draft', { planId: plan(state).id, draftId: plan(state).intakeDraft.id, baseFingerprint: plan(state).intakeDraft.baseFingerprint, expectedDraftVersion: intakeDraftVersion(plan(state).intakeDraft), ...fields }, LATER); }
const consumed = (mealId, quantity, fields = {}) => ({ mealId, lineId: `${mealId}-rice`, quantity, unit: 'g', ...fields });
const transfer = (fromMealId, toMealId, quantity, id = `transfer-${++sequence}`) => ({ id, fromMealId, lineId: `${fromMealId}-rice`, toMealId, quantity, unit: 'g' });
const nutrient = (totals, key = 'kcal') => totals.find(total => total.key === key).value;
const row = (view, mealId, lineId = `${mealId}-rice`) => view.meals.find(meal => meal.id === mealId).rows.find(row => row.lineId === lineId);
function actual(state, mealId, quantity, id = `chat-${mealId}`) { return mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId, entries: [{ id, itemId: 'rice', quantity, unit: 'g', sourceText: `用户实际${quantity}g` }] }); }

test('cloud draft previews partial intake and remaining without changing menu, facts, supplements or stock; reload and targeted Chat reads preserve it', () => {
  const initial = fixture(), before = copy(initial), input = draft(initial, { consumed: [consumed('lunch', 30)], transfers: [transfer('lunch', 'dinner', 40)] });
  const state = save(initial, input), p = plan(state), view = intakeDraftView(p, state.items);
  assert.deepEqual(initial, before); assert.deepEqual(state.items, before.items); assert.deepEqual(p.meals, plan(before).meals);
  assert.deepEqual(p.supplementDoses, plan(before).supplementDoses); assert.equal(view.canSubmit, true);
  assert.equal(row(view, 'lunch').plannedQuantity, 60); assert.equal(row(view, 'lunch').eatenQuantity, 30); assert.equal(row(view, 'lunch').remainingQuantity, 30);
  assert.equal(view.dayRows[0].plannedQuantity, 400); assert.equal(view.dayRows[0].eatenQuantity, 30); assert.equal(view.dayRows[0].remainingQuantity, 370);
  assert.equal(nutrient(view.totals.eaten), 60); assert.equal(nutrient(view.totals.remaining), 740);
  const restored = JSON.parse(JSON.stringify(state)); assert.deepEqual(intakeDraftView(plan(restored), restored.items), view);
  assert.equal(readIntakeDraft(restored, { date: p.date }).draft.id, input.id);
  assert.equal(readIntakeDraft(restored, { planId: p.id, mealIds: ['lunch'] }).meals.length, 1);
  assert.equal(readDietRecords(restored, { planId: p.id }).intakeDraftState.draftIsActual, false);
  assert.throws(() => readIntakeDraft(restored, { date: '2026-10-25' }), { code: 'PLAN_NOT_FOUND' });
});

test('supplement checking leaves food draft valid; full and incremental Chat menu edits retain it as explicitly stale', () => {
  let state = fixture(); const input = draft(state, { consumed: [consumed('lunch', 30)] }); state = save(state, input);
  state = mutate(state, 'set_daily_supplement_check', { date: plan(state).date, doseId: 'creatine-am', checked: true });
  assert.equal(intakeDraftView(plan(state), state.items).stale, false); assert.equal(stock(state), 1000); assert.equal(stock(state, 'creatine'), 995);
  const facts = copy(plan(state).supplementDoses);
  state = mutate(state, 'save_meal_plan_draft', { plan: { ...menu(), title: '更新', meals: menu().meals.map(meal => meal.id === 'dinner' ? { ...meal, plannedItems: [{ ...meal.plannedItems[0], quantity: 120 }] } : meal) } });
  assert.equal(plan(state).intakeDraft.id, input.id); assert.equal(intakeDraftView(plan(state), state.items).stale, true); assert.deepEqual(plan(state).supplementDoses, facts);
  const before = copy(state); assert.throws(() => submit(state), { code: 'INTAKE_DRAFT_STALE' }); assert.deepEqual(state, before);
  state = mutate(state, 'discard_intake_draft', { planId: plan(state).id, draftId: input.id, expectedDraftVersion: intakeDraftVersion(plan(state).intakeDraft) });
  assert.equal(plan(state).intakeDraft, undefined); assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).meals, plan(before).meals);
  state = save(state, draft(state, { consumed: [consumed('lunch', 20)] }));
  state = mutate(state, 'patch_meal_plan', { planId: plan(state).id, mode: 'draft', mealPatches: [{ id: 'lunch', plannedTime: '13:00' }] });
  assert.equal(intakeDraftView(plan(state), state.items).stale, true);
});

test('one submit atomically redistributes leftovers and accounts only actual quantity; network retry and operation-ID conflict cannot debit twice', () => {
  let state = fixture(); state = save(state, draft(state, { consumed: [consumed('lunch', 30)], transfers: [transfer('lunch', 'dinner', 40)] }));
  const input = { action: 'submit_intake_draft', planId: plan(state).id, draftId: plan(state).intakeDraft.id, baseFingerprint: plan(state).intakeDraft.baseFingerprint, expectedDraftVersion: intakeDraftVersion(plan(state).intakeDraft), expectedRevision: state.revision, operationId: 'submit-once' };
  state = applyMutation(state, input, LATER); assert.equal(stock(state), 970); assert.equal(plan(state).intakeDraft, undefined);
  assert.equal(plan(state).meals[1].plannedItems[0].quantity, 60); assert.equal(plan(state).meals[3].plannedItems.length, 2);
  assert.equal(plan(state).meals[1].actualEntries[0].quantity, 30); assert.equal(plan(state).meals[1].state, 'in_progress');
  assert.equal(plan(state).intakeDraftAudit.length, 1); assert.equal(nutrient(planNutritionTotals(plan(state))), 810);
  assert.equal(applyMutation(state, input, LATER), state);
  assert.throws(() => applyMutation(state, { ...input, draftId: 'different' }, LATER), { code: 'OPERATION_ID_CONFLICT' });
  assert.throws(() => submit(state, { draftId: 'gone', baseFingerprint: 'gone' }));
});

test('continuous cumulative edits add or refund only the delta and retain correction audit', () => {
  let state = fixture();
  for (const quantity of [30, 50, 20, 140]) { state = submit(save(state, draft(state, { consumed: [consumed('lunch', quantity)] }))); assert.equal(stock(state), 1000 - quantity); }
  const entry = plan(state).meals[1].actualEntries[0]; assert.equal(entry.id, intakeEntryId(plan(state).id, 'lunch', 'lunch-rice')); assert.equal(entry.quantity, 140);
  assert.equal(entry.correctionHistory.length, 3); assert.equal(row(intakeDraftView(plan(state), state.items), 'lunch').remainingQuantity, 0);
});

test('pre-eating a later meal transfers only remaining food before recording it once in current meal', () => {
  let state = fixture(); const t = transfer('dinner', 'lunch', 60);
  state = submit(save(state, draft(state, { transfers: [t], consumed: [{ mealId: 'lunch', lineId: intakeTransferLineId(plan(state).id, t.id), quantity: 60, unit: 'g' }] })));
  const view = intakeDraftView(plan(state), state.items); assert.equal(stock(state), 940); assert.equal(row(view, 'dinner').remainingQuantity, 40);
  assert.equal(view.dayRows[0].eatenQuantity, 60); assert.equal(view.dayRows[0].remainingQuantity, 340); assert.equal(nutrient(view.totals.eaten), 120);
  assert.equal(nutrient(planNutritionTotals(plan(state))), 810);
});

test('consumed quantities and over-transfer input fail atomically; revision conflict also leaves everything unchanged', () => {
  let state = actual(fixture(), 'lunch', 70); const before = copy(state);
  const bad = draft(state, { transfers: [transfer('lunch', 'dinner', 31)] }); assert.equal(intakeDraftView(plan(state), state.items, bad).canSubmit, false);
  assert.throws(() => save(state, bad), { code: 'INTAKE_TRANSFER_EXCEEDS_REMAINING' }); assert.deepEqual(state, before);
  assert.throws(() => save(state, draft(state, { consumed: [consumed('lunch', -1)] })));
  assert.throws(() => mutate(state, 'save_intake_draft', { planId: plan(state).id, draft: draft(state), expectedRevision: state.revision - 1 }), { code: 'REVISION_CONFLICT' }); assert.deepEqual(state, before);
});

test('lowering external Chat actual requires explicit confirmation and corrects same ID with history rather than erasing the fact', () => {
  let state = actual(fixture(), 'lunch', 70); const before = copy(state);
  assert.throws(() => save(state, draft(state, { consumed: [consumed('lunch', 40)] })), { code: 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED' }); assert.deepEqual(state, before);
  state = submit(save(state, draft(state, { consumed: [consumed('lunch', 40, { correctExistingActuals: true })] })));
  assert.equal(stock(state), 960); const entry = plan(state).meals[1].actualEntries.find(entry => entry.id === 'chat-lunch'); assert.equal(entry.quantity, 40);
  assert.equal(entry.correctionHistory[0].quantity, 70); assert.equal(entry.correctionHistory[0].sourceText, '用户实际70g');
});

test('same-SKU ambiguous Chat actual is counted once and cannot be silently assigned or reduced', () => {
  const input = menu(); input.meals[1].plannedItems.push({ id: 'lunch-rice-second', itemId: 'rice', quantity: 50 });
  let state = actual(fixture(undefined, input), 'lunch', 30); const view = intakeDraftView(plan(state), state.items);
  assert.equal(view.dayRows[0].eatenQuantity, 30); assert.equal(nutrient(view.totals.eaten), 60);
  assert.equal(view.meals[1].rows.filter(row => !row.canEdit).length, 3);
  assert.throws(() => save(state, draft(state, { consumed: [consumed('lunch', 20, { correctExistingActuals: true })] })), { code: 'INTAKE_ACTUAL_REQUIRES_REVIEW' });
});

test('completed meals can send and receive unconsumed plans without inventing a new actual report', () => {
  let state = actual(fixture(), 'lunch', 30); state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'lunch', mode: 'complete', sourceText: '午餐结束，剩下留晚餐' });
  state = submit(save(state, draft(state, { transfers: [transfer('lunch', 'dinner', 70)] })));
  assert.equal(stock(state), 970); assert.equal(plan(state).meals[1].state, 'completed'); assert.equal(plan(state).meals[1].plannedItems[0].quantity, 30);
  const before = copy(state), t = transfer('dinner', 'lunch', 10);
  state = submit(save(state, draft(state, { transfers: [t] })));
  assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).meals[1].actualEntries, plan(before).meals[1].actualEntries);
  assert.equal(plan(state).meals[1].state, 'completed');
  assert.equal(row(intakeDraftView(plan(state), state.items), 'lunch', intakeTransferLineId(plan(state).id, t.id)).remainingQuantity, 10);
  state = submit(save(state, draft(state, { consumed: [{ mealId: 'lunch', lineId: intakeTransferLineId(plan(state).id, t.id), quantity: 10, unit: 'g' }] })));
  assert.equal(stock(state), 960); assert.equal(plan(state).meals[1].state, 'completed');
});

test('explicit meal completion does not imply quantities and never clears earlier completed facts', () => {
  let state = fixture(); const before = copy(state);
  assert.throws(() => submit(save(state, draft(state, { completedMealIds: ['lunch'] }))), { code: 'ACTUAL_CONTENT_REQUIRED' }); assert.deepEqual(state, before);
  state = submit(save(state, draft(state, { consumed: [consumed('lunch', 40)], completedMealIds: ['lunch'] })));
  state = submit(save(state, draft(state, { consumed: [consumed('dinner', 20)], completedMealIds: [] })));
  assert.equal(plan(state).meals[1].state, 'completed'); assert.equal(plan(state).meals[3].state, 'in_progress'); assert.equal(stock(state), 940);
});

test('UI partial intake followed by Chat complete matched to the plan tops up the stable entry; subsequent complete under new operation ID is safe', () => {
  let state = submit(save(fixture(), draft(fixture(), { consumed: [consumed('lunch', 30)] })));
  const id = plan(state).meals[1].actualEntries[0].id;
  const payload = { planId: plan(state).id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '午餐按计划吃完' };
  state = mutate(state, 'record_meal_intake', payload); assert.equal(stock(state), 900); assert.equal(plan(state).meals[1].actualEntries.length, 1);
  assert.equal(plan(state).meals[1].actualEntries[0].id, id); assert.equal(plan(state).meals[1].actualEntries[0].intakeLineId, 'lunch-rice');
  state = mutate(state, 'record_meal_intake', { ...payload, sourceText: '再次确认午餐按计划吃完' }, LATER);
  assert.equal(stock(state), 900); assert.equal(plan(state).meals[1].actualEntries.length, 1); assert.equal(plan(state).meals[1].actualEntries[0].quantity, 100);
});

test('Chat matched completion still rejects a partial actual with a different frozen portion or different actual food', () => {
  let state = submit(save(fixture(), draft(fixture(), { consumed: [consumed('lunch', 30)] })));
  plan(state).meals[1].actualEntries[0].nutritionSnapshot.nutrition.kcal = 222; const before = copy(state);
  assert.throws(() => mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '吃完' }), { code: 'ACTUAL_ID_CONFLICT' }); assert.deepEqual(state, before);
});

test('frozen bag grams and mL are displayed and saved using original stock units even after current inventory package data changes', () => {
  const input = menu(); input.meals[1].plannedItems = [{ id: 'beef-l', itemId: 'beef', quantity: 1 }]; input.meals[3].plannedItems = [{ id: 'milk-d', itemId: 'milk', quantity: 200 }];
  let state = fixture([item('rice'), item('creatine'), item('beef', 10, '袋', 132), item('milk', 1000, 'ml')], input);
  state.items.find(item => item.id === 'beef').gramsPerUnit = 999;
  const view = intakeDraftView(plan(state), state.items); assert.equal(row(view, 'lunch', 'beef-l').unit, 'g'); assert.equal(row(view, 'lunch', 'beef-l').plannedQuantity, 132);
  assert.equal(row(view, 'dinner', 'milk-d').unit, 'mL');
  state = submit(save(state, draft(state, { consumed: [{ mealId: 'lunch', lineId: 'beef-l', quantity: 66, unit: 'g' }, { mealId: 'dinner', lineId: 'milk-d', quantity: 120, unit: 'mL' }] })));
  assert.equal(stock(state, 'beef'), 9.5); assert.equal(stock(state, 'milk'), 880); assert.equal(plan(state).meals[1].actualEntries[0].quantity, 0.5);
  assert.equal(plan(state).meals[1].actualEntries[0].nutritionSnapshot.gramsPerUnit, 132);
  const after = intakeDraftView(plan(state), state.items); assert.equal(row(after, 'lunch', 'beef-l').eatenQuantity, 66);
});

test('actual weighed packages with a different frozen weight retain raw package-unit meaning and never inherit a planned gram conversion', () => {
  const input = menu(); input.meals[1].plannedItems = [{ id: 'beef-l', itemId: 'beef', quantity: 1 }];
  let state = fixture([item('rice'), item('creatine'), item('beef', 10, '袋', 132)], input);
  state = mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'lunch', entries: [{ id: 'weighed', itemId: 'beef', quantity: 1, unit: '袋', sourceText: '实称130g一袋' }] });
  plan(state).meals[1].actualEntries[0].nutritionSnapshot.gramsPerUnit = 130;
  const view = intakeDraftView(plan(state), state.items); assert.equal(row(view, 'lunch', 'beef-l').unit, '袋'); assert.equal(row(view, 'lunch', 'beef-l').eatenQuantity, 1);
  assert.throws(() => save(state, draft(state, { consumed: [{ mealId: 'lunch', lineId: 'beef-l', quantity: 100, unit: 'g', correctExistingActuals: true }] })), { code: 'INTAKE_UNIT_CONFLICT' });
});

test('unknown external quantities remain facts and block guessing, while own unknown reports can be explicitly corrected later', () => {
  let state = actual(fixture(), 'lunch', null); const view = intakeDraftView(plan(state), state.items); assert.equal(row(view, 'lunch').eatenQuantity, null); assert.equal(row(view, 'lunch').canEdit, false);
  assert.throws(() => save(state, draft(state, { consumed: [consumed('lunch', 20, { correctExistingActuals: true })] })), { code: 'INTAKE_ACTUAL_REQUIRES_REVIEW' });
  state = fixture(); state = submit(save(state, draft(state, { consumed: [consumed('lunch', null)] })));
  assert.equal(plan(state).inventoryAccounting, 'pending_reconciliation'); assert.equal(stock(state), 1000);
  state = submit(save(state, draft(state, { consumed: [consumed('lunch', 20)] })));
  assert.equal(stock(state), 980); assert.equal(plan(state).inventoryAccounting, 'settled');
});

test('food shortage saves full actual facts and its shortfall, while transfer-only submit never recharges it after a recount', () => {
  let state = fixture([item('rice', 10), item('creatine')]); state = submit(save(state, draft(state, { consumed: [consumed('lunch', 30), consumed('dinner', 20)] })));
  assert.equal(stock(state), 0); assert.equal(plan(state).inventoryAccounting, 'settled'); assert.equal(plan(state).meals[1].actualEntries[0].quantity, 30);
  assert.equal(plan(state).accountedDebits.find(line => line.itemId === 'rice').shortfallQuantity, 40);
  state = mutate(state, 'set_quantity', { id: 'rice', quantity: 100 }, LATER);
  const before = copy(state.items), issues = copy(plan(state).accountingIssues), debits = copy(plan(state).accountedDebits), history = copy(plan(state).accountingAdjustmentHistory);
  state = submit(save(state, draft(state, { transfers: [transfer('lunch', 'dinner', 10)] })));
  assert.deepEqual(state.items, before); assert.deepEqual(plan(state).accountingIssues, issues); assert.deepEqual(plan(state).accountedDebits, debits); assert.equal(plan(state).inventoryAccounting, 'settled');
  assert.deepEqual(plan(state).accountingAdjustmentHistory, history);
});

test('legacy reserved credits remain untouched by draft/save/redistribution; a real completion releases only its historical difference', () => {
  let state = fixture(); const p = plan(state); p.status = 'reserved'; delete p.foodAccounting; delete p.supplementAccounting;
  const credit = { itemId: 'rice', quantity: 400, unit: 'g', name: 'rice', baselineToken: state.items[0].quantityBaselineToken, unknownBalance: false };
  p.accountedDebits = [copy(credit)]; p.items = [copy(credit)]; state.items[0].quantity -= 400;
  const before = copy(state.items);
  state = save(state, draft(state, { transfers: [transfer('lunch', 'dinner', 40)] })); assert.deepEqual(state.items, before);
  state = submit(state); assert.deepEqual(state.items, before); assert.deepEqual(plan(state).accountedDebits, [credit]); assert.equal(plan(state).legacyReservations.meals[1].plannedItems[0].quantity, 100);
  state = submit(save(state, draft(state, { consumed: [consumed('lunch', 30)], completedMealIds: ['lunch'] })));
  assert.equal(stock(state), 670); assert.equal(plan(state).accountedDebits[0].quantity, 330);
});

test('cancelled and closed views preserve actual nutrition as read-only facts, without inventing remaining food or hiding records', () => {
  let state = actual(fixture(), 'lunch', 30); plan(state).status = 'cancelled'; for (const meal of plan(state).meals) meal.state = 'cancelled';
  const before = copy(state), view = intakeDraftView(plan(state), state.items); assert.equal(nutrient(view.totals.eaten), 60);
  assert.equal(row(view, 'lunch').eatenQuantity, 30); assert.equal(row(view, 'lunch').remainingQuantity, 0); assert.equal(row(view, 'lunch').canEdit, false);
  assert.deepEqual(state, before); assert.throws(() => save(state, draft(state, { consumed: [consumed('lunch', 20)] })), { code: 'PLAN_CLOSED' });
  plan(state).status = 'closed_with_actuals'; assert.equal(nutrient(intakeDraftView(plan(state), state.items).totals.eaten), 60);
});

test('draft compare-and-swap rejects another device replacing, editing, submitting or discarding a newer cloud draft even after global revision refresh', () => {
  let state = fixture(); const starting = intakeDraftView(plan(state), state.items), first = draft(state, { consumed: [consumed('lunch', 20)] });
  state = save(state, first); const oldVersion = intakeDraftVersion(plan(state).intakeDraft);
  assert.equal(intakeDraftVersion(first), oldVersion); assert.equal(intakeDraftView(plan(state), state.items).draftVersion, oldVersion);
  const next = { ...first, consumed: [consumed('lunch', 30)] }; state = save(state, next); const before = copy(state);
  for (const [action, fields] of [
    ['save_intake_draft', { draft: first, expectedDraftVersion: oldVersion }],
    ['submit_intake_draft', { draftId: first.id, baseFingerprint: first.baseFingerprint, expectedDraftVersion: oldVersion }],
    ['discard_intake_draft', { draftId: first.id, expectedDraftVersion: oldVersion }],
    ['save_intake_draft', { draft: { ...first, id: 'other-device' }, expectedDraftVersion: starting.draftVersion }],
    ['save_intake_draft', { draft: first }],
  ]) assert.throws(() => mutate(state, action, { planId: plan(state).id, ...fields }), { code: 'INTAKE_DRAFT_CONFLICT' });
  assert.deepEqual(state, before); assert.equal(stock(state), 1000);
  const precision = { ...next, id: '  canonical-id  ', consumed: [{ ...consumed('lunch', 12.34567891), unit: ' g ' }] };
  const stored = save(state, precision); assert.equal(intakeDraftVersion(precision), intakeDraftVersion(plan(stored).intakeDraft));
});

test('Chat extra food retains one cumulative virtual row across UI submit, refresh and subsequent cumulative correction', () => {
  const input = menu(); input.meals[1].plannedItems = [];
  let state = actual(fixture(undefined, input), 'lunch', 30); const lineId = intakeDraftView(plan(state), state.items).meals[1].rows[0].lineId;
  for (const quantity of [50, 60]) {
    state = submit(save(state, draft(state, { consumed: [{ mealId: 'lunch', lineId, quantity, unit: 'g' }] })));
    state = JSON.parse(JSON.stringify(state)); const view = intakeDraftView(plan(state), state.items);
    assert.equal(view.meals[1].rows.length, 1); assert.equal(view.meals[1].rows[0].eatenQuantity, quantity);
    assert.equal(view.dayRows[0].eatenQuantity, quantity); assert.equal(nutrient(view.totals.eaten), quantity * 2); assert.equal(stock(state), 1000 - quantity);
  }
});

test('mixed external Chat and UI actuals never get recopied by matched completion; a cumulative completion preserves external evidence and settles only remaining', () => {
  let state = actual(fixture(), 'lunch', 30); state = submit(save(state, draft(state, { consumed: [consumed('lunch', 50)] })));
  const before = copy(state); assert.throws(() => mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '午餐吃完' }), { code: 'ACTUAL_PLAN_DUPLICATION' }); assert.deepEqual(state, before);
  state = submit(save(state, draft(state, { consumed: [consumed('lunch', 100)], completedMealIds: ['lunch'] })));
  assert.equal(stock(state), 900); assert.equal(plan(state).meals[1].actualEntries.length, 2);
  assert.equal(plan(state).meals[1].actualEntries.find(entry => entry.id === 'chat-lunch').quantity, 30);
  assert.equal(plan(state).meals[1].state, 'completed'); assert.equal(row(intakeDraftView(plan(state), state.items), 'lunch').eatenQuantity, 100);
});
