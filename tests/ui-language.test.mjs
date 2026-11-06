import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Fresh processes are intentional: static navigation labels are selected when
// a module is imported. Neither a test nor a language change writes user data.
const root = fileURLToPath(new URL('../', import.meta.url));
const configuredLanguage = JSON.parse(readFileSync(new URL('../lib/ui-language-config.json', import.meta.url), 'utf8')).language;
const results = new Map();
function probe(language) {
  const key = language ?? 'configured';
  if (results.has(key)) return results.get(key);
  const code = `
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ts from 'typescript';
    import { getUiLanguage, uiLocale, uiText } from './lib/ui-language.mjs';
    import { unitLabel, storageLabel } from './lib/english-display.mjs';
    import { applyMutation, validateItem } from './lib/inventory.mjs';
    const dataUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
    const stub = dataUrl('export default function Stub(){return null;} export function LimitedTextarea(){return null;}');
    async function load(file) {
      let compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName:file,
        compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022} }).outputText;
      compiled = compiled.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm, '');
      compiled = compiled.replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm, (_match,_quote,specifier) => 'from ' + JSON.stringify(
        specifier.startsWith('@/lib/') ? pathToFileURL(process.cwd()+'/lib/'+specifier.slice('@/lib/'.length)).href
          : specifier.startsWith('./') ? stub : import.meta.resolve(specifier)));
      return (await import(dataUrl(compiled))).default;
    }
    const AT='2026-11-06T15:00:00.000Z';
    const food=(id,patch={})=>validateItem({id,name:'DEMO '+id,category:'other',quantity:1000,unit:'g',location:'冷藏',
      nutrition:{basisAmount:100,basisUnit:'g',kcal:100,protein:10,carbs:10,fat:2,source:'label'},...patch},AT);
    const items=[food('banana',{unit:'条',quantity:4,nutrition:{basisAmount:1,basisUnit:'条',kcal:100,protein:1,carbs:25,fat:0,source:'estimate'}}),food('cocoa')];
    const state=applyMutation({schemaVersion:1,revision:0,updatedAt:AT,items,plans:[],events:[],operationIds:[],preferences:[]},
      {action:'save_meal_plan_draft',operationId:'locale-fixture',expectedRevision:0,plan:{id:'demo-day',date:'2026-11-06',title:'DEMO menu',
        meals:[{id:'breakfast',slot:'breakfast',title:'DEMO breakfast',plannedTime:'09:00',plannedItems:[{id:'banana-line',itemId:'banana',quantity:1},{id:'cocoa-line',itemId:'cocoa',quantity:5}],
          recipeGroups:[{id:'brownie',name:'DEMO brownie',lineIds:['banana-line','cocoa-line'],portion:0.5}]},
          {id:'dinner',slot:'dinner',title:'DEMO dinner',plannedItems:[]}]}},AT);
    const before=JSON.stringify(state), plan=state.plans[0];
    const mutate=async()=>{throw Error('Rendering attempted a write');};
    const Home=await load('app/page.tsx'), Portions=await load('app/recipe-portion-editor.tsx'), Picker=await load('app/meal-inventory-picker.tsx'), Calendar=await load('app/diet-calendar.tsx');
    const render=(Component,props={})=>renderToStaticMarkup(React.createElement(Component,props));
    const nav=render(Home), portions=render(Portions,{plan,items:state.items,revision:state.revision,mealId:'breakfast',groupId:'brownie',busy:false,mutate,onClose(){}});
    const picker=render(Picker,{plan,items:state.items,revision:state.revision,mealId:'breakfast',busy:false,mutate,onClose(){}});
    const calendar=render(Calendar,{days:[],month:'2026-11',selectedDate:'2026-11-06',onMonthChange(){},onSelectDate(){}});
    const date=new Intl.DateTimeFormat(uiLocale(),{year:'numeric',month:'long',timeZone:'UTC'}).format(new Date('2026-11-01T12:00:00Z'));
    console.log(JSON.stringify({language:getUiLanguage(),locale:uiLocale(),nav,portions,picker,calendar,date,
      bag:unitLabel('袋',0.5),cold:storageLabel('冷藏'),frozen:storageLabel('冷冻'),rawUnit:state.items[0].unit,
      originalText:uiText('DEMO user note: 香蕉 1 条'),unchanged:JSON.stringify(state)===before,
      actualCount:plan.meals.reduce((count,meal)=>count+meal.actualEntries.length,0),stock:state.items.map(item=>item.quantity)}));
  `;
  const env = { ...process.env };
  if (language === undefined) delete env.PANTRY_UI_LANGUAGE;
  else env.PANTRY_UI_LANGUAGE = language;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd:root, env, encoding:'utf8', maxBuffer:2_000_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout.trim());
  results.set(key, value);
  return value;
}

test('the private Chinese interface keeps navigation, whole-recipe controls, inventory picker and calendar readable in Chinese', () => {
  const view = probe('zh-CN');
  assert.equal(view.language, 'zh-CN');
  assert.equal(view.locale, 'zh-CN');
  for (const label of ['食物库存', '每日饮食', '体重进度', '训练记录']) assert.ok(view.nav.includes(label), label);
  for (const label of ['半份', '整份', '自定义', '保存']) assert.ok(view.portions.includes(label), label);
  assert.match(view.picker, /从库存添加/);
  assert.match(view.picker, /冷藏/);
  assert.equal(view.bag, '袋');
  assert.equal(view.cold, '冷藏');
  assert.equal(view.frozen, '冷冻');
  assert.match(view.date, /2026年11月/);
  assert.ok(view.calendar.includes(view.date));
});

test('the English public configuration or explicit test override keeps the same controls and dates in English', () => {
  const view = probe('en');
  assert.equal(view.language, 'en');
  assert.equal(view.locale, 'en-CA');
  for (const label of ['Food inventory', 'Daily meals', 'Weight progress', 'Training records']) assert.ok(view.nav.includes(label), label);
  for (const label of ['Half portion', 'Whole portion', 'Custom', 'Save']) assert.ok(view.portions.includes(label), label);
  assert.match(view.picker, /Add from inventory/);
  assert.match(view.picker, /Refrigerated/);
  assert.equal(view.bag, 'bags');
  assert.equal(view.cold, 'Refrigerated');
  assert.equal(view.frozen, 'Frozen');
  assert.match(view.date, /November 2026/);
  assert.ok(view.calendar.includes(view.date));
});

test('the default follows checked-in deployment configuration while either language preserves every inventory and actual fact', () => {
  assert.ok(['zh-CN', 'en'].includes(configuredLanguage));
  assert.equal(probe(undefined).language, configuredLanguage);
  for (const language of ['zh-CN', 'en']) {
    const view = probe(language);
    assert.equal(view.unchanged, true);
    assert.equal(view.actualCount, 0);
    assert.deepEqual(view.stock, [4,1000]);
    assert.equal(view.rawUnit, '条');
    assert.equal(view.originalText, 'DEMO user note: 香蕉 1 条');
  }
});
