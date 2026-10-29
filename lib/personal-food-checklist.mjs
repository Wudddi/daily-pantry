import { projectCurrentDietPlan } from './diet-current-plan.mjs';

const rows=value=>Array.isArray(value)?value:[];
function fail(message,status=400,code='INVALID_PERSONAL_FOOD_CHECK') { throw Object.assign(new Error(message),{status,code}); }
function id(value,label) { if(typeof value!=='string'||!value.trim()||value.length>100) fail(label+'必须是1至100字符。'); return value.trim(); }
export function isPersonalFoodChecked(plan,mealId,lineId) {
  return rows(plan?.personalFoodChecks?.checks).find(check=>check.mealId===mealId&&check.lineId===lineId)?.checked===true;
}

/** Private visual reminders. These are deliberately never actual intake. */
export function applyPersonalFoodCheck(state,payload,at) {
  const allowed=new Set(['action','operationId','expectedRevision','planId','mealId','lineIds','wholeMeal','checked']);
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.has(key))) fail('个人饮食标记包含不支持的字段。');
  const planId=id(payload.planId,'计划ID'),mealId=id(payload.mealId,'餐次ID');
  if(typeof payload.checked!=='boolean') fail('checked必须明确为true或false。');
  if(payload.wholeMeal!==undefined&&payload.wholeMeal!==true) fail('wholeMeal只能为true。');
  if(payload.wholeMeal===true&&payload.lineIds!==undefined) fail('整餐标记不能同时指定lineIds。');
  const index=rows(state.plans).findIndex(plan=>plan.id===planId),original=rows(state.plans)[index];
  if(!original) fail('找不到饮食计划。',404,'PLAN_NOT_FOUND');
  if(original.format!=='meals_v1') fail('此操作仅用于结构化餐次。',409,'LEGACY_PLAN_CONFLICT');
  if(original.status==='cancelled') fail('已取消菜单不能新增个人标记。',409,'PLAN_CLOSED');
  const current=projectCurrentDietPlan(original,state.items),meal=rows(current.meals).find(meal=>meal.id===mealId);
  if(!meal) fail('找不到餐次。',404,'MEAL_NOT_FOUND');
  const lineIds=payload.wholeMeal===true?rows(meal.plannedItems).filter(line=>line.quantity>0).map(line=>line.id)
    :Array.isArray(payload.lineIds)&&payload.lineIds.length<=100?payload.lineIds.map(value=>id(value,'食物行ID')):null;
  if(lineIds===null||new Set(lineIds).size!==lineIds.length) fail('lineIds应为不重复的食物行ID列表。');
  for(const lineId of lineIds) if(!rows(meal.plannedItems).some(line=>line.id===lineId)) fail('个人标记的食物行已变更，请刷新。',404,'PLANNED_LINE_NOT_FOUND');
  const previous=original.personalFoodChecks;
  if(previous!==undefined&&(previous.version!==1||!Array.isArray(previous.checks))) fail('个人标记格式异常，旧记录已保留。',409,'PERSONAL_CHECKS_REQUIRE_REVIEW');
  const checks=structuredClone(previous?.checks??[]);
  let changed=false;
  for(const lineId of lineIds) {
    const atIndex=checks.findIndex(check=>check.mealId===mealId&&check.lineId===lineId);
    if((atIndex<0?false:checks[atIndex].checked)===payload.checked) continue;
    const check={mealId,lineId,checked:payload.checked,updatedAt:at};
    if(atIndex<0) checks.push(check); else checks[atIndex]=check;
    changed=true;
  }
  if(!changed) return {items:state.items,plans:state.plans??[],detail:'个人标记已是此状态；没有变更实际进食或库存。',noChange:true};
  if(checks.length>1600) fail('个人标记达到保存上限，请先核对旧行。',409,'PERSONAL_CHECKS_LIMIT');
  const next={...original,personalFoodChecks:{version:1,checks,updatedAt:at},updatedAt:at};
  const plans=state.plans.slice();plans[index]=next;
  return {items:state.items,plans,detail:'已保存个人饮食标记；不作为Chat实际摄入依据，不改进食、补给或库存。'};
}
