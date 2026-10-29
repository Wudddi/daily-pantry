import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

let compiled = ts.transpileModule(await readFile(new URL('../app/meal-overview.tsx', import.meta.url), 'utf8'), {
  fileName: 'meal-overview.tsx',
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
compiled = compiled.replace(/import\s+["']\.\/meal-overview\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(
  specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier),
));
const { default: MealOverview, MealOverviewCard } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const nutrition = patch => ({ basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 20, carbs: 10, fat: 5, source: 'label', sourceText: '', sourceNote: '', ...patch });
function food(id, quantity = 100, patch = {}) {
  return { id, itemId: id, name: '食物 ' + id, quantity, unit: 'g', nutritionSnapshot: { name: '食物 ' + id, unit: 'g', gramsPerUnit: null, nutrition: nutrition(), ingredients: '', supplementFacts: '' }, ...patch };
}
function meal(patch = {}) {
  return { id: 'dinner', slot: 'dinner', title: '原计划牛肉米饭', state: 'reserved', plannedTime: '18:30', plannedItems: [food('beef')], actualEntries: [], reportHistory: [], ...patch };
}
function renderCard(input, props = {}) {
  return renderToStaticMarkup(React.createElement(MealOverviewCard, { meal: input, planStatus: 'reserved', targetId: 'selected-detail', triggerId: 'meal-trigger', onSelect() {}, ...props }));
}
function metric(html, label) { return html.split('<dt>' + label + '</dt>')[1]?.split('</div>')[0] ?? ''; }
function title(html) { return html.match(/<h3[^>]*>(.*?)<\/h3>/s)?.[1] ?? ''; }

test('the all-day overview exposes every meal without rendering any full nutrition detail by default', () => {
  const meals = ['breakfast', 'lunch', 'dinner'].map((slot, index) => meal({ id: slot, slot, title: ['早餐燕麦碗', '午餐牛肉饭', '晚餐贝果'][index] }));
  let detailCalls = 0;
  const html = renderToStaticMarkup(React.createElement(MealOverview, { meals, planStatus: 'reserved', renderDetail() { detailCalls += 1; throw new Error('detail must be on demand'); } }));
  assert.equal(detailCalls, 0);
  assert.equal([...html.matchAll(/aria-label="(?:早餐|午餐|晚餐)总览"/g)].length, 3);
  assert.match(html, /早餐燕麦碗/); assert.match(html, /午餐牛肉饭/); assert.match(html, /晚餐贝果/);
  assert.equal([...html.matchAll(/aria-expanded="false"/g)].length, 3);
  assert.match(html, /class="meal-overview-detail" hidden=""/);
  assert.doesNotMatch(html, /详细饮食|meal-food-nutrition/);
  assert.match(html,/当前菜单/);assert.doesNotMatch(html,/计划 · 未完成|未完成的菜单/);
});

test('a completed actual swap previews the bagel instead of stale pasta and hides zero rows without changing the original facts', () => {
  const input = meal({ title: '原计划110克意面', state: 'completed', plannedItems: [food('pasta', 110, { name: '干意面' })], actualEntries: [food('pasta', 0, { name: '干意面', nutritionSnapshot: null }), food('bagel', 86, { name: '芝麻贝果' })] });
  const before = structuredClone(input), html = renderCard(input);
  assert.equal(title(html), '芝麻贝果');
  assert.doesNotMatch(title(html), /意面|原计划/);
  assert.match(html, /实际记录/); assert.match(html, /实际：时间未报/);
  assert.match(html, /<details class="meal-overview-foods"><summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(html, /干意面<\/span>|未吃 · 0 g/);
  assert.match(html, /食材与份量 · 1项/);
  assert.match(html, /芝麻贝果<\/span><strong>86 g/);
  assert.match(metric(html, '热量'), /172/);
  assert.doesNotMatch(metric(html, '热量'), /220|392/);
  assert.deepEqual(input, before);
});

test('partial reports use the effective current meal amounts rather than adding actual and original quantities', () => {
  const planned = food('rice', 110, { name: '米饭' }), reported = food('rice-actual', 30, { itemId: 'rice', name: '米饭' });
  const html = renderCard(meal({ state: 'in_progress', plannedItems: [planned], actualEntries: [reported] }));
  assert.match(html, /部分已报告/);
  assert.equal(title(html), '米饭');
  assert.match(html, /米饭<\/span><strong>110 g/);
  assert.doesNotMatch(html, /140 g|80 g/);
  assert.match(metric(html, '热量'), /220/);
  assert.doesNotMatch(metric(html, '热量'), /280|60/);
});

test('completed without actual content keeps the planned nutrition and makes the missing actual report clear', () => {
  const html = renderCard(meal({ state: 'completed' }));
  assert.equal(title(html), '原计划牛肉米饭');
  assert.match(html, /实际内容未报/); assert.match(html, /计划：18:30/);
  assert.doesNotMatch(html, />实际记录<|实际：时间未报/);
  assert.match(metric(html, '热量'), /200/);
  assert.match(html, /食物 beef<\/span><strong>100 g/);
});

test('cancelled plans do not revive planned food or nutrition, while previously reported facts remain visible', () => {
  const empty = renderCard(meal(), { planStatus: 'cancelled' });
  assert.equal(title(empty), '无已报告的食物');
  assert.match(empty, /已取消/); assert.match(empty, /食材与份量 · 0项/);
  assert.match(metric(empty, '热量'), /<dd>0<small> kcal/);
  assert.doesNotMatch(empty, /食物 beef|原计划牛肉米饭/);
  const actual = renderCard(meal({ actualEntries: [food('reported', 20, { name: '已吃牛肉' })] }), { planStatus: 'cancelled' });
  assert.equal(title(actual), '已吃牛肉');
  assert.match(metric(actual, '热量'), /40/);
});

test('unknown nutrients, an explicit zero and tiny positive nutrients remain distinct in compact metrics', () => {
  const line = food('mixed');
  line.nutritionSnapshot.nutrition = nutrition({ protein: .02, carbs: null, fat: 0 });
  const html = renderCard(meal({ plannedItems: [line] }));
  assert.match(metric(html, '碳水'), /待补齐/);
  assert.doesNotMatch(metric(html, '碳水'), /<dd>0/);
  assert.match(metric(html, '脂肪'), /<dd>0<small> g/);
  assert.doesNotMatch(metric(html, '脂肪'), /待补齐/);
  assert.match(metric(html, '蛋白质'), /&lt;0.1/);
  assert.doesNotMatch(metric(html, '蛋白质'), /<dd>0<small>/);
});

test('a known subtotal remains incomplete, and unreported actual quantity is not invented as one serving or zero', () => {
  const missing = food('unknown');
  missing.nutritionSnapshot.nutrition = nutrition({ kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' });
  const partial = renderCard(meal({ plannedItems: [food('known', 50), missing] }));
  assert.match(metric(partial, '热量'), /待补齐/);
  assert.match(metric(partial, '热量'), /已知 100 kcal/);
  const unknownQuantity = renderCard(meal({ state: 'completed', actualEntries: [food('unreported', null)] }));
  assert.match(unknownQuantity, /用量未报/);
  assert.equal([...unknownQuantity.matchAll(/<dd>待补齐<\/dd>/g)].length, 4);
  assert.doesNotMatch(unknownQuantity, /未吃 ·|<strong>1 g/);
});

test('zero planned and reported portions are hidden from the compact overview while the original records remain intact', () => {
  const plannedInput = meal({ plannedItems: [food('planned-zero', 0)] }), plannedBefore = structuredClone(plannedInput);
  const planned = renderCard(plannedInput);
  assert.doesNotMatch(planned, /食物 planned-zero<\/span>|<strong>0 g/);
  assert.match(planned, /食材与份量 · 0项/);
  assert.doesNotMatch(planned, /未吃/);
  const actualInput = meal({ state: 'completed', actualEntries: [food('reported-zero', 0, { nutritionSnapshot: null })] }), actualBefore = structuredClone(actualInput);
  const actual = renderCard(actualInput);
  assert.doesNotMatch(actual, /食物 reported-zero<\/span>|未吃 · 0 g/);
  assert.match(actual, /食材与份量 · 0项/);
  assert.match(metric(actual, '热量'), /<dd>0<small> kcal/);
  assert.deepEqual(plannedInput, plannedBefore); assert.deepEqual(actualInput, actualBefore);
});

test('presentation retains long names and precise portions as escaped text without changing stored meals or evidence', () => {
  const line = food('precise', .125, { name: '<script>完整长名</script>'.repeat(12), unit: '袋', nutritionSnapshot: null });
  const input = meal({ state: 'completed', actualEntries: [line], sourceText: '用户实际汇报', planRevisionHistory: [{ at: '2026-10-20', previous: { title: '旧版本' } }] });
  const before = structuredClone(input);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(input);
  const html = renderCard(input, { expanded: true });
  assert.ok(html.includes('&lt;script&gt;完整长名&lt;/script&gt;'.repeat(12)));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /0.125 袋/);
  assert.match(html, /id="meal-trigger" aria-expanded="true" aria-controls="selected-detail"/);
  assert.deepEqual(input, before);
});
