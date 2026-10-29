import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryViewItems, inventoryScopeCounts, groupInventoryItems, isInventoryArchived } from '../lib/inventory-organization.mjs';
const food=(id,category='protein',patch={})=>({id,name:id,category,quantity:1,status:'available',priority:false,nutrition:{kcal:100,protein:10,carbs:5,fat:3},...patch});
test('daily foods, supplements, condiments and reusable archive are disjoint and retain all records',()=>{
 const items=[food('beef'),food('pending','prepared',{status:'pending',quantity:null}),food('fishoil','supplement'),food('mustard','condiment'),food('finished','protein',{status:'depleted',quantity:0}),food('old','bread',{status:'archived'}),food('legacy-zero','vegetable',{quantity:0})];
 assert.deepEqual(inventoryScopeCounts(items),{food:2,supplement:1,condiment:1,archive:3});
 const ids=['food','supplement','condiment','archive'].flatMap(scope=>inventoryViewItems(items,{scope}).map(item=>item.id));
 assert.equal(new Set(ids).size,items.length);assert.equal(ids.length,items.length);
 assert.deepEqual(inventoryViewItems(items).map(x=>x.id),['pending','beef']);
 assert.ok(isInventoryArchived(items.at(-1)));
});
test('category groups stay stable after label edits and manual priorities only order their group',()=>{
 const items=[food('bread','bread',{priority:true}),food('z-beef'),food('a-beef'),food('veg','vegetable'),food('batch','prepared')];
 const before=structuredClone(items);
 assert.deepEqual(inventoryViewItems(items).map(x=>x.id),['batch','a-beef','z-beef','veg','bread']);
 items[1].priority=true;
 assert.deepEqual(inventoryViewItems(items).map(x=>x.id),['batch','z-beef','a-beef','veg','bread']);
 items.forEach((item,index)=>{item.updatedAt=String(100-index);item.confirmedAt=String(index);});
 assert.deepEqual(inventoryViewItems(items).map(x=>x.id),['batch','z-beef','a-beef','veg','bread']);
 assert.deepEqual(groupInventoryItems(inventoryViewItems(before)).map(g=>[g.category,g.items.length]),[['prepared',1],['protein',2],['vegetable',1],['bread',1]]);
});
test('filters and alias search stay in scope, exclude unknown supplements from missing macros, and never mutate saved items',()=>{
 const items=[food('yogurt','protein',{aliases:['0%希腊酸奶'],nutrition:{kcal:50,protein:10,carbs:null,fat:0}}),food('caffeine','supplement',{status:'pending',quantity:null,nutrition:{kcal:null,protein:null,carbs:null,fat:null}}),food('butter','condiment'),food('old-yogurt','protein',{status:'archived',aliases:['旧标签']})];
 const original=structuredClone(items);
 assert.deepEqual(inventoryViewItems(items,{query:'0%希腊酸奶'}).map(x=>x.id),['yogurt']);
 assert.deepEqual(inventoryViewItems(items,{filter:'missing'}).map(x=>x.id),['yogurt']);
 assert.equal(inventoryViewItems(items,{scope:'supplement',filter:'missing'}).length,0);
 assert.deepEqual(inventoryViewItems(items,{scope:'supplement',filter:'pending'}).map(x=>x.id),['caffeine']);
 assert.equal(inventoryViewItems(items,{query:'旧标签'}).length,0);
 assert.deepEqual(inventoryViewItems(items,{scope:'archive',query:'旧标签'}).map(x=>x.id),['old-yogurt']);
 assert.deepEqual(items,original);
});
