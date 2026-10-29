import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { validateDietHistory } from '../lib/diet-history.mjs';
import { historyNutritionSignature } from '../lib/diet-history-nutrition.mjs';

const NOW = '2026-10-18T12:00:00Z';
const LATER = '2026-10-18T13:00:00Z';
const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const copy = value => structuredClone(value);
function state() {
  return { schemaVersion: 1, revision: 0, updatedAt: NOW,
    items: [validateItem({ id: 'current', name: '当前面包', category: 'bread', quantity: 10, unit: '片', status: 'pending' }, NOW)],
    plans: [], preferences: [], events: [], operationIds: [] };
}
function record(overrides = {}) {
  return { id: 'nutrition-history', date: '2026-10-17', title: '有来源的历史菜单', confirmation: 'partial_report',
    meals: [{ id: 'lunch', name: '午餐', status: 'reported_completed', plannedTime: '12:00', actualTime: null,
      items: [{ id: 'potato', name: '土豆', inventoryItemId: 'old-potato-batch', quantity: 400,
        plannedQuantity: 400, actualQuantity: 450, quantitySource: 'reported', unit: 'g',
        nutrition: { kcal: 320, protein: 8, carbs: 72, fat: 0.4, source: 'estimate', sourceText: '400g计划份量估算' },
        sourceText: '16日450克土豆；本轮未重述生熟口径' }] }],
    supplements: [{ id: 'fish-oil', name: '鱼油', quantity: 1, plannedQuantity: 1, actualQuantity: null,
      quantitySource: 'unknown', unit: '粒', status: 'unknown', actualTime: null, sourceText: '计划1粒，未核对执行或包装营养' }],
    nutrition: { kcal: 1960, protein: 145, carbs: 250, fat: 50, source: 'estimate', sourceText: '已按当前食物与份量重算全天；补给标签仍未知' },
    planSourceText: '原计划土豆400g', executionSourceText: '用户确认土豆450g',
    sourceRefs: [{ conversationId: 'current-codex-chat', messageKey: 'potato-date-quantity-confirmation', kind: 'user', text: '16日450克土豆' }],
    ...overrides };
}
function apply(s, r, operationId = `history-nutrition-${s.revision}`, at = NOW) {
  return applyMutation(s, { action: 'import_diet_history', record: r, operationId, expectedRevision: s.revision }, at);
}
function current(s) { return s.dietHistory[0]; }
function content(r) {
  const { recordType, inventoryEffect, createdAt, updatedAt, versions, ...value } = r;
  return value;
}

test('explicit whole-day four nutrient values bind to the sanitized current food evidence without asserting supplements', () => {
  const before = state(), input = record(), after = apply(before, input), saved = current(after);
  for (const key of KEYS) {
    assert.equal(saved.nutrition[key], input.nutrition[key]);
    assert.equal(saved.nutritionSignatures[key], historyNutritionSignature(saved));
  }
  assert.equal(saved.meals[0].items[0].plannedQuantity, 400);
  assert.equal(saved.meals[0].items[0].actualQuantity, 450);
  assert.equal(saved.supplements[0].status, 'unknown');
  assert.equal(saved.supplements[0].actualQuantity, null);
  assert.equal(saved.supplements[0].actualTime, null);
  for (const key of KEYS) assert.equal(saved.supplements[0].nutrition[key], null);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.plans, before.plans);
  assert.equal(saved.inventoryEffect, 'none');
  assert.equal(before.dietHistory, undefined);
});

test('signature follows food identity, effective quantity, unit and portion nutrition rather than just a date', () => {
  const saved = current(apply(state(), record())), baseline = historyNutritionSignature(saved);
  const changes = {
    foodId: r => { r.meals[0].items[0].id = 'different-line'; },
    inventoryBatch: r => { r.meals[0].items[0].inventoryItemId = 'another-batch'; },
    foodName: r => { r.meals[0].items[0].name = '红薯'; },
    mealAllocation: r => { r.meals[0].id = 'dinner'; },
    effectiveQuantity: r => { r.meals[0].items[0].actualQuantity = 500; },
    unit: r => { r.meals[0].items[0].unit = '个'; },
    portionBasis: r => { r.meals[0].items[0].plannedQuantity = 350; },
    portionKcal: r => { r.meals[0].items[0].nutrition.kcal = 300; },
    portionProtein: r => { r.meals[0].items[0].nutrition.protein = 9; },
    portionCarbs: r => { r.meals[0].items[0].nutrition.carbs = 70; },
    portionFat: r => { r.meals[0].items[0].nutrition.fat = 1; },
    supplementIdentity: r => { r.supplements[0].name = '另一种鱼油'; },
  };
  for (const [label, change] of Object.entries(changes)) {
    const changed = copy(saved); change(changed);
    assert.notEqual(historyNutritionSignature(changed), baseline, label);
  }
});

test('effective quantities honor reported evidence and keep an unfinished meal portion in its current basis', () => {
  const baseline = validateDietHistory(record());
  baseline.meals[0].status = 'partial_report';
  baseline.meals[0].items[0].actualQuantity = 100;
  const signature = historyNutritionSignature(baseline);
  const partial = copy(baseline); partial.meals[0].items[0].actualQuantity = 200;
  assert.equal(historyNutritionSignature(partial), signature, 'partial intake below the planned 400g is not a finished 200g meal');
  const completed = copy(partial); completed.meals[0].status = 'reported_completed';
  assert.notEqual(historyNutritionSignature(completed), signature);
  const unverified = copy(baseline); unverified.meals[0].items[0].quantitySource = 'unknown'; unverified.meals[0].items[0].actualQuantity = 999;
  assert.equal(historyNutritionSignature(unverified), signature, 'an unverified actual quantity cannot become the effective quantity');
  const added = copy(baseline); added.meals[0].items[0].actualQuantity = 450;
  assert.notEqual(historyNutritionSignature(added), signature, 'reported extra food changes the effective evidence');
});

test('changing menu quantities without explicitly reporting new totals preserves old bindings as stale evidence', () => {
  const first = apply(state(), record()), before = copy(first);
  const meals = copy(current(first).meals); meals[0].items[0].actualQuantity = 500;
  const updated = apply(first, { id: 'nutrition-history', meals });
  assert.deepEqual(current(updated).nutritionSignatures, current(first).nutritionSignatures);
  for (const key of KEYS) assert.notEqual(current(updated).nutritionSignatures[key], historyNutritionSignature(current(updated)));
  assert.deepEqual(current(updated).nutrition, current(first).nutrition);
  assert.deepEqual(updated.items, first.items);
  assert.deepEqual(updated.plans, first.plans);
  assert.deepEqual(first, before);
  assert.deepEqual(current(updated).versions[0].previous.nutritionSignatures, current(first).nutritionSignatures);
});

test('a partial re-report refreshes only explicitly supplied nutrient keys and explicit null removes its binding', () => {
  const first = apply(state(), record()), meals = copy(current(first).meals);
  meals[0].items[0].actualQuantity = 500;
  const stale = apply(first, { id: 'nutrition-history', meals });
  const refreshed = apply(stale, { id: 'nutrition-history', nutrition: { kcal: 2020 } });
  const saved = current(refreshed), signature = historyNutritionSignature(saved);
  assert.equal(saved.nutrition.kcal, 2020);
  assert.equal(saved.nutritionSignatures.kcal, signature);
  for (const key of ['protein', 'carbs', 'fat']) {
    assert.equal(saved.nutrition[key], current(first).nutrition[key]);
    assert.equal(saved.nutritionSignatures[key], current(first).nutritionSignatures[key]);
    assert.notEqual(saved.nutritionSignatures[key], signature);
  }
  const cleared = current(apply(refreshed, { id: 'nutrition-history', nutrition: { protein: null } }));
  assert.equal(cleared.nutrition.protein, null);
  assert.equal(Object.hasOwn(cleared.nutritionSignatures, 'protein'), false);
  assert.equal(cleared.nutritionSignatures.kcal, signature);
});

test('time, narration and evidence corrections leave current bindings intact', () => {
  const first = apply(state(), record()), meals = copy(current(first).meals), supplements = copy(current(first).supplements);
  meals[0].plannedTime = '12:30'; meals[0].actualTime = '12:40'; meals[0].actualTimeText = '12:40吃完';
  meals[0].sourceText = '补充逐字原话'; meals[0].items[0].sourceText += '\n补充没有改份量';
  supplements[0].plannedTime = '13:00'; supplements[0].sourceText += '\n仍未确认剂量';
  const after = apply(first, { id: 'nutrition-history', title: '更正来源说明', meals, supplements,
    planSourceText: '完整计划原话\n', executionSourceText: '保留新原话，不虚构摄入',
    notes: '只改时间与原话', sourceRefs: [...current(first).sourceRefs, { conversationId: 'current-codex-chat', messageKey: 'later-time-report', kind: 'user', text: '12:40吃完' }] });
  assert.equal(historyNutritionSignature(current(after)), historyNutritionSignature(current(first)));
  assert.deepEqual(current(after).nutritionSignatures, current(first).nutritionSignatures);
  assert.equal(current(after).supplements[0].actualQuantity, null);
  assert.equal(current(after).supplements[0].status, 'unknown');
  assert.deepEqual(after.items, first.items);
});

test('client-supplied signatures cannot create, refresh or replace a server binding', () => {
  const withoutTotals = record({ nutrition: { source: 'unknown' }, nutritionSignatures: { kcal: 'forged', protein: 'forged' } });
  assert.equal(validateDietHistory(withoutTotals).nutritionSignatures, undefined);
  const unsigned = apply(state(), withoutTotals);
  assert.equal(current(unsigned).nutritionSignatures, undefined);
  const signed = apply(state(), record({ nutritionSignatures: Object.fromEntries(KEYS.map(key => [key, 'forged'])) }));
  for (const key of KEYS) assert.equal(current(signed).nutritionSignatures[key], historyNutritionSignature(current(signed)));
  const meals = copy(current(signed).meals); meals[0].items[0].actualQuantity = 500;
  const candidate = { ...current(signed), meals };
  const attempted = apply(signed, { id: 'nutrition-history', meals,
    nutritionSignatures: Object.fromEntries(KEYS.map(key => [key, historyNutritionSignature(candidate)])) });
  assert.deepEqual(current(attempted).nutritionSignatures, current(signed).nutritionSignatures);
  assert.notEqual(current(attempted).nutritionSignatures.kcal, historyNutritionSignature(current(attempted)));
  const noExplicitMacro = apply(attempted, { id: 'nutrition-history', nutrition: { fiber: 20 }, nutritionSignatures: { kcal: historyNutritionSignature(current(attempted)) } });
  assert.deepEqual(current(noExplicitMacro).nutritionSignatures, current(signed).nutritionSignatures);
  const explicit = apply(noExplicitMacro, { id: 'nutrition-history', nutrition: { kcal: 2020 }, nutritionSignatures: { kcal: 'still-forged', protein: 'still-forged' } });
  assert.equal(current(explicit).nutritionSignatures.kcal, historyNutritionSignature(current(explicit)));
  assert.equal(current(explicit).nutritionSignatures.protein, current(signed).nutritionSignatures.protein);
});

test('signatures bind normalized stored precision and a repeat of the same import stays idempotent', () => {
  const input = record(), raw = input.meals[0].items[0]; raw.actualQuantity = 450.1234567;
  raw.nutrition.kcal = 320.1234567;
  const payload = { action: 'import_diet_history', record: input, operationId: 'signed-once', expectedRevision: 0 };
  const first = applyMutation(state(), payload, NOW);
  assert.equal(current(first).meals[0].items[0].actualQuantity, 450.123457);
  assert.equal(current(first).meals[0].items[0].nutrition.kcal, 320.123457);
  assert.equal(current(first).nutritionSignatures.kcal, historyNutritionSignature(current(first)));
  assert.notEqual(current(first).nutritionSignatures.kcal, historyNutritionSignature(input));
  assert.strictEqual(applyMutation(first, { ...payload, expectedRevision: 999 }, LATER), first);
  assert.strictEqual(apply(first, input, 'signed-same-content-new-operation', LATER), first);
  assert.equal(current(first).versions.length, 0);
});

test('signed imports and corrections remain stock-neutral after recounts and on repeated operations', () => {
  const first = apply(state(), record());
  const recounted = applyMutation(first, { action: 'set_quantity', id: 'current', quantity: 3, operationId: 'absolute-recount', expectedRevision: first.revision }, LATER);
  const meals = copy(current(recounted).meals); meals[0].items[0].actualQuantity = 500;
  const patch = { action: 'import_diet_history', record: { id: 'nutrition-history', meals, nutrition: { kcal: 2020 } }, operationId: 'signed-correction', expectedRevision: recounted.revision };
  const after = applyMutation(recounted, patch, LATER);
  assert.deepEqual(after.items, recounted.items);
  assert.deepEqual(after.plans, recounted.plans);
  assert.equal(after.items[0].quantity, 3);
  assert.strictEqual(applyMutation(after, { ...patch, expectedRevision: 0 }, LATER), after);
  assert.strictEqual(apply(after, patch.record, 'same-correction-new-operation', LATER), after);
  assert.equal(after.dietHistory.length, 1);
  assert.equal(current(after).versions.length, 1);
  assert.equal(current(after).versions[0].previous.nutritionSignatures.kcal, current(first).nutritionSignatures.kcal);
});

test('server-added nutrient bindings cannot silently exceed the single-record 240000-character budget', () => {
  const input = record({ planSourceText: 'x'.repeat(100000), executionSourceText: 'y'.repeat(100000),
    meals: [{ id: 'lunch', name: '午餐', status: 'planned', items: Array.from({ length: 30 }, (_, i) => ({
      id: `food-${i}`, name: '菜'.repeat(200), inventoryItemId: `batch-${i}`, quantity: 100, plannedQuantity: 100, unit: 'g',
    })) }] });
  assert.ok(JSON.stringify(validateDietHistory(input)).length < 240000, 'the user input itself fits before adding server metadata');
  const before = state(), snapshot = copy(before);
  let after;
  try { after = apply(before, input, 'large-signed-record'); }
  catch (error) {
    assert.equal(error.status, 400);
    assert.match(error.message, /240000/);
  }
  assert.deepEqual(before, snapshot, 'either a bounded save or a rejection must leave the input state untouched');
  if (after) assert.ok(JSON.stringify(content(current(after))).length <= 240000, 'size must be checked after adding signatures, not only before');
});
