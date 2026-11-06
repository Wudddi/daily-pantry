import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
function renderLanguage(language){
  const script=`
    import fs from'node:fs';import{pathToFileURL}from'node:url';import React from'react';import{renderToStaticMarkup}from'react-dom/server';import ts from'typescript';
    import{fixture,plan,meal,mutate,move,recipeMoves,ID,nutrition}from'./tests/fixtures/food-layout.mjs';import{foodLayoutView}from'./lib/food-layout-view.mjs';
    const url=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
    async function load(file){let code=ts.transpileModule(fs.readFileSync('app/'+file+'.tsx','utf8'),{fileName:file+'.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
      code=code.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm,'').replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm,(_m,_q,s)=>'from '+JSON.stringify(s.startsWith('@/lib/')?pathToFileURL(process.cwd()+'/lib/'+s.slice('@/lib/'.length)).href:import.meta.resolve(s)));return import(url(code));}
    const{MealOverviewCard}=await load('meal-overview'),{FoodNutritionList}=await load('meal-nutrition');
    const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};
    let writes=0;
    const render=moves=>{
      let state=fixture();meal(state,'dinner').plannedItems[0].id='square-oats';
      state=mutate(state,'set_food_layout',{planId:ID,moves});const before=JSON.stringify(state),totals=JSON.stringify(nutrition(state));freeze(state);
      const p=plan(state),layout=foodLayoutView(p).meals.find(entry=>entry.mealId==='dinner'),source=meal(state,'dinner');
      const overview=renderToStaticMarkup(React.createElement(MealOverviewCard,{meal:source,layout,planId:p.id,planStatus:p.status,targetId:'demo-layout-detail',triggerId:'demo-layout-trigger',onSelect(){writes++;},onAdjustRecipe(){writes++;}}));
      const props={rows:layout.nutrition.rows,sections:layout.sections,meal:source,planId:p.id},element=FoodNutritionList(props),keys=[];
      function collect(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(collect);return;}if(node.type==='li'&&node.props?.className==='meal-food-row')keys.push(node.key);collect(node.props?.children);}
      collect(element);const detail=renderToStaticMarkup(element);
      return{overview,detail,keys,unchanged:JSON.stringify(state)===before,nutritionUnchanged:JSON.stringify(nutrition(state))===totals};
    };
    console.log(JSON.stringify({full:render(recipeMoves('dinner')),partial:render([move('breakfast','planned','square-oats','dinner')]),writes}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,PANTRY_UI_LANGUAGE:language},encoding:'utf8',maxBuffer:3_000_000});
  assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout.trim());
}
const strip=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const group=html=>html.match(/<li class="meal-(?:overview|food)-recipe"[^>]*>([\s\S]*?)<\/details><\/li>/)?.[1]??'';
const summary=html=>strip(group(html).split('</summary>')[0]);

for(const language of ['zh-CN','en'])test(`arranged full and partial recipes render accurate portions and original source keys in ${language} without writes`,()=>{
  const output=renderLanguage(language),chinese=language==='zh-CN';
  for(const html of [output.full.overview,output.full.detail]){
    assert.match(group(html),/^<details><summary>/);assert.doesNotMatch(group(html),/<details[^>]*\sopen/);
    assert.ok(summary(html).includes(chinese?'半份':'Half portion'));assert.match(summary(html),chinese?/3\s*项食材/:/3\s*ingredients/);
    assert.match(group(html),/DEMO demo-oats/);assert.match(group(html),/40 g/);assert.match(group(html),/90 mL/);
    assert.doesNotMatch(group(html),/DEMO demo-rice/);assert.match(html,/DEMO demo-rice/);
  }
  assert.match(output.full.overview,/355/);
  for(const html of [output.partial.overview,output.partial.detail]){
    assert.ok(summary(html).includes(chinese?'部分配料':'Part of recipe'));
    assert.doesNotMatch(summary(html),/半份|Half portion/);assert.match(summary(html),chinese?/1\s*项食材/:/1\s*ingredients/);
  }
  for(const rendered of [output.full,output.partial]){
    assert.ok(rendered.keys.includes('breakfast:planned:square-oats'));
    assert.ok(rendered.keys.includes('dinner:planned:square-oats'));
    assert.equal(new Set(rendered.keys).size,rendered.keys.length);
    assert.equal(rendered.unchanged,true);assert.equal(rendered.nutritionUnchanged,true);
  }
  assert.equal(output.writes,0);
});
