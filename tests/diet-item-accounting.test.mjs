import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDietAction } from '../lib/diet.mjs';

const DAY='2026-10-29', AT=DAY+'T22:00:00.000Z', LATER=DAY+'T23:00:00.000Z';
const stock=(state,id)=>state.items.find(item=>item.id===id);
const plan=state=>state.plans[0];
const credit=(state,id)=>plan(state).accountedDebits.find(line=>line.itemId===id);
function item(id,quantity,unit='g',category='prepared') {
  return {id,name:id,quantity,unit,category,status:quantity===0?'depleted':'available',quantityBaselineToken:'initial-'+id,
    confirmedAt:AT,updatedAt:AT,gramsPerUnit:null,nutrition:{basisAmount:1,basisUnit:unit,kcal:1,protein:0,carbs:0,fat:0,source:'estimate'}};
}
function apply(state,payload,at=AT) {
  const result=applyDietAction(state,payload,at);
  return result.noChange?state:{...state,items:result.items,plans:result.plans};
}
function fixture() {
  return apply({items:[item('pepper',1,'个','vegetable'),item('rice',1000),item('yogurt',200,'g','protein'),item('oil',1,'粒','supplement')],plans:[]},
    {action:'save_meal_plan_draft',plan:{id:'day',date:DAY,title:'三餐',meals:[
      {id:'breakfast',slot:'breakfast',title:'早餐',plannedItems:[{id:'yogurt-plan',itemId:'yogurt',quantity:95}]},
      {id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'pepper-plan',itemId:'pepper',quantity:2},{id:'rice-plan',itemId:'rice',quantity:100}]},
    ],supplementDoses:[{id:'oil-dose',itemId:'oil',plannedQuantity:1}]}});
}
const entry=(id,itemId,quantity,unit='g')=>({id,itemId,quantity,unit,sourceText:'用户明确报告实际用量'});
const lunch=(state,entries,extra={})=>apply(state,{action:'record_meal_intake',planId:'day',mealId:'lunch',mode:'complete',entries,sourceText:'今天这餐实际吃完了',...extra});

test('one pepper on the books and two actually eaten settles at zero without blocking rice or changing facts',()=>{
  const initial=fixture(),state=lunch(initial,[entry('ate-pepper','pepper',2,'个'),entry('ate-rice','rice',100)]);
  assert.equal(stock(state,'pepper').quantity,0);assert.equal(stock(state,'pepper').status,'depleted');assert.equal(stock(state,'rice').quantity,900);
  assert.equal(plan(state).inventoryAccounting,'settled');assert.deepEqual(plan(state).accountingIssues,[]);
  assert.equal(credit(state,'pepper').quantity,2);assert.equal(credit(state,'pepper').shortfallQuantity,1);
  assert.equal(plan(state).meals[1].actualEntries.find(e=>e.id==='ate-pepper').quantity,2);
  assert.equal(plan(state).accountingWarnings[0].quantity,1);
  assert.deepEqual(plan(state).accountingAdjustmentHistory[0],{at:AT,itemId:'pepper',unit:'个',code:'STOCK_SHORTFALL_RECORDED',basis:'reported_actual',
    targetBefore:0,targetAfter:2,stockBefore:1,stockAfter:0,shortfallBefore:0,shortfallAfter:1,inventoryDelta:1});
  assert.deepEqual(plan(state).supplementDoses,plan(initial).supplementDoses);
  const retry=lunch(state,[entry('ate-pepper','pepper',2,'个'),entry('ate-rice','rice',100)]);
  assert.deepEqual(retry.items,state.items);assert.deepEqual(plan(retry).accountingAdjustmentHistory,plan(state).accountingAdjustmentHistory);
});

test('correction 2 to 1 first clears the unwithdrawn shortfall, then 1 to 0 returns only the genuinely withdrawn one',()=>{
  let state=lunch(fixture(),[entry('ate-pepper','pepper',2,'个')]);
  state=lunch(state,[entry('ate-pepper','pepper',1,'个')],{mode:'correct'});
  assert.equal(stock(state,'pepper').quantity,0);assert.equal(credit(state,'pepper').quantity,1);assert.equal(credit(state,'pepper').shortfallQuantity,undefined);
  assert.deepEqual(plan(state).accountingWarnings,[]);assert.equal(plan(state).accountingAdjustmentHistory[1].inventoryDelta,0);
  state=lunch(state,[entry('ate-pepper','pepper',0,'个')],{mode:'correct'});
  assert.equal(stock(state,'pepper').quantity,1);assert.equal(credit(state,'pepper'),undefined);
  assert.equal(plan(state).meals[1].actualEntries[0].correctionHistory.length,2);
});

test('direct correction 2 to 0 refunds one, and a later additional report can record a new shortage without replaying the old one',()=>{
  let state=lunch(fixture(),[entry('ate-pepper','pepper',2,'个')]);
  state=lunch(state,[entry('ate-pepper','pepper',0,'个')],{mode:'correct'});
  assert.equal(stock(state,'pepper').quantity,1);assert.equal(plan(state).accountingAdjustmentHistory[1].inventoryDelta,-1);
  state=lunch(state,[entry('extra-pepper','pepper',2,'个')],{mode:'append'});
  assert.equal(stock(state,'pepper').quantity,0);assert.equal(credit(state,'pepper').shortfallQuantity,1);
  assert.equal(plan(state).accountingAdjustmentHistory.length,3);
});

test('a changed inventory baseline blocks only that refund and keeps the old shortfall credit while another item settles',()=>{
  let state=lunch(fixture(),[entry('ate-pepper','pepper',2,'个'),entry('ate-rice','rice',50)]);
  stock(state,'pepper').quantity=8;stock(state,'pepper').status='available';stock(state,'pepper').quantityBaselineToken='new-delivery';
  const before=structuredClone(credit(state,'pepper'));
  state=lunch(state,[entry('ate-pepper','pepper',0,'个'),entry('ate-rice','rice',100)],{mode:'correct'});
  assert.equal(stock(state,'pepper').quantity,8);assert.deepEqual(credit(state,'pepper'),before);
  assert.equal(stock(state,'rice').quantity,900);assert.equal(credit(state,'rice').quantity,100);
  assert.deepEqual(new Set(plan(state).accountingIssues.map(issue=>issue.itemId)),new Set(['pepper']));
  assert.equal(plan(state).accountingAdjustmentHistory.length,1);
});

test('unit conflicts in one item do not lose a different target or corrupt its independent credit',()=>{
  const state=lunch(fixture(),[entry('bad-pepper','pepper',2,'g'),entry('ate-rice','rice',100)]);
  assert.equal(stock(state,'pepper').quantity,1);assert.equal(credit(state,'pepper'),undefined);assert.equal(stock(state,'rice').quantity,900);
  assert.equal(credit(state,'rice').quantity,100);assert.equal(plan(state).inventoryAccounting,'pending_reconciliation');
  assert.deepEqual(new Set(plan(state).accountingIssues.map(i=>i.itemId)),new Set(['pepper']));
  assert(!plan(state).accountingIssues.some(i=>i.code==='ATOMIC_ACCOUNTING_PENDING'));
});

test('genuinely pending and archived stock stay blocked through consecutive retries, while other food is not replayed',()=>{
  for (const status of ['pending','archived']) {
    const initial=fixture();stock(initial,'pepper').status=status;
    const entries=[entry('ate-pepper','pepper',2,'个'),entry('ate-rice','rice',100)];
    const first=lunch(initial,entries),second=lunch(first,entries),third=lunch(second,entries);
    for(const state of [first,second,third]) {
      assert.equal(stock(state,'pepper').quantity,1);assert.equal(stock(state,'pepper').status,status);
      assert.equal(credit(state,'pepper'),undefined);assert.equal(stock(state,'rice').quantity,900);
      assert.equal(credit(state,'rice').quantity,100);
      assert(plan(state).accountingIssues.some(issue=>issue.itemId==='pepper'&&issue.code==='ITEM_UNAVAILABLE'));
      assert.equal(plan(state).accountingWarnings?.length??0,0);
    }
  }
});

test('an unknown actual amount on a known balance blocks only that item and is never replaced with its plan',()=>{
  const state=lunch(fixture(),[entry('unknown-pepper','pepper',null,'个'),entry('ate-rice','rice',100)]);
  assert.equal(stock(state,'pepper').quantity,1);assert.equal(stock(state,'rice').quantity,900);
  assert.equal(plan(state).meals[1].actualEntries[0].quantity,null);
  assert(plan(state).accountingIssues.some(issue=>issue.itemId==='pepper'&&issue.code==='ACTUAL_QUANTITY_UNKNOWN'));
});

test('a missing historical inventory reference cannot stop a newly reported valid item or lose its actual fact',()=>{
  const initial=fixture();plan(initial).meals[0].actualEntries=[{id:'old-ghost',itemId:'missing-item',quantity:1,unit:'g',name:'已移除的旧食物',
    sourceText:'历史已报告',reportedAt:AT,quantitySource:'reported',nutritionSnapshot:null,correctionHistory:[]}];
  const state=lunch(initial,[entry('ate-rice','rice',100)]);
  assert.equal(stock(state,'rice').quantity,900);assert.equal(credit(state,'rice').quantity,100);
  assert(plan(state).accountingIssues.some(issue=>issue.itemId==='missing-item'&&issue.code==='ITEM_NOT_FOUND'));
  assert.deepEqual(plan(state).meals[0].actualEntries,plan(initial).meals[0].actualEntries);
});

test('conflicting units across actual entries isolate the failing target aggregation instead of blocking every item',()=>{
  const state=lunch(fixture(),[entry('pepper-one','pepper',1,'个'),entry('pepper-grams','pepper',10,'g'),entry('ate-rice','rice',100)]);
  assert.equal(stock(state,'pepper').quantity,1);assert.equal(stock(state,'rice').quantity,900);
  assert(plan(state).accountingIssues.some(i=>i.itemId==='pepper'&&i.code==='UNIT_CONFLICT'));
  assert.equal(plan(state).meals[1].actualEntries.length,3);
});

test('already deducted 95g yogurt and its old baseline are unchanged when an unrelated pepper shortage settles',()=>{
  let state=apply(fixture(),{action:'record_meal_intake',planId:'day',mealId:'breakfast',mode:'complete',entries:[entry('ate-yogurt','yogurt',95)]});
  const prior=structuredClone(credit(state,'yogurt'));stock(state,'yogurt').quantity=0;stock(state,'yogurt').status='depleted';stock(state,'yogurt').quantityBaselineToken='user-empty-report';
  state=lunch(state,[entry('ate-pepper','pepper',2,'个'),entry('ate-rice','rice',100)]);
  assert.equal(stock(state,'yogurt').quantity,0);assert.deepEqual(credit(state,'yogurt'),prior);
  assert.equal(plan(state).inventoryAccounting,'settled');assert.equal(stock(state,'rice').quantity,900);
});

test('a supplement shortage is never clamped but cannot block separately reported food',()=>{
  const state=lunch(fixture(),[entry('ate-rice','rice',100)],{supplements:[{doseId:'oil-dose',mode:'complete',entries:[entry('ate-oil','oil',2,'粒')]}]});
  assert.equal(stock(state,'rice').quantity,900);assert.equal(stock(state,'oil').quantity,1);
  assert.equal(credit(state,'oil'),undefined);assert(plan(state).accountingIssues.some(i=>i.itemId==='oil'&&i.code==='INSUFFICIENT_STOCK'));
  assert.equal(plan(state).supplementDoses[0].actualEntries[0].quantity,2);
});

test('shortfall audit survives replacement menus and an independent supplement check without changing food balances',()=>{
  let state=lunch(fixture(),[entry('ate-pepper','pepper',2,'个')]);
  state=apply(state,{action:'save_meal_plan_draft',plan:{id:'day',date:DAY,title:'修改菜单',meals:[
    {id:'breakfast',slot:'breakfast',title:'早餐',plannedItems:[{id:'yogurt-plan',itemId:'yogurt',quantity:90}]},
    {id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'pepper-plan',itemId:'pepper',quantity:2},{id:'rice-plan',itemId:'rice',quantity:90}]},
  ]}});
  const before=structuredClone(plan(state).accountingAdjustmentHistory),food=structuredClone(credit(state,'pepper'));
  state=apply(state,{action:'set_supplement_check',planId:'day',doseId:'oil-dose',checked:true});
  assert.deepEqual(credit(state,'pepper'),food);assert.deepEqual(plan(state).accountingAdjustmentHistory,before);
  assert.equal(plan(state).accountingWarnings[0].quantity,1);assert.equal(stock(state,'pepper').quantity,0);assert.equal(stock(state,'oil').quantity,0);
});

test('midnight clamping is explicitly an automatic-menu basis, never new actual facts or personal check changes',()=>{
  let state=fixture();state.dailyMenuSettlementPolicy={version:1,enabled:true,timeZone:'America/Toronto',startsOn:DAY,updatedAt:AT,sourceText:'用户开启午夜按菜单结算'};
  plan(state).personalFoodChecks={version:1,checks:[],updatedAt:AT};
  const meals=structuredClone(plan(state).meals),doses=structuredClone(plan(state).supplementDoses),checks=structuredClone(plan(state).personalFoodChecks);
  const payload={action:'settle_daily_menu',planId:'day',effectiveDate:DAY,policyStartDate:DAY,confirmed:true};
  state=apply(state,payload,'2026-10-30T04:00:00.000Z');
  assert.equal(stock(state,'pepper').quantity,0);assert.equal(stock(state,'rice').quantity,900);assert.equal(plan(state).dailySettlement.accounting,'settled');
  assert.equal(plan(state).accountingAdjustmentHistory[0].basis,'automatic_menu');assert.deepEqual(plan(state).meals,meals);assert.deepEqual(plan(state).supplementDoses,doses);assert.deepEqual(plan(state).personalFoodChecks,checks);
  const retry=apply(state,payload,'2026-10-30T04:01:00.000Z');assert.strictEqual(retry,state);
});

test('strict legacy cancellations keep their transaction semantics and never refund another item after a baseline error',()=>{
  const state=fixture(),p=plan(state);p.status='reserved';delete p.foodAccounting;delete p.supplementAccounting;
  p.accountedDebits=[{itemId:'pepper',name:'pepper',quantity:1,unit:'个',unknownBalance:false,baselineToken:'initial-pepper'},
    {itemId:'rice',name:'rice',quantity:100,unit:'g',unknownBalance:false,baselineToken:'initial-rice'}];p.items=structuredClone(p.accountedDebits);
  stock(state,'pepper').quantityBaselineToken='another-count';const before=structuredClone(state);
  assert.throws(()=>apply(state,{action:'cancel_meal_plan',planId:'day',confirmed:true}),e=>e.code==='BASELINE_REQUIRES_REVIEW');assert.deepEqual(state,before);
});
