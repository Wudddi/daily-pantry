import test from 'node:test';
import assert from 'node:assert/strict';
import {foodLayoutView} from '../lib/food-layout-view.mjs';
import {mealNutritionView} from '../lib/meal-nutrition-view.mjs';
import {personalFoodChecklistView} from '../lib/personal-food-view.mjs';
import {isPersonalFoodChecked} from '../lib/personal-food-checklist.mjs';
import {ID,copy,fixture,plan,meal,mutate,move,recipeMoves,nutrition,canonicalLines} from './fixtures/food-layout.mjs';

const layout=(state,moves)=>mutate(state,'set_food_layout',{planId:ID,moves});
const projected=(view,id)=>view.meals.find(entry=>entry.mealId===id);
const kcal=totals=>totals.find(total=>total.key==='kcal').value;
const identity=(mealId,row)=>JSON.stringify([mealId,row.id]);
const clean=row=>{const copy={...row};delete copy.sourceMealId;delete copy.sourceKind;return copy;};
function canonicalRows(state,field='rows'){
  return new Map(plan(state).meals.flatMap(meal=>mealNutritionView(meal,{planId:ID,planStatus:plan(state).status})[field].map(row=>[identity(meal.id,row),row])));
}
function assertEveryOriginalRowOnce(state,view,field='rows'){
  const original=canonicalRows(state,field),rendered=view.meals.flatMap(entry=>entry.nutrition[field]);
  assert.equal(rendered.length,original.size);
  const seen=new Set();
  for(const row of rendered){
    const key=identity(row.sourceMealId,row);assert.ok(original.has(key),key);assert.equal(seen.has(key),false,key);seen.add(key);
    assert.deepEqual(clean(row),original.get(key));
  }
}

test('the default layout preserves existing canonical meal views and does not activate a projection',()=>{
  const state=fixture(),before=copy(state),view=foodLayoutView(plan(state));
  assert.equal(view.active,false);assert.deepEqual(view.issues,[]);
  for(const entry of view.meals)assert.deepEqual(entry.nutrition,mealNutritionView(meal(state,entry.mealId),{planId:ID,planStatus:plan(state).status}));
  assert.deepEqual(state,before);
});

test('an already eaten 15g sauce moves to the chosen display meal exactly once, keeping its original contribution and all canonical facts',()=>{
  const state=layout(fixture(),[move('lunch','planned','sauce-line','dinner')]),before=copy(state),totals=nutrition(state),view=foodLayoutView(plan(state));
  assert.equal(view.active,true);assert.deepEqual(view.issues,[]);
  const dinner=projected(view,'dinner'),sauce=dinner.nutrition.rows.filter(row=>row.itemId==='demo-sauce');
  assert.equal(sauce.length,1);assert.equal(sauce[0].quantity,15);assert.equal(sauce[0].sourceMealId,'lunch');assert.equal(sauce[0].sourceKind,'actual');
  assert.equal(projected(view,'lunch').nutrition.rows.length,0);
  assert.equal(kcal(dinner.nutrition.totals),95);
  assert.equal(view.meals.reduce((sum,entry)=>sum+(kcal(entry.nutrition.totals)??0),0),kcal(totals));
  for(const field of ['rows','plannedRows','actualRows','remainingRows'])assertEveryOriginalRowOnce(state,view,field);
  assert.deepEqual(nutrition(state),totals);assert.deepEqual(state,before);
});

test('moving a whole mixed-unit half recipe retains its own section, exact ingredient rows and half portion at its destination',()=>{
  const state=layout(fixture(),recipeMoves('dinner')),before=copy(state),view=foodLayoutView(plan(state)),destination=projected(view,'dinner');
  const recipe=destination.sections.find(section=>section.kind==='recipe');
  assert.ok(recipe);assert.equal(recipe.name,'DEMO oat square');assert.equal(recipe.sourceMealId,'breakfast');assert.equal(recipe.portion,0.5);
  assert.equal(recipe.partialRecipe,undefined);assert.equal(recipe.rows.length,3);
  assert.deepEqual(recipe.rows.map(row=>[row.id,row.quantity,row.unit]),[['square-oats',40,'g'],['square-milk',90,'ml'],['square-egg',1,'个']]);
  assert.equal(kcal(destination.nutrition.totals),355);
  assert.equal(projected(view,'breakfast').nutrition.rows.length,0);assertEveryOriginalRowOnce(state,view);assert.deepEqual(state,before);
});

test('a split recipe marks each fragment partial and does not claim the full half-recipe portion for either fragment',()=>{
  const state=layout(fixture(),[move('breakfast','planned','square-oats','dinner')]),view=foodLayoutView(plan(state));
  for(const [id,length]of[['breakfast',2],['dinner',1]]){
    const group=projected(view,id).sections.find(section=>section.kind==='recipe');assert.ok(group);assert.equal(group.rows.length,length);
    assert.equal(group.partialRecipe,true);assert.equal(group.portion,undefined);
  }
  assertEveryOriginalRowOnce(state,view);
});

test('checked and unchecked reminder rows keep their original source keys and day totals after being arranged in another meal',()=>{
  const before=fixture(),previous=personalFoodChecklistView(plan(before),before.items),state=layout(before,recipeMoves('dinner')),calls=[];
  const view=personalFoodChecklistView(plan(state),state.items,(mealId,lineId)=>{calls.push([mealId,lineId]);return isPersonalFoodChecked(plan(state),mealId,lineId);});
  const target=view.meals.find(meal=>meal.id==='dinner'),moved=target.rows.filter(row=>row.sourceMealId==='breakfast');
  assert.deepEqual(moved.map(row=>row.lineId),['square-oats','square-milk','square-egg']);
  for(const id of ['square-oats','square-milk','square-egg'])assert.ok(calls.some(pair=>pair[0]==='breakfast'&&pair[1]===id));
  assert.equal(calls.some(pair=>pair[0]==='dinner'&&pair[1]==='square-oats'),false);
  assert.deepEqual(view.totals,previous.totals);assert.deepEqual(view.dayRows,previous.dayRows);
  assert.equal(kcal(view.mealTotals.find(row=>row.mealId==='dinner').totals),355);
  assert.deepEqual(plan(state).personalFoodChecks,plan(before).personalFoodChecks);
});

test('same line IDs from different source meals retain distinct rows, recipe membership and personal check identities',()=>{
  const state=fixture();meal(state,'dinner').plannedItems[0].id='square-oats';
  const after=layout(state,[move('breakfast','planned','square-oats','dinner')]),view=foodLayoutView(plan(after));
  const sameId=projected(view,'dinner').nutrition.rows.filter(row=>row.id==='square-oats');
  assert.equal(sameId.length,2);assert.deepEqual(sameId.map(row=>row.sourceMealId).sort(),['breakfast','dinner']);
  const recipe=projected(view,'dinner').sections.find(section=>section.kind==='recipe');
  assert.deepEqual(recipe.rows.map(row=>row.itemId),['demo-oats']);
  const checklist=personalFoodChecklistView(plan(after),after.items),target=checklist.meals.find(meal=>meal.id==='dinner');
  assert.equal(target.rows.filter(row=>row.lineId==='square-oats').length,2);assertEveryOriginalRowOnce(after,view);
});

test('conflicting destinations of one partial aggregate preserve its contribution once and expose the separate actual evidence without guessing a split',()=>{
  let state=fixture();state=mutate(state,'record_meal_intake',{planId:ID,mealId:'lunch',entries:[{id:'demo-extra-sauce',itemId:'demo-sauce',quantity:5,unit:'g',sourceText:'DEMO second sauce report'}]});
  meal(state,'lunch').state='in_progress';
  const first=meal(state,'lunch').actualEntries[0].id,totals=nutrition(state),lines=canonicalLines(state);
  state=layout(state,[move('lunch','actual',first,'dinner')]);const view=foodLayoutView(plan(state));
  assert.ok(view.issues.some(issue=>issue.code==='FOOD_LAYOUT_AGGREGATE_TARGET_CONFLICT'));
  assert.equal(projected(view,'lunch').nutrition.rows.filter(row=>row.itemId==='demo-sauce').length,1);
  assert.equal(projected(view,'dinner').nutrition.rows.filter(row=>row.itemId==='demo-sauce').length,0);
  assert.equal(projected(view,'dinner').nutrition.actualRows.find(row=>row.id===first).quantity,15);
  assert.equal(projected(view,'lunch').nutrition.actualRows.find(row=>row.id==='demo-extra-sauce').quantity,5);
  assertEveryOriginalRowOnce(state,view);assert.deepEqual(nutrition(state),totals);assert.deepEqual(canonicalLines(state),lines);
});

test('unknown nutrient and quantity evidence survives projection independently from explicit zero',()=>{
  const state=fixture(),milk=meal(state,'breakfast').plannedItems.find(row=>row.id==='square-milk');
  milk.nutritionSnapshot.nutrition.carbs=null;milk.nutritionSnapshot.nutrition.fat=0;
  const oats=meal(state,'breakfast').plannedItems.find(row=>row.id==='square-oats');oats.quantity=null;
  const after=layout(state,recipeMoves('dinner')),view=foodLayoutView(plan(after)),target=projected(view,'dinner');
  const movedMilk=target.nutrition.rows.find(row=>row.id==='square-milk'),movedOats=target.nutrition.rows.find(row=>row.id==='square-oats');
  assert.equal(movedMilk.totals.find(total=>total.key==='carbs').value,null);assert.equal(movedMilk.totals.find(total=>total.key==='fat').value,0);
  assert.equal(movedOats.quantity,null);assert.equal(movedOats.quantityUnknown,true);
  assertEveryOriginalRowOnce(after,view);assert.deepEqual(nutrition(after),nutrition(state));
});
