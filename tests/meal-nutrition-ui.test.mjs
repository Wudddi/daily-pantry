import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { mealNutritionView } from '../lib/meal-nutrition-view.mjs';

let compiled = ts.transpileModule(await readFile(new URL('../app/meal-nutrition.tsx', import.meta.url), 'utf8'), { fileName: 'meal-nutrition.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import\s+["']\.\/meal-nutrition\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier)));
const { MealNutritionSummary, FoodNutritionList } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const nutrition = patch => ({ basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 20, carbs: 10, fat: 5, source: 'label', sourceText: '', sourceNote: '', ...patch });
function food(id, quantity = 100, patch = {}) { return { id, itemId: id, name: '食物 ' + id, quantity, unit: 'g', nutritionSnapshot: { name: '食物 ' + id, unit: 'g', gramsPerUnit: null, nutrition: nutrition(), ingredients: '', supplementFacts: '' }, ...patch }; }
function meal(patch = {}) { return { id: 'dinner', slot: 'dinner', title: '晚餐', state: 'reserved', plannedItems: [food('beef')], actualEntries: [], reportHistory: [], ...patch }; }
const renderSummary = view => renderToStaticMarkup(React.createElement(MealNutritionSummary, { totals: view.totals, basisLabel: view.basisLabel, note: view.note }));
const renderRows = rows => renderToStaticMarkup(React.createElement(FoodNutritionList, { rows }));
function metric(html, label) { return html.split('<dt class="meal-metric-label">' + label + '</dt>')[1]?.split('</dd>')[0] ?? ''; }

test('saved meal and each food expose the same calculated portion values with readable units', () => {
  const view = mealNutritionView(meal({ plannedItems: [food('beef', 50)] }));
  const summary = renderSummary(view), rows = renderRows(view.rows);
  assert.match(summary, /本餐计划/);
  assert.match(metric(summary, '热量'), /100/);
  assert.match(metric(summary, '蛋白质'), /10/);
  assert.match(metric(rows, '热量'), /100/);
  assert.match(metric(rows, '蛋白质'), /10/);
  assert.match(rows, /食物 beef/); assert.match(rows, /50 g/);
  assert.match(rows, /<small>kcal<\/small>/); assert.match(rows, /<small>g<\/small>/);
  assert.doesNotMatch(rows, /待补齐/);
});

test('unknown nutrient stays independently missing while explicit zero and estimated known nutrients remain visible', () => {
  const line = food('mixed'); line.nutritionSnapshot.nutrition = nutrition({ carbs: null, fat: 0, nutrientSources: { protein: 'estimate' } });
  const view = mealNutritionView(meal({ plannedItems: [line] })), html = renderRows(view.rows);
  assert.match(metric(html, '碳水'), /待补齐/);
  assert.doesNotMatch(metric(html, '碳水'), /<span>0<\/span>/);
  assert.match(metric(html, '脂肪'), /<span>0<\/span>/);
  assert.doesNotMatch(metric(html, '脂肪'), /待补齐/);
  assert.match(metric(html, '蛋白质'), /≈ 20/);
  assert.doesNotMatch(metric(html, '热量'), /≈/);
});

test('partial meal totals keep their known subtotal separate instead of claiming the subtotal is the complete meal', () => {
  const missing = food('unknown'); missing.nutritionSnapshot.nutrition = nutrition({ kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' });
  const view = mealNutritionView(meal({ plannedItems: [food('known', 50), missing] }));
  const html = renderSummary(view), energy = metric(html, '热量');
  assert.match(energy, /待补齐/);
  assert.match(energy, /已知部分 100 kcal/);
  assert.match(metric(html, '蛋白质'), /已知部分 10 g/);
});

test('unknown quantity never becomes one portion or zero; empty totals also remain unprovided', () => {
  const view = mealNutritionView(meal({ state: 'completed', actualEntries: [food('unreported', null)] }));
  const rows = renderRows(view.rows);
  assert.match(rows, /用量未报/);
  assert.equal([...rows.matchAll(/<span>待补齐<\/span>/g)].length, 4);
  assert.doesNotMatch(rows, /<span>0<\/span>|1 g/);
  const empty = renderToStaticMarkup(React.createElement(MealNutritionSummary, { totals: [] }));
  assert.equal([...empty.matchAll(/<span>待补齐<\/span>/g)].length, 4);
});

test('zero actual intake is explicitly uneaten and all four zero contributions stay known without nutrition data', () => {
  const view = mealNutritionView(meal({ state: 'completed', actualEntries: [food('not-eaten', 0, { nutritionSnapshot: null })] }));
  const html = renderRows(view.rows);
  assert.match(html, /未吃 · /); assert.match(html, /0 g/);
  assert.equal([...html.matchAll(/<span>0<\/span>/g)].length, 4);
  assert.doesNotMatch(html, /待补齐/);
});

test('partial actual and remaining sections are display evidence and never replace core effective meal totals', () => {
  const planned = food('beef', 100), reported = food('reported-beef', 50, { itemId: 'beef', name: '食物 beef' });
  reported.nutritionSnapshot.nutrition = nutrition({ kcal: 500 });
  const view = mealNutritionView(meal({ state: 'in_progress', plannedItems: [planned], actualEntries: [reported] }));
  assert.equal(view.totals[0].value, 200);
  assert.equal(view.actualRows[0].totals[0].value, 250);
  const html = renderSummary(view);
  assert.match(metric(html, '热量'), /<span>200<\/span>/);
  assert.doesNotMatch(metric(html, '热量'), /350|250/);
  assert.match(html, /实际与剩余明细用于对照，请勿另行相加/);
});

test('nutrition source originals are preserved fully in one closed disclosure and escaped as text', () => {
  const line = food('source');
  const original = '<script>不运行</script>\n明确估算依据'.repeat(50);
  line.nutritionSnapshot.nutrition = nutrition({ source: 'estimate', sourceText: original, sourceNote: '按保存的这份用量换算' });
  const html = renderRows(mealNutritionView(meal({ plannedItems: [line] })).rows);
  assert.match(html, /<details class="meal-food-sources"><summary>查看营养依据<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open|<script>/);
  assert.ok(html.includes(original.replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  assert.match(html, /按保存的这份用量换算/);
  assert.match(metric(html, '热量'), /≈ 200/);
});

test('long names stay intact, tiny positive nutrient values are not rounded into a false zero, and missing conversion is explicit', () => {
  const line = food('long', 1, { name: '很长的完整食品名称'.repeat(12), unit: '罐' });
  const view = mealNutritionView(meal({ plannedItems: [line] }));
  const html = renderRows(view.rows);
  assert.ok(html.includes(line.name));
  assert.match(html, /营养口径无法换算/);
  const tiny = food('tiny', 100); tiny.nutritionSnapshot.nutrition = nutrition({ protein: .02 });
  const tinyHtml = renderRows(mealNutritionView(meal({ plannedItems: [tiny] })).rows);
  assert.match(metric(tinyHtml, '蛋白质'), /&lt;0.1/);
  assert.doesNotMatch(metric(tinyHtml, '蛋白质'), /<span>0<\/span>/);
});

test('partial plan and actual lines with the same record id retain separate stable list and source keys', () => {
  const planned = food('same-id', 100, { itemId: 'planned-food', name: '计划食品' });
  const actual = food('same-id', 50, { itemId: 'actual-food', name: '临时增加的实际食品' });
  const view = mealNutritionView(meal({ state: 'in_progress', plannedItems: [planned], actualEntries: [actual] }));
  assert.deepEqual(view.rows.map(row => [row.id, row.origin]), [['same-id', 'planned'], ['same-id', 'reported']]);
  const original = structuredClone(view.rows), tree = FoodNutritionList({ rows: view.rows });
  function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children)];
  }
  const all = nodes(tree), list = all.find(node => node.props?.className === 'meal-food-list');
  const sources = all.find(node => node.props?.className === 'meal-food-sources');
  const listKeys = list.props.children.map(node => node.key);
  const sourceKeys = sources.props.children.flat().filter(node => node?.type === 'div').map(node => node.key);
  assert.deepEqual(listKeys, ['planned:same-id', 'reported:same-id']);
  assert.deepEqual(sourceKeys, listKeys);
  assert.equal(new Set(listKeys).size, 2);
  const html = renderRows(view.rows);
  assert.match(html, /计划食品/); assert.match(html, /临时增加的实际食品/);
  assert.deepEqual(view.rows, original, 'presentation keys never change saved record ids or nutrition');
});
