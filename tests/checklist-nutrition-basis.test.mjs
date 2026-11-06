import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistNutritionBasis } from '../lib/checklist-nutrition-basis.mjs';
import { personalFoodChecklistView } from '../lib/personal-food-view.mjs';
import { applyPersonalFoodCheck } from '../lib/personal-food-checklist.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
import { KEYS, actual, basisFixture, copy, freezeDeep, keyed, line, snapshot, values } from './fixtures/nutrition-basis.mjs';

const header = (plan, histories = []) => resolveDietDays([plan],histories)[0].totals;
const view = (state, options = {}) => checklistNutritionBasis(state.plans[0],state.items,options);
const round = value => Math.round(value*1e6)/1e6;

test('planned food plus reported-food adjustment plus supplements explains the daily summary exactly without rewriting any basis', () => {
  const state=freezeDeep(basisFixture()),before=copy(state),plan=state.plans[0];
  const result=view(state,{headerTotals:header(plan)});
  assert.deepEqual(values(result.plannedFoodTotals),{kcal:300,protein:30,carbs:60,fat:9});
  assert.deepEqual(values(result.effectiveFoodTotals),{kcal:350,protein:35,carbs:70,fat:10.5});
  assert.deepEqual(values(result.foodDelta),{kcal:50,protein:5,carbs:10,fat:1.5});
  assert.deepEqual(values(result.supplementTotals),{kcal:10,protein:0,carbs:0,fat:1});
  assert.deepEqual(values(result.totalTotals),{kcal:360,protein:35,carbs:70,fat:11.5});
  assert.deepEqual(values(result.plannedFoodTotals),values(personalFoodChecklistView(plan,state.items).totals.planned));
  for(const key of KEYS)assert.equal(round(keyed(result.plannedFoodTotals)[key].value+keyed(result.foodDelta)[key].value+keyed(result.supplementTotals)[key].value),keyed(result.totalTotals)[key].value,key);
  assert.equal(result.headerComparison.provided,true);
  assert.equal(result.headerComparison.matches,true);
  assert.equal(result.headerComparison.canReconcile,true);
  assert.deepEqual(state,before);
});

test('per-meal comparisons preserve positive and negative corrections instead of relabelling the checklist as actual intake', () => {
  for(const [quantity,delta,total]of [[150,50,360],[50,-50,260]]){
    const state=basisFixture();state.plans[0].meals[0].actualEntries[0].quantity=quantity;
    const result=view(state,{headerTotals:header(state.plans[0])}),breakfast=result.meals.find(meal=>meal.mealId==='breakfast');
    assert.equal(keyed(breakfast.plannedFoodTotals).kcal.value,100);
    assert.equal(keyed(breakfast.effectiveFoodTotals).kcal.value,quantity);
    assert.equal(keyed(breakfast.foodDelta).kcal.value,delta);
    assert.equal(keyed(result.foodDelta).kcal.value,delta);
    assert.equal(keyed(result.totalTotals).kcal.value,total);
    assert.equal(result.headerComparison.canReconcile,true);
  }
});

test('personal checkmarks change only the checked reminder subtotal, never actual facts, the nutrition comparison or stock', () => {
  const state=basisFixture(),before=copy(state),plan=state.plans[0],previousHeader=header(plan),previous=view(state,{headerTotals:previousHeader});
  const saved=applyPersonalFoodCheck(state,{planId:plan.id,mealId:'breakfast',wholeMeal:true,checked:true},'2026-01-15T13:00:00.000Z');
  const next={...state,items:saved.items,plans:saved.plans};
  assert.equal(personalFoodChecklistView(plan,state.items).totals.checked[0].value,0);
  assert.equal(personalFoodChecklistView(next.plans[0],next.items).totals.checked[0].value,100);
  assert.deepEqual(view(next,{headerTotals:header(next.plans[0])}),previous);
  assert.deepEqual(header(next.plans[0]),previousHeader);
  assert.deepEqual(next.items,before.items);
  assert.deepEqual(next.plans[0].meals,before.plans[0].meals);
  assert.deepEqual(next.plans[0].supplementDoses,before.plans[0].supplementDoses);
  assert.deepEqual(next.plans[0].accountedDebits,before.plans[0].accountedDebits);
  assert.deepEqual(state,before);
});

test('completed extra foods contribute once to the effective summary but never become planned checklist rows', () => {
  const state=basisFixture(),plan=state.plans[0],extra=line('demo-extra',20,{nutritionSnapshot:snapshot('DEMO extra',{kcal:2,protein:0,carbs:0.5,fat:0})});
  plan.meals[0].actualEntries.push(actual(extra,20));
  const result=view(state,{headerTotals:header(plan)});
  assert.equal(keyed(result.plannedFoodTotals).kcal.value,300);
  assert.equal(keyed(result.effectiveFoodTotals).kcal.value,390);
  assert.equal(keyed(result.foodDelta).kcal.value,90);
  assert.equal(keyed(result.totalTotals).kcal.value,400);
  assert.equal(personalFoodChecklistView(plan,state.items).meals[0].rows.length,1);
  assert.equal(result.headerComparison.matches,true);
});

test('partial reports retain unreported planned food and only quantities above that plan change the effective total', () => {
  for(const [quantity,expectedDelta]of [[50,0],[150,50]]){
    const state=basisFixture(),plan=state.plans[0];plan.meals[0].state='in_progress';plan.meals[0].actualEntries[0].quantity=quantity;
    const result=view(state,{headerTotals:header(plan)});
    assert.equal(keyed(result.plannedFoodTotals).kcal.value,300);
    assert.equal(keyed(result.foodDelta).kcal.value,expectedDelta);
    assert.equal(keyed(result.totalTotals).kcal.value,310+expectedDelta);
    assert.equal(plan.meals[0].actualEntries[0].quantity,quantity);
  }
});

test('explicit actual zero and cancellations remain distinct from missing content and do not resurrect planned food', () => {
  const zero=basisFixture(),p=zero.plans[0];p.meals[0].actualEntries[0].quantity=0;p.meals[0].actualEntries[0].nutritionSnapshot=null;
  const zeroView=view(zero,{headerTotals:header(p)});
  assert.equal(keyed(zeroView.effectiveFoodTotals).kcal.value,200);
  assert.equal(keyed(zeroView.foodDelta).kcal.value,-100);
  assert.equal(keyed(zeroView.totalTotals).kcal.value,210);
  assert.equal(keyed(zeroView.effectiveFoodTotals).kcal.complete,true);
  const cancelled=basisFixture();cancelled.plans[0].status='cancelled';
  const cancelledView=view(cancelled,{headerTotals:header(cancelled.plans[0])});
  assert.equal(keyed(cancelledView.plannedFoodTotals).kcal.value,300);
  assert.equal(keyed(cancelledView.effectiveFoodTotals).kcal.value,150);
  assert.equal(keyed(cancelledView.supplementTotals).kcal.value,0);
  assert.equal(keyed(cancelledView.totalTotals).kcal.value,150);
  const cancelledMeal=basisFixture();cancelledMeal.plans[0].meals[0].state='cancelled';cancelledMeal.plans[0].meals[0].actualEntries[0].quantity=25;
  const cancelledMealView=view(cancelledMeal,{headerTotals:header(cancelledMeal.plans[0])});
  assert.equal(keyed(cancelledMealView.effectiveFoodTotals).kcal.value,225);
  assert.equal(keyed(cancelledMealView.foodDelta).kcal.value,-75);
  assert.equal(keyed(cancelledMealView.totalTotals).kcal.value,235);
  const unreported=basisFixture();unreported.plans[0].meals[0].actualEntries=[];
  assert.equal(keyed(view(unreported).effectiveFoodTotals).kcal.value,300);
});

test('unknown nutrients, unknown actual quantities and incompatible units never become zero adjustments', () => {
  const missing=basisFixture(),meal=missing.plans[0].meals[0];meal.actualEntries[0].nutritionSnapshot.nutrition.carbs=null;
  const partial=view(missing,{headerTotals:header(missing.plans[0])});
  assert.equal(keyed(partial.foodDelta).kcal.value,50);
  assert.equal(keyed(partial.foodDelta).carbs.value,null);
  assert.equal(keyed(partial.effectiveFoodTotals).carbs.partial,true);
  assert.equal(keyed(partial.effectiveFoodTotals).carbs.value,40);
  for(const patch of [{quantity:null},{unit:'袋'}]){
    const state=basisFixture();Object.assign(state.plans[0].meals[0].actualEntries[0],patch);
    const result=view(state,{headerTotals:header(state.plans[0])});
    assert.equal(keyed(result.foodDelta).kcal.value,null);
    assert.equal(keyed(result.effectiveFoodTotals).kcal.partial,true);
    assert.equal(keyed(result.effectiveFoodTotals).kcal.value,200);
    assert.equal(result.headerComparison.canReconcile,false);
  }
});

test('known supplement calories are separate from missing supplement macros and neither is mistaken for checked food', () => {
  const state=basisFixture(),plan=state.plans[0];plan.supplementDoses[0].nutritionSnapshot.nutrition.protein=null;
  const result=view(state,{headerTotals:header(plan)});
  assert.equal(keyed(result.supplementTotals).kcal.value,10);
  assert.equal(keyed(result.supplementTotals).protein.value,null);
  assert.equal(keyed(result.totalTotals).protein.value,35);
  assert.equal(keyed(result.totalTotals).protein.supplementPartial,true);
  assert.equal(keyed(result.totalTotals).protein.complete,false);
  assert.equal(keyed(result.foodDelta).protein.value,5);
  assert.equal(result.headerComparison.matches,true);
  assert.equal(result.headerComparison.canReconcile,true);
});

test('unreported supplement energy stays unknown, whereas an absent or unscheduled dose is a genuine zero contribution', () => {
  const unknown=basisFixture(),p=unknown.plans[0];p.supplementDoses[0].nutritionSnapshot.nutrition.kcal=null;
  const unresolved=view(unknown,{headerTotals:header(p)});
  assert.equal(keyed(unresolved.supplementTotals).kcal.value,null);
  assert.equal(keyed(unresolved.totalTotals).kcal.value,350);
  assert.equal(keyed(unresolved.totalTotals).kcal.supplementPartial,true);
  assert.equal(unresolved.headerComparison.canReconcile,false);
  const optional=basisFixture(),plan=optional.plans[0],dose=plan.supplementDoses[0];dose.scheduled=false;dose.requirement='optional';
  assert.equal(keyed(view(optional).supplementTotals).kcal.value,0);
  dose.actualEntries=[{id:'demo-explicit-dose',itemId:dose.itemId,name:'DEMO dose',quantity:1,unit:'粒',nutritionSnapshot:copy(dose.nutritionSnapshot),sourceText:'DEMO explicit dose'}];
  assert.equal(keyed(view(optional).supplementTotals).kcal.value,10);
  assert.equal(keyed(view(optional).totalTotals).kcal.value,360);
  plan.supplementDoses=[];
  assert.equal(keyed(view(optional).supplementTotals).kcal.value,0);
});

test('different header values, coverage or historical fallback sources suppress a falsely complete reconciliation', () => {
  const state=basisFixture(),original=header(state.plans[0]);
  const changedValue=copy(original);changedValue[0].value+=1;
  const changedCoverage=copy(original);changedCoverage[0].partial=true;changedCoverage[0].missing=1;
  const historical=copy(original);historical[0].source='matched_history_total';
  for(const totals of [changedValue,changedCoverage,historical]){
    const result=view(state,{headerTotals:totals});
    assert.equal(result.headerComparison.canReconcile,false);
  }
  assert.equal(view(state,{headerTotals:changedValue}).headerComparison.matches,false);
  assert.equal(view(state,{headerTotals:changedCoverage}).headerComparison.matches,false);
});

test('a real legacy-history nutrition fill is identified as another header basis instead of inventing ingredient-level values', () => {
  const state=basisFixture(),plan=state.plans[0];plan.meals=plan.meals.slice(0,1);plan.meals[0].state='reserved';plan.meals[0].actualEntries=[];plan.supplementDoses=[];
  plan.meals[0].plannedItems[0].nutritionSnapshot.nutrition.kcal=null;
  const planned=plan.meals[0].plannedItems[0];
  const history={id:'demo-legacy',recordType:'diet_history',date:plan.date,title:'DEMO historical evidence',confirmation:'final_plan',
    nutrition:{kcal:null,protein:null,carbs:null,fat:null,source:'unknown'},supplements:[],
    meals:[{id:'breakfast',name:'DEMO breakfast',status:'planned',items:[{id:planned.id,name:planned.name,inventoryItemId:planned.itemId,
      quantity:100,plannedQuantity:100,actualQuantity:null,quantitySource:'unknown',unit:'g',nutrition:{kcal:100,protein:10,carbs:20,fat:3,source:'estimate'}}]}]};
  const dailyHeader=header(plan,[history]);
  assert.equal(keyed(dailyHeader).kcal.value,100);
  assert.equal(keyed(dailyHeader).kcal.source,'matched_history_items');
  const before=copy({state,history}),result=view(state,{headerTotals:dailyHeader});
  assert.equal(keyed(result.effectiveFoodTotals).kcal.value,null);
  assert.equal(keyed(result.foodDelta).kcal.value,null);
  assert.equal(result.headerComparison.canReconcile,false);
  assert.deepEqual({state,history},before);
});
