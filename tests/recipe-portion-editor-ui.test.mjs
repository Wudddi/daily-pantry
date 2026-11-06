import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { applyMutation,validateItem } from '../lib/inventory.mjs';
import { intakeDraftView } from '../lib/intake-draft.mjs';

const source=await readFile(new URL('../app/recipe-portion-editor.tsx',import.meta.url),'utf8');
function compile(react=import.meta.resolve('react')){
 const output=ts.transpileModule(source,{fileName:'recipe-portion-editor.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/import\s+["']\.\/recipe-portion-editor\.css["'];?/g,'');
 return 'data:text/javascript;base64,'+Buffer.from(output.replace(/(?<=^import[^;\n]*\s)from\s+(["'])([^"']+)\1/gm,(_m,_q,specifier)=>'from '+JSON.stringify(specifier==='react'?react:specifier.startsWith('@/')?new URL('../'+specifier.slice(2),import.meta.url).href:import.meta.resolve(specifier)))).toString('base64');
}
const Component=(await import(compile())).default,AT='2026-11-06T17:00:00.000Z';
function fixture(){
 const foods=[['yogurt',"Greek yogurt"],['cocoa',"Cocoa powder"],['egg',"Eggs"],['rice',"Rice"]].map(([id,name])=>validateItem({id,name,category:'protein',quantity:1000,unit:'g',nutrition:{basisAmount:100,basisUnit:'g',kcal:100,protein:10,carbs:12,fat:2,source:'label'}},AT));
 return applyMutation({schemaVersion:1,revision:0,updatedAt:AT,items:foods,plans:[],events:[],operationIds:[],preferences:[],dailyMenuSettlementPolicy:{version:1,enabled:false,timeZone:'America/Toronto',startsOn:'2026-10-26',updatedAt:AT,sourceText:'本机明确关闭自动结算'}},
  {action:'save_meal_plan_draft',operationId:'recipe-portion-fixture',expectedRevision:0,plan:{id:'recipe-portion-day',date:'2026-11-06',title:'本机份量测试',meals:[
   {id:'breakfast',slot:'breakfast',title:"Basque cheesecake",plannedItems:[{id:'yogurt-cake',itemId:'yogurt',quantity:150,unit:'g'},{id:'cocoa-cake',itemId:'cocoa',quantity:8,unit:'g'},{id:'egg-cake',itemId:'egg',quantity:50,unit:'g'},{id:'yogurt-side',itemId:'yogurt',quantity:30,unit:'g'}],recipeGroups:[{id:'basque',name:'巴斯克（旧名字含半份）',lineIds:['yogurt-cake','cocoa-cake','egg-cake']}]},
   {id:'lunch',slot:'lunch',title:"Lunch",plannedItems:[{id:'rice-lunch',itemId:'rice',quantity:100,unit:'g'}]},
   {id:'dinner',slot:'dinner',title:"Dinner",plannedItems:[]}
  ]}},AT);
}
const props=state=>({plan:state.plans[0],items:state.items,revision:state.revision,mealId:'breakfast',groupId:'basque',busy:false,async mutate(){return true;},onClose(){}});
test('the whole-dish editor defaults to compact preset controls, explains the legacy serving basis and does not infer half from its name',()=>{
 const state=fixture(),before=structuredClone(state),html=renderToStaticMarkup(React.createElement(Component,props(state)));
 assert.match(html,/Current: 1 portions/);assert.match(html,/Half portion/);assert.match(html,/Whole portion/);assert.match(html,/Custom/);assert.match(html,/One portion uses this saved ingredient group as its basis/);
 assert.doesNotMatch(html,/<input|Consumed so far|Confirm intake/);assert.match(html,/aria-label="Whole recipe adjustment method"/);assert.match(html,/role="tabpanel"[^>]*hidden=""/);assert.deepEqual(state,before);
});

const hooksUrl='data:text/javascript;base64,'+Buffer.from(`
let active;export const host=()=>({cells:[],cursor:0,effects:[],changed:false});export function begin(h){active=h;h.cursor=0;h.effects=[];h.changed=false;}
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
export function useState(initial){const h=active,i=h.cursor++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return[h.cells[i],next=>{const value=typeof next==='function'?next(h.cells[i]):next;if(!Object.is(value,h.cells[i])){h.cells[i]=value;h.changed=true;}}];}
export function useRef(initial){const h=active,i=h.cursor++;return h.cells[i]??={current:initial};}
export function useMemo(fn,deps){const h=active,i=h.cursor++;if(!h.cells[i]||!same(h.cells[i].deps,deps))h.cells[i]={value:fn(),deps};return h.cells[i].value;}
export function useEffect(fn,deps){const h=active,i=h.cursor++,old=h.cells[i];if(!old||!same(old.deps,deps))h.effects.push(()=>{old?.cleanup?.();h.cells[i]={deps,cleanup:fn()};});}
export function useId(){return ':portion-'+active.cursor+++':';}export function effects(h){h.effects.forEach(effect=>effect());}
`).toString('base64');
const hooks=await import(hooksUrl),Interactive=(await import(compile(hooksUrl))).default;
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
function find(node,predicate){if(!node||typeof node!=='object')return null;if(!Array.isArray(node)&&predicate(node))return node;for(const child of Array.isArray(node)?node:[node.props?.children]){const result=find(child,predicate);if(result)return result;}return null;}
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function mount(initial=fixture(),mutator){
 const host=hooks.host(),calls=[];let state=initial,tree,closed=0;const p=props(state);
 function render(patch={}){Object.assign(p,{plan:state.plans[0],items:state.items,revision:state.revision},patch);for(let count=0;count<20;count++){hooks.begin(host);tree=Interactive(p);hooks.effects(host);if(!host.changed)return tree;}throw Error('unstable hooks');}
 p.mutate=async(action,payload)=>{calls.push({action,payload:structuredClone(payload)});if(mutator)return mutator({action,payload,get state(){return state;},set state(value){state=value;}});state=applyMutation(state,{action,...payload},AT);render();return true;};p.onClose=()=>{closed++;};
 render();return{calls,render,get tree(){return tree;},get state(){return state;},get closed(){return closed;},find:predicate=>find(tree,predicate),
  async click(label){const button=find(tree,node=>node.type==='button'&&(node.props['aria-label']===label||text(node).trim()===label));assert(button,'missing '+label);assert(!button.props.disabled,'disabled '+label);button.props.onClick();render();await pause();render();},
  input(label,value){const input=find(tree,node=>node.type==='input'&&node.props['aria-label']===label);assert(input);input.props.onChange({target:{value}});render();},
  select(label,value){const select=find(tree,node=>node.type==='select'&&node.props['aria-label']===label);assert(select);select.props.onChange({target:{value}});render();},
 };
}
const line=(state,id)=>state.plans[0].meals.flatMap(meal=>meal.plannedItems).find(line=>line.id===id);
function facts(state){return{items:state.items,actuals:state.plans[0].meals.map(meal=>meal.actualEntries),credits:state.plans[0].accountedDebits,checks:state.plans[0].personalFoodChecks,supplements:state.plans[0].supplementDoses,policy:state.dailyMenuSettlementPolicy};}
test('one half-serving save scales every ingredient atomically, preserves outside food and all actual/accounting facts, and can restore a full serving after reload',async()=>{
 const ui=mount(),before=structuredClone(ui.state);await ui.click("Half portion");assert.equal(ui.calls.length,0);await ui.click("Save recipe amount");
 assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].action,'scale_recipe_group');assert.equal(ui.calls[0].payload.targetPortion,.5);assert.equal(ui.calls[0].payload.groupId,'basque');assert.match(ui.calls[0].payload.expectedFingerprint,/^recipe-/);
 assert.equal(line(ui.state,'yogurt-cake').quantity,75);assert.equal(line(ui.state,'cocoa-cake').quantity,4);assert.equal(line(ui.state,'egg-cake').quantity,25);assert.equal(line(ui.state,'yogurt-side').quantity,30);assert.deepEqual(facts(ui.state),facts(before));assert.equal(ui.closed,1);
 const again=mount(structuredClone(ui.state));assert.match(text(again.tree),/Current: 0.5 portions/);await again.click("Whole portion");await again.click("Save recipe amount");
 assert.equal(line(again.state,'yogurt-cake').quantity,150);assert.equal(line(again.state,'cocoa-cake').quantity,8);assert.equal(line(again.state,'egg-cake').quantity,50);assert.deepEqual(facts(again.state),facts(before));
});
test('custom portions preview the entire recipe without writing until save, and invalid values cannot dispatch',async()=>{
 const ui=mount();await ui.click("Custom");ui.input("Planned recipe portions",'.75');assert.equal(ui.calls.length,0);assert.match(text(ui.tree),/112.5 g/);await ui.click("Save recipe amount");assert.equal(line(ui.state,'yogurt-cake').quantity,112.5);
 const invalid=mount();await invalid.click("Custom");for(const value of ['', '0','-1','101','Infinity']){invalid.input("Planned recipe portions",value);assert.equal(invalid.find(node=>node.type==='button'&&text(node).trim()==="Save recipe amount").props.disabled,true);}assert.equal(invalid.calls.length,0);
});
test('moving half the remaining dish retains a named group in the chosen meal and conserves the full-day ingredient quantities',async()=>{
 const ui=mount(),before=structuredClone(ui.state),sum=state=>state.plans[0].meals.flatMap(meal=>meal.plannedItems).reduce((values,line)=>(values[line.itemId]=(values[line.itemId]??0)+line.quantity,values),{});
 await ui.click("Move to another meal");ui.select("Destination for the remaining recipe",'dinner');await ui.click("Half remaining");await ui.click("Save meal allocation");
 assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].action,'move_recipe_group');assert.equal(ui.calls[0].payload.toMealId,'dinner');assert.equal(ui.calls[0].payload.fractionOfRemaining,.5);assert.equal(typeof ui.calls[0].payload.transferId,'string');
 const dinner=ui.state.plans[0].meals.find(meal=>meal.id==='dinner');assert.equal(dinner.recipeGroups.length,1);assert.equal(dinner.recipeGroups[0].name,'巴斯克（旧名字含半份）');assert.equal(dinner.recipeGroups[0].lineIds.length,3);assert.equal(line(ui.state,'yogurt-side').quantity,30);assert.deepEqual(sum(ui.state),sum(before));assert.deepEqual(facts(ui.state),facts(before));
});
test('custom transfer percentages are bounded, and moving all remaining ingredients does not create actual intake',async()=>{
 const ui=mount(),before=structuredClone(ui.state);await ui.click("Move to another meal");await ui.click("Custom percentage");
 for(const value of ['', '0','101']){ui.input("Remaining recipe transfer percentage",value);assert.equal(ui.find(node=>node.type==='button'&&text(node).trim()==="Save meal allocation").props.disabled,true);}
 ui.input("Remaining recipe transfer percentage",'100');await ui.click("Save meal allocation");assert.equal(ui.state.plans[0].meals.find(meal=>meal.id==='breakfast').recipeGroups.length,0);assert.deepEqual(facts(ui.state),facts(before));
});
test('a half-serving below a stable actual report is blocked and the original report cannot be overwritten',async()=>{
 let state=fixture();state=applyMutation(state,{action:'record_meal_intake',operationId:'recipe-portion-actual',expectedRevision:state.revision,planId:state.plans[0].id,mealId:'breakfast',mode:'append',entries:[{id:'actual-yogurt',itemId:'yogurt',quantity:100,unit:'g',sourceText:'用户实报蛋糕中酸奶100g'}]},AT);
 state.plans[0].meals[0].actualEntries[0].intakeLineId='yogurt-cake';const before=structuredClone(state),ui=mount(state);await ui.click("Half portion");
 assert.equal(ui.find(node=>node.type==='button'&&text(node).trim()==="Save recipe amount").props.disabled,true);assert.match(text(ui.tree),/below.*recorded|actual consumption|reported intake/i);assert.equal(ui.calls.length,0);assert.deepEqual(ui.state,before);
});
test('a successful server write with an unconfirmed client response retries the exact action and operation ID without another change',async()=>{
 let attempts=0;const ui=mount(fixture(),ctx=>{ctx.state=applyMutation(ctx.state,{action:ctx.action,...ctx.payload},AT);return ++attempts>1;});await ui.click("Half portion");await ui.click("Save recipe amount");assert.equal(ui.calls.length,1);const saved=structuredClone(ui.state);assert(ui.find(node=>node.type==='button'&&text(node)==="Retry same action"));
 await ui.click("Retry same action");assert.equal(ui.calls.length,2);assert.deepEqual(ui.calls[1],ui.calls[0]);assert.deepEqual(ui.state,saved);assert.equal(ui.closed,1);
});
test('a changed recipe fingerprint blocks an open dialog instead of applying an old choice to new members or quantities',async()=>{
 const ui=mount();await ui.click("Half portion");const changed=structuredClone(ui.state.plans[0]);changed.meals[0].plannedItems.find(line=>line.id==='yogurt-cake').quantity=170;ui.render({plan:changed});
 assert.match(text(ui.tree),/changed. Close and reopen/);const save=ui.find(node=>node.type==='button'&&text(node).trim()==="Save recipe amount");assert.equal(save.props.disabled,true);save.props.onClick();await pause();assert.equal(ui.calls.length,0);
});
test('an existing unsubmitted intake draft stays visible and is neither submitted nor erased by a recipe adjustment',async()=>{
 let state=fixture();const view=intakeDraftView(state.plans[0],state.items,null);state=applyMutation(state,{action:'save_intake_draft',operationId:'recipe-ui-pending-draft',expectedRevision:state.revision,planId:state.plans[0].id,expectedDraftVersion:null,draft:{id:'existing-draft',baseFingerprint:view.baseFingerprint,consumed:[{mealId:'breakfast',lineId:'cocoa-cake',quantity:1,unit:'g'}],transfers:[],completedMealIds:[]}},AT);
 const before=structuredClone(state.plans[0].intakeDraft),ui=mount(state);assert.match(text(ui.tree),/An unsubmitted intake draft will be retained/);await ui.click("Half portion");await ui.click("Save recipe amount");assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].action,'scale_recipe_group');assert.deepEqual(ui.state.plans[0].intakeDraft,before);assert.equal(ui.state.plans[0].meals.flatMap(meal=>meal.actualEntries).length,0);
});
test('cancel and backdrop close the dialog without writing any serving or actual records',async()=>{
 const ui=mount();await ui.click("Half portion");await ui.click("Cancel");assert.equal(ui.closed,1);assert.equal(ui.calls.length,0);
 const overlay=ui.find(node=>node.props?.className==='recipe-portion-overlay');overlay.props.onPointerDown({target:overlay,currentTarget:overlay});assert.equal(ui.closed,2);assert.equal(ui.calls.length,0);
});
