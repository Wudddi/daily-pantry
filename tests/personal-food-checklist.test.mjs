import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { isPersonalFoodChecked } from '../lib/personal-food-checklist.mjs';
import { intakePlanFingerprint } from '../lib/intake-draft.mjs';

const AT='2026-10-26T16:00:00.000Z';let seq=0;
const mutate=(state,action,fields={})=>applyMutation(state,{action,operationId:'personal-test-'+(++seq),expectedRevision:state.revision,...fields},AT);
function fixture() {return mutate({schemaVersion:1,revision:0,updatedAt:AT,preferences:[],events:[],operationIds:[],plans:[],items:[validateItem({id:'food',name:'食物',category:'prepared',quantity:1000,unit:'g'},AT)]},'save_meal_plan_draft',{plan:{id:'daily-food-2026-10-26',date:'2026-10-26',title:'个人清单',meals:[{id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'food-l',itemId:'food',quantity:100}]}],supplementDoses:[]}});}
const plan=state=>state.plans[0];
const mark=(state,checked,fields={})=>mutate(state,'set_food_personal_check',{planId:plan(state).id,mealId:'lunch',lineIds:['food-l'],checked,...fields});

test('personal checked and unchecked never write actuals, quantities, accounting, meal completion or nutrition',()=>{
  const original=fixture(), before=structuredClone(original);
  let state=mark(original,true);
  assert.equal(isPersonalFoodChecked(plan(state),'lunch','food-l'),true);
  assert.deepEqual(state.items,original.items);
  const {personalFoodChecks,updatedAt,...content}=plan(state),{updatedAt:oldAt,...prior}=plan(original);
  assert.deepEqual(content,prior);
  assert.equal(personalFoodChecks.checks[0].checked,true);
  assert.deepEqual(plan(state).meals[0].actualEntries,[]);
  assert.deepEqual(plan(state).accountedDebits,[]);
  assert.strictEqual(mark(state,true),state);
  state=mark(state,false);
  assert.equal(isPersonalFoodChecked(plan(state),'lunch','food-l'),false);
  assert.deepEqual(state.items,original.items);
  assert.deepEqual(original,before);
});

test('completed real meals and saved intake drafts do not infer or block personal marks',()=>{
  let state=fixture();
  state=mutate(state,'record_meal_intake',{planId:plan(state).id,mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:'用户明确报告吃完'});
  assert.equal(isPersonalFoodChecked(plan(state),'lunch','food-l'),false);
  state=mutate(state,'save_intake_draft',{planId:plan(state).id,expectedDraftVersion:null,draft:{id:'pending',baseFingerprint:intakePlanFingerprint(plan(state),state.items),consumed:[],transfers:[],completedMealIds:[]}});
  const before=structuredClone(state);
  state=mark(state,true);
  assert.deepEqual(state.items,before.items);
  for(const key of ['meals','intakeDraft','accountedDebits','inventoryAccounting','accountingIssues','supplementDoses']) assert.deepEqual(plan(state)[key],plan(before)[key]);
});

test('personal marks survive menu replacement with stable IDs and stale or unknown lines fail atomically',()=>{
  let state=mark(fixture(),true);
  const marks=structuredClone(plan(state).personalFoodChecks);
  state=mutate(state,'save_meal_plan_draft',{plan:{id:plan(state).id,date:plan(state).date,title:'只改数量',meals:[{id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'food-l',itemId:'food',quantity:120}]}],supplementDoses:[]}});
  assert.deepEqual(plan(state).personalFoodChecks,marks);
  assert.equal(state.items[0].quantity,1000);
  const before=structuredClone(state);
  assert.throws(()=>mark(state,false,{lineIds:['missing']}),error=>error.code==='PLANNED_LINE_NOT_FOUND');
  assert.throws(()=>mark(state,false,{expectedRevision:0}),error=>error.code==='REVISION_CONFLICT');
  assert.deepEqual(state,before);
});

test('whole meal check is a personal reminder only, and original operation retries are idempotent',()=>{
  let state=fixture();
  const payload={action:'set_food_personal_check',operationId:'whole-personal-once',expectedRevision:state.revision,planId:plan(state).id,mealId:'lunch',wholeMeal:true,checked:true};
  state=applyMutation(state,payload,AT);
  assert.equal(isPersonalFoodChecked(plan(state),'lunch','food-l'),true);
  assert.equal(state.items[0].quantity,1000);
  assert.strictEqual(applyMutation(state,payload,AT),state);
  assert.deepEqual(plan(state).meals[0].actualEntries,[]);
  assert.throws(()=>applyMutation(state,{...payload,checked:false},AT),error=>error.code==='OPERATION_ID_CONFLICT');
});
