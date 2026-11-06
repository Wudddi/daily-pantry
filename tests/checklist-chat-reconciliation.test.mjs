import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { buildChecklistAction } from '../lib/checklist-actions.mjs';

const NOW='2026-10-27T16:00:00.000Z', LATER='2026-10-27T22:00:00.000Z';
const clone=value=>structuredClone(value);
let sequence=0;
const nutrition=(unit='g')=>({basisAmount:100,basisUnit:unit,kcal:150,protein:10,carbs:20,fat:3,source:'estimate',sourceText:"Local estimated nutrition fixture"});
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
    events:[],operationIds:[],preferences:[],plans:[]},'save_meal_plan_draft',{plan:{id:'daily-food-2026-10-27',date:'2026-10-27',title:"Local checklist and Chat reconciliation fixture",
      meals:[
        {id:'lunch',slot:'lunch',title:"Lunch",plannedItems:[{id:'rice-line',itemId:'rice',quantity:100,unit:'g'},{id:'milk-line',itemId:'milk',quantity:150,unit:'ml'}]},
        {id:'dinner',slot:'dinner',title:"Dinner",plannedItems:[{id:'beef-line',itemId:'beef',quantity:1,unit:'袋'}]},
      ],supplementDoses:[{id:'creatine-am',itemId:'creatine',plannedQuantity:5,timingSlot:'breakfast'}]}});
}
function check(state,action) {
  const command=buildChecklistAction(plan(state),state.items,action,{draftId:'checkbox-gesture-'+(++sequence)});
  return command.noChange?state:mutate(state,'apply_checklist_intake',{planId:plan(state).id,draft:command.draft,expectedDraftVersion:null});
}
const complete=(state,fields={})=>mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:"The user finished lunch according to the current plan",...fields},LATER);
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
  const command={action:'record_meal_intake',planId:plan(state).id,mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:"The user finished lunch according to the current plan",operationId:'repeat-after-ui',expectedRevision:state.revision};
  const retry=applyMutation(state,command,LATER);
  assert.strictEqual(retry,state);
  assert.strictEqual(applyMutation(retry,command,LATER),state);
});

test('a new Chat ID cannot append a cumulative portion already represented by a checkbox; the whole action is atomic',()=>{
  const state=check(fixture(),{type:'set_eaten',mealId:'lunch',lineIds:['rice-line'],quantity:60}), before=clone(state);
  const duplicate={mealId:'lunch',mode:'complete',sourceText:"Cumulative lunch: 100 g rice and 150 mL milk",entries:[
    {id:'new-chat-milk',itemId:'milk',quantity:150,unit:'ml',sourceText:"Cumulative lunch: 150 mL"},
    {id:'new-chat-rice',itemId:'rice',quantity:100,unit:'g',sourceText:"Cumulative lunch: 100 g"},
  ]};
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,...duplicate}),reconciliationError);
  assert.deepEqual(state,before); assert.equal(stock(state),940); assert.equal(stock(state,'milk'),1000);
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,meals:[
    {mealId:'dinner',mode:'complete',matchesPlannedFood:true,sourceText:"Dinner completed"},duplicate,
  ]}),reconciliationError);
  assert.deepEqual(state,before,'a later ambiguous meal cannot leave an earlier meal partially settled');
});

test('explicit correction reuses the checkbox actual ID and applies only the increase or refund difference',()=>{
  let state=check(fixture(),{type:'set_eaten',mealId:'lunch',lineIds:['rice-line'],quantity:60});
  const id=lunch(state).actualEntries[0].id;
  const correct=(current,quantity)=>mutate(current,'record_meal_intake',{planId:plan(current).id,mealId:'lunch',mode:'correct',
    entries:[{id,itemId:'rice',quantity,unit:'g',sourceText:"Cumulative actual quantity after user verification"+quantity+'g'}]},LATER);
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
  const fields={planId:plan(state).id,mealId:'lunch',mode:'append',entries:[{id:'genuinely-additional-rice',itemId:'rice',quantity:20,unit:'g',sourceText:"Ate another 20 g in addition to the previous 60 g"}],sourceText:"An explicit additional portion, not a cumulative total"};
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
    entries:[{id:'new-chat-beef-grams',itemId:'beef',quantity:132,unit:'g',sourceText:"Finished this 132 g bag of beef"}]}),reconciliationError);
  assert.deepEqual(state,before);
  state=mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'dinner',mode:'complete',matchesPlannedFood:true,sourceText:"Finished the planned one bag of beef"},LATER);
  assert.equal(stock(state,'beef'),9);
  assert.equal(plan(state).meals[1].actualEntries[0].id,actual.id);
  assert.equal(plan(state).meals[1].actualEntries[0].quantity,1);
});

test('canonical external food names cannot bypass the cumulative-portion guard through whitespace changes',()=>{
  let state=fixture();
  state=mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'append',entries:[
    {id:'outside-yogurt-first',itemId:null,name:"External yogurt",quantity:60,unit:'g',sourceText:"Initially ate 60 g of external yogurt"},
  ]});
  const before=clone(state);
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'complete',entries:[
    {id:'outside-yogurt-new-id',itemId:null,name:"External yogurt",quantity:100,unit:'g',sourceText:"Cumulative external yogurt: 100 g"},
  ]}),reconciliationError);
  assert.deepEqual(state,before);
});
