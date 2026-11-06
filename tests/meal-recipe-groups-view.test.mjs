import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMealRecipeRows } from '../lib/meal-recipe-groups-view.mjs';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { mealNutritionView } from '../lib/meal-nutrition-view.mjs';

const food=(id,itemId,name)=>({id,itemId,name,quantity:50,unit:'g'});
const planned=()=>({id:'breakfast',plannedItems:[food('yogurt-b','yogurt',"Yogurt"),food('banana-b','banana',"Banana"),food('yogurt-k','yogurt',"Yogurt"),food('yogurt-alone','yogurt',"Yogurt")],recipeGroups:[{id:'brownie',name:"Banana chocolate brownies",lineIds:['yogurt-b','banana-b']},{id:'basque',name:"Basque cheesecake",lineIds:['yogurt-k']}],actualEntries:[]});
const plannedRows=meal=>meal.plannedItems.map(line=>({...line,origin:'planned'}));
test('display groups keep recipes and outside portions of the same food separate, with every original row retained once',()=>{
 const meal=planned(),rows=plannedRows(meal),before=structuredClone({meal,rows});
 const result=groupMealRecipeRows(meal,rows);
 assert.deepEqual(result.map(section=>[section.kind,section.name,section.rows.map(row=>row.id)]),[
  ['recipe',"Banana chocolate brownies",['yogurt-b','banana-b']],['recipe',"Basque cheesecake",['yogurt-k']],['food',"Yogurt",['yogurt-alone']]
 ]);
 assert.equal(result.flatMap(section=>section.rows).length,rows.length);
 assert(result.every(section=>section.rows.every(row=>rows.includes(row))),'the view must preserve row references and their nutrition/amount values');
 assert.deepEqual({meal,rows},before);
});
test('actuals produced by the existing backend match their stable planned anchors even when the SKU occurs inside and outside dishes',()=>{
 const at='2026-11-02T17:00:00.000Z',meal=planned();
 let state={schemaVersion:1,revision:0,updatedAt:at,items:['yogurt','banana'].map(id=>validateItem({id,name:id,category:'protein',quantity:1000,unit:'g',nutrition:{basisAmount:100,basisUnit:'g',kcal:100,protein:10,carbs:10,fat:1,source:'label'}},at)),events:[],operationIds:[],plans:[],preferences:[]};
 state=applyMutation(state,{action:'save_meal_plan_draft',expectedRevision:state.revision,operationId:'recipe-view-save',plan:{id:'recipe-view',date:'2026-11-02',title:"Local mapping fixture",meals:[{...meal,slot:'breakfast',title:"Breakfast"}]}},at);
 state=applyMutation(state,{action:'record_meal_intake',expectedRevision:state.revision,operationId:'recipe-view-actual',planId:'recipe-view',mealId:'breakfast',mode:'complete',matchesPlannedFood:true,sourceText:"Local complete planned intake fixture"},at);
 const saved=state.plans[0].meals[0],rows=mealNutritionView(saved,{planId:'recipe-view'}).actualRows,before=structuredClone(state);
 assert(rows.every(row=>row.id.startsWith('planned-')));
 const result=groupMealRecipeRows(saved,rows,{planId:'recipe-view'});
 assert.equal(result.find(section=>section.id==='brownie').rows.length,2);assert.equal(result.find(section=>section.id==='basque').rows.length,1);
 assert.equal(result.filter(section=>section.kind==='food').length,1);assert.deepEqual(state,before);
});
test('explicit intakeLineId groups a known actual, while stale or mismatching anchors stay outside rather than being guessed',()=>{
 const meal=planned();meal.actualEntries=[{...food('reported-b','yogurt',"Yogurt"),intakeLineId:'yogurt-b'},{...food('stale','yogurt',"Yogurt"),intakeLineId:'removed'},{...food('wrong-food','milk',"Milk"),intakeLineId:'banana-b'}];
 const rows=meal.actualEntries.map(({intakeLineId,...entry})=>({...entry,origin:'reported'})),sections=groupMealRecipeRows(meal,rows);
 assert.deepEqual(sections[0].lineIds,['yogurt-b']);assert.equal(sections[0].id,'brownie');
 assert.deepEqual(sections.filter(section=>section.kind==='food').map(section=>section.rows[0].id),['stale','wrong-food']);
 const unmatched=groupMealRecipeRows(meal,[{id:'planned-unrecognized',itemId:'banana',name:"Banana",origin:'reported'}],{planId:'recipe-view'});
 assert.equal(unmatched[0].kind,'food','an unrecognized stable anchor is never reassigned by SKU');
});
test('manual reports group only when every matching planned portion belongs to the same unique recipe',()=>{
 const meal=planned(),report={id:'manual-yogurt',itemId:'yogurt',name:"Yogurt",origin:'reported'};
 assert.equal(groupMealRecipeRows(meal,[report])[0].kind,'food','the same SKU in two recipes or a loose portion is ambiguous');
 meal.plannedItems=meal.plannedItems.filter(line=>['yogurt-b','banana-b'].includes(line.id));
 meal.plannedItems.push(food('second-yogurt-b','yogurt',"Yogurt"));meal.recipeGroups[0].lineIds.push('second-yogurt-b');
 const sections=groupMealRecipeRows(meal,[report]);assert.equal(sections[0].id,'brownie');assert.deepEqual(sections[0].lineIds,['yogurt-b','second-yogurt-b']);
});
test('external foods with no item ID match normalized names only when unambiguous, and invalid overlap never duplicates rows',()=>{
 const meal={id:'snack',plannedItems:[food('cocoa',null,"  Unsweetened cocoa powder  "),food('milk',null,"Milk")],recipeGroups:[{id:'a',name:"Brownies",lineIds:['cocoa','milk']},{id:'b',name:"Basque cheesecake",lineIds:['milk']}],actualEntries:[]};
 const rows=[{id:'actual-cocoa',itemId:null,name:"Unsweetened cocoa powder",origin:'reported'},{id:'actual-milk',itemId:null,name:"Milk",origin:'reported'}],sections=groupMealRecipeRows(meal,rows);
 assert.equal(sections[0].id,'a');assert.equal(sections[1].kind,'food');assert.equal(sections.flatMap(section=>section.rows).length,2);
});
test('missing recipe metadata is a lossless flat view, with unknown quantity and zero values untouched',()=>{
 const meal=planned();delete meal.recipeGroups;const rows=[{...food('unknown','yogurt',"Yogurt"),quantity:null,origin:'reported'},{...food('zero','banana',"Banana"),quantity:0,origin:'planned'}],before=structuredClone(rows);
 const result=groupMealRecipeRows(meal,rows);assert(result.every(section=>section.kind==='food'));assert.equal(result.length,2);assert.deepEqual(rows,before);
});
test('effective rows combining multiple actual reports cannot inherit the first recipe anchor',()=>{
 const meal=planned();meal.actualEntries=[{...food('actual-b','yogurt',"Yogurt"),intakeLineId:'yogurt-b'},{...food('actual-k','yogurt',"Yogurt"),intakeLineId:'yogurt-k'}];
 const derived={...meal.actualEntries[0],quantity:200,origin:'reported'};
 const section=groupMealRecipeRows(meal,[derived])[0];assert.equal(section.kind,'food');assert.equal(section.rows[0].quantity,200);
 const conflict=groupMealRecipeRows(meal,[{...meal.plannedItems[0],quantity:null,origin:'planned'}])[0];assert.equal(conflict.kind,'food');
});
