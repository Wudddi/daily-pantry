import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { nutritionFactor } from '../lib/diet-nutrition.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
const NOW='2026-10-20T22:00:00.000Z', PREFIX='actual-nutrition:', copy=value=>structuredClone(value);
const nutrition=(kcal=249.4,protein=7.74,carbs=43,fat=5.16,amount=1,unit='个')=>({basisAmount:amount,basisUnit:unit,kcal,protein,carbs,fat,source:'estimate',sourceText:'标签每100g及用户实称86g换算的本个份量；没有推断库存克重',sourceNote:'独立实际营养完整来源'});
function mutate(state,action,payload,operationId=action+'-'+state.revision){return applyMutation(state,{action,...payload,operationId,expectedRevision:state.revision},NOW);}
function ready(){
  let state={schemaVersion:1,revision:0,updatedAt:NOW,events:[],operationIds:[],preferences:[],plans:[],items:[
    validateItem({id:'bagel',name:'贝果',category:'bread',quantity:5,unit:'个',gramsPerUnit:85,nutrition:{basisAmount:100,basisUnit:'g',kcal:290,protein:9,carbs:50,fat:6,source:'label',sourceText:'原标签每100g'}},NOW),
    validateItem({id:'veg',name:'蔬菜',category:'vegetable',quantity:1000,unit:'g'},NOW),
    validateItem({id:'other',name:'其它餐',category:'protein',quantity:1000,unit:'g',nutrition:{basisAmount:100,basisUnit:'g',kcal:200,protein:20,carbs:10,fat:5,source:'label'}},NOW),
    validateItem({id:'fish',name:'鱼油',category:'supplement',quantity:10,unit:'粒',nutrition:{basisAmount:1,basisUnit:'粒',kcal:10,source:'label'}},NOW),
  ]};
  state=mutate(state,'save_meal_plan_draft',{plan:{id:'day',date:'2026-10-20',title:'完整日记录',meals:[{id:'breakfast',slot:'breakfast',title:'早餐',plannedItems:[{id:'other-line',itemId:'other',quantity:100}]},{id:'dinner',slot:'dinner',title:'晚餐',plannedItems:[{id:'bagel-line',itemId:'bagel',quantity:1},{id:'veg-line',itemId:'veg',quantity:150}]}],supplementDoses:[{id:'oil',itemId:'fish',plannedQuantity:1}]}});
  state=mutate(state,'commit_meal_plan',{planId:'day',confirmed:true});
  state=mutate(state,'record_meal_intake',{planId:'day',mealId:'breakfast',mode:'complete',entries:[{id:'a-breakfast',itemId:'other',quantity:100,unit:'g',sourceText:'早餐实际100g'}]});
  return mutate(state,'record_meal_intake',{planId:'day',mealId:'dinner',mode:'complete',actualTime:'20:00',sourceText:'晚餐贝果1个实称86g、蔬菜150g',entries:[{id:'a-bagel',itemId:'bagel',quantity:1,unit:'个',sourceText:'实际贝果1个实称86g'},{id:'a-veg',itemId:'veg',quantity:150,unit:'g',sourceText:'实际150g蔬菜'}]});
}
const plan=state=>state.plans[0], dinner=state=>plan(state).meals.find(meal=>meal.id==='dinner'), actual=(state,id)=>dinner(state).actualEntries.find(entry=>entry.id===id);
const rows=()=>[{id:PREFIX+'a-bagel',nutrition:nutrition(),sourceText:'用户授权，仅更正本个实称86g的营养，不改已吃事实'},{id:PREFIX+'a-veg',nutrition:nutrition(47,2.5,10.5,0.5,200,'g'),sourceText:'用户授权，沿用已有完整每200g蔬菜工作估算'}];
function bridge(state,items=rows(),fields={},operationId){return mutate(state,'patch_meal_plan',{planId:'day',mode:'apply',confirmed:true,mealPatches:[{id:'dinner',itemPatches:items}],...fields},operationId);}
function facts(entry){const{nutritionSnapshot,nutritionCorrectionHistory,...physical}=entry;return physical;}
function assertIsolated(after,before){
  assert.deepEqual(after.items,before.items);
  for(const key of ['items','accountedDebits','allocationAdjustments','inventoryAccounting','accountingIssues','status','draft'])assert.deepEqual(plan(after)[key],plan(before)[key]);
  assert.deepEqual(plan(after).supplementDoses,plan(before).supplementDoses);assert.deepEqual(plan(after).meals[0],plan(before).meals[0]);
  for(const key of ['plannedItems','planRevisionHistory','actualTime','actualTimeText','completionReportedAt','sourceText','reportHistory','state'])assert.deepEqual(dinner(after)[key],dinner(before)[key]);
  assert.deepEqual(dinner(after).actualEntries.map(facts),dinner(before).actualEntries.map(facts));
}
function reject(state,items=rows(),fields={},code){const before=copy(state);assert.throws(()=>bridge(state,items,fields),error=>!code||error.code===code);assert.deepEqual(state,before);}

test('legacy-schema fields alone address existing actual nutrition while preserving an old nested draft, all facts and inventory',()=>{
  const before=ready();plan(before).draft={...copy(plan(before)),title:'旧版保留的计划修改',patchDraft:true};
  const after=bridge(before);assertIsolated(after,before);
  assert.equal(actual(after,'a-bagel').nutritionSnapshot.nutrition.kcal,249.4);assert.equal(actual(after,'a-veg').nutritionSnapshot.nutrition.basisAmount,200);
  for(const row of rows()){const id=row.id.slice(PREFIX.length);assert.equal(actual(after,id).nutritionCorrectionHistory.length,1);assert.equal(actual(after,id).nutritionCorrectionHistory[0].sourceText,row.sourceText);assert.deepEqual(actual(after,id).nutritionCorrectionHistory[0].previous,actual(before,id).nutritionSnapshot);}
  assert.equal(resolveDietDays(after.plans,[])[0].partial,false);
  assert.ok(!dinner(after).plannedItems.some(line=>line.id.startsWith(PREFIX)));
});

test('whole-item correction clears only unsupported actual average weight, audits old85 and never invents86 or reverse-converts grams',()=>{
  const before=ready(),after=bridge(before,[rows()[0]]),snapshot=actual(after,'a-bagel').nutritionSnapshot;
  assert.equal(snapshot.gramsPerUnit,null);assert.equal(snapshot.nutrition.basisUnit,'个');assert.equal(snapshot.nutrition.kcal,249.4);
  assert.equal(actual(after,'a-bagel').nutritionCorrectionHistory[0].previous.gramsPerUnit,85);
  assert.equal(after.items.find(item=>item.id==='bagel').gramsPerUnit,85);
  assert.equal(nutritionFactor(snapshot,1,'个'),1);assert.equal(nutritionFactor(snapshot,86,'g'),null);
  assert.match(after.events.at(-1).detail,/整份口径，旧平均克重换算已清除/);
  assertIsolated(after,before);
});

test('lost-response retry and new-ID no-op cannot duplicate audit, while stale or changed-operation requests are rejected',()=>{
  const before=ready(),items=rows(),operationId='same-compat-body',after=bridge(before,items,{},operationId);
  const command={action:'patch_meal_plan',planId:'day',mode:'apply',confirmed:true,mealPatches:[{id:'dinner',itemPatches:items}],operationId,expectedRevision:before.revision};
  assert.equal(applyMutation(after,command,NOW),after);assert.equal(bridge(after,items,{},'new-id-same-values'),after);
  assert.throws(()=>applyMutation(after,{...command,operationId:'stale-id'},NOW),{code:'REVISION_CONFLICT',status:409});
  const changed=copy(command);changed.expectedRevision=after.revision;changed.mealPatches[0].itemPatches[0].nutrition.kcal=250;
  assert.throws(()=>applyMutation(after,changed,NOW),{code:'OPERATION_ID_CONFLICT',status:409});assert.equal(actual(after,'a-bagel').nutritionCorrectionHistory.length,1);
});

test('compatibility rejects draft, missing explicit confirmation, multiple meals, unrelated plan fields and mixed planned rows',()=>{
  const state=ready();for(const fields of [{mode:'draft'},{confirmed:false},{confirmed:undefined},{title:'不能混入标题'},{notes:'不能混入备注'},{allocationOnly:false},{supplementPatches:[]},{mealPatches:[{id:'dinner',itemPatches:rows()},{id:'breakfast',itemPatches:[rows()[0]]}]},{mealPatches:[{id:'dinner',title:'不能改餐名',itemPatches:rows()}]}])reject(state,rows(),fields);
  reject(state,[{id:'bagel-line',quantity:2},rows()[0]]);reject(state,[rows()[0],{id:'veg-line',nutrition:rows()[1].nutrition,sourceText:'普通行混合'}]);
});

test('reserved resources forbid quantity, identity, unit, remove, raw snapshot and conversion fields even when values match',()=>{
  const state=ready();for(const extra of [{quantity:1},{unit:'个'},{itemId:'bagel'},{name:'贝果'},{remove:false},{gramsPerUnit:86},{fromPlannedLineId:'bagel-line'},{nutritionSnapshot:{}}])reject(state,[{...rows()[0],...extra}]);
  reject(state,[{...rows()[0],sourceText:''}]);const partial=rows()[0];delete partial.nutrition.protein;reject(state,[partial]);
  reject(state,[{id:PREFIX+'a-bagel',sourceText:'没有完整nutrition'}]);
});

test('resources must exist in the exact target meal and fit the old100-character ID limit without truncation',()=>{
  const state=ready();reject(state,[{...rows()[0],id:PREFIX+'missing-actual'}],{},'ACTUAL_NOT_FOUND');
  reject(state,[{...rows()[0],id:PREFIX+'a-breakfast'}],{},'ACTUAL_NOT_FOUND');
  reject(state,[{...rows()[0],id:PREFIX}]);reject(state,[{...rows()[0],id:PREFIX+' a-bagel'}]);
  reject(state,[{...rows()[0],id:PREFIX+'x'.repeat(101-PREFIX.length)}]);
});

test('active and pending planned IDs that collide with the complete reserved resource address reject ambiguity',()=>{
  for(const pending of [false,true]){const state=ready(),collision={...copy(dinner(state).plannedItems[0]),id:PREFIX+'a-bagel'};
    if(pending){plan(state).draft=copy(plan(state));plan(state).draft.meals[1].plannedItems.push(collision);}else plan(state).meals[0].plannedItems.push(collision);
    reject(state,[rows()[0]],{},'NUTRITION_RESOURCE_AMBIGUOUS');
  }
});

test('normal planned patches and prose containing resource-looking text retain their original planned-only meaning',()=>{
  const state=ready();const after=mutate(state,'patch_meal_plan',{planId:'day',mode:'apply',confirmed:true,mealPatches:[{id:'dinner',itemPatches:[{id:'veg-line',nutrition:rows()[1].nutrition,sourceText:'原话中写着 actual-nutrition:a-veg，作为原话保存，不是命令'}]}]});
  assert.deepEqual(actual(after,'a-veg'),actual(state,'a-veg'));assert.equal(actual(after,'a-veg').nutritionCorrectionHistory,undefined);
  assert.equal(dinner(after).plannedItems[1].nutritionSnapshot.nutrition.kcal,47);assert.deepEqual(after.items,state.items);
});

test('one invalid member or duplicate resource rejects the whole batch without partial snapshot or audit writes',()=>{
  const state=ready();reject(state,[rows()[0],{...rows()[1],nutrition:{...rows()[1].nutrition,sourceNote:'',sourceText:''}}]);
  reject(state,[rows()[0],rows()[0]]);reject(state,Array.from({length:101},(_,i)=>({...rows()[0],id:PREFIX+'a-'+i})));
  reject(state,[rows()[0],{...rows()[1],nutrition:{...rows()[1].nutrition,kcal:-1}}]);
});
