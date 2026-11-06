import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { validateItem, applyMutation } from '../lib/inventory.mjs';
import { fixture as layoutFixture, ID as layoutPlanId, recipeMoves } from './fixtures/food-layout.mjs';

// Exercise the actual RPC dispatcher and real domain mutation. Only the
// authenticated R2/health boundary is replaced; these tests never reach a site.
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const inventoryUrl = new URL('../lib/inventory.mjs', import.meta.url).href;
const storeUrl = dataModule(`
  import { applyMutation } from ${JSON.stringify(inventoryUrl)};
  let state, calls = [];
  export const reset = value => { state = structuredClone(value); calls = []; };
  export const current = () => state;
  export const mutations = () => calls;
  export function actorFrom(request) {
    if (!request.headers.get('oai-authenticated-user-id')) throw Object.assign(new Error('请先登录'), {status:401});
    return request.headers.get('oai-authenticated-user-id');
  }
  export const boundedJson = request => request.json();
  export const readInventory = async () => ({ state });
  export const mutateInventory = async (actor, payload) => {
    calls.push({actor, payload:structuredClone(payload)});
    state = applyMutation(state, payload, '2026-10-27T02:30:00.000Z');
    return { state };
  };
`);
const healthStoreUrl = dataModule('export const readHealth = async () => { throw new Error("health unavailable in preference test"); }; export const mutateHealth = readHealth;');
const compiledUrls = new Map();
async function typescriptModule(relative) {
  if (compiledUrls.has(relative)) return compiledUrls.get(relative);
  let compiled = ts.transpileModule(await readFile(new URL('../' + relative, import.meta.url), 'utf8'), {
    fileName: relative, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const specs = [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)].map(match => match[2]);
  for (const spec of new Set(specs)) {
    let target;
    if (spec === '@/lib/inventory-store') target = storeUrl;
    else if (spec === '@/lib/health-store') target = healthStoreUrl;
    else if (spec.startsWith('@/lib/')) {
      const relativePath = 'lib/' + spec.slice('@/lib/'.length);
      target = spec.endsWith('.mjs') ? new URL('../' + relativePath, import.meta.url).href : await typescriptModule(relativePath + '.ts');
    } else if (spec === './inventory-store') target = storeUrl;
    else if (spec.startsWith('./') || spec.startsWith('../')) {
      target = new URL(spec, new URL('../' + relative, import.meta.url)).href;
    } else target = import.meta.resolve(spec);
    compiled = compiled.replaceAll(JSON.stringify(spec), JSON.stringify(target)).replaceAll("'" + spec + "'", JSON.stringify(target));
  }
  const url = dataModule(compiled);
  compiledUrls.set(relative, url);
  return url;
}
const { POST } = await import(await typescriptModule('app/mcp/route.ts'));
const store = await import(storeUrl);

const NOW = '2026-10-26T15:00:00.000Z';
function fixture() {
  return { schemaVersion:1, revision:0, updatedAt:NOW, preferences:['喜欢蓝莓', '保留每袋肉的分装克重'], events:[], operationIds:[],
    items:[validateItem({id:'food', name:"Test food", category:'fruit', unit:'g', quantity:200}, NOW)],
    plans:[{id:'prior-day', title:'保留旧菜单', date:'2026-10-25', status:'cancelled', items:[], notes:'历史原文'}],
    dietHistory:[{id:'prior-history', date:'2026-10-25', sourceText:'历史饮食原文'}],
    supplementRoutine:{supplementDoses:[{id:'stable-dose', instruction:'原补给安排'}]},
  };
}
const payload = (extra = {}) => ({operationId:'habit-no-rice', expectedRevision:0, confirmed:true,
  add:['未主动要求时不安排米饭和意面'], sourceText:'我说了我不吃米饭和意面，在我没跟你说我想吃的时候不要给我安排', sourceDate:'2026-10-26', ...extra});
async function rpc(method, params, authenticated = true) {
  const response = await POST(new Request('http://local-test.invalid/mcp', {method:'POST', headers:{'content-type':'application/json', ...(authenticated ? {'oai-authenticated-user-id':'local-test-only'} : {})},
    body:JSON.stringify({jsonrpc:'2.0', id:1, method, ...(params ? {params} : {})})}));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  return (await response.json()).result;
}
const call = args => rpc('tools/call', {name:'patch_food_preferences', arguments:args});

test('MCP discovery exposes the habit writer and initialize tells Chat to persist explicit long-term changes', async () => {
  const listing = await rpc('tools/list');
  const tool = listing.tools.find(entry => entry.name === 'patch_food_preferences');
  assert.ok(tool, 'the model must actually receive a writable preference tool');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const field of ['operationId','expectedRevision','confirmed','sourceText','sourceDate']) assert.ok(tool.inputSchema.required.includes(field));
  assert.equal(tool.inputSchema.properties.sourceText.maxLength, 1000);
  assert.equal(tool.inputSchema.properties.confirmed.const, true);
  const init = await rpc('initialize');
  assert.match(init.instructions, /patch_food_preferences/);
  assert.match(init.instructions, /one-day|one-off|daily/i);
  assert.match(init.instructions, /Explicit actuals use record_meal_intake/);
});

test('RPC writes an incremental durable habit, returns every current preference and leaves all stock and records intact', async () => {
  const initial = fixture(); store.reset(initial);
  const result = await call(payload());
  assert.equal(result.isError, false);
  const receipt = result.structuredContent;
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.preferencesRevision, receipt.revision);
  assert.equal(receipt.preferencesComplete, true);
  assert.deepEqual(receipt.preferences, [...initial.preferences, payload().add[0]]);
  assert.equal(receipt.inventoryEffect, 'none');
  assert.equal(receipt.operationId, 'habit-no-rice');
  assert.equal(store.mutations()[0].payload.action, 'patch_preferences');
  const saved = store.current();
  for (const key of ['items','plans','dietHistory','supplementRoutine']) assert.deepEqual(saved[key], initial[key]);
  assert.equal(saved.preferenceHistory[0].sourceText, payload().sourceText);
  assert.deepEqual(saved.preferenceHistory[0].previous, initial.preferences);
  assert.deepEqual(saved.preferenceHistory[0].next, receipt.preferences);
});

test('RPC retries the original request without a second write, even though its revision is now stale', async () => {
  store.reset(fixture());
  const command = payload();
  await call(command);
  const saved = structuredClone(store.current());
  const retry = await call(command);
  assert.equal(retry.isError, false);
  assert.deepEqual(store.current(), saved);
  assert.equal(retry.structuredContent.revision, 1);
  assert.equal(retry.structuredContent.inventoryEffect, 'none');
  const changedPayload = await call({...command, add:['换了参数的习惯']});
  assert.equal(changedPayload.isError, true);
  assert.equal(changedPayload.structuredContent.status, 409);
  assert.deepEqual(store.current(), saved);
});

test('RPC stale revisions, mismatched old rules, missing evidence and unsupported fields fail without state changes', async () => {
  for (const [args, status] of [
    [payload({expectedRevision:99}), 409],
    [payload({replace:[{previous:'不存在的旧习惯',next:'不能静默覆盖'}],add:[]}), 409],
    [payload({confirmed:false}), 400],
    [payload({sourceText:''}), 400],
    [payload({sourceText:'x'.repeat(1001)}), 400],
    [payload({sourceDate:undefined}), 400],
    [payload({sourceDate:'2026-02-30'}), 400],
    [payload({preferences:[]}), 400],
  ]) {
    const initial=fixture(); store.reset(initial);
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.available, false);
    assert.equal(result.structuredContent.status, status);
    assert.deepEqual(store.current(), initial);
  }
});

test('RPC refuses unauthenticated writes and unknown tool names', async () => {
  const initial=fixture(); store.reset(initial);
  const denied = await rpc('tools/call', {name:'patch_food_preferences',arguments:payload()}, false);
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.status, 401);
  const unknown = await rpc('tools/call', {name:'invented_preferences_tool',arguments:payload()});
  assert.equal(unknown.isError, true);
  assert.deepEqual(store.current(), initial);
  assert.equal(store.mutations().length, 0);
});

function mealFixture(quantity=200) {
  let s=fixture();s.items[0]={...s.items[0],quantity};
  s=applyMutation(s,{action:'save_meal_plan_draft',operationId:'fixture-menu',expectedRevision:s.revision,plan:{id:'auto-day',date:'2026-10-25',title:'测试已保存菜单',meals:[{id:'lunch',slot:'lunch',title:"Lunch",plannedItems:[{id:'food-line',itemId:'food',quantity:60,unit:'g'}]}],supplementDoses:[]}},'2026-10-25T12:00:00Z');
  return s;
}
test('the scheduled MCP writer honors actor policy, dry-run and repeated daily processing without using personal marks',async()=>{
  const s=mealFixture();s.dailyMenuSettlementPolicy={version:1,enabled:true,timeZone:'America/Toronto',startsOn:'2026-10-25',updatedAt:NOW,sourceText:'明确开启自动结算'};
  s.plans.find(p=>p.id==='auto-day').personalFoodChecks={version:1,checks:[{mealId:'lunch',lineId:'food-line',checked:false,updatedAt:NOW}],updatedAt:NOW};store.reset(s);
  let r=await rpc('tools/call',{name:'settle_due_daily_menus',arguments:{dryRun:true}});assert.equal(r.isError,false);assert.equal(store.current().items[0].quantity,200);assert.equal(store.mutations().length,0);
  r=await rpc('tools/call',{name:'settle_due_daily_menus',arguments:{dryRun:false}});assert.equal(r.isError,false);assert.equal(store.current().items[0].quantity,140);
  const saved=store.current().plans.find(p=>p.id==='auto-day');assert.equal(saved.dailySettlement.basis,'auto_planned');assert.equal(saved.meals[0].actualEntries.length,0);assert.equal(saved.personalFoodChecks.checks[0].checked,false);
  await rpc('tools/call',{name:'settle_due_daily_menus',arguments:{dryRun:false}});assert.equal(store.current().items[0].quantity,140);
  const details=await rpc('tools/call',{name:'read_diet_records',arguments:{recordId:'auto-day'}});assert.equal(details.isError,false);
  assert.ok(!JSON.stringify(details.structuredContent).includes('personalFoodChecks'));
  const context=JSON.parse(details.structuredContent.text).personalCheckContext;
  assert.equal(context.actualIntakeEvidence,false);assert.deepEqual(context.rows.map(row=>({lineId:row.lineId,checked:row.checked})),[{lineId:'food-line',checked:false}]);
});

let reminderSequence=0;
function markedMealFixture() {
  let state=mealFixture();
  const mutate=(action,fields)=>{state=applyMutation(state,{action,operationId:'read-reminder-'+(++reminderSequence),expectedRevision:state.revision,...fields},NOW);};
  mutate('save_meal_plan_draft',{plan:{id:'auto-day',date:'2026-10-25',title:'Advisory reminder read test',meals:[
    {id:'lunch',slot:'lunch',title:'Lunch',plannedItems:[{id:'food-line',itemId:'food',quantity:60,unit:'g'}]},
    {id:'dinner',slot:'dinner',title:'Dinner',plannedItems:[{id:'dinner-food',itemId:'food',quantity:40,unit:'g'}]},
  ],supplementDoses:[]}});
  mutate('set_food_personal_check',{planId:'auto-day',mealId:'lunch',lineIds:['food-line'],checked:true});
  mutate('set_food_personal_check',{planId:'auto-day',mealId:'dinner',lineIds:['dinner-food'],checked:true});
  mutate('set_food_personal_check',{planId:'auto-day',mealId:'dinner',lineIds:['dinner-food'],checked:false});
  return state;
}
function advisoryContext(content) {
  if(content.personalCheckContext) return content.personalCheckContext;
  if(content.records) return content.records.find(record=>record.id==='auto-day')?.personalCheckContext;
  assert.equal(content.nextOffset,null,'the synthetic record should fit in one lossless chunk');
  return JSON.parse(content.text).personalCheckContext;
}
const advisoryReads=[
  ['read_intake_draft',{planId:'auto-day'}],
  ['read_food_plan_edit_context',{planId:'auto-day'}],
  ['read_diet_records',{planId:'auto-day'}],
  ['read_diet_records',{recordId:'auto-day'}],
];

test('targeted MCP day reads expose the latest checked and unchecked reminders as advisory context without writes',async()=>{
  const initial=markedMealFixture();store.reset(initial);
  for(const [name,args] of advisoryReads) {
    const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.isError,false,name);
    const content=response.structuredContent,context=advisoryContext(content);assert(context,name+' must carry the advisory context');
    assert.equal(content.revision,initial.revision);assert.equal(context.available,true);assert.equal(context.basis,'personal_reminder');assert.equal(context.actualIntakeEvidence,false);
    assert.equal(context.totalRows,2);assert.equal(context.includedRows,2);assert.equal(context.truncated,false);
    assert.deepEqual(context.rows.map(row=>({sourceMealId:row.sourceMealId,lineId:row.lineId,displayMealId:row.displayMealId,checked:row.checked})),[
      {sourceMealId:'lunch',lineId:'food-line',displayMealId:'lunch',checked:true},
      {sourceMealId:'dinner',lineId:'dinner-food',displayMealId:'dinner',checked:false},
    ]);
    assert(context.rows.every(row=>row.updatedAt===NOW));assert.match(context.instructions,/not.*actual|not.*intake|not.*eaten/i);
    assert.ok(!JSON.stringify(content).includes('personalFoodChecks'),'raw storage is not a second contradictory context');
  }
  assert.deepEqual(store.current(),initial);assert.equal(store.mutations().length,0);
  const updated=applyMutation(store.current(),{action:'set_food_personal_check',operationId:'latest-advisory-toggle',expectedRevision:store.current().revision,planId:'auto-day',mealId:'lunch',lineIds:['food-line'],checked:false},'2026-10-26T15:10:00.000Z');
  store.reset(updated);
  const latest=await rpc('tools/call',{name:'read_intake_draft',arguments:{planId:'auto-day'}});
  assert.equal(latest.structuredContent.revision,updated.revision);assert.equal(latest.structuredContent.personalCheckContext.rows[0].checked,false);
  assert.equal(latest.structuredContent.personalCheckContext.rows[0].updatedAt,'2026-10-26T15:10:00.000Z');assert.deepEqual(store.current(),updated);
});

test('partial actuals and menu settlement stay independent of advisory checks without duplicate rows, intake or stock deduction on reads',async()=>{
  let state=markedMealFixture();
  state=applyMutation(state,{action:'record_meal_intake',operationId:'advisory-partial-actual',expectedRevision:state.revision,planId:'auto-day',mealId:'lunch',entries:[{id:'stable-actual-food',itemId:'food',quantity:20,unit:'g',sourceText:'The user explicitly reported eating 20 g.'}],sourceText:'A partial actual report, independent of reminders.'},NOW);
  state.dailyMenuSettlementPolicy={version:1,enabled:true,timeZone:'America/Toronto',startsOn:'2026-10-25',updatedAt:NOW,sourceText:'The owner enabled midnight menu settlement.'};
  state=applyMutation(state,{action:'settle_daily_menu',operationId:'advisory-settlement',expectedRevision:state.revision,planId:'auto-day',effectiveDate:'2026-10-25',policyStartDate:'2026-10-25',confirmed:true},NOW);
  const before=structuredClone(state);store.reset(state);
  assert.equal(state.items[0].quantity,100,'only the single 100 g daily food total is settled');
  for(let attempt=0;attempt<2;attempt++) for(const [name,args] of advisoryReads) {
    const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.isError,false,name);
    const context=advisoryContext(response.structuredContent);assert.equal(context.actualIntakeEvidence,false);
    assert.equal(context.rows.length,2);assert.equal(new Set(context.rows.map(row=>JSON.stringify([row.sourceMealId,row.lineId]))).size,2);
    assert.deepEqual(context.rows.map(row=>row.checked),[true,false]);
    if(name==='read_intake_draft') {
      const lunch=response.structuredContent.meals.find(meal=>meal.id==='lunch');assert.equal(lunch.rows[0].reportedQuantity,20);
      const dinner=response.structuredContent.meals.find(meal=>meal.id==='dinner');assert.equal(dinner.rows[0].reportedQuantity,0);
    }
  }
  assert.deepEqual(store.current(),before);assert.equal(store.mutations().length,0);
  const saved=store.current().plans.find(plan=>plan.id==='auto-day');
  assert.equal(saved.meals.flatMap(meal=>meal.actualEntries).length,1);assert.equal(saved.meals[0].actualEntries[0].id,'stable-actual-food');assert.equal(saved.meals[0].actualEntries[0].quantity,20);
  assert.equal(saved.accountedDebits.find(line=>line.itemId==='food').quantity,100);assert.equal(saved.dailySettlement.source,'automatic_menu');
});

test('MCP reads follow a moved checked recipe by display meal while retaining one canonical source per ingredient',async()=>{
  let state=layoutFixture();
  state=applyMutation(state,{action:'set_food_layout',operationId:'advisory-moved-recipe',expectedRevision:state.revision,planId:layoutPlanId,moves:recipeMoves('dinner')},NOW);
  const before=structuredClone(state);store.reset(state);
  for(const name of ['read_intake_draft','read_food_plan_edit_context']) {
    const response=await rpc('tools/call',{name,arguments:{planId:layoutPlanId,mealIds:['dinner']}});assert.equal(response.isError,false,name);
    const context=response.structuredContent.personalCheckContext;assert.equal(context.actualIntakeEvidence,false);
    const moved=context.rows.filter(row=>row.sourceMealId==='breakfast');
    assert.deepEqual(moved.map(row=>[row.lineId,row.checked,row.displayMealId]),[
      ['square-oats',true,'dinner'],['square-milk',false,'dinner'],['square-egg',true,'dinner'],
    ]);
    assert.equal(context.rows.filter(row=>row.lineId==='rice-line').length,1);
    assert.equal(new Set(context.rows.map(row=>JSON.stringify([row.sourceMealId,row.lineId]))).size,context.rows.length);
  }
  assert.deepEqual(store.current(),before);assert.equal(store.mutations().length,0);
  assert.equal(store.current().plans[0].meals.find(meal=>meal.id==='breakfast').actualEntries.length,0);
});

test('a later explicit cumulative report settles only the missing amount after advisory reads and exact retries keep the same credit',async()=>{
  store.reset(markedMealFixture());
  const first={operationId:'advisory-first-part',expectedRevision:store.current().revision,planId:'auto-day',mealId:'lunch',entries:[{id:'first-20g',itemId:'food',quantity:20,unit:'g',sourceText:'The owner explicitly ate the first 20 g.'}],sourceText:'The first part of lunch was eaten.'};
  const firstReceipt=await rpc('tools/call',{name:'record_meal_intake',arguments:first});assert.equal(firstReceipt.isError,false);assert.equal(store.current().items[0].quantity,180);
  const afterFirst=structuredClone(store.current());
  for(const [name,args] of advisoryReads) {const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.isError,false,name);assert.equal(advisoryContext(response.structuredContent).rows[0].checked,true);}
  assert.deepEqual(store.current(),afterFirst,'reading a checked row does not report the other 40 g as eaten');
  const second={operationId:'advisory-later-part',expectedRevision:store.current().revision,planId:'auto-day',mealId:'lunch',mode:'correct',entries:[{id:'first-20g',itemId:'food',quantity:60,unit:'g',sourceText:'The owner explicitly ate the remaining 40 g later; cumulative intake is 60 g.'}],sourceText:'Correct the original partial record to its cumulative amount without a second serving.'};
  const secondReceipt=await rpc('tools/call',{name:'record_meal_intake',arguments:second});assert.equal(secondReceipt.isError,false,JSON.stringify(secondReceipt.structuredContent));
  assert.equal(store.current().items[0].quantity,140);const afterSecond=structuredClone(store.current());
  const retry=await rpc('tools/call',{name:'record_meal_intake',arguments:second});assert.equal(retry.isError,false);assert.deepEqual(store.current(),afterSecond);
  const saved=store.current().plans.find(plan=>plan.id==='auto-day');
  const actual=saved.meals.find(meal=>meal.id==='lunch').actualEntries;
  assert.deepEqual(actual.map(entry=>[entry.id,entry.quantity]),[['first-20g',60]]);assert.equal(actual[0].correctionHistory[0].quantity,20);
  assert.equal(saved.accountedDebits.find(line=>line.itemId==='food').quantity,60);
  assert.equal(saved.meals.find(meal=>meal.id==='dinner').actualEntries.length,0);assert.deepEqual(saved.personalFoodChecks,afterFirst.plans.find(plan=>plan.id==='auto-day').personalFoodChecks);
});
test('MCP stock calibration acknowledges the original consumed credit rather than subtracting it again',async()=>{
  let s=mealFixture(null);s=applyMutation(s,{action:'record_meal_intake',operationId:'ate-food',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:'用户明确按菜单吃完'},'2026-10-25T20:00:00Z');store.reset(s);
  const preview=await rpc('tools/call',{name:'read_food_balance_reconciliation',arguments:{itemId:'food'}});assert.equal(preview.structuredContent.recordedQuantity,60);
  const result=await rpc('tools/call',{name:'reconcile_food_inventory',arguments:{operationId:'calibrate-known',expectedRevision:s.revision,itemId:'food',quantity:620,confirmed:true,planIds:preview.structuredContent.planIds,sourceText:'用户确认原680g，已经记录吃60g，剩余620g'}});
  assert.equal(result.isError,false);assert.equal(store.current().items[0].quantity,620);assert.equal(store.current().plans.find(p=>p.id==='auto-day').accountedDebits[0].quantity,60);
});

test('MCP records actual food over a stale balance, reports the difference and never repeats another food debit',async()=>{
  const s=mealFixture(1);s.items.push(validateItem({id:'bread',name:"Bread",category:'bread',quantity:100,unit:'g'},NOW));store.reset(s);
  const args={operationId:'actual-stock-drift',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',entries:[{id:'actual-food',itemId:'food',quantity:2,unit:'g',sourceText:'实吃2g'},{id:'actual-bread',itemId:'bread',quantity:10,unit:'g',sourceText:'实吃10g'}],sourceText:'用户明确吃完，以实际量为准，账面不足记0。'};
  const r=await rpc('tools/call',{name:'record_meal_intake',arguments:args});assert.equal(r.isError,false);assert.equal(r.structuredContent.inventoryAccounting,'settled');
  assert.equal(store.current().items.find(i=>i.id==='food').quantity,0);assert.equal(store.current().items.find(i=>i.id==='bread').quantity,90);
  assert.equal(r.structuredContent.accountingWarnings[0].quantity,1);assert.equal(r.structuredContent.accountingWarnings[0].itemId,'food');
  assert.equal(store.current().plans.find(p=>p.id==='auto-day').meals[0].actualEntries[0].quantity,2);
  const before=structuredClone(store.current());await rpc('tools/call',{name:'record_meal_intake',arguments:args});assert.deepEqual(store.current(),before);
});

test('MCP unit ambiguity retains only that item credit and still settles the independent food',async()=>{
  const s=mealFixture();s.items.push(validateItem({id:'bread',name:"Bread",category:'bread',quantity:100,unit:'g'},NOW));store.reset(s);
  const r=await rpc('tools/call',{name:'record_meal_intake',arguments:{operationId:'mixed-unit-food-report',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',entries:[{id:'actual-food',itemId:'food',quantity:2,unit:'ml',sourceText:'单位待核'},{id:'actual-bread',itemId:'bread',quantity:10,unit:'g',sourceText:'实吃10g'}],sourceText:'实际报告单位有一项待核。'}});
  assert.equal(r.isError,false);assert.equal(r.structuredContent.inventoryAccounting,'pending_reconciliation');
  assert.equal(store.current().items.find(i=>i.id==='food').quantity,200);assert.equal(store.current().items.find(i=>i.id==='bread').quantity,90);
  assert.ok(r.structuredContent.accountingIssues.every(i=>i.itemId==='food'));assert.match(r.structuredContent.note,/Accounting is per item/);
});

test('a legacy pending report can retry accounting through an empty correction without changing any actual entries',async()=>{
  let s=mealFixture(1);s.items.push(validateItem({id:'bread',name:"Bread",category:'bread',quantity:100,unit:'g'},NOW));
  s=applyMutation(s,{action:'record_meal_intake',operationId:'prepare-old-actuals',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',entries:[{id:'actual-food',itemId:'food',quantity:2,unit:'g',sourceText:'实际2g'},{id:'actual-bread',itemId:'bread',quantity:10,unit:'g',sourceText:'实际10g'}],sourceText:'已经明确吃完'},NOW);
  const p=s.plans.find(p=>p.id==='auto-day');p.accountedDebits=[];p.items=[];delete p.accountingWarnings;delete p.accountingAdjustmentHistory;
  p.inventoryAccounting='pending_reconciliation';p.accountingIssues=[{code:'INSUFFICIENT_STOCK',itemId:'food',message:'旧版不足'},{code:'ATOMIC_ACCOUNTING_PENDING',itemId:'bread',message:'旧版整批暂停'}];
  s.items.find(i=>i.id==='food').quantity=1;s.items.find(i=>i.id==='food').status='available';s.items.find(i=>i.id==='bread').quantity=100;
  const actual=structuredClone(p.meals[0].actualEntries);store.reset(s);
  const r=await rpc('tools/call',{name:'record_meal_intake',arguments:{operationId:'retry-existing-facts-only',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'correct',entries:[],sourceText:'仅按原已存实际明细重新核账，无新增进食或改量。'}});
  assert.equal(r.isError,false);assert.equal(r.structuredContent.inventoryAccounting,'settled');
  assert.deepEqual(store.current().plans.find(p=>p.id==='auto-day').meals[0].actualEntries,actual);
  assert.equal(store.current().items.find(i=>i.id==='food').quantity,0);assert.equal(store.current().items.find(i=>i.id==='bread').quantity,90);
});
