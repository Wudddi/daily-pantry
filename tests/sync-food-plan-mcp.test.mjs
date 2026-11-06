import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { fixture, ID, preserved } from './fixtures/sync-food-plan.mjs';

// Exercise the real RPC dispatcher and domain action with an isolated fake R2
// boundary. No production state, authentication or network is used.
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const storeUrl = moduleUrl(`
  import { applyMutation } from ${JSON.stringify(new URL('../lib/inventory.mjs', import.meta.url).href)};
  let state, calls=[];
  export const reset = value => {state=structuredClone(value);calls=[];};
  export const current = () => state;
  export const mutations = () => calls;
  export function actorFrom(request) {if(!request.headers.get('oai-authenticated-user-id')) throw Object.assign(new Error('Sign in first.'),{status:401});return 'demo-sync-actor';}
  export const boundedJson = request => request.json();
  export const readInventory = async () => ({state});
  export const mutateInventory = async (actor,payload) => {calls.push(structuredClone(payload));state=applyMutation(state,payload,'2026-02-12T18:00:00.000Z');return {state};};
`);
const healthUrl=moduleUrl('export const readHealth=async()=>{throw Error("Health data is not used by food plan sync.")};export const mutateHealth=readHealth;');
const modules=new Map();
async function compile(relative){
  if(modules.has(relative))return modules.get(relative);
  let code=ts.transpileModule(await readFile(new URL('../'+relative,import.meta.url),'utf8'),{fileName:relative,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const spec of new Set([...code.matchAll(/from\s+(['"])([^'"]+)\1/g)].map(match=>match[2]))){
    let target;
    if(spec==='@/lib/inventory-store'||spec==='./inventory-store')target=storeUrl;
    else if(spec==='@/lib/health-store')target=healthUrl;
    else if(spec.startsWith('@/lib/')){const path='lib/'+spec.slice(6);target=spec.endsWith('.mjs')?new URL('../'+path,import.meta.url).href:await compile(path+'.ts');}
    else if(spec.startsWith('./')||spec.startsWith('../'))target=new URL(spec,new URL('../'+relative,import.meta.url)).href;
    else target=import.meta.resolve(spec);
    code=code.replaceAll(JSON.stringify(spec),JSON.stringify(target)).replaceAll("'"+spec+"'",JSON.stringify(target));
  }
  const url=moduleUrl(code);modules.set(relative,url);return url;
}
const {POST}=await import(await compile('app/mcp/route.ts'));
const store=await import(storeUrl);
async function rpc(method,params,authenticated=true){
  const response=await POST(new Request('http://demo-sync.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{'oai-authenticated-user-id':'demo-sync-only'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  return (await response.json()).result;
}
const call=(name,args,authenticated=true)=>rpc('tools/call',{name,arguments:args},authenticated);

test('MCP exposes a read-only sync preview and authenticated fingerprinted plan-only application',async()=>{
  const initial=fixture();store.reset(initial);
  const listing=await rpc('tools/list');
  const read=listing.tools.find(tool=>tool.name==='read_food_plan_sync_preview');
  const write=listing.tools.find(tool=>tool.name==='sync_food_plan');
  assert.equal(read.annotations.readOnlyHint,true);
  assert.equal(write.annotations.readOnlyHint,false);
  assert.ok(write.inputSchema.required.includes('expectedFingerprint'));
  const previewResult=await call(read.name,{planId:ID});
  assert.equal(previewResult.isError,false);
  const preview=previewResult.structuredContent;
  assert.equal(preview.canApply,true);assert.equal(preview.revision,initial.revision);
  assert.equal(preview.inventoryEffect,'none');assert.equal(preview.plan,undefined);
  assert.deepEqual(store.current(),initial);assert.deepEqual(store.mutations(),[]);
  const command={planId:ID,operationId:'demo-sync-rpc-once',expectedRevision:preview.revision,expectedFingerprint:preview.fingerprint};
  const result=await call(write.name,command);
  assert.equal(result.isError,false);
  assert.equal(result.structuredContent.inventoryEffect,'none');
  assert.equal(result.structuredContent.nutritionSummary.totals.length,4);
  assert.ok(result.structuredContent.dailyFoodSummary);
  assert.deepEqual(preserved(store.current()),preserved(initial));
  const saved=structuredClone(store.current());
  const retry=await call(write.name,command);
  assert.equal(retry.isError,false);assert.deepEqual(store.current(),saved);
});

test('MCP rejects unauthenticated sync and unknown preview input without inventory writes',async()=>{
  const initial=fixture();store.reset(initial);
  const denied=await call('sync_food_plan',{planId:ID,operationId:'demo-denied',expectedRevision:initial.revision,expectedFingerprint:'none'},false);
  assert.equal(denied.isError,true);
  const invalid=await call('read_food_plan_sync_preview',{planId:ID,actualEntries:[]});
  assert.equal(invalid.isError,true);
  assert.deepEqual(store.current(),initial);assert.deepEqual(store.mutations(),[]);
});

test('MCP can organize existing actual food into half recipes without reporting intake or settling stock',async()=>{
  const initial=fixture();store.reset(initial);
  const before=initial.plans.find(plan=>plan.id===ID),meal=before.meals.find(meal=>meal.id==='breakfast');
  const listing=await rpc('tools/list'),tool=listing.tools.find(tool=>tool.name==='set_actual_recipe_groups');
  assert.ok(tool);assert.equal(tool.annotations.idempotentHint,true);
  const groups=[{id:'demo-reported-half',name:'DEMO half cereal recipe',portion:0.5,actualEntryIds:[meal.actualEntries[0].id]}];
  const command={planId:ID,mealId:meal.id,groups,expectedRevision:initial.revision,operationId:'demo-recipe-metadata-rpc-once'};
  const response=await call(tool.name,command);
  assert.equal(response.isError,false);assert.equal(response.structuredContent.inventoryEffect,'none');
  const saved=store.current(),after=saved.plans.find(plan=>plan.id===ID),changed=after.meals.find(entry=>entry.id===meal.id);
  assert.deepEqual(changed.actualRecipeGroups,groups);
  for(const key of ['actualEntries','reportHistory','state','actualTime','completionReportedAt','plannedItems','recipeGroups'])assert.deepEqual(changed[key],meal[key],key);
  for(const key of ['supplementDoses','accountedDebits','items','inventoryAccounting','accountingIssues','personalFoodChecks'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(saved.items,initial.items);assert.deepEqual(saved.dailyMenuSettlementPolicy,initial.dailyMenuSettlementPolicy);
  const context=await call('read_food_plan_edit_context',{planId:ID,mealIds:[meal.id]});
  assert.equal(context.isError,false);assert.deepEqual(context.structuredContent.meals[0].actualRecipeGroups,groups);
  const snapshot=structuredClone(saved),retry=await call(tool.name,command);
  assert.equal(retry.isError,false);assert.deepEqual(store.current(),snapshot);
});

test('MCP protects actual-recipe organization from unauthorized calls and intake-field injection',async()=>{
  const initial=fixture();store.reset(initial);
  const command={planId:ID,mealId:'breakfast',groups:[],expectedRevision:initial.revision,operationId:'demo-recipe-group-denied'};
  assert.equal((await call('set_actual_recipe_groups',command,false)).isError,true);
  assert.equal((await call('set_actual_recipe_groups',{...command,actualEntries:[]})).isError,true);
  assert.deepEqual(store.current(),initial);
});

test('Chat reads the latest saved web meal arrangement without adopting drafts or creating another serving',async()=>{
  const initial=fixture();initial.plans[0].intakeDraft={id:'demo-rpc-layout-draft',baseFingerprint:'demo-old',consumed:[],transfers:[],completedMealIds:[]};store.reset(initial);
  const before=structuredClone(initial),preview=await call('read_food_plan_edit_context',{planId:ID,mealIds:['breakfast']});
  assert.equal(preview.isError,false);
  const command={planId:ID,operationId:'demo-web-layout-rpc',expectedRevision:preview.structuredContent.revision,expectedFingerprint:preview.structuredContent.plan.foodLayoutFingerprint,
    moves:[{sourceMealId:'breakfast',sourceKind:'actual',sourceId:initial.plans[0].meals[0].actualEntries[0].id,targetMealId:'lunch'}]};
  const written=await call('set_food_layout',command);assert.equal(written.isError,false);assert.equal(written.structuredContent.inventoryEffect,'none');
  const saved=structuredClone(store.current());assert.deepEqual(saved.plans[0].meals,before.plans[0].meals);assert.deepEqual(saved.items,before.items);
  assert.deepEqual(saved.plans[0].intakeDraft,before.plans[0].intakeDraft);
  const context=await call('read_food_plan_edit_context',{planId:ID,mealIds:['lunch']});
  assert.equal(context.isError,false);assert.equal(context.structuredContent.revision,saved.revision);
  assert.deepEqual(context.structuredContent.plan.foodLayoutOverrides,saved.plans[0].foodLayoutOverrides);
  assert.notEqual(context.structuredContent.plan.foodLayoutFingerprint,preview.structuredContent.plan.foodLayoutFingerprint);
  const draft=await call('read_intake_draft',{planId:ID,mealIds:['lunch']});assert.equal(draft.isError,false);
  assert.deepEqual(draft.structuredContent.foodLayoutOverrides,saved.plans[0].foodLayoutOverrides);
  const retry=await call('set_food_layout',command);assert.equal(retry.isError,false);assert.deepEqual(store.current(),saved);
});
