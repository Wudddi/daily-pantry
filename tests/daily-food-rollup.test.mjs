import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyFoodRollup, dailyFoodRollupPage } from '../lib/daily-food-rollup.mjs';
import { planNutritionTotals } from '../lib/diet-nutrition.mjs';
import { readDailyFoodSummary, readDietRecords } from '../lib/diet.mjs';
import { readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';
import { applyMutation, validateItem } from '../lib/inventory.mjs';

const AT = '2026-10-26T12:00:00.000Z';
const numbers = { kcal: 100, protein: 10, carbs: 12, fat: 2 };
const snapshot = (name, patch = {}) => ({ name, unit: 'g', gramsPerUnit: null, ingredients: '', supplementFacts: '',
  nutrition: { basisAmount: 100, basisUnit: 'g', ...numbers, source: 'label' }, ...patch });
const food = (id, itemId, quantity, patch = {}) => ({ id, itemId, name: itemId ?? '常备食物', quantity, unit: 'g',
  nutritionSnapshot: snapshot(itemId ?? '常备食物'), ...patch });
const meal = (id, plannedItems, patch = {}) => ({ id, slot: id, title: id, state: 'reserved', plannedItems,
  actualEntries: [], ...patch });
const plan = (meals, patch = {}) => ({ id: 'daily-20261026', date: '2026-10-26', format: 'meals_v1', title: '全天菜单',
  status: 'draft', meals, supplementDoses: [], ...patch });
const totals = summary => Object.fromEntries(summary.totals.map(total => [total.key, total.value]));
const qty = (summary, itemId) => summary.rows.find(row => row.itemId === itemId)?.quantity;
const stateOf = p => ({ schemaVersion: 1, revision: 7, updatedAt: AT, items: [], events: [], preferences: [], plans: [p], dietHistory: [] });

test('same food across lunch and dinner becomes one day row with original meal allocations and exact macros', () => {
  const p = plan([meal('lunch', [food('l-m', 'mushroom', 200), food('l-rice', 'rice', 60)]),
    meal('dinner', [food('d-m', 'mushroom', 200), food('d-rice', 'rice', 40)])]);
  const before = structuredClone(p), summary = dailyFoodRollup(p);
  assert.equal(summary.rows.length, 2);
  assert.equal(qty(summary, 'mushroom'), 400);
  assert.equal(qty(summary, 'rice'), 100);
  assert.deepEqual(summary.rows[0].allocations.map(row => [row.mealId, row.quantity, row.unit]), [['lunch', 200, 'g'], ['dinner', 200, 'g']]);
  assert.deepEqual(totals(summary), { kcal: 500, protein: 50, carbs: 60, fat: 10 });
  assert.deepEqual(summary.totals, planNutritionTotals(p));
  assert.deepEqual(p, before);
});

test('reliably frozen bag weights combine with grams, while mL never guesses density or combines with grams', () => {
  const meat = snapshot('牛肉', { unit: '袋', gramsPerUnit: 132 });
  const p = plan([meal('lunch', [food('l', 'beef-batch', 0.5, { unit: '袋', nutritionSnapshot: meat }),
    food('water-volume', 'sauce', 10, { unit: 'ml', nutritionSnapshot: snapshot('酱', { unit: 'ml' }) })]),
  meal('dinner', [food('d', 'beef-batch', 66, { nutritionSnapshot: meat }), food('water-mass', 'sauce', 10)])]);
  const summary = dailyFoodRollup(p);
  assert.equal(qty(summary, 'beef-batch'), 132);
  assert.equal(summary.rows.find(row => row.itemId === 'beef-batch').unit, 'g');
  assert.deepEqual(summary.rows.filter(row => row.itemId === 'sauce').map(row => row.unit), ['mL', 'g']);
  assert.equal(summary.rows.find(row => row.unit === 'mL').partial, true);
});

test('unknown package conversions remain separate and unknown amounts/nutrients remain unknown, never zero', () => {
  const unknown = snapshot('酥点', { unit: '袋', gramsPerUnit: null, nutrition: { basisAmount: 100, basisUnit: 'g', kcal: null, protein: null, carbs: null, fat: null } });
  const summary = dailyFoodRollup(plan([meal('lunch', [food('a', 'pastry', 1, { unit: '袋', nutritionSnapshot: unknown })]),
    meal('dinner', [food('b', 'pastry', 80), food('c', 'unknown-actual', null)])]));
  assert.deepEqual(summary.rows.filter(row => row.itemId === 'pastry').map(row => row.unit), ['袋', 'g']);
  assert.ok(summary.rows[0].totals.every(total => total.value === null && total.partial));
  assert.equal(qty(summary, 'unknown-actual'), null);
  assert.equal(summary.partial, true);
});

test('different batches stay separate even with identical names and same-ID snapshot differences sum each saved contribution', () => {
  const first = snapshot('卤牛肉');
  const changed = snapshot('卤牛肉', { nutrition: { ...first.nutrition, kcal: 120 } });
  const summary = dailyFoodRollup(plan([meal('lunch', [food('a', 'batch-1', 100, { name: '卤牛肉', nutritionSnapshot: first })]),
    meal('dinner', [food('b', 'batch-1', 100, { name: '卤牛肉', nutritionSnapshot: changed }), food('c', 'batch-2', 50, { name: '卤牛肉' })])]));
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[0].nutritionBasisVaries, true);
  assert.equal(summary.rows[0].totals.find(total => total.key === 'kcal').value, 220);
  assert.equal(summary.rows[1].quantity, 50);
});

test('untracked identical foods can merge, but differing untracked bases and absent identities do not fabricate a product match', () => {
  const summary = dailyFoodRollup(plan([meal('lunch', [food('a', null, 40), food('b', null, 20)]),
    meal('dinner', [food('c', null, 10, { nutritionSnapshot: snapshot('常备食物', { nutrition: { ...numbers, basisAmount: 100, basisUnit: 'g', kcal: 200 } }) })])]));
  assert.equal(summary.rows.length, 2);
  assert.deepEqual(summary.rows.map(row => row.quantity), [60, 10]);
});

test('completed meals use actual once; partial reports preserve the effective menu rather than adding actual on top', () => {
  const planned = food('l', 'rice', 100);
  const actual = { ...planned, id: 'a-l', quantity: 50 };
  const p = plan([meal('lunch', [planned], { state: 'completed', actualEntries: [actual] }),
    meal('dinner', [food('d', 'rice', 100)], { state: 'in_progress', actualEntries: [{ ...actual, id: 'a-d', quantity: 30 }] })]);
  const summary = dailyFoodRollup(p);
  assert.equal(qty(summary, 'rice'), 150);
  assert.deepEqual(summary.rows[0].allocations.map(row => [row.quantity, row.origin]), [[50, 'reported'], [100, 'planned']]);
  assert.equal(totals(summary).kcal, 150);
  assert.deepEqual(summary.totals, planNutritionTotals(p));
});

test('supplements contribute to the day total once while food list and food subtotal stay independent', () => {
  const p = plan([meal('lunch', [food('a', 'rice', 100)])], { supplementDoses: [{ id: 'oil', itemId: 'fish-oil',
    plannedQuantity: 1, unit: '粒', state: 'completed', actualEntries: [{ id: 'actual-oil', itemId: 'fish-oil', name: '鱼油',
      quantity: 1, unit: '粒', nutritionSnapshot: snapshot('鱼油', { unit: '粒', nutrition: { basisAmount: 1, basisUnit: '粒', kcal: 10, protein: 0, carbs: 0, fat: 1, source: 'estimate' } }) }] }] });
  const summary = dailyFoodRollup(p);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.foodTotals.find(total => total.key === 'kcal').value, 100);
  assert.equal(summary.supplementTotals.find(total => total.key === 'kcal').value, 10);
  assert.equal(totals(summary).kcal, 110);
});

test('legacy supplementOnly plus saved draft remains a complete menu and preserves actual dose facts without migration', () => {
  const p = plan([], { status: 'reserved', supplementOnly: true, draft: { meals: [meal('lunch', [food('a', 'rice', 100)])], supplementDoses: [] } });
  const before = structuredClone(p);
  assert.equal(dailyFoodRollup(p).rows.length, 1);
  assert.equal(totals(dailyFoodRollup(p)).kcal, 100);
  assert.deepEqual(p, before);
});

test('saving and patching menus updates the readable day summary after reload without changing stock or unrelated rows', () => {
  const rice = validateItem({ id: 'rice', name: 'rice', category: 'staple', unit: 'g', quantity: 1000,
    nutrition: { basisAmount: 100, basisUnit: 'g', ...numbers, source: 'label' } }, AT);
  let state = { ...stateOf(null), plans: [], items: [rice], operationIds: [] };
  const mutate = (action, payload) => applyMutation(state, { action, ...payload, operationId: `op-${state.revision}`, expectedRevision: state.revision }, AT);
  state = mutate('save_meal_plan_draft', { plan: { id: 'day', date: '2026-10-26', title: '分两餐', meals: [
    { id: 'lunch', slot: 'lunch', title: '午餐', plannedItems: [{ id: 'l', itemId: 'rice', quantity: 40 }] },
    { id: 'dinner', slot: 'dinner', title: '晚餐', plannedItems: [{ id: 'd', itemId: 'rice', quantity: 60 }] }] } });
  assert.equal(qty(readDailyFoodSummary(state, { planId: 'day' }), 'rice'), 100);
  const inventory = structuredClone(state.items);
  state = mutate('patch_meal_plan', { planId: 'day', mode: 'draft', mealPatches: [{ id: 'lunch', itemPatches: [{ id: 'l', quantity: 50 }] }] });
  state = JSON.parse(JSON.stringify(state));
  const summary = readDietRecords(state, { date: '2026-10-26', summaryOnly: 'daily_food' }).dailyFoodSummary;
  assert.equal(qty(summary, 'rice'), 110);
  assert.deepEqual(summary.rows[0].allocations.map(row => row.quantity), [50, 60]);
  assert.deepEqual(state.items, inventory);
  const before = structuredClone(state);
  assert.equal(readDietRecords(state, { date: '2026-10-26' }).dailyFoodSummary.rows[0].quantity, 110);
  assert.deepEqual(state, before);
  assert.equal(readDietRecords(state, {}).dailyFoodSummary, undefined);
  assert.equal(readFoodPlanEditContext(state, { planId: 'day', mealIds: ['lunch'] }).dailyFoodSummary, undefined);
});

test('large derived summaries paginate within a bounded response with full totals and revision checks on continuation', () => {
  const p = plan([meal('lunch', Array.from({ length: 80 }, (_, index) => food(`line-${index}`, `food-${index}`, 10)))]);
  const state = stateOf(p), before = structuredClone(state), all = [];
  let cursor = '0';
  do {
    const response = readDietRecords(state, { planId: p.id, summaryOnly: 'daily_food', cursor, limit: 50, expectedRevision: state.revision });
    const summary = response.dailyFoodSummary;
    assert.ok(JSON.stringify(response).length < 24000);
    assert.equal(totals(summary).kcal, 800);
    all.push(...summary.rows); cursor = summary.nextCursor;
  } while (cursor !== null);
  assert.equal(new Set(all.map(row => row.id)).size, 80);
  assert.throws(() => readDietRecords({ ...state, revision: 8 }, { planId: p.id, summaryOnly: 'daily_food', cursor: '1', expectedRevision: 7 }), error => error.code === 'REVISION_CONFLICT');
  assert.deepEqual(state, before);
  assert.throws(() => dailyFoodRollupPage(dailyFoodRollup(p), { cursor: '-1' }));
});

test('a normal 17-food four-meal preparation table fits one transport page without losing quantities, allocations or nutrient flags', () => {
  const names = [
    'Oikos High Protein Greek Yogurt Plain 0% M.F.（650g）',
    'Lavish Doses 原味黄油可颂（Butter Croissant，52g）',
    'ON Gold Standard 100% Whey — Extreme Milk Chocolate',
    'PC Blueberries Cultivated 冷冻蓝莓',
    '常备无糖纯可可粉',
    '示例备餐132g标准袋',
    'Pane Fresco Whole Wheat Pan Bread（Fortinos 现烤）',
    'No Name Large Size Eggs（生鸡蛋，12个装×2）',
    'No Name Mixed Garden Vegetables（豆角＋胡萝卜冷冻杂蔬）',
    '彩椒（当前实报余量）',
    '酱油（10kcal/15mL，红黄标签1.9L）',
    'Président Premium Salted Cultured Butter（有盐发酵黄油）',
    '香蕉 Bananas Bunch（5根，2026-10-21 Superstore）',
    'Lavish Doses 巧克力杏仁可颂（Almond Chocolate Croissant）',
    'Blackbird Baking Co. Seeded Sourdough（多籽酸种面包）',
    'Coombe Castle Cheshire 英国硬质奶酪（200g）',
    'PC Broccoli Florets 冷冻西兰花（500g袋）',
  ];
  const allocations = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9, 10, 11], [0, 12, 13], [5, 7, 8, 9, 10, 14, 15, 16]];
  const slots = ['breakfast', 'lunch', 'snack', 'dinner'];
  const p = plan(allocations.map((indices, mealIndex) => meal(slots[mealIndex], indices.map(index => {
    const name = names[index], saved = snapshot(name);
    if (index === 2) saved.nutrition.source = 'estimate';
    if (index === 4) saved.nutrition.protein = null;
    return food(`${slots[mealIndex]}-food-${index}`, `grocery-20261026-${index}-existing-stable-product-id`, index === 9 && mealIndex === 3 ? null : 50 + index,
      { name, nutritionSnapshot: saved });
  }), { title: `${slots[mealIndex]}｜按照备餐习惯分配的食物和饮品，保存当前菜单并保留实际记录` })));
  const rich = dailyFoodRollup(p), before = structuredClone(rich);
  const page = dailyFoodRollupPage(rich);
  assert.equal(page.rowCount, 17);
  assert.equal(page.rows.length, 17, `full transport characters: ${JSON.stringify(dailyFoodRollupPage(rich, { budget: 100000 })).length}`);
  assert.equal(page.hasMore, false);
  assert.equal(page.truncated, false);
  assert.equal(page.nextCursor, null);
  assert.ok(JSON.stringify(page).length <= 18000, JSON.stringify(page).length);
  const ordinaryDateRead = readDietRecords(stateOf(p), { date: p.date }).dailyFoodSummary;
  assert.equal(ordinaryDateRead.rows.length, 17, 'ordinary date reads also return every row without summaryOnly');
  assert.equal(ordinaryDateRead.hasMore, false);
  assert.ok(JSON.stringify(ordinaryDateRead).length <= 18000, JSON.stringify(ordinaryDateRead).length);
  assert.deepEqual(page.totals, rich.totals);
  assert.deepEqual(page.foodTotals, rich.foodTotals);
  assert.deepEqual(page.supplementTotals, rich.supplementTotals);
  for (const [index, row] of page.rows.entries()) {
    const original = rich.rows[index];
    const { totals: originalTotals, allocations: originalAllocations, displayQuantity, displayUnit, knownQuantity, ...originalFields } = original;
    const { totals: transportTotals, allocations: transportAllocations, ...transportFields } = row;
    assert.equal(displayQuantity, original.quantity);
    assert.equal(displayUnit, original.unit);
    assert.deepEqual(transportFields, { ...originalFields, ...(original.quantity === null ? { knownQuantity } : {}) });
    assert.deepEqual(transportAllocations, originalAllocations.map(({ mealTitle, knownQuantity, ...allocation }) => ({
      ...allocation, ...(allocation.quantity === null ? { knownQuantity } : {}),
    })));
    assert.deepEqual(transportTotals, originalTotals.map(total => ({ key: total.key, value: total.value,
      estimated: total.estimated, partial: total.partial, supplementPartial: total.supplementPartial,
      ...(total.missing > 0 ? { missing: total.missing } : {}),
      ...(total.supplementMissing > 0 ? { supplementMissing: total.supplementMissing } : {}),
    })));
    assert.ok(originalTotals.every(total => Object.hasOwn(total, 'knownCount')));
  }
  assert.deepEqual(rich, before, 'transport compression must not mutate the richer UI model');
  assert.equal(page.rows.find(row => row.name === names[9]).knownQuantity, 59, 'unknown total retains the known lunch subtotal');
});

test('targeted source fragments remain lossless and multi-day briefs do not repeat the preparation table', () => {
  const p = plan([meal('lunch', [food('a', 'rice', 100)])]);
  p.notes = 'very long original'.repeat(6000);
  const state = stateOf(p), chunks = [];
  let offset = 0;
  do {
    const response = readDietRecords(state, { recordId: p.id, offset });
    assert.ok(JSON.stringify(response).length <= 63000);
    assert.equal(response.dailyFoodSummary.rows[0].quantity, 100);
    chunks.push(response.text); offset = response.nextOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(chunks.join('')), p);
  assert.equal(readDietRecords(state, { from: '2026-10-25', to: '2026-10-27' }).dailyFoodSummary, undefined);
});
