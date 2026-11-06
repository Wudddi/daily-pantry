import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
function renderLanguage(language){
  const code=`
    import fs from 'node:fs';
    import {pathToFileURL} from 'node:url';
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import ts from 'typescript';
    import {basisFixture,freezeDeep} from './tests/fixtures/nutrition-basis.mjs';
    import {applyPersonalFoodCheck} from './lib/personal-food-checklist.mjs';
    const dataUrl=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
    const stub=dataUrl('export default function Stub(){return null;}');
    let code=ts.transpileModule(fs.readFileSync('app/day-food-checklist.tsx','utf8'),{fileName:'day-food-checklist.tsx',
      compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    code=code.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm,'');
    code=code.replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm,(_m,_q,s)=>'from '+JSON.stringify(
      s.startsWith('@/lib/')?pathToFileURL(process.cwd()+'/lib/'+s.slice('@/lib/'.length)).href:s.startsWith('./')?stub:import.meta.resolve(s)));
    const {default:Checklist}=await import(dataUrl(code));
    const state=freezeDeep(basisFixture()),before=JSON.stringify(state),plan=state.plans[0];
    let writes=0;
    const render=p=>renderToStaticMarkup(React.createElement(Checklist,{plan:p,items:state.items,revision:0,busy:false,
      mutate:async()=>{writes++;throw Error('Unexpected write');},refresh:async()=>{},onOpenAdvanced(){}}));
    const checklist=render(plan);
    const marked=applyPersonalFoodCheck(state,{planId:plan.id,mealId:'breakfast',wholeMeal:true,checked:true},'2026-01-15T13:00:00.000Z');
    const markedChecklist=render(marked.plans[0]);
    console.log(JSON.stringify({checklist,markedChecklist,writes,unchanged:JSON.stringify(state)===before,
      stockUnchanged:JSON.stringify(marked.items)===JSON.stringify(state.items),
      actualUnchanged:JSON.stringify(marked.plans[0].meals)===JSON.stringify(plan.meals),
      supplementsUnchanged:JSON.stringify(marked.plans[0].supplementDoses)===JSON.stringify(plan.supplementDoses)}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,env:{...process.env,PANTRY_UI_LANGUAGE:language},encoding:'utf8',maxBuffer:2_000_000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  return JSON.parse(result.stdout.trim());
}
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const progress=html=>text(html.match(/<div class="food-progress-strip"[^>]*>([\s\S]*?)<\/div>/)?.[1]??'');

for(const language of ['zh-CN','en']){
  test(`the ${language} checklist omits the removed nutrition explanation while retaining planned counts and plan sync without writes`,()=>{
    const output=renderLanguage(language),chinese=language==='zh-CN';
    for(const html of [output.checklist,output.markedChecklist]){
      assert.doesNotMatch(html,/food-nutrition-basis|为什么与全天营养不同|Why daily nutrition differs/);
      assert.ok(html.includes(chinese?'计划食物清单 · 不含补给':'Planned food checklist · excludes supplements'));
      assert.match(html,/food-plan-sync-trigger/);
      assert.ok(html.includes(chinese?'一键同步当日计划':'Sync this day'));
      assert.match(html,/food-meal-planned-label/);
    }
    const original=progress(output.checklist),marked=progress(output.markedChecklist);
    assert.match(original,chinese?/已勾选计划：\s*(?:≈\s*)?0\s*千卡/:/Checked plan:\s*(?:≈\s*)?0\s*kcal/);
    assert.match(original,chinese?/未勾选计划：\s*(?:≈\s*)?300\s*千卡/:/Unchecked plan:\s*(?:≈\s*)?300\s*kcal/);
    assert.match(marked,chinese?/已勾选计划：\s*(?:≈\s*)?100\s*千卡/:/Checked plan:\s*(?:≈\s*)?100\s*kcal/);
    assert.match(marked,chinese?/未勾选计划：\s*(?:≈\s*)?200\s*千卡/:/Unchecked plan:\s*(?:≈\s*)?200\s*kcal/);
    assert.equal(output.writes,0);
    assert.equal(output.unchanged,true);
    assert.equal(output.stockUnchanged,true);
    assert.equal(output.actualUnchanged,true);
    assert.equal(output.supplementsUnchanged,true);
  });
}
