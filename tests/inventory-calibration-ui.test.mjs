import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { previewFoodBalanceReconciliation } from '../lib/food-balance-reconciliation.mjs';

let source=await readFile(new URL('../app/page.tsx',import.meta.url),'utf8');
source=source.replace('import HealthRecords, { LimitedTextarea } from "./health-records";','import React from "react"; const HealthRecords=()=>null; const LimitedTextarea=(props:any)=>React.createElement("textarea",props);');
source=source.replace('import DietRecords from "./diet-records";','const DietRecords=()=>null;').replace(/import\s+["'][^"']+\.css["'];?/g,'');
source+='\nexport {FoodRow,CalibrateModal,foodBalanceCalibrationPayload};';
function compile(react=import.meta.resolve('react')){
 const output=ts.transpileModule(source,{fileName:'inventory-calibration.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return 'data:text/javascript;base64,'+Buffer.from(output.replace(/from\s+(["'])([^"']+)\1/g,(_m,_q,specifier)=>'from '+JSON.stringify(specifier==='react'?react:specifier.startsWith('@/')?new URL('../'+specifier.slice(2),import.meta.url).href:import.meta.resolve(specifier)))).toString('base64');
}
const {FoodRow,CalibrateModal,foodBalanceCalibrationPayload}=await import(compile());
const AT='2026-10-20T17:00:00.000Z',LATER='2026-10-21T17:00:00.000Z';
// Fictional product and arithmetic: 800g initial stock minus 70g intake leaves 730g.
const food=patch=>validateItem({id:'demo-bread',name:'Demo Bakery 示例面包',category:'bread',quantity:null,unit:'g',nutrition:{basisAmount:100,basisUnit:'g',kcal:240,protein:8,carbs:48,fat:1,source:'estimate'},...patch},AT);
function fixture(){
 let state={schemaVersion:1,revision:0,updatedAt:AT,items:[food(),food({id:'broccoli',name:'西兰花',quantity:500})],plans:[],events:[],operationIds:[],preferences:[]};
 state=applyMutation(state,{action:'save_meal_plan_draft',operationId:'calibration-fixture-menu',expectedRevision:state.revision,plan:{id:'calibration-day',date:'2026-10-20',title:'本机余量校准',meals:[{id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'bread',itemId:'demo-bread',quantity:70,unit:'g'}]}]}},AT);
 state=applyMutation(state,{action:'record_meal_intake',operationId:'calibration-fixture-actual',expectedRevision:state.revision,planId:'calibration-day',mealId:'lunch',mode:'complete',entries:[{id:'bread-actual',itemId:'demo-bread',quantity:70,unit:'g',sourceText:'合成示例报告：示例面包70g已吃'}]},AT);
 state=applyMutation(state,{action:'set_quantity',operationId:'calibration-fixture-book',expectedRevision:state.revision,id:'demo-bread',quantity:800},LATER);
 // Keep an unrelated unresolved ledger issue in this same old plan. Calibrating
 // the bread cannot mark the entire plan settled or erase its original report.
 state.plans[0].inventoryAccounting='pending_reconciliation';
 state.plans[0].accountingIssues=[{code:'BASELINE_REQUIRES_REVIEW',itemId:'broccoli',message:'西兰花旧记录待单独核对'}];
 return state;
}
const modalProps=state=>({item:state.items[0],preview:previewFoodBalanceReconciliation(state,'demo-bread',LATER),saving:false,blocked:false,error:'',onClose(){},async onSave(){}});
test('food row offers a separate balance calibration operation; supplements do not',()=>{
 const props={item:food({quantity:800}),disabled:false,onEdit(){},onConsume(){},onPriority(){},onDeplete(){},onCalibrate(){}};
 assert.match(renderToStaticMarkup(React.createElement(FoodRow,props)),/校准余量/);
 assert.doesNotMatch(renderToStaticMarkup(React.createElement(FoodRow,{...props,item:food({category:'supplement'})})),/校准余量/);
});
test('calibration asks for current total, previews prior intake and automatically covers every related plan',()=>{
 const state=fixture(),before=structuredClone(state),props=modalProps(state),html=renderToStaticMarkup(React.createElement(CalibrateModal,props));
 assert.equal(props.preview.recordedQuantity,70);
 assert.match(html,/aria-label="校准后的实际总余量"[^>]*value=""/);
 assert.match(html,/此前已记录摄入/);assert.match(html,/70 g/);assert.match(html,/不会再扣一次/);
 assert.match(html,/自动核对 1 条关联菜单/);assert.match(html,/maxLength="1000"/i);
 assert.doesNotMatch(html,/<select|type="checkbox"/);assert.deepEqual(state,before);
});

const hooksUrl='data:text/javascript;base64,'+Buffer.from(`
export { default } from ${JSON.stringify(import.meta.resolve('react'))};
let active;export const host=()=>({cells:[],cursor:0});export function begin(h){active=h;h.cursor=0;}
export function useState(initial){const h=active,i=h.cursor++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return[h.cells[i],next=>h.cells[i]=typeof next==='function'?next(h.cells[i]):next];}
export function useRef(initial){const h=active,i=h.cursor++;return h.cells[i]??={current:initial};}
export function useMemo(fn){active.cursor++;return fn();}export function useEffect(){active.cursor++;}
`).toString('base64');
const hooks=await import(hooksUrl),Interactive=await import(compile(hooksUrl));
function find(node,predicate){if(!node||typeof node!=='object')return null;if(!Array.isArray(node)&&predicate(node))return node;for(const child of Array.isArray(node)?node:[node.props?.children]){const result=find(child,predicate);if(result)return result;}return null;}
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
function mount(props){const host=hooks.host();let tree;const render=patch=>{Object.assign(props,patch);hooks.begin(host);return tree=Interactive.CalibrateModal(props);};render();return{render,get tree(){return tree;},input(label,value){const input=find(tree,node=>node.type==='input'&&node.props['aria-label']===label);assert(input,label);input.props.onChange({target:{value}});render();},submit(){find(tree,node=>node.type==='form').props.onSubmit({preventDefault(){}});}};}
test('saving a typed 730g balance with a recorded 70g report never consumes 70g again or drops pending old evidence',async()=>{
 let state=fixture();const actualBefore=structuredClone(state.plans[0].meals),calls=[];
 const ui=mount({...modalProps(state),async onSave(quantity,note){const payload=foodBalanceCalibrationPayload(state,'demo-bread',quantity,note);calls.push(payload);state=applyMutation(state,{action:'reconcile_food_inventory',operationId:'calibration-ui-save',expectedRevision:state.revision,...payload},LATER);}});
 ui.input('校准后的实际总余量','730');ui.input('余量校准来源说明','合成示例核对：原800g减去已吃70g，现存730g');ui.submit();
 assert.equal(calls.length,1);assert.deepEqual(calls[0].planIds,['calibration-day']);assert.equal(calls[0].confirmed,true);
 assert.equal(state.items[0].quantity,730,'must not become 660 from a second debit');
 assert.deepEqual(state.plans[0].meals,actualBefore,'original amount, report source and IDs are retained');
 assert.equal(state.plans[0].inventoryAccounting,'pending_reconciliation');
 assert.deepEqual(state.plans[0].accountingIssues,[{code:'BASELINE_REQUIRES_REVIEW',itemId:'broccoli',message:'西兰花旧记录待单独核对'}]);
 assert.equal(state.inventoryReconciliationHistory.at(-1).sourceText,calls[0].sourceText);
});
test('stale or saving modal cannot submit; unknown prior quantities show exact preview errors and never write',()=>{
 const state=fixture();let saves=0;const ui=mount({...modalProps(state),onSave:async()=>{saves++;}});ui.input('校准后的实际总余量','730');
 ui.render({blocked:true});ui.submit();assert.equal(saves,0);
 ui.render({blocked:false,saving:true});ui.submit();assert.equal(saves,0);
 state.plans[0].meals[0].actualEntries[0].quantity=null;
 const preview=previewFoodBalanceReconciliation(state,'demo-bread',LATER),props={...modalProps(state),preview};
 const html=renderToStaticMarkup(React.createElement(CalibrateModal,props));
 assert.equal(preview.canReconcile,false);assert.match(html,/已有实际用量未知/);assert.match(html,/暂不能校准，未修改库存/);
 assert.throws(()=>foodBalanceCalibrationPayload(state,'demo-bread',730,'用户核对余量'),/已有实际用量未知/);
 const bad=mount({...props,onSave:async()=>{saves++;}});bad.input('校准后的实际总余量','730');bad.submit();assert.equal(saves,0);
});
test('zero current balance is allowed but blank, negative, nonfinite and missing sources cannot submit',()=>{
 const state=fixture();let saves=0;const ui=mount({...modalProps(state),onSave:async()=>{saves++;}});
 ui.submit();ui.input('校准后的实际总余量','-1');ui.submit();ui.input('校准后的实际总余量','Infinity');ui.submit();
 ui.input('校准后的实际总余量','0');ui.input('余量校准来源说明','');ui.submit();assert.equal(saves,0);
 ui.input('余量校准来源说明','已全部用完，包含此前已记录摄入');ui.submit();assert.equal(saves,1);
 assert.equal(foodBalanceCalibrationPayload(state,'demo-bread',0,'确认已用完').quantity,0);
 assert.throws(()=>foodBalanceCalibrationPayload(state,'demo-bread',-1,'确认余量'),/不小于 0/);
 assert.throws(()=>foodBalanceCalibrationPayload(state,'demo-bread',730,'x'.repeat(1001)),/1–1000/);
});
test('the Home save path uses reconciliation and refuses a stale open modal before dispatch',async()=>{
 const originalFetch=globalThis.fetch;let state=fixture();const host=hooks.host(),calls=[];
 host.cells[0]=state;host.cells[1]=false;
 const render=()=>{hooks.begin(host);return Interactive.default();};
 globalThis.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);calls.push(payload);state=applyMutation(state,payload,LATER);return{ok:true,status:200,json:async()=>({state})};};
 try{
  let tree=render();const stateRef=host.cells.filter(cell=>cell&&typeof cell==='object'&&'current' in cell&&cell.current===null).at(-1);assert(stateRef);stateRef.current=state;
  let row=find(tree,node=>node.type===Interactive.FoodRow&&node.props.item.id==='demo-bread');assert(row);row.props.onCalibrate();tree=render();
  const modal=find(tree,node=>node.type===Interactive.CalibrateModal);assert(modal);await modal.props.onSave(730,'明确核对：现存730g，已包含旧摄入');render();
  assert.equal(calls.length,1);assert.equal(calls[0].action,'reconcile_food_inventory');assert.equal(calls[0].quantity,730);assert.deepEqual(calls[0].planIds,['calibration-day']);
  tree=render();row=find(tree,node=>node.type===Interactive.FoodRow&&node.props.item.id==='demo-bread');row.props.onCalibrate();tree=render();
  const stale=find(tree,node=>node.type===Interactive.CalibrateModal);state={...state,revision:state.revision+1};host.cells[0]=state;stateRef.current=state;render();
  await stale.props.onSave(700,'旧弹窗');assert.equal(calls.length,1,'stale calibration cannot dispatch after another record update');
 }finally{globalThis.fetch=originalFetch;}
});
