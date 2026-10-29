import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { intakeDraftView, intakeDraftVersion } from '../lib/intake-draft.mjs';
import { buildChecklistAction, canReceiveChecklistFood, groupChecklistRows, nextChecklistMealId } from '../lib/checklist-actions.mjs';

const NOW = '2026-10-26T15:00:00.000Z';
let sequence = 0;
const item = (id, unit = 'g', gramsPerUnit = null, quantity = 1000) => validateItem({ id, name: id, unit, quantity, gramsPerUnit,
  category: id === 'creatine' ? 'supplement' : 'prepared', nutrition: { basisAmount: 100, basisUnit: unit === '袋' ? 'g' : unit,
    kcal: 200, protein: 10, carbs: 20, fat: 5, source: 'label' } }, NOW);
const menu = (itemId = 'rice', quantity = 100) => ({ id: 'daily-food-2026-10-26', date: '2026-10-26', title: '本机验证勾选菜单',
  meals: ['breakfast', 'lunch', 'snack', 'dinner'].map(id => ({ id, slot: id, title: id,
    plannedItems: [{ id: `${id}-food`, itemId, quantity }] })),
  supplementDoses: [{ id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, timingSlot: 'breakfast' }] });
const mutate = (state, action, fields) => applyMutation(state, { action, operationId: 'cl-test-' + (++sequence), expectedRevision: state.revision, ...fields }, NOW);
function fixture(foods = [item('rice'), item('creatine')], raw = menu()) {
  return mutate({ schemaVersion: 1, revision: 0, updatedAt: NOW, items: foods, plans: [], events: [], operationIds: [], preferences: [] }, 'save_meal_plan_draft', { plan: raw });
}
const plan = state => state.plans[0], stock = (state, id = 'rice') => state.items.find(item => item.id === id).quantity;
const view = state => intakeDraftView(plan(state), state.items);
const row = (state, mealId) => view(state).meals.find(meal => meal.id === mealId).rows[0];
function build(state, action, id = 'gesture-' + (++sequence)) { return buildChecklistAction(plan(state), state.items, action, { draftId: id }); }
function apply(state, action) { const { draft, expectedDraftVersion, noChange } = build(state, action); return noChange ? state : mutate(state, 'apply_checklist_intake', { planId: plan(state).id, draft, expectedDraftVersion }); }
const done = mealId => ({ type: 'complete_item', mealId, lineIds: [`${mealId}-food`] });
const edit = (mealId, quantity, fields = {}) => ({ type: 'set_eaten', mealId, lineIds: [`${mealId}-food`], quantity, ...fields });
const actual = (state, mealId, quantity) => mutate(state, 'record_meal_intake', { planId: plan(state).id, mealId,
  entries: [{ id: 'chat-' + mealId, itemId: 'rice', quantity, unit: 'g', sourceText: '用户原始实际记录' }] });

test('one click completes planned portion and meal; existing Chat actual is retained and only the missing difference debited', () => {
  let state = actual(fixture(), 'lunch', 30), before = structuredClone(state);
  const command = build(state, done('lunch')); assert.deepEqual(state, before);
  assert.equal(command.draft.consumed[0].quantity, 100); assert.deepEqual(command.draft.completedMealIds, ['lunch']);
  assert.equal(command.preview.meals[1].rows[0].remainingQuantity, 0);
  state = mutate(state, 'apply_checklist_intake', { planId: plan(state).id, draft: command.draft, expectedDraftVersion: null });
  assert.equal(stock(state), 900); assert.equal(plan(state).meals[1].state, 'completed');
  assert.equal(plan(state).meals[1].actualEntries.find(entry => entry.id === 'chat-lunch').quantity, 30);
  assert.equal(stock(state, 'creatine'), 1000); assert.equal(plan(state).supplementDoses[0].actualEntries.length, 0);
  assert.equal(build(state, done('lunch')).noChange, true);
});

test('already eaten above plan is never lowered by checking complete', () => {
  const state = actual(fixture(), 'lunch', 130), command = build(state, done('lunch'));
  assert.equal(command.draft.consumed.length, 0); assert.deepEqual(command.draft.completedMealIds, ['lunch']);
  const next = apply(state, done('lunch')); assert.equal(stock(next), 870); assert.equal(row(next, 'lunch').eatenQuantity, 130);
});

test('whole meal check records every stable line in one action and repeated gestures are no-ops', () => {
  const raw = menu(); raw.meals[1].plannedItems.push({ id: 'lunch-second', itemId: 'beans', quantity: 50 });
  let state = fixture([item('rice'), item('beans'), item('creatine')], raw);
  const command = build(state, { type: 'complete_meal', mealId: 'lunch' });
  assert.deepEqual(command.draft.consumed.map(entry => entry.lineId), ['lunch-food', 'lunch-second']);
  state = apply(state, { type: 'complete_meal', mealId: 'lunch' });
  assert.equal(stock(state), 900); assert.equal(stock(state, 'beans'), 950);
  assert.equal(build(state, { type: 'complete_meal', mealId: 'lunch' }).noChange, true);
});

test('long press edit records only actual eaten and puts the unconsumed balance in the chosen next meal', () => {
  let state = fixture(), before = structuredClone(state);
  const command = build(state, edit('lunch', 40, { moveRemainingToMealId: 'dinner' }));
  assert.deepEqual(state, before); assert.equal(command.draft.transfers[0].quantity, 60);
  assert.equal(command.preview.meals[1].rows[0].plannedQuantity, 40);
  assert.equal(command.preview.dayRows[0].plannedQuantity, 400);
  assert.equal(command.preview.dayRows[0].remainingQuantity, 360);
  state = apply(state, edit('lunch', 40, { moveRemainingToMealId: 'dinner' }));
  assert.equal(stock(state), 960); assert.equal(plan(state).meals[1].plannedItems[0].quantity, 40);
  assert.equal(plan(state).meals[3].plannedItems.reduce((sum, line) => sum + line.quantity, 0), 160);
});

test('dragging a complete or partial remaining portion changes only allocation, not facts, supplements or inventory', () => {
  let state = fixture(), before = structuredClone(state);
  state = apply(state, { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-food'], toMealId: 'lunch', quantity: 25 });
  assert.equal(stock(state), 1000); assert.deepEqual(plan(state).supplementDoses, plan(before).supplementDoses);
  assert.equal(plan(state).meals[3].plannedItems[0].quantity, 75); assert.equal(plan(state).meals[1].plannedItems.at(-1).quantity, 25);
  assert.equal(plan(state).meals.flatMap(meal => meal.actualEntries).length, 0);
  state = apply(state, { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-food'], toMealId: 'lunch' });
  assert.equal(plan(state).meals[3].plannedItems.length, 0); assert.equal(stock(state), 1000);
  assert.equal(view(state).dayRows[0].plannedQuantity, 400);
});

test('gram display for packaged meals is converted through the same frozen snapshot', () => {
  let state = fixture([item('beef', '袋', 140, 5), item('creatine')], menu('beef', 1));
  assert.equal(row(state, 'lunch').unit, 'g'); assert.equal(row(state, 'lunch').plannedQuantity, 140);
  state = apply(state, edit('lunch', 70, { moveRemainingToMealId: 'dinner' }));
  assert.equal(stock(state, 'beef'), 4.5); assert.equal(plan(state).meals[1].actualEntries[0].quantity, .5);
  assert.equal(plan(state).meals[1].actualEntries[0].nutritionSnapshot.gramsPerUnit, 140);
  assert.equal(plan(state).meals[3].plannedItems.at(-1).quantity, .5);
});

test('visual groups retain original line ids and allocate edits while preserving both frozen line snapshots', () => {
  const raw = menu(); raw.meals[1].plannedItems.push({ id: 'lunch-split', itemId: 'rice', quantity: 50, sourceText: '本机验证：不同冻结快照配方',
    nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 220, protein: 11, carbs: 21, fat: 6, source: 'estimate', sourceText: '本机验证不同配方' } });
  let state = fixture(undefined, raw); const group = groupChecklistRows(view(state).meals[1])[0];
  assert.deepEqual(group.lineIds, ['lunch-food', 'lunch-split']); assert.equal(group.plannedQuantity, 150);
  state = apply(state, { type: 'set_eaten', mealId: 'lunch', lineIds: group.lineIds, quantity: 80, moveRemainingToMealId: 'dinner' });
  assert.equal(stock(state), 920); assert.equal(view(state).dayRows[0].plannedQuantity, 450);
  assert.deepEqual(plan(state).meals[3].plannedItems.slice(-2).map(line => line.nutritionSnapshot.nutrition.kcal), [200, 220]);
  assert.equal(groupChecklistRows(view(state).meals[3])[0].plannedQuantity, 170);
});

test('increasing an actual above plan is not capped or silently borrowed from another meal', () => {
  const state = apply(fixture(), edit('lunch', 140));
  assert.equal(stock(state), 860); assert.equal(row(state, 'lunch').eatenQuantity, 140); assert.equal(row(state, 'dinner').plannedQuantity, 100);
  assert.equal(view(state).dayRows[0].remainingQuantity, 300);
});

test('undo is explicit, refunds only the recorded difference, and protects external actual without confirmation', () => {
  let state = actual(fixture(), 'lunch', 30), before = structuredClone(state);
  assert.throws(() => build(state, { type: 'undo_item', mealId: 'lunch', lineIds: ['lunch-food'] }), { code: 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED' });
  assert.deepEqual(state, before);
  state = apply(state, { type: 'undo_item', mealId: 'lunch', lineIds: ['lunch-food'], correctExistingActuals: true });
  assert.equal(stock(state), 1000);
  const entry = plan(state).meals[1].actualEntries.find(entry => entry.id === 'chat-lunch');
  assert.equal(entry.quantity, 0); assert.equal(entry.correctionHistory[0].quantity, 30);
});

test('pending cloud drafts are never implicitly submitted, merged or overwritten by a quick check', () => {
  let state = fixture(); const pending = build(state, edit('lunch', 20)).draft;
  state = mutate(state, 'save_intake_draft', { planId: plan(state).id, draft: pending, expectedDraftVersion: null });
  const before = structuredClone(state);
  assert.throws(() => build(state, done('breakfast')), { code: 'INTAKE_DRAFT_PENDING' });
  assert.deepEqual(state, before); assert.equal(intakeDraftVersion(plan(state).intakeDraft), intakeDraftVersion(pending));
});

test('unknown Chat actual remains unknown rather than checked or moved as zero', () => {
  const state = actual(fixture(), 'lunch', null), before = structuredClone(state);
  assert.equal(row(state, 'lunch').eatenQuantity, null); assert.equal(groupChecklistRows(view(state).meals[1])[0].eatenQuantity, null);
  assert.throws(() => build(state, done('lunch')), { code: 'INTAKE_ACTUAL_REQUIRES_REVIEW' });
  assert.deepEqual(state, before);
});

test('meal suggestions preserve usual pairings while allowing earlier and already completed destinations', () => {
  let state = fixture();
  assert.equal(nextChecklistMealId(view(state), 'breakfast'), 'lunch');
  assert.equal(nextChecklistMealId(view(state), 'lunch'), 'dinner');
  assert.equal(nextChecklistMealId(view(state), 'snack'), 'dinner');
  assert.equal(nextChecklistMealId(view(state), 'dinner'), 'lunch');
  const ended = view(state); ended.meals.find(meal => meal.id === 'dinner').state = 'completed';
  ended.meals.find(meal => meal.id === 'dinner').rows.forEach(row => row.remainingQuantity = 0);
  assert.equal(nextChecklistMealId(ended, 'lunch'), 'dinner');
  ended.meals.find(meal => meal.id === 'snack').state = 'cancelled';
  assert.equal(nextChecklistMealId(ended, 'lunch'), 'dinner');
  ended.meals.find(meal => meal.id === 'dinner').state = 'cancelled';
  assert.equal(nextChecklistMealId(ended, 'lunch'), 'breakfast');
  ended.meals.find(meal => meal.id === 'breakfast').state = 'cancelled';
  assert.equal(nextChecklistMealId(ended, 'lunch'), null);
  state = apply(state, { type: 'complete_meal', mealId: 'lunch' });
  assert.equal(nextChecklistMealId(view(state), 'breakfast'), 'lunch'); assert.equal(nextChecklistMealId(view(state), 'dinner'), 'lunch');
  const before = structuredClone(state);
  state = apply(state, { type: 'move_remaining', fromMealId: 'breakfast', lineIds: ['breakfast-food'], toMealId: 'lunch' });
  assert.deepEqual(state.items, before.items);
  assert.deepEqual(plan(state).meals[1].actualEntries, plan(before).meals[1].actualEntries);
});

test('cumulative group edits preserve existing actual distribution before adding a missing portion', () => {
  const raw = menu(); raw.meals[1].plannedItems.push({ id: 'lunch-split', itemId: 'rice', quantity: 50 });
  let state = fixture(undefined, raw); state = apply(state, { type: 'set_eaten', mealId: 'lunch', lineIds: ['lunch-split'], quantity: 30 });
  state = apply(state, { type: 'set_eaten', mealId: 'lunch', lineIds: ['lunch-food', 'lunch-split'], quantity: 60 });
  const rows = view(state).meals[1].rows;
  assert.equal(rows.find(row => row.lineId === 'lunch-food').eatenQuantity, 30);
  assert.equal(rows.find(row => row.lineId === 'lunch-split').eatenQuantity, 30); assert.equal(stock(state), 940);
});

test('unchecking a completed food refunds exactly once and rechecking debits the same stable actual only once', () => {
  let state = apply(fixture(), done('lunch'));
  const original = structuredClone(plan(state).meals[1].actualEntries[0]);
  state = apply(state, { type: 'undo_item', mealId: 'lunch', lineIds: ['lunch-food'], correctExistingActuals: true });
  assert.equal(stock(state), 1000); assert.equal(row(state, 'lunch').remainingQuantity, 100);
  assert.equal(plan(state).meals[1].state, 'completed');
  const actual = plan(state).meals[1].actualEntries[0];
  assert.equal(actual.id, original.id); assert.equal(actual.quantity, 0); assert.equal(actual.correctionHistory.at(-1).quantity, 100);
  assert.equal(build(state, { type: 'undo_item', mealId: 'lunch', lineIds: ['lunch-food'], correctExistingActuals: true }).noChange, true);
  state = apply(state, done('lunch')); assert.equal(stock(state), 900); assert.equal(plan(state).meals[1].actualEntries.length, 1);
  assert.equal(plan(state).meals[1].actualEntries[0].id, original.id);
});

test('whole-meal uncheck is atomic across mixed units and corrects external actual only when explicitly requested', () => {
  const raw = menu(); raw.meals[1].plannedItems.push({ id: 'lunch-milk', itemId: 'milk', quantity: 150 });
  let state = fixture([item('rice'), item('creatine'), item('milk', 'ml')], raw);
  state = actual(state, 'lunch', 30);
  state = apply(state, { type: 'complete_meal', mealId: 'lunch' });
  assert.equal(stock(state), 900); assert.equal(stock(state, 'milk'), 850);
  assert.throws(() => build(state, { type: 'undo_meal', mealId: 'lunch' }), { code: 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED' });
  const command = build(state, { type: 'undo_meal', mealId: 'lunch', correctExistingActuals: true });
  assert.deepEqual(command.draft.consumed.map(entry => [entry.lineId, entry.quantity, entry.unit]), [['lunch-food', 0, 'g'], ['lunch-milk', 0, 'mL']]);
  const revision = state.revision; state = apply(state, { type: 'undo_meal', mealId: 'lunch', correctExistingActuals: true });
  assert.equal(state.revision, revision + 1); assert.equal(stock(state), 1000); assert.equal(stock(state, 'milk'), 1000);
  assert.equal(plan(state).meals[1].actualEntries.find(entry => entry.id === 'chat-lunch').correctionHistory[0].quantity, 30);
  assert.equal(build(state, { type: 'undo_meal', mealId: 'lunch', correctExistingActuals: true }).noChange, true);
});

test('a checked meal can receive a new unconsumed portion without revoking its historical completion or claiming new intake', () => {
  let state = apply(fixture(), { type: 'complete_meal', mealId: 'lunch' });
  const before = structuredClone(state), actualBefore = structuredClone(plan(state).meals[1].actualEntries);
  assert.equal(canReceiveChecklistFood(view(state).meals[1]), true);
  assert.equal(nextChecklistMealId(view(state), 'breakfast'), 'lunch');
  state = apply(state, { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-food'], toMealId: 'lunch', quantity: 25 });
  assert.deepEqual(state.items, before.items);
  assert.deepEqual(plan(state).meals[1].actualEntries, actualBefore);
  assert.equal(groupChecklistRows(view(state).meals[1])[0].remainingQuantity, 25);
  assert.equal(groupChecklistRows(view(state).meals[1])[0].reportedQuantity, 100);
  assert.equal(plan(state).meals[1].completionReportedAt, plan(before).meals[1].completionReportedAt);
  assert.equal(plan(state).meals[1].state, 'completed');
});

test('a dinner portion is split directly into lunch and a snack portion directly into breakfast with no actual intake', () => {
  let state = fixture(), before = structuredClone(state);
  const command = build(state, { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-food'], toMealId: 'lunch', quantity: 50 });
  assert.equal(command.draft.transfers.length, 1); assert.equal(command.draft.transfers[0].quantity, 50);
  assert.deepEqual(command.draft.consumed, []); assert.deepEqual(command.draft.completedMealIds, []);
  state = apply(state, { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-food'], toMealId: 'lunch', quantity: 50 });
  state = apply(state, { type: 'move_remaining', fromMealId: 'snack', lineIds: ['snack-food'], toMealId: 'breakfast', quantity: 40 });
  assert.equal(groupChecklistRows(view(state).meals[3])[0].plannedQuantity, 50);
  assert.equal(groupChecklistRows(view(state).meals[1])[0].plannedQuantity, 150);
  assert.equal(groupChecklistRows(view(state).meals[2])[0].plannedQuantity, 60);
  assert.equal(groupChecklistRows(view(state).meals[0])[0].plannedQuantity, 140);
  assert.deepEqual(state.items, before.items); assert.equal(view(state).dayRows[0].plannedQuantity, 400);
  assert(plan(state).meals.every(meal => meal.actualEntries.length === 0));
});

test('a half bag transfers in frozen display grams without changing the inventory package unit or nutrition', () => {
  const raw = menu(); raw.meals[3].plannedItems = [{ id: 'dinner-beef', itemId: 'beef', quantity: 1 }];
  let state = fixture([item('rice'), item('creatine'), item('beef', '袋', 132, 10)], raw);
  const original = structuredClone(plan(state).meals[3].plannedItems[0]);
  state.items.find(value => value.id === 'beef').gramsPerUnit = 999;
  const before = structuredClone(state);
  state = apply(state, { type: 'move_remaining', fromMealId: 'dinner', lineIds: ['dinner-beef'], toMealId: 'lunch', quantity: 66 });
  const source = plan(state).meals[3].plannedItems[0], destination = plan(state).meals[1].plannedItems.find(line => line.itemId === 'beef');
  assert.equal(source.quantity, .5); assert.equal(destination.quantity, .5); assert.equal(destination.unit, '袋');
  assert.deepEqual(destination.nutritionSnapshot, original.nutritionSnapshot);
  assert.deepEqual(state.items, before.items);
  assert.equal(groupChecklistRows(view(state).meals[3])[0].plannedQuantity, 66);
  assert.equal(groupChecklistRows(view(state).meals[1]).find(group => group.itemId === 'beef').plannedQuantity, 66);
});
