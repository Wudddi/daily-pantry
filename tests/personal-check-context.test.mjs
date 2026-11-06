import test from 'node:test';
import assert from 'node:assert/strict';
import { aiFoodReadState, personalFoodCheckContext } from '../lib/ai-food-read-state.mjs';
import { readIntakeDraft, readDietRecords } from '../lib/diet.mjs';
import { readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';
import { fixture, plan, copy, mutate, recipeMoves, ID, AT } from './fixtures/food-layout.mjs';

test('valid personal reminders are detached current-row references and never actual evidence', () => {
  const state = fixture({ pending: true }), before = copy(state), result = personalFoodCheckContext(plan(state));
  assert.equal(result.available, true); assert.equal(result.basis, 'personal_reminder');
  assert.equal(result.actualIntakeEvidence, false); assert.equal(result.savedAt, AT);
  assert.deepEqual(result.rows.find(row => row.lineId === 'square-oats'), {
    sourceMealId: 'breakfast', lineId: 'square-oats', checked: true, displayMealId: 'breakfast', updatedAt: AT,
  });
  assert.deepEqual(result.rows.find(row => row.lineId === 'square-milk'), {
    sourceMealId: 'breakfast', lineId: 'square-milk', checked: false, displayMealId: 'breakfast', updatedAt: null,
  });
  result.rows[0].checked = false;
  assert.deepEqual(state, before);
  assert.match(result.instructions, /cumulative intake targets/);
  assert.match(result.instructions, /never append the full planned amount/);
});

test('display-meal narrowing keeps moved mixed-unit reminders anchored to their original source lines', () => {
  const state = mutate(fixture(), 'set_food_layout', { planId: ID, moves: recipeMoves('dinner') });
  const result = personalFoodCheckContext(plan(state), { mealIds: ['dinner'] });
  assert.equal(result.totalRows, 4); assert.equal(result.truncated, false);
  const moved = result.rows.filter(row => row.sourceMealId === 'breakfast');
  assert.deepEqual(moved.map(row => row.lineId), ['square-oats', 'square-milk', 'square-egg']);
  assert.deepEqual(moved.map(row => row.checked), [true, false, true]);
  assert.ok(moved.every(row => row.displayMealId === 'dinner'));
  assert.match(result.instructions, /read those sourceMealIds for current quantities/);
  assert.equal(personalFoodCheckContext(plan(state), { mealIds: ['lunch'] }).rows.length, 1);
});

test('missing saved reminders default to unchecked without an intake conclusion; malformed storage is unavailable', () => {
  const state = fixture(), source = copy(plan(state)); delete source.personalFoodChecks;
  const absent = personalFoodCheckContext(source);
  assert.equal(absent.available, true); assert.ok(absent.rows.length > 0);
  assert.ok(absent.rows.every(row => row.checked === false && row.updatedAt === null));
  assert.equal(absent.savedAt, null);
  for (const personalFoodChecks of [null, { checks: [] }, { version: 2, checks: [] }, { version: 1, checks: {} }]) {
    const invalid = personalFoodCheckContext({ ...source, personalFoodChecks });
    assert.equal(invalid.available, false); assert.deepEqual(invalid.rows, []);
    assert.equal(invalid.actualIntakeEvidence, false); assert.equal(invalid.truncated, true);
  }
});

test('deleted checks never migrate by SKU and conflicting or malformed entries do not manufacture unchecked rows', () => {
  const state = fixture(), source = copy(plan(state));
  source.meals[0].plannedItems[0].id = 'new-oats-row';
  source.personalFoodChecks.checks.push({ mealId: 'breakfast', lineId: 'square-egg', checked: false, updatedAt: AT });
  source.personalFoodChecks.checks.push({ mealId: 'breakfast', lineId: 'square-milk', checked: true, updatedAt: AT, privateNote: 'PRIVATE_REMINDER_CONTENT' });
  const result = personalFoodCheckContext(source);
  assert.equal(result.rows.find(row => row.lineId === 'new-oats-row').checked, false);
  assert.ok(!result.rows.some(row => ['square-oats', 'square-egg', 'square-milk'].includes(row.lineId)));
  assert.ok(result.staleReferenceCount > 0); assert.ok(result.invalidReferenceCount > 0);
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REMINDER_CONTENT'));
});

test('AI read state strips nested and draft reminder storage while preserving actual facts and parent reminder authority', () => {
  const state = fixture(), source = plan(state);
  source.draft = { title: source.title, meals: copy(source.meals), supplementDoses: copy(source.supplementDoses),
    personalFoodChecks: { version: 1, checks: [{ mealId: 'breakfast', lineId: 'square-oats', checked: false, updatedAt: AT }], updatedAt: AT } };
  source.meals[0].planRevisionHistory = [{ at: AT, previous: { personalFoodChecks: { secret: 'HISTORICAL_PRIVATE_CHECKS' } } }];
  const before = copy(state), safe = aiFoodReadState(state);
  assert.equal(safe.plans[0].personalCheckContext.rows.find(row => row.lineId === 'square-oats').checked, true);
  assert.ok(!JSON.stringify(safe).includes('personalFoodChecks'));
  assert.ok(!JSON.stringify(safe).includes('HISTORICAL_PRIVATE_CHECKS'));
  assert.deepEqual(safe.plans[0].meals[1].actualEntries, source.meals[1].actualEntries);
  assert.deepEqual(safe.plans[0].accountedDebits, source.accountedDebits);
  assert.deepEqual(state, before);
});

test('one meal with 100 rows is complete while 101 rows across meals are explicitly truncated and can be narrowed', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: 'food-' + index, itemId: 'same-sku', quantity: 1, unit: 'g' }));
  const source = { format: 'meals_v1', status: 'draft', meals: [{ id: 'large', plannedItems: rows }] };
  const complete = personalFoodCheckContext(source);
  assert.equal(complete.totalRows, 100); assert.equal(complete.includedRows, 100); assert.equal(complete.truncated, false);
  source.meals.push({ id: 'small', plannedItems: [{ id: 'last', itemId: 'same-sku', quantity: 1, unit: 'g' }] });
  const truncated = personalFoodCheckContext(source);
  assert.equal(truncated.totalRows, 101); assert.equal(truncated.includedRows, 100); assert.equal(truncated.truncated, true);
  const narrowed = personalFoodCheckContext(source, { mealIds: ['small'] });
  assert.equal(narrowed.includedRows, 1); assert.equal(narrowed.rows[0].lineId, 'last'); assert.equal(narrowed.truncated, false);
  assert.throws(() => personalFoodCheckContext(source, { maxRows: 0 }));
  assert.throws(() => personalFoodCheckContext(source, { maxRows: 101 }));
});

test('all targeted read paths expose only advisory references and leave pending drafts, actuals and stock unchanged', () => {
  let state = fixture({ pending: true });
  state = mutate(state, 'set_food_layout', { planId: ID, moves: recipeMoves('dinner') });
  const before = copy(state), intake = readIntakeDraft(state, { planId: ID, mealIds: ['dinner'] });
  const edit = readFoodPlanEditContext(state, { planId: ID, mealIds: ['dinner'] });
  const record = readDietRecords(aiFoodReadState(state), { planId: ID }).records[0];
  for (const context of [intake.personalCheckContext, edit.personalCheckContext]) {
    assert.equal(context.rows.length, 4); assert.equal(context.actualIntakeEvidence, false);
    assert.ok(context.rows.some(row => row.sourceMealId === 'breakfast' && row.displayMealId === 'dinner'));
  }
  assert.equal(record.personalCheckContext.basis, 'personal_reminder');
  assert.equal(record.personalCheckContext.rows.length, 5);
  assert.deepEqual(state, before);
});

test('active and draft edit views reference exactly their own materialized planned rows', () => {
  const state = fixture(), source = plan(state);
  source.draft = { title: source.title, meals: copy(source.meals), supplementDoses: copy(source.supplementDoses) };
  source.draft.meals[0].plannedItems[0].id = 'draft-oats';
  const before = copy(state);
  const active = readFoodPlanEditContext(state, { planId: ID, view: 'active', mealIds: ['breakfast'] });
  const draft = readFoodPlanEditContext(state, { planId: ID, view: 'draft', mealIds: ['breakfast'] });
  assert.ok(active.meals[0].plannedItems.some(line => line.id === 'square-oats'));
  assert.equal(active.personalCheckContext.rows.find(row => row.lineId === 'square-oats').checked, true);
  assert.ok(!active.personalCheckContext.rows.some(row => row.lineId === 'draft-oats'));
  assert.ok(draft.meals[0].plannedItems.some(line => line.id === 'draft-oats'));
  assert.equal(draft.personalCheckContext.rows.find(row => row.lineId === 'draft-oats').checked, false);
  assert.ok(!draft.personalCheckContext.rows.some(row => row.lineId === 'square-oats'));
  assert.deepEqual(state, before);
});
