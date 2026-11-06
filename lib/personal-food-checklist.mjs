import { projectCurrentDietPlan } from './diet-current-plan.mjs';

const rows=value=>Array.isArray(value)?value:[];
function fail(message,status=400,code='INVALID_PERSONAL_FOOD_CHECK') { throw Object.assign(new Error(message),{status,code}); }
function id(value,label) { if(typeof value!=='string'||!value.trim()||value.length>100) fail(label+" must contain 1 to 100 characters."); return value.trim(); }
export function isPersonalFoodChecked(plan,mealId,lineId) {
  return rows(plan?.personalFoodChecks?.checks).find(check=>check.mealId===mealId&&check.lineId===lineId)?.checked===true;
}

/** Private visual reminders. These are deliberately never actual intake. */
export function applyPersonalFoodCheck(state,payload,at) {
  const allowed=new Set(['action','operationId','expectedRevision','planId','mealId','lineIds','wholeMeal','checked']);
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.has(key))) fail("Personal food checkmarks contain unsupported fields.");
  const planId=id(payload.planId,"Plan ID"),mealId=id(payload.mealId,"Meal ID");
  if(typeof payload.checked!=='boolean') fail("checked must explicitly be true or false.");
  if(payload.wholeMeal!==undefined&&payload.wholeMeal!==true) fail("wholeMeal may only be true.");
  if(payload.wholeMeal===true&&payload.lineIds!==undefined) fail("Whole-meal checkmarks cannot also specify lineIds.");
  const index=rows(state.plans).findIndex(plan=>plan.id===planId),original=rows(state.plans)[index];
  if(!original) fail("Diet plan not found.",404,'PLAN_NOT_FOUND');
  if(original.format!=='meals_v1') fail("This action applies only to structured meals.",409,'LEGACY_PLAN_CONFLICT');
  if(original.status==='cancelled') fail("Personal checkmarks cannot be added to cancelled menus.",409,'PLAN_CLOSED');
  const current=projectCurrentDietPlan(original,state.items),meal=rows(current.meals).find(meal=>meal.id===mealId);
  if(!meal) fail("Meal not found.",404,'MEAL_NOT_FOUND');
  const lineIds=payload.wholeMeal===true?rows(meal.plannedItems).filter(line=>line.quantity>0).map(line=>line.id)
    :Array.isArray(payload.lineIds)&&payload.lineIds.length<=100?payload.lineIds.map(value=>id(value,"Food line ID")):null;
  if(lineIds===null||new Set(lineIds).size!==lineIds.length) fail("lineIds must be a list of unique food line IDs.");
  for(const lineId of lineIds) if(!rows(meal.plannedItems).some(line=>line.id===lineId)) fail("A food line for the personal checkmark changed. Refresh it.",404,'PLANNED_LINE_NOT_FOUND');
  const previous=original.personalFoodChecks;
  if(previous!==undefined&&(previous.version!==1||!Array.isArray(previous.checks))) fail("Personal checkmarks have an invalid format. Previous records were preserved.",409,'PERSONAL_CHECKS_REQUIRE_REVIEW');
  const checks=structuredClone(previous?.checks??[]);
  let changed=false;
  for(const lineId of lineIds) {
    const atIndex=checks.findIndex(check=>check.mealId===mealId&&check.lineId===lineId);
    if((atIndex<0?false:checks[atIndex].checked)===payload.checked) continue;
    const check={mealId,lineId,checked:payload.checked,updatedAt:at};
    if(atIndex<0) checks.push(check); else checks[atIndex]=check;
    changed=true;
  }
  if(!changed) return {items:state.items,plans:state.plans??[],detail:"Personal checkmarks already have this state. Actual intake and inventory were unchanged.",noChange:true};
  if(checks.length>1600) fail("The personal-checkmark save limit was reached. Review old lines first.",409,'PERSONAL_CHECKS_LIMIT');
  const next={...original,personalFoodChecks:{version:1,checks,updatedAt:at},updatedAt:at};
  const plans=state.plans.slice();plans[index]=next;
  return {items:state.items,plans,detail:"Personal food checkmarks were saved. They are not Chat intake evidence and do not change intake, supplements, or inventory."};
}
