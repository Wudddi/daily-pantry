import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
const NOW = '2026-10-20T20:00:00.000Z', LATER = '2026-10-20T21:00:00.000Z';
const copy = value => structuredClone(value);
const nutrients = (kcal, protein, carbs, fat, basisAmount = 100, basisUnit = 'g', source = 'label') => ({ basisAmount, basisUnit, kcal, protein, carbs, fat, source, sourceNote: "Explicit label or per-portion estimate source", sourceText: "Complete original label or recipe provenance" });
const vegEstimate = () => nutrients(47, 2.5, 10.5, 0.5, 200, 'g', 'estimate');
const tunaEstimate = () => nutrients(80, 19.2, 0, 0, 1, '罐', 'estimate');
const bagelEstimate = () => nutrients(249.4, 7.74, 43, 5.16, 1, '个', 'estimate');
function food(id, unit, quantity, nutrition, category = 'prepared', gramsPerUnit = null) { return validateItem({ id, name: id, unit, quantity, nutrition, category, gramsPerUnit }, NOW); }
function fixture() { return { schemaVersion: 1, revision: 0, updatedAt: NOW, events: [], operationIds: [], preferences: [], plans: [], items: [
  food('veg', 'g', 1000, { basisAmount: 100, basisUnit: 'g' }, 'vegetable'), food('tuna', '罐', 5, nutrients(50, 12, 0, 0, 55)),
  food('bagel', '个', 5, nutrients(290, 9, 50, 6), 'bread', 85), food('pasta', 'g', 1000, { basisAmount: 100, basisUnit: 'g' }, 'staple'),
  food('beef', '袋', 10, nutrients(100, 10, 5, 3, 1, '袋')), food('fish', '粒', 10, nutrients(10, null, null, null, 1, '粒'), 'supplement'),
] }; }
function input(overrides = false) { return { id: 'day', date: '2026-10-20', title: "Actual nutrition correction test menu", meals: [
  { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedItems: [{ id: 'beef-line', itemId: 'beef', quantity: 1 }] },
  { id: 'dinner', slot: 'dinner', title: "Dinner", plannedItems: [{ id: 'veg-line', itemId: 'veg', quantity: 150, ...(overrides ? { nutrition: vegEstimate() } : {}) }, { id: 'tuna-line', itemId: 'tuna', quantity: 1, ...(overrides ? { nutrition: tunaEstimate() } : {}) }, { id: 'bagel-line', itemId: 'bagel', quantity: 1 }, { id: 'pasta-line', itemId: 'pasta', quantity: 110 }] },
], supplementDoses: [{ id: 'oil', itemId: 'fish', plannedQuantity: 1, timingSlot: 'breakfast' }] }; }
function mutate(state, action, payload, operationId = action + '-' + state.revision) { return applyMutation(state, { action, ...payload, operationId, expectedRevision: state.revision }, LATER); }
function ready(raw = input(), state = fixture()) { return mutate(mutate(state, 'save_meal_plan_draft', { plan: raw }), 'commit_meal_plan', { planId: 'day', confirmed: true }); }
function report(state) { return mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'complete', actualTime: '19:45', actualTimeText: "User reported after eating", sourceText: "Actual: 150 g vegetables, 1 can tuna, 1 bagel measured at 86 g; no pasta", entries: [
  { id: 'a-veg', itemId: 'veg', quantity: 150, unit: 'g', sourceText: "Actually ate 150 g vegetables" }, { id: 'a-tuna', itemId: 'tuna', quantity: 1, unit: '罐', sourceText: "Actually ate 1 can" }, { id: 'a-bagel', itemId: 'bagel', quantity: 1, unit: '个', sourceText: "One bagel measured at 86 g" }, { id: 'a-zero', itemId: 'pasta', quantity: 0, unit: 'g', sourceText: "Pasta: 0 g, explicitly not eaten" },
] }); }
const plan = state => state.plans[0], dinner = state => plan(state).meals.find(meal => meal.id === 'dinner'), actual = (state, id) => dinner(state).actualEntries.find(entry => entry.id === id);
function oldActualFixture() { const state = report(ready()); return mutate(state, 'patch_meal_plan', { planId: 'day', mode: 'apply', confirmed: true, mealPatches: [{ id: 'dinner', itemPatches: [{ id: 'veg-line', nutrition: vegEstimate() }, { id: 'tuna-line', nutrition: tunaEstimate() }, { id: 'bagel-line', nutrition: bagelEstimate() }] }] }); }
const corrections = () => [{ entryId: 'a-veg', fromPlannedLineId: 'veg-line', sourceText: "Reuse the confirmed per-200-g vegetable estimate of 47 kcal and P/C/F; retain actual 150 g" }, { entryId: 'a-tuna', fromPlannedLineId: 'tuna-line', sourceText: "Reuse this meal's estimate per can: 80 kcal, P19.2/C0/F0; do not infer drained mass" }, { entryId: 'a-bagel', gramsPerUnit: 86, sourceText: "This bagel measured 86 g; preserve the per-100-g label and 85 g inventory average" }];
function correct(state, rows = corrections(), fields = {}, operationId) { return mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', nutritionCorrections: rows, ...fields }, operationId); }
const daily = state => resolveDietDays(state.plans, [])[0];
const totals = state => Object.fromEntries(daily(state).totals.map(row => [row.key, row]));
function physicalFacts(entry) { return Object.fromEntries(['id', 'itemId', 'name', 'quantity', 'unit', 'sourceText', 'reportedAt', 'quantitySource', 'correctionHistory'].map(key => [key, entry[key]])); }
function assertOnlyNutrition(after, before) {
  assert.deepEqual(after.items, before.items);
  for (const key of ['items', 'accountedDebits', 'allocationAdjustments', 'inventoryAccounting', 'accountingIssues', 'status', 'intakeBasis', 'draft']) assert.deepEqual(plan(after)[key], plan(before)[key]);
  assert.deepEqual(plan(after).supplementDoses, plan(before).supplementDoses);
  assert.deepEqual(plan(after).meals.find(meal => meal.id === 'breakfast'), plan(before).meals.find(meal => meal.id === 'breakfast'));
  for (const key of ['actualTime', 'actualTimeText', 'completionReportedAt', 'sourceText', 'reportHistory', 'state', 'plannedItems', 'planRevisionHistory']) assert.deepEqual(dinner(after)[key], dinner(before)[key]);
  assert.deepEqual(dinner(after).actualEntries.map(physicalFacts), dinner(before).actualEntries.map(physicalFacts));
}
function rejectsUnchanged(state, rows, fields = {}, code) { const original = copy(state); assert.throws(() => correct(state, rows, fields), error => !code || error.code === code); assert.deepEqual(state, original); }

test('three explicit nutrition corrections fill real gaps, keep label provenance and actual86g, and never change any inventory or eating fact', () => {
  const before = oldActualFixture(), oldSnapshots = dinner(before).actualEntries.map(entry => copy(entry.nutritionSnapshot));
  assert.equal(daily(before).partial, true);
  const after = correct(before);
  assertOnlyNutrition(after, before);
  assert.equal(actual(after, 'a-veg').nutritionSnapshot.nutrition.basisAmount, 200);
  assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.basisUnit, '罐');
  assert.equal(actual(after, 'a-bagel').nutritionSnapshot.gramsPerUnit, 86);
  assert.equal(actual(after, 'a-bagel').nutritionSnapshot.nutrition.source, 'label');
  assert.equal(after.items.find(item => item.id === 'bagel').gramsPerUnit, 85);
  assert.equal(actual(after, 'a-tuna').nutritionSnapshot.gramsPerUnit, null);
  for (const [index, row] of dinner(after).actualEntries.entries()) {
    if (index < 3) { assert.equal(row.nutritionCorrectionHistory.length, 1); assert.deepEqual(row.nutritionCorrectionHistory[0].previous, oldSnapshots[index]); assert.equal(row.nutritionCorrectionHistory[0].at, LATER); }
    else { assert.deepEqual(row, dinner(before).actualEntries[index]); assert.equal(row.nutritionSnapshot.nutrition.kcal, null); }
  }
  const values = totals(after);
  assert.equal(daily(after).partial, false);
  assert.equal(values.kcal.value, 474.65);
  assert.equal(values.protein.value, 38.815); assert.equal(values.carbs.value, 55.875); assert.equal(values.fat.value, 8.535);
  assert.equal(values.protein.supplementPartial, true); assert.equal(values.protein.partial, false);
});

test('retries with a stale revision and repeated identical values never duplicate nutrition history or intake', () => {
  const before = oldActualFixture(), rows = corrections(), operationId = 'stable-nutrition-event';
  const after = correct(before, rows, { mode: 'correct' }, operationId);
  assert.equal(applyMutation(after, { action: 'record_meal_intake', planId: 'day', mealId: 'dinner', mode: 'correct', nutritionCorrections: rows, operationId, expectedRevision: before.revision }, LATER), after);
  assert.equal(correct(after, rows, { mode: 'correct' }, 'new-operation-identical-values'), after);
  assert.throws(() => applyMutation(after, { action: 'record_meal_intake', planId: 'day', mealId: 'dinner', mode: 'correct', nutritionCorrections: [{ entryId: 'a-bagel', gramsPerUnit: 87, sourceText: "Different measured weight" }], operationId, expectedRevision: after.revision }, LATER), { code: 'OPERATION_ID_CONFLICT', status: 409 });
  assert.throws(() => applyMutation(after, { action: 'record_meal_intake', planId: 'day', mealId: 'dinner', nutritionCorrections: rows, operationId: 'stale-client', expectedRevision: before.revision }, LATER), { code: 'REVISION_CONFLICT', status: 409 });
  assert.equal(actual(after, 'a-bagel').nutritionCorrectionHistory.length, 1);
});

test('nutritional evidence changes neither settle a pending old inventory problem nor reapply global pending flags', () => {
  const before = oldActualFixture(); plan(before).inventoryAccounting = 'pending_reconciliation'; plan(before).accountingIssues = [{ itemId: 'tuna', code: 'BASELINE_REQUIRES_REVIEW', message: "Original count pending review" }];
  before.items.find(item => item.id === 'tuna').status = 'available';
  const after = correct(before);
  assertOnlyNutrition(after, before);
  assert.equal(after.items.find(item => item.id === 'tuna').status, 'available');
  assert.equal(plan(after).inventoryAccounting, 'pending_reconciliation');
});

test('fromPlan reads the current saved line while only an explicit nutrition correction changes old actual evidence', () => {
  let before = oldActualFixture();
  before = mutate(before, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'dinner', itemPatches: [{ id: 'tuna-line', nutrition: { ...tunaEstimate(), kcal: 999 } }, { id: 'pending-only-line', itemId: 'tuna', quantity: 1, nutrition: tunaEstimate() }] }] });
  assert.equal(actual(before, 'a-tuna').nutritionSnapshot.nutrition.basisUnit, 'g', 'editing a menu never refreshes old actual evidence');
  const after = correct(before, [{ entryId: 'a-tuna', fromPlannedLineId: 'tuna-line', sourceText: "Explicitly use the currently saved per-can estimate" }]);
  assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.kcal, 999);
  assertOnlyNutrition(after, before);
  assert.equal(correct(before, [{ entryId: 'a-tuna', fromPlannedLineId: 'pending-only-line', sourceText: "Explicit reference to the current newly added planned line" }]).plans[0].meals[1].actualEntries.find(entry => entry.id === 'a-tuna').nutritionSnapshot.nutrition.kcal, 80);
  rejectsUnchanged(before, [{ entryId: 'a-tuna', fromPlannedLineId: 'missing-line', sourceText: "Nonexistent source" }], {}, 'PLANNED_LINE_NOT_FOUND');
  rejectsUnchanged(before, [corrections()[0], { entryId: 'a-tuna', fromPlannedLineId: 'veg-line', sourceText: "Reject a different food" }], {}, 'NUTRITION_IDENTITY_CONFLICT');
  const wrongUnit = copy(before); actual(wrongUnit, 'a-tuna').unit = 'g';
  rejectsUnchanged(wrongUnit, [{ entryId: 'a-tuna', fromPlannedLineId: 'tuna-line', sourceText: "Different unit" }], {}, 'NUTRITION_IDENTITY_CONFLICT');
});

test('nutrition-only correction preserves a legacy pending draft and cannot silently use draft-only evidence', () => {
  const before = oldActualFixture();
  plan(before).draft = { ...copy(plan(before)), patchDraft: true };
  const saved = plan(before).draft.meals.find(meal => meal.id === 'dinner');
  saved.plannedItems.find(line => line.id === 'tuna-line').nutritionSnapshot.nutrition.kcal = 999;
  saved.plannedItems.push({ id: 'legacy-draft-only', itemId: 'tuna', quantity: 1, unit: '罐',
    nutrition: tunaEstimate(), nutritionSnapshot: { ...copy(saved.plannedItems.find(line => line.id === 'tuna-line').nutritionSnapshot), nutrition: tunaEstimate() } });
  const after = correct(before, [{ entryId: 'a-tuna', fromPlannedLineId: 'tuna-line', sourceText: "Explicitly reuse the original parent record's food nutrition" }]);
  assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.kcal, 80);
  assertOnlyNutrition(after, before);
  rejectsUnchanged(before, [{ entryId: 'a-tuna', fromPlannedLineId: 'legacy-draft-only', sourceText: "Independent nutrition correction must not adopt the draft" }], {}, 'PLANNED_LINE_NOT_FOUND');
});

test('nutrition-only requests strictly reject all intake, time, supplement or arbitrary fields and duplicate IDs', () => {
  const before = oldActualFixture();
  for (const fields of [{ entries: [] }, { supplements: [] }, { actualTime: '20:10' }, { actualTimeText: "Time" }, { sourceText: "Intake source text mixed in" }, { matchesPlannedFood: false }, { mode: 'append' }, { mode: 'complete' }, { confirmed: true }]) rejectsUnchanged(before, corrections(), fields);
  for (const rows of [[], null, [{ entryId: 'a-veg', fromPlannedLineId: 'veg-line', sourceText: "Duplicate" }, { entryId: ' a-veg ', fromPlannedLineId: 'veg-line', sourceText: "Duplicate" }], [{ entryId: 'a-bagel', gramsPerUnit: 86, sourceText: '' }], [{ entryId: 'a-bagel', sourceText: "No correction fields" }], [{ entryId: 'a-bagel', gramsPerUnit: 86, sourceText: "Quantity cannot change", quantity: 2 }], [{ entryId: 'a-tuna', nutrition: tunaEstimate(), fromPlannedLineId: 'tuna-line', sourceText: "Ambiguous dual sources" }]]) rejectsUnchanged(before, rows);
  assert.throws(() => mutate(before, 'record_supplement_intake', { planId: 'day', doseId: 'oil', nutritionCorrections: corrections() }));
});

test('full nutrition replacement requires all four explicit values, valid independent basis and real source evidence', () => {
  const before = oldActualFixture();
  for (const key of ['basisAmount', 'basisUnit', 'source', 'kcal', 'protein', 'carbs', 'fat']) { const raw = tunaEstimate(); delete raw[key]; rejectsUnchanged(before, [{ entryId: 'a-tuna', nutrition: raw, sourceText: "Required fields cannot be omitted" }]); }
  for (const raw of [{ ...tunaEstimate(), basisAmount: 0 }, { ...tunaEstimate(), kcal: -1 }, { ...tunaEstimate(), protein: NaN }, { ...tunaEstimate(), fat: Infinity }, { ...tunaEstimate(), basisUnit: 'mg' }, { ...tunaEstimate(), source: 'unknown' }, { ...tunaEstimate(), sourceNote: '', sourceText: '' }, { ...tunaEstimate(), hidden: true }, { ...tunaEstimate(), nutrientSources: { kcal: 'estimate', hidden: 'label' } }]) rejectsUnchanged(before, [{ entryId: 'a-tuna', nutrition: raw, sourceText: "Invalid source must not save" }]);
  const after = correct(before, [{ entryId: 'a-tuna', nutrition: { ...tunaEstimate(), protein: null, fat: 0 }, sourceText: "Only the supplied values are known; protein is now unknown" }]);
  assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.protein, null); assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.fat, 0);
  assert.equal(totals(after).protein.partial, true); assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.nutrientSources.protein, 'unknown');
});

test('actual grams can be cleared back to unknown; grams do not rescale a nutrition basis already expressed per physical unit', () => {
  const before = correct(oldActualFixture());
  const cleared = correct(before, [{ entryId: 'a-bagel', gramsPerUnit: null, sourceText: "Withdraw the measured mass; retain unknown, not zero" }]);
  assert.equal(actual(cleared, 'a-bagel').nutritionSnapshot.gramsPerUnit, null); assert.equal(daily(cleared).partial, true);
  let perItem = correct(before, [{ entryId: 'a-bagel', fromPlannedLineId: 'bagel-line', sourceText: "Explicitly use a per-item estimate" }]); const known = totals(perItem).kcal.value;
  perItem = correct(perItem, [{ entryId: 'a-bagel', gramsPerUnit: 100, sourceText: "Only the new mass changes; per-item values do not scale automatically" }]);
  assert.equal(totals(perItem).kcal.value, known); assert.equal(actual(perItem, 'a-bagel').nutritionSnapshot.nutrition.basisUnit, '个');
});

test('weight corrections cannot invent density, mg conversion or zero/negative weights and invalid batch entries never partially save', () => {
  const before = oldActualFixture();
  for (const value of [0, -1, NaN, Infinity, '86']) rejectsUnchanged(before, [corrections()[0], { entryId: 'a-bagel', gramsPerUnit: value, sourceText: "Invalid mass" }]);
  const volume = copy(before); actual(volume, 'a-bagel').unit = 'ml';
  rejectsUnchanged(volume, [{ entryId: 'a-bagel', gramsPerUnit: 86, sourceText: "Volume cannot be treated as mass" }]);
  rejectsUnchanged(before, [corrections()[0], { entryId: 'missing-actual', nutrition: tunaEstimate(), sourceText: "Later entry does not exist" }], {}, 'ACTUAL_NOT_FOUND');
});

test('same-identity quantity corrections retain independent nutrition history and frozen evidence, while changed identity archives old evidence', () => {
  let state = correct(oldActualFixture()); const oldEntry = copy(actual(state, 'a-bagel'));
  state.items.find(item => item.id === 'bagel').nutrition.kcal = 999;
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'correct', entries: [{ id: 'a-bagel', itemId: 'bagel', quantity: 2, unit: '个', sourceText: "The user corrected quantity to 2 items without reporting nutrition again" }] });
  assert.deepEqual(actual(state, 'a-bagel').nutritionSnapshot, oldEntry.nutritionSnapshot);
  assert.deepEqual(actual(state, 'a-bagel').nutritionCorrectionHistory, oldEntry.nutritionCorrectionHistory);
  assert.equal(actual(state, 'a-bagel').correctionHistory.length, 1);
  assert.deepEqual(actual(state, 'a-bagel').correctionHistory[0].nutritionCorrectionHistory, oldEntry.nutritionCorrectionHistory);
  state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'correct', entries: [{ id: 'a-bagel', itemId: 'tuna', quantity: 1, unit: '罐', sourceText: "Correct the record identity to a different tuna portion" }] });
  assert.equal(actual(state, 'a-bagel').nutritionCorrectionHistory, undefined);
  assert.deepEqual(actual(state, 'a-bagel').correctionHistory.at(-1).nutritionCorrectionHistory, oldEntry.nutritionCorrectionHistory);
  assert.equal(actual(state, 'a-bagel').nutritionSnapshot.gramsPerUnit, null);
});

test('new explicit actuals use the unique matching current menu estimate, including newly saved planned changes', () => {
  let state = ready(input(true)); state = report(state);
  assert.equal(actual(state, 'a-tuna').nutritionSnapshot.nutrition.basisUnit, '罐'); assert.equal(actual(state, 'a-tuna').nutritionSnapshot.nutrition.kcal, 80);
  assert.equal(actual(state, 'a-veg').nutritionSnapshot.nutrition.basisAmount, 200);
  assert.equal(actual(state, 'a-tuna').quantitySource, 'reported'); assert.equal(actual(state, 'a-tuna').nutritionCorrectionHistory, undefined);
  let pending = ready(); pending = mutate(pending, 'patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'dinner', itemPatches: [{ id: 'tuna-line', nutrition: tunaEstimate() }] }] }); pending = report(pending);
  assert.equal(actual(pending, 'a-tuna').nutritionSnapshot.nutrition.basisUnit, '罐');
  assert.equal(actual(pending, 'a-tuna').nutritionSnapshot.nutrition.kcal, 80);
  assert.equal(actual(pending, 'a-tuna').nutritionSnapshot.gramsPerUnit, null);
  assert.equal(totals(pending).protein.partial, true);
});

test('ambiguous same-food overrides keep old stock evidence until the user explicitly selects a confirmed line', () => {
  const raw = input(true); raw.meals[1].plannedItems.push({ id: 'second-tuna-line', itemId: 'tuna', quantity: 1, nutrition: { ...tunaEstimate(), kcal: 90 } });
  const before = report(ready(raw));
  assert.equal(actual(before, 'a-tuna').nutritionSnapshot.nutrition.basisUnit, 'g'); assert.equal(actual(before, 'a-tuna').nutritionSnapshot.gramsPerUnit, null);
  const after = correct(before, [{ entryId: 'a-tuna', fromPlannedLineId: 'second-tuna-line', sourceText: "The user explicitly selected this meal's second estimate source" }]);
  assert.equal(actual(after, 'a-tuna').nutritionSnapshot.nutrition.kcal, 90); assertOnlyNutrition(after, before);
});

test('untracked food inference and correction require matching food names as well as matching null IDs and units', () => {
  const raw = input(); raw.meals[1].plannedItems.push({ id: 'oats-line', itemId: null, name: "Oats", quantity: 40, unit: 'g', nutrition: nutrients(380, 13, 66, 6, 100, 'g', 'estimate') }, { id: 'rice-line', itemId: null, name: "Rice", quantity: 40, unit: 'g', nutrition: nutrients(116, 3, 25, 1, 100, 'g', 'estimate') });
  let state = ready(raw); state = mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', entries: [{ id: 'a-oats', itemId: null, name: "Oats", quantity: 40, unit: 'g', sourceText: "Actually ate 40 g oats" }] });
  assert.equal(actual(state, 'a-oats').nutritionSnapshot.nutrition.kcal, 380);
  rejectsUnchanged(state, [{ entryId: 'a-oats', fromPlannedLineId: 'rice-line', sourceText: "Matching null IDs do not permit crossing food identities" }], {}, 'NUTRITION_IDENTITY_CONFLICT');
});

test('history limits reject atomically, identical no-ops stay harmless at the limit and closed actual records can update evidence', () => {
  const before = oldActualFixture(); actual(before, 'a-bagel').nutritionCorrectionHistory = Array.from({ length: 100 }, () => ({ at: NOW, sourceText: "Previous provenance", previous: null }));
  rejectsUnchanged(before, [{ entryId: 'a-bagel', gramsPerUnit: 86, sourceText: "Reject the 101st correction" }], {}, 'NUTRITION_HISTORY_LIMIT');
  assert.equal(correct(before, [{ entryId: 'a-bagel', gramsPerUnit: 85, sourceText: "Identical values do not append history" }]), before);
  let closed = oldActualFixture(); closed = mutate(closed, 'cancel_remaining_meals', { planId: 'day', confirmed: true });
  assert.equal(plan(closed).status, 'closed_with_actuals');
  const after = correct(closed); assertOnlyNutrition(after, closed); assert.equal(plan(after).status, 'closed_with_actuals');
});
