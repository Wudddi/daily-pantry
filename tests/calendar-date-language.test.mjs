import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalLocalDate } from '../lib/calendar-date.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['2026-11-06T04:59:59.000Z', '2026-11-05'],
  ['2026-11-06T05:00:00.000Z', '2026-11-06'],
  ['2026-07-01T03:59:59.000Z', '2026-06-30'],
  ['2026-07-01T04:00:00.000Z', '2026-07-01'],
  ['2024-03-01T04:30:00.000Z', '2024-02-29'],
  ['2027-01-01T04:30:00.000Z', '2026-12-31'],
];

test('canonical machine dates respect Toronto midnight, daylight-saving offset, leap days and year boundaries without display formatting', () => {
  for (const [instant, expected] of cases) {
    assert.equal(canonicalLocalDate(instant), expected);
    assert.equal(canonicalLocalDate(new Date(instant)), expected);
    assert.equal(canonicalLocalDate(Date.parse(instant)), expected);
  }
  assert.equal(canonicalLocalDate('2026-11-05T16:00:00.000Z', 'Asia/Shanghai'), '2026-11-06');
  assert.throws(() => canonicalLocalDate('not-a-timestamp'), RangeError);
});

function initialPages(language) {
  const code = `
    import fs from 'node:fs';
    import {pathToFileURL} from 'node:url';
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import ts from 'typescript';
    const NativeDate=Date, frozen='2026-11-06T04:30:00.000Z';
    globalThis.Date=class extends NativeDate {
      constructor(...args){super(...(args.length?args:[frozen]));}
      static now(){return NativeDate.parse(frozen);}
    };
    const dataUrl=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
    const stub=dataUrl('export default function Stub(){return null;} export function FoodNutritionList(){return null;} export function LimitedTextarea(){return null;}');
    const reactUrl=import.meta.resolve('react');
    const captureUrl=dataUrl('import React from '+JSON.stringify(reactUrl)+'; export const states=[]; export const useMemo=React.useMemo; export function useState(initial){const result=React.useState(initial); states.push(result[0]); return result;}');
    const captured=await import(captureUrl);
    async function load(file,extra='',capture=false){
      let code=ts.transpileModule(fs.readFileSync(file,'utf8')+'\\n'+extra,{fileName:file,
        compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
      code=code.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm,'');
      code=code.replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm,(_m,_q,s)=>'from '+JSON.stringify(
        s==='react'&&capture?captureUrl:s.startsWith('@/lib/')?pathToFileURL(process.cwd()+'/lib/'+s.slice('@/lib/'.length)).href
        :s.startsWith('./')?stub:import.meta.resolve(s)));
      return import(dataUrl(code));
    }
    const state={revision:0,items:[],plans:[],dietHistory:[],preferences:[],events:[],operationIds:[]},before=JSON.stringify(state);
    let writes=0;
    const Diet=(await load('app/diet-records.tsx','',true)).default;
    const html=renderToStaticMarkup(React.createElement(Diet,{state,loading:false,saving:false,error:'',getLatest:()=>state,
      refresh:async()=>{},mutate:async()=>{writes++;throw Error('Unexpected write');},dispatchCheck:async()=>{writes++;throw Error('Unexpected check');}}));
    const health=await load('app/health-records.tsx','export {localToday,measurementDraft,sessionDraft};');
    const meals=await load('app/diet-calendar.tsx','export {torontoToday};');
    const training=await load('app/training-calendar.tsx','export {torontoToday};');
    const measurement=health.measurementDraft(),session=health.sessionDraft();
    console.log(JSON.stringify({html,date:captured.states[0],month:captured.states[1],healthToday:health.localToday(),
      measurementDate:measurement.date,sessionDate:session.date,createdAt:measurement.createdAt,
      mealToday:meals.torontoToday(),trainingToday:training.torontoToday(),writes,unchanged:JSON.stringify(state)===before}));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',code], { cwd:root,
    env:{...process.env,PANTRY_UI_LANGUAGE:language},encoding:'utf8',maxBuffer:2_000_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

for (const language of ['zh-CN','en']) {
  test(`initial Daily Meals, health drafts and calendar current dates remain canonical in ${language}`, () => {
    const view = initialPages(language);
    assert.equal(view.date, '2026-11-05');
    assert.equal(view.month, '2026-11');
    assert.match(view.html, /type="date" value="2026-11-05"/);
    assert.ok(view.html.includes(language === 'zh-CN' ? '每日饮食' : 'Daily meals'));
    for (const field of ['healthToday','measurementDate','sessionDate','mealToday','trainingToday'])
      assert.equal(view[field], '2026-11-05', field);
    assert.equal(view.createdAt, '2026-11-06T04:30:00.000Z');
    assert.equal(view.writes, 0);
    assert.equal(view.unchanged, true);
  });
}
