import { projectCurrentDietPlan } from './diet-current-plan.mjs';

const rows=value=>Array.isArray(value)?value:[];
const copy=value=>structuredClone(value);
const keyName=value=>typeof value==='string'?value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,''):'';
const foodKey=entry=>entry.itemId===null?'external:'+keyName(entry.name??entry.nutritionSnapshot?.name)+':'+entry.unit:'item:'+entry.itemId;
function fail(message,status=400,code='INVALID_DAILY_MENU_SETTLEMENT') { throw Object.assign(new Error(message),{status,code}); }
function day(value) { return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value; }
export function torontoLocalDate(at=new Date().toISOString()) {
  const value=new Date(at);if(!Number.isFinite(value.valueOf())) fail('结算时间必须为真实时间。');
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
}
function plannedMeals(plan) {
  return rows(plan.meals).map(meal=>({mealId:meal.id,plannedItems:rows(meal.plannedItems).map(line=>({id:line.id,itemId:line.itemId,
    ...(line.itemId===null?{name:line.name??line.nutritionSnapshot?.name??''}:{}),quantity:line.quantity,unit:line.unit}))}));
}
export function dailyMenuPlannedFingerprint(plan) {
  const value=JSON.stringify({id:plan.id,date:plan.date,meals:plannedMeals(plan)});
  let a=2166136261,b=0x9e3779b9;
  for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),2246822519);}
  return 'menu-'+(a>>>0).toString(16)+(b>>>0).toString(16)+'-'+value.length;
}
function unknownCompletedEntries(meal,basis) {
  if(rows(meal.actualEntries).length||!['completed'].includes(meal.state)) return [];
  // A historical completion without amounts is not a report of zero intake.
  return rows(basis.plannedItems).filter(line=>line.itemId!==null).map(line=>({id:'auto-unknown-'+line.id,itemId:line.itemId,
    name:line.name??'',quantity:null,unit:line.unit}));
}
function accountingView(plan) {
  const settlement=plan.dailySettlement;
  if(settlement?.source!=='automatic_menu'||settlement.date!==plan.date||!Array.isArray(settlement.plannedMeals)) return {plan,assumedMealIds:[]};
  const sourceById=new Map(rows(plan.meals).map(meal=>[meal.id,meal]));
  const assumedMealIds=[];
  const meals=settlement.plannedMeals.map(basis=>{
    const source=sourceById.get(basis.mealId)??{id:basis.mealId,state:'reserved',actualEntries:[],reportHistory:[],actualTime:null,actualTimeText:'',completionReportedAt:null};
    const actualEntries=copy(rows(source.actualEntries));
    let assumed=false;
    if(!['completed','cancelled'].includes(source.state)) {
      const groups=new Map();
      for(const line of rows(basis.plannedItems)) {
        if(!(typeof line.quantity==='number'&&line.quantity>0)) continue;
        const key=foodKey(line);if(!groups.has(key)) groups.set(key,[]);groups.get(key).push(line);
      }
      for(const [key,lines] of groups) {
        const facts=rows(source.actualEntries).filter(entry=>foodKey(entry)===key),first=lines[0];
        let quantity=lines.reduce((sum,line)=>sum+line.quantity,0);
        if(facts.length) {
          // A partial progress report does not mean the rest of the saved menu
          // was left uneaten. Midnight fills the remaining planned amount,
          // while explicit zero and a later correction override that default.
          if(facts.some(entry=>entry.quantity===null||typeof entry.quantity!=='number'||!Number.isFinite(entry.quantity))) continue;
          const sum=facts.reduce((total,entry)=>total+entry.quantity,0);
          const ids=new Set(facts.map(entry=>entry.id));
          const lastReport=rows(source.reportHistory).findLast(report=>rows(report.entryIds).some(id=>ids.has(id)));
          if(sum===0||lastReport?.mode==='correct') continue;
          // Different units remain an accounting conflict; do not infer a
          // gram/package conversion from current mutable package metadata.
          if(facts.some(entry=>entry.unit!==first.unit)||lines.some(line=>line.unit!==first.unit)) continue;
          quantity=Math.max(0,Math.round((quantity-sum)*1e6)/1e6);
        }
        if(quantity<=0) continue;
        actualEntries.push({id:'auto-menu-'+basis.mealId+'-'+first.id,itemId:first.itemId,name:first.name??'',quantity,unit:first.unit});
        assumed=true;
      }
    } else actualEntries.push(...unknownCompletedEntries(source,basis));
    if(assumed) assumedMealIds.push(basis.mealId);
    return {...source,plannedItems:[],actualEntries,state:'completed'};
  });
  // New genuine reports whose meal was not in the original saved menu remain
  // genuine facts. They do not manufacture another automatically planned meal.
  for(const meal of rows(plan.meals)) if(!meals.some(old=>old.id===meal.id)) meals.push({...copy(meal),plannedItems:[],state:'completed'});
  const accountingPlan={...plan,meals,foodAccounting:'actual_only',allocationAdjustments:{},
    ...(plan.legacyReservations?{legacyReservations:{...copy(plan.legacyReservations),meals:meals.map(meal=>({id:meal.id,plannedItems:[]})),allocationAdjustments:{}}}:{})};
  return {plan:accountingPlan,assumedMealIds};
}

/** Transient accounting only: none of the synthesized entries are persisted. */
export function dailyMenuAccountingPlan(plan) { return accountingView(plan).plan; }
export function dailyMenuAssumedMealIds(plan) { return accountingView(plan).assumedMealIds; }

/** Validate the enabled standing policy and freeze the latest saved menu once.
 * Actual meals, personal marks and supplement checks are never rewritten. */
export function prepareDailyMenuSettlement(state,original,payload,at) {
  const allowed=new Set(['action','operationId','expectedRevision','planId','effectiveDate','policyStartDate','confirmed']);
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.has(key))) fail('日终结算包含不支持的字段。');
  if(payload.confirmed!==true) fail('日终结算需要已开启的用户明确授权。',403,'DAILY_MENU_POLICY_REQUIRED');
  const policy=state.dailyMenuSettlementPolicy;
  if(policy?.version!==1||policy.enabled!==true||policy.timeZone!=='America/Toronto'||!day(policy.startsOn)) fail('尚未开启午夜自动结算策略。',403,'DAILY_MENU_POLICY_REQUIRED');
  if(payload.policyStartDate!==policy.startsOn) fail('日终结算策略已变化，请重新读取。',409,'DAILY_MENU_POLICY_CONFLICT');
  if(!day(payload.effectiveDate)||payload.effectiveDate!==original.date) fail('effectiveDate必须与原计划日期一致。',409,'DAILY_MENU_DATE_CONFLICT');
  if(original.date<policy.startsOn) fail('此菜单早于自动结算开启日期，不补扣历史库存。',409,'DAILY_MENU_BEFORE_POLICY');
  if(torontoLocalDate(at)<=original.date) fail('此菜单日期尚未结束，不能提前结算。',409,'DAILY_MENU_DAY_NOT_ENDED');
  if(original.format!=='meals_v1') fail('历史平铺记录不能自动转换或再次扣减。',409,'LEGACY_PLAN_CONFLICT');
  if(['cancelled','closed_with_actuals'].includes(original.status)) return {noChange:true,detail:'这一天已取消或结束，自动结算跳过，原实际与旧账保持。'};
  const plan=projectCurrentDietPlan(original,state.items);
  if(!rows(plan.meals).length) return {noChange:true,detail:'当天没有保存食物菜单，补剂独立保留，未自动结算。'};
  if(original.dailySettlement?.source==='automatic_menu'&&original.dailySettlement.date===original.date) return {noChange:true,detail:original.dailySettlement.accounting==='pending_reconciliation'?'本日自动结算已尝试且待核对；没有重复扣减或自动清除旧问题。':'本日菜单已自动结算；重复请求不会再次扣减。'};
  const metadata={version:1,date:plan.date,effectiveDate:payload.effectiveDate,source:'automatic_menu',basis:'auto_planned',
    policyStartDate:policy.startsOn,attemptedAt:at,settledAt:null,lastReconciledAt:at,plannedFingerprint:dailyMenuPlannedFingerprint(plan),
    plannedMeals:plannedMeals(plan),assumedMealIds:[],accounting:'pending_reconciliation'};
  const next={...copy(plan),dailySettlement:metadata};
  next.dailySettlement.assumedMealIds=dailyMenuAssumedMealIds(next);
  return {plan:next,noChange:false};
}
