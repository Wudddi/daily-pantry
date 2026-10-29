import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { dailyFoodRollup } from '../lib/daily-food-rollup.mjs';

let compiled = ts.transpileModule(await readFile(new URL('../app/daily-food-overview.tsx', import.meta.url), 'utf8'), {
  fileName: 'daily-food-overview.tsx',
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/import\s+["']\.\/daily-food-overview\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(import.meta.resolve(specifier)));
const { default: DailyFoodOverview } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const nutrition = patch => ({ basisAmount: 100, basisUnit: 'g', kcal: 100, protein: 10, carbs: 8, fat: 2, source: 'label', ...patch });
const food = (id, quantity = 100, patch = {}) => ({ id, itemId: id, name: '食物 ' + id, quantity, unit: 'g',
  nutritionSnapshot: { name: '食物 ' + id, unit: 'g', gramsPerUnit: null, nutrition: nutrition() }, ...patch });
const meal = (id, lines, patch = {}) => ({ id, slot: id, title: id, state: 'reserved', plannedItems: lines, actualEntries: [], reportHistory: [], ...patch });
const plan = meals => ({ id: 'daily-food-2026-10-26', format: 'meals_v1', date: '2026-10-26', status: 'draft', meals, supplementDoses: [] });
const render = summary => renderToStaticMarkup(React.createElement(DailyFoodOverview, { summary }));

test('daily detail renders the cross-meal total and each allocation from the shared saved-plan calculation', () => {
  const input = plan([meal('lunch', [food('mushroom', 100, { name: '蘑菇' })]), meal('dinner', [food('mushroom', 200, { name: '蘑菇' })])]);
  const before = structuredClone(input), summary = dailyFoodRollup(input), html = render(summary);
  assert.equal(summary.rows.length, 1);
  assert.match(html, /id="daily-food-details" tabindex="-1"/);
  assert.match(html, /全天明细/); assert.match(html, /1 项食材/);
  assert.match(html, /蘑菇的全天总用量[^>]*>.*?<strong>300 <small>g<\/small>/s);
  assert.match(html, /<span>午餐<\/span><strong>100 g<\/strong>/);
  assert.match(html, /<span>晚餐<\/span><strong>200 g<\/strong>/);
  assert.match(html, /食物小计/); assert.match(html, /补给营养/); assert.match(html, /全天合计/);
  assert.doesNotMatch(html, /<details[^>]* open|确认最终版/);
  assert.deepEqual(input, before);
});

test('unknown food quantity shows a known portion without inventing a complete total or zero nutrients', () => {
  const summary = dailyFoodRollup(plan([meal('lunch', [food('soup', 100)]), meal('dinner', [food('soup', null)])]));
  const html = render(summary);
  assert.match(html, /总量待补/); assert.match(html, /已知 100 g/); assert.match(html, /晚餐<\/span><strong>用量未报/);
  assert.match(html, /待补齐/); assert.match(html, /已知 100 kcal/);
  assert.doesNotMatch(html, /晚餐<\/span><strong>0 g/);
});

test('unknown supplement nutrients are marked separately while known daily food still contributes', () => {
  const input = plan([meal('lunch', [food('rice', 100)])]);
  input.supplementDoses = [{ id: 'dose', name: '未知补给', plannedQuantity: 1, unit: '粒', scheduled: true, requirement: 'daily', state: 'scheduled', actualEntries: [], nutritionSnapshot: null }];
  const summary = dailyFoodRollup(input), html = render(summary);
  assert.equal(summary.supplementPartial, true);
  const supplement = html.split('<strong>补给营养</strong>')[1].split('<strong>全天合计</strong>')[0];
  assert.match(supplement, /待补齐/);
  assert.doesNotMatch(supplement, /<span>0<\/span><small>kcal/);
  assert.match(html, /补给仍有营养未提供，全天合计含补给的已知部分/);
  assert.match(html.split('<strong>全天合计</strong>')[1], /<span>100<\/span><small>kcal/);
});

test('only reported zero quantities are labelled uneaten; saved planned zero remains a plan', () => {
  const planned = render(dailyFoodRollup(plan([meal('lunch', [food('zero', 0)])])));
  assert.doesNotMatch(planned, /未吃/);
  const actual = render(dailyFoodRollup(plan([meal('lunch', [food('zero', 100)], { state: 'completed', actualEntries: [food('actual-zero', 0, { itemId: 'zero' })] })])));
  assert.match(actual, /未吃 ·/); assert.match(actual, /<em>实际<\/em>/);
  assert.match(actual, /is-uneaten/);
});

test('liquid totals stay mL, packaged portions use saved grams, and long names remain safe text', () => {
  const drink = food('drink', 15, { name: '<img src=x onerror=alert(1)>饮料', unit: 'ml', nutritionSnapshot: { name: '饮料', unit: 'ml', gramsPerUnit: null, nutrition: nutrition({ basisUnit: 'ml' }) } });
  const bag = food('beef', .5, { name: '分袋牛肉', unit: '袋', nutritionSnapshot: { name: '分袋牛肉', unit: '袋', gramsPerUnit: 132, nutrition: nutrition() } });
  const html = render(dailyFoodRollup(plan([meal('lunch', [drink, bag]), meal('dinner', [drink, bag])])));
  assert.match(html, /30 <small>mL<\/small>/);
  assert.match(html, /132 <small>g<\/small>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;饮料/);
  assert.doesNotMatch(html, /<img src=x|0.5 <small>袋/);
});

test('tiny positive nutrients remain visibly positive and missing macro values never render as zero', () => {
  const summary = dailyFoodRollup(plan([meal('lunch', [food('tiny', 100, { nutritionSnapshot: { name: '微量食物', unit: 'g', nutrition: nutrition({ kcal: .2, protein: .02, carbs: null, fat: 0 }) } })])]));
  const html = render(summary);
  assert.match(html, /&lt;1/); assert.match(html, /&lt;0.1/); assert.match(html, /待补齐/);
  assert.match(html, /<dt>脂肪<\/dt><dd><span>0<\/span><small>g/);
  assert.doesNotMatch(html.split('<div class="daily-rollup-totals">')[0], /<dt>碳水<\/dt><dd><span>0<\/span>/);
});
