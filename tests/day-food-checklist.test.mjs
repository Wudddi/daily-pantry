import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { applyMutation, validateItem } from '../lib/inventory.mjs';

const path = new URL('../app/day-food-checklist.tsx', import.meta.url);
const compile = (react = import.meta.resolve('react')) => {
  let compiled = ts.transpileModule(source, { fileName: 'day-food-checklist.tsx', compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText.replace(/import\s+["']\.\/day-food-checklist\.css["'];?/g, '');
  return 'data:text/javascript;base64,' + Buffer.from(compiled.replace(/from\s+(["'])([^"']+)\1/g, (_m, _q, specifier) => 'from ' + JSON.stringify(
    specifier === 'react' ? react : specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier),
  ))).toString('base64');
};
const source = await readFile(path, 'utf8'), css = await readFile(new URL('../app/day-food-checklist.css', import.meta.url), 'utf8');
const Component = (await import(compile())).default;
const NOW='2026-10-26T16:00:00.000Z';
const rawItem = id => ({ id, name: id === 'rice' ? 'No Name 米饭（每袋200g）' : 'No Name Eggs（生鸡蛋，12个装）',
  aliases: id === 'rice' ? ['米饭'] : ['生鸡蛋'], quantity: 1000, unit: 'g', category: 'protein',
  nutrition: { basisAmount:100,basisUnit:'g',kcal:100,protein:10,carbs:12,fat:2,source:'label' } });
function fixture() {
  let state = {schemaVersion:1,revision:0,updatedAt:NOW,items:['rice','egg'].map(id=>validateItem(rawItem(id),NOW)),plans:[],events:[],operationIds:[],preferences:[]};
  return applyMutation(state,{action:'save_meal_plan_draft',expectedRevision:0,operationId:'fixture',plan:{id:'checklist-test',date:'2026-10-26',title:'本机测试四餐',meals:
    ['breakfast','lunch','snack','dinner'].map(id=>({id,slot:id,title:id,plannedTime:'12:30',plannedItems:[{id:id+'-rice',itemId:'rice',quantity:200},{id:id+'-egg',itemId:'egg',quantity:50}]}))}},NOW);
}
const props=state=>({plan:state.plans[0],items:state.items,revision:state.revision,busy:false,mutate:async()=>true,refresh:async()=>{}});
test('default screen shows every meal as a compact checklist, without numeric inputs or draft-save steps',()=>{
  const state=fixture(),before=structuredClone(state),html=renderToStaticMarkup(React.createElement(Component,props(state)));
  for(const name of ['早餐计划','午餐计划','加餐计划','晚餐计划']) assert.ok(html.includes('aria-label="'+name+'"'));
  assert.equal((html.match(/role="checkbox"/g)||[]).length,12);
  assert.equal((html.match(/class="food-meal-column"/g)||[]).length,2);
  assert.equal((html.match(/勾选整餐/g)||[]).length,8);
  assert.match(html,/个人勾选 · 不影响库存结算/);
  assert.match(html,/已勾选/);assert.match(html,/未勾选/);
  assert.doesNotMatch(html,/type="number"|保存草稿|累计已吃量|进食草稿/);
  assert.match(html,/米饭/);assert.match(html,/200g/);assert.deepEqual(state,before);
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/\.food-meal-column\{display:flex;flex-direction:column/);
  assert.match(html,/aria-label="早餐与加餐"[\s\S]*aria-label="早餐计划"[\s\S]*aria-label="加餐计划"[\s\S]*aria-label="午餐与晚餐"[\s\S]*aria-label="午餐计划"[\s\S]*aria-label="晚餐计划"/);
  assert.match(css,/touch-action:pan-y/);assert.doesNotMatch(html,/class="food-row-drag"/);
});
test('an older intake draft is never submitted and does not block private checks',()=>{
  const state=fixture();state.plans[0].intakeDraft={id:'old',baseFingerprint:'old',consumed:[],transfers:[],completedMealIds:[]};
  const html=renderToStaticMarkup(React.createElement(Component,props(state)));
  assert.match(html,/个人勾选不受影响/);assert.match(html,/核对进食草稿/);
  assert.doesNotMatch(html,/class="food-row-main"[^>]*disabled=""/);
});

const hooksUrl='data:text/javascript;base64,'+Buffer.from(`
let active;export const host=()=>({cells:[],cursor:0,effects:[],changed:false});
export function begin(h){active=h;h.cursor=0;h.effects=[];h.changed=false;}
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
export function useState(initial){const h=active,i=h.cursor++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return[h.cells[i],next=>{const value=typeof next==='function'?next(h.cells[i]):next;if(!Object.is(value,h.cells[i])){h.cells[i]=value;h.changed=true;}}];}
export function useRef(initial){const h=active,i=h.cursor++;return h.cells[i]??={current:initial};}
export function useMemo(fn,deps){const h=active,i=h.cursor++;if(!h.cells[i]||!same(h.cells[i].deps,deps))h.cells[i]={value:fn(),deps};return h.cells[i].value;}
export function useEffect(fn,deps){const h=active,i=h.cursor++,old=h.cells[i];if(!old||!same(old.deps,deps))h.effects.push(()=>{old?.cleanup?.();h.cells[i]={deps,cleanup:fn()};});}
export function useId(){return ':check-'+active.cursor+++':';}
export function effects(h){h.effects.forEach(effect=>effect());}
`).toString('base64');
const hooks=await import(hooksUrl), Interactive=(await import(compile(hooksUrl))).default;
function find(node,predicate){if(!node||typeof node!=='object')return null;if(!Array.isArray(node)&&predicate(node))return node;for(const child of Array.isArray(node)?node:[node.props?.children]){const found=find(child,predicate);if(found)return found;}return null;}
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function mount(mutator,initialState=fixture()){const host=hooks.host(),calls=[];let state=initialState,tree;
  const initialProps=props(state);
  function render(patch={}){Object.assign(initialProps,{plan:state.plans[0],items:state.items,revision:state.revision},patch);for(let i=0;i<20;i++){hooks.begin(host);tree=Interactive(initialProps);hooks.effects(host);if(!host.changed)return tree;}throw Error('unstable hooks');}
  initialProps.getLatest=()=>({plan:state.plans[0],items:state.items,revision:state.revision});
  initialProps.mutate=async(action,payload)=>{calls.push({action,payload:structuredClone(payload)});if(mutator)return mutator({action,payload,get state(){return state;},set state(value){state=value;}});state=applyMutation(state,{action,...payload},NOW);render();return true;};
  initialProps.refresh=async()=>render();
  // Keep the actual mutation and reader across subsequent renders.
  const mutation=initialProps.mutate,latest=initialProps.getLatest,refresh=initialProps.refresh;
  const renderActual=patch=>render({mutate:mutation,getLatest:latest,refresh,...patch});renderActual();
  return{calls,render:renderActual,get tree(){return tree;},get state(){return state;},find:predicate=>find(tree,predicate),
    click(label){const button=find(tree,node=>node.type==='button'&&(node.props['aria-label']===label||text(node).trim()===label));assert(button,'missing '+label);assert(!button.props.disabled,'disabled '+label);button.props.onClick();renderActual();return pause();}};
}
test('one meal click saves private checks without changing actual intake, completion, supplements or stock',async()=>{
  const ui=mount(),before=structuredClone(ui.state);await ui.click('个人勾选午餐');await pause();ui.render();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].action,'set_food_personal_check');
  assert.deepEqual(ui.calls[0].payload.lineIds,['lunch-rice','lunch-egg']);assert.equal(ui.calls[0].payload.checked,true);assert.equal(ui.calls[0].payload.draft,undefined);
  assert.deepEqual(ui.state.items,before.items);assert.deepEqual(ui.state.plans[0].meals,before.plans[0].meals);assert.deepEqual(ui.state.plans[0].supplementDoses,before.plans[0].supplementDoses);
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],true);
  const reloaded=mount(undefined,structuredClone(ui.state));assert.equal(foodCheckbox(reloaded,'lunch','米饭').props['aria-checked'],true,'private reminders survive reload');
});
test('rapid checks queue against the latest state and carry different operation IDs, without a second page read',async()=>{
  let release;let count=0;const ui=mount(async ctx=>{if(++count===1)await new Promise(resolve=>{release=resolve;});ctx.state=applyMutation(ctx.state,{action:ctx.action,...ctx.payload},NOW);return true;});
  const first=ui.click('个人勾选午餐的米饭');const second=ui.click('个人勾选午餐的生鸡蛋');assert.equal(ui.calls.length,1);release();await Promise.all([first,second]);await pause();ui.render();
  assert.equal(ui.calls.length,2);assert.notEqual(ui.calls[0].payload.operationId,ui.calls[1].payload.operationId);
  assert.equal(ui.calls[1].payload.expectedRevision,ui.calls[0].payload.expectedRevision+1);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);assert.equal(ui.state.items.find(item=>item.id==='egg').quantity,1000);
});
test('an unconfirmed personal check retries the same request without touching intake or stock',async()=>{
  let attempts=0;const ui=mount(ctx=>{ctx.state=applyMutation(ctx.state,{action:ctx.action,...ctx.payload},NOW);attempts++;return attempts>1;});
  await ui.click('个人勾选午餐的米饭');await pause();ui.render();
  assert.equal(ui.calls.length,1);assert(ui.find(node=>node.type==='button'&&text(node)==='重试原操作'));
  const revision=ui.state.revision;assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);
  await ui.click('重试原操作');await pause();ui.render();assert.equal(ui.calls.length,2);assert.deepEqual(ui.calls[1].payload,ui.calls[0].payload);
  assert.equal(ui.state.revision,revision);assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);assert.equal(ui.state.plans[0].meals.flatMap(meal=>meal.actualEntries).length,0);
});

function withDocument(test){return async()=>{const oldDocument=globalThis.document,oldWindow=globalThis.window;
  const listeners=new Map();
  globalThis.document={body:{style:{overflow:''}},activeElement:null,
    addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
    removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
    dispatchEvent(event){for(const listener of listeners.get(event.type)??[])listener(event);},
    elementFromPoint(){return null;}};
  globalThis.window={innerHeight:844,scrollBy(){}};
  try{await test();}finally{globalThis.document=oldDocument;globalThis.window=oldWindow;}
};}
test('the more button opens allocation first and can split half of dinner directly into lunch without recording intake',withDocument(async()=>{
  const ui=mount(),before=structuredClone(ui.state);assert.equal(ui.find(node=>node.type==='input'&&node.props.type==='number'),null);
  await ui.click('修改晚餐的米饭');
  const input=ui.find(node=>node.type==='input'&&node.props['aria-label']==='移动数量');assert(input);assert.equal(input.props.value,'200');
  const target=ui.find(node=>node.type==='select'&&node.props['aria-label']==='分到哪餐');assert(target);
  for(const id of ['breakfast','lunch','snack'])assert(find(target,node=>node.type==='option'&&node.props.value===id),'missing destination '+id);
  assert.equal(ui.find(node=>node.type==='input'&&node.props['aria-label']==='这餐累计已吃量'),null);
  await ui.click('半份');assert.equal(ui.find(node=>node.props?.['aria-label']==='移动数量').props.value,'100');
  ui.find(node=>node.props?.['aria-label']==='分到哪餐').props.onChange({target:{value:'lunch'}});ui.render();await ui.click('分到午餐');await pause();ui.render();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].payload.draft.consumed.length,0);assert.equal(ui.calls[0].payload.draft.transfers[0].quantity,100);
  const plan=ui.state.plans[0],lunch=plan.meals.find(meal=>meal.id==='lunch'),dinner=plan.meals.find(meal=>meal.id==='dinner');
  assert.equal(lunch.plannedItems.filter(line=>line.itemId==='rice').reduce((sum,line)=>sum+line.quantity,0),300);
  assert.equal(dinner.plannedItems.filter(line=>line.itemId==='rice').reduce((sum,line)=>sum+line.quantity,0),100);
  assert.deepEqual(ui.state.items,before.items);assert.equal(plan.meals.flatMap(meal=>meal.actualEntries).length,0);
}));

test('old Chat actuals remain separate while personal checks and incoming allocations are updated',withDocument(async()=>{
  let initial=fixture();initial=applyMutation(initial,{action:'record_meal_intake',operationId:'chat-breakfast',expectedRevision:initial.revision,planId:initial.plans[0].id,mealId:'breakfast',mode:'complete',matchesPlannedFood:true,sourceText:'本机Chat明确汇报早餐已吃'},NOW);
  const ui=mount(undefined,initial);assert.equal(foodCheckbox(ui,'breakfast','米饭').props['aria-checked'],false,'old actuals must not infer personal checks');
  await ui.click('个人勾选早餐');await pause();ui.render();
  const before=structuredClone(ui.state),actualBefore=structuredClone(ui.state.plans[0].meals[0].actualEntries);
  await ui.click('修改加餐的米饭');
  const target=ui.find(node=>node.props?.['aria-label']==='分到哪餐');assert(find(target,node=>node.type==='option'&&node.props.value==='breakfast'));
  target.props.onChange({target:{value:'breakfast'}});ui.render();await ui.click('半份');await ui.click('分到早餐');await pause();ui.render();
  assert.equal(ui.calls.length,2);assert.deepEqual(ui.state.items,before.items);
  assert.deepEqual(ui.state.plans[0].meals[0].actualEntries,actualBefore);
  assert.equal(ui.state.plans[0].meals[0].plannedItems.filter(line=>line.itemId==='rice').reduce((sum,line)=>sum+line.quantity,0),300);
  assert.equal(foodCheckbox(ui,'breakfast','米饭').props['aria-checked'],'mixed','new transfer stays unmarked while the old line retains its private check');
  await ui.click('个人勾选早餐的米饭');await pause();ui.render();
  assert.equal(ui.calls.length,3);assert.equal(ui.calls[2].action,'set_food_personal_check');assert.equal(ui.calls[2].payload.checked,true);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,before.items.find(item=>item.id==='rice').quantity);
  const currentBreakfast=ui.state.plans[0].meals[0];
  for(const oldActual of actualBefore)assert.deepEqual(currentBreakfast.actualEntries.find(entry=>entry.id===oldActual.id),oldActual);
  assert.equal(currentBreakfast.actualEntries.filter(entry=>entry.itemId==='rice').reduce((sum,entry)=>sum+entry.quantity,0),200);
  assert.equal(foodCheckbox(ui,'breakfast','米饭').props['aria-checked'],true);
  const latest=ui.calls[2],after=structuredClone(ui.state);
  assert.deepEqual(applyMutation(ui.state,{action:latest.action,...latest.payload},NOW),after,'replaying the private check cannot change intake or charge incoming food');
}));

test('reducing a planned portion reallocates its remainder without recording actual intake',withDocument(async()=>{
  const ui=mount();await ui.click('修改午餐的米饭');await ui.click('本餐份量');
  const input=ui.find(node=>node.props?.['aria-label']==='这餐计划份量');assert(input);
  input.props.onChange({target:{value:'120'}});ui.render();await ui.click('保存计划份量');await pause();ui.render();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].payload.draft.consumed.length,0);assert.equal(ui.calls[0].payload.draft.transfers[0].quantity,80);
  assert.equal(ui.state.plans[0].meals.find(meal=>meal.id==='lunch').plannedItems.find(line=>line.itemId==='rice').quantity,120);
  assert.equal(ui.state.plans[0].meals.flatMap(meal=>meal.actualEntries).length,0);assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);
}));
test('increasing a planned portion takes matching food from the chosen meal with no inventory or factual change',withDocument(async()=>{
  const ui=mount(),before=structuredClone(ui.state);await ui.click('修改午餐的米饭');await ui.click('本餐份量');
  ui.find(node=>node.props?.['aria-label']==='这餐计划份量').props.onChange({target:{value:'300'}});ui.render();
  ui.find(node=>node.props?.['aria-label']==='份量调整对应餐次').props.onChange({target:{value:'dinner'}});ui.render();
  await ui.click('保存计划份量');await pause();ui.render();
  assert.equal(ui.calls[0].payload.draft.consumed.length,0);assert.equal(ui.calls[0].payload.draft.transfers[0].fromMealId,'dinner');assert.equal(ui.calls[0].payload.draft.transfers[0].quantity,100);
  assert.equal(ui.state.plans[0].meals.find(meal=>meal.id==='lunch').plannedItems.filter(line=>line.itemId==='rice').reduce((sum,line)=>sum+line.quantity,0),300);
  assert.deepEqual(ui.state.items,before.items);assert.equal(ui.state.plans[0].meals.flatMap(meal=>meal.actualEntries).length,0);
}));

function holdFood(ui,mealId,name,{pointerId=1,x=10,y=100,pointerType='mouse'}={}){
  const row=foodCheckbox(ui,mealId,name);assert(row);
  const target={setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
  let callback;const timeout=globalThis.setTimeout,clear=globalThis.clearTimeout;
  globalThis.setTimeout=fn=>{callback=fn;return 999;};globalThis.clearTimeout=()=>{callback=null;};
  try{row.props.onPointerDown({button:0,pointerId,pointerType,clientX:x,clientY:y,preventDefault(){},currentTarget:target});assert(callback,'a hold timer should be scheduled');callback();}
  finally{globalThis.setTimeout=timeout;globalThis.clearTimeout=clear;}
  ui.render();return{row,target,pointerId};
}

test('long pressing a food selects it for dragging, never opens editing, and suppresses its synthetic click',withDocument(async()=>{
  const ui=mount(),{row,target,pointerId}=holdFood(ui,'lunch','米饭');
  assert.equal(ui.find(node=>node.props?.role==='dialog'),null);
  assert(ui.find(node=>node.type==='li'&&node.props.className?.includes('is-dragging')));
  assert(ui.find(node=>node.props?.className==='food-drag-ghost'));
  row.props.onPointerUp({pointerId,currentTarget:target});row.props.onClick();await pause();ui.render();assert.equal(ui.calls.length,0);
}));

test('long-press dragging the full food row moves only its remaining portion and does not need a separate handle',withDocument(async()=>{
  const ui=mount(),{row,target,pointerId}=holdFood(ui,'lunch','米饭');
  assert.equal(ui.find(node=>node.props?.className==='food-row-drag'),null);
  const card={dataset:{checklistMeal:'dinner'},closest:()=>({dataset:{checklistPlan:ui.state.plans[0].id}})};
  globalThis.document.elementFromPoint=()=>({closest:()=>card});
  row.props.onPointerMove({pointerId,clientX:80,clientY:250,preventDefault(){},currentTarget:target});ui.render();
  assert(ui.find(node=>node.props?.['data-checklist-meal']==='dinner').props.className.includes('is-drop-target'));
  assert.match(text(ui.find(node=>node.props?.className==='food-drag-ghost')),/米饭.*200g.*晚餐/);
  row.props.onPointerUp({pointerId,currentTarget:target});await pause();ui.render();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].payload.draft.consumed.length,0);
  const plan=ui.state.plans[0];assert.equal(plan.meals.find(meal=>meal.id==='dinner').plannedItems.filter(line=>line.itemId==='rice').reduce((sum,line)=>sum+line.quantity,0),400);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);assert.equal(plan.meals.flatMap(meal=>meal.actualEntries).length,0);
  assert.equal(ui.find(node=>node.type==='li'&&node.props.className?.includes('is-dragging')),null);
}));

test('a desktop mouse can drag the food row immediately without waiting for a long press and never checks it on release',withDocument(async()=>{
  const ui=mount(),before=structuredClone(ui.state),row=foodCheckbox(ui,'dinner','米饭');
  const target={setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){}};
  const card={dataset:{checklistMeal:'lunch'},closest:()=>({dataset:{checklistPlan:ui.state.plans[0].id}})};
  globalThis.document.elementFromPoint=()=>({closest:()=>card});
  row.props.onPointerDown({button:0,pointerId:9,pointerType:'mouse',clientX:20,clientY:500,currentTarget:target});ui.render();
  assert.equal(ui.find(node=>node.props?.className==='food-drag-ghost'),null,'pressing alone should still be a regular click');
  row.props.onPointerMove({pointerId:9,pointerType:'mouse',clientX:100,clientY:250,preventDefault(){},currentTarget:target});ui.render();
  assert(ui.find(node=>node.props?.className==='food-drag-ghost'),'moving the mouse lifts the full row immediately');
  assert(ui.find(node=>node.props?.['data-checklist-meal']==='lunch').props.className.includes('is-drop-target'));
  row.props.onPointerUp({pointerId:9,currentTarget:target});row.props.onClick();await pause();ui.render();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].payload.draft.consumed.length,0);
  assert.equal(ui.calls[0].payload.draft.transfers[0].fromMealId,'dinner');assert.equal(ui.calls[0].payload.draft.transfers[0].toMealId,'lunch');
  assert.deepEqual(ui.state.items,before.items);assert.equal(ui.state.plans[0].meals.flatMap(meal=>meal.actualEntries).length,0);
}));

test('normal scrolling before the long-press threshold cancels selection without checking or editing a food',withDocument(async()=>{
  const ui=mount(),row=foodCheckbox(ui,'lunch','米饭');let callback;const timeout=globalThis.setTimeout,clear=globalThis.clearTimeout;
  globalThis.setTimeout=fn=>{callback=fn;return 123;};globalThis.clearTimeout=()=>{callback=null;};
  try{row.props.onPointerDown({button:0,pointerId:1,pointerType:'touch',clientX:20,clientY:100,currentTarget:{}});
    assert(callback);row.props.onPointerMove({pointerId:1,clientX:20,clientY:125,currentTarget:{}});assert.equal(callback,null);
    row.props.onPointerCancel({pointerId:1,currentTarget:{}});ui.render();
    row.props.onClick();await pause();ui.render();
    assert.equal(ui.find(node=>node.props?.className==='food-drag-ghost'),null);assert.equal(ui.find(node=>node.props?.role==='dialog'),null);assert.equal(ui.calls.length,0);
  }finally{globalThis.setTimeout=timeout;globalThis.clearTimeout=clear;}
}));

function mealNode(ui,mealId){return ui.find(node=>node.props?.['data-checklist-meal']===mealId);}
function foodCheckbox(ui,mealId,name){return find(mealNode(ui,mealId),node=>node.props?.role==='checkbox'&&text(node).includes(name));}
function clickNode(ui,node){assert(node);assert(!node.props.disabled);node.props.onClick();ui.render();return pause();}

test('a personal check toggles off with no actual correction, refund or inventory write',async()=>{
  const ui=mount();await clickNode(ui,foodCheckbox(ui,'lunch','米饭'));await pause();ui.render();
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],true);
  const actual=structuredClone(ui.state.plans[0].meals[1].actualEntries);
  await clickNode(ui,foodCheckbox(ui,'lunch','米饭'));await pause();ui.render();
  assert.equal(ui.calls.length,2);assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],false);
  assert.equal(ui.find(node=>node.props?.role==='dialog'),null,'unchecking must not open editing');
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);
  assert.equal(ui.calls[1].action,'set_food_personal_check');assert.equal(ui.calls[1].payload.checked,false);
  assert.deepEqual(ui.state.plans[0].meals[1].actualEntries,actual);
  const undo=ui.calls[1];const revision=ui.state.revision;
  assert.deepEqual(applyMutation(ui.state,{action:undo.action,...undo.payload},NOW),ui.state);
  assert.equal(ui.state.revision,revision);
});

test('the meal header can uncheck every food together and retains other meals and supplements',async()=>{
  const ui=mount();await ui.click('个人勾选午餐');await pause();ui.render();
  const before=structuredClone(ui.state.plans[0]);
  const header=find(mealNode(ui,'lunch'),node=>node.type==='button'&&node.props.className?.includes('food-meal-check'));
  await clickNode(ui,header);await pause();ui.render();
  assert.equal(ui.calls.length,2);assert.equal(ui.calls[1].payload.lineIds.length,2);assert.equal(ui.calls[1].payload.checked,false);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);assert.equal(ui.state.items.find(item=>item.id==='egg').quantity,1000);
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],false);assert.equal(foodCheckbox(ui,'lunch','生鸡蛋').props['aria-checked'],false);
  assert.deepEqual(ui.state.plans[0].meals.filter(meal=>meal.id!=='lunch'),before.meals.filter(meal=>meal.id!=='lunch'));
  assert.deepEqual(ui.state.plans[0].supplementDoses,before.supplementDoses);
});

test('rapid personal check then uncheck queues both intentions without changing consumption',async()=>{
  let release,count=0;const ui=mount(async ctx=>{if(++count===1)await new Promise(resolve=>{release=resolve;});ctx.state=applyMutation(ctx.state,{action:ctx.action,...ctx.payload},NOW);return true;});
  const checking=clickNode(ui,foodCheckbox(ui,'lunch','米饭'));ui.render();
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],true);
  const unchecking=clickNode(ui,foodCheckbox(ui,'lunch','米饭'));ui.render();
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],false);
  assert.equal(ui.calls.length,1);release();await Promise.all([checking,unchecking]);await pause();ui.render();
  assert.equal(ui.calls.length,2);assert.notEqual(ui.calls[0].payload.operationId,ui.calls[1].payload.operationId);
  assert.equal(ui.calls[1].payload.expectedRevision,ui.calls[0].payload.expectedRevision+1);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],false);
});

test('three rapid toggles retain the final checked intention rather than deduplicating away the last click',async()=>{
  let release,count=0;const ui=mount(async ctx=>{if(++count===1)await new Promise(resolve=>{release=resolve;});ctx.state=applyMutation(ctx.state,{action:ctx.action,...ctx.payload},NOW);return true;});
  const clicks=[clickNode(ui,foodCheckbox(ui,'lunch','米饭')),clickNode(ui,foodCheckbox(ui,'lunch','米饭')),clickNode(ui,foodCheckbox(ui,'lunch','米饭'))];
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],true);release();await Promise.all(clicks);await pause();ui.render();
  assert.equal(ui.calls.length,3);assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);
  assert.equal(foodCheckbox(ui,'lunch','米饭').props['aria-checked'],true);
});

test('the full day ingredients sheet closes via its close control, backdrop and Escape without any writes',withDocument(async()=>{
  const ui=mount(),before=structuredClone(ui.state);
  const open=()=>ui.find(node=>node.type==='button'&&text(node).trim()==='全天食材');
  await clickNode(ui,open());
  assert(ui.find(node=>node.props?.role==='dialog'&&text(node).includes('全天食材总量')));
  assert.equal(globalThis.document.body.style.overflow,'hidden');
  await ui.click('关闭全天食材总量');assert.equal(ui.find(node=>node.props?.role==='dialog'),null);assert.equal(globalThis.document.body.style.overflow,'');
  await clickNode(ui,open());
  const overlay=ui.find(node=>node.props?.className==='food-day-overlay');assert(overlay);
  overlay.props.onPointerDown({target:'sheet-content',currentTarget:'backdrop'});ui.render();
  assert(ui.find(node=>node.props?.role==='dialog'),'touching the list must not close it');
  overlay.props.onPointerDown({target:'backdrop',currentTarget:'backdrop'});ui.render();assert.equal(ui.find(node=>node.props?.role==='dialog'),null);
  await clickNode(ui,open());globalThis.document.dispatchEvent({type:'keydown',key:'Escape'});ui.render();
  assert.equal(ui.find(node=>node.props?.role==='dialog'),null);assert.equal(ui.calls.length,0);assert.deepEqual(ui.state,before);
}));

test('cancelling a held row or dropping outside a meal clears feedback and never changes allocation or inventory',withDocument(async()=>{
  const ui=mount(),before=structuredClone(ui.state);
  let held=holdFood(ui,'lunch','米饭');held.row.props.onPointerCancel({pointerId:held.pointerId,currentTarget:held.target});ui.render();
  assert.equal(ui.find(node=>node.props?.className==='food-drag-ghost'),null);
  held=holdFood(ui,'lunch','米饭');held.row.props.onPointerMove({pointerId:held.pointerId,clientX:200,clientY:200,preventDefault(){},currentTarget:held.target});ui.render();
  held.row.props.onPointerUp({pointerId:held.pointerId,currentTarget:held.target});await pause();ui.render();
  assert.equal(ui.find(node=>node.props?.className==='food-drag-ghost'),null);assert.equal(ui.calls.length,0);assert.deepEqual(ui.state,before);
}));

test('a changed menu cannot be overwritten by an already-open quantity editor',withDocument(async()=>{
  const ui=mount();await ui.click('修改午餐的米饭');await ui.click('本餐份量');
  const changed=structuredClone(ui.state.plans[0]);changed.meals.find(meal=>meal.id==='lunch').plannedItems[0].quantity=250;
  ui.render({plan:changed});
  const save=ui.find(node=>node.type==='button'&&text(node)==='保存计划份量');assert.equal(save.props.disabled,true);
  assert(ui.find(node=>node.props?.role==='alert'&&text(node).includes('菜单或实际记录已更新')));
  assert.equal(ui.calls.length,0);
}));
test('Chinese labels remain recognizable when aliases contain a long English brand',()=>{
  const state=fixture();state.items[0].aliases=['Lavish Doses 原味黄油可颂'];
  const html=renderToStaticMarkup(React.createElement(Component,props(state)));
  assert.match(html,/>原味黄油可颂<\/span>/);assert.doesNotMatch(html,/food-row-name">Lavish/);
});
test('a historical completed marker does not automatically create any personal check',()=>{
  const state=fixture();state.plans[0].meals.find(meal=>meal.id==='lunch').state='completed';
  const html=renderToStaticMarkup(React.createElement(Component,props(state)));
  assert.match(html,/aria-label="个人勾选午餐"/);assert.doesNotMatch(html,/aria-label="取消午餐个人勾选"/);
});
test('real product names keep food meaning rather than baking notes, package weights or long English brands',()=>{
  const products=[
    {id:'bread',category:'bread',name:'Pane Fresco Whole Wheat Pan Bread（Fortinos 现烤）'},
    {id:'broccoli',category:'vegetable',name:'PC Broccoli Florets 冷冻西兰花（埃及产，500g袋）',aliases:['PC冷冻西兰花500g']},
    {id:'veg',category:'vegetable',name:'No Name Mixed Garden Vegetables（豆角＋胡萝卜冷冻杂蔬）'},
    {id:'cocoa',category:'condiment',name:'No Name Cocoa Powder 无糖可可粉（227g装）',aliases:['No Name可可粉']},
    {id:'whey',category:'protein',name:'ON Gold Standard 100% Whey — Extreme Milk Chocolate'},
    {id:'yogurt',category:'protein',name:'Oikos High Protein Greek Yogurt Plain 0% M.F.（650g）',aliases:['Oikos高蛋白零脂原味希腊酸奶']},
    {id:'croissant',category:'bread',name:'Lavish Doses 巧克力杏仁可颂（Almond Chocolate Croissant）'},
  ];
  const items=products.map(product=>validateItem({...rawItem(product.id),aliases:[],...product},NOW));
  const state=applyMutation({schemaVersion:1,revision:0,updatedAt:NOW,items,plans:[],events:[],operationIds:[],preferences:[]},
    {action:'save_meal_plan_draft',expectedRevision:0,operationId:'real-names',plan:{id:'real-product-names',date:'2048-03-04',title:'本机真实商品名称显示测试',meals:[
      {id:'lunch',slot:'lunch',title:'午餐',plannedItems:products.map(product=>({id:product.id,itemId:product.id,quantity:100}))}
    ]}},NOW);
  const html=renderToStaticMarkup(React.createElement(Component,props(state)));
  const labels=[...html.matchAll(/class="food-row-name">([^<]+)/g)].map(match=>match[1]);
  assert.deepEqual(labels,['全麦面包','冷冻西兰花','冷冻杂蔬','无糖可可粉','巧克力乳清','Oikos 0%酸奶','巧克力杏仁可颂']);
});


test('zero-plan zero-actual rows disappear from the meal checklist without deleting historical data',()=>{
  const state=fixture(),lunch=state.plans[0].meals.find(meal=>meal.id==='lunch');
  lunch.plannedItems.find(line=>line.itemId==='rice').quantity=0;
  const before=structuredClone(state),ui=mount(undefined,state);
  assert.equal(foodCheckbox(ui,'lunch','米饭'),null);
  assert(foodCheckbox(ui,'lunch','生鸡蛋'));assert.deepEqual(state,before);
});

test('actual-only foods remain preserved outside personal reminders while unknown planned amounts can be checked',async()=>{
  let state=fixture();state=applyMutation(state,{action:'record_meal_intake',operationId:'zero-with-actual',expectedRevision:state.revision,planId:state.plans[0].id,mealId:'lunch',entries:[{id:'chat-rice',itemId:'rice',quantity:20,unit:'g',sourceText:'本机已吃20g'}]},NOW);
  state.plans[0].meals.find(meal=>meal.id==='lunch').plannedItems.find(line=>line.itemId==='rice').quantity=0;
  state.plans[0].meals.find(meal=>meal.id==='dinner').plannedItems.find(line=>line.itemId==='rice').quantity=null;
  const before=structuredClone(state),ui=mount(undefined,state);
  assert.equal(foodCheckbox(ui,'lunch','米饭'),null,'a zero planned item is not part of the personal planned reminder');
  assert(foodCheckbox(ui,'dinner','米饭'),'unknown quantities must not be disguised as zero');assert.deepEqual(state,before);
  await clickNode(ui,foodCheckbox(ui,'dinner','米饭'));await pause();ui.render();
  assert.equal(foodCheckbox(ui,'dinner','米饭').props['aria-checked'],true);assert.deepEqual(ui.state.items,before.items);
  assert.deepEqual(ui.state.plans[0].meals.flatMap(meal=>meal.actualEntries),before.plans[0].meals.flatMap(meal=>meal.actualEntries));
});


test('native touch moves prevent scrolling only after a long press and touch end submits the move once',withDocument(async()=>{
  const ui=mount();let prevented=0;
  globalThis.document.dispatchEvent({type:'touchmove',cancelable:true,touches:[{clientX:20,clientY:120}],preventDefault(){prevented++;}});
  assert.equal(prevented,0,'ordinary page scrolling must remain native');
  const {row}=holdFood(ui,'lunch','米饭',{pointerType:'touch'});
  const card={dataset:{checklistMeal:'breakfast'},closest:()=>({dataset:{checklistPlan:ui.state.plans[0].id}})};
  globalThis.document.elementFromPoint=()=>({closest:()=>card});
  globalThis.document.dispatchEvent({type:'touchmove',cancelable:true,touches:[{clientX:80,clientY:250}],preventDefault(){prevented++;}});ui.render();
  assert.equal(prevented,1);assert(ui.find(node=>node.props?.['data-checklist-meal']==='breakfast').props.className.includes('is-drop-target'));
  globalThis.document.dispatchEvent({type:'touchend'});await pause();ui.render();
  row.props.onPointerUp({});row.props.onClick();await pause();ui.render();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].payload.draft.consumed.length,0);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);
  assert.equal(ui.find(node=>node.props?.className==='food-drag-ghost'),null);
}));

test('touch cancellation releases the selected row without changing plans or consuming food',withDocument(async()=>{
  const ui=mount(),before=structuredClone(ui.state);holdFood(ui,'dinner','米饭',{pointerType:'touch'});
  globalThis.document.dispatchEvent({type:'touchcancel'});ui.render();
  assert.equal(ui.find(node=>node.props?.className==='food-drag-ghost'),null);assert.equal(ui.calls.length,0);assert.deepEqual(ui.state,before);
}));

test('moving all planned food removes its old personal row without creating or erasing actual intake',withDocument(async()=>{
  const ui=mount();await ui.click('个人勾选午餐的米饭');await pause();ui.render();await ui.click('取消个人勾选午餐的米饭');await pause();ui.render();
  const actual=structuredClone(ui.state.plans[0].meals.find(meal=>meal.id==='lunch').actualEntries);
  await ui.click('修改午餐的米饭');const target=ui.find(node=>node.props?.['aria-label']==='分到哪餐');target.props.onChange({target:{value:'dinner'}});ui.render();
  await ui.click('全部');await ui.click('分到晚餐');await pause();ui.render();
  assert.equal(foodCheckbox(ui,'lunch','米饭'),null,'a zero-plan zero-actual virtual remainder must disappear');
  assert.deepEqual(ui.state.plans[0].meals.find(meal=>meal.id==='lunch').actualEntries,actual);
  assert.equal(ui.state.items.find(item=>item.id==='rice').quantity,1000);
}));
