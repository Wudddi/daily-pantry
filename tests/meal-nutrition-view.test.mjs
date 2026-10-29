import test from 'node:test';
import assert from 'node:assert/strict';
import { mealNutritionView } from '../lib/meal-nutrition-view.mjs';
import { planNutritionTotals } from '../lib/diet-nutrition.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';

const nutrition = (overrides = {}) => ({ basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 20, carbs: 10, fat: 5, source: 'label', sourceNote: '', sourceText: '', ...overrides });
const snapshot = (name = '食物', overrides = {}) => ({ name, unit: 'g', gramsPerUnit: null, ingredients: '', supplementFacts: '', nutrition: nutrition(), ...overrides });
const line = (id, quantity, overrides = {}) => ({ id, itemId: id, name: '食物 ' + id, quantity, unit: 'g', nutritionSnapshot: snapshot('食物 ' + id), sourceText: '', ...overrides });
const meal = (overrides = {}) => ({ id: 'dinner', slot: 'dinner', title: '晚餐', state: 'reserved', plannedItems: [line('rice', 150)], actualEntries: [], reportHistory: [], ...overrides });
const values = totals => Object.fromEntries(totals.map(total => [total.key, total.value]));
const sumRows = rows => Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, Math.round(rows.reduce((sum, row) => sum + row.totals.find(total => total.key === key).value, 0) * 1e6) / 1e6]));

test('an unreported final menu shows full per-food portions, sources and per-meal totals using the existing daily aggregation', () => {
  const input = meal({ plannedItems: [line('rice', 150), line('beef', 0.5, { unit: '袋', nutritionSnapshot: snapshot('卤牛肉', { unit: '袋', gramsPerUnit: 125, nutrition: nutrition({ basisAmount: 1, basisUnit: '袋', kcal: 250, protein: 44, carbs: 0, fat: 8, source: 'recipe' }) }) })] });
  const view = mealNutritionView(input);
  assert.equal(view.mode, 'planned');
  assert.equal(view.basisLabel, '本餐计划');
  assert.deepEqual(values(view.totals), { kcal: 425, protein: 52, carbs: 15, fat: 11.5 });
  assert.deepEqual(sumRows(view.rows), values(view.totals));
  assert.deepEqual(view.totals, planNutritionTotals({ meals: [input], supplementDoses: [] }));
  assert.equal(view.rows[1].nutrientSources.protein, 'recipe');
  assert.equal(view.actualRows.length, 0);
  assert.equal(view.partial, false);
});

test('saved bag weights and explicit actual86g conversions work per row without reading a new inventory label', () => {
  const beef = line('beef', 62.5, { nutritionSnapshot: snapshot('牛肉', { unit: '袋', gramsPerUnit: 125, nutrition: nutrition({ basisAmount: 1, basisUnit: '袋', kcal: 250, protein: 44, carbs: 0, fat: 8 }) }) });
  const bagel = line('bagel', 1, { unit: '个', nutritionSnapshot: snapshot('贝果', { unit: '个', gramsPerUnit: 86, nutrition: nutrition({ kcal: 290, protein: 9, carbs: 50, fat: 6 }) }) });
  const view = mealNutritionView(meal({ state: 'completed', actualEntries: [beef, bagel] }));
  assert.equal(view.rows[0].totals[0].value, 125);
  assert.equal(view.rows[1].totals[0].value, 249.4);
  assert.equal(view.rows[1].totals[1].value, 7.74);
  assert.equal(view.basisLabel, '本餐实际');
  assert.deepEqual(sumRows(view.rows), values(view.totals));
});

test('a saved draft is the editable current menu and needs no confirmation to show complete nutrition', () => {
  const input = meal(), before = structuredClone(input);
  const confirmed = mealNutritionView(input);
  const draft = mealNutritionView(input, { planStatus: 'draft' });
  assert.equal(draft.basisLabel, '本餐当前菜单');
  assert.match(draft.note, /已保存的当前菜单/);
  assert.match(draft.note, /实际吃完并报告后才结算/);
  assert.deepEqual(draft.totals, confirmed.totals);
  assert.deepEqual(draft.rows, confirmed.rows);
  assert.deepEqual(input, before);
});

test('unknown macros remain null, known subtotals stay partial and independent nutrient estimates retain their own sources', () => {
  const mixed = nutrition({ kcal: 200, protein: null, carbs: 10, fat: null, source: 'estimate', nutrientSources: { kcal: 'label', protein: 'unknown', carbs: 'estimate', fat: 'unknown' }, sourceNote: '标签热量；碳水同类估算', sourceText: '完整来源\n每100g' });
  const view = mealNutritionView(meal({ plannedItems: [line('known', 100), line('mixed', 100, { nutritionSnapshot: snapshot('混合来源', { nutrition: mixed }) })] }));
  const row = view.rows[1];
  assert.equal(row.totals.find(total => total.key === 'protein').value, null);
  assert.equal(row.totals.find(total => total.key === 'protein').partial, true);
  assert.equal(view.totals.find(total => total.key === 'protein').value, 20);
  assert.equal(view.totals.find(total => total.key === 'protein').completeValue, null);
  assert.equal(row.totals.find(total => total.key === 'kcal').estimated, false);
  assert.equal(row.totals.find(total => total.key === 'carbs').estimated, true);
  assert.equal(row.nutrientSources.protein, 'unknown');
  assert.equal(row.sourceText, '完整来源\n每100g');
  assert.equal(row.sourceNote, '标签热量；碳水同类估算');
  assert.equal(view.estimated, true);
});

test('incompatible ml-to-g conversion and unknown quantities cannot become a guessed serving or zero', () => {
  const view = mealNutritionView(meal({ state: 'completed', actualEntries: [line('oil', 10, { unit: 'ml', nutritionSnapshot: snapshot('油', { gramsPerUnit: 1 }) }), line('unknown', null)] }));
  assert.equal(view.rows[0].conversionMissing, true);
  assert.equal(view.rows[0].totals[0].value, null);
  assert.equal(view.rows[1].quantityUnknown, true);
  assert.equal(view.rows[1].conversionMissing, false);
  assert.equal(view.totals[0].value, null);
  assert.equal(view.partial, true);
});

test('completed actuals replace planned food, explicit zero remains known zero even without a snapshot and does not revive pasta', () => {
  const input = meal({ state: 'completed', plannedItems: [line('pasta', 110)], actualEntries: [line('pasta', 0, { nutritionSnapshot: null }), line('bagel', 86)] });
  const view = mealNutritionView(input);
  assert.equal(view.mode, 'actual');
  assert.equal(view.rows[0].zero, true);
  assert.deepEqual(values(view.rows[0].totals), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  assert.equal(view.rows[0].partial, false);
  assert.equal(view.rows[0].estimated, false);
  assert.equal(view.rows[0].conversionMissing, false);
  assert.equal(view.totals[0].value, 172);
  assert.equal(view.plannedRows[0].totals[0].value, 220);
  assert.equal(view.remainingRows.length, 0);
  assert.deepEqual(sumRows(view.rows), values(view.totals));
});

test('a completed flag with no content keeps the existing planned contribution and explicitly avoids calling it an actual total', () => {
  const view = mealNutritionView(meal({ state: 'completed' }));
  assert.equal(view.totals[0].value, 300);
  assert.equal(view.mode, 'actual');
  assert.equal(view.actualRows.length, 0);
  assert.equal(view.rows[0].origin, 'planned');
  assert.equal(view.basisLabel, '本餐计划 · 实际内容未报');
  assert.ok(view.issues.some(issue => issue.code === 'COMPLETED_CONTENT_UNREPORTED'));
});

test('partial reports retain max planned versus actual, show separate remaining portions and never add both sections as a new formula', () => {
  const input = meal({ state: 'in_progress', plannedItems: [line('rice', 110), line('veg', 150)], actualEntries: [line('rice', 30)] });
  const view = mealNutritionView(input);
  assert.equal(view.mode, 'partial');
  assert.equal(view.basisLabel, '已报告＋保留计划');
  assert.equal(view.actualRows[0].quantity, 30);
  assert.equal(view.remainingRows[0].quantity, 80);
  assert.equal(view.remainingRows[1].quantity, 150);
  assert.equal(view.remainingRows[0].origin, 'remaining');
  assert.equal(view.rows[0].quantity, 110);
  assert.equal(view.totals[0].value, 520);
  assert.deepEqual(view.totals, planNutritionTotals({ meals: [input], supplementDoses: [] }));
  assert.ok(view.issues.some(issue => issue.code === 'PARTIAL_MENU_BASIS'));
  const extra = mealNutritionView({ ...input, actualEntries: [line('rice', 130), line('rice', 10, { id: 'extra-rice', itemId: 'rice' })] });
  assert.equal(extra.rows[0].quantity, 140);
  assert.equal(extra.totals[0].value, 580);
});

test('partial actual versus plan snapshot differences are disclosed while totals retain the exact current day algorithm', () => {
  const input = meal({ state: 'in_progress', plannedItems: [line('rice', 110)], actualEntries: [line('rice', 30, { nutritionSnapshot: snapshot('实际高热量', { nutrition: nutrition({ kcal: 400 }) }) })] });
  const view = mealNutritionView(input);
  assert.equal(view.totals[0].value, 220);
  assert.equal(view.actualRows[0].totals[0].value, 120);
  assert.equal(view.remainingRows[0].totals[0].value, 160);
  assert.ok(view.issues.some(issue => issue.code === 'PARTIAL_NUTRITION_BASIS_DIFFERENCE'));
  assert.notEqual(view.actualRows[0].totals[0].value + view.remainingRows[0].totals[0].value, view.totals[0].value);
  assert.deepEqual(view.totals, planNutritionTotals({ meals: [input], supplementDoses: [] }));
});

test('partial explicit wrong units retain unresolved food and unknown reported amounts keep the original plan, with clear issues', () => {
  const wrongUnit = mealNutritionView(meal({ state: 'in_progress', actualEntries: [line('rice', 1, { unit: '袋' })] }));
  assert.equal(wrongUnit.rows[0].quantity, null);
  assert.equal(wrongUnit.totals[0].value, null);
  assert.ok(wrongUnit.issues.some(issue => issue.code === 'PARTIAL_UNIT_CONFLICT'));
  assert.match(wrongUnit.remainingRows[0].remainingNote, /余量待核对/);
  const unknown = mealNutritionView(meal({ state: 'in_progress', actualEntries: [line('rice', null)] }));
  assert.equal(unknown.actualRows[0].totals[0].value, null);
  assert.equal(unknown.totals[0].value, 300);
  assert.ok(unknown.issues.some(issue => issue.code === 'PARTIAL_QUANTITY_UNKNOWN'));
});

test('meal and whole-plan cancellation retain only actual facts, including none, without resurrecting the unreported plan', () => {
  const input = meal({ state: 'cancelled', actualEntries: [line('rice', 20)] });
  const view = mealNutritionView(input);
  assert.equal(view.totals[0].value, 40);
  assert.equal(view.actualRows.length, 1);
  const cancelledPlan = mealNutritionView(meal(), { planStatus: 'cancelled' });
  assert.equal(cancelledPlan.mode, 'actual');
  assert.equal(cancelledPlan.rows.length, 0);
  assert.equal(cancelledPlan.totals[0].value, 0);
  assert.equal(cancelledPlan.partial, false);
  assert.equal(cancelledPlan.basisLabel, '已取消 · 无实际记录');
});

test('same-identity untracked food and explicit existing fallback use saved plan evidence without merging different unnamed foods', () => {
  const input = meal({ state: 'completed', plannedItems: [line('egg', 1, { itemId: null, name: '鸡蛋', unit: '个', nutritionSnapshot: snapshot('鸡蛋', { unit: '个', nutrition: nutrition({ basisAmount: 1, basisUnit: '个', kcal: 70 }) }) })], actualEntries: [line('egg-actual', 1, { itemId: null, name: '鸡蛋', unit: '个', nutritionSnapshot: null }), line('yogurt-actual', 100, { itemId: null, name: '酸奶', nutritionSnapshot: null })] });
  const view = mealNutritionView(input);
  assert.equal(view.rows[0].totals[0].value, 70);
  assert.equal(view.rows[1].totals[0].value, null);
  assert.equal(view.totals[0].value, 70);
  assert.equal(view.totals[0].partial, true);
});

test('native per-meal sums match the unchanged selected daily item totals and do not allocate history-day or supplement totals into food', () => {
  const first = meal(), second = meal({ id: 'lunch', plannedItems: [line('veg', 100)] });
  const plan = { id: 'plan', date: '2026-10-20', status: 'reserved', format: 'meals_v1', meals: [first, second], supplementDoses: [], updatedAt: '2026-10-20' };
  const day = resolveDietDays([plan], [])[0];
  const views = plan.meals.map(input => mealNutritionView(input));
  assert.equal(views.reduce((sum, view) => sum + view.totals[0].value, 0), day.totals[0].value);
  const withHistory = { ...plan, history: { nutrition: { kcal: 9999 } }, draft: { meals: [meal({ plannedItems: [line('draft', 999)] })] } };
  assert.deepEqual(mealNutritionView(withHistory.meals[0]), views[0]);
});

test('view generation is strictly read-only and returns original nutrition evidence without editing actuals, snapshots, history or ledger', () => {
  const input = meal({ state: 'in_progress', actualEntries: [line('rice', 30, { nutritionCorrectionHistory: [{ at: '2026-10-20', sourceText: '原更正', previous: null }] })] });
  const before = structuredClone(input);
  const freeze = object => { if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); } return object; };
  freeze(input);
  const view = mealNutritionView(input, { planStatus: 'reserved' });
  assert.deepEqual(input, before);
  view.actualRows[0].totals[0].value = 999;
  assert.equal(input.actualEntries[0].nutritionSnapshot.nutrition.kcal, 200);
  assert.equal(input.actualEntries[0].nutritionCorrectionHistory.length, 1);
});
