import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { validateItem, applyMutation } from '../lib/inventory.mjs';

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
// All preferences and human quotes in this fixture are fictional examples.
function fixture() {
  return { schemaVersion:1, revision:0, updatedAt:NOW, preferences:['示例食材A优先', '保留示例分装的单位'], events:[], operationIds:[],
    items:[validateItem({id:'food', name:'测试食物', category:'fruit', unit:'g', quantity:200}, NOW)],
    plans:[{id:'prior-day', title:'保留旧菜单', date:'2026-10-25', status:'cancelled', items:[], notes:'历史原文'}],
    dietHistory:[{id:'prior-history', date:'2026-10-25', sourceText:'历史饮食原文'}],
    supplementRoutine:{supplementDoses:[{id:'stable-dose', instruction:'原补给安排'}]},
  };
}
const payload = (extra = {}) => ({operationId:'habit-demo-rule', expectedRevision:0, confirmed:true,
  add:['未主动要求时不安排示例食材B'], sourceText:'合成示例：以后默认不安排示例食材B，明确指定时例外。', sourceDate:'2026-10-26', ...extra});
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
  assert.match(init.instructions, /某一天|单日|当天/);
  assert.match(init.instructions, /用户明确已吃才record_meal_intake/);
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
  assert.equal(receipt.operationId, 'habit-demo-rule');
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
  s=applyMutation(s,{action:'save_meal_plan_draft',operationId:'fixture-menu',expectedRevision:s.revision,plan:{id:'auto-day',date:'2026-10-25',title:'测试已保存菜单',meals:[{id:'lunch',slot:'lunch',title:'午餐',plannedItems:[{id:'food-line',itemId:'food',quantity:60,unit:'g'}]}],supplementDoses:[]}},'2026-10-25T12:00:00Z');
  return s;
}
test('the scheduled MCP writer honors actor policy, dry-run and repeated daily processing without using personal marks',async()=>{
  const s=mealFixture();s.dailyMenuSettlementPolicy={version:1,enabled:true,timeZone:'America/Toronto',startsOn:'2026-10-25',updatedAt:NOW,sourceText:'明确开启自动结算'};
  s.plans.find(p=>p.id==='auto-day').personalFoodChecks={version:1,checks:[{mealId:'lunch',lineId:'food-line',checked:false,updatedAt:NOW}],updatedAt:NOW};store.reset(s);
  let r=await rpc('tools/call',{name:'settle_due_daily_menus',arguments:{dryRun:true}});assert.equal(r.isError,false);assert.equal(store.current().items[0].quantity,200);assert.equal(store.mutations().length,0);
  r=await rpc('tools/call',{name:'settle_due_daily_menus',arguments:{dryRun:false}});assert.equal(r.isError,false);assert.equal(store.current().items[0].quantity,140);
  const saved=store.current().plans.find(p=>p.id==='auto-day');assert.equal(saved.dailySettlement.basis,'auto_planned');assert.equal(saved.meals[0].actualEntries.length,0);assert.equal(saved.personalFoodChecks.checks[0].checked,false);
  await rpc('tools/call',{name:'settle_due_daily_menus',arguments:{dryRun:false}});assert.equal(store.current().items[0].quantity,140);
  const details=await rpc('tools/call',{name:'read_diet_records',arguments:{recordId:'auto-day'}});assert.equal(details.isError,false);assert.ok(!JSON.stringify(details.structuredContent).includes('personalFoodChecks'));
});
test('MCP stock calibration acknowledges the original consumed credit rather than subtracting it again',async()=>{
  let s=mealFixture(null);s=applyMutation(s,{action:'record_meal_intake',operationId:'ate-food',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',matchesPlannedFood:true,sourceText:'用户明确按菜单吃完'},'2026-10-25T20:00:00Z');store.reset(s);
  const preview=await rpc('tools/call',{name:'read_food_balance_reconciliation',arguments:{itemId:'food'}});assert.equal(preview.structuredContent.recordedQuantity,60);
  const result=await rpc('tools/call',{name:'reconcile_food_inventory',arguments:{operationId:'calibrate-known',expectedRevision:s.revision,itemId:'food',quantity:620,confirmed:true,planIds:preview.structuredContent.planIds,sourceText:'用户确认原680g，已经记录吃60g，剩余620g'}});
  assert.equal(result.isError,false);assert.equal(store.current().items[0].quantity,620);assert.equal(store.current().plans.find(p=>p.id==='auto-day').accountedDebits[0].quantity,60);
});

test('MCP records actual food over a stale balance, reports the difference and never repeats another food debit',async()=>{
  const s=mealFixture(1);s.items.push(validateItem({id:'bread',name:'面包',category:'bread',quantity:100,unit:'g'},NOW));store.reset(s);
  const args={operationId:'actual-stock-drift',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',entries:[{id:'actual-food',itemId:'food',quantity:2,unit:'g',sourceText:'实吃2g'},{id:'actual-bread',itemId:'bread',quantity:10,unit:'g',sourceText:'实吃10g'}],sourceText:'用户明确吃完，以实际量为准，账面不足记0。'};
  const r=await rpc('tools/call',{name:'record_meal_intake',arguments:args});assert.equal(r.isError,false);assert.equal(r.structuredContent.inventoryAccounting,'settled');
  assert.equal(store.current().items.find(i=>i.id==='food').quantity,0);assert.equal(store.current().items.find(i=>i.id==='bread').quantity,90);
  assert.equal(r.structuredContent.accountingWarnings[0].quantity,1);assert.equal(r.structuredContent.accountingWarnings[0].itemId,'food');
  assert.equal(store.current().plans.find(p=>p.id==='auto-day').meals[0].actualEntries[0].quantity,2);
  const before=structuredClone(store.current());await rpc('tools/call',{name:'record_meal_intake',arguments:args});assert.deepEqual(store.current(),before);
});

test('MCP unit ambiguity retains only that item credit and still settles the independent food',async()=>{
  const s=mealFixture();s.items.push(validateItem({id:'bread',name:'面包',category:'bread',quantity:100,unit:'g'},NOW));store.reset(s);
  const r=await rpc('tools/call',{name:'record_meal_intake',arguments:{operationId:'mixed-unit-food-report',expectedRevision:s.revision,planId:'auto-day',mealId:'lunch',mode:'complete',entries:[{id:'actual-food',itemId:'food',quantity:2,unit:'ml',sourceText:'单位待核'},{id:'actual-bread',itemId:'bread',quantity:10,unit:'g',sourceText:'实吃10g'}],sourceText:'实际报告单位有一项待核。'}});
  assert.equal(r.isError,false);assert.equal(r.structuredContent.inventoryAccounting,'pending_reconciliation');
  assert.equal(store.current().items.find(i=>i.id==='food').quantity,200);assert.equal(store.current().items.find(i=>i.id==='bread').quantity,90);
  assert.ok(r.structuredContent.accountingIssues.every(i=>i.itemId==='food'));assert.match(r.structuredContent.note,/按食材独立/);
});

test('a legacy pending report can retry accounting through an empty correction without changing any actual entries',async()=>{
  let s=mealFixture(1);s.items.push(validateItem({id:'bread',name:'面包',category:'bread',quantity:100,unit:'g'},NOW));
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
