import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMutation} from '../lib/inventory.mjs';
import {readDietRecords,materializeDietPlanForEdit} from '../lib/diet.mjs';
import {projectCurrentDietPlan} from '../lib/diet-current-plan.mjs';
import {intakePlanFingerprint} from '../lib/intake-draft.mjs';
import {previewFoodPlanSync} from '../lib/sync-food-plan.mjs';
import {groupMealRecipeRows,recipeIngredientDisplayName} from '../lib/meal-recipe-groups-view.mjs';
import {mealNutritionView} from '../lib/meal-nutrition-view.mjs';
import {DAY,AT,LATER,ID,copy,fixture,plan,breakfast,snack,mutate,explicitGroups,nonGroupingFacts,nutrition} from './fixtures/actual-recipe-groups.mjs';

const setGroups=(state,groups=explicitGroups(),fields={})=>mutate(state,'set_actual_recipe_groups',{planId:ID,mealId:'breakfast',groups,...fields});
const recipes=(state)=>groupMealRecipeRows(breakfast(state),mealNutritionView(breakfast(state),{planId:ID}).actualRows,{planId:ID}).filter(s=>s.kind==='recipe');

test('actual dish metadata separates two recipes sharing yogurt and egg without changing any intake, nutrition, reminders or inventory facts',()=>{
  const before=fixture(),snapshot=copy(before),facts=nonGroupingFacts(before),totals=nutrition(before),after=setGroups(before);
  assert.equal(breakfast(after).actualEntries.length,17);
  assert.deepEqual(breakfast(after).actualRecipeGroups,explicitGroups());
  assert.deepEqual(recipes(after).map(section=>[section.name,section.rows.length]),[['DEMO cocoa plum squares',9],['DEMO citrus custard',6]]);
  assert.deepEqual(nonGroupingFacts(after),facts);
  assert.deepEqual(nutrition(after),totals);
  assert.deepEqual(after.events.slice(0,before.events.length),before.events);
  assert.deepEqual(after.operationIds.slice(0,before.operationIds.length),before.operationIds);
  assert.deepEqual(snack(after),snack(before));
  assert.deepEqual(before,snapshot);
});

test('actual group references validate atomically against this meal and reject duplicates, unsupported fields and invalid portions',()=>{
  const state=fixture(),before=copy(state),groups=explicitGroups();
  const invalid=[null,[{...groups[0],actualEntryIds:[]}],[{...groups[0],actualEntryIds:['snack-square-yogurt']}],
    [{...groups[0],actualEntryIds:['actual-square-yogurt','actual-square-yogurt']}],
    [groups[0],{...groups[1],actualEntryIds:['actual-square-yogurt']}],
    [groups[0],{...groups[1],id:groups[0].id}],[{...groups[0],portion:0}],[{...groups[0],portion:101}],
    [{...groups[0],quantity:999}],[{...groups[0],nutrition:{kcal:0}}]];
  for(const value of invalid){
    assert.throws(()=>setGroups(state,value),error=>error.status===400&&error.code==='INVALID_ACTUAL_RECIPE_GROUPS');
    assert.deepEqual(state,before);
  }
  assert.throws(()=>mutate(state,'set_actual_recipe_groups',{planId:ID,mealId:'snack',groups}),error=>error.status===400);
  assert.deepEqual(state,before);
  const other=mutate(state,'record_meal_intake',{planId:ID,mealId:'snack',entries:[{id:'demo-foreign-actual',itemId:'demo-yogurt',quantity:3,unit:'g',sourceText:'DEMO other meal'}]}),saved=copy(other);
  assert.throws(()=>setGroups(other,[{...groups[0],actualEntryIds:['demo-foreign-actual']}]),error=>error.code==='INVALID_ACTUAL_RECIPE_GROUPS');
  assert.deepEqual(other,saved);
});

test('metadata retries are idempotent, identical metadata is a no-op, and stale revisions cannot overwrite newer grouping',()=>{
  const before=fixture(),payload={action:'set_actual_recipe_groups',planId:ID,mealId:'breakfast',groups:explicitGroups(),operationId:'demo-fixed-grouping-operation',expectedRevision:before.revision};
  const after=applyMutation(before,payload,LATER);
  assert.strictEqual(applyMutation(after,payload,LATER),after);
  assert.strictEqual(setGroups(after),after);
  const stale={...payload,operationId:'demo-stale-grouping-operation',groups:[]},saved=copy(after);
  assert.throws(()=>applyMutation(after,stale,LATER),error=>error.code==='REVISION_CONFLICT');
  assert.deepEqual(after,saved);
});

test('reports preserve omitted actual grouping, accept explicit grouping after entry creation and permit explicit clearing with an audit trail',()=>{
  let state=fixture({withGroups:true});
  assert.deepEqual(breakfast(state).actualRecipeGroups,explicitGroups());
  const entry=copy(breakfast(state).actualEntries[0]);
  state=mutate(state,'record_meal_intake',{planId:ID,mealId:'breakfast',mode:'correct',entries:[{id:entry.id,itemId:entry.itemId,quantity:entry.quantity+1,unit:entry.unit,sourceText:'DEMO corrected quantity only'}]});
  assert.deepEqual(breakfast(state).actualRecipeGroups,explicitGroups());
  const before=copy(state);state=setGroups(state,[]);
  assert.deepEqual(breakfast(state).actualRecipeGroups,[]);
  assert.deepEqual(nonGroupingFacts(state),nonGroupingFacts(before));
  assert.ok(breakfast(state).actualRecipeGroupHistory.some(change=>JSON.stringify(change).includes('demo-custard')));
  const snapshot=copy(state);
  assert.throws(()=>mutate(state,'record_meal_intake',{planId:ID,mealId:'breakfast',actualRecipeGroups:explicitGroups()}),error=>error.code==='ACTUAL_RECIPE_GROUPS_REQUIRE_METADATA_TOOL');
  assert.deepEqual(state,snapshot);
});

test('group metadata is detached in read and legacy projection paths and does not invalidate a pending intake draft',()=>{
  let state=setGroups(fixture());
  state=mutate(state,'save_intake_draft',{planId:ID,expectedDraftVersion:null,draft:{id:'demo-pending-recipes',baseFingerprint:intakePlanFingerprint(plan(state),state.items),consumed:[],transfers:[],completedMealIds:[]}});
  const before=copy(state),fingerprint=intakePlanFingerprint(plan(state),state.items),renamed=explicitGroups();renamed[0].name='DEMO renamed square';
  const after=setGroups(state,renamed);
  assert.equal(intakePlanFingerprint(plan(after),after.items),fingerprint);
  assert.deepEqual(plan(after).intakeDraft,plan(before).intakeDraft);
  const records=readDietRecords(after,{planId:ID}),edit=materializeDietPlanForEdit(after,ID);
  assert.deepEqual(records.records[0].meals[0].actualRecipeGroups,renamed);
  edit.meals[0].actualRecipeGroups[0].name='DEMO local-only edit';
  assert.equal(breakfast(after).actualRecipeGroups[0].name,'DEMO renamed square');
  const legacy=copy(plan(after));legacy.draft={id:ID,date:DAY,title:'DEMO nested draft',meals:[{...copy(snack(after)),title:'DEMO changed snack'}]};
  const legacyBefore=copy(legacy),projected=projectCurrentDietPlan(legacy,after.items);
  assert.deepEqual(projected.meals.find(m=>m.id==='breakfast').actualRecipeGroups,renamed);
  assert.deepEqual(legacy,legacyBefore);
});

test('a batch report validates actual recipe IDs after saving its own entries and rejects a cross-meal reference atomically',()=>{
  const before=fixture({reported:false}),entry={id:'demo-batch-yogurt',itemId:'demo-yogurt',quantity:41,unit:'g',sourceText:'DEMO batch report'};
  const group={id:'demo-batch-dish',name:'DEMO yogurt cup',actualEntryIds:[entry.id],portion:0.5};
  const after=mutate(before,'record_meal_intake',{planId:ID,meals:[{mealId:'breakfast',mode:'complete',entries:[entry],actualRecipeGroups:[group]}]});
  assert.deepEqual(breakfast(after).actualRecipeGroups,[group]);
  const snapshot=copy(before);
  assert.throws(()=>mutate(before,'record_meal_intake',{planId:ID,meals:[{mealId:'breakfast',mode:'complete',entries:[entry],actualRecipeGroups:[{...group,actualEntryIds:['demo-batch-other']}]},
    {mealId:'snack',mode:'complete',entries:[{...entry,id:'demo-batch-other'}]}]}),error=>error.status===400);
  assert.deepEqual(before,snapshot);
});

test('sync copies explicit actual dish membership onto corresponding planned rows and retains quantities, frozen nutrition and all original facts',()=>{
  const before=setGroups(fixture()),totals=nutrition(before),actuals=copy(breakfast(before).actualEntries),view=previewFoodPlanSync(plan(before),before.items);
  assert.equal(view.canApply,true);
  const after=mutate(before,'sync_food_plan',{planId:ID,expectedFingerprint:view.fingerprint});
  assert.deepEqual(breakfast(after).actualEntries,actuals);
  assert.deepEqual(breakfast(after).actualRecipeGroups,explicitGroups());
  assert.deepEqual(nutrition(after),totals);
  assert.deepEqual(after.items,before.items);
  assert.deepEqual(plan(after).accountedDebits,plan(before).accountedDebits);
  assert.deepEqual(snack(after),snack(before));
  const m=breakfast(after),groups=m.recipeGroups;
  assert.deepEqual(groups.map(g=>[g.name,g.lineIds.length,g.portion]),explicitGroups().map(g=>[g.name,g.actualEntryIds.length,g.portion]));
  for(const group of groups){
    const original=explicitGroups().find(g=>g.name===group.name);
    const members=group.lineIds.flatMap(id=>m.plannedItems.find(row=>row.id===id).syncActualEntryIds??[]);
    assert.deepEqual(members.sort(),copy(original.actualEntryIds).sort());
  }
  assert.equal(m.plannedItems.filter(row=>!groups.some(g=>g.lineIds.includes(row.id))).length,2);
});

test('metadata changes never add a second stock deduction during follow-on settlement',()=>{
  let state=fixture(),groups=explicitGroups();
  state.dailyMenuSettlementPolicy.enabled=true;
  state=mutate(state,'settle_daily_menu',{planId:ID,effectiveDate:DAY,policyStartDate:DAY,confirmed:true},'2026-03-19T05:00:00.000Z');
  const stock=copy(state.items),debits=copy(plan(state).accountedDebits);
  state=setGroups(state,groups);
  state=mutate(state,'settle_daily_menu',{planId:ID,effectiveDate:DAY,policyStartDate:DAY,confirmed:true},'2026-03-19T05:05:00.000Z');
  assert.deepEqual(state.items,stock);
  assert.deepEqual(plan(state).accountedDebits,debits);
});

test('explicit actual IDs override stale planned anchors, and an explicit empty grouping prevents legacy inferred dishes',()=>{
  const state=fixture(),m=breakfast(state);
  m.actualEntries.find(e=>e.id==='actual-custard-yogurt').intakeLineId='planned-square-yogurt';
  m.actualRecipeGroups=explicitGroups();
  const rows=mealNutritionView(m,{planId:ID}).actualRows,before=copy(m),sections=groupMealRecipeRows(m,rows,{planId:ID});
  assert.deepEqual(sections.filter(s=>s.kind==='recipe').map(s=>[s.source,s.portion,s.rows.length]),[['actual',0.5,9],['actual',0.5,6]]);
  const custard=sections.find(s=>s.name==='DEMO citrus custard');
  assert.ok(custard.rows.some(row=>row.id==='actual-custard-yogurt'));
  assert.equal(sections.flatMap(s=>s.rows).length,17);
  assert.deepEqual(m,before);
  m.actualRecipeGroups=[];
  assert(groupMealRecipeRows(m,rows,{planId:ID}).every(s=>s.kind==='food'));
});

test('partial aggregates cannot inherit one recipe when their actual contributors span two explicit dishes',()=>{
  const state=fixture(),m=breakfast(state);m.state='in_progress';m.actualRecipeGroups=explicitGroups();
  m.actualEntries.find(row=>row.id==='actual-custard-egg').quantity=45;
  const before=copy(m),view=mealNutritionView(m,{planId:ID}),sections=groupMealRecipeRows(m,view.rows,{planId:ID});
  for(const itemId of ['demo-yogurt','demo-egg']){
    const row=view.rows.find(row=>row.itemId===itemId);assert.ok(row,itemId);
    const section=sections.find(s=>s.rows.includes(row));assert.equal(section.kind,'food',itemId);
  }
  assert.equal(new Set(sections.flatMap(s=>s.rows)).size,view.rows.length);
  assert.deepEqual(m,before);
});

test('legacy partial reports without exact line evidence never inherit a dish solely from a matching SKU',()=>{
  const state=fixture(),m=breakfast(state);m.state='in_progress';
  const view=mealNutritionView(m,{planId:ID}),sections=groupMealRecipeRows(m,view.actualRows,{planId:ID});
  assert(sections.every(s=>s.kind==='food'));
  assert.equal(sections.length,17);
  assert.equal(sections.flatMap(s=>s.rows).filter(row=>row.itemId==='demo-yogurt').length,2);
});

test('ingredient prefix cleaning is exact presentation metadata and never rewrites names or strips an unrelated phrase',()=>{
  const section={kind:'recipe',id:'actual:demo-square',name:'DEMO cocoa plum squares',source:'actual',portion:0.5},
    prefix='\u534a\u4efd'+section.name+'\uff1a',row={id:'demo-prefix',name:prefix+'DEMO yogurt'},before=copy(row);
  assert.equal(recipeIngredientDisplayName(section,row),'DEMO yogurt');
  assert.equal(recipeIngredientDisplayName({...section,source:'planned'},row),row.name);
  assert.equal(recipeIngredientDisplayName({...section,name:'Another dish'},row),row.name);
  assert.equal(recipeIngredientDisplayName(section,{...row,name:'Brand '+row.name}),'Brand '+row.name);
  assert.deepEqual(row,before);
});

test('one partial aggregate may belong to a recipe only when every actual contributor is explicitly in that same recipe',()=>{
  const state=fixture(),m=breakfast(state);m.state='in_progress';m.actualRecipeGroups=explicitGroups();
  m.actualRecipeGroups[0].actualEntryIds.push('actual-custard-yogurt');
  m.actualRecipeGroups[1].actualEntryIds=m.actualRecipeGroups[1].actualEntryIds.filter(id=>id!=='actual-custard-yogurt');
  const view=mealNutritionView(m,{planId:ID}),row=view.rows.find(row=>row.itemId==='demo-yogurt');
  assert.equal(row.quantity,110);
  const section=groupMealRecipeRows(m,view.rows,{planId:ID}).find(section=>section.rows.includes(row));
  assert.equal(section.kind,'recipe');assert.equal(section.source,'actual');assert.equal(section.name,'DEMO cocoa plum squares');
  assert.ok(section.actualEntryIds.includes('actual-square-yogurt'));assert.ok(section.actualEntryIds.includes('actual-custard-yogurt'));
});

test('organizing existing historical actual entries is allowed on closed and cancelled plans without reopening or settling them',()=>{
  for(const status of ['closed_with_actuals','cancelled']){
    const state=fixture();plan(state).status=status;const before=copy(state),after=setGroups(state);
    assert.equal(plan(after).status,status);
    assert.deepEqual(nonGroupingFacts(after),nonGroupingFacts(before));assert.deepEqual(nutrition(after),nutrition(before));
  }
});
