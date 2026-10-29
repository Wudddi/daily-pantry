import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation } from '../lib/inventory.mjs';
import { readDailyMenuSettlementPolicy } from '../lib/daily-menu-policy.mjs';
import { dailyMenuSettlementCandidates } from '../lib/daily-menu-runner.mjs';
import { aiFoodReadState } from '../lib/ai-food-read-state.mjs';
const at='2026-10-26T20:00:00.000Z';
const state=()=>({schemaVersion:1,revision:0,updatedAt:at,items:[],plans:[],preferences:[],events:[],operationIds:[]});
const policy=(s,enabled,startsOn='2026-10-26')=>applyMutation(s,{action:'set_daily_menu_settlement_policy',operationId:'policy-'+s.revision,expectedRevision:s.revision,enabled,timeZone:'America/Toronto',startsOn,confirmed:true,sourceText:'用户明确开启个人提醒与日终菜单结算'},at);
const plan=(date,extra={})=>({id:'day-'+date,date,format:'meals_v1',status:'draft',meals:[{id:'lunch'}],...extra});
test('policy activation persists explicit authority without modifying food, menu, actual or personal checks',()=>{
  const before=state();before.plans=[plan('2026-10-26',{personalFoodChecks:{version:1,checks:[]},actualMarker:'unchanged'})];
  const result=policy(before,true);
  assert.equal(result.revision,1);assert.equal(result.dailyMenuSettlementPolicy.startsOn,'2026-10-26');
  assert.deepEqual(result.items,before.items);assert.deepEqual(result.plans,before.plans);assert.deepEqual(result.preferences,before.preferences);
  const p=readDailyMenuSettlementPolicy(result);p.enabled=false;assert.equal(result.dailyMenuSettlementPolicy.enabled,true);
});
test('re-enabling does not retroactively settle days while the rule was disabled',()=>{
  const off=policy(policy(state(),true),false);const on=policy(off,true,'2026-10-29');
  on.plans=[plan('2026-10-27'),plan('2026-10-29')];
  const result=dailyMenuSettlementCandidates(on,'2026-10-30T04:00:00Z');
  assert.deepEqual(result.candidates.map(p=>p.date),['2026-10-29']);
  assert.throws(()=>policy(on,true,'2026-10-20'),e=>e.status===400);
});
test('Toronto midnight and the enabled cutoff control eligibility independently of every personal checkbox',()=>{
  const s=policy(state(),true);s.plans=[plan('2026-10-25'),plan('2026-10-26',{personalFoodChecks:{checks:[{checked:false}]}})];
  assert.equal(dailyMenuSettlementCandidates(s,'2026-10-27T03:59:59Z').candidates.length,0);
  assert.deepEqual(dailyMenuSettlementCandidates(s,'2026-10-27T04:00:00Z').candidates.map(p=>p.date),['2026-10-26']);
  s.plans[1].personalFoodChecks.checks[0].checked=true;
  assert.deepEqual(dailyMenuSettlementCandidates(s,'2026-10-27T04:00:00Z').candidates.map(p=>p.date),['2026-10-26']);
});
test('old processed days cannot starve a new due day and ambiguous canonical dates are not guessed',()=>{
  const s=policy(state(),true,'2026-10-01');s.plans=Array.from({length:12},(_,i)=>{const date='2026-10-'+String(i+1).padStart(2,'0');return plan(date,{dailySettlement:{source:'automatic_menu',date,accounting:i%2?'settled':'pending_reconciliation'}});});
  s.plans.push(plan('2026-10-26'),plan('2026-10-25'),plan('2026-10-25',{id:'duplicate'}));
  const result=dailyMenuSettlementCandidates(s,'2026-10-27T04:00:00Z');assert.deepEqual(result.candidates.map(p=>p.date),['2026-10-26']);assert.deepEqual(result.ambiguousDates,['2026-10-25']);assert.equal(result.pendingPreviousCount,6);
});

test('closed actual days cannot fill the seven-candidate batch and starve a later saved menu',()=>{
  const s=policy(state(),true,'2026-10-01');
  s.plans=Array.from({length:12},(_,i)=>plan('2026-10-'+String(i+1).padStart(2,'0'),{status:'closed_with_actuals'}));
  s.plans.push(plan('2026-10-26'));
  const before=structuredClone(s);
  const result=dailyMenuSettlementCandidates(s,'2026-10-27T04:00:00Z');
  assert.equal(result.total,1);assert.equal(result.hasMore,false);
  assert.deepEqual(result.candidates.map(p=>p.planId),['day-2026-10-26']);
  assert.deepEqual(s,before);
});

test('a legacy supplement-only record with a saved food draft is eligible through the same current-menu projection as settlement',()=>{
  const s=policy(state(),true);
  s.plans=[plan('2026-10-26',{status:'reserved',supplementOnly:true,meals:[],supplementDoses:[],
    draft:{id:'day-2026-10-26',date:'2026-10-26',title:'已保存的早餐菜单',meals:[{id:'breakfast',slot:'breakfast',title:'早餐',plannedItems:[{id:'existing-food',itemId:'food',quantity:100,unit:'g'}]}],supplementDoses:[]},
    personalFoodChecks:{version:1,checks:[{mealId:'breakfast',lineId:'existing-food',checked:false,updatedAt:at}],updatedAt:at}}),
    plan('2026-10-27',{supplementOnly:true,meals:[],supplementDoses:[],draft:{meals:[]}})];
  const before=structuredClone(s);
  const result=dailyMenuSettlementCandidates(s,'2026-10-27T04:00:00Z');
  assert.deepEqual(result.candidates.map(p=>p.planId),['day-2026-10-26']);
  assert.equal(result.total,1);
  assert.deepEqual(s,before,'selection never materializes or rewrites a legacy record');
  s.plans[0].draft.meals=[];
  assert.equal(dailyMenuSettlementCandidates(s,'2026-10-27T04:00:00Z').total,0,'genuine supplement-only days still do not consume food');
});
test('AI read state omits only private personal reminders while preserving actual evidence and source state',()=>{
  const s=state();s.plans=[plan('2026-10-26',{personalFoodChecks:{checks:[{checked:false}]},draft:{personalFoodChecks:{checks:[{checked:true}]},title:'菜单'},actualEntries:[{id:'real',quantity:60}]})];
  const before=structuredClone(s),safe=aiFoodReadState(s);assert.ok(!JSON.stringify(safe).includes('personalFoodChecks'));assert.deepEqual(safe.plans[0].actualEntries,s.plans[0].actualEntries);assert.deepEqual(s,before);
});
