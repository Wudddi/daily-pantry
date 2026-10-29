import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { intakeDraftView, intakePlanFingerprint } from '../lib/intake-draft.mjs';
import { buildChecklistAction } from '../lib/checklist-actions.mjs';

const NOW = '2026-10-26T16:00:00.000Z', LATER = '2026-10-26T18:00:00.000Z';
const clone = value => structuredClone(value);
let sequence = 0;
function food(id, quantity = 1000, unit = 'g', gramsPerUnit = null) {
  return validateItem({ id, name: id, quantity, unit, gramsPerUnit, category: id === 'creatine' ? 'supplement' : 'prepared',
    nutrition: { basisAmount: 100, basisUnit: unit === '袋' ? 'g' : unit, kcal: 200, protein: 20, carbs: 10, fat: 5, source: 'label' } }, NOW);
}
function menu() { return { id: 'daily-food-2026-10-26', date: '2026-10-26', title: '本机验证清单四餐',
  meals: ['breakfast', 'lunch', 'snack', 'dinner'].map(id => ({ id, slot: id, title: id,
    plannedItems: [{ id: `${id}-rice`, itemId: 'rice', quantity: 100 }] })),
  supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, timingSlot: 'breakfast' }] }; }
function mutation(state, action, fields = {}, at = NOW) {
  return applyMutation(state, { action, expectedRevision: state.revision, operationId: `checklist-test-${++sequence}`, ...fields }, at);
}
function fixture(foods = [food('rice'), food('creatine')], input = menu()) {
  return mutation({ schemaVersion: 1, revision: 0, updatedAt: NOW, items: foods, plans: [], events: [], operationIds: [], preferences: [] }, 'save_meal_plan_draft', { plan: input });
}
const plan = state => state.plans[0];
const stock = (state, id = 'rice') => state.items.find(item => item.id === id).quantity;
const consumed = (mealId, quantity, fields = {}) => ({ mealId, lineId: `${mealId}-rice`, quantity, unit: 'g', ...fields });
function draft(state, fields = {}) { return { id: `checklist-draft-${++sequence}`, baseFingerprint: intakePlanFingerprint(plan(state), state.items), consumed: [], transfers: [], completedMealIds: [], ...fields }; }
function check(state, input, fields = {}) { return mutation(state, 'apply_checklist_intake', { planId: plan(state).id, draft: input, expectedDraftVersion: null, ...fields }, LATER); }

test('one food check is one atomic revision/event and immediately saves actual without leaving a cloud draft', () => {
  const before = fixture(), untouched = clone(before);
  const state = check(before, draft(before, { consumed: [consumed('lunch', 100)] }));
  assert.deepEqual(before, untouched); assert.equal(state.revision, before.revision + 1);
  assert.equal(state.events.length, before.events.length + 1); assert.equal(state.operationIds.length, before.operationIds.length + 1);
  assert.equal(stock(state), 900); assert.equal(plan(state).intakeDraft, undefined); assert.equal(plan(state).intakeDraftAudit.length, 1);
  assert.equal(plan(state).meals[1].actualEntries.length, 1); assert.equal(plan(state).meals[1].actualEntries[0].quantity, 100);
  assert.deepEqual(plan(state).supplementDoses, plan(before).supplementDoses); assert.equal(stock(state, 'creatine'), 1000);
});

test('whole meal check records all food and completion atomically, preserving other meals and supplements', () => {
  const input = menu(); input.meals[1].plannedItems.push({ id: 'lunch-milk', itemId: 'milk', quantity: 150 });
  const before = fixture([food('rice'), food('creatine'), food('milk', 1000, 'ml')], input);
  const state = check(before, draft(before, { consumed: [consumed('lunch', 100), { mealId: 'lunch', lineId: 'lunch-milk', quantity: 150, unit: 'mL' }], completedMealIds: ['lunch'] }));
  assert.equal(stock(state), 900); assert.equal(stock(state, 'milk'), 850); assert.equal(plan(state).meals[1].state, 'completed');
  assert.equal(plan(state).meals[1].actualEntries.length, 2); assert.equal(state.revision, before.revision + 1);
  for (const index of [0, 2, 3]) assert.deepEqual(plan(state).meals[index], plan(before).meals[index]);
});

test('same network operation retry and same cumulative target under a new operation do not debit twice', () => {
  const before = fixture(), value = draft(before, { consumed: [consumed('lunch', 100)] });
  const payload = { action: 'apply_checklist_intake', expectedRevision: before.revision, operationId: 'check-once', planId: plan(before).id, draft: value, expectedDraftVersion: null };
  let state = applyMutation(before, payload, NOW), entryId = plan(state).meals[1].actualEntries[0].id;
  assert.equal(applyMutation(state, payload, LATER), state);
  assert.throws(() => applyMutation(state, { ...payload, draft: { ...value, consumed: [consumed('lunch', 99)] } }), { code: 'OPERATION_ID_CONFLICT' });
  state = check(state, draft(state, { consumed: [consumed('lunch', 100)] }));
  assert.equal(stock(state), 900); assert.equal(plan(state).meals[1].actualEntries.length, 1); assert.equal(plan(state).meals[1].actualEntries[0].id, entryId);
});

test('failed completion, stale revision or fingerprint cannot leave an intermediate cloud draft or consume food', () => {
  let state = fixture(), before = clone(state);
  assert.throws(() => check(state, draft(state, { completedMealIds: ['lunch'] })), { code: 'ACTUAL_CONTENT_REQUIRED' }); assert.deepEqual(state, before);
  assert.throws(() => check(state, draft(state, { consumed: [consumed('lunch', 100)] }), { expectedRevision: state.revision - 1 }), { code: 'REVISION_CONFLICT' }); assert.deepEqual(state, before);
  const stale = draft(state, { consumed: [consumed('lunch', 100)] });
  state = mutation(state, 'patch_meal_plan', { planId: plan(state).id, mode: 'draft', mealPatches: [{ id: 'lunch', itemPatches: [{ id: 'lunch-rice', quantity: 120 }] }] }); before = clone(state);
  assert.throws(() => check(state, stale), { code: 'INTAKE_DRAFT_STALE' }); assert.deepEqual(state, before);
});

test('pending cloud drafts cannot be submitted, replaced or hidden by a quick check', () => {
  let state = fixture(), value = draft(state, { consumed: [consumed('breakfast', 40)] });
  state = mutation(state, 'save_intake_draft', { planId: plan(state).id, draft: value, expectedDraftVersion: null });
  const before = clone(state);
  assert.throws(() => check(state, draft(state, { consumed: [consumed('lunch', 100)] })), { code: 'INTAKE_DRAFT_PENDING' }); assert.deepEqual(state, before); assert.equal(stock(state), 1000);
  state = fixture();
  for (const token of ['other-cloud-version', undefined]) {
    const payload = { action: 'apply_checklist_intake', operationId: `missing-token-${++sequence}`, expectedRevision: state.revision, planId: plan(state).id, draft: draft(state, { consumed: [consumed('lunch', 100)] }), ...(token !== undefined ? { expectedDraftVersion: token } : {}) };
    assert.throws(() => applyMutation(state, payload, NOW), { code: 'INTAKE_DRAFT_CONFLICT' });
  }
});

test('unknown checkbox quantities and unknown external actual cannot be guessed by a quick check', () => {
  let state = fixture(), before = clone(state);
  assert.throws(() => check(state, draft(state, { consumed: [consumed('lunch', null)] })), { code: 'CHECKLIST_QUANTITY_REQUIRED' }); assert.deepEqual(state, before);
  state = mutation(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'lunch', entries: [{ id: 'unknown-chat', itemId: 'rice', quantity: null, unit: 'g', sourceText: '用户已吃，数量未报' }] }); before = clone(state);
  assert.throws(() => check(state, draft(state, { consumed: [consumed('lunch', 100)] })), { code: 'INTAKE_ACTUAL_REQUIRES_REVIEW' }); assert.deepEqual(state, before);
});

test('moving unconsumed food only redistributes planned amounts and frozen nutrition without inventory debit', () => {
  const before = fixture();
  const state = check(before, draft(before, { transfers: [{ id: 'lunch-leftovers', fromMealId: 'lunch', lineId: 'lunch-rice', toMealId: 'dinner', quantity: 40, unit: 'g' }] }));
  assert.deepEqual(state.items, before.items); assert.equal(plan(state).meals[1].plannedItems[0].quantity, 60);
  assert.equal(plan(state).meals[3].plannedItems.length, 2); assert.equal(plan(state).meals[3].plannedItems[1].quantity, 40);
  assert.deepEqual(plan(state).meals[3].plannedItems[1].nutritionSnapshot, plan(before).meals[1].plannedItems[0].nutritionSnapshot);
  assert(plan(state).meals.every(meal => meal.actualEntries.length === 0)); assert.equal(intakeDraftView(plan(state), state.items).dayRows[0].plannedQuantity, 400);
});

test('partial edit transfers its remaining food while accounting only actual, and further correction refunds only the difference', () => {
  let state = fixture(); state = check(state, draft(state, { consumed: [consumed('lunch', 60)], transfers: [{ id: 'leftover40', fromMealId: 'lunch', lineId: 'lunch-rice', toMealId: 'dinner', quantity: 40, unit: 'g' }] }));
  assert.equal(stock(state), 940); assert.equal(plan(state).meals[1].plannedItems[0].quantity, 60);
  const entryId = plan(state).meals[1].actualEntries[0].id;
  state = check(state, draft(state, { consumed: [consumed('lunch', 45)] })); assert.equal(stock(state), 955);
  assert.equal(plan(state).meals[1].actualEntries[0].id, entryId); assert.equal(plan(state).meals[1].actualEntries[0].correctionHistory[0].quantity, 60);
});

test('an explicit correction preserves external actual ID and audit; unconfirmed overwrite is atomic refusal', () => {
  let state = fixture(); state = mutation(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'lunch', entries: [{ id: 'external-chat', itemId: 'rice', quantity: 70, unit: 'g', sourceText: '午餐吃了70g' }] });
  const before = clone(state); assert.throws(() => check(state, draft(state, { consumed: [consumed('lunch', 40)] })), { code: 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED' }); assert.deepEqual(state, before);
  state = check(state, draft(state, { consumed: [consumed('lunch', 40, { correctExistingActuals: true })] }));
  assert.equal(stock(state), 960); const entry = plan(state).meals[1].actualEntries.find(entry => entry.id === 'external-chat');
  assert.equal(entry.quantity, 40); assert.equal(entry.correctionHistory[0].quantity, 70); assert.equal(entry.correctionHistory[0].sourceText, '午餐吃了70g');
});

test('bag gram conversion uses frozen planned portion even when live inventory grams per package changes', () => {
  const input = menu(); input.meals[1].plannedItems = [{ id: 'beef-l', itemId: 'beef', quantity: 1 }];
  let state = fixture([food('rice'), food('creatine'), food('beef', 10, '袋', 132)], input); state.items.find(item => item.id === 'beef').gramsPerUnit = 999;
  state = check(state, draft(state, { consumed: [{ mealId: 'lunch', lineId: 'beef-l', quantity: 66, unit: 'g' }] }));
  assert.equal(stock(state, 'beef'), 9.5); assert.equal(plan(state).meals[1].actualEntries[0].quantity, .5); assert.equal(plan(state).meals[1].actualEntries[0].nutritionSnapshot.gramsPerUnit, 132);
});

test('food shortage retains full actual facts and an audited shortfall; pure transfer never recharges it after a recount', () => {
  let state = fixture([food('rice', 10), food('creatine')]);
  state = check(state, draft(state, { consumed: [consumed('lunch', 30), consumed('dinner', 20)] }));
  assert.equal(stock(state), 0); assert.equal(plan(state).inventoryAccounting, 'settled'); assert.equal(plan(state).meals[1].actualEntries[0].quantity, 30);
  assert.equal(plan(state).accountedDebits.find(line => line.itemId === 'rice').shortfallQuantity, 40);
  state = mutation(state, 'set_quantity', { id: 'rice', quantity: 100 }, LATER);
  const before = clone(state), issues = clone(plan(state).accountingIssues), history = clone(plan(state).accountingAdjustmentHistory);
  state = check(state, draft(state, { transfers: [{ id: 'pending-transfer', fromMealId: 'lunch', lineId: 'lunch-rice', toMealId: 'dinner', quantity: 10, unit: 'g' }] }));
  assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).accountingIssues, issues); assert.deepEqual(plan(state).accountedDebits, plan(before).accountedDebits);
  assert.deepEqual(plan(state).accountingAdjustmentHistory, history);
});

test('legacy credits are retained and only actual completion difference is settled; cancelled menus stay protected', () => {
  let state = fixture(); const p = plan(state); p.status = 'reserved'; delete p.foodAccounting; delete p.supplementAccounting;
  const credit = { itemId: 'rice', quantity: 400, unit: 'g', name: 'rice', baselineToken: state.items[0].quantityBaselineToken, unknownBalance: false };
  p.items = [clone(credit)]; p.accountedDebits = [clone(credit)]; state.items[0].quantity = 600;
  state = check(state, draft(state, { consumed: [consumed('lunch', 30)], completedMealIds: ['lunch'] })); assert.equal(stock(state), 670); assert.equal(plan(state).accountedDebits[0].quantity, 330);
  state = fixture(); plan(state).status = 'cancelled'; for (const meal of plan(state).meals) meal.state = 'cancelled'; const before = clone(state);
  assert.throws(() => check(state, draft(state, { consumed: [consumed('lunch', 100)] })), { code: 'PLAN_CLOSED' }); assert.deepEqual(state, before);
});

test('undo retry refunds a completed meal once, preserves actual IDs and history, and repeated desired zero is harmless', () => {
  let state = fixture(); state = check(state, draft(state, { consumed: [consumed('lunch', 100)], completedMealIds: ['lunch'] }));
  const previous = clone(plan(state).meals[1]), command = buildChecklistAction(plan(state), state.items,
    { type: 'undo_meal', mealId: 'lunch', correctExistingActuals: true }, { draftId: 'undo-completed-meal' });
  const payload = { action: 'apply_checklist_intake', operationId: 'undo-once', expectedRevision: state.revision,
    planId: plan(state).id, draft: command.draft, expectedDraftVersion: null };
  state = applyMutation(state, payload, LATER); const revision = state.revision;
  assert.equal(stock(state), 1000); assert.equal(plan(state).meals[1].state, 'completed');
  assert.equal(plan(state).meals[1].completionReportedAt, previous.completionReportedAt);
  assert.equal(plan(state).meals[1].actualEntries[0].id, previous.actualEntries[0].id);
  assert.equal(plan(state).meals[1].actualEntries[0].quantity, 0);
  assert.equal(plan(state).meals[1].actualEntries[0].correctionHistory.at(-1).quantity, 100);
  assert.deepEqual(plan(state).meals[1].reportHistory.slice(0, previous.reportHistory.length), previous.reportHistory);
  assert.equal(applyMutation(state, payload, LATER), state); assert.equal(state.revision, revision);
  assert.equal(buildChecklistAction(plan(state), state.items, { type: 'undo_meal', mealId: 'lunch', correctExistingActuals: true }, { draftId: 'another-undo' }).noChange, true);
  assert.equal(stock(state, 'creatine'), 1000);
});

test('legacy completion undone then drag and recheck uses the existing reservation credit without a new planned debit', () => {
  let state = fixture(); const p = plan(state); p.status = 'reserved'; delete p.foodAccounting; delete p.supplementAccounting;
  const credit = { itemId: 'rice', quantity: 400, unit: 'g', name: 'rice', baselineToken: state.items[0].quantityBaselineToken, unknownBalance: false };
  p.items = [clone(credit)]; p.accountedDebits = [clone(credit)]; state.items[0].quantity = 600;
  const quick = action => {
    const value = buildChecklistAction(plan(state), state.items, action, { draftId: `legacy-toggle-${++sequence}` });
    state = value.noChange ? state : check(state, value.draft);
  };
  quick({ type: 'complete_meal', mealId: 'lunch' }); assert.equal(stock(state), 600);
  quick({ type: 'undo_meal', mealId: 'lunch', correctExistingActuals: true }); assert.equal(stock(state), 700);
  const accounting = clone(plan(state).accountedDebits), supplements = clone(plan(state).supplementDoses);
  quick({ type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-rice'], toMealId: 'lunch', quantity: 25 });
  assert.equal(stock(state), 700); assert.deepEqual(plan(state).accountedDebits, accounting); assert.deepEqual(plan(state).supplementDoses, supplements);
  assert.equal(plan(state).meals[1].state, 'completed');
  assert.equal(intakeDraftView(plan(state), state.items).meals[1].rows.reduce((sum, row) => sum + row.remainingQuantity, 0), 125);
  quick({ type: 'complete_meal', mealId: 'lunch' });
  // Lunch's 125g actual is new; dinner's remaining 75g still belongs to the
  // original 100g reservation credit. No new lunch plan reservation is created.
  assert.equal(stock(state), 575); assert.equal(plan(state).accountedDebits[0].quantity, 425);
  const revision = state.revision; quick({ type: 'complete_meal', mealId: 'lunch' }); assert.equal(state.revision, revision); assert.equal(stock(state), 575);
});

test('transferring snack into a completed breakfast preserves unanchored Chat actual and accounts only the newly eaten portion', () => {
  let state = fixture();
  state = mutation(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast',
    entries: [{ id: 'chat-breakfast', itemId: 'rice', quantity: 100, unit: 'g', sourceText: '用户早餐实际100g' }] });
  state = mutation(state, 'record_meal_intake', { planId: plan(state).id, mealId: 'breakfast', mode: 'complete', sourceText: '早餐完成' });
  const before = clone(state), command = buildChecklistAction(plan(state), state.items,
    { type: 'move_remaining', fromMealId: 'snack', lineIds: ['snack-rice'], toMealId: 'breakfast', quantity: 40 }, { draftId: 'snack-to-breakfast' });
  const payload = { action: 'apply_checklist_intake', operationId: 'snack-to-breakfast-once', expectedRevision: state.revision,
    planId: plan(state).id, draft: command.draft, expectedDraftVersion: null };
  state = applyMutation(state, payload, LATER);
  assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).meals[0].actualEntries, plan(before).meals[0].actualEntries);
  assert.equal(plan(state).meals[0].state, 'completed'); assert.equal(plan(state).meals[0].completionReportedAt, plan(before).meals[0].completionReportedAt);
  assert.equal(applyMutation(state, payload, LATER), state);
  const restored = JSON.parse(JSON.stringify(state)), breakfast = intakeDraftView(plan(restored), restored.items).meals[0];
  assert.equal(breakfast.rows.reduce((sum, row) => sum + row.reportedQuantity, 0), 100);
  assert.equal(breakfast.rows.reduce((sum, row) => sum + row.remainingQuantity, 0), 40);
  assert(breakfast.rows.every(row => row.canEdit && !row.unknown));
  const completion = buildChecklistAction(plan(state), state.items, { type: 'complete_meal', mealId: 'breakfast' }, { draftId: 'breakfast-new-portion-eaten' });
  assert.equal(completion.draft.consumed.length, 1); assert.equal(completion.draft.consumed[0].quantity, 40);
  state = check(state, completion.draft);
  assert.equal(stock(state), 860); assert.equal(plan(state).meals[0].actualEntries.find(entry => entry.id === 'chat-breakfast').quantity, 100);
});

test('a legacy completed meal receives a half portion as plan only with unchanged reservation credits, supplements and retry state', () => {
  let state = fixture(); const p = plan(state); p.status = 'reserved'; delete p.foodAccounting; delete p.supplementAccounting;
  const credit = { itemId: 'rice', quantity: 400, unit: 'g', name: 'rice', baselineToken: state.items[0].quantityBaselineToken, unknownBalance: false };
  p.items = [clone(credit)]; p.accountedDebits = [clone(credit)]; state.items[0].quantity = 600;
  state = check(state, buildChecklistAction(plan(state), state.items, { type: 'complete_meal', mealId: 'lunch' }, { draftId: 'legacy-complete-lunch' }).draft);
  const before = clone(state), command = buildChecklistAction(plan(state), state.items,
    { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-rice'], toMealId: 'lunch', quantity: 50 }, { draftId: 'legacy-half-dinner-to-lunch' });
  const payload = { action: 'apply_checklist_intake', operationId: 'legacy-free-transfer-once', expectedRevision: state.revision,
    planId: plan(state).id, draft: command.draft, expectedDraftVersion: null };
  state = applyMutation(state, payload, LATER);
  assert.deepEqual(state.items, before.items); assert.deepEqual(plan(state).accountedDebits, plan(before).accountedDebits);
  assert.deepEqual(plan(state).legacyReservations, plan(before).legacyReservations);
  assert.deepEqual(plan(state).supplementDoses, plan(before).supplementDoses);
  assert.deepEqual(plan(state).meals[1].actualEntries, plan(before).meals[1].actualEntries);
  assert.equal(plan(state).meals[1].state, 'completed'); assert.equal(stock(state), 600);
  assert.equal(applyMutation(state, payload, LATER), state);
  assert.equal(intakeDraftView(plan(state), state.items).meals[1].rows.reduce((sum, row) => sum + row.remainingQuantity, 0), 50);
});
