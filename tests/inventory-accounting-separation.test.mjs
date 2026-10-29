import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation,validateItem } from '../lib/inventory.mjs';
import { readPlanningInventory } from '../lib/inventory-planning-read.mjs';

const AT='2026-10-26T16:00:00.000Z',LATER='2026-10-26T22:00:00.000Z';let seq=0;
const mutate=(state,action,fields={},at=AT)=>applyMutation(state,{action,operationId:'physical-ledger-'+(++seq),expectedRevision:state.revision,...fields},at);
const copy=value=>structuredClone(value);
const food=(id,quantity,unit='g')=>validateItem({id,name:id,quantity,unit,category:id==='banana'?'fruit':'prepared',status:'available',nutrition:{basisAmount:100,basisUnit:unit,kcal:100,protein:5,carbs:20,fat:2,source:'estimate'}},AT);
const planInput=(id,date)=>({id,date,title:'账务与实物分开',meals:[{id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'banana-l',itemId:'banana',quantity:1,unit:'个'},{id:'oats-l',itemId:'oats',quantity:50,unit:'g'}]}],supplementDoses:[]});
function fixture(){
  let state=mutate({schemaVersion:1,revision:0,updatedAt:AT,preferences:[],items:[food('banana',2,'个'),food('oats',500),food('other-food',700)],plans:[],events:[],operationIds:[]},'save_meal_plan_draft',{plan:planInput('day-26','2026-10-26')});
  state=mutate(state,'record_meal_intake',{planId:'day-26',mealId:'lunch',mode:'complete',entries:[{id:'ate-banana',itemId:'banana',quantity:1,unit:'个',sourceText:'实际1根香蕉'},{id:'ate-oats',itemId:'oats',quantity:50,unit:'g',sourceText:'实际50g燕麦'}]});
  return mutate(state,'set_quantity',{id:'banana',quantity:3},LATER);
}

test('one banana baseline conflict preserves that physical balance while an independent food delta settles and future menus remain editable',()=>{
  let state=fixture(),before=copy(state);
  state=mutate(state,'record_meal_intake',{planId:'day-26',mealId:'lunch',mode:'correct',entries:[
    {id:'ate-banana',itemId:'banana',quantity:0,unit:'个',sourceText:'更正：香蕉未吃'},
    {id:'ate-oats',itemId:'oats',quantity:80,unit:'g',sourceText:'更正：燕麦实际80g'},
  ]},LATER);
  assert.deepEqual(state.items.find(item=>item.id==='banana'),before.items.find(item=>item.id==='banana'),'a changed count cannot be refunded or rebased');
  assert.equal(state.items.find(item=>item.id==='oats').quantity,420,'only the additional30g is deducted');
  assert.deepEqual(state.items.find(item=>item.id==='other-food'),before.items.find(item=>item.id==='other-food'));
  assert(state.items.every(item=>item.status==='available'));
  const pending=copy(state.plans[0]);
  assert.equal(pending.inventoryAccounting,'pending_reconciliation');
  assert(pending.accountingIssues.some(issue=>issue.itemId==='banana'&&issue.code==='BASELINE_REQUIRES_REVIEW'));
  assert.equal(pending.accountingIssues.some(issue=>issue.itemId==='oats'),false);
  assert.equal(pending.accountedDebits.find(line=>line.itemId==='oats').quantity,80);
  assert.deepEqual(pending.accountedDebits.find(line=>line.itemId==='banana'),before.plans[0].accountedDebits.find(line=>line.itemId==='banana'));
  const inventory=readPlanningInventory(state,{},LATER);
  for(const id of ['banana','oats','other-food'])assert.equal(inventory.items.find(item=>item.id===id).status,'available');
  const settledItems=copy(state.items);
  state=mutate(state,'save_meal_plan_draft',{plan:planInput('day-27','2026-10-27')},LATER);
  assert.deepEqual(state.items,settledItems);
  assert.deepEqual(state.plans.find(plan=>plan.id==='day-26'),pending,'saving tomorrow never erases or reinterprets the old problem');
  assert.equal(state.plans.find(plan=>plan.id==='day-27').meals.length,1);
});

test('an explicitly restored available item is never relocked by saving another day, and untouched legacy pending is not automatically restored',()=>{
  const original=fixture();
  original.plans[0].inventoryAccounting='pending_reconciliation';
  original.plans[0].accountingIssues=[{code:'BASELINE_REQUIRES_REVIEW',itemId:'banana',message:'旧盘点需核对'}];
  original.items.find(item=>item.id==='banana').status='available';
  original.items.find(item=>item.id==='other-food').status='pending';
  const before=copy(original);
  const next=mutate(original,'save_meal_plan_draft',{plan:planInput('day-27','2026-10-27')},LATER);
  assert.deepEqual(next.items,before.items);
  assert.equal(next.items.find(item=>item.id==='banana').status,'available');
  assert.equal(next.items.find(item=>item.id==='other-food').status,'pending');
  assert.deepEqual(next.plans[0].accountingIssues,before.plans[0].accountingIssues);
});
