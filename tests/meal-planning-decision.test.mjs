import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlanningInventory } from '../lib/inventory-planning-read.mjs';
import { validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-27T16:00:00.000Z';
// This fixture contains fictional preferences, reports and food batches.
const LABEL = { basisAmount:100, basisUnit:'g', kcal:100, protein:10, carbs:10, fat:2, source:'label', sourceText:'示例旧标签，不应替代新菜单重算' };
const food = (id, extra={}) => validateItem({id, name:id, category:'prepared', quantity:500, unit:'g', location:'冷冻', nutrition:LABEL, ...extra}, NOW);
const intake = (id, itemId, quantity, extra={}) => ({id, itemId, quantity, unit:'g', sourceText:'合成示例摄入报告',
  nutritionSnapshot:{name:itemId, unit:'g', gramsPerUnit:null, nutrition:LABEL}, ...extra});
const frozen = value => { if (value && typeof value==='object') { Object.freeze(value); for (const v of Object.values(value)) frozen(v); } return value; };

function fixture(extraItems=[]) {
  const actualPlan = {id:'daily-food-2026-10-26', date:'2026-10-26', title:'确实吃过的三餐', format:'meals_v1', status:'draft',
    foodAccounting:'actual_only', inventoryAccounting:'settled', supplementDoses:[],
    meals:[
      {id:'breakfast', slot:'breakfast', state:'completed', title:'旧早餐', actualTime:'08:30',
        plannedItems:[{id:'unused-plan-rice',itemId:'rice',quantity:100,unit:'g'}],
        actualEntries:[intake('ate-yogurt','yogurt',100), intake('ate-unavailable-external','no-longer-current-sku',40)]},
      {id:'lunch', slot:'lunch', state:'completed', title:'旧午餐', actualTime:'12:30',
        plannedItems:[{id:'unused-plan-pasta',itemId:'pasta',quantity:70,unit:'g'}],
        actualEntries:[intake('ate-finished-bread','finished-bread',50), intake('not-ate-pasta','pasta',0)]},
      {id:'dinner', slot:'dinner', state:'completed', title:'旧晚餐', actualTime:'19:30',
        plannedItems:[{id:'unused-plan-rice-dinner',itemId:'rice',quantity:50,unit:'g'}],
        actualEntries:[intake('ate-eggs','eggs',2,{unit:'个', nutritionSnapshot:{name:'鸡蛋',unit:'个',gramsPerUnit:50,nutrition:{...LABEL,basisAmount:1,basisUnit:'个',kcal:80}}})]},
    ]};
  return {schemaVersion:1, revision:42, updatedAt:NOW, events:[], operationIds:[],
    preferences:['演示菜单每餐只选一个示例主菜。','示例午餐配一份示例蔬菜，明确另选时例外。'],
    items:[
      food('yogurt',{category:'protein',location:'冷藏'}),
      food('finished-bread',{category:'bread',quantity:0,status:'depleted',location:'常温'}),
      food('eggs',{category:'protein',unit:'个',quantity:12,gramsPerUnit:50,location:'冷藏',nutrition:{...LABEL,basisAmount:1,basisUnit:'个',kcal:80}}),
      food('rice',{category:'staple',location:'常温'}),food('pasta',{category:'staple',location:'常温'}),
      food('fresh-spinach',{name:'示例新鲜菠菜',category:'vegetable',location:'冷藏',freshness:{opened:true,openedOn:'2026-10-26',sourceText:'合成示例：示例菠菜于26号开封，存放冷藏。'}}),
      food('frozen-last-tail',{name:'冷冻示例备餐尾袋',category:'prepared',unit:'袋',quantity:1,location:'冷冻',gramsPerUnit:145}),
      ...extraItems,
    ],
    plans:[actualPlan,{...actualPlan,id:'future-actual-must-not-copy',date:'2026-10-28',title:'未来记录不作参考'}], dietHistory:[]};
}

test('first planning read recognizes completed actual meals while their day still has draft status', () => {
  const source=fixture(), before=structuredClone(source);
  const result=readPlanningInventory(frozen(source),{},NOW);
  const references=result.mealPatternReferences;
  assert.equal(references.hasCompleteDayReference,true);
  assert.equal(references.referenceMode,'completed_primary_days');
  assert.equal(references.completeDayReferences.length,1);
  const day=references.completeDayReferences[0];
  assert.equal(day.planId,'daily-food-2026-10-26');
  assert.equal(day.primaryMealsComplete,true);
  assert.deepEqual(day.meals.map(meal=>meal.slot),['breakfast','lunch','dinner']);
  const entries=day.meals.flatMap(meal=>meal.actualEntries);
  assert.deepEqual(entries.map(entry=>entry.id),['ate-yogurt','ate-unavailable-external','ate-finished-bread','ate-eggs']);
  assert.ok(!entries.some(entry=>['rice','pasta'].includes(entry.itemId)),'unexecuted planned foods and explicit zero intake are not familiar meals');
  assert.ok(!('actualTime' in day.meals[0]),'old times are not copied into a new schedule');
  assert.equal(day.referenceEvidence, 'reported_actual');
  assert.equal(day.actualIntakeProven, true);
  assert.deepEqual(result.preferences,source.preferences);
  assert.equal(result.preferencesComplete,true);
  assert.deepEqual(source,before,'a planning read never writes records, preferences, actuals, quantities or dates');
});

test('familiar actual food references explicitly distinguish depleted and missing current inventory', () => {
  const result=readPlanningInventory(fixture(),{},NOW);
  const entries=result.mealPatternReferences.completeDayReferences[0].meals.flatMap(meal=>meal.actualEntries);
  const missing=entries.find(entry=>entry.id==='ate-unavailable-external');
  assert.equal(missing.currentInventory.matched,false);
  assert.equal(missing.currentInventory.available,false);
  assert.equal(missing.currentInventory.status,null);
  const depleted=entries.find(entry=>entry.id==='ate-finished-bread');
  assert.equal(depleted.currentInventory.matched,true);
  assert.equal(depleted.currentInventory.quantity,0);
  assert.equal(depleted.currentInventory.available,false);
  const available=entries.find(entry=>entry.id==='ate-yogurt');
  assert.equal(available.currentInventory.available,true);
  assert.ok(!result.items.some(item=>item.id==='no-longer-current-sku'),'history does not silently add food to current stock');
  assert.equal(result.candidateCoverage.availableRoleTotals.food,6);
});

test('a refrigerated fresh opened food appears before a flexible frozen last bag without inventing expiry', () => {
  const source=fixture(), before=structuredClone(source);
  const result=readPlanningInventory(frozen(source),{},NOW);
  const fresh=result.items.find(item=>item.id==='fresh-spinach');
  const tail=result.items.find(item=>item.id==='frozen-last-tail');
  assert.equal(fresh.freshness.openedOn,'2026-10-26');
  assert.equal(fresh.freshnessHint.group,'fresh_first');
  assert.equal(tail.freshnessHint.group,'frozen_flexible');
  assert.ok(result.items.indexOf(fresh)<result.items.indexOf(tail));
  assert.equal(fresh.freshness.bestBeforeDate,null,'no label or user date is invented from location or updates');
  assert.deepEqual(source,before);
});

test('familiar meals plus full current habits preserve all inventory pagination and reference the first-page revision', () => {
  const extra=Array.from({length:140},(_,i)=>food('extra-'+String(i).padStart(3,'0'),{
    category:['bread','fruit','nuts','vegetable','condiment','supplement','prepared'][i%7],
    status:i%19===0?'pending':i%17===0?'archived':'available', quantity:i%23===0?0:300,
    notes:'现有食材资料。'.repeat(30),
  }));
  const source=fixture(extra);
  source.preferences=Array.from({length:60},(_,i)=>('完整习惯-'+i+'：'+'字'.repeat(480)).slice(0,500));
  const before=structuredClone(source); frozen(source);
  let cursor, first; const all=[];
  do {
    const page=readPlanningInventory(source,{limit:11,...(cursor?{cursor,expectedRevision:source.revision}:{})},NOW);
    assert.ok(JSON.stringify(page).length<=page.charBudget);
    assert.equal(page.contextRevision,source.revision);
    if(!first) {
      first=page;
      assert.deepEqual(first.preferences,source.preferences);
      assert.equal(first.preferencesComplete,true);
      assert.equal(first.mealPatternReferences.hasCompleteDayReference,true);
    } else {
      assert.equal(page.contextIncluded,false);
      assert.equal(page.requiresFirstPage,true);
      assert.ok(!('preferences' in page));
      assert.ok(!('mealPatternReferences' in page));
      assert.match(page.instructions,/revision=contextRevision/);
    }
    all.push(...page.items); cursor=page.nextCursor;
  } while(cursor!==null);
  assert.equal(all.length,source.items.length);
  assert.equal(new Set(all.map(item=>item.id)).size,source.items.length);
  assert.deepEqual(new Set(all.map(item=>item.id)),new Set(source.items.map(item=>item.id)));
  assert.equal(first.candidateCoverage.availableRoleTotals.food,all.filter(item=>item.status==='available'&&item.quantity!==0&&!['supplement','condiment'].includes(item.category)).length);
  assert.throws(()=>readPlanningInventory(source,{cursor:'11',expectedRevision:41},NOW),error=>error.status===409&&error.code==='REVISION_CONFLICT');
  assert.deepEqual(source,before);
});
