import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { torontoLocalDate } from '../lib/daily-menu-settlement.mjs';
import { intakePlanFingerprint } from '../lib/intake-draft.mjs';

const DAY='2026-10-26',AT=DAY+'T16:00:00.000Z',MIDNIGHT='2026-10-27T04:00:00.000Z';let seq=0;
const copy=value=>structuredClone(value);
const nutrition={basisAmount:100,basisUnit:'g',kcal:100,protein:10,carbs:10,fat:2,source:'label'};
const food=(id,unit='g',extra={})=>validateItem({id,name:id,category:id==='creatine'?'supplement':'prepared',quantity:1000,unit,nutrition:{...nutrition,basisUnit:unit==='袋'?'g':unit},...extra},AT);
const mutate=(state,action,fields={},at=AT)=>applyMutation(state,{action,operationId:'midnight-test-'+(++seq),expectedRevision:state.revision,...fields},at);
const plan=state=>state.plans[0],stock=(state,id)=>state.items.find(item=>item.id===id).quantity;
function fixture(extra={}) {
  return mutate({schemaVersion:1,revision:0,updatedAt:AT,preferences:[],events:[],operationIds:[],plans:[],
    dailyMenuSettlementPolicy:{version:1,enabled:true,timeZone:'America/Toronto',startsOn:DAY,updatedAt:AT,sourceText:'用户要求午夜按完整菜单结算，个人标记不影响'},
    items:[food('rice'),food('milk','ml'),food('beef','袋',{quantity:10,gramsPerUnit:132}),food('creatine')],...extra},'save_meal_plan_draft',
    {plan:{id:'daily-food-'+DAY,date:DAY,title:'日终菜单',meals:[
      {id:'breakfast',slot:'breakfast',title:'早餐',plannedItems:[{id:'milk-am',itemId:'milk',quantity:150,unit:'ml'}]},
      {id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'rice-l',itemId:'rice',quantity:100,unit:'g'}]},
      {id:'dinner',slot:'dinner',title:'晚餐',plannedItems:[{id:'rice-d',itemId:'rice',quantity:100,unit:'g'},{id:'beef-d',itemId:'beef',quantity:1,unit:'袋'}]},
    ],supplementDoses:[{id:'creatine-am',itemId:'creatine',plannedQuantity:5,timingSlot:'breakfast'}]}});
}
const settle=(state,fields={},at=MIDNIGHT)=>mutate(state,'settle_daily_menu',{planId:plan(state).id,effectiveDate:plan(state).date,policyStartDate:state.dailyMenuSettlementPolicy.startsOn,confirmed:true,...fields},at);
const report=(state,mealId,entries,mode='append')=>mutate(state,'record_meal_intake',{planId:plan(state).id,mealId,mode,entries,sourceText:'用户明确报告真实摄入'},MIDNIGHT);

test('midnight settles the latest complete saved menu independently of personal marks, without inventing actuals or supplement intake',()=>{
  const original=fixture();
  const marked=mutate(original,'set_food_personal_check',{planId:plan(original).id,mealId:'lunch',lineIds:['rice-l'],checked:true});
  const actuals=copy(plan(marked).meals),supplements=copy(plan(marked).supplementDoses),checks=copy(plan(marked).personalFoodChecks);
  const state=settle(marked),unmarked=settle(original);
  assert.deepEqual(state.items,unmarked.items);
  assert.equal(stock(state,'rice'),800);assert.equal(stock(state,'milk'),850);assert.equal(stock(state,'beef'),9);assert.equal(stock(state,'creatine'),1000);
  assert.deepEqual(plan(state).meals,actuals);assert.deepEqual(plan(state).supplementDoses,supplements);assert.deepEqual(plan(state).personalFoodChecks,checks);
  assert.equal(plan(state).status,'draft');
  assert.equal(plan(state).dailySettlement.basis,'auto_planned');assert.equal(plan(state).dailySettlement.source,'automatic_menu');
  assert.equal(plan(state).dailySettlement.accounting,'settled');
  assert.deepEqual(plan(state).dailySettlement.assumedMealIds,['breakfast','lunch','dinner']);
  assert(plan(state).meals.every(meal=>meal.actualEntries.length===0&&meal.actualTime===null&&meal.completionReportedAt===null));
  assert.strictEqual(settle(state),state,'new operation cannot settle a date twice');
});

test('a saved change before midnight is used while unsaved personal marks never change the automatic amounts',()=>{
  let state=fixture();
  state=mutate(state,'patch_meal_plan',{planId:plan(state).id,mode:'draft',mealPatches:[{id:'lunch',itemPatches:[{id:'rice-l',quantity:70}]}]});
  assert.equal(stock(state,'rice'),1000);
  state=settle(state);
  assert.equal(stock(state,'rice'),830);
  assert.equal(plan(state).dailySettlement.plannedMeals.find(meal=>meal.mealId==='lunch').plannedItems[0].quantity,70);
});

test('real completed meals and explicit zero overrides win over the automatic menu',()=>{
  let state=fixture();
  state=report(state,'lunch',[{id:'actual-rice-l',itemId:'rice',quantity:60,unit:'g',sourceText:'午餐实际只吃60g'}],'complete');
  state=report(state,'dinner',[{id:'actual-beef-zero',itemId:'beef',quantity:0,unit:'袋',sourceText:'牛肉没吃'}]);
  const facts=copy(plan(state).meals);
  state=settle(state);
  assert.equal(stock(state,'rice'),840);assert.equal(stock(state,'beef'),10);assert.equal(stock(state,'milk'),850);
  assert.deepEqual(plan(state).meals,facts);
  assert.deepEqual(plan(state).dailySettlement.assumedMealIds,['breakfast','dinner']);
});

test('a partial actual report is topped up to the saved menu at midnight while a completed report is not',()=>{
  let partial=report(fixture(),'lunch',[{id:'partial-rice',itemId:'rice',quantity:60,unit:'g',sourceText:'午餐目前先吃60g'}]);
  assert.equal(stock(partial,'rice'),940);
  const facts=copy(plan(partial).meals[1].actualEntries);
  partial=settle(partial);
  assert.equal(stock(partial,'rice'),800,'midnight adds the remaining40g plus dinner100g');
  assert.deepEqual(plan(partial).meals[1].actualEntries,facts,'the assumed remaining40g is accounting only');
  let completed=report(fixture(),'lunch',[{id:'finished-rice',itemId:'rice',quantity:60,unit:'g',sourceText:'午餐结束，实际只有60g'}],'complete');
  completed=settle(completed);
  assert.equal(stock(completed,'rice'),840,'completed actual60g overrides planned100g');
});

test('later actual corrections settle only their difference while other automatically accounted meals remain charged',()=>{
  let state=report(fixture(),'lunch',[{id:'actual-rice-l',itemId:'rice',quantity:60,unit:'g',sourceText:'午餐实际60g'}],'complete');
  state=settle(state);
  assert.equal(stock(state,'rice'),840);
  state=report(state,'lunch',[{id:'actual-rice-l',itemId:'rice',quantity:80,unit:'g',sourceText:'更正午餐实际80g'}],'correct');
  assert.equal(stock(state,'rice'),820);assert.equal(stock(state,'milk'),850);assert.equal(stock(state,'beef'),9);
  state=report(state,'dinner',[{id:'actual-beef-zero',itemId:'beef',quantity:0,unit:'袋',sourceText:'实际上牛肉没吃'}]);
  assert.equal(stock(state,'beef'),10);assert.equal(stock(state,'rice'),820);assert.equal(stock(state,'milk'),850);
  assert(plan(state).meals[0].actualEntries.length===0,'assumed breakfast stays explicitly unreported');
});

test('supplement checking before or after automatic food settlement remains independent',()=>{
  let state=mutate(fixture(),'set_daily_supplement_check',{date:DAY,doseId:'creatine-am',checked:true});
  const facts=copy(plan(state).supplementDoses);
  state=settle(state);assert.equal(stock(state,'creatine'),995);assert.deepEqual(plan(state).supplementDoses,facts);
  const foodQuantities=state.items.filter(item=>item.id!=='creatine').map(item=>[item.id,item.quantity]);
  state=mutate(state,'set_daily_supplement_check',{date:DAY,doseId:'creatine-am',checked:false},MIDNIGHT);
  assert.equal(stock(state,'creatine'),1000);
  assert.deepEqual(state.items.filter(item=>item.id!=='creatine').map(item=>[item.id,item.quantity]),foodQuantities);
  assert.equal(plan(state).dailySettlement.accounting,'settled');
});

test('personal marks and later plan-only edits preserve the frozen accounting basis and do not reopen automatic settlement',()=>{
  let state=settle(fixture());const amounts=copy(state.items),basis=copy(plan(state).dailySettlement);
  state=mutate(state,'set_food_personal_check',{planId:plan(state).id,mealId:'lunch',wholeMeal:true,checked:true},MIDNIGHT);
  state=mutate(state,'patch_meal_plan',{planId:plan(state).id,mode:'draft',mealPatches:[{id:'lunch',itemPatches:[{id:'rice-l',quantity:500}]}]},MIDNIGHT);
  assert.deepEqual(state.items,amounts);assert.deepEqual(plan(state).dailySettlement,basis);
  state=report(state,'dinner',[{id:'explicit-beef-zero',itemId:'beef',quantity:0,unit:'袋',sourceText:'牛肉没有吃'}]);
  assert.equal(stock(state,'rice'),800,'a later real correction does not silently bill a subsequently edited old menu');
  assert.equal(stock(state,'beef'),10);assert.strictEqual(settle(state),state);
});

test('automatic food shortage clamps its balance and audits the assumed basis while other foods settle once',()=>{
  let state=fixture({items:[food('rice','g',{quantity:50}),food('milk','ml'),food('beef','袋',{quantity:10,gramsPerUnit:132}),food('creatine')]});
  const facts=copy(plan(state).meals);
  state=settle(state);
  assert.equal(stock(state,'rice'),0);assert.equal(stock(state,'milk'),850);assert.equal(stock(state,'beef'),9);assert.equal(stock(state,'creatine'),1000);
  assert.equal(plan(state).inventoryAccounting,'settled');assert.equal(plan(state).dailySettlement.accounting,'settled');
  const riceCredit=plan(state).accountedDebits.find(line=>line.itemId==='rice');
  assert.equal(riceCredit.quantity,200);assert.equal(riceCredit.shortfallQuantity,150);assert.deepEqual(plan(state).meals,facts);
  assert(plan(state).accountingWarnings.some(issue=>issue.code==='STOCK_SHORTFALL_RECORDED'&&issue.itemId==='rice'&&issue.quantity===150));
  assert.equal(plan(state).accountingAdjustmentHistory.at(-1).basis,'automatic_menu');
  assert.strictEqual(settle(state),state);
});

test('changed stock baselines prevent refund of that old credit while unrelated automatic food settles',()=>{
  let state=fixture();
  const rice=state.items.find(item=>item.id==='rice');
  plan(state).accountedDebits=[{itemId:'rice',name:'rice',quantity:400,unit:'g',unknownBalance:false,baselineToken:rice.quantityBaselineToken??rice.confirmedAt}];
  plan(state).items=copy(plan(state).accountedDebits);
  rice.quantity=700;rice.quantityBaselineToken='new-user-count';
  state=settle(state);
  assert.equal(stock(state,'rice'),700);assert.equal(stock(state,'milk'),850);assert.equal(stock(state,'beef'),9);assert.equal(stock(state,'creatine'),1000);
  assert.equal(plan(state).dailySettlement.accounting,'pending_reconciliation');
  assert(plan(state).accountingIssues.some(issue=>issue.code==='BASELINE_REQUIRES_REVIEW'));
  assert.equal(plan(state).accountingIssues.some(issue=>issue.itemId!=='rice'),false);
  assert.equal(plan(state).accountedDebits.find(line=>line.itemId==='rice').quantity,400);
  assert.equal(plan(state).accountedDebits.find(line=>line.itemId==='milk').quantity,150);
  const saved=copy(state.items);assert.strictEqual(settle(state),state);assert.deepEqual(state.items,saved);
});

test('historical food and supplement reservation credits are reused rather than debited or refunded at midnight',()=>{
  let state=fixture();const p=plan(state);
  p.status='reserved';delete p.foodAccounting;delete p.supplementAccounting;
  const amounts={rice:200,milk:150,beef:1,creatine:5};
  p.accountedDebits=state.items.map(item=>({itemId:item.id,name:item.name,quantity:amounts[item.id],unit:item.unit,unknownBalance:false,baselineToken:item.quantityBaselineToken??item.confirmedAt}));
  p.items=copy(p.accountedDebits);for(const item of state.items)item.quantity-=amounts[item.id];
  const quantities=state.items.map(item=>[item.id,item.quantity]),supplements=copy(p.supplementDoses);
  state=settle(state);
  assert.deepEqual(state.items.map(item=>[item.id,item.quantity]),quantities);
  assert.deepEqual(plan(state).supplementDoses,supplements);
  assert.equal(plan(state).dailySettlement.accounting,'settled');
  state=report(state,'lunch',[{id:'final-lunch80',itemId:'rice',quantity:80,unit:'g',sourceText:'之后明确午餐只吃80g'}],'complete');
  assert.equal(stock(state,'rice'),820,'only20g is refunded from the already-accounted daily total');
  assert.equal(stock(state,'milk'),850);assert.equal(stock(state,'beef'),9);assert.equal(stock(state,'creatine'),995);
});

test('unknown real portions or incompatible units remain pending for that food while other automatic foods settle',()=>{
  for(const [mealId,entry] of [
    ['lunch',{id:'unknown-rice',itemId:'rice',quantity:null,unit:'g',sourceText:'吃了，实际量还不清楚'}],
    ['dinner',{id:'different-beef-unit',itemId:'beef',quantity:66,unit:'g',sourceText:'实际66g，未核准库存袋的换算'}],
  ]) {
    let state=report(fixture(),mealId,[entry]);
    const facts=copy(plan(state).meals),badId=entry.itemId,badStock=stock(state,badId);
    state=settle(state);
    assert.equal(stock(state,badId),badStock,'the conflicting or unknown food is neither guessed nor charged');
    assert.equal(stock(state,'milk'),850);
    if(badId==='rice')assert.equal(stock(state,'beef'),9);
    else assert.equal(stock(state,'rice'),800);
    assert.deepEqual(plan(state).meals,facts);
    assert.equal(plan(state).dailySettlement.accounting,'pending_reconciliation');
    assert(plan(state).accountingIssues.some(issue=>issue.itemId===badId&&['ACTUAL_QUANTITY_UNKNOWN','UNIT_CONFLICT'].includes(issue.code)));
    assert.equal(plan(state).accountingIssues.some(issue=>issue.itemId!==badId),false);
  }
});

test('midnight never submits an outstanding intake draft or confuses its tentative amounts with actuals',()=>{
  let state=fixture();
  state=mutate(state,'save_intake_draft',{planId:plan(state).id,expectedDraftVersion:null,draft:{id:'unsent-tentative-portion',baseFingerprint:intakePlanFingerprint(plan(state),state.items),
    consumed:[{mealId:'lunch',lineId:'rice-l',quantity:40,unit:'g'}],transfers:[],completedMealIds:[]}});
  const draft=copy(plan(state).intakeDraft),facts=copy(plan(state).meals);
  state=settle(state);
  assert.equal(stock(state,'rice'),800,'standing policy uses saved menu, never the tentative40g');
  assert.deepEqual(plan(state).intakeDraft,draft);
  assert.deepEqual(plan(state).meals,facts);
  assert.equal(plan(state).intakeDraftAudit,undefined);
});

test('midnight uses Toronto dates, requires enabled matching standing policy, and never backfills older history',()=>{
  const state=fixture(),before=copy(state);
  assert.equal(torontoLocalDate('2026-10-27T03:59:59Z'),DAY);assert.equal(torontoLocalDate(MIDNIGHT),'2026-10-27');
  assert.equal(torontoLocalDate('2026-11-02T04:59:59Z'),'2026-11-01');assert.equal(torontoLocalDate('2026-11-02T05:00:00Z'),'2026-11-02');
  assert.throws(()=>settle(state,{},'2026-10-27T03:59:59Z'),error=>error.code==='DAILY_MENU_DAY_NOT_ENDED');
  assert.throws(()=>settle(state,{policyStartDate:'2026-10-25'}),error=>error.code==='DAILY_MENU_POLICY_CONFLICT');
  assert.throws(()=>settle(state,{effectiveDate:'2026-10-25'}),error=>error.code==='DAILY_MENU_DATE_CONFLICT');
  const disabled=copy(state);disabled.dailyMenuSettlementPolicy.enabled=false;
  assert.throws(()=>settle(disabled),error=>error.code==='DAILY_MENU_POLICY_REQUIRED');
  const old=copy(state);old.dailyMenuSettlementPolicy.startsOn='2026-10-27';
  assert.throws(()=>settle(old),error=>error.code==='DAILY_MENU_BEFORE_POLICY');
  assert.deepEqual(state,before);
});
