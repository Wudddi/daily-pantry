import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { mealExecutionView, readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';

const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 120, protein: 8, carbs: 20, fat: 1, source: 'estimate', sourceText: '标签或估算完整来源' };
function line(id, name, quantity, unit = 'g', itemId = id) {
  return { id, itemId, name, quantity, unit, sourceText: '原计划 ' + name, nutritionSnapshot: { name, unit, nutrition, gramsPerUnit: null, ingredients: '', supplementFacts: '' } };
}
function actual(id, name, quantity, unit = 'g', itemId = id) {
  return { ...line(id, name, quantity, unit, itemId), reportedAt: '2026-10-20T20:00:00Z', quantitySource: quantity === null ? 'unknown' : 'reported', correctionHistory: [], sourceText: '完整实际原话 ' + name };
}
function meal(patch = {}) {
  return { id: 'dinner', slot: 'dinner', title: '晚餐', state: 'reserved', plannedTime: null, plannedTimeText: '', actualTime: null, actualTimeText: '', completionReportedAt: null, sourceText: '', reportHistory: [], plannedItems: [line('pasta', '意面', 110)], actualEntries: [], ...patch };
}
function state(target) {
  return { schemaVersion: 1, revision: 7, items: [], preferences: ['改餐仍遵守完整当前习惯'], plans: [{ id: 'day', format: 'meals_v1', status: 'reserved', date: '2026-10-20', title: '最终菜单', intakeBasis: 'confirmed_daily_plan', inventoryAccounting: 'settled', accountingIssues: [], accountedDebits: [], supplementDoses: [], meals: [target] }], dietHistory: [] };
}

const source = await readFile(new URL('../app/diet-records.tsx', import.meta.url), 'utf8');
let nutritionComponent = ts.transpileModule(await readFile(new URL('../app/meal-nutrition.tsx', import.meta.url), 'utf8'), { fileName: 'meal-nutrition.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
nutritionComponent = nutritionComponent.replace(/import\s+["'][^"']+\.css["'];?/g, '').replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier)));
const nutritionComponentUrl = 'data:text/javascript;base64,' + Buffer.from(nutritionComponent).toString('base64');
let compiled = ts.transpileModule(source, { fileName: 'diet-records.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import\s+["'][^"']+\.css["'];?/g, '');
const stub = 'data:text/javascript;base64,' + Buffer.from('export default function Stub(){return null}').toString('base64');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => {
  const url = specifier === './meal-nutrition' ? nutritionComponentUrl : specifier.startsWith('@/lib/') ? new URL('../lib/' + specifier.slice('@/lib/'.length), import.meta.url).href : specifier.startsWith('./') ? stub : import.meta.resolve(specifier);
  return 'from ' + JSON.stringify(url);
});
const { ExecutedMealCard } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const render = value => renderToStaticMarkup(React.createElement(ExecutedMealCard, { meal: value }));

test('completed swapped dinner leads with actual food, marks zero pasta uneaten and folds the original 110g plan', () => {
  const target = meal({ state: 'completed', title: '晚餐 · 原计划110g意面', actualEntries: [
    actual('bagel', '贝果', 1, '个'), actual('butter', '黄油', 5), actual('veg', '蔬菜', 150),
    actual('beef', '牛肉', 0.5, '袋'), actual('fish', '鱼', 1, '罐'), actual('no-pasta', '意面', 0, 'g', 'pasta'),
  ] });
  const before = structuredClone(target), html = render(target);
  const main = html.split('<details class="diet-actual">')[0];
  assert.match(main, /贝果/); assert.match(main, /黄油/); assert.match(main, /0\.5 袋/); assert.match(main.replace(/<[^>]*>/g, ''), /未吃 · 0 g/);
  assert.doesNotMatch(main, /110 ?g/);
  assert.match(main, /晚餐 · 实际记录/);
  assert.match(html, /原计划（仅供对照）/); assert.match(html, /110 g/);
  assert.match(html, /完整实际原话 贝果/);
  assert.deepEqual(target, before);
});

test('unreported meals stay on the final plan without requiring a check-in', () => {
  const target = meal(), view = mealExecutionView(target), html = render(target);
  assert.equal(view.mode, 'planned');
  assert.deepEqual(view.remainingItems, []);
  assert.match(html, /110 g/); assert.match(html, /当前菜单可随时修改/); assert.match(html, /个人勾选不影响库存/); assert.match(html, /日终策略及明确实际更正分别结算/);
  assert.doesNotMatch(html, /已报告的实际食物|仍保留的计划/);
});

test('partial reports separate reported food and unreported remaining portions, including repeated planned food', () => {
  const target = meal({ state: 'in_progress', plannedItems: [line('first', '牛肉', 1, '袋', 'beef'), line('second', '牛肉', 2, '袋', 'beef'), line('veg', '蔬菜', 150)], actualEntries: [actual('beef-entry', '牛肉', 2.5, '袋', 'beef'), actual('extra', '鱼', 1, '罐')] });
  const view = mealExecutionView(target), html = render(target);
  assert.equal(view.mode, 'partial');
  assert.deepEqual(view.remainingItems.map(item => [item.id, item.quantity]), [['second', .5], ['veg', 150]]);
  assert.match(html, /已报告的实际食物/); assert.match(html, /仍保留的计划 · 尚未报告/); assert.match(html, /不代表已经吃了/);
  assert.doesNotMatch(html, /实际已记录/);
});

test('a partial completion flag without food details still labels every retained portion as unreported', () => {
  const target = meal({ state: 'in_progress' }), view = mealExecutionView(target), html = render(target);
  assert.equal(view.mode, 'partial');
  assert.equal(view.remainingItems[0].quantity, 110);
  assert.match(html, /部分已报告/); assert.match(html, /尚未提供具体实际食物/);
  assert.match(html, /仍保留的计划 · 尚未报告/);
});

test('unknown or incompatible actual quantities do not invent a remaining balance', () => {
  for (const entry of [actual('unknown', '意面', null, 'g', 'pasta'), actual('different', '意面', 1, '袋', 'pasta')]) {
    const view = mealExecutionView(meal({ state: 'in_progress', actualEntries: [entry] }));
    assert.equal(view.remainingItems[0].quantity, null);
    assert.match(view.remainingItems[0].remainingNote, /余量待核对/);
  }
  const zero = mealExecutionView(meal({ state: 'in_progress', actualEntries: [actual('zero', '意面', 0, 'g', 'pasta')] }));
  assert.equal(zero.remainingItems[0].quantity, 110);
});

test('completed without food details never relabels the old planned food as eaten; original reports and previous plans stay readable', () => {
  const report = '实际原话全文'.repeat(1500);
  const target = meal({ state: 'completed', sourceText: report, planRevisionHistory: [{ at: '2026-10-20T21:00:00Z', previous: { slot: 'dinner', title: '旧晚餐', plannedTime: null, plannedTimeText: '晚饭', plannedItems: [line('old', '原来的备餐', 1, '袋')] } }] });
  const html = render(target), main = html.split('<details class="diet-actual">')[0];
  assert.match(main, /尚未提供具体实际食物/); assert.doesNotMatch(main, /110 g/);
  assert.ok(html.includes(report)); assert.match(html, /之前的计划（1）/); assert.match(html, /原来的备餐/);
});

test('light edit read exposes complete immutable actual facts alongside editable planned fields without original report text', () => {
  const target = meal({ state: 'completed', actualEntries: [actual('actual-zero', '意面', 0), actual('actual-unknown', '蔬菜', null)], sourceText: '不要在轻读返回的全文原话' });
  const original = state(target), before = structuredClone(original);
  const result = readFoodPlanEditContext(original, { planId: 'day', mealIds: ['dinner'] });
  const value = result.meals[0];
  assert.equal(value.canPatch, true); assert.equal(value.canRemove, false); assert.equal(value.actualFactsImmutable, true);
  assert.equal(value.state, 'completed');
  assert.deepEqual(value.actualEntries.map(entry => [entry.id, entry.itemId, entry.name, entry.quantity, entry.unit]), [['actual-zero', 'actual-zero', '意面', 0, 'g'], ['actual-unknown', 'actual-unknown', '蔬菜', null, 'g']]);
  assert.equal(value.actualEntries[0].nutrition.kcal, 120);
  assert.equal(value.actualEntries[0].nutrition.source, 'estimate');
  assert.equal(value.actualEntries[0].sourceTextAvailable, true);
  assert.equal(result.completeForPatch, true);
  assert.ok(JSON.stringify(result).length <= 24000);
  assert.doesNotMatch(JSON.stringify(result), /不要在轻读返回的全文原话|完整实际原话/);
  assert.deepEqual(original, before);
});

test('oversized target actual facts reject explicitly instead of dropping entries or returning a partial target meal', () => {
  const target = meal({ state: 'completed', actualEntries: Array.from({ length: 200 }, (_, index) => actual('actual-' + index, '\u0000'.repeat(200), 1)) });
  const original = state(target), before = structuredClone(original);
  assert.throws(() => readFoodPlanEditContext(original, { planId: 'day', mealIds: ['dinner'] }), error => error.status === 413 && error.code === 'EDIT_CONTEXT_TOO_LARGE');
  assert.deepEqual(original, before);
});

test('current actual nutrition is visible while correction history stays folded with its full evidence and old snapshot', () => {
  const entry = actual('actual-bagel', '贝果', 100);
  entry.nutritionSnapshot = { ...entry.nutritionSnapshot, nutrition: { ...nutrition, kcal: 250, protein: 20, carbs: 40, fat: 0, sourceText: '完整的本次营养估值依据' } };
  entry.nutritionCorrectionHistory = [{ at: '2026-10-20T22:00:00Z', sourceText: '只补营养，不改食物用量。'.repeat(250), previous: { ...entry.nutritionSnapshot, nutrition: { ...nutrition, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown', sourceText: '' } } }];
  const original = meal({ state: 'completed', actualEntries: [entry] }), before = structuredClone(original), html = render(original);
  assert.match(html, /<details><summary>营养更正与依据（1）<\/summary>/);
  assert.match(html, /当前营养依据/);
  assert.match(html, /250 kcal/);
  assert.match(html, /脂肪：0 g/);
  assert.match(html, /更正前/);
  assert.match(html, /热量：未提供/);
  assert.ok(html.includes(entry.nutritionCorrectionHistory[0].sourceText));
  assert.match(html, /完整的本次营养估值依据/);
  assert.match(html, /meal-nutrition-summary/);
  assert.match(html, /meal-metric-value/);
  assert.doesNotMatch(html.split('<details class="health-source">')[0], /营养更正与依据/);
  assert.deepEqual(original, before);
  const light = readFoodPlanEditContext(state(original), { planId: 'day', mealIds: ['dinner'] });
  assert.equal(light.meals[0].actualEntries[0].nutritionCorrectionCount, 1);
  assert.match(light.instructions, /record_meal_intake/);
  assert.match(light.instructions, /营养更正用nutritionCorrections及来源/);
  assert.match(light.instructions, /已有actual不可由计划覆盖/);
  assert.match(light.instructions, /完成餐按实际快照/);
  assert.doesNotMatch(JSON.stringify(light), /只补营养，不改食物用量/);
});
