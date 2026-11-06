import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { inventoryMealChoices, mealAdditionQuantity, mealAdditionUnits, buildMealInventoryAddition } from '../lib/meal-inventory-addition.mjs';
const AT='2026-11-06T15:00:00.000Z';
function fixture(){
  const food=(id,extra={})=>validateItem({id,name:id,category:'protein',quantity:1000,unit:'g',nutrition:{basisAmount:100,basisUnit:'g',kcal:100,protein:10,carbs:10,fat:2,source:'label'},...extra},AT);
  return applyMutation({schemaVersion:1,revision:0,updatedAt:AT,items:[food('yogurt',{name:'Plain yogurt',aliases:["Greek yogurt"]}),food('bag',{name:"Bread",unit:'袋',gramsPerUnit:250,quantity:3}),food('milk',{unit:'ml',gramsPerUnit:1}),food('unknown',{quantity:null}),food('empty',{quantity:0}),food('pending',{status:'pending'}),food('archived',{status:'archived'}),food('supplement',{category:'supplement'})],plans:[],operationIds:[],events:[],preferences:[]},
    {action:'save_meal_plan_draft',operationId:'setup',expectedRevision:0,plan:{id:'day',date:'2026-11-06',title:'Local synthetic menu',meals:[{id:'breakfast',slot:'breakfast',title:"Breakfast",plannedItems:[]},{id:'dinner',slot:'dinner',title:"Dinner",plannedItems:[]}]}},AT);
}
test('inventory menu selection keeps available unknown totals and excludes only unavailable items and supplements',()=>{
  const state=fixture(),before=structuredClone(state);
  assert.deepEqual(new Set(inventoryMealChoices(state.items).map(i=>i.id)),new Set(['yogurt','bag','milk','unknown']));
  assert.equal(inventoryMealChoices(state.items,'Greek')[0].id,'yogurt');
  assert.deepEqual(state,before);
});
test('adding by grams converts only with known package mass and never treats volume as mass',()=>{
  const state=fixture(),bag=state.items.find(i=>i.id==='bag'),milk=state.items.find(i=>i.id==='milk');
  assert.deepEqual(mealAdditionUnits(bag),['袋','g']);assert.equal(mealAdditionQuantity(bag,125,'g'),.5);
  assert.deepEqual(mealAdditionUnits(milk),['ml']);assert.throws(()=>mealAdditionQuantity(milk,125,'g'));
  assert.throws(()=>mealAdditionQuantity(bag,0,'g'));assert.throws(()=>mealAdditionQuantity(bag,NaN,'g'));
  const before=structuredClone(state),payload=buildMealInventoryAddition(state.plans[0],state.items,{mealId:'breakfast',itemId:'bag',quantity:125,unit:'g'},{operationId:'add-bag',expectedRevision:state.revision});
  assert.equal(payload.quantity,.5);assert.equal(payload.expectedDraftVersion,null);
  const after=applyMutation(state,{action:'add_food_to_meal',...payload},AT);
  assert.equal(after.plans[0].meals[0].plannedItems[0].quantity,.5);assert.deepEqual(after.items,before.items);assert.deepEqual(after.plans[0].accountedDebits,[]);
});
const hooksUrl='data:text/javascript;base64,'+Buffer.from(`let active;export const host=()=>({cells:[],cursor:0,changed:false});export function begin(h){active=h;h.cursor=0;h.changed=false;}export function useState(v){const h=active,i=h.cursor++;if(!(i in h.cells))h.cells[i]=typeof v==='function'?v():v;return[h.cells[i],n=>{const value=typeof n==='function'?n(h.cells[i]):n;if(!Object.is(value,h.cells[i])){h.cells[i]=value;h.changed=true;}}];}export function useRef(v){const h=active,i=h.cursor++;return h.cells[i]??={current:v};}export function useMemo(fn){return fn();}export function useEffect(){}export function useId(){return 'picker-heading';}`).toString('base64');
const hooks=await import(hooksUrl);
async function componentUrl(interactive=false){
  let code=ts.transpileModule(await readFile(new URL('../app/meal-inventory-picker.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  code=code.replace(/import\s+["'][^"']+\.css["'];?/g,'').replace(/(?<=^import[^\n]*)from\s+(["'])([^"']+)\1/gm,(_m,_q,s)=>'from '+JSON.stringify(s==='react'&&interactive?hooksUrl:s.startsWith('@/')?new URL('../'+s.slice(2),import.meta.url).href:import.meta.resolve(s)));
  return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
}
const Picker=(await import(await componentUrl())).default,Interactive=(await import(await componentUrl(true))).default;
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
function find(node,predicate){if(!node||typeof node!=='object')return null;if(!Array.isArray(node)&&predicate(node))return node;for(const child of Array.isArray(node)?node:[node.props?.children]){const result=find(child,predicate);if(result)return result;}return null;}
test('picker explains that menu addition is a plan and presents usable stock without a premature intake action',()=>{
  const state=fixture(),before=structuredClone(state),html=renderToStaticMarkup(React.createElement(Picker,{plan:state.plans[0],items:state.items,revision:state.revision,mealId:'breakfast',busy:false,mutate:async()=>{throw Error('render wrote');},onClose:()=>{}}));
  assert.match(html,/Add from inventory/);assert.match(html,/Available · balance unrecorded/);assert.match(html,/Adds to the menu only\. Record after eating\./);assert.doesNotMatch(html,/>supplement<|>archived<|>empty</);assert.deepEqual(state,before);
});
test('stock picker uses an atomic planned addition and retries an unknown response with its frozen original request',async()=>{
  let state=fixture(),closed=0,tree;const before=structuredClone(state),calls=[],host=hooks.host();
  const props={busy:false,mealId:'breakfast',onClose:()=>closed++,mutate:async(action,payload)=>{calls.push({action,payload:structuredClone(payload)});state=applyMutation(state,{action,...payload},AT);return calls.length>1;}};
  function render(){for(let i=0;i<10;i++){hooks.begin(host);tree=Interactive({...props,plan:state.plans[0],items:state.items,revision:state.revision});if(!host.changed)return;}throw Error('unstable');}
  render();find(tree,node=>node.type==='button'&&text(node).includes('Plain yogurt')).props.onClick();render();
  find(tree,node=>node.type==='input'&&node.props['aria-label']==="Food amount to add").props.onChange({target:{value:'80'}});render();
  const add=()=>find(tree,node=>node.type==='button'&&text(node).includes("Add to meal"));
  await add().props.onClick();await new Promise(r=>setImmediate(r));render();assert.equal(closed,0);
  await add().props.onClick();await new Promise(r=>setImmediate(r));render();
  assert.equal(calls.length,2);assert.equal(calls[0].action,'add_food_to_meal');assert.deepEqual(calls[1],calls[0]);assert.equal(closed,1);
  assert.equal(state.plans[0].meals[0].plannedItems.length,1);assert.equal(state.plans[0].meals[0].plannedItems[0].quantity,80);assert.deepEqual(state.items,before.items);assert.deepEqual(state.plans[0].meals[0].actualEntries,[]);
});
