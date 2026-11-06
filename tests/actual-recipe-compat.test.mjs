import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMutation} from '../lib/inventory.mjs';
import {readDietRecords} from '../lib/diet.mjs';
import {actualRecipeGroupResourcePatch,hasActualRecipeGroupResources} from '../lib/actual-recipe-groups.mjs';
import {DAY,LATER,ID,copy,fixture,plan,breakfast,snack,explicitGroups,nonGroupingFacts,nutrition} from './fixtures/actual-recipe-groups.mjs';

const resources=()=>explicitGroups().map(({actualEntryIds,...group})=>({...group,id:'actual-recipe:'+group.id,lineIds:actualEntryIds.map(id=>'actual-entry:'+id)}));
const command=state=>({action:'patch_meal_plan',planId:ID,mode:'draft',operationId:'demo-actual-recipe-compat',expectedRevision:state.revision,
  mealPatches:[{id:'breakfast',recipeGroups:resources()}]});

test('cached menu patches organize exact actual dishes without materializing a legacy menu or retrying pending stock accounting',()=>{
  const state=fixture();
  plan(state).draft={id:ID,date:DAY,title:'DEMO untouched legacy draft',meals:[{...copy(snack(state)),title:'DEMO latest saved snack'}]};
  plan(state).intakeDraft={id:'demo-untouched-pending-draft',baseFingerprint:'demo-legacy-fingerprint',consumed:[],transfers:[],completedMealIds:[]};
  plan(state).accountingIssues=[{code:'DEMO_REVIEW_REQUIRED',itemId:'demo-yogurt',message:'DEMO unresolved old accounting'}];
  const before=copy(state),facts=nonGroupingFacts(state),totals=nutrition(state),payload=command(state);
  assert.equal(hasActualRecipeGroupResources(payload),true);
  assert.deepEqual(actualRecipeGroupResourcePatch(payload),{planId:ID,mealId:'breakfast',groups:explicitGroups()});
  const after=applyMutation(state,payload,LATER);
  assert.deepEqual(breakfast(after).actualRecipeGroups,explicitGroups());
  assert.deepEqual(breakfast(after).actualRecipeGroupHistory,[{at:LATER,previous:null}]);
  assert.deepEqual(nonGroupingFacts(after),facts);
  assert.deepEqual(nutrition(after),totals);
  assert.deepEqual(state,before);
  assert.strictEqual(applyMutation(after,payload,LATER),after);
  assert.throws(()=>applyMutation(after,{...payload,operationId:'demo-stale-compat',mealPatches:[{id:'breakfast',recipeGroups:resources().slice(0,1)}]},LATER),error=>error.code==='REVISION_CONFLICT');
  const read=readDietRecords(after,{date:DAY});
  const saved=read.records.find(record=>record.id===ID);
  assert.deepEqual(saved.meals.find(meal=>meal.id==='breakfast').actualRecipeGroups,explicitGroups());
});

test('reserved actual resources reject mixed or foreign mutations atomically while empty ordinary groups still clear only the planned recipe',()=>{
  const state=fixture({withGroups:true}),before=copy(state),payload=command(state);
  const mixed=copy(payload);mixed.mealPatches[0].recipeGroups.push(copy(breakfast(state).recipeGroups[0]));
  const invalid=[mixed,{...payload,title:'DEMO not metadata'},{...payload,notes:'DEMO not metadata'},
    {...payload,allocationOnly:true},{...payload,supplementPatches:[{id:'demo-dose',plannedQuantity:2}]},
    {...payload,mealPatches:[...payload.mealPatches,{id:'snack',recipeGroups:resources()}]},
    {...payload,mealPatches:[{...payload.mealPatches[0],title:'DEMO not metadata'}]},
    {...payload,mealPatches:[{...payload.mealPatches[0],itemPatches:[{id:'planned-square-oats',quantity:1}]}]},
    {...payload,mealPatches:[{id:'breakfast',recipeGroups:[{...resources()[0],lineIds:['actual-entry:not-in-this-meal']}]}]},
    {...payload,mealPatches:[{id:'breakfast',recipeGroups:[{...resources()[0],lineIds:['actual-square-oats']}]}]},
    {...payload,mode:'apply'}, {...payload,confirmed:false}];
  for(const value of invalid){
    assert.throws(()=>applyMutation(state,value,LATER),error=>error.status===400&&['INVALID_ACTUAL_RECIPE_GROUP_RESOURCE','INVALID_ACTUAL_RECIPE_GROUPS'].includes(error.code));
    assert.deepEqual(state,before);
  }
  const ordinary={...payload,mealPatches:[{id:'breakfast',recipeGroups:[]}]};
  assert.equal(hasActualRecipeGroupResources(ordinary),false);
  const after=applyMutation(state,ordinary,LATER);
  assert.deepEqual(breakfast(after).recipeGroups,[]);
  assert.deepEqual(breakfast(after).actualRecipeGroups,explicitGroups());
  assert.deepEqual(breakfast(after).actualEntries,breakfast(state).actualEntries);
  assert.deepEqual(after.items,state.items);
  assert.deepEqual(plan(after).accountedDebits,plan(state).accountedDebits);
});
