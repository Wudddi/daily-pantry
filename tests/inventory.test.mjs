import { legacyFlatPlan } from './fixtures/legacy-flat-plan.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, planningSnapshot, seedState, validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-18T03:00:00.000Z';
const LATER = '2026-10-18T04:00:00.000Z';
// DEMO: all foods, quantities, labels and evidence in this suite are synthetic.
const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 15, carbs: 20, fat: 7, source: 'label', sourceNote: '包装标签' };

function food(overrides = {}) {
  return { id: 'test-food', name: '测试主餐', category: 'prepared', quantity: 2, unit: '袋', nutrition, gramsPerUnit: 300, ...overrides };
}

function mutation(state, action, payload = {}, operationId = `${action}-${state.revision}`) {
  return applyMutation(state, { action, operationId, expectedRevision: state.revision, ...payload }, NOW);
}

function fixtureState() {
  const at = '2026-10-17';
  return {
    schemaVersion: 1, revision: 0, updatedAt: at, events: [], plans: [], operationIds: [], preferences: ['按库存安排饮食'],
    items: [
      validateItem({ id: 'fixture-mushrooms', name: '蘑菇', category: 'vegetable', quantity: 300, unit: 'g', priority: true }, at),
      validateItem({ id: 'fixture-dessert', name: '冰激凌', category: 'dessert', quantity: null, unit: 'g' }, at),
      validateItem({ id: 'fixture-broccoli', name: '西兰花', category: 'vegetable', quantity: 0, unit: 'g' }, at),
    ],
  };
}

test('supplement facts do not require food macros and unknown values stay null', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ id: 'calcium', name: '钙片', category: 'supplement', unit: '片', quantity: null, gramsPerUnit: null, nutrition: { basisAmount: 1, basisUnit: '片', source: 'unknown' }, supplementFacts: '每片元素钙300mg；包装100片，余量未知' }) });
  const snapshot = planningSnapshot(state, NOW);
  const calcium = snapshot.items.find(item => item.id === 'calcium');
  assert.equal(calcium.nutritionReadiness.status, 'not_required');
  assert.deepEqual(calcium.nutritionReadiness.missingNutrients, []);
  assert.equal(calcium.nutrition.protein, null);
  assert.equal(calcium.nutrition.kcal, null);
  assert.equal(calcium.remainingNutrition, null);
  assert.equal(snapshot.nutritionReadiness.supplementCount, 1);
  assert.equal(snapshot.nutritionReadiness.missingCount, 2);
  assert.equal(calcium.quantity, null);
  assert.match(calcium.supplementFacts, /300mg/);
});

test('known supplement calories still calculate without inventing optional missing macros', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ id: 'fish-oil', category: 'supplement', unit: '粒', quantity: 2, gramsPerUnit: null, nutrition: { basisAmount: 1, basisUnit: '粒', kcal: 10, source: 'estimate' } }) });
  const snapshot = planningSnapshot(state, NOW);
  const oil = snapshot.items.find(item => item.id === 'fish-oil');
  assert.equal(oil.nutritionReadiness.status, 'not_required');
  assert.deepEqual(oil.remainingNutrition, { kcal: 20, protein: null, carbs: null, fat: null });
  assert.equal(snapshot.nutritionReadiness.partialCount, 0);
});

test('the DEMO seed is cloned, preserves pending foods and never invents missing mushroom nutrition', () => {
  const state = seedState();
  const mushrooms = state.items.find((entry) => entry.id === 'demo-mushrooms');
  assert.equal(mushrooms.name, 'DEMO 蘑菇');
  assert.equal(mushrooms.quantity, 300);
  assert.equal(mushrooms.nutrition.source, 'unknown');
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) assert.equal(mushrooms.nutrition[key], null);
  const snapshot = planningSnapshot(state, NOW);
  assert.equal(snapshot.availableItems.length, 6);
  assert.equal(snapshot.pendingItems.length, 2);
  assert.equal(snapshot.depletedItems.length, 1);
  assert.ok(snapshot.pendingItems.some((entry) => entry.id === 'demo-stew'));
  assert.ok(snapshot.pendingItems.some((entry) => entry.id === 'demo-potatoes'));
  assert.ok(state.items.every((entry) => entry.name.startsWith('DEMO ') && entry.nutrition.sourceText.startsWith('DEMO synthetic')));
  assert.deepEqual(state.preferences, ['DEMO：优先参考现有库存安排示例菜单。', 'DEMO：未知数量和营养保持未知，核实后再更新。']);
  const after = mutation(state, 'consume', { id: mushrooms.id, quantity: 200 });
  assert.equal(after.items.find((entry) => entry.id === 'demo-mushrooms').quantity, 100);
  state.items[0].nutrition.kcal = 999;
  assert.notEqual(seedState().items[0].nutrition.kcal, 999);
});

test('consume subtracts the confirmed amount without mutating the old state or unrelated confirmation times', () => {
  const before = fixtureState();
  const after = mutation(before, 'consume', { id: 'fixture-mushrooms', quantity: 200 });
  assert.equal(after.items[0].quantity, 100);
  assert.equal(before.items[0].quantity, 300);
  assert.equal(after.items[0].confirmedAt, NOW);
  assert.equal(after.items[1].confirmedAt, before.items[1].confirmedAt);
  assert.equal(after.revision, 1);
  assert.match(after.events[0].detail, /实际食用.*200.*剩余 100/);
});

test('retries are idempotent even with a stale revision', () => {
  const before = fixtureState();
  const payload = { action: 'consume', id: 'fixture-mushrooms', quantity: 200, operationId: 'one-consumption', expectedRevision: 0 };
  const after = applyMutation(before, payload, NOW);
  const retried = applyMutation(after, payload, LATER);
  assert.strictEqual(retried, after);
  assert.equal(retried.items[0].quantity, 100);
  assert.equal(retried.events.length, 1);
});

test('an unrelated stale mutation gets a revision conflict before changing inventory', () => {
  const state = mutation(fixtureState(), 'consume', { id: 'fixture-mushrooms', quantity: 200 });
  assert.throws(() => applyMutation(state, { action: 'set_quantity', id: 'fixture-mushrooms', quantity: 100, operationId: 'stale-write', expectedRevision: 0 }, NOW), (error) => error.status === 409 && error.code === 'REVISION_CONFLICT');
  assert.equal(state.items[0].quantity, 100);
});

test('overspending, negative amounts and consuming an unknown amount are rejected', () => {
  const state = fixtureState();
  assert.throws(() => mutation(state, 'consume', { id: 'fixture-mushrooms', quantity: 301 }), /超过当前库存/);
  assert.throws(() => mutation(state, 'consume', { id: 'fixture-mushrooms', quantity: -1 }), /有限数值/);
  assert.throws(() => mutation(state, 'consume', { id: 'fixture-dessert', quantity: 50 }), (error) => error.code === 'UNKNOWN_QUANTITY');
  assert.equal(state.revision, 0);
});

test('bag counts convert to grams only with explicit gramsPerUnit', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food() });
  const entry = planningSnapshot(state, LATER).availableItems.find((value) => value.id === 'test-food');
  assert.deepEqual(entry.remainingNutrition, { kcal: 1200, protein: 90, carbs: 120, fat: 42 });
  const noWeight = mutation(state, 'upsert', { item: food({ gramsPerUnit: null }) });
  assert.equal(planningSnapshot(noWeight, LATER).items.find((value) => value.id === 'test-food').remainingNutrition, null);
});

test('ml never converts to g, including when a stray gramsPerUnit is present', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ unit: 'ml', quantity: 250, gramsPerUnit: 1 }) });
  const entry = planningSnapshot(state, LATER).availableItems.find((value) => value.id === 'test-food');
  assert.equal(entry.remainingNutrition, null);
  assert.match(entry.nutritionReadiness.issues.join(' '), /无法可靠换算/);
});

test('partial nutrition and genuinely zero nutrition remain distinct from missing data', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ unit: 'g', quantity: 200, nutrition: { ...nutrition, kcal: 0, protein: null, fat: null } }) });
  const entry = planningSnapshot(state, LATER).items.find((value) => value.id === 'test-food');
  assert.deepEqual(entry.remainingNutrition, { kcal: 0, protein: null, carbs: 40, fat: null });
  assert.equal(entry.nutritionReadiness.status, 'partial');
});

test('generating a planning snapshot never consumes inventory or refreshes confirmedAt', () => {
  const state = fixtureState();
  const before = structuredClone(state);
  const first = planningSnapshot(state, NOW);
  const second = planningSnapshot(state, LATER);
  assert.deepEqual(state, before);
  assert.equal(first.items[0].confirmedAt, second.items[0].confirmedAt);
  assert.equal(first.updatedAt, state.updatedAt);
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.items[0].remainingNutrition, null);
  assert.ok(first.rules.some((rule) => rule.includes('保存即显示') && rule.includes('吃完')));
});

test('zero stock stays in the full snapshot but is excluded from usable ingredients', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ quantity: 0, status: 'available' }) });
  const snapshot = planningSnapshot(state, NOW);
  assert.equal(state.items.find((entry) => entry.id === 'test-food').status, 'depleted');
  assert.ok(snapshot.items.some((entry) => entry.id === 'test-food'));
  assert.ok(snapshot.depletedItems.some((entry) => entry.id === 'test-food'));
  assert.ok(!snapshot.availableItems.some((entry) => entry.id === 'test-food'));
  assert.ok(snapshot.availableItems.some((entry) => entry.id === 'fixture-dessert' && entry.quantity === null));
});

test('missing essential fields, NaN, strings, invalid enums and excessive text are rejected', () => {
  for (const [field, value] of [['name', undefined], ['category', undefined], ['quantity', undefined], ['unit', undefined], ['quantity', NaN], ['quantity', '3'], ['quantity', -0.1], ['category', 'invalid-category'], ['unit', 'kg'], ['name', 'x'.repeat(121)]]) {
    assert.throws(() => validateItem(food({ [field]: value }), NOW), `expected invalid ${field}=${String(value)}`);
  }
  assert.throws(() => validateItem(food({ nutrition: { ...nutrition, basisAmount: 0 } }), NOW), /必须大于 0/);
  assert.throws(() => validateItem(food({ nutrition: { ...nutrition, basisAmount: null } }), NOW), /有限数值/);
  assert.throws(() => validateItem(food({ nutrition: { ...nutrition, protein: Infinity } }), NOW), /有限数值/);
  assert.throws(() => validateItem(food({ gramsPerUnit: -5 }), NOW), /有限数值/);
  const unknown = validateItem(food({ nutrition: undefined, quantity: null }), NOW);
  assert.equal(unknown.nutrition.protein, null);
  assert.equal(unknown.quantity, null);
});

test('floating point consumption keeps six-decimal precision', () => {
  let state = mutation(fixtureState(), 'upsert', { item: food({ quantity: 0.3 }) });
  state = mutation(state, 'consume', { id: 'test-food', quantity: 0.1 });
  state = mutation(state, 'consume', { id: 'test-food', quantity: 0.2 });
  assert.equal(state.items.find((entry) => entry.id === 'test-food').quantity, 0);
  assert.equal(state.items.find((entry) => entry.id === 'test-food').status, 'depleted');
});

test('restore validates duplicate IDs and preserves genuine original confirmation times', () => {
  const original = fixtureState();
  assert.throws(() => mutation(original, 'restore', { items: [original.items[0], original.items[0]], preferences: [] }), /重复的食材 ID/);
  const restored = mutation(original, 'restore', { items: original.items, preferences: ['优先已有库存'] });
  assert.equal(restored.items[0].confirmedAt, original.items[0].confirmedAt);
  assert.deepEqual(restored.preferences, ['优先已有库存']);
  assert.equal(restored.updatedAt, NOW);
});

test('the 400-item limit and bounded audit history prevent unlimited growth', () => {
  const item = validateItem(food(), NOW);
  const state = { ...fixtureState(), items: Array.from({ length: 400 }, (_, index) => ({ ...item, id: `food-${index}` })) };
  assert.throws(() => mutation(state, 'upsert', { item: food({ id: 'one-too-many' }) }), /最多保存 400 项/);
  const withHistory = { ...fixtureState(), events: Array.from({ length: 100 }, (_, index) => ({ id: `old-${index}` })), operationIds: Array.from({ length: 1000 }, (_, index) => ({ id: `old-${index}`, at: NOW })) };
  const updated = mutation(withHistory, 'preferences', { preferences: ['按库存排餐'] });
  assert.equal(updated.events.length, 100);
  assert.equal(updated.operationIds.length, 1000);
  assert.equal(updated.operationIds.at(-1).id, 'preferences-0');
});

function plan(overrides = {}) {
  return { id: 'plan-2026-10-18', title: '明天最终饮食', date: '2026-10-18', items: [{ itemId: 'fixture-mushrooms', quantity: 200 }], ...overrides };
}

test('a draft or unconfirmed final menu never deducts inventory', () => {
  const state = fixtureState();
  const before = structuredClone(state);
  planningSnapshot(state, NOW);
  assert.throws(() => mutation(state, 'commit_plan', { plan: plan() }), (error) => error.code === 'PLAN_CONFIRMATION_REQUIRED');
  assert.throws(() => mutation(state, 'commit_plan', { plan: plan(), confirmed: false }), /最终版/);
  assert.deepEqual(state, before);
});

test('new flat finalization is disabled atomically so old callers cannot pre-debit a menu', () => {
  const before=fixtureState(), copy=structuredClone(before);
  for(const raw of [plan(),plan({items:[{itemId:'fixture-mushrooms',quantity:999}]}),plan({items:[{itemId:'fixture-dessert',quantity:80}]})])
    assert.throws(()=>mutation(before,'commit_plan',{plan:raw,confirmed:true}),{code:'STRUCTURED_PLAN_REQUIRED'});
  assert.deepEqual(before,copy);
});

test('stored legacy flat plans remain readable and same-ID retries cannot debit history again', () => {
  const saved=legacyFlatPlan(fixtureState(),plan(),NOW), before=structuredClone(saved);
  assert.strictEqual(mutation(saved,'commit_plan',{plan:plan(),confirmed:true},'legacy-retry'),saved);
  assert.equal(saved.items[0].quantity,100); assert.deepEqual(saved,before);
  const snapshot=planningSnapshot(saved,NOW);
  assert.equal(snapshot.quantityMeaning,'remaining_after_actual_and_legacy_credits');
  assert.equal(snapshot.plans[0].id,plan().id);
});

test('stored legacy plan identity conflicts preserve title, date, notes, amounts and stock', () => {
  const saved=legacyFlatPlan(fixtureState(),plan(),NOW), before=structuredClone(saved);
  for(const patch of [{title:'changed'},{date:'2026-10-19'},{notes:'changed'},{items:[{itemId:'fixture-mushrooms',quantity:50}]}])
    assert.throws(()=>mutation(saved,'commit_plan',{plan:plan(patch),confirmed:true}),{code:'PLAN_ID_CONFLICT'});
  assert.deepEqual(saved,before);
});

test('legacy replay normalizes order, split rows and optional notes without another debit', () => {
  const raw=plan({items:[{itemId:'fixture-mushrooms',quantity:200},{itemId:'fixture-dessert',quantity:80}]}),saved=legacyFlatPlan(fixtureState(),raw,NOW);
  assert.strictEqual(mutation(saved,'commit_plan',{plan:{...raw,notes:'',items:raw.items.toReversed()},confirmed:true}),saved);
  const split=plan({items:[{itemId:'fixture-mushrooms',quantity:149.9},{itemId:'fixture-mushrooms',quantity:50.1},{itemId:'fixture-dessert',quantity:80}]});
  assert.strictEqual(mutation(saved,'commit_plan',{plan:split,confirmed:true},'split-retry'),saved);
});

test('explicit cancellation of an old flat reservation refunds once and cannot reactivate it', () => {
  const saved=legacyFlatPlan(fixtureState(),plan(),NOW),cancelled=mutation(saved,'cancel_plan',{planId:plan().id,confirmed:true});
  assert.equal(cancelled.items[0].quantity,300);assert.equal(cancelled.plans[0].status,'cancelled');
  assert.strictEqual(mutation(cancelled,'cancel_plan',{planId:plan().id,confirmed:true},'second-cancel'),cancelled);
  assert.throws(()=>mutation(cancelled,'commit_plan',{plan:plan(),confirmed:true}),{code:'PLAN_ALREADY_CANCELLED'});
});

test('unknown legacy balances remain unknown through replay and explicit cancellation', () => {
  const raw=plan({items:[{itemId:'fixture-dessert',quantity:80}]}),saved=legacyFlatPlan(fixtureState(),raw,NOW);
  assert.equal(saved.plans[0].items[0].unknownQuantity,true);
  assert.strictEqual(mutation(saved,'commit_plan',{plan:raw,confirmed:true}),saved);
  const cancelled=mutation(saved,'cancel_plan',{planId:raw.id,confirmed:true});
  assert.equal(cancelled.items.find(item=>item.id==='fixture-dessert').quantity,null);
});

test('independent stored credits and later real consumption refund only the requested legacy credits', () => {
  let saved=legacyFlatPlan(fixtureState(),plan(),NOW);
  saved=legacyFlatPlan(saved,plan({id:'plan-two',items:[{itemId:'fixture-mushrooms',quantity:50}]}),NOW);
  saved=mutation(saved,'consume',{id:'fixture-mushrooms',quantity:50});
  saved=mutation(saved,'cancel_plan',{planId:plan().id,confirmed:true}); assert.equal(saved.items[0].quantity,200);
  saved=mutation(saved,'cancel_plan',{planId:'plan-two',confirmed:true});assert.equal(saved.items[0].quantity,250);
});

test('recounted legacy balances reject stale refunds and import cannot overwrite accounted history', () => {
  let saved=legacyFlatPlan(fixtureState(),plan(),NOW);
  saved=mutation(saved,'set_quantity',{id:'fixture-mushrooms',quantity:300});const before=structuredClone(saved);
  assert.throws(()=>mutation(saved,'cancel_plan',{planId:plan().id,confirmed:true}),{code:'REFUND_REQUIRES_REVIEW'});
  assert.throws(()=>mutation(saved,'restore',{items:fixtureState().items,preferences:[]}),{code:'RESTORE_REQUIRES_REVIEW'});
  assert.deepEqual(saved,before);
});

test('legacy nutrition edits preserve credits but absolute count changes invalidate refund baselines', () => {
  let saved=mutation(fixtureState(),'upsert',{item:food({quantity:3})});
  saved=legacyFlatPlan(saved,plan({items:[{itemId:'test-food',quantity:1}]}),NOW);
  const current=saved.items.find(item=>item.id==='test-food');
  const labelled=mutation(saved,'upsert',{item:{id:'test-food',nutrition:{...current.nutrition,kcal:201}}});
  assert.equal(mutation(labelled,'cancel_plan',{planId:plan().id,confirmed:true}).items.find(item=>item.id==='test-food').quantity,3);
  const changed=mutation(labelled,'upsert',{item:{id:'test-food',quantity:4}});
  assert.throws(()=>mutation(changed,'cancel_plan',{planId:plan().id,confirmed:true}),{code:'REFUND_REQUIRES_REVIEW'});
});

test('pending items remain excluded while discrete units retain reliable nutrition conversion', () => {
  let state=mutation(fixtureState(),'upsert',{item:food({status:'pending',quantity:null})});
  const snap=planningSnapshot(state,NOW);assert.ok(snap.pendingItems.some(item=>item.id==='test-food'));
  assert.ok(!snap.availableItems.some(item=>item.id==='test-food'));
  for(const unit of ['包','罐','条']){state=mutation(state,'upsert',{item:food({unit,quantity:2})});assert.equal(planningSnapshot(state,NOW).items.find(item=>item.id==='test-food').remainingNutrition.kcal,1200);}
});

test('snapshots preserve all stored history while bounding recent plus future plan summaries', () => {
  const historical=Array.from({length:20},(_,index)=>({id:'old-'+index,title:'旧计划',date:'2026-09-01',items:[],status:'reserved',createdAt:NOW,updatedAt:NOW}));
  const state={...fixtureState(),plans:[{...historical[0],id:'future-plan',date:'2026-10-20'},...historical]},snap=planningSnapshot(state,NOW);
  assert.equal(snap.plans.length,15);assert.ok(snap.plans.some(row=>row.id==='future-plan'));assert.equal(state.plans.length,21);assert.equal(snap.planSummary.omitted,6);
});

test('snapshot inclusion uses the Toronto calendar day rather than the UTC day', () => {
  const historical = Array.from({ length: 20 }, (_, index) => ({ id: `past-${index}`, title: '旧计划', date: '2026-09-01', items: [], status: 'cancelled', createdAt: NOW, updatedAt: NOW }));
  const today = { ...historical[0], id: 'still-today-in-toronto', date: '2026-10-17', status: 'reserved' };
  const state = { ...fixtureState(), plans: [today, ...historical] };
  assert.ok(planningSnapshot(state, '2026-10-18T03:00:00.000Z').plans.some((entry) => entry.id === today.id));
  assert.ok(!planningSnapshot(state, '2026-10-18T05:00:00.000Z').plans.some((entry) => entry.id === today.id));
});

test('supplements accept capsules and drops and preserve complete ingredient and supplement label text', () => {
  const raw = food({ category: 'supplement', quantity: null, unit: '粒', nutrition: undefined, ingredients: ' 配料：鱼油\n明胶、甘油。 ', supplementFacts: '每2粒：鱼油 2000 mg\nEPA 600 mg；DHA 400 mg。' });
  const item = validateItem(raw, NOW);
  assert.equal(item.category, 'supplement');
  assert.equal(item.quantity, null);
  assert.equal(item.ingredients, raw.ingredients);
  assert.equal(item.supplementFacts, raw.supplementFacts);
  assert.equal(item.nutrition.basisAmount, 1);
  assert.equal(item.nutrition.basisUnit, '粒');
  assert.equal(item.nutrition.kcal, null);
  assert.equal(item.nutrition.fat, null);
  assert.equal(validateItem({ ...raw, unit: '滴' }, NOW).unit, '滴');
  assert.throws(() => validateItem({ ...raw, unit: 'mg' }, NOW));
  assert.throws(() => validateItem({ ...raw, nutrition: { basisAmount: 100, basisUnit: 'mg' } }, NOW));
});

test('a partial label patch preserves stock, old nutrition values and quantity confirmation metadata', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ brand: '品牌A', notes: '原备注', ingredients: '原配料' }) });
  const old = state.items.find((entry) => entry.id === 'test-food');
  const after = applyMutation(state, { action: 'upsert', item: { id: 'test-food', nutrition: { kcal: 201, sourceText: ' 每100g 201kcal\n其余看不清 ' } }, expectedRevision: state.revision, operationId: 'label-only' }, LATER);
  const changed = after.items.find((entry) => entry.id === 'test-food');
  assert.equal(changed.quantity, old.quantity);
  assert.equal(changed.brand, '品牌A');
  assert.equal(changed.notes, '原备注');
  assert.equal(changed.ingredients, '原配料');
  assert.equal(changed.nutrition.kcal, 201);
  assert.equal(changed.nutrition.protein, old.nutrition.protein);
  assert.equal(changed.nutrition.sourceText, ' 每100g 201kcal\n其余看不清 ');
  assert.equal(changed.confirmedAt, old.confirmedAt);
  assert.equal(changed.quantityBaselineToken, old.quantityBaselineToken);
  assert.equal(changed.updatedAt, LATER);
});

test('partial label confirmation never upgrades unmentioned estimated nutrients to label evidence', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ nutrition: { ...nutrition, source: 'estimate', sourceNote: '用户授权估算' } }) });
  const after = mutation(state, 'upsert', { item: { id: 'test-food', nutrition: { kcal: 210, source: 'label' } } });
  const changed = after.items.find((entry) => entry.id === 'test-food').nutrition;
  assert.equal(changed.kcal, 210);
  assert.equal(changed.protein, 15);
  assert.deepEqual(changed.nutrientSources, { kcal: 'label', protein: 'estimate', carbs: 'estimate', fat: 'estimate' });
  assert.equal(changed.source, 'estimate');
  assert.match(changed.sourceNote, /protein=estimate/);
  const repeated = mutation(after, 'upsert', { item: { id: 'test-food', brand: '只改品牌' } });
  assert.equal(repeated.items.find((entry) => entry.id === 'test-food').nutrition.sourceNote, changed.sourceNote);
});

test('a source-text-only patch preserves existing per-field evidence even when a global label source is supplied', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ nutrition: { ...nutrition, source: 'estimate' } }) });
  const after = mutation(state, 'upsert', { item: { id: 'test-food', nutrition: { source: 'label', sourceText: '新照片，只有标题可读' } } });
  const changed = after.items.find((entry) => entry.id === 'test-food').nutrition;
  assert.equal(changed.source, 'estimate');
  assert.ok(Object.values(changed.nutrientSources).every((source) => source === 'estimate'));
});

test('mixed label and recipe evidence is conservatively unknown and explicit field evidence takes precedence', () => {
  const item = validateItem(food({ nutrition: { ...nutrition, source: 'label', nutrientSources: { protein: 'recipe' } } }), NOW);
  assert.equal(item.nutrition.source, 'unknown');
  assert.equal(item.nutrition.nutrientSources.kcal, 'label');
  assert.equal(item.nutrition.nutrientSources.protein, 'recipe');
  assert.match(item.nutrition.sourceNote, /protein=recipe/);
  const state = mutation(fixtureState(), 'upsert', { item });
  const after = mutation(state, 'upsert', { item: { id: 'test-food', nutrition: { protein: 16, source: 'estimate', nutrientSources: { protein: 'label' } } } });
  assert.equal(after.items.find((entry) => entry.id === 'test-food').nutrition.source, 'label');
  assert.equal(after.items.find((entry) => entry.id === 'test-food').nutrition.sourceNote, '包装标签');
});

test('explicitly clearing one nutrient keeps it null with unknown evidence and never zeroes the others', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food() });
  const after = mutation(state, 'upsert', { item: { id: 'test-food', nutrition: { protein: null, source: 'label' } } });
  const changed = after.items.find((entry) => entry.id === 'test-food').nutrition;
  assert.equal(changed.protein, null);
  assert.equal(changed.nutrientSources.protein, 'unknown');
  assert.equal(changed.carbs, 20);
  assert.equal(changed.source, 'label');
  const unknown = validateItem(food({ nutrition: { source: 'label' } }), NOW).nutrition;
  assert.ok(['kcal', 'protein', 'carbs', 'fat'].every((key) => unknown[key] === null && unknown.nutrientSources[key] === 'unknown'));
});

test('legacy global sources remain valid fallbacks and snapshot source maps do not alias state', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ nutrition: { ...nutrition, source: 'estimate' } }) });
  const legacy = structuredClone(state);
  delete legacy.items.find((entry) => entry.id === 'test-food').nutrition.nutrientSources;
  const after = mutation(legacy, 'upsert', { item: { id: 'test-food', nutrition: { kcal: 220, source: 'label' } } });
  const changed = after.items.find((entry) => entry.id === 'test-food');
  assert.equal(changed.nutrition.nutrientSources.protein, 'estimate');
  const snapshot = planningSnapshot(after, LATER);
  const read = snapshot.items.find((entry) => entry.id === 'test-food');
  read.perBasis.nutrientSources.kcal = 'unknown';
  read.nutrition.nutrientSources.protein = 'unknown';
  assert.equal(changed.nutrition.nutrientSources.kcal, 'label');
  assert.equal(changed.nutrition.nutrientSources.protein, 'estimate');
});

test('label-only updates preserve depleted, pending and archived status without reviving inventory', () => {
  for (const [quantity, status] of [[0, 'depleted'], [null, 'pending'], [0, 'pending'], [0, 'archived']]) {
    const entry = validateItem(food({ quantity, status }), NOW);
    const state = { ...fixtureState(), items: [entry] };
    const updated = applyMutation(state, { action: 'upsert', item: { id: entry.id, nutrition: { sourceText: '标签原文', kcal: 0, source: 'label' }, ingredients: '新配料表' }, expectedRevision: 0, operationId: `label-${status}` }, LATER);
    assert.equal(updated.items[0].quantity, quantity);
    assert.equal(updated.items[0].status, status);
    assert.equal(updated.items[0].confirmedAt, NOW);
    assert.equal(updated.items[0].quantityBaselineToken, entry.quantityBaselineToken);
    assert.equal(planningSnapshot(updated, LATER).availableItems.length, 0);
  }
});

test('saving label evidence does not invalidate a reservation refund, while a real count change does', () => {
  let state = mutation(fixtureState(), 'upsert', { item: food({ quantity: 3 }) });
  state = legacyFlatPlan(state, plan({ items: [{ itemId: 'test-food', quantity: 1 }] }), NOW);
  const reserved = state.items.find((entry) => entry.id === 'test-food');
  const labelled = applyMutation(state, { action: 'upsert', item: { id: 'test-food', nutrition: { fat: 8, source: 'label' } }, expectedRevision: state.revision, operationId: 'photo-after-plan' }, LATER);
  assert.equal(labelled.items.find((entry) => entry.id === 'test-food').confirmedAt, reserved.confirmedAt);
  const cancelled = mutation(labelled, 'cancel_plan', { planId: plan().id, confirmed: true });
  assert.equal(cancelled.items.find((entry) => entry.id === 'test-food').quantity, 3);
  const recounted = applyMutation(labelled, { action: 'upsert', item: { id: 'test-food', quantity: 5 }, expectedRevision: labelled.revision, operationId: 'real-recount' }, LATER);
  assert.equal(recounted.items.find((entry) => entry.id === 'test-food').confirmedAt, LATER);
  assert.notEqual(recounted.items.find((entry) => entry.id === 'test-food').quantityBaselineToken, reserved.quantityBaselineToken);
  assert.throws(() => mutation(recounted, 'cancel_plan', { planId: plan().id, confirmed: true }), (error) => error.code === 'REFUND_REQUIRES_REVIEW');
});

test('photo-item retries use the stable item ID and operation ID without creating duplicate rows', () => {
  const state = fixtureState();
  const payload = { action: 'upsert', operationId: 'photo-new-item', expectedRevision: 0, item: food({ category: 'supplement', quantity: null, unit: '粒', nutrition: undefined }) };
  const after = applyMutation(state, payload, NOW);
  assert.strictEqual(applyMutation(after, payload, LATER), after);
  assert.equal(after.items.filter((entry) => entry.id === 'test-food').length, 1);
  const update = applyMutation(after, { action: 'upsert', operationId: 'photo-same-product', expectedRevision: after.revision, item: { id: 'test-food', supplementFacts: '维生素D 25mcg/粒' } }, LATER);
  assert.equal(update.items.length, after.items.length);
  assert.equal(update.items.find((entry) => entry.id === 'test-food').quantity, null);
  assert.equal(update.items.find((entry) => entry.id === 'test-food').confirmedAt, NOW);
});

test('a photo operation ID cannot silently save a different label, while sorted keys and retry revisions remain idempotent', () => {
  const payload = { action: 'upsert', operationId: 'photo-content-identity', expectedRevision: 0, item: food({ nutrition: { kcal: 200, source: 'label', sourceText: '完整照片原文'.repeat(1500) } }) };
  const state = applyMutation(fixtureState(), payload, NOW);
  const reordered = { item: Object.fromEntries(Object.entries(payload.item).reverse()), expectedRevision: 777, operationId: payload.operationId, action: 'upsert' };
  assert.strictEqual(applyMutation(state, reordered, LATER), state);
  assert.throws(() => applyMutation(state, { ...payload, item: { ...payload.item, nutrition: { ...payload.item.nutrition, kcal: 201 } } }, LATER), (error) => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  assert.equal(state.items.find((entry) => entry.id === 'test-food').nutrition.kcal, 200);
  assert.ok(JSON.stringify(state.operationIds.at(-1)).length < 200);
  assert.equal(state.operationIds.at(-1).fingerprint.length, 35);
});

test('old persisted retry entries without a content fingerprint retain backwards-compatible success', () => {
  const state = { ...fixtureState(), operationIds: [{ id: 'pre-fingerprint', at: NOW }] };
  assert.strictEqual(applyMutation(state, { operationId: 'pre-fingerprint', expectedRevision: -1, action: 'upsert', item: { nutrition: { kcal: 999 } } }, LATER), state);
});

test('drop volumes and supplement active-component masses do not imply stock mass or macros', () => {
  const state = mutation(fixtureState(), 'upsert', { item: food({ category: 'supplement', unit: '滴', quantity: 20, gramsPerUnit: null, supplementFacts: '每滴维生素D 25mcg', nutrition: { basisAmount: 1, basisUnit: 'ml', kcal: 10, source: 'label' } }) });
  const item = planningSnapshot(state, LATER).items.find((entry) => entry.id === 'test-food');
  assert.equal(item.remainingNutrition, null);
  assert.equal(item.gramsPerUnit, null);
  assert.equal(item.nutrition.protein, null);
  assert.equal(item.nutrition.fat, null);
});

test('bounded raw-label fields and nutrient-source validation reject invalid data without mutating stock', () => {
  assert.throws(() => validateItem(food({ ingredients: 'x'.repeat(12001) }), NOW));
  assert.throws(() => validateItem(food({ supplementFacts: 'x'.repeat(12001) }), NOW));
  assert.throws(() => validateItem(food({ nutrition: { ...nutrition, sourceText: 'x'.repeat(16001) } }), NOW));
  assert.throws(() => validateItem(food({ nutrition: { ...nutrition, nutrientSources: { protein: 'guessed' } } }), NOW));
  assert.throws(() => validateItem(food({ nutrition: { ...nutrition, nutrientSources: { vitaminD: 'label' } } }), NOW));
  const state = mutation(fixtureState(), 'upsert', { item: food() });
  assert.throws(() => mutation(state, 'upsert', { item: { id: 'test-food', nutrition: null } }));
  assert.equal(state.items.find((entry) => entry.id === 'test-food').nutrition.protein, 15);
});
