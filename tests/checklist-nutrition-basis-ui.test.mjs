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
    import {basisFixture,copy,freezeDeep} from './tests/fixtures/nutrition-basis.mjs';
    import {resolveDietDays} from './lib/diet-day-summary.mjs';
    import {applyPersonalFoodCheck} from './lib/personal-food-checklist.mjs';
    const dataUrl=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
    const stub=dataUrl('export default function Stub(){return null;}');
    let code=ts.transpileModule(fs.readFileSync('app/day-food-checklist.tsx','utf8'),{fileName:'day-food-checklist.tsx',
      compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    code=code.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm,'');
    code=code.replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm,(_m,_q,s)=>'from '+JSON.stringify(
      s.startsWith('@/lib/')?pathToFileURL(process.cwd()+'/lib/'+s.slice('@/lib/'.length)).href:s.startsWith('./')?stub:import.meta.resolve(s)));
    const {default:Checklist,ChecklistNutritionBasis:Basis}=await import(dataUrl(code));
    const state=freezeDeep(basisFixture()),before=JSON.stringify(state),plan=state.plans[0],header=resolveDietDays([plan],[])[0].totals;
    const render=(p=plan,h=header)=>renderToStaticMarkup(React.createElement(Basis,{plan:p,items:state.items,headerTotals:h}));
    let writes=0;
    const checklist=renderToStaticMarkup(React.createElement(Checklist,{plan,items:state.items,revision:0,busy:false,headerTotals:header,
      mutate:async()=>{writes++;throw Error('Unexpected write');},refresh:async()=>{},onOpenAdvanced(){}}));
    const marked=applyPersonalFoodCheck(state,{planId:plan.id,mealId:'breakfast',wholeMeal:true,checked:true},'2026-01-15T13:00:00.000Z');
    const unknown=copy(plan);unknown.meals[0].actualEntries[0].quantity=null;
    const partialHeader=resolveDietDays([unknown],[])[0].totals;
    const historyHeader=copy(header);historyHeader[0].source='matched_history_total';
    const mismatch=copy(header);mismatch[0].value+=1;
    const clean=copy(plan);clean.meals[0].actualEntries[0].quantity=100;clean.supplementDoses=[];
    const cleanHeader=resolveDietDays([clean],[])[0].totals;
    const cleanHistory=copy(cleanHeader);cleanHistory[0].source='matched_history_total';
    const cleanMismatch=copy(cleanHeader);cleanMismatch[0].value+=1;
    const supplementOnly=copy(clean);supplementOnly.supplementDoses=copy(plan.supplementDoses);
    const macroOnly=copy(clean);macroOnly.meals[0].actualEntries[0].nutritionSnapshot.nutrition.protein=0.2;
    console.log(JSON.stringify({basis:render(),checkedBasis:render(marked.plans[0]),checklist,unknown:render(unknown,partialHeader),
      historical:render(plan,historyHeader),mismatch:render(plan,mismatch),clean:render(clean,cleanHeader),
      cleanHistory:render(clean,cleanHistory),cleanMismatch:render(clean,cleanMismatch),
      supplementOnly:render(supplementOnly,resolveDietDays([supplementOnly],[])[0].totals),
      macroOnly:render(macroOnly,resolveDietDays([macroOnly],[])[0].totals),writes,unchanged:JSON.stringify(state)===before}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,env:{...process.env,PANTRY_UI_LANGUAGE:language},encoding:'utf8',maxBuffer:2_000_000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  return JSON.parse(result.stdout.trim());
}
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

for(const language of ['zh-CN','en']){
  test(`the ${language} checklist labels planned food separately and explains the actual-food and supplement difference without adding an intake action`,()=>{
    const output=renderLanguage(language),chinese=language==='zh-CN';
    const labels=chinese
      ? ['为什么与全天营养不同','计划食物','实际报告带来的调整','补给已知热量','当前全天汇总']
      : ['Why daily nutrition differs','Planned food','Reported food adjustment','Known supplement calories','Current daily summary'];
    for(const label of labels)assert.ok(output.basis.includes(label),label);
    assert.ok(output.checklist.includes(chinese?'计划食物清单 · 不含补给':'Planned food checklist · excludes supplements'));
    assert.ok(output.checklist.includes(chinese?'已勾选计划：':'Checked plan:'));
    assert.ok(output.checklist.includes(chinese?'未勾选计划：':'Unchecked plan:'));
    for(const value of ['300','+50','10','360'])assert.ok(text(output.basis).includes(value),value);
    assert.doesNotMatch(output.basis,/<input|<button|<form/);
    assert.equal(output.checkedBasis,output.basis);
    assert.ok(output.unknown.includes(chinese?'未知差额不按0处理':'unknown differences are not zero'));
    assert.ok(output.historical.includes(chinese?'这些数字不能直接当作完整等式':'these figures are not a complete equation'));
    assert.ok(output.mismatch.includes(chinese?'与本对照存在差异':'differs from this comparison'));
    assert.equal(output.clean,'','An entirely equal complete food-only baseline needs no comparison panel');
    for(const field of ['cleanHistory','cleanMismatch','supplementOnly','macroOnly'])assert.ok(output[field].includes(labels[0]),field);
    assert.equal(output.writes,0);
    assert.equal(output.unchanged,true);
  });
}
