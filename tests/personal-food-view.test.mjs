import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { personalFoodChecklistView } from '../lib/personal-food-view.mjs';

const NOW='2026-10-26T16:00:00.000Z';
function fixture(patch={}){
  const item=validateItem({id:'food',name:'本机测试食物',category:'prepared',quantity:1000,unit:'g',nutrition:{basisAmount:100,basisUnit:'g',kcal:200,protein:10,carbs:30,fat:4,source:'label'},...patch},NOW);
  return applyMutation({schemaVersion:1,revision:0,updatedAt:NOW,items:[item],plans:[],events:[],operationIds:[],preferences:[]},
    {action:'save_meal_plan_draft',operationId:'view-fixture',expectedRevision:0,plan:{id:'personal-view',date:'2026-10-26',title:'本机私人勾选视图',meals:['lunch','dinner'].map(id=>({id,slot:id,title:id,plannedItems:[{id:id+'-food',itemId:'food',quantity:item.unit==='袋'?1:100}]}))}},NOW);
}
const value=(totals,key='kcal')=>totals.find(value=>value.key===key);
test('personal progress follows only marks and planned snapshots, never Chat actuals or completion',()=>{
  let state=fixture();state=applyMutation(state,{action:'record_meal_intake',operationId:'chat-fact',expectedRevision:state.revision,planId:'personal-view',mealId:'lunch',mode:'append',entries:[{id:'chat-food',itemId:'food',quantity:120,unit:'g',sourceText:'用户实际120g'}]},NOW);
  const before=structuredClone(state);let view=personalFoodChecklistView(state.plans[0],state.items);
  assert.equal(value(view.totals.planned).value,400);assert.equal(value(view.totals.checked).value,0);assert.equal(value(view.totals.unchecked).value,400);
  assert.equal(view.meals[0].rows[0].plannedQuantity,100);assert.equal(view.meals[0].rows[0].reportedQuantity,120);assert.deepEqual(state,before);
  state=applyMutation(state,{action:'set_food_personal_check',operationId:'personal-only',expectedRevision:state.revision,planId:'personal-view',mealId:'lunch',lineIds:['lunch-food'],checked:true},NOW);
  view=personalFoodChecklistView(state.plans[0],state.items);
  assert.equal(value(view.totals.checked).value,200);assert.equal(value(view.totals.unchecked).value,200);
  assert.deepEqual(state.items,before.items);assert.deepEqual(state.plans[0].meals,before.plans[0].meals);
});
test('personal day quantities use frozen grams per bag while nutrition retains its original basis',()=>{
  let state=fixture({unit:'袋',quantity:5,gramsPerUnit:132});
  state=applyMutation(state,{action:'set_food_personal_check',operationId:'bag-check',expectedRevision:state.revision,planId:'personal-view',mealId:'lunch',lineIds:['lunch-food'],checked:true},NOW);
  const view=personalFoodChecklistView(state.plans[0],state.items);
  assert.equal(view.dayRows[0].unit,'g');assert.equal(view.dayRows[0].plannedQuantity,264);assert.equal(view.dayRows[0].checkedQuantity,132);assert.equal(view.dayRows[0].uncheckedQuantity,132);
  assert.equal(value(view.totals.planned).value,528);assert.equal(value(view.totals.checked).value,264);
  assert.equal(state.items[0].quantity,5);
});
test('marking unknown portions never makes their calorie or quantity gaps look like zero',()=>{
  let state=fixture();state.plans[0].meals[0].plannedItems[0].quantity=null;
  state=applyMutation(state,{action:'set_food_personal_check',operationId:'unknown-check',expectedRevision:state.revision,planId:'personal-view',mealId:'lunch',lineIds:['lunch-food'],checked:true},NOW);
  const view=personalFoodChecklistView(state.plans[0],state.items);
  assert.equal(value(view.totals.checked).partial,true);assert.equal(view.dayRows[0].checkedQuantity,null);assert.equal(view.dayRows[0].plannedQuantity,null);
  assert.equal(view.dayRows[0].uncheckedQuantity,100);assert.equal(state.items[0].quantity,1000);
});
test('a differently weighed actual package never gets relabelled with planned grams in private rows',()=>{
  let state=fixture({unit:'袋',quantity:5,gramsPerUnit:132});
  state=applyMutation(state,{action:'record_meal_intake',operationId:'weighed-fact',expectedRevision:state.revision,planId:'personal-view',mealId:'lunch',entries:[{id:'weighed',itemId:'food',quantity:1,unit:'袋',sourceText:'另称130g一袋'}]},NOW);
  state.plans[0].meals[0].actualEntries[0].nutritionSnapshot.gramsPerUnit=130;
  const view=personalFoodChecklistView(state.plans[0],state.items),row=view.meals[0].rows[0];
  assert.equal(row.plannedQuantity,132);assert.equal(row.unit,'g');assert.equal(row.reportedQuantity,null);assert.equal(row.canEdit,false);
  assert.equal(value(view.totals.checked).value,0);assert.equal(value(view.totals.planned).value,528);
});
