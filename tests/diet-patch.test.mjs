import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { materializeDietPlanForEdit, dietContext, isDietAction } from '../lib/diet.mjs';

const NOW = '2026-10-19T14:00:00.000Z';
const LATER = '2026-10-19T15:00:00.000Z';
const copy = value => structuredClone(value);
const macros = (kcal = 100, unit = '袋') => ({ basisAmount: 1, basisUnit: unit, kcal, protein: 10, carbs: 8, fat: 3, source: 'label', sourceText: '用户确认的包装原文', sourceNote: '包装标签' });
const oatsNutrition = { basisAmount: 100, basisUnit: 'g', kcal: 380, protein: 13, carbs: 66, fat: 6, source: 'estimate', sourceNote: '用户允许的常备食品工作估值', sourceText: '燕麦每100g估值原文' };
function food(id, quantity, unit = '袋', category = 'prepared', kcal = 100) { return validateItem({ id, name: id, quantity, unit, category, gramsPerUnit: unit === '袋' ? 125 : null, nutrition: macros(kcal, unit) }, NOW); }
function fixture() {
  return { schemaVersion: 1, revision: 0, updatedAt: NOW, preferences: [], events: [], operationIds: [], plans: [], items: [food('beef', 20), food('chicken', 20, '袋', 'prepared', 180), food('veg', 1000, 'g', 'vegetable', 0.3), food('tuna', 4, '罐', 'protein', 80), food('fish', 20, '粒', 'supplement', 10), food('beta', 100, 'g', 'supplement', 0), food('magnesium', null, '片', 'supplement', 0)] };
}
function input() {
  return { id: 'day', date: '2026-10-19', title: '完整全天菜单', notes: '原完整菜单备注', meals: [
    { id: 'breakfast', slot: 'breakfast', title: '早餐', plannedTime: '08:00', plannedTimeText: '起床后', plannedItems: [{ id: 'beef-line', itemId: 'beef', quantity: 2, sourceText: '原卤肉餐建议' }, { id: 'oats-line', itemId: null, name: '燕麦', quantity: 60, unit: 'g', sourceText: '常备燕麦原话', nutrition: oatsNutrition }] },
    { id: 'lunch', slot: 'lunch', title: '午餐', plannedTime: '12:30', plannedTimeText: '午饭时间', plannedItems: [{ id: 'chicken-line', itemId: 'chicken', quantity: 3, sourceText: '鸡肉原计划' }] },
    { id: 'dinner', slot: 'dinner', title: '晚餐', plannedTime: '18:00', plannedItems: [{ id: 'veg-line', itemId: 'veg', quantity: 300, sourceText: '蔬菜原话' }] },
  ], supplementDoses: [{ id: 'oil', itemId: 'fish', plannedQuantity: 1, timingSlot: 'breakfast', plannedMealId: 'breakfast', instruction: '随餐', sourceText: '鱼油安排原话' }, { id: 'beta-pre', itemId: 'beta', plannedQuantity: 1.6, timingSlot: 'pre_workout', requirement: 'optional', scheduled: false, instruction: '用户当天决定', sourceText: '可选补给原话' }] };
}
function apply(state, action, fields = {}, operationId = `${action}-${state.revision}`, at = NOW) { return applyMutation(state, { action, ...fields, operationId, expectedRevision: state.revision }, at); }
function drafted(raw = input(), state = fixture()) { return apply(state, 'save_meal_plan_draft', { plan: raw }); }
function ready(raw = input(), state = fixture()) { return apply(drafted(raw, state), 'commit_meal_plan', { planId: raw.id, confirmed: true }); }
const plan = state => state.plans.find(p => p.id === 'day');
const stock = (state, id) => state.items.find(item => item.id === id).quantity;
const meal = (state, id) => plan(state).meals.find(item => item.id === id);
const line = (state, mealId, lineId) => meal(state, mealId).plannedItems.find(item => item.id === lineId);
function patch(state, fields, operationId) { return apply(state, 'patch_meal_plan', { planId: 'day', mode: 'apply', confirmed: true, ...fields }, operationId); }
const amount = (mealId, lineId, quantity) => [{ id: mealId, itemPatches: [{ id: lineId, quantity }] }];
function rejectsUnchanged(state, fields, code, status) {
  const before = copy(state);
  assert.throws(() => patch(state, fields), error => (!code || error.code === code) && (!status || error.status === status));
  assert.deepEqual(state, before);
}

test('draft quantity patches change one line and preserve all other meals, supplements, sources and snapshots without any debit', () => {
  const before = drafted(); const after = patch(before, { mode: 'draft', mealPatches: amount('breakfast', 'beef-line', 1) });
  assert.equal(isDietAction('patch_meal_plan'), true);
  assert.deepEqual(after.items, before.items);
  assert.equal(plan(after).status, 'draft');
  assert.equal(line(after, 'breakfast', 'beef-line').quantity, 1);
  assert.deepEqual(line(after, 'breakfast', 'beef-line').nutritionSnapshot, line(before, 'breakfast', 'beef-line').nutritionSnapshot);
  assert.equal(line(after, 'breakfast', 'beef-line').sourceText, '原卤肉餐建议');
  assert.deepEqual(line(after, 'breakfast', 'oats-line'), line(before, 'breakfast', 'oats-line'));
  assert.deepEqual(meal(after, 'lunch'), meal(before, 'lunch'));
  assert.deepEqual(meal(after, 'dinner'), meal(before, 'dinner'));
  assert.deepEqual(plan(after).supplementDoses, plan(before).supplementDoses);
});

test('apply changes only the target debit and unchanged meals/supplements remain exactly equal', () => {
  const before = ready(); const after = patch(before, { mealPatches: amount('breakfast', 'beef-line', 1) });
  assert.equal(stock(before, 'beef'), 20);
  assert.equal(stock(after, 'beef'), 20);
  for (const id of ['chicken', 'veg', 'fish', 'beta']) assert.equal(stock(after, id), stock(before, id));
  assert.deepEqual(meal(after, 'lunch'), meal(before, 'lunch'));
  assert.deepEqual(meal(after, 'dinner'), meal(before, 'dinner'));
  assert.deepEqual(plan(after).supplementDoses, plan(before).supplementDoses);
  assert.equal(after.events.at(-1).action, 'patch_meal_plan');
});

test('successive saved edits are current immediately and adoption never loses actual supplements or debits food', () => {
  let state=apply(ready(),'set_supplement_check',{planId:'day',doseId:'oil',checked:true});const original=copy(state),dose=copy(plan(state).supplementDoses[0]);
  state=patch(state,{mode:'draft',mealPatches:amount('breakfast','beef-line',1)});state=patch(state,{mode:'draft',mealPatches:amount('dinner','veg-line',200)});
  assert.deepEqual(state.items,original.items);assert.equal(line(state,'breakfast','beef-line').quantity,1);assert.equal(line(state,'dinner','veg-line').quantity,200);
  assert.equal(materializeDietPlanForEdit(state,'day','active').meals[0].plannedItems[0].quantity,1);
  state=apply(state,'commit_meal_plan',{planId:'day',confirmed:true});assert.equal(stock(state,'beef'),20);assert.equal(stock(state,'veg'),1000);assert.equal(stock(state,'fish'),19);
  assert.deepEqual(plan(state).supplementDoses[0],dose);assert.ok(!plan(state).draft);assert.equal(apply(state,'commit_meal_plan',{planId:'day',confirmed:true},'retry-adopt'),state);
});

test('apply preserves earlier saved menu edits without requiring a separate pending-draft confirmation', () => {
  const before=patch(ready(),{mode:'draft',notes:'另一餐的保存修改'}),after=patch(before,{mealPatches:amount('dinner','veg-line',200)});
  assert.equal(plan(after).notes,'另一餐的保存修改');assert.equal(line(after,'dinner','veg-line').quantity,200);assert.deepEqual(after.items,before.items);
});

test('legacy meal replacement preserves independently saved current notes and all other planned fields', () => {
  const before=patch(ready(),{mode:'draft',notes:'其它修改必须保留'});
  const after=apply(before,'revise_unconsumed_meals',{planId:'day',confirmed:true,meals:[{...copy(meal(before,'dinner')),title:'局部修改'}]});
  assert.equal(plan(after).notes,'其它修改必须保留');assert.equal(meal(after,'dinner').title,'局部修改');assert.deepEqual(after.items,before.items);
});

test('successive draft patches freeze both newly replaced and unchanged line/dose snapshots across later label updates', () => {
  let state = patch(ready(), { mode: 'draft', mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', itemId: 'tuna', quantity: 1 }] }] });
  const first = materializeDietPlanForEdit(state, 'day');
  state = { ...state, items: state.items.map(item => ({ ...item, nutrition: { ...item.nutrition, kcal: 999, sourceText: '后来更新的库存标签' } })) };
  state = patch(state, { mode: 'draft', mealPatches: amount('dinner', 'veg-line', 200) });
  const next = materializeDietPlanForEdit(state, 'day');
  assert.deepEqual(next.meals[0].plannedItems[0].nutritionSnapshot, first.meals[0].plannedItems[0].nutritionSnapshot);
  assert.deepEqual(next.meals[1], first.meals[1]);
  assert.deepEqual(next.supplementDoses, first.supplementDoses);
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  assert.equal(line(state, 'breakfast', 'beef-line').nutritionSnapshot.nutrition.kcal, 80);
  assert.equal(line(state, 'lunch', 'chicken-line').nutritionSnapshot.nutrition.kcal, 180);
  assert.equal(plan(state).supplementDoses[0].nutritionSnapshot.nutrition.kcal, 10);
  assert.equal(stock(state, 'tuna'), 4);
});

test('food replacement adopts the new stock unit and evidence without inheriting an old estimate, name or quote', () => {
  const raw = input(); raw.meals[0].plannedItems[0].nutrition = { ...macros(123), source: 'estimate', sourceText: '只属于旧卤肉的估值' };
  const before = ready(raw);
  const after = patch(before, { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', itemId: 'tuna', quantity: 1 }] }] });
  const changed = line(after, 'breakfast', 'beef-line');
  assert.equal(changed.id, 'beef-line'); assert.equal(changed.itemId, 'tuna'); assert.equal(changed.unit, '罐');
  assert.equal(changed.sourceText, ''); assert.ok(!changed.nutrition); assert.equal(changed.nutritionSnapshot.name, 'tuna');
  assert.equal(changed.nutritionSnapshot.nutrition.kcal, 80);
  assert.equal(stock(after, 'beef'), 20); assert.equal(stock(after, 'tuna'), 4);
  rejectsUnchanged(before, { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', itemId: 'tuna', quantity: 1, unit: '袋' }] }] });
  rejectsUnchanged(before, { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', itemId: 'tuna' }] }] });
});

test('untracked quantity-only patches retain nutrition, but replacing identity clears old food nutrition and raw quote', () => {
  const before = ready();
  const reduced = patch(before, { mealPatches: amount('breakfast', 'oats-line', 40) });
  assert.deepEqual(line(reduced, 'breakfast', 'oats-line').nutritionSnapshot, line(before, 'breakfast', 'oats-line').nutritionSnapshot);
  assert.deepEqual(reduced.items, before.items);
  const changed = patch(reduced, { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'oats-line', name: '另一种未盘点常备食品' }] }] });
  const food = line(changed, 'breakfast', 'oats-line');
  assert.equal(food.quantity, 40); assert.equal(food.unit, 'g'); assert.equal(food.sourceText, '');
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) assert.equal(food.nutritionSnapshot.nutrition[key], null);
  assert.deepEqual(changed.items, before.items);
});

test('explicit line removal/addition changes only that meal and keeps the other line and all daily supplements', () => {
  const before = ready();
  const after = patch(before, { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', remove: true }, { id: 'new-tuna-line', itemId: 'tuna', quantity: 1 }] }] });
  assert.deepEqual(meal(after, 'breakfast').plannedItems.map(item => item.id), ['oats-line', 'new-tuna-line']);
  assert.equal(stock(after, 'beef'), 20); assert.equal(stock(after, 'tuna'), 4);
  assert.deepEqual(line(after, 'breakfast', 'oats-line'), line(before, 'breakfast', 'oats-line'));
  assert.deepEqual(plan(after).supplementDoses, plan(before).supplementDoses);
});

test('meal removal refuses planned or actual references; explicit planned unlink is allowed in the same atomic patch', () => {
  const before = ready();
  rejectsUnchanged(before, { mealPatches: [{ id: 'breakfast', remove: true }] }, 'MEAL_REFERENCE_CONFLICT', 409);
  const after = patch(before, { mealPatches: [{ id: 'breakfast', remove: true }], supplementPatches: [{ id: 'oil', plannedMealId: null }] });
  assert.equal(plan(after).meals.length, 2); assert.equal(stock(after, 'beef'), 20); assert.equal(stock(after, 'fish'), 20);
  const withActual = apply(before, 'record_supplement_intake', { planId: 'day', doseId: 'oil', mode: 'complete', matchesPlannedDose: true, actualMealId: 'breakfast' });
  rejectsUnchanged(withActual, { mealPatches: [{ id: 'breakfast', remove: true }], supplementPatches: [{ id: 'oil', plannedMealId: null }] }, 'MEAL_REFERENCE_CONFLICT', 409);
});

test('reported meal plans may change while actual evidence remains immutable and deleting the meal is rejected', () => {
  const before = apply(ready(), 'record_meal_intake', { planId: 'day', mealId: 'lunch', mode: 'complete', matchesPlannedFood: true, actualTime: '12:44', sourceText: '用户午饭按计划吃完' });
  for (const mode of ['draft', 'apply']) {
    const revised = patch(before, { mode, mealPatches: amount('lunch', 'chicken-line', 1) });
    assert.deepEqual(revised.items, before.items);
    assert.deepEqual(meal(revised, 'lunch').actualEntries, meal(before, 'lunch').actualEntries);
    assert.equal(line(revised, 'lunch', 'chicken-line').quantity, 1);
    assert.equal(meal(revised, 'lunch').planRevisionHistory.length, 1);
  }
  rejectsUnchanged(before, { mealPatches: [{ id: 'lunch', remove: true }] }, 'CONSUMED_MEAL_CONFLICT', 409);
  const changed = patch(before, { mealPatches: [{ id: 'lunch', title: '只改标题', plannedTime: '13:00' }] });
  assert.equal(meal(changed, 'lunch').plannedTimeText, '午饭时间');
  for (const key of ['actualEntries', 'actualTime', 'actualTimeText', 'reportHistory', 'sourceText', 'completionReportedAt']) assert.deepEqual(meal(changed, 'lunch')[key], meal(before, 'lunch')[key]);
  assert.deepEqual(changed.items, before.items);
});

test('supplement patches merge optional metadata, adjust only selected reservations, and preserve all food and prior actuals', () => {
  let state = apply(ready(), 'set_supplement_check', { planId: 'day', doseId: 'oil', checked: true });
  const before = copy(state);
  state = patch(state, { supplementPatches: [{ id: 'beta-pre', scheduled: true }] });
  assert.equal(stock(state, 'beta'), 100);
  assert.equal(plan(state).supplementDoses[1].requirement, 'optional');
  assert.equal(plan(state).supplementDoses[1].instruction, '用户当天决定');
  assert.deepEqual(plan(state).meals, plan(before).meals);
  assert.deepEqual(plan(state).supplementDoses[0], plan(before).supplementDoses[0]);
  rejectsUnchanged(state, { supplementPatches: [{ id: 'oil', plannedQuantity: 2 }] }, 'CONSUMED_MEAL_CONFLICT', 409);
  rejectsUnchanged(state, { supplementPatches: [{ id: 'oil', remove: true }] }, 'CONSUMED_MEAL_CONFLICT', 409);
  const metadata = patch(state, { supplementPatches: [{ id: 'oil', instruction: '只修改下次查看说明' }] });
  assert.deepEqual(metadata.items, state.items);
  assert.deepEqual(plan(metadata).supplementDoses[0].actualEntries, plan(state).supplementDoses[0].actualEntries);
});

test('new nullable supplement doses preserve unknowns and dose replacements adopt their new physical unit', () => {
  const before = ready();
  const after = patch(before, { supplementPatches: [{ id: 'night-mag', itemId: 'magnesium', plannedQuantity: null, requirement: 'optional', instruction: '片数待确认' }, { id: 'beta-pre', itemId: 'fish', plannedQuantity: 1, scheduled: true }] });
  const unknown = plan(after).supplementDoses.find(item => item.id === 'night-mag');
  assert.equal(unknown.plannedQuantity, null); assert.equal(unknown.unit, '片'); assert.equal(unknown.scheduled, false);
  assert.equal(stock(after, 'magnesium'), null);
  assert.equal(plan(after).supplementDoses.find(item => item.id === 'beta-pre').unit, '粒');
  assert.equal(plan(after).supplementDoses.find(item => item.id === 'beta-pre').sourceText, '');
  assert.equal(stock(after, 'fish'), 20);
  assert.deepEqual(plan(after).meals, plan(before).meals);
});

test('same-day allocation patches keep total inventory unchanged and retain completed actual evidence', () => {
  const before = apply(ready(), 'record_meal_intake', { planId: 'day', mealId: 'breakfast', mode: 'complete', matchesPlannedFood: true, sourceText: '早餐按计划' });
  const fields = { allocationOnly: true, mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', quantity: 1 }] }, { id: 'lunch', itemPatches: [{ id: 'beef-moved', itemId: 'beef', quantity: 1 }] }] };
  const after = patch(before, fields);
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(meal(after, 'breakfast').actualEntries, meal(before, 'breakfast').actualEntries);
  rejectsUnchanged(before, { ...fields, mode: 'draft' });
  rejectsUnchanged(before, { allocationOnly: true, mealPatches: amount('breakfast', 'beef-line', 1) }, 'DAILY_TOTAL_CONFLICT', 409);
  rejectsUnchanged(before, { ...fields, supplementPatches: [{ id: 'oil', instruction: '无库存变动也分开修改' }] }, 'DAILY_TOTAL_CONFLICT', 409);
});

test('planned quantities do not spend or refund stock even when a menu exceeds current stock or follows a recount', () => {
  const before=ready(),edited=patch(before,{mealPatches:[...amount('breakfast','beef-line',1),...amount('lunch','chicken-line',999)]});
  assert.deepEqual(edited.items,before.items);assert.equal(line(edited,'lunch','chicken-line').quantity,999);
  const recounted={...before,items:before.items.map(item=>item.id==='beef'?{...item,quantityBaselineToken:'recount',quantity:7}:item)},after=patch(recounted,{mealPatches:amount('breakfast','beef-line',1)});
  assert.deepEqual(after.items,recounted.items);assert.equal(stock(after,'beef'),7);
});

test('a planned unit edit after recount does not reinterpret or spend the new counted balance', () => {
  const before=ready(),recounted={...before,items:before.items.map(item=>item.id==='beef'?{...item,unit:'g',quantity:500,quantityBaselineToken:'unit-recount'}:item)};
  const after=patch(recounted,{mealPatches:[{id:'breakfast',itemPatches:[{id:'beef-line',unit:'g',quantity:2}]}]});
  assert.deepEqual(after.items,recounted.items);assert.deepEqual(plan(after).accountedDebits,[]);assert.equal(line(after,'breakfast','beef-line').unit,'g');
});

test('idempotent retries, no-op values, changed-operation conflicts and stale revisions all preserve one delta', () => {
  const before = ready(); const fields = { mealPatches: amount('breakfast', 'beef-line', 1) };
  const after = patch(before, fields, 'patch-stable');
  const command = { action: 'patch_meal_plan', planId: 'day', mode: 'apply', confirmed: true, ...fields, operationId: 'patch-stable', expectedRevision: before.revision };
  assert.equal(applyMutation(after, command, LATER), after);
  assert.equal(patch(after, fields, 'same-value-new-operation'), after);
  assert.throws(() => applyMutation(after, { ...command, expectedRevision: after.revision, mealPatches: amount('breakfast', 'beef-line', 2) }, LATER), { code: 'OPERATION_ID_CONFLICT', status: 409 });
  assert.throws(() => applyMutation(after, { ...command, operationId: 'another-client' }, LATER), { code: 'REVISION_CONFLICT', status: 409 });
  assert.equal(stock(after, 'beef'), 20);
});

test('unknown and actual/snapshot fields are rejected at every patch level instead of silently replacing evidence', () => {
  const before = ready();
  const invalid = [
    { mode: 'unknown' }, { confirmed: 'true' }, { allocationOnly: 'true' }, { date: '2026-10-20' }, { timeZone: 'UTC' }, { actualEntries: [] }, { nutritionSnapshot: {} },
    { mealPatches: null }, { supplementPatches: null }, { mealPatches: [{ id: 'breakfast', plannedItems: [] }] },
    { mealPatches: [{ id: 'breakfast', actualTime: '12:00' }] }, { mealPatches: [{ id: 'breakfast', itemPatches: null }] },
    { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', nutritionSnapshot: {} }] }] },
    { supplementPatches: [{ id: 'oil', actualEntries: [] }] }, { supplementPatches: [{ id: 'oil', nutritionSnapshot: {} }] },
    { mealPatches: [{ id: 'breakfast', remove: true, title: '混合删除与修改' }] }, { mealPatches: [{ id: 'breakfast', remove: 'true' }] },
    { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', quantity: 0 }] }] },
    { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', nutrition: { ...macros(), actualTime: '12:00' } }] }] },
    { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', nutrition: { ...macros(), nutrientSources: { fake: 'label' } } }] }] },
  ];
  for (const fields of invalid) rejectsUnchanged(before, fields, undefined, 400);
});

test('duplicate IDs, absent removals, new-object required fields and collection limits are validated atomically', () => {
  const before = ready();
  for (const fields of [
    { mealPatches: [{ id: 'breakfast' }, { id: ' breakfast ' }] },
    { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'beef-line', quantity: 1 }, { id: 'beef-line', quantity: 3 }] }] },
    { mealPatches: [{ id: 'new-meal', title: '缺slot' }] },
    { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'new-food', quantity: 1 }] }] },
    { supplementPatches: [{ id: 'new-dose', itemId: 'fish' }] },
    { mealPatches: Array.from({ length: 17 }, (_, i) => ({ id: `m${i}`, title: '餐', slot: 'other' })) },
    { mealPatches: [{ id: 'breakfast', itemPatches: Array.from({ length: 101 }, (_, i) => ({ id: `l${i}`, itemId: 'beef', quantity: 1 })) }] },
    { supplementPatches: Array.from({ length: 33 }, (_, i) => ({ id: `d${i}`, itemId: 'fish', plannedQuantity: 1 })) },
  ]) rejectsUnchanged(before, fields);
  rejectsUnchanged(before, { mealPatches: [{ id: 'missing', remove: true }] }, 'MEAL_NOT_FOUND', 404);
  rejectsUnchanged(before, { mealPatches: [{ id: 'breakfast', itemPatches: [{ id: 'missing', remove: true }] }] }, 'LINE_NOT_FOUND', 404);
  rejectsUnchanged(before, { supplementPatches: [{ id: 'missing', remove: true }] }, 'DOSE_NOT_FOUND', 404);
});

test('adding a stable new snack and a line retains existing meals and does not replace an existing slot peer', () => {
  const before = ready();
  const after = patch(before, { mealPatches: [{ id: 'snack-extra', slot: 'snack', title: '只增加加餐', itemPatches: [{ id: 'snack-tuna', itemId: 'tuna', quantity: 1 }] }] });
  assert.equal(plan(after).meals.length, 4);
  for (const m of plan(before).meals) assert.deepEqual(meal(after, m.id), m);
  assert.equal(stock(after, 'tuna'), 4);
  const context = dietContext(after, '2026-10-19');
  assert.equal(context.records[0].meals.find(m => m.id === 'snack-extra').plannedItems[0].id, 'snack-tuna');
});

test('open drafts and menus with pending actuals remain editable without resolving stock through a plan edit', () => {
  const adopted=patch(drafted(),{notes:'草稿直接可编辑'});assert.equal(plan(adopted).notes,'草稿直接可编辑');assert.equal(stock(adopted,'beef'),20);
  rejectsUnchanged(ready(),{confirmed:false,notes:'未授权apply'},'PLAN_CONFIRMATION_REQUIRED',400);
  const pending=apply(ready(),'record_meal_intake',{planId:'day',mealId:'lunch',mode:'complete',entries:[{id:'unknown',itemId:'chicken',quantity:null,unit:'袋',sourceText:'吃了但量未知'}]});
  assert.equal(plan(pending).inventoryAccounting,'pending_reconciliation');
  const after=patch(pending,{mealPatches:amount('dinner','veg-line',200)});assert.deepEqual(after.items,pending.items);assert.equal(plan(after).inventoryAccounting,'pending_reconciliation');
  assert.deepEqual(meal(after,'lunch').actualEntries,meal(pending,'lunch').actualEntries);
  const closed=apply(ready(),'cancel_meal_plan',{planId:'day',confirmed:true});rejectsUnchanged(closed,{mode:'draft',notes:'不能复活'},'PLAN_CLOSED',409);
});

test('full save retains unchanged frozen snapshots and ignores caller-supplied snapshot spoofing without a confirmation gate', () => {
  let state=ready();const old=copy(plan(state));state={...state,items:state.items.map(item=>({...item,nutrition:{...item.nutrition,kcal:999}}))};
  const raw=copy(old);raw.meals[2].plannedItems[0].quantity=200;raw.meals[0].plannedItems[0].nutritionSnapshot.nutrition.kcal=99999;
  const before=copy(state.items);state=apply(state,'save_meal_plan_draft',{plan:raw});assert.ok(!plan(state).draft);
  assert.equal(line(state,'breakfast','beef-line').nutritionSnapshot.nutrition.kcal,100);assert.deepEqual(meal(state,'breakfast'),old.meals[0]);assert.deepEqual(plan(state).supplementDoses,old.supplementDoses);assert.deepEqual(state.items,before);
});

test('materialized views are pure and detached, validate view/record IDs, and resolve passed objects through stored authority', () => {
  const state = patch(ready(), { mode: 'draft', notes: '待确认备注' }); const before = copy(state);
  const fake = { id: 'day', title: '伪造调用者对象', meals: [] };
  const result = materializeDietPlanForEdit(state, fake);
  assert.equal(result.notes, '待确认备注'); assert.equal(result.title, '完整全天菜单');
  result.meals[0].plannedItems[0].nutritionSnapshot.nutrition.kcal = 8888;
  assert.deepEqual(state, before);
  assert.throws(() => materializeDietPlanForEdit(state, 'missing'), { code: 'PLAN_NOT_FOUND', status: 404 });
  assert.throws(() => materializeDietPlanForEdit(state, 'day', 'unknown'));
});

test('a supplement-only canonical owner can receive a menu directly without losing the existing actual dose', () => {
  const raw=input();raw.meals=[];raw.supplementDoses=[raw.supplementDoses[0]];raw.supplementDoses[0].plannedMealId=null;
  let state=ready(raw);plan(state).supplementOnly=true;plan(state).supplementAccounting='actual_only';state=apply(state,'set_daily_supplement_check',{date:raw.date,doseId:'oil',checked:true});const dose=copy(plan(state).supplementDoses[0]),before=copy(state.items);
  state=patch(state,{mealPatches:[{id:'new-lunch',slot:'lunch',title:'新增午餐',itemPatches:[{id:'new-beef',itemId:'beef',quantity:1}]}]});
  assert.equal(plan(state).supplementOnly,false);assert.equal(plan(state).supplementAccounting,'actual_only');assert.equal(plan(state).meals.length,1);assert.deepEqual(plan(state).supplementDoses[0],dose);assert.deepEqual(state.items,before);
});

test('explicit draft removal of an unreported supplement-only dose survives materialization and commit without being auto-inherited again', () => {
  const raw = input(); raw.meals = []; raw.supplementDoses[0].plannedMealId = null;
  let state = ready(raw); plan(state).supplementOnly = true; plan(state).supplementAccounting = 'actual_only';
  state = patch(state, { mode: 'draft', supplementPatches: [{ id: 'beta-pre', remove: true }] });
  assert.equal(materializeDietPlanForEdit(state, 'day').supplementDoses.length, 1);
  state = apply(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  assert.deepEqual(plan(state).supplementDoses.map(d => d.id), ['oil']);
});
