import {applyMutation,validateItem} from '../../lib/inventory.mjs';
import {planNutritionTotals} from '../../lib/diet-nutrition.mjs';

// Invented records only: no private inventory, meals or health history.
export const DAY='2026-02-12',AT=DAY+'T14:00:00.000Z',LATER=DAY+'T18:00:00.000Z',ID='demo-sync-day';
let sequence=0;
export const copy=value=>structuredClone(value);
export const plan=state=>state.plans.find(entry=>entry.id===ID);
export const meal=(state,id='breakfast')=>plan(state).meals.find(entry=>entry.id===id);
export const stock=(state,id)=>state.items.find(entry=>entry.id===id).quantity;
export const mutate=(state,action,fields={},at=LATER)=>applyMutation(state,{action,operationId:'demo-fixture-'+(++sequence),expectedRevision:state.revision,...fields},at);
export const nutrientValues=p=>planNutritionTotals(p).map(({key,value,partial,supplementPartial,missing,supplementMissing})=>({key,value,partial,supplementPartial,missing,supplementMissing}));
export function fixture({groups=true,enabled=false}={}){
  const food=(id,unit,quantity,kcal,category='protein')=>validateItem({id,name:'DEMO '+id,category,unit,quantity,
    nutrition:{basisAmount:unit==='个'||unit==='粒'?1:100,basisUnit:unit,kcal,protein:1,carbs:2,fat:0.5,source:'label',sourceText:'DEMO synthetic package label'}},AT);
  let state={schemaVersion:1,revision:0,updatedAt:AT,items:[food('demo-cereal','g',1000,400,'staple'),food('demo-yogurt','g',1000,60),
    food('demo-milk','ml',1000,50),food('demo-fruit','个',5,70,'fruit'),food('demo-supplement','粒',20,10,'supplement')],
    plans:[],events:[],operationIds:[],preferences:['DEMO continuing preference'],dietHistory:[],
    dailyMenuSettlementPolicy:{version:1,enabled,timeZone:'America/Toronto',startsOn:DAY,updatedAt:AT,sourceText:'DEMO explicit settlement policy'}};
  state=mutate(state,'save_meal_plan_draft',{plan:{id:ID,date:DAY,title:'DEMO sync plan',meals:[
    {id:'breakfast',slot:'breakfast',title:'DEMO breakfast',plannedTime:'08:30',plannedItems:[{id:'bf-cereal',itemId:'demo-cereal',quantity:100},{id:'bf-yogurt',itemId:'demo-yogurt',quantity:100}],
      ...(groups?{recipeGroups:[{id:'demo-bowl',name:'DEMO bowl',lineIds:['bf-cereal','bf-yogurt'],portion:1}]}:{})},
    {id:'lunch',slot:'lunch',title:'DEMO lunch',plannedItems:[{id:'l-cereal',itemId:'demo-cereal',quantity:80},{id:'l-milk',itemId:'demo-milk',quantity:100}]},
    {id:'dinner',slot:'dinner',title:'DEMO dinner',plannedItems:[{id:'d-fruit',itemId:'demo-fruit',quantity:1}]},
  ],supplementDoses:[{id:'demo-dose',itemId:'demo-supplement',plannedQuantity:1,timingSlot:'breakfast'}]}},AT);
  state=mutate(state,'commit_meal_plan',{planId:ID,confirmed:true},AT);
  state=mutate(state,'patch_meal_plan',{planId:ID,mode:'draft',mealPatches:[{id:'breakfast',title:'DEMO amended breakfast'}]},AT);
  state=mutate(state,'record_meal_intake',{planId:ID,mealId:'breakfast',mode:'complete',actualTime:'08:40',sourceText:'DEMO complete actual breakfast',entries:[
    {id:'demo-eaten-cereal',itemId:'demo-cereal',quantity:60,unit:'g',sourceText:'DEMO actual 60 g'},
    {id:'demo-eaten-fruit',itemId:'demo-fruit',quantity:1,unit:'个',sourceText:'DEMO actual fruit'},
  ]},AT);
  state=mutate(state,'set_food_personal_check',{planId:ID,mealId:'breakfast',lineIds:['bf-cereal'],checked:true},AT);
  state=mutate(state,'set_supplement_check',{planId:ID,doseId:'demo-dose',checked:true},AT);
  state.dietHistory=[{id:'demo-history',date:'2026-02-11',recordType:'diet_history',sourceText:'DEMO preserved historical evidence'}];
  return state;
}
export function preserved(state){
  const p=plan(state);
  return {items:copy(state.items),dietHistory:copy(state.dietHistory),preferences:copy(state.preferences),policy:copy(state.dailyMenuSettlementPolicy),
    planFields:copy(Object.fromEntries(Object.entries(p).filter(([key])=>!['meals','updatedAt'].includes(key)))),
    facts:p.meals.map(m=>copy(Object.fromEntries(Object.entries(m).filter(([key])=>!['plannedItems','recipeGroups','planRevisionHistory'].includes(key))))) };
}
