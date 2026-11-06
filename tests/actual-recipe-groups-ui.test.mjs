import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
function renderLanguage(language){
  const script=`
    import fs from 'node:fs';import{pathToFileURL}from'node:url';import React from'react';import{renderToStaticMarkup}from'react-dom/server';import ts from'typescript';
    import{fixture,plan,breakfast,snack,explicitGroups,nutrition}from'./tests/fixtures/actual-recipe-groups.mjs';import{mealNutritionView}from'./lib/meal-nutrition-view.mjs';
    const state=fixture({withGroups:true}),p=plan(state),m=breakfast(state);
    // Synthetic legacy user labels: clean only the exact actual recipe prefix in display.
    for(const group of explicitGroups())for(const id of group.actualEntryIds){const row=m.actualEntries.find(e=>e.id===id);row.name='\\u534a\\u4efd'+group.name+'\\uff1aDEMO '+row.itemId.slice(5);}
    const before=JSON.stringify(state),totals=JSON.stringify(nutrition(state));let writes=0;
    const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(state);
    const url=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
    async function load(file){let code=ts.transpileModule(fs.readFileSync('app/'+file+'.tsx','utf8'),{fileName:file+'.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
      code=code.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm,'').replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm,(_m,_q,s)=>'from '+JSON.stringify(s.startsWith('@/lib/')?pathToFileURL(process.cwd()+'/lib/'+s.slice('@/lib/'.length)).href:import.meta.resolve(s)));return import(url(code));}
    const{MealOverviewCard}=await load('meal-overview'),{FoodNutritionList}=await load('meal-nutrition');
    const card=meal=>renderToStaticMarkup(React.createElement(MealOverviewCard,{meal,planStatus:p.status,planId:p.id,targetId:'demo-detail',triggerId:'demo-trigger',onSelect(){writes++;},onAdjustRecipe(){writes++;}}));
    const view=mealNutritionView(m,{planId:p.id,planStatus:p.status});
    const detail=renderToStaticMarkup(React.createElement(FoodNutritionList,{rows:view.actualRows,meal:m,planId:p.id}));
    const overview=card(m),planned=card(snack(state));
    console.log(JSON.stringify({overview,detail,planned,writes,unchanged:JSON.stringify(state)===before,nutritionUnchanged:JSON.stringify(nutrition(state))===totals}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,PANTRY_UI_LANGUAGE:language},encoding:'utf8',maxBuffer:3_000_000});
  assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout.trim());
}
const strip=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const blocks=(html,kind)=>[...html.matchAll(new RegExp('<li class="'+kind+'"[^>]*>([\\s\\S]*?)</details></li>','g'))].map(match=>match[1]);

for(const language of ['zh-CN','en'])test(`explicit actual dishes render as two separate closed half recipes in ${language}, retaining planned groups and every underlying fact`,()=>{
  const output=renderLanguage(language),chinese=language==='zh-CN';
  for(const [html,kind] of [[output.overview,'meal-overview-recipe'],[output.detail,'meal-food-recipe']]){
    const groups=blocks(html,kind);assert.equal(groups.length,2);
    assert.match(groups[0],/DEMO cocoa plum squares/);assert.match(groups[1],/DEMO citrus custard/);
    for(const [index,count] of [9,6].entries()){
      assert.match(groups[index],/^<details><summary>/);
      assert.doesNotMatch(groups[index],/<details[^>]*\sopen/);
      const summary=strip(groups[index].split('</summary>')[0]);
      assert.ok(summary.includes(chinese?'半份':'Half portion'));
      assert.match(summary,new RegExp(count+'\\s*'+(chinese?'项食材':'ingredients')));
      assert.doesNotMatch(groups[index],/Half DEMO|半份DEMO/);
    }
    assert.match(strip(groups[0]),/DEMO yogurt[\s\S]*47 g/);
    assert.match(strip(groups[1]),/DEMO yogurt[\s\S]*63 g/);
    assert.doesNotMatch(groups[0],/63 g/);assert.doesNotMatch(groups[1],/47 g/);
    assert.doesNotMatch(groups.join(''),/DEMO apple|DEMO pear/);
    assert.match(html,/DEMO apple/);assert.match(html,/DEMO pear/);
  }
  const planned=blocks(output.planned,'meal-overview-recipe');assert.equal(planned.length,2);
  for(const [index,count]of[9,6].entries()){
    assert.ok(strip(planned[index]).includes(chinese?'半份':'Half portion'));
    assert.match(strip(planned[index]),new RegExp(count+'\\s*'+(chinese?'项食材':'ingredients')));
  }
  assert.doesNotMatch(output.overview,/meal-overview-actions|Adjust portion|调整份量/);
  assert.match(output.planned,/meal-overview-actions/);
  assert.equal(output.writes,0);assert.equal(output.unchanged,true);assert.equal(output.nutritionUnchanged,true);
});
