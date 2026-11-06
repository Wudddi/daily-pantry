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
compiled = compiled.replace(/(?<=^import[^;\n]*\s)from\s+(["'])([^"']+)\1/gm, (_match, _quote, specifier) => 'from ' + JSON.stringify(
  specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier),
));
const { default: MealOverview, MealOverviewCard } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const nutrition = patch => ({ basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 20, carbs: 10, fat: 5, source: 'label', sourceText: '', sourceNote: '', ...patch });
function food(id, quantity = 100, patch = {}) {
  return { id, itemId: id, name: "Food " + id, quantity, unit: 'g', nutritionSnapshot: { name: "Food " + id, unit: 'g', gramsPerUnit: null, nutrition: nutrition(), ingredients: '', supplementFacts: '' }, ...patch };
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
  assert.equal([...html.matchAll(/aria-label="(?:Breakfast|Lunch|Dinner) overview"/g)].length, 3);
  assert.match(html, /早餐燕麦碗/); assert.match(html, /午餐牛肉饭/); assert.match(html, /晚餐贝果/);
  assert.equal([...html.matchAll(/aria-expanded="false"/g)].length, 3);
  assert.match(html, /class="meal-overview-detail" hidden=""/);
  assert.doesNotMatch(html, /Meal details|meal-food-nutrition/);
  assert.match(html,/Current menu/);assert.doesNotMatch(html,/Planned · not completed|Uncompleted menu/);
});

test('a completed actual swap previews the bagel instead of stale pasta and hides zero rows without changing the original facts', () => {
  const input = meal({ title: '原计划110克意面', state: 'completed', plannedItems: [food('pasta', 110, { name: '干意面' })], actualEntries: [food('pasta', 0, { name: '干意面', nutritionSnapshot: null }), food('bagel', 86, { name: '芝麻贝果' })] });
  const before = structuredClone(input), html = renderCard(input);
  assert.equal(title(html), '芝麻贝果');
  assert.doesNotMatch(title(html), /意面|原计划/);
  assert.match(html, /reported intake/); assert.match(html, /Actual: Time unreported/);
  assert.match(html, /<details class="meal-overview-foods"><summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(html, /干意面<\/span>|Not eaten · 0 g/);
  assert.match(html, /Ingredients and amounts · 1 items/);
  assert.match(html, /芝麻贝果<\/span><strong>86 g/);
  assert.match(metric(html, "Calories"), /172/);
  assert.doesNotMatch(metric(html, "Calories"), /220|392/);
  assert.deepEqual(input, before);
});

test('partial reports use the effective current meal amounts rather than adding actual and original quantities', () => {
  const planned = food('rice', 110, { name: "Rice" }), reported = food('rice-actual', 30, { itemId: 'rice', name: "Rice" });
  const html = renderCard(meal({ state: 'in_progress', plannedItems: [planned], actualEntries: [reported] }));
  assert.match(html, /Partially reported/);
  assert.equal(title(html), "Rice");
  assert.match(html, /Rice<\/span><strong>110 g/);
  assert.doesNotMatch(html, /140 g|80 g/);
  assert.match(metric(html, "Calories"), /220/);
  assert.doesNotMatch(metric(html, "Calories"), /280|60/);
});

test('completed without actual content keeps the planned nutrition and makes the missing actual report clear', () => {
  const html = renderCard(meal({ state: 'completed' }));
  assert.equal(title(html), '原计划牛肉米饭');
  assert.match(html, /Actual foods unreported/); assert.match(html, /Planned: 18:30/);
  assert.doesNotMatch(html, />reported intake<|Actual: Time unreported/);
  assert.match(metric(html, "Calories"), /200/);
  assert.match(html, /Food beef<\/span><strong>100 g/);
});

test('cancelled plans do not revive planned food or nutrition, while previously reported facts remain visible', () => {
  const empty = renderCard(meal(), { planStatus: 'cancelled' });
  assert.equal(title(empty), "No reported foods");
  assert.match(empty, /Cancelled/); assert.match(empty, /Ingredients and amounts · 0 items/);
  assert.match(metric(empty, "Calories"), /<dd>0<small> kcal/);
  assert.doesNotMatch(empty, /Food beef|原计划牛肉米饭/);
  const actual = renderCard(meal({ actualEntries: [food('reported', 20, { name: '已吃牛肉' })] }), { planStatus: 'cancelled' });
  assert.equal(title(actual), '已吃牛肉');
  assert.match(metric(actual, "Calories"), /40/);
});

test('unknown nutrients, an explicit zero and tiny positive nutrients remain distinct in compact metrics', () => {
  const line = food('mixed');
  line.nutritionSnapshot.nutrition = nutrition({ protein: .02, carbs: null, fat: 0 });
  const html = renderCard(meal({ plannedItems: [line] }));
  assert.match(metric(html, "Carbs"), /Incomplete/);
  assert.doesNotMatch(metric(html, "Carbs"), /<dd>0/);
  assert.match(metric(html, "Fat"), /<dd>0<small> g/);
  assert.doesNotMatch(metric(html, "Fat"), /Incomplete/);
  assert.match(metric(html, "Protein"), /&lt;0.1/);
  assert.doesNotMatch(metric(html, "Protein"), /<dd>0<small>/);
});

test('a known subtotal remains incomplete, and unreported actual quantity is not invented as one serving or zero', () => {
  const missing = food('unknown');
  missing.nutritionSnapshot.nutrition = nutrition({ kcal: null, protein: null, carbs: null, fat: null, source: 'unknown' });
  const partial = renderCard(meal({ plannedItems: [food('known', 50), missing] }));
  assert.match(metric(partial, "Calories"), /Incomplete/);
  assert.match(metric(partial, "Calories"), /Known: 100 kcal/);
  const unknownQuantity = renderCard(meal({ state: 'completed', actualEntries: [food('unreported', null)] }));
  assert.match(unknownQuantity, /Quantity unreported/);
  assert.equal([...unknownQuantity.matchAll(/<dd>Incomplete<\/dd>/g)].length, 4);
  assert.doesNotMatch(unknownQuantity, /Not eaten ·|<strong>1 g/);
});

test('zero planned and reported portions are hidden from the compact overview while the original records remain intact', () => {
  const plannedInput = meal({ plannedItems: [food('planned-zero', 0)] }), plannedBefore = structuredClone(plannedInput);
  const planned = renderCard(plannedInput);
  assert.doesNotMatch(planned, /Food planned-zero<\/span>|<strong>0 g/);
  assert.match(planned, /Ingredients and amounts · 0 items/);
  assert.doesNotMatch(planned, /Not eaten/);
  const actualInput = meal({ state: 'completed', actualEntries: [food('reported-zero', 0, { nutritionSnapshot: null })] }), actualBefore = structuredClone(actualInput);
  const actual = renderCard(actualInput);
  assert.doesNotMatch(actual, /Food reported-zero<\/span>|Not eaten · 0 g/);
  assert.match(actual, /Ingredients and amounts · 0 items/);
  assert.match(metric(actual, "Calories"), /<dd>0<small> kcal/);
  assert.deepEqual(plannedInput, plannedBefore); assert.deepEqual(actualInput, actualBefore);
});

test('presentation retains long names and precise portions as escaped text without changing stored meals or evidence', () => {
  const line = food('precise', .125, { name: '<script>完整长名</script>'.repeat(12), unit: '袋', nutritionSnapshot: null });
  const input = meal({ state: 'completed', actualEntries: [line], sourceText: "User intake report", planRevisionHistory: [{ at: '2026-10-20', previous: { title: '旧版本' } }] });
  const before = structuredClone(input);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(input);
  const html = renderCard(input, { expanded: true });
  assert.ok(html.includes('&lt;script&gt;完整长名&lt;/script&gt;'.repeat(12)));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /0.125 bags/);
  assert.match(html, /id="meal-trigger" aria-expanded="true" aria-controls="selected-detail"/);
  assert.deepEqual(input, before);
});

test('planned recipes show collapsed dish titles and leave fruit outside without a long raw-ingredient heading',()=>{
 const input=meal({title:'旧标题里把酸奶香蕉可可粉鸡蛋全部拼在一起',plannedItems:[food('yogurt',75,{name:'PC原味无脂希腊酸奶'}),food('banana',80,{name:"Banana"}),food('cocoa',8,{name:"Cocoa powder"}),food('berries',60,{name:'蓝莓'})],recipeGroups:[{id:'brownie',name:"Banana chocolate brownies",lineIds:['yogurt','banana','cocoa']}]});
 const before=structuredClone(input),html=renderCard(input);
 assert.equal(title(html),"Banana chocolate brownies");assert.match(html,/class="meal-overview-recipe"/);assert.match(html,/3 ingredients/);
 assert.match(html,/<details><summary><h3 title="Banana chocolate brownies">/);assert.doesNotMatch(html,/<details[^>]* open/);
 assert.match(html,/class="meal-overview-single"><span>蓝莓<\/span><strong>60 g/);
 assert.match(html,/aria-label="Banana chocolate brownies recipe ingredients"/);assert.deepEqual(input,before);
});
test('a completed dish title stays ahead of an independent milk report and its actual ingredient portions remain expandable',()=>{
 const input=meal({id:'breakfast',slot:'breakfast',state:'completed',title:'旧原料标题',plannedItems:[food('yogurt-b',75,{itemId:'yogurt',name:"Yogurt"}),food('banana-b',80,{itemId:'banana',name:"Banana"})],recipeGroups:[{id:'brownie',name:"Banana chocolate brownies",lineIds:['yogurt-b','banana-b']}],actualEntries:[food('milk-extra',220,{name:'Fairlife Ultra Filtered High Protein Milk 长英文独立牛奶',unit:'ml'}),food('actual-yogurt',75,{itemId:'yogurt',name:"Yogurt",intakeLineId:'yogurt-b'}),food('actual-banana',80,{itemId:'banana',name:"Banana",intakeLineId:'banana-b'})]});
 const before=structuredClone(input),html=renderCard(input);
 assert.equal(title(html),"Banana chocolate brownies");assert.match(html,/2 ingredients/);assert.match(html,/Yogurt<\/span><strong>75 g/);
 assert(html.indexOf('meal-overview-recipe')<html.indexOf('meal-overview-single'),'dish titles precede independent drink rows');
 assert.match(html,/class="meal-overview-single"><span>Fairlife Ultra Filtered High Protein Milk 长英文独立牛奶<\/span><strong>220 mL/);assert.deepEqual(input,before);
});
test('an ambiguous manual actual shared by multiple recipes stays a single food rather than claiming either dish was eaten',()=>{
 const input=meal({state:'completed',plannedItems:[food('yogurt-b',75,{itemId:'yogurt',name:"Yogurt"}),food('yogurt-k',100,{itemId:'yogurt',name:"Yogurt"})],recipeGroups:[{id:'brownie',name:"Banana chocolate brownies",lineIds:['yogurt-b']},{id:'basque',name:"Basque cheesecake",lineIds:['yogurt-k']}],actualEntries:[food('manual-yogurt',175,{itemId:'yogurt',name:"Yogurt"})]});
 const html=renderCard(input);assert.equal(title(html),"Yogurt");assert.doesNotMatch(html,/meal-overview-recipe|Banana chocolate brownies|巴斯克/);assert.match(html,/Yogurt<\/span><strong>175 g/);
});
