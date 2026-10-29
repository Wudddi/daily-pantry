import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { previewFoodBalanceReconciliation } from '../lib/food-balance-reconciliation.mjs';

const AT='2026-10-29T22:00:00.000Z';let seq=0;
const act=(s,action,fields,operationId='shortfall-calibration-'+(++seq))=>applyMutation(s,{action,operationId,expectedRevision:s.revision,...fields},AT);
const plan=s=>s.plans[0];
function fixture(){
  let s={schemaVersion:1,revision:0,updatedAt:AT,preferences:[],events:[],operationIds:[],plans:[],items:[validateItem({id:'pepper',name:'彩椒',category:'vegetable',quantity:1,unit:'个'},AT)]};
  s=act(s,'save_meal_plan_draft',{plan:{id:'day',date:'2026-10-29',title:'测试晚餐',meals:[{id:'dinner',slot:'dinner',title:'晚餐',plannedItems:[{id:'pepper-line',itemId:'pepper',quantity:2,unit:'个'}]}],supplementDoses:[]}});
  return act(s,'record_meal_intake',{planId:'day',mealId:'dinner',mode:'complete',entries:[{id:'actual-pepper',itemId:'pepper',quantity:2,unit:'个',sourceText:'明确实际用了2个'}],sourceText:'实吃2个，账面不足记0。'});
}
const correct=(s,quantity)=>act(s,'record_meal_intake',{planId:'day',mealId:'dinner',mode:'correct',entries:[{id:'actual-pepper',itemId:'pepper',quantity,unit:'个',sourceText:'更正原实际数量'}],sourceText:'用户明确更正原记录，不是追加。'});
function recount(s){const preview=previewFoodBalanceReconciliation(s,'pepper',AT);assert.equal(preview.canReconcile,true);return act(s,'reconcile_food_inventory',{itemId:'pepper',quantity:0,confirmed:true,planIds:preview.planIds,sourceText:'用户确认仍剩0个，包含上述实际记录；并无新的补货。'});}

test('a present-balance calibration preserves shortfall so a later intake correction cannot invent a refund',()=>{
  let s=fixture();assert.equal(s.items[0].quantity,0);assert.equal(plan(s).accountedDebits[0].shortfallQuantity,1);
  s=recount(s);assert.equal(s.items[0].quantity,0);assert.equal(plan(s).accountedDebits[0].shortfallQuantity,1);
  const audit=s.inventoryReconciliationHistory.at(-1).planCreditBeforeAfter[0];
  assert.equal(audit.before.accountedDebits[0].shortfallQuantity,1);assert.equal(audit.after.accountedDebits[0].shortfallQuantity,1);
  s=correct(s,1);assert.equal(s.items[0].quantity,0,'first remove the unmatched part, not refund an imaginary pepper');
  assert.equal(plan(s).accountedDebits[0].shortfallQuantity??0,0);
  s=correct(s,0);assert.equal(s.items[0].quantity,1,'only the one physically deducted pepper can return');
});

test('recount aligns an already saved smaller actual quantity without retaining a resolved shortfall warning',()=>{
  let s=fixture();plan(s).meals[0].actualEntries[0].quantity=1;
  plan(s).inventoryAccounting='pending_reconciliation';plan(s).accountingIssues=[{code:'BASELINE_REQUIRES_REVIEW',itemId:'pepper',message:'原更正未结算'}];
  s=recount(s);assert.equal(s.items[0].quantity,0);assert.equal(plan(s).accountedDebits[0].quantity,1);
  assert.equal(plan(s).accountedDebits[0].shortfallQuantity??0,0);assert.equal(plan(s).accountingWarnings.length,0);
  s=correct(s,0);assert.equal(s.items[0].quantity,1);
});

test('an invalid persisted shortfall cannot be silently discarded by a current balance calibration',()=>{
  const s=fixture();plan(s).accountedDebits[0].shortfallQuantity=3;
  const preview=previewFoodBalanceReconciliation(s,'pepper',AT);assert.equal(preview.canReconcile,false);
  assert.ok(preview.errors.some(error=>error.code==='INVALID_ACCOUNTING_SHORTFALL'));
  assert.throws(()=>act(s,'reconcile_food_inventory',{itemId:'pepper',quantity:0,confirmed:true,planIds:preview.planIds,sourceText:'当前仍为0'}),error=>error.code==='INVALID_ACCOUNTING_SHORTFALL');
});
