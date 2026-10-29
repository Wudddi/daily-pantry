import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { buildChecklistAction } from '../lib/checklist-actions.mjs';

const NOW='2026-10-27T16:00:00.000Z', LATER='2026-10-27T22:00:00.000Z';
const clone=value=>structuredClone(value);
let sequence=0;
const nutrition=(unit='g')=>({basisAmount:100,basisUnit:unit,kcal:150,protein:10,carbs:20,fat:3,source:'estimate',sourceText:'本机验证营养估值'});
const item=(id,unit='g',extra={})=>validateItem({id,name:id,category:id==='creatine'?'supplement':'prepared',quantity:1000,unit,
  nutrition:nutrition(unit==='袋'?'g':unit),...extra},NOW);
function mutate(state,action,fields={},at=NOW) {
  return applyMutation(state,{action,expectedRevision:state.revision,operationId:'checkbox-chat-'+(++sequence),...fields},at);
}
const plan=state=>state.plans[0];
const lunch=state=>plan(state).meals[0];
const stock=(state,id='rice')=>state.items.find(item=>item.id===id).quantity;
function fixture() {
  return mutate({schemaVersion:1,revision:0,updatedAt:NOW,items:[item('rice'),item('milk','ml'),item('beef','袋',{quantity:10,gramsPerUnit:132}),item('creatine')],
    events:[],operationIds:[],preferences:[],plans:[]},'save_meal_plan_draft',{plan:{id:'daily-food-2026-10-27',date:'2026-10-27',title:'本机验证勾选与Chat对账',
      meals:[
        {id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'rice-line',itemId:'rice',quantity:100,unit:'g'},{id:'milk-line',itemId:'milk',quantity:150,unit:'ml'}]},
        {id:'dinner',slot:'dinner',title:'晚餐',plannedItems:[{id:'beef-line',itemId:'beef',quantity:1,unit:'袋'}]},
      ],supplementDoses:[{id:'creatine-am',itemId:'creatine',plannedQuantity:5,timingSlot:'breakfast'}]}});
}
function check(state,action) {
  const command=buildChecklistAction(plan(state),state.items,action,{draftId:'checkbox-gesture-'+(++sequence)});
  return command.noChange?state:mutate(state,'apply_checklist_intake',{planId:plan(state).id,draft:command.draft,expectedDraftVersion:null});
}
const complete=(state,fields={})=>mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:'用户说午餐已按当前计划吃完',...fields},LATER);
const reconciliationError=error=>error.status===409&&error.code==='ACTUAL_INTAKE_RECONCILIATION_REQUIRED';

test('UI partial intake followed by Chat planned completion settles only the missing portion using the same actual ID',()=>{
  let state=check(fixture(),{type:'set_eaten',mealId:'lunch',lineIds:['rice-line'],quantity:60});
  const id=lunch(state).actualEntries[0].id, supplement=clone(plan(state).supplementDoses);
  assert.equal(stock(state),940);
  state=complete(state);
  assert.equal(stock(state),900); assert.equal(stock(state,'milk'),850);
  const saved=lunch(state).actualEntries.find(entry=>entry.id===id);
  assert.equal(saved.quantity,100); assert.equal(saved.intakeLineId,'rice-line');
  assert.equal(lunch(state).actualEntries.filter(entry=>entry.itemId==='rice').length,1);
  assert.equal(lunch(state).state,'completed');
  assert.deepEqual(plan(state).supplementDoses,supplement); assert.equal(stock(state,'creatine'),1000);
  const repeated=complete(state);
  assert.strictEqual(repeated,state,'a new operation carrying the same completed portions is a domain no-op');
});

test('UI whole meal check followed by repeated Chat completion never charges that meal again',()=>{
  let state=check(fixture(),{type:'complete_meal',mealId:'lunch'});
  const ids=lunch(state).actualEntries.map(entry=>entry.id), amounts=clone(state.items);
  state=complete(state);
  assert.deepEqual(state.items,amounts);
  assert.deepEqual(lunch(state).actualEntries.map(entry=>entry.id),ids);
  const command={action:'record_meal_intake',planId:plan(state).id,mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:'用户说午餐已按当前计划吃完',operationId:'repeat-after-ui',expectedRevision:state.revision};
  const retry=applyMutation(state,command,LATER);
  assert.strictEqual(retry,state);
  assert.strictEqual(applyMutation(retry,command,LATER),state);
});

test('a new Chat ID cannot append a cumulative portion already represented by a checkbox; the whole action is atomic',()=>{
  const state=check(fixture(),{type:'set_eaten',mealId:'lunch',lineIds:['rice-line'],quantity:60}), before=clone(state);
  const duplicate={mealId:'lunch',mode:'complete',sourceText:'午餐累计吃了100g米饭，喝了150ml奶',entries:[
    {id:'new-chat-milk',itemId:'milk',quantity:150,unit:'ml',sourceText:'午餐累计150ml'},
    {id:'new-chat-rice',itemId:'rice',quantity:100,unit:'g',sourceText:'午餐累计100g'},
  ]};
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,...duplicate}),reconciliationError);
  assert.deepEqual(state,before); assert.equal(stock(state),940); assert.equal(stock(state,'milk'),1000);
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,meals:[
    {mealId:'dinner',mode:'complete',matchesPlannedFood:true,sourceText:'晚餐已吃完'},duplicate,
  ]}),reconciliationError);
  assert.deepEqual(state,before,'a later ambiguous meal cannot leave an earlier meal partially settled');
});

test('explicit correction reuses the checkbox actual ID and applies only the increase or refund difference',()=>{
  let state=check(fixture(),{type:'set_eaten',mealId:'lunch',lineIds:['rice-line'],quantity:60});
  const id=lunch(state).actualEntries[0].id;
  const correct=(current,quantity)=>mutate(current,'record_meal_intake',{planId:plan(current).id,mealId:'lunch',mode:'correct',
    entries:[{id,itemId:'rice',quantity,unit:'g',sourceText:'用户核对后累计实际'+quantity+'g'}]},LATER);
  state=correct(state,80); assert.equal(stock(state),920);
  state=correct(state,40); assert.equal(stock(state),960);
  assert.equal(lunch(state).actualEntries.length,1);
  assert.equal(lunch(state).actualEntries[0].id,id);
  assert.equal(lunch(state).actualEntries[0].intakeLineId,'rice-line');
  assert.deepEqual(lunch(state).actualEntries[0].correctionHistory.map(entry=>entry.quantity),[60,80]);
  assert.strictEqual(correct(state,40),state);
});

test('explicit additional append stays available and retrying its stable actual ID does not consume another serving',()=>{
  let state=check(fixture(),{type:'set_eaten',mealId:'lunch',lineIds:['rice-line'],quantity:60});
  const fields={planId:plan(state).id,mealId:'lunch',mode:'append',entries:[{id:'genuinely-additional-rice',itemId:'rice',quantity:20,unit:'g',sourceText:'刚才那60g之外又吃了20g'}],sourceText:'明确新增的一份，不是累计总量'};
  state=mutate(state,'record_meal_intake',fields,LATER);
  assert.equal(stock(state),920);
  assert.equal(lunch(state).actualEntries.reduce((total,entry)=>total+entry.quantity,0),80);
  assert.equal(lunch(state).actualEntries.length,2);
  assert.strictEqual(mutate(state,'record_meal_intake',fields,LATER),state);
});

test('gram and package representations of the same food require reconciliation instead of silently adding another portion',()=>{
  let state=check(fixture(),{type:'set_eaten',mealId:'dinner',lineIds:['beef-line'],quantity:66});
  assert.equal(stock(state,'beef'),9.5);
  const actual=plan(state).meals[1].actualEntries[0], before=clone(state);
  assert.equal(actual.quantity,.5); assert.equal(actual.unit,'袋');
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'dinner',mode:'complete',
    entries:[{id:'new-chat-beef-grams',itemId:'beef',quantity:132,unit:'g',sourceText:'累计吃完这一袋132g牛肉'}]}),reconciliationError);
  assert.deepEqual(state,before);
  state=mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'dinner',mode:'complete',matchesPlannedFood:true,sourceText:'牛肉按原计划1袋吃完'},LATER);
  assert.equal(stock(state,'beef'),9);
  assert.equal(plan(state).meals[1].actualEntries[0].id,actual.id);
  assert.equal(plan(state).meals[1].actualEntries[0].quantity,1);
});

test('canonical external food names cannot bypass the cumulative-portion guard through whitespace changes',()=>{
  let state=fixture();
  state=mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'append',entries:[
    {id:'outside-yogurt-first',itemId:null,name:'外食 酸奶',quantity:60,unit:'g',sourceText:'实际先吃60g外食酸奶'},
  ]});
  const before=clone(state);
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'complete',entries:[
    {id:'outside-yogurt-new-id',itemId:null,name:'外食酸奶',quantity:100,unit:'g',sourceText:'外食酸奶累计100g'},
  ]}),reconciliationError);
  assert.deepEqual(state,before);
});
