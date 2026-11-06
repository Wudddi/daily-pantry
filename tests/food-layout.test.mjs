import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMutation} from '../lib/inventory.mjs';
import {foodLayoutTarget,foodLayoutFingerprint} from '../lib/food-layout.mjs';
import {readDietRecords,materializeDietPlanForEdit,readIntakeDraft} from '../lib/diet.mjs';
import {projectCurrentDietPlan} from '../lib/diet-current-plan.mjs';
import {readFoodPlanEditContext} from '../lib/diet-edit-read.mjs';
import {intakePlanFingerprint,intakeDraftView} from '../lib/intake-draft.mjs';
import {DAY,AT,LATER,ID,copy,fixture,plan,meal,mutate,move,recipeMoves,nutrition,canonicalLines,nonLayoutFacts} from './fixtures/food-layout.mjs';

const layout=(state,moves,fields={})=>mutate(state,'set_food_layout',{planId:ID,moves,...fields});
const target=(state,mealId,kind,id)=>foodLayoutTarget(plan(state),mealId,kind,id);

test('moving an already eaten sauce changes only its display meal and follows the proven planned-to-actual link without another nutrient or inventory contribution',()=>{
  const before=fixture(),saved=copy(before),actual=meal(before,'lunch').actualEntries[0],totals=nutrition(before),lines=canonicalLines(before),facts=nonLayoutFacts(before);
  const after=layout(before,[move('lunch','planned','sauce-line','dinner')]);
  assert.equal(target(after,'lunch','planned','sauce-line'),'dinner');
  assert.equal(target(after,'lunch','actual',actual.id),'dinner');
  assert.deepEqual(nonLayoutFacts(after),facts);assert.deepEqual(nutrition(after),totals);assert.deepEqual(canonicalLines(after),lines);
  assert.deepEqual(after.events.slice(0,before.events.length),before.events);
  assert.deepEqual(after.operationIds.slice(0,before.operationIds.length),before.operationIds);
  assert.deepEqual(before,saved);
});

test('a whole mixed-unit recipe can move checked and unchecked ingredients together without scaling quantities or changing recipe membership',()=>{
  const before=fixture(),after=layout(before,recipeMoves('dinner'));
  for(const id of ['square-oats','square-milk','square-egg'])assert.equal(target(after,'breakfast','planned',id),'dinner');
  assert.deepEqual(meal(after,'breakfast').plannedItems.map(row=>[row.id,row.quantity,row.unit]),[
    ['square-oats',40,'g'],['square-milk',90,'ml'],['square-egg',1,'个']]);
  assert.deepEqual(meal(after,'breakfast').recipeGroups,meal(before,'breakfast').recipeGroups);
  assert.deepEqual(plan(after).personalFoodChecks,plan(before).personalFoodChecks);
  assert.deepEqual(nonLayoutFacts(after),nonLayoutFacts(before));
});

test('an actual-only display move does not move or rewrite the original planned row and never guesses a same-SKU association',()=>{
  let state=fixture();
  state=mutate(state,'record_meal_intake',{planId:ID,mealId:'lunch',entries:[{id:'demo-unanchored-sauce',itemId:'demo-sauce',quantity:4,unit:'g',sourceText:'DEMO distinct unanchored sauce report'}]});
  const routed=layout(state,[move('lunch','planned','sauce-line','dinner')]);
  assert.equal(target(routed,'lunch','actual','demo-unanchored-sauce'),'lunch','a unique matching SKU is not a proven actual link');
  const before=copy(state),after=layout(state,[move('lunch','actual','demo-unanchored-sauce','breakfast')]);
  assert.equal(target(after,'lunch','actual','demo-unanchored-sauce'),'breakfast');
  assert.equal(target(after,'lunch','planned','sauce-line'),'lunch');
  const moved=layout(after,[move('lunch','planned','sauce-line','dinner')]);
  assert.equal(target(moved,'lunch','actual','demo-unanchored-sauce'),'breakfast');
  assert.deepEqual(nonLayoutFacts(moved),nonLayoutFacts(before));
});

test('saved intake drafts remain byte-for-byte present, current and unsubmitted during a display move',()=>{
  const before=fixture({pending:true}),fingerprint=intakePlanFingerprint(plan(before),before.items),after=layout(before,recipeMoves('dinner'));
  assert.deepEqual(plan(after).intakeDraft,plan(before).intakeDraft);
  assert.equal(intakePlanFingerprint(plan(after),after.items),fingerprint);
  assert.equal(intakeDraftView(plan(after),after.items).stale,false);
  assert.deepEqual(nonLayoutFacts(after),nonLayoutFacts(before));
});

test('moves merge by original source, preserve unrelated overrides, revert when returned to their source and treat empty moves as a no-op',()=>{
  const original=fixture();let state=layout(original,[move('lunch','planned','sauce-line','dinner')]);
  state=layout(state,[move('breakfast','planned','square-oats','dinner')]);
  assert.equal(target(state,'lunch','planned','sauce-line'),'dinner');assert.equal(target(state,'breakfast','planned','square-oats'),'dinner');
  assert.strictEqual(layout(state,[]),state);
  state=layout(state,[move('lunch','planned','sauce-line','lunch')]);
  assert.equal(target(state,'lunch','planned','sauce-line'),'lunch');
  assert.equal(target(state,'lunch','actual',meal(state,'lunch').actualEntries[0].id),'lunch');
  assert.equal(target(state,'breakfast','planned','square-oats'),'dinner');
  assert.ok(plan(state).foodLayoutHistory.length>=3);
  assert.deepEqual(nonLayoutFacts(state),nonLayoutFacts(original));
});

test('layout retries and identical assignments are idempotent while stale revisions and layout fingerprints reject atomically',()=>{
  const before=fixture(),fingerprint=foodLayoutFingerprint(plan(before)),payload={action:'set_food_layout',planId:ID,moves:recipeMoves('dinner'),
    expectedRevision:before.revision,expectedFingerprint:fingerprint,operationId:'demo-fixed-layout-operation'};
  const after=applyMutation(before,payload,LATER),saved=copy(after);
  assert.strictEqual(applyMutation(after,payload,LATER),after);assert.strictEqual(layout(after,recipeMoves('dinner')),after);
  assert.notEqual(foodLayoutFingerprint(plan(after)),fingerprint);
  assert.throws(()=>applyMutation(after,{...payload,operationId:'demo-stale-layout-revision'},LATER),error=>error.code==='REVISION_CONFLICT');
  assert.throws(()=>layout(after,[move('breakfast','planned','square-oats','lunch')],{expectedFingerprint:fingerprint}),error=>error.code==='FOOD_LAYOUT_STALE');
  assert.deepEqual(after,saved);
});

test('source boundaries, source kinds, duplicate assignments, target meals and unsupported payload fields validate before any write',()=>{
  const before=fixture(),saved=copy(before),valid=move('breakfast','planned','square-oats','dinner');
  for(const moves of [null,[{...valid,sourceMealId:'foreign-meal'}],[{...valid,sourceId:'rice-line'}],
    [{...valid,sourceKind:'actual'}],[{...valid,sourceKind:'inventory'}],[{...valid,targetMealId:'foreign-meal'}],
    [valid,{...valid,targetMealId:'lunch'}],[{...valid,quantity:7}],[valid,{...valid,sourceId:'missing-row'}]]){
    assert.throws(()=>layout(before,moves),error=>error.code==='INVALID_FOOD_LAYOUT'&&error.status===400);assert.deepEqual(before,saved);
  }
  assert.throws(()=>layout(before,[valid],{entries:[]}),error=>error.status===400);assert.deepEqual(before,saved);
});

test('layout reads are detached and legacy draft materialization preserves source facts and display assignments',()=>{
  const state=layout(fixture(),recipeMoves('dinner')),saved=copy(state),p=plan(state);
  assert.deepEqual(readDietRecords(state,{planId:ID}).records[0].foodLayoutOverrides,p.foodLayoutOverrides);
  const edit=materializeDietPlanForEdit(state,ID);assert.deepEqual(edit.foodLayoutOverrides,p.foodLayoutOverrides);
  edit.foodLayoutOverrides[0].targetMealId='lunch';assert.deepEqual(state,saved);
  const context=readFoodPlanEditContext(state,{planId:ID});
  assert.deepEqual(context.plan.foodLayoutOverrides,p.foodLayoutOverrides);
  assert.equal(context.plan.foodLayoutFingerprint,foodLayoutFingerprint(p));
  const draft=readIntakeDraft(state,{planId:ID});assert.deepEqual(draft.foodLayoutOverrides,p.foodLayoutOverrides);
  assert.equal(draft.foodLayoutFingerprint,foodLayoutFingerprint(p));
  context.plan.foodLayoutOverrides[0].targetMealId='lunch';draft.foodLayoutOverrides[0].targetMealId='lunch';assert.deepEqual(state,saved);
  const legacy=copy(p);legacy.draft={id:ID,date:DAY,title:'DEMO nested visual draft',meals:copy(p.meals)};
  const snapshot=copy(legacy),projected=projectCurrentDietPlan(legacy,state.items);
  assert.deepEqual(projected.foodLayoutOverrides,p.foodLayoutOverrides);assert.deepEqual(legacy,snapshot);
});

test('display assignment works on historical closed or cancelled actuals without reopening them or changing their byte-level evidence',()=>{
  for(const status of ['closed_with_actuals','cancelled']){
    const before=fixture();plan(before).status=status;const actual=meal(before,'lunch').actualEntries[0],source=JSON.stringify(meal(before,'lunch'));
    const after=layout(before,[move('lunch','actual',actual.id,'dinner')]);
    assert.equal(plan(after).status,status);assert.equal(JSON.stringify(meal(after,'lunch')),source);
    assert.deepEqual(nonLayoutFacts(after),nonLayoutFacts(before));
  }
});

test('a display reassignment after settlement cannot deduct an already eaten amount a second time',()=>{
  let state=fixture();state.dailyMenuSettlementPolicy.enabled=true;
  const settle=s=>mutate(s,'settle_daily_menu',{planId:ID,effectiveDate:DAY,policyStartDate:DAY,confirmed:true},'2026-04-10T05:00:00.000Z');
  state=settle(state);const items=copy(state.items),debits=copy(plan(state).accountedDebits),actuals=copy(plan(state).meals.map(m=>m.actualEntries));
  state=layout(state,[move('lunch','planned','sauce-line','dinner')]);state=settle(state);
  assert.deepEqual(state.items,items);assert.deepEqual(plan(state).accountedDebits,debits);assert.deepEqual(plan(state).meals.map(m=>m.actualEntries),actuals);
});

test('valid 400-character legacy actual IDs remain movable and groupable while oversized actual and planned layout IDs reject atomically',()=>{
  const actualId='demo-'+ 'x'.repeat(395);assert.equal(actualId.length,400);
  let state=fixture();state=mutate(state,'record_meal_intake',{planId:ID,mealId:'lunch',entries:[{id:actualId,itemId:'demo-sauce',quantity:2,unit:'g',sourceText:'DEMO legacy long record ID'}]});
  state=mutate(state,'set_actual_recipe_groups',{planId:ID,mealId:'lunch',groups:[{id:'demo-legacy-id-recipe',name:'DEMO sauce cup',actualEntryIds:[actualId],portion:0.5}]});
  const before=copy(state),after=layout(state,[move('lunch','actual',actualId,'dinner')]);
  assert.equal(target(after,'lunch','actual',actualId),'dinner');assert.deepEqual(nonLayoutFacts(after),nonLayoutFacts(before));
  const saved=copy(after);
  for(const source of [move('lunch','actual',actualId+'x','dinner'),move('breakfast','planned','p'.repeat(101),'dinner')]){
    assert.throws(()=>layout(after,[source]),error=>error.code==='INVALID_FOOD_LAYOUT'&&error.status===400);assert.deepEqual(after,saved);
  }
});
