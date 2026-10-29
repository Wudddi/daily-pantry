import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDietAction, readDietRecords, dietContext, isDietAction } from '../lib/diet.mjs';

const NOW = '2026-10-18T01:00:00.000Z';
function state() { return { revision: 0, items: [food('a', 10), food('b', 10), { ...food('fish', 10), category: 'supplement', unit: '粒' }], plans: [] }; }
function food(id, quantity) { return { id, name: id, quantity, unit: '袋', category: 'prepared', status: 'available', quantityBaselineToken: 'initial', nutrition: { basisAmount: 1, basisUnit: '袋', kcal: 100, protein: 10, carbs: 10, fat: 3, source: 'label' }, gramsPerUnit: null, confirmedAt: NOW, updatedAt: NOW }; }
function meal(id, amount, itemId = 'a') { return { id, slot: id === 'lunch' ? 'lunch' : 'dinner', title: id, plannedTime: '12:00', plannedItems: amount ? [{ id: `${id}-food`, itemId, quantity: amount }] : [] }; }
function plan() { return { id: 'day', date: '2026-10-17', title: '每日菜单', meals: [meal('lunch', 2), meal('dinner', 3)], supplementDoses: [{ id: 'oil', itemId: 'fish', plannedQuantity: 1 }] }; }
function apply(s, payload) { const result = applyDietAction(s, payload, NOW); return result.noChange ? s : { ...s, items: result.items, plans: result.plans }; }
function ready(p = plan(), s = state()) { return apply(apply(s, { action: 'save_meal_plan_draft', plan: p }), { action: 'commit_meal_plan', planId: p.id, confirmed: true }); }
const quantity = (s, id = 'a') => s.items.find((i) => i.id === id).quantity;
const entry = (id, amount, itemId = 'a') => ({ id, itemId, quantity: amount, sourceText: `用户吃了${amount}袋` });

test('actions are explicit and legacy actions stay outside diet', () => { assert.equal(isDietAction('record_meal_intake'), true); assert.equal(isDietAction('consume'), false); });
test('draft edits and adopted daily menus never deduct, including retries and later edits', () => {
  let s = state(); s = apply(s, { action: 'save_meal_plan_draft', plan: plan() }); assert.equal(quantity(s), 10);
  s = apply(s, { action: 'commit_meal_plan', planId: 'day', confirmed: true }); assert.equal(quantity(s), 10); assert.equal(quantity(s, 'fish'), 10);
  assert.equal(apply(s, { action: 'commit_meal_plan', planId: 'day', confirmed: true }), s);
  const changed = { ...plan(), title: '修改草稿', meals: [meal('lunch', 1), meal('dinner', 3)] };
  s = apply(s, { action: 'save_meal_plan_draft', plan: changed }); assert.equal(quantity(s), 10); assert.equal(s.plans[0].title, '修改草稿');
  s = apply(s, { action: 'commit_meal_plan', planId: 'day', confirmed: true }); assert.equal(quantity(s), 10); assert.equal(s.plans[0].title, '修改草稿');
});
test('ordinary completion debits only actual meal amount; dinner stays planned with no reservation', () => {
  const s = apply(ready(), { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', entries: [entry('l1', 1)] });
  assert.equal(quantity(s), 9); assert.equal(s.plans[0].accountedDebits.find((l) => l.itemId === 'a').quantity, 1); assert.equal(s.plans[0].meals[1].state, 'reserved');
});
test('as-planned completion does not double-debit or fabricate actual time or dose status', () => {
  let s = ready(); const command = { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, sourceText: '午饭按计划吃了' };
  s = apply(s, command); assert.equal(quantity(s), 8); assert.equal(s.plans[0].meals[0].actualTime, null); assert.equal(s.plans[0].meals[0].plannedTime, '12:00'); assert.equal(s.plans[0].supplementDoses[0].state, 'reserved'); assert.equal(s.plans[0].meals[0].actualEntries[0].quantitySource, 'confirmed_plan_portion'); assert.equal(apply(s, command), s);
});
test('long IDs with common prefixes generate distinct stable planned entry IDs', () => {
  const prefix = 'x'.repeat(99); const p = { ...plan(), id: `${prefix}p`, meals: [{ ...meal(`${prefix}m`, 1), plannedItems: [{ id: `${prefix}a`, itemId: 'a', quantity: 1 }, { id: `${prefix}b`, itemId: 'b', quantity: 1 }] }] }; let s = ready(p);
  const command = { action: 'record_meal_intake', planId: p.id, mealId: p.meals[0].id, mode: 'complete', matchesPlannedFood: true }; s = apply(s, command);
  assert.equal(s.plans[0].meals[0].actualEntries.length, 2); assert.equal(new Set(s.plans[0].meals[0].actualEntries.map((e) => e.id)).size, 2); assert.equal(apply(s, command), s);
});
test('missing actual food is not assumed zero and conflicting business IDs cannot duplicate events', () => {
  let s = ready(); assert.throws(() => apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete' }), { code: 'ACTUAL_CONTENT_REQUIRED' });
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', entries: [entry('same-event', 1)] });
  assert.throws(() => apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'dinner', entries: [entry('same-event', 1)] }), { code: 'ACTUAL_ID_CONFLICT' });
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'correct', entries: [{ ...entry('same-event', 1), unit: 'g' }] }); assert.equal(s.plans[0].inventoryAccounting, 'pending_reconciliation'); assert.equal(s.plans[0].meals[0].actualEntries[0].unit, 'g');
});
test('actual entries append without replacing old facts, stable IDs reject conflicts, corrections preserve words', () => {
  let s = ready(); const first = { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', entries: [entry('one', 1)] };
  s = apply(s, first); assert.equal(apply(s, first), s);
  s = apply(s, { ...first, entries: [entry('two', 2)] }); assert.equal(s.plans[0].meals[0].actualEntries.length, 2); assert.equal(quantity(s), 7);
  assert.throws(() => apply(s, { ...first, entries: [entry('one', 2)] }), { code: 'ACTUAL_ID_CONFLICT' });
  s = apply(s, { ...first, mode: 'correct', entries: [entry('one', 0.5)] }); assert.equal(quantity(s), 7.5); assert.equal(s.plans[0].meals[0].actualEntries[0].correctionHistory[0].sourceText, '用户吃了1袋');
});
test('same-day redistribution changes no stock before or after a reported meal', () => {
  let s = ready(); s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true }); const before = clone(s.items); const raw = s.plans[0].meals[0].actualEntries[0].sourceText;
  s = apply(s, { action: 'revise_unconsumed_meals', planId: 'day', confirmed: true, allocationOnly: true, meals: [meal('lunch', 3), meal('dinner', 2)] }); assert.deepEqual(s.items, before); assert.equal(s.plans[0].meals[0].actualEntries[0].sourceText, raw);
  assert.throws(() => apply(s, { action: 'revise_unconsumed_meals', planId: 'day', confirmed: true, allocationOnly: true, meals: [meal('lunch', 4)] }), { code: 'DAILY_TOTAL_CONFLICT' });
});
test('redistribution cannot offset explicitly reported extra intake; finishing all meals releases balance', () => {
  let p = plan(); p.meals = [meal('lunch', 2), meal('dinner', 0)]; let s = ready(p);
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true });
  s = apply(s, { action: 'revise_unconsumed_meals', planId: 'day', confirmed: true, allocationOnly: true, meals: [meal('lunch', 1), meal('dinner', 1)] }); assert.equal(quantity(s), 8);
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'dinner', mode: 'complete', entries: [entry('d1', 1)] }); assert.equal(quantity(s), 7);
});
test('actual meal and supplement settle atomically; bad dose does not half-write', () => {
  let s = ready(); const input = { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, actualTime: '12:40', supplements: [{ doseId: 'oil', mode: 'complete', matchesPlannedDose: true, actualTime: '12:40' }] };
  const before = clone(s); assert.throws(() => apply(s, { ...input, supplements: [{ doseId: 'wrong', mode: 'complete' }] }), { code: 'DOSE_NOT_FOUND' }); assert.deepEqual(s, before);
  s = apply(s, input); assert.equal(quantity(s), 8); assert.equal(quantity(s, 'fish'), 9); assert.equal(s.plans[0].supplementDoses[0].actualTime, '12:40'); assert.equal(apply(s, input), s);
});
test('started meal plans can be revised while cancelling remaining never refunds actuals', () => {
  let s = apply(ready(), { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', entries: [entry('l1', 1)] });
  const actual = clone(s.plans[0].meals[0].actualEntries);
  s = apply(s, { action: 'revise_unconsumed_meals', planId: 'day', confirmed: true, meals: [meal('lunch', 1)] });
  assert.deepEqual(s.plans[0].meals[0].actualEntries, actual); assert.equal(quantity(s), 9); assert.equal(s.plans[0].meals[0].planRevisionHistory.length, 1);
  assert.throws(() => apply(s, { action: 'cancel_meal_plan', planId: 'day', confirmed: true }), { code: 'PLAN_HAS_ACTUALS' });
  s = apply(s, { action: 'cancel_remaining_meals', planId: 'day', confirmed: true }); assert.equal(quantity(s), 9); assert.equal(quantity(s, 'fish'), 10); assert.equal(s.plans[0].status, 'closed_with_actuals'); assert.equal(apply(s, { action: 'cancel_remaining_meals', planId: 'day', confirmed: true }), s);
});
test('baseline guard rejects stale refunds while nutrition edits retain accounting', () => {
  // A persisted pre-upgrade plan already debited these planned portions. It is
  // historical evidence, not a new menu saved under the actual-only contract.
  let s = ready(); delete s.plans[0].foodAccounting; delete s.plans[0].supplementAccounting;
  s.plans[0].accountedDebits = [{ itemId: 'a', name: 'a', quantity: 5, unit: '袋', baselineToken: 'initial', unknownBalance: false }, { itemId: 'fish', name: 'fish', quantity: 1, unit: '粒', baselineToken: 'initial', unknownBalance: false }];
  s.plans[0].items = clone(s.plans[0].accountedDebits); s.items[0].quantity = 5; s.items[2].quantity = 9;
  s.items = s.items.map((i) => i.id === 'a' ? { ...i, quantity: 4, quantityBaselineToken: 'recounted' } : i);
  assert.throws(() => apply(s, { action: 'cancel_meal_plan', planId: 'day', confirmed: true }), { code: 'BASELINE_REQUIRES_REVIEW' }); assert.equal(quantity(s), 4);
  const after = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', entries: [entry('l1', 1)] }); assert.equal(after.plans[0].inventoryAccounting, 'pending_reconciliation'); assert.equal(quantity(after), 4); assert.equal(after.plans[0].meals[0].actualEntries[0].sourceText, '用户吃了1袋');
});
test('actual food shortage clamps stock with an audited shortfall while an independent dose settles once', () => {
  let s = ready();
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'complete', entries: [entry('too-many', 20)], supplements: [{ doseId: 'oil', mode: 'complete', entries: [entry('oil2', 2, 'fish')] }] });
  assert.equal(quantity(s), 0); assert.equal(quantity(s, 'fish'), 8); assert.equal(s.plans[0].inventoryAccounting, 'settled'); assert.equal(s.plans[0].meals[0].actualEntries[0].quantity, 20); assert.equal(s.plans[0].supplementDoses[0].actualEntries[0].quantity, 2);
  const credit = s.plans[0].accountedDebits.find(line => line.itemId === 'a');
  assert.equal(credit.quantity, 20); assert.equal(credit.shortfallQuantity, 10);
  assert.ok(s.plans[0].accountingWarnings.some(warning => warning.itemId === 'a' && warning.code === 'STOCK_SHORTFALL_RECORDED' && warning.quantity === 10));
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'correct', entries: [entry('too-many', 1)] }); assert.equal(s.plans[0].inventoryAccounting, 'settled'); assert.equal(quantity(s), 9); assert.equal(quantity(s, 'fish'), 8);
  assert.equal(s.plans[0].meals[0].actualEntries[0].correctionHistory[0].quantity, 20);
});
test('unknown quantities and explicit units stay unknown; missing dates are not inferred', () => {
  assert.throws(() => ready({ ...plan(), date: undefined })); assert.throws(() => ready({ ...plan(), date: '2026-02-30' })); assert.throws(() => ready({ ...plan(), meals: [{ ...meal('lunch', 1), plannedItems: [{ id: 'x', itemId: 'a', quantity: 1, unit: 'g' }] }] }));
  let s = state(); s.items[0].quantity = null; s = ready(plan(), s); assert.equal(quantity(s), null); assert.deepEqual(s.plans[0].accountedDebits, []);
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', entries: [entry('unknown', null)] }); assert.equal(s.plans[0].inventoryAccounting, 'settled'); assert.equal(s.items[0].status, 'available'); assert.equal(s.plans[0].meals[0].actualEntries[0].quantity, null);
  s = apply(s, { action: 'record_meal_intake', planId: 'day', mealId: 'lunch', mode: 'correct', entries: [entry('unknown', 1)] }); assert.equal(s.plans[0].accountedDebits[0].unknownBalance, true); assert.equal(quantity(s), null);
});
test('legacy records are untouched; duplicate day IDs cannot reserve a second plan', () => {
  let s = state(); s.plans.push({ id: 'legacy', date: '2026-10-16', status: 'reserved', items: [] }); const old = clone(s.plans[0]); s = ready(plan(), s); assert.deepEqual(s.plans[0], old);
  assert.throws(() => apply(s, { action: 'save_meal_plan_draft', plan: { ...plan(), id: 'other' } }), { code: 'DAY_PLAN_CONFLICT' });
});
test('list pagination and lossless details obey final encoded output budgets', () => {
  const s = ready(); const p = s.plans[0]; p.meals[0].sourceText = '\u0001'.repeat(30000); p.notes = '说明'.repeat(40000); const original = JSON.stringify(p);
  const listed = readDietRecords(s); assert.equal(listed.truncated, true); assert.equal(listed.records[0].recordTruncated, true); assert.ok(JSON.stringify(listed).length <= 64000);
  let offset = 0; let text = ''; do { const part = readDietRecords(s, { recordId: p.id, offset }); assert.ok(JSON.stringify(part).length <= 64000); text += part.text; offset = part.nextOffset; } while (offset !== null); assert.equal(text, original);
  for (let i = 0; i < 70; i++) s.plans.push({ ...clone(p), id: `old-${i}`, date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}` });
  const page = readDietRecords(s, { limit: 1 }); assert.equal(page.total, 71); assert.equal(page.nextCursor, '1');
  const context = dietContext(s, '2026-10-17'); assert.ok(JSON.stringify(context).length <= 24000); assert.equal(context.records[0].meals[0].actualTime, null);
});
function clone(value) { return structuredClone(value); }

const staple = (id, name, quantity, unit = 'g', extra = {}) => ({ id, itemId: null, name, quantity, unit, sourceText: '用户明确常备，不逐项盘库存', ...extra });
test('untracked staples coexist with tracked food without creating stock or changing its debit', () => {
  const p = plan(); p.meals[0].plannedItems.push(staple('oats', '燕麦', 60)); p.meals[1].plannedItems.push(staple('yogurt', '酸奶', 200));
  let s = ready(p); assert.equal(quantity(s), 10); assert.equal(s.items.length, 3); assert.deepEqual(s.plans[0].accountedDebits, []);
  s = apply(s, { action: 'record_meal_intake', planId: p.id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true });
  assert.equal(quantity(s), 8); const oats = s.plans[0].meals[0].actualEntries.find(entry => entry.itemId === null);
  assert.equal(oats.name, '燕麦'); assert.equal(oats.quantity, 60); assert.equal(oats.quantitySource, 'confirmed_plan_portion'); assert.equal(oats.nutritionSnapshot.nutrition.kcal, null);
  s = apply(s, { action: 'cancel_remaining_meals', planId: p.id, confirmed: true }); assert.equal(quantity(s), 8); assert.equal(s.items.length, 3);
});
test('untracked nutrition preserves its basis and unknown macros through as-planned reporting', () => {
  const p = { ...plan(), meals: [{ ...meal('lunch', 0), plannedItems: [staple('oats', '燕麦', 60, 'g', { nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 380, source: 'label', sourceText: '100g热量380，其他看不清' } })] }], supplementDoses: [] };
  let s = ready(p); assert.deepEqual(s.items, state().items); assert.equal(s.plans[0].accountedDebits.length, 0);
  s = apply(s, { action: 'record_meal_intake', planId: p.id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true });
  const nutrition = s.plans[0].meals[0].actualEntries[0].nutritionSnapshot.nutrition;
  assert.equal(nutrition.basisAmount, 100); assert.equal(nutrition.kcal, 380); assert.equal(nutrition.protein, null); assert.equal(nutrition.nutrientSources.protein, 'unknown'); assert.equal(nutrition.sourceText, '100g热量380，其他看不清');
});
test('untracked redistribution matches each normalized name and unit, not a shared null ID', () => {
  const p = { ...plan(), meals: [{ ...meal('lunch', 0), plannedItems: [staple('oats1', '燕麦', 60), staple('egg1', '蛋', 2, '个')] }, { ...meal('dinner', 0), plannedItems: [staple('oats2', '燕麦', 40), staple('egg2', '蛋', 1, '个')] }], supplementDoses: [] };
  const before = ready(p); const meals = clone(p.meals); meals[0].plannedItems[0].quantity = 40; meals[1].plannedItems[0].quantity = 60;
  const after = apply(before, { action: 'revise_unconsumed_meals', planId: p.id, confirmed: true, allocationOnly: true, meals }); assert.deepEqual(after.items, before.items);
  const swap = clone(meals); swap[0].plannedItems[0].quantity -= 1; swap[0].plannedItems.push(staple('different', '酸奶', 1));
  assert.throws(() => apply(after, { action: 'revise_unconsumed_meals', planId: p.id, confirmed: true, allocationOnly: true, meals: swap }), { code: 'DAILY_TOTAL_CONFLICT' });
  const wrongUnit = clone(meals); wrongUnit[0].plannedItems[0].unit = 'ml';
  assert.throws(() => apply(after, { action: 'revise_unconsumed_meals', planId: p.id, confirmed: true, allocationOnly: true, meals: wrongUnit }), { code: 'DAILY_TOTAL_CONFLICT' });
});
test('tracked names cannot bypass missing stock through null ID; supplements always require ID', () => {
  const s = state(); s.items[0].name = ' 燕麦 '; s.items[0].quantity = 0; s.items[0].status = 'depleted';
  const p = { ...plan(), meals: [{ ...meal('lunch', 0), plannedItems: [staple('bypass', '燕 麦', 60)] }], supplementDoses: [] };
  assert.throws(() => ready(p, s), { code: 'TRACKED_FOOD_REQUIRES_ID' });
  for (const missing of [{ name: undefined }, { unit: undefined }, { nutrition: { kcal: 100 } }]) assert.throws(() => ready({ ...p, meals: [{ ...meal('lunch', 0), plannedItems: [staple('new', '酸奶', 60, 'g', missing)] }] }));
  assert.throws(() => ready({ ...plan(), supplementDoses: [{ id: 'oil', itemId: null, plannedQuantity: 1, unit: '粒' }] }));
  let drafted = apply(state(), { action: 'save_meal_plan_draft', plan: p }); drafted.items.push({ ...food('new-oats', 0), name: '燕麦', status: 'depleted' });
  assert.throws(() => apply(drafted, { action: 'commit_meal_plan', planId: p.id, confirmed: true }), { code: 'TRACKED_FOOD_REQUIRES_ID' });
});

test('today context identifies each untracked planned food and exposes compact nutrition evidence with a detail pointer', () => {
  const p = { ...plan(), meals: [{ ...meal('lunch', 0), plannedItems: [staple('oats', '燕麦', 60, 'g', { nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 380, source: 'label', sourceText: '完整标签原文'.repeat(1000) } }), staple('egg', '鸡蛋', 2, '个')] }], supplementDoses: [] };
  const s = ready(p); const context = dietContext(s, p.date); const lines = context.records[0].meals[0].plannedItems;
  assert.equal(lines[0].name, '燕麦'); assert.equal(lines[1].name, '鸡蛋'); assert.equal(lines[0].nutrition.basisAmount, 100); assert.equal(lines[0].nutrition.kcal, 380); assert.equal(lines[0].nutrition.source, 'label'); assert.equal(lines[0].nutrition.protein, null); assert.equal(lines[1].nutrition.kcal, null);
  assert.equal(lines[0].nutritionSourceTextAvailable, true); assert.equal(lines[0].nutrition.sourceText, undefined); assert.equal(context.records[0].recordId, p.id); assert.ok(JSON.stringify(context).length <= 24000);
  assert.equal(JSON.parse(readDietRecords(s, { recordId: p.id }).text).meals[0].plannedItems[0].nutritionSnapshot.nutrition.sourceText, p.meals[0].plannedItems[0].nutrition.sourceText);
});

test('correcting an untracked actual food preserves its nutrition only when both identity and unit remain the same', () => {
  const p = { ...plan(), meals: [{ ...meal('lunch', 0), plannedItems: [staple('egg', '鸡蛋', 2, '个', { nutrition: { basisAmount: 1, basisUnit: '个', kcal: 70, source: 'label' } })] }], supplementDoses: [] };
  let s = ready(p); s = apply(s, { action: 'record_meal_intake', planId: p.id, mealId: 'lunch', mode: 'complete', matchesPlannedFood: true });
  const initial = s; const entry = s.plans[0].meals[0].actualEntries[0];
  s = apply(s, { action: 'record_meal_intake', planId: p.id, mealId: 'lunch', mode: 'correct', entries: [{ id: entry.id, itemId: null, name: '鸡蛋', quantity: 3, unit: '个', sourceText: '实际3个鸡蛋' }] });
  assert.equal(s.plans[0].meals[0].actualEntries[0].nutritionSnapshot.nutrition.kcal, 70);
  for (const changed of [{ name: '酸奶', quantity: 200, unit: 'g' }, { name: '鸡蛋', quantity: 100, unit: 'g' }]) {
    const after = apply(s, { action: 'record_meal_intake', planId: p.id, mealId: 'lunch', mode: 'correct', entries: [{ id: entry.id, itemId: null, ...changed, sourceText: '更正实际食品或计量口径' }] });
    const actual = after.plans[0].meals[0].actualEntries[0]; assert.equal(actual.nutritionSnapshot, null); assert.equal(actual.correctionHistory.at(-1).nutritionSnapshot.nutrition.kcal, 70); assert.deepEqual(after.items, initial.items);
  }
});
