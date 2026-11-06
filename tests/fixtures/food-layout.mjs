import {applyMutation,validateItem} from '../../lib/inventory.mjs';
import {planNutritionTotals,planNutritionLines} from '../../lib/diet-nutrition.mjs';
import {intakePlanFingerprint} from '../../lib/intake-draft.mjs';

// Invented display-layout records; no private meals or stock data.
export const DAY='2026-04-09',AT=DAY+'T14:00:00.000Z',LATER=DAY+'T18:00:00.000Z',ID='demo-layout-day';
let sequence=0;
export const copy=value=>structuredClone(value);
export const plan=state=>state.plans[0];
export const meal=(state,id)=>plan(state).meals.find(value=>value.id===id);
export const mutate=(state,action,fields={},at=LATER)=>applyMutation(state,{action,operationId:'demo-layout-'+(++sequence),expectedRevision:state.revision,...fields},at);
export const move=(sourceMealId,sourceKind,sourceId,targetMealId)=>({sourceMealId,sourceKind,sourceId,targetMealId});
export const recipeMoves=target=>['square-oats','square-milk','square-egg'].map(id=>move('breakfast','planned',id,target));
export const nutrition=state=>planNutritionTotals(plan(state));
export const canonicalLines=state=>planNutritionLines(plan(state));
export function fixture({pending=false}={}){
  const food=(id,unit,quantity,kcal,basis=100)=>validateItem({id,name:'DEMO '+id,unit,quantity,category:id==='demo-mineral'?'supplement':'other',
    nutrition:{basisAmount:basis,basisUnit:unit,kcal,protein:2,carbs:3,fat:1,source:'label',sourceText:'DEMO invented package evidence'}},AT);
  let state={schemaVersion:1,revision:0,updatedAt:AT,items:[food('demo-oats','g',1000,400),food('demo-milk','ml',1000,50),food('demo-egg','个',12,70,1),
    food('demo-sauce','g',250,100),food('demo-rice','g',1000,100),food('demo-mineral','粒',20,0,1)],plans:[],events:[],operationIds:[],preferences:['DEMO preserved preference'],dietHistory:[],
    dailyMenuSettlementPolicy:{version:1,enabled:false,timeZone:'America/Toronto',startsOn:DAY,updatedAt:AT,sourceText:'DEMO disabled auto settlement'}};
  state=mutate(state,'save_meal_plan_draft',{plan:{id:ID,date:DAY,title:'DEMO visual meal assignments',meals:[
    {id:'breakfast',slot:'breakfast',title:'DEMO mixed-unit oat square',plannedItems:[{id:'square-oats',itemId:'demo-oats',quantity:40},{id:'square-milk',itemId:'demo-milk',quantity:90},{id:'square-egg',itemId:'demo-egg',quantity:1}],
      recipeGroups:[{id:'demo-oat-square',name:'DEMO oat square',lineIds:['square-oats','square-milk','square-egg'],portion:0.5}]},
    {id:'lunch',slot:'lunch',title:'DEMO sauce',plannedItems:[{id:'sauce-line',itemId:'demo-sauce',quantity:15}]},
    {id:'dinner',slot:'dinner',title:'DEMO rice',plannedItems:[{id:'rice-line',itemId:'demo-rice',quantity:80}]},
  ],supplementDoses:[{id:'demo-layout-dose',itemId:'demo-mineral',plannedQuantity:1,timingSlot:'breakfast'}]}},AT);
  state=mutate(state,'record_meal_intake',{planId:ID,mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:'DEMO already ate the planned sauce'},AT);
  state=mutate(state,'set_food_personal_check',{planId:ID,mealId:'breakfast',lineIds:['square-oats','square-egg'],checked:true},AT);
  state=mutate(state,'set_food_personal_check',{planId:ID,mealId:'lunch',wholeMeal:true,checked:true},AT);
  state=mutate(state,'set_supplement_check',{planId:ID,doseId:'demo-layout-dose',checked:true},AT);
  state.dietHistory=[{id:'demo-layout-history',date:'2026-04-08',recordType:'diet_history',sourceText:'DEMO retained prior history'}];
  if(pending)state=mutate(state,'save_intake_draft',{planId:ID,expectedDraftVersion:null,draft:{id:'demo-layout-pending',baseFingerprint:intakePlanFingerprint(plan(state),state.items),
    consumed:[{mealId:'breakfast',lineId:'square-oats',quantity:5,unit:'g'}],transfers:[],completedMealIds:[]}},AT);
  return state;
}
export function nonLayoutFacts(state){
  const result=copy(state);
  delete result.revision;delete result.updatedAt;delete result.events;delete result.operationIds;
  for(const p of result.plans??[]){delete p.updatedAt;delete p.foodLayoutOverrides;delete p.foodLayoutHistory;}
  return result;
}
