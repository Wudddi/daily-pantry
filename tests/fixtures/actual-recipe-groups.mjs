import {applyMutation,validateItem} from '../../lib/inventory.mjs';
import {planNutritionTotals} from '../../lib/diet-nutrition.mjs';

// Entirely invented records. Shared SKUs deliberately occur in two dishes.
export const DAY='2026-03-18',AT=DAY+'T14:00:00.000Z',LATER=DAY+'T16:00:00.000Z',ID='demo-explicit-actual-dishes';
export const copy=value=>structuredClone(value);
export const plan=state=>state.plans[0];
export const breakfast=state=>plan(state).meals[0];
export const snack=state=>plan(state).meals[1];
let sequence=0;
export const mutate=(state,action,fields={},at=LATER)=>applyMutation(state,{action,operationId:'demo-actual-groups-'+(++sequence),expectedRevision:state.revision,...fields},at);
export const squareIngredients=[['oats',23],['yogurt',47],['egg',31],['cocoa',4],['plum',38],['oil',3],['flour',13],['baking',1],['walnut',7]];
export const custardIngredients=[['yogurt',63],['egg',29],['cream',19],['starch',6],['vanilla',2],['lemon',8]];
export const explicitGroups=()=>[
  {id:'demo-square',name:'DEMO cocoa plum squares',actualEntryIds:squareIngredients.map(([id])=>'actual-square-'+id),portion:0.5},
  {id:'demo-custard',name:'DEMO citrus custard',actualEntryIds:custardIngredients.map(([id])=>'actual-custard-'+id),portion:0.5},
];
export const nutrition=state=>planNutritionTotals(plan(state));
export function fixture({reported=true,withGroups=false}={}){
  const ids=[...new Set([...squareIngredients,...custardIngredients].map(([id])=>id)),'apple','pear'];
  const food=id=>validateItem({id:'demo-'+id,name:'DEMO '+id,quantity:2000,unit:'g',category:'other',
    nutrition:{basisAmount:100,basisUnit:'g',kcal:125,protein:7,carbs:13,fat:5,source:'label',sourceText:'DEMO invented nutrition label'}},AT);
  const supp=validateItem({id:'demo-mineral',name:'DEMO mineral',quantity:20,unit:'粒',category:'supplement',
    nutrition:{basisAmount:1,basisUnit:'粒',kcal:0,protein:0,carbs:0,fat:0,source:'label'}},AT);
  const lines=(prefix,ingredients,multiple=1)=>ingredients.map(([id,q])=>({id:prefix+id,itemId:'demo-'+id,quantity:q*multiple}));
  let state={schemaVersion:1,revision:0,updatedAt:AT,items:[...ids.map(food),supp],plans:[],events:[],operationIds:[],preferences:['DEMO preference retained'],dietHistory:[],
    dailyMenuSettlementPolicy:{version:1,enabled:false,timeZone:'America/Toronto',startsOn:DAY,updatedAt:AT,sourceText:'DEMO disabled automatic settlement'}};
  state=mutate(state,'save_meal_plan_draft',{plan:{id:ID,date:DAY,title:'DEMO separate actual dishes',meals:[
    {id:'breakfast',slot:'breakfast',title:'DEMO planned square',plannedItems:lines('planned-square-',squareIngredients,2),
      recipeGroups:[{id:'planned-square',name:'DEMO planned cocoa plum squares',lineIds:squareIngredients.map(([id])=>'planned-square-'+id),portion:1}]},
    {id:'snack',slot:'snack',title:'DEMO two planned dishes',plannedItems:[...lines('snack-square-',squareIngredients),...lines('snack-custard-',custardIngredients)],recipeGroups:[
      {id:'snack-square',name:'DEMO cocoa plum squares',lineIds:squareIngredients.map(([id])=>'snack-square-'+id),portion:0.5},
      {id:'snack-custard',name:'DEMO citrus custard',lineIds:custardIngredients.map(([id])=>'snack-custard-'+id),portion:0.5}]},
  ],supplementDoses:[{id:'demo-dose',itemId:'demo-mineral',plannedQuantity:1,timingSlot:'breakfast'}]}},AT);
  if(reported){
    const entries=(prefix,ingredients,label)=>ingredients.map(([id,quantity])=>({id:prefix+id,itemId:'demo-'+id,quantity,unit:'g',
      name:'Half '+label+': DEMO '+id,sourceText:'DEMO reported ingredient, unchanged'}));
    state=mutate(state,'record_meal_intake',{planId:ID,mealId:'breakfast',mode:'complete',entries:[
      ...entries('actual-square-',squareIngredients,'DEMO cocoa plum squares'),...entries('actual-custard-',custardIngredients,'DEMO citrus custard'),
      {id:'actual-apple',itemId:'demo-apple',quantity:73,unit:'g',sourceText:'DEMO separate fruit'},
      {id:'actual-pear',itemId:'demo-pear',quantity:81,unit:'g',sourceText:'DEMO separate fruit'}],
      ...(withGroups?{actualRecipeGroups:explicitGroups()}:{}),sourceText:'DEMO completed two dishes and fruit'},AT);
  }
  state=mutate(state,'set_food_personal_check',{planId:ID,mealId:'breakfast',lineIds:['planned-square-oats'],checked:true},AT);
  state=mutate(state,'set_supplement_check',{planId:ID,doseId:'demo-dose',checked:true},AT);
  state.dietHistory=[{id:'demo-preserved-history',date:'2026-03-17',recordType:'diet_history',sourceText:'DEMO prior history'}];
  return state;
}
export function nonGroupingFacts(state){
  const result=copy(state);
  delete result.revision;delete result.updatedAt;delete result.events;delete result.operationIds;
  for(const p of result.plans??[]){delete p.updatedAt;for(const m of p.meals??[]){delete m.actualRecipeGroups;delete m.actualRecipeGroupHistory;}}
  return result;
}
