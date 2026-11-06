import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMutation} from '../lib/inventory.mjs';
import {previewFoodPlanSync} from '../lib/sync-food-plan.mjs';
import {intakeDraftView,intakePlanFingerprint,intakeTransferLineId} from '../lib/intake-draft.mjs';
import {projectCurrentDietPlan} from '../lib/diet-current-plan.mjs';
import {AT,DAY,ID,LATER,copy,fixture,meal,mutate,nutrientValues,plan,preserved,stock} from './fixtures/sync-food-plan.mjs';

let sequence=0;
const preview=state=>previewFoodPlanSync(plan(state),state.items);
const request=(state,patch={})=>({action:'sync_food_plan',planId:ID,operationId:'demo-sync-'+(++sequence),expectedRevision:state.revision,expectedFingerprint:preview(state).fingerprint,...patch});
const sync=(state,patch={})=>applyMutation(state,request(state,patch),LATER);
const quantities=entity=>Object.fromEntries(entity.plannedItems.map(row=>[row.itemId,row.quantity]));

test('preview is read-only and applying sync aligns completed additions, replacements and amounts while retaining unreported meals and all non-plan evidence',()=>{
  const before=fixture(),snapshot=copy(before),facts=preserved(before),totals=nutrientValues(plan(before)),view=preview(before);
  assert.equal(view.canApply,true);assert.equal(view.noChange,false);
  const changed=view.meals.find(m=>m.mealId==='breakfast');
  assert.equal(changed.changed,true);
  for(const kind of ['add','update','remove'])assert.ok(changed.changes.some(change=>change.kind===kind),kind);
  assert.deepEqual(before,snapshot);
  const after=sync(before);
  assert.deepEqual(quantities(meal(after)),{'demo-cereal':60,'demo-fruit':1});
  assert.deepEqual(meal(after,'lunch'),meal(before,'lunch'));
  assert.deepEqual(meal(after,'dinner'),meal(before,'dinner'));
  assert.deepEqual(preserved(after),facts);
  assert.deepEqual(nutrientValues(plan(after)),totals);
  assert.deepEqual(meal(after).planRevisionHistory.slice(0,-1),meal(before).planRevisionHistory);
  assert.deepEqual(meal(after).planRevisionHistory.at(-1).previous.plannedItems,meal(before).plannedItems);
  assert.deepEqual(before,snapshot);
});

test('sync copies saved actual nutrition and weighed-unit evidence rather than refreshing it from live inventory labels',()=>{
  const state=fixture({groups:false}),actual=meal(state).actualEntries.find(e=>e.itemId==='demo-fruit');
  actual.nutritionSnapshot.gramsPerUnit=125;
  Object.assign(actual.nutritionSnapshot.nutrition,{basisAmount:100,basisUnit:'g',kcal:80,protein:2,carbs:16,fat:0.2,source:'estimate',sourceText:'DEMO verified actual snapshot'});
  actual.nutritionCorrectionHistory=[{at:AT,sourceText:'DEMO prior correction',previous:copy(actual.nutritionSnapshot)}];
  const live=state.items.find(item=>item.id==='demo-fruit');live.quantity=0;live.status='depleted';live.nutrition.kcal=999;live.gramsPerUnit=200;
  const before=copy(state),totals=nutrientValues(plan(state)),after=sync(state),saved=meal(after).plannedItems.find(row=>row.itemId==='demo-fruit');
  assert.deepEqual(saved.nutritionSnapshot,actual.nutritionSnapshot);
  assert.equal(saved.quantity,1);assert.equal(saved.unit,'个');
  assert.deepEqual(nutrientValues(plan(after)),totals);
  assert.deepEqual(preserved(after),preserved(before));
});

test('partial meals retain unreported amounts and never change effective daily nutrition when aligned',()=>{
  for(const amount of [40,120]){
    let state=fixture({groups:false});
    state=mutate(state,'record_meal_intake',{planId:ID,mealId:'lunch',entries:[{id:'demo-partial-cereal',itemId:'demo-cereal',quantity:amount,unit:'g',sourceText:'DEMO partial report'}]});
    const before=copy(state),totals=nutrientValues(plan(state)),after=sync(state);
    assert.equal(quantities(meal(after,'lunch'))['demo-cereal'],Math.max(80,amount));
    assert.equal(quantities(meal(after,'lunch'))['demo-milk'],100);
    assert.deepEqual(nutrientValues(plan(after)),totals);
    assert.deepEqual(preserved(after),preserved(before));
  }
});

test('the same operation retries exactly once and a fresh sync is a no-op when food plans already match',()=>{
  const before=fixture(),payload=request(before),after=applyMutation(before,payload,LATER);
  assert.strictEqual(applyMutation(after,payload,LATER),after);
  assert.equal(preview(after).noChange,true);
  assert.strictEqual(sync(after),after);
});

test('revision and preview fingerprint conflicts reject atomically instead of applying an old preview to new facts',()=>{
  const before=fixture(),snapshot=copy(before),payload=request(before,{expectedRevision:before.revision-1});
  assert.throws(()=>applyMutation(before,payload,LATER),error=>error.code==='REVISION_CONFLICT');
  assert.deepEqual(before,snapshot);
  const oldFingerprint=preview(before).fingerprint;
  const changed=mutate(before,'record_meal_intake',{planId:ID,mealId:'breakfast',mode:'correct',entries:[{id:'demo-eaten-cereal',itemId:'demo-cereal',quantity:61,unit:'g',sourceText:'DEMO corrected actual quantity'}]});
  const saved=copy(changed);
  assert.notEqual(preview(changed).fingerprint,oldFingerprint);
  assert.throws(()=>sync(changed,{expectedFingerprint:oldFingerprint}),error=>error.status===409);
  assert.deepEqual(changed,saved);
});

test('closed or cancelled menus and a missing preview fingerprint cannot be silently reopened or synced',()=>{
  for(const status of ['cancelled','closed_with_actuals']){
    const state=fixture();plan(state).status=status;const before=copy(state);
    assert.equal(preview(state).canApply,false);
    assert.throws(()=>sync(state),error=>error.status===409);
    assert.deepEqual(state,before);
  }
  const state=fixture(),before=copy(state),payload=request(state);delete payload.expectedFingerprint;
  assert.throws(()=>applyMutation(state,payload,LATER),error=>error.status===400||error.status===409);
  assert.deepEqual(state,before);
});

test('an unsubmitted intake draft blocks sync without discarding, submitting or modifying any part of the draft',()=>{
  let state=fixture();
  state=mutate(state,'save_intake_draft',{planId:ID,expectedDraftVersion:null,draft:{id:'demo-pending-draft',baseFingerprint:intakePlanFingerprint(plan(state),state.items),
    consumed:[{mealId:'lunch',lineId:'l-cereal',quantity:20,unit:'g'}],transfers:[],completedMealIds:[]}});
  const before=copy(state),view=preview(state);
  assert.equal(view.hasIntakeDraft,true);assert.equal(view.canApply,false);
  assert.ok(view.issues.some(issue=>issue.code==='INTAKE_DRAFT_PENDING'));
  assert.throws(()=>sync(state),error=>error.code==='INTAKE_DRAFT_PENDING');
  assert.deepEqual(state,before);
  assert.equal(intakeDraftView(plan(state),state.items).stale,false);
});

test('pending legacy accounting does not block a plan-only alignment or silently resolve old issues',()=>{
  const state=fixture();plan(state).inventoryAccounting='pending_reconciliation';
  plan(state).accountingIssues=[{code:'DEMO_ACCOUNT_REVIEW',itemId:'demo-cereal',message:'DEMO historical account retained'}];
  plan(state).accountingWarnings=[{code:'DEMO_WARNING',itemId:'demo-cereal',quantity:2,unit:'g'}];
  const before=copy(state),after=sync(state);
  assert.deepEqual(preserved(after),preserved(before));
  assert.equal(plan(after).inventoryAccounting,'pending_reconciliation');
});

test('recipe references stay stable when provable and never attach an actual-only side food to an unrelated dish',()=>{
  const before=fixture(),after=sync(before),source=meal(before).recipeGroups[0];
  for(const group of meal(after).recipeGroups??[]){
    assert.equal(group.id,source.id);assert.equal(group.name,source.name);
    assert.ok(group.lineIds.every(id=>meal(after).plannedItems.some(line=>line.id===id)));
    assert.ok(group.lineIds.every(id=>meal(after).plannedItems.find(line=>line.id===id).itemId==='demo-cereal'));
  }
  const actualOnly=meal(after).plannedItems.find(line=>line.itemId==='demo-fruit');
  assert.ok(!(meal(after).recipeGroups??[]).some(group=>group.lineIds.includes(actualOnly.id)));
  if(meal(after).plannedItems.some(line=>line.id==='bf-cereal'))assert.equal(meal(after).plannedItems.find(line=>line.id==='bf-cereal').quantity,60);
});

test('unknown actual quantities are refused and ambiguous recipe association is never fabricated',()=>{
  const unknown=fixture();meal(unknown).actualEntries[0].quantity=null;
  const before=copy(unknown),view=preview(unknown);
  assert.equal(view.canApply,false);assert.ok(view.issues.length>0);
  assert.throws(()=>sync(unknown),error=>error.status===409);
  assert.deepEqual(unknown,before);
  let ambiguous=fixture();
  ambiguous=mutate(ambiguous,'patch_meal_plan',{planId:ID,mode:'draft',mealPatches:[{id:'breakfast',itemPatches:[{id:'bf-second-cereal',itemId:'demo-cereal',quantity:20}],
    recipeGroups:[{id:'demo-bowl',name:'DEMO bowl',lineIds:['bf-cereal']},{id:'demo-other-bowl',name:'DEMO other bowl',lineIds:['bf-second-cereal']}]}]});
  const prior=copy(ambiguous);
  const uncertain=preview(ambiguous);
  if(uncertain.canApply){
    assert.ok(uncertain.issues.some(issue=>issue.code==='SYNC_RECIPE_GROUPS_REMOVED'&&issue.severity==='warning'));
    const after=sync(ambiguous);
    assert.deepEqual(meal(after).recipeGroups,[]);
    assert.deepEqual(nutrientValues(plan(after)),nutrientValues(plan(prior)));
    assert.deepEqual(preserved(after),preserved(prior));
  }else{
    assert.ok(uncertain.issues.some(issue=>issue.severity==='skip'));
    assert.throws(()=>sync(ambiguous),error=>error.status===409);
    assert.deepEqual(ambiguous,prior);
  }
});

test('an unsupported partial meal stays unchanged while independently supported completed food can still sync',()=>{
  let state=fixture({groups:false});
  state=mutate(state,'record_meal_intake',{planId:ID,mealId:'lunch',entries:[{id:'demo-unknown-lunch',itemId:'demo-cereal',quantity:1,unit:'袋',sourceText:'DEMO incompatible partial unit'}]});
  const before=copy(state),view=preview(state),unsupported=view.meals.find(entry=>entry.mealId==='lunch');
  assert.equal(view.canApply,true);assert.equal(unsupported.supported,false);assert.equal(unsupported.changed,false);
  assert.ok(view.issues.some(issue=>issue.mealId==='lunch'&&issue.severity==='skip'));
  const after=sync(state);
  assert.deepEqual(quantities(meal(after)),{'demo-cereal':60,'demo-fruit':1});
  assert.deepEqual(meal(after,'lunch'),meal(before,'lunch'));
  assert.deepEqual(nutrientValues(plan(after)),nutrientValues(plan(before)));
  assert.deepEqual(preserved(after),preserved(before));
});

test('a completed meal keeps explicit incoming remainder lines without dropping or counting that future food twice',()=>{
  let state=fixture({groups:false});const transferId=intakeTransferLineId(ID,'demo-incoming');
  state=mutate(state,'patch_meal_plan',{planId:ID,mode:'draft',mealPatches:[{id:'breakfast',itemPatches:[{id:transferId,itemId:'demo-milk',quantity:40}]}]});
  const before=copy(state),totals=nutrientValues(plan(state)),after=sync(state),incoming=meal(after).plannedItems.find(row=>row.id===transferId);
  assert.ok(incoming);assert.equal(incoming.quantity,40);assert.equal(incoming.itemId,'demo-milk');
  assert.deepEqual(nutrientValues(plan(after)),totals);
  assert.deepEqual(preserved(after),preserved(before));
});

test('null actual snapshots cannot change their first compatible planned fallback through row reordering',()=>{
  let state=fixture({groups:false});
  state=mutate(state,'patch_meal_plan',{planId:ID,mode:'draft',mealPatches:[{id:'breakfast',itemPatches:[{id:'bf-other-cereal',itemId:'demo-cereal',quantity:10,
    nutrition:{basisAmount:100,basisUnit:'g',kcal:100,protein:1,carbs:2,fat:0.5,source:'estimate',sourceText:'DEMO second distinct plan-only estimate'}}]}]});
  meal(state).actualEntries.find(entry=>entry.itemId==='demo-cereal').nutritionSnapshot=null;
  const before=copy(state),totals=nutrientValues(plan(state)),view=preview(state);
  if(view.canApply){const after=sync(state);assert.deepEqual(nutrientValues(plan(after)),totals);assert.deepEqual(preserved(after),preserved(before));}
  else {assert.ok(view.issues.length>0);assert.throws(()=>sync(state),error=>error.status===409);assert.deepEqual(state,before);}
});

test('multiple unanchored reports of one SKU cannot become newly ambiguous or uneaten after syncing the planned checklist',()=>{
  const state=fixture({groups:false}),breakfast=meal(state),first=breakfast.actualEntries.find(entry=>entry.itemId==='demo-cereal');
  first.quantity=30;
  breakfast.actualEntries.push({...copy(first),id:'demo-second-cereal-report',quantity:30,sourceText:'DEMO separate second report'});
  const before=copy(state),totals=nutrientValues(plan(state)),view=preview(state);
  if(view.canApply){
    const after=sync(state),rows=intakeDraftView(plan(after),after.items,null).meals.find(entry=>entry.id==='breakfast').rows;
    assert.ok(rows.every(row=>!row.unknown));
    assert.equal(rows.filter(row=>row.itemId==='demo-cereal').reduce((sum,row)=>sum+row.reportedQuantity,0),60);
    assert.equal(rows.filter(row=>row.itemId==='demo-cereal').reduce((sum,row)=>sum+row.remainingQuantity,0),0);
    assert.deepEqual(nutrientValues(plan(after)),totals);
    assert.deepEqual(preserved(after),preserved(before));
  }else{
    assert.ok(view.issues.length>0);
    assert.throws(()=>sync(state),error=>error.status===409);
    assert.deepEqual(state,before);
  }
});

test('legacy nested drafts are materialized without replacing the parent actual, supplement or accounting facts',()=>{
  const state=fixture({groups:false}),p=plan(state);
  p.draft={id:p.id,date:p.date,title:'DEMO legacy current menu',meals:copy(p.meals),supplementDoses:copy(p.supplementDoses)};
  p.draft.meals[1].plannedItems[0].quantity=90;
  p.draft.meals[0].actualEntries=[];
  const before=copy(state),current=projectCurrentDietPlan(p,state.items),totals=nutrientValues(current),after=sync(state);
  assert.deepEqual(meal(after).actualEntries,meal(before).actualEntries);
  assert.deepEqual(plan(after).supplementDoses,plan(before).supplementDoses);
  assert.deepEqual(plan(after).accountedDebits,plan(before).accountedDebits);
  assert.deepEqual(after.items,before.items);
  assert.deepEqual(nutrientValues(projectCurrentDietPlan(plan(after),after.items)),totals);
  assert.equal(quantities(meal(after,'lunch'))['demo-cereal'],90);
});

test('later actual correction and day-end settlement still adjust only unaccounted differences after plan sync',()=>{
  const original=fixture({groups:false,enabled:true}),synced=sync(original);
  const corrected=mutate(synced,'record_meal_intake',{planId:ID,mealId:'breakfast',mode:'correct',entries:[{id:'demo-eaten-cereal',itemId:'demo-cereal',quantity:70,unit:'g',sourceText:'DEMO later corrected cumulative amount'}]});
  assert.equal(stock(corrected,'demo-cereal'),stock(synced,'demo-cereal')-10);
  assert.equal(stock(corrected,'demo-fruit'),stock(synced,'demo-fruit'));
  const settle=state=>mutate(state,'settle_daily_menu',{planId:ID,effectiveDate:DAY,policyStartDate:DAY,confirmed:true},'2026-02-13T05:00:00.000Z');
  const plainSettled=settle(original),syncSettled=settle(synced);
  assert.deepEqual(syncSettled.items,plainSettled.items);
  assert.equal(stock(syncSettled,'demo-cereal'),1000-60-80);
  assert.equal(stock(syncSettled,'demo-fruit'),5-1-1);
  assert.equal(stock(syncSettled,'demo-milk'),900);
  assert.strictEqual(settle(syncSettled),syncSettled);
});
