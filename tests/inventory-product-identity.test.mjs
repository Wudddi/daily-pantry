import { legacyFlatPlan } from './fixtures/legacy-flat-plan.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { isReusableProduct, matchExistingProducts } from '../lib/inventory-product-identity.mjs';

const NOW = '2026-10-21T12:00:00.000Z';
const LATER = '2026-10-21T13:00:00.000Z';
const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 60, protein: 10, carbs: 5, fat: 0, source: 'label', sourceText: '原始实物营养标签' };
const yogurt = (patch = {}) => validateItem({ id: 'pc-yogurt', name: 'PC Plain Greek Yogurt 0% M.F.（原味无脂希腊酸奶1kg）',
  brand: 'PC', category: 'protein', quantity: 700, unit: 'g', nutrition, aliases: ['0%希腊酸奶'], ...patch }, NOW);
const state = (items = [yogurt()]) => ({ schemaVersion: 1, revision: 0, updatedAt: NOW, items, events: [], operationIds: [], plans: [], preferences: [] });
const apply = (before, action, payload = {}, operationId = `${action}-${before.revision}`) => applyMutation(before, {
  action, expectedRevision: before.revision, operationId, ...payload,
}, LATER);

test('commercial matching uses exact normalized names and verified aliases, including archived labels', () => {
  const archived = yogurt({ id: 'old-pc', quantity: 0, status: 'archived' });
  const active = yogurt();
  assert.deepEqual(matchExistingProducts([archived, active], { id: 'new', name: '０％ 希腊酸奶', category: 'protein', unit: 'g' }).map(item => item.id), ['pc-yogurt', 'old-pc']);
  assert.deepEqual(matchExistingProducts([active], { ...active, id: 'new', name: 'PC Plain Greek Yogurt 0% M.F.(原味无脂希腊酸奶1kg)' }).map(item => item.id), ['pc-yogurt']);
  assert.deepEqual(matchExistingProducts([active], active), []);
  assert.deepEqual(matchExistingProducts([active], { ...active, id: 'new', name: '0%希腊酸奶', aliases: [] }), [active]);
  assert.equal(matchExistingProducts([active], { ...active, id: 'new', name: '2%希腊酸奶', aliases: [] }).length, 0);
});

test('different known brands, sizes, units and supplement strengths are not silently grouped', () => {
  const old = yogurt();
  for (const patch of [
    { brand: 'Oikos' }, { unit: '个' }, { category: 'condiment' }, { gramsPerUnit: 500 },
  ]) {
    const source = { ...old, gramsPerUnit: 1000 };
    assert.equal(matchExistingProducts([source], { ...old, id: 'new', name: '0%希腊酸奶', aliases: [], ...patch }).length, 0);
  }
  assert.equal(matchExistingProducts([old], { ...old, id: 'new', name: 'PC 原味酸奶500g', aliases: ['0%希腊酸奶'] }).length, 0);
  assert.equal(matchExistingProducts([{ id: 'caffeine', name: '咖啡因200mg 150片', aliases: ['咖啡因片'], category: 'supplement', unit: '片' }],
    { id: 'new', name: '咖啡因100mg 150片', aliases: ['咖啡因片'], category: 'supplement', unit: '片' }).length, 0);
});

test('verified ordinary-food aliases survive a category mistake without combining different specifications', () => {
  const original = yogurt();
  const candidate = { ...original, id: 'new-yogurt', name: '0%希腊酸奶', category: 'staple', aliases: [] };
  assert.deepEqual(matchExistingProducts([original], candidate), [original]);
  const before = state([original]);
  assert.throws(() => apply(before, 'upsert', { item: candidate }), error => error.code === 'DUPLICATE_PRODUCT');
  assert.equal(before.items[0].quantity, 700);
  assert.equal(before.items.length, 1);
  assert.equal(matchExistingProducts([original], { ...candidate, name: '0%希腊酸奶750g', aliases: ['0%希腊酸奶'] }).length, 0);
  assert.equal(matchExistingProducts([original], { ...candidate, gramsPerUnit: 750, name: '0%希腊酸奶750g', aliases: ['0%希腊酸奶'] }).length, 0);
  for (const category of ['supplement', 'condiment', 'prepared']) {
    assert.deepEqual(matchExistingProducts([original], { ...candidate, category }), []);
  }
  const noAlias = { ...original, aliases: [] };
  assert.deepEqual(matchExistingProducts([noAlias], { ...noAlias, id: 'new', category: 'staple' }), [], 'cross-category generic names need explicit alias evidence');
});

test('prepared meals and recipe batches remain independent even when names match', () => {
  for (const patch of [{ category: 'prepared' }, { nutrition: { ...nutrition, source: 'recipe' } },
    { nutrition: { ...nutrition, nutrientSources: { kcal: 'recipe' } } }]) {
    const old = yogurt(patch);
    assert.equal(isReusableProduct(old), false);
    assert.deepEqual(matchExistingProducts([old], { ...old, id: 'new' }), []);
    const before = state([old]);
    const after = apply(before, 'upsert', { item: { ...old, id: 'new' } });
    assert.equal(after.items.length, 2);
    assert.throws(() => apply(before, 'restock', { itemId: old.id, quantity: 2 }), error => error.code === 'BATCH_REQUIRES_NEW_ITEM');
  }
});

test('new duplicate is rejected atomically and returns the existing product IDs', () => {
  const before = state();
  const backup = structuredClone(before);
  assert.throws(() => apply(before, 'upsert', { item: { ...yogurt(), id: 'new-yogurt', name: '0%希腊酸奶', aliases: [] } }), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'DUPLICATE_PRODUCT');
    assert.deepEqual(error.candidates.map(item => item.id), ['pc-yogurt']);
    return true;
  });
  assert.deepEqual(before, backup);
});

test('aliases are optional for legacy items, validated and persist without altering label or stock baseline', () => {
  const legacy = yogurt(); delete legacy.aliases;
  const before = state([legacy]);
  const after = apply(before, 'upsert', { item: { id: legacy.id, aliases: [' 0%希腊酸奶 ', '0%希腊酸奶', '无脂原味酸奶'] } });
  assert.deepEqual(after.items[0].aliases, ['0%希腊酸奶', '无脂原味酸奶']);
  assert.equal(after.items[0].quantityBaselineToken, legacy.quantityBaselineToken);
  assert.deepEqual(after.items[0].nutrition, legacy.nutrition);
  const restored = apply(after, 'restore', { items: after.items, preferences: [] });
  assert.deepEqual(restored.items[0].aliases, after.items[0].aliases);
  for (const aliases of [null, {}, [''], [4], Array(21).fill('酸奶')]) {
    assert.throws(() => apply(before, 'upsert', { item: { id: legacy.id, aliases } }));
  }
  assert.equal(Object.hasOwn(legacy, 'aliases'), false);
});

test('restock reuses the same catalogue ID and exact current total while retaining original label and history', () => {
  const before = state([yogurt({ quantity: 0, status: 'archived' })]);
  before.plans = [{ id: 'old-plan', title: '旧菜单', date: '2026-10-20', status: 'cancelled', items: [{ itemId: 'pc-yogurt', quantity: 150 }] }];
  const after = apply(before, 'restock', { itemId: 'pc-yogurt', quantity: 1000 });
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].id, 'pc-yogurt');
  assert.equal(after.items[0].quantity, 1000);
  assert.equal(after.items[0].status, 'available');
  assert.deepEqual(after.items[0].nutrition, before.items[0].nutrition);
  assert.deepEqual(after.items[0].aliases, before.items[0].aliases);
  assert.deepEqual(after.plans, before.plans);
  assert.notEqual(after.items[0].quantityBaselineToken, before.items[0].quantityBaselineToken);
  assert.match(after.events.at(-1).detail, /当前总量，不与旧余量累加/);
  const known = apply(state(), 'restock', { itemId: 'pc-yogurt', quantity: 1000 });
  assert.equal(known.items[0].quantity, 1000, 'existing 700g is not added to a reported 1000g total');
});

test('restock supports explicit present-but-uncounted stock, zero and rejects omitted/invalid totals', () => {
  const before = state([yogurt({ quantity: 0, status: 'archived' })]);
  const unknown = apply(before, 'restock', { itemId: 'pc-yogurt', quantity: null });
  assert.equal(unknown.items[0].quantity, null); assert.equal(unknown.items[0].status, 'available');
  const depleted = apply(unknown, 'restock', { itemId: 'pc-yogurt', quantity: 0 });
  assert.equal(depleted.items[0].quantity, 0); assert.equal(depleted.items[0].status, 'depleted');
  for (const quantity of [undefined, -1, Infinity, NaN, '1000']) {
    assert.throws(() => apply(before, 'restock', { itemId: 'pc-yogurt', quantity }));
  }
  assert.throws(() => apply(before, 'restock', { itemId: 'absent', quantity: 1000 }), error => error.code === 'ITEM_NOT_FOUND');
});

test('restocking to the same numeric balance changes the baseline, preventing an old reservation refund', () => {
  let before = state();
  before = legacyFlatPlan(before, { id: 'plan', date: '2026-10-21', title: '酸奶早餐', items: [{ itemId: 'pc-yogurt', quantity: 100 }] }, NOW);
  assert.equal(before.items[0].quantity, 600);
  const after = apply(before, 'restock', { itemId: 'pc-yogurt', quantity: 600 });
  assert.equal(after.items[0].quantity, 600);
  assert.notEqual(after.items[0].quantityBaselineToken, before.items[0].quantityBaselineToken);
  assert.throws(() => apply(after, 'cancel_plan', { planId: 'plan', confirmed: true }), error => error.code === 'REFUND_REQUIRES_REVIEW');
});

test('restock retries remain idempotent under stale revision and conflicting operation content is rejected', () => {
  const before = state();
  const payload = { action: 'restock', itemId: 'pc-yogurt', quantity: 1000, operationId: 'single-restock', expectedRevision: before.revision };
  const after = applyMutation(before, payload, NOW);
  assert.strictEqual(applyMutation(after, payload, LATER), after);
  assert.equal(after.items[0].quantity, 1000);
  assert.throws(() => applyMutation(after, { ...payload, quantity: 2000 }, LATER), error => error.code === 'OPERATION_ID_CONFLICT');
  assert.throws(() => applyMutation(after, { ...payload, operationId: 'new-but-stale' }, LATER), error => error.code === 'REVISION_CONFLICT');
});
