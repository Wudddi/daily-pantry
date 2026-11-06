import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {applyMutation} from '../lib/inventory.mjs';
import {AT,ID,LATER,copy,fixture,mutate,plan,preserved} from './fixtures/sync-food-plan.mjs';
import {intakePlanFingerprint} from '../lib/intake-draft.mjs';

const dataUrl=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
const hooksUrl=dataUrl(`let active;export const host=()=>({cells:[],cursor:0,changed:false});export function begin(h){active=h;h.cursor=0;h.changed=false;}
export function useState(initial){const h=active,i=h.cursor++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return[h.cells[i],n=>{h.cells[i]=typeof n==='function'?n(h.cells[i]):n;h.changed=true;}];}
export function useRef(initial){return active.cells[active.cursor++]??={current:initial};}export const useMemo=fn=>fn();export function useEffect(){}export function useId(){return 'sync-heading';}`);
const hooks=await import(hooksUrl);
const stub=dataUrl('export default function Stub(){return null;}');
let compiled=ts.transpileModule(await readFile(new URL('../app/day-food-checklist.tsx',import.meta.url),'utf8'),{fileName:'day-food-checklist.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
compiled=compiled.replace(/^import\s+["'][^"']+\.css["'];?\r?\n?/gm,'');
compiled=compiled.replace(/(?<=^import[^\n]*)from\s+(["'])([^"']+)\1/gm,(_m,_q,s)=>'from '+JSON.stringify(s==='react'?hooksUrl:s.startsWith('@/lib/')?new URL('../lib/'+s.slice('@/lib/'.length),import.meta.url).href:s.startsWith('./')?stub:import.meta.resolve(s)));
const {FoodPlanSyncDialog}=await import(dataUrl(compiled));
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
function find(node,predicate){if(!node||typeof node!=='object')return null;if(!Array.isArray(node)&&predicate(node))return node;for(const child of Array.isArray(node)?node:[node.props?.children]){const result=find(child,predicate);if(result)return result;}return null;}
function mount(initial=fixture(),mutator){
  const host=hooks.host(),calls=[];let state=initial,closed=0,reviewed=0,tree;
  const props={busy:false,onClose(){closed++;},onReviewDraft(){reviewed++;},mutate:async(action,payload)=>{
    calls.push({action,payload:copy(payload)});
    if(mutator)return mutator({action,payload,get state(){return state;},set state(next){state=next;}});
    state=applyMutation(state,{action,...payload},LATER);return true;
  }};
  function render(){hooks.begin(host);tree=FoodPlanSyncDialog({...props,plan:plan(state),items:state.items,revision:state.revision});return tree;}
  render();
  return {calls,render,get state(){return state;},get closed(){return closed;},get reviewed(){return reviewed;},get tree(){return tree;},
    set state(next){state=next;render();},button(label){return find(tree,n=>n.type==='button'&&text(n).trim()===label);},
    async click(label){const button=this.button(label);assert.ok(button,label);assert.equal(!!button.props.disabled,false,label);button.props.onClick();await new Promise(resolve=>setImmediate(resolve));render();}};
}

test('opening sync is only a preview and explicit apply sends one fingerprinted plan-only mutation',async()=>{
  const ui=mount(),before=copy(ui.state);
  assert.equal(ui.calls.length,0);assert.match(text(ui.tree),/Only the plan is updated/);
  await ui.click('Apply sync');
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].action,'sync_food_plan');
  assert.equal(ui.calls[0].payload.planId,ID);assert.equal(ui.calls[0].payload.expectedRevision,before.revision);
  assert.equal(typeof ui.calls[0].payload.expectedFingerprint,'string');assert.ok(ui.calls[0].payload.expectedFingerprint.length>0);
  assert.equal(ui.closed,1);assert.deepEqual(preserved(ui.state),preserved(before));
});

test('an unconfirmed successful write retries the identical operation and cannot sync or deduct twice',async()=>{
  let count=0;
  const ui=mount(fixture(),context=>{context.state=applyMutation(context.state,{action:context.action,...context.payload},LATER);return ++count>1;});
  const before=copy(ui.state);
  await ui.click('Apply sync');const saved=copy(ui.state);assert.equal(ui.closed,0);
  await ui.click('Retry same action');
  assert.equal(ui.calls.length,2);assert.deepEqual(ui.calls[1],ui.calls[0]);assert.equal(ui.closed,1);
  assert.deepEqual(ui.state,saved);assert.deepEqual(preserved(ui.state),preserved(before));
});

test('a changed revision or fingerprint disables an open preview without writing against the newer menu',()=>{
  const ui=mount();
  ui.state=mutate(ui.state,'patch_meal_plan',{planId:ID,mode:'draft',mealPatches:[{id:'lunch',itemPatches:[{id:'l-cereal',quantity:81}]}]});
  assert.equal(ui.button('Apply sync').props.disabled,true);assert.match(text(ui.tree),/Close and reopen/);
  assert.equal(ui.calls.length,0);
});

test('a pending draft is retained and routes to review while Apply sync remains disabled',async()=>{
  let state=fixture();state=mutate(state,'save_intake_draft',{planId:ID,expectedDraftVersion:null,draft:{id:'demo-ui-pending',baseFingerprint:intakePlanFingerprint(plan(state),state.items),consumed:[],transfers:[],completedMealIds:[]}});
  const ui=mount(state),before=copy(state);
  assert.equal(ui.button('Apply sync').props.disabled,true);
  assert.match(text(ui.tree),/will not be cleared automatically/);
  await ui.click('Review intake draft');assert.equal(ui.reviewed,1);
  assert.equal(ui.calls.length,0);assert.deepEqual(ui.state,before);
});

test('the sync preview explains its plan-only effect in both private Chinese and public English',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const code=`import fs from 'node:fs';import {pathToFileURL} from 'node:url';import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import ts from'typescript';
    import{fixture,plan}from'./tests/fixtures/sync-food-plan.mjs';const state=fixture(),before=JSON.stringify(state);
    const url=text=>'data:text/javascript;base64,'+Buffer.from(text).toString('base64'),stub=url('export default function Stub(){return null;}');
    let code=ts.transpileModule(fs.readFileSync('app/day-food-checklist.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    code=code.replace(/^import\\s+["'][^"']+\\.css["'];?\\r?\\n?/gm,'').replace(/(?<=^import[^\\n]*)from\\s+(["'])([^"']+)\\1/gm,(_m,_q,s)=>'from '+JSON.stringify(s.startsWith('@/lib/')?pathToFileURL(process.cwd()+'/lib/'+s.slice('@/lib/'.length)).href:s.startsWith('./')?stub:import.meta.resolve(s)));
    const{FoodPlanSyncDialog}=await import(url(code));let writes=0;const html=renderToStaticMarkup(React.createElement(FoodPlanSyncDialog,{plan:plan(state),items:state.items,revision:state.revision,busy:false,mutate:async()=>{writes++;throw Error('Unexpected write');},onClose(){},onReviewDraft(){}}));console.log(JSON.stringify({html,writes,unchanged:JSON.stringify(state)===before}));`;
  for(const language of ['zh-CN','en']){
    const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,env:{...process.env,PANTRY_UI_LANGUAGE:language},encoding:'utf8',maxBuffer:1_000_000});
    assert.equal(result.status,0,result.stderr||result.stdout);const value=JSON.parse(result.stdout.trim());
    assert.ok(value.html.includes(language==='zh-CN'?'确认同步计划':'Apply sync'));
    assert.ok(value.html.includes(language==='zh-CN'?'只更新计划，已报实际、库存和补给记录均保持原样':'Only the plan is updated; reported intake, inventory and supplement records stay unchanged'));
    assert.equal(value.writes,0);assert.equal(value.unchanged,true);
  }
});
