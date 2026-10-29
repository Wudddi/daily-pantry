import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, planningSnapshot, validateItem } from '../lib/inventory.mjs';
import { inventoryViewItems, groupInventoryItems } from '../lib/inventory-organization.mjs';
import { readPlanningInventory } from '../lib/inventory-planning-read.mjs';
import { matchExistingProducts } from '../lib/inventory-product-identity.mjs';
import { legacyFlatPlan } from './fixtures/legacy-flat-plan.mjs';

const NOW = '2026-10-26T12:00:00.000Z';
const label = { basisAmount: 80, basisUnit: 'g', kcal: 40, protein: 0.3, carbs: 10, fat: 0.5,
  source: 'label', sourceText: 'PC Blueberries Cultivated: per 80g, 40 kcal, P0.3g/C10g/F0.5g.' };
const food = (id, category, patch = {}) => validateItem({ id, name: id, category, unit: 'g', quantity: null,
  status: 'available', nutrition: label, ...patch }, NOW);
const state = (items = []) => ({ schemaVersion: 1, revision: 0, updatedAt: NOW,
  items, preferences: [], events: [], operationIds: [], plans: [] });

test('fruit and nuts can be available without an invented stock amount and retain their exact label basis', () => {
  let current = state();
  for (const category of ['fruit', 'nuts']) current = applyMutation(current, {
    action: 'upsert', expectedRevision: current.revision, operationId: `new-${category}`, item: food(category, category),
  }, NOW);
  const snapshot = planningSnapshot(current, NOW);
  for (const category of ['fruit', 'nuts']) {
    const saved = snapshot.availableItems.find(item => item.id === category);
    assert.equal(saved.category, category);
    assert.equal(saved.quantity, null);
    assert.equal(saved.status, 'available');
    assert.equal(saved.remainingNutrition, null);
    assert.equal(saved.nutrition.basisAmount, 80);
    assert.equal(saved.nutrition.protein, 0.3);
    assert.equal(saved.nutrition.sourceText, label.sourceText);
  }
});

test('correcting an existing category preserves its stock baseline, nutrition, original ID and historical accounting', () => {
  const original = food('banana', 'other', { quantity: 500, notes: '原备注', ingredients: '香蕉', quantityBaselineToken: 'prior-stock' });
  const before = legacyFlatPlan(state([original]), { id: 'historical-plan', title: '既有历史菜单', date: '2026-10-20',
    items: [{ itemId: original.id, quantity: 100 }] }, '2026-10-20T12:00:00.000Z');
  const originalState = structuredClone(before);
  const payload = { action: 'upsert', expectedRevision: before.revision, operationId: 'classify-banana',
    item: { id: original.id, category: 'fruit' } };
  const after = applyMutation(before, payload, NOW);
  const saved = after.items[0];
  assert.equal(after.items.length, 1);
  assert.equal(saved.id, original.id);
  assert.equal(saved.category, 'fruit');
  for (const field of ['quantity', 'unit', 'status', 'confirmedAt', 'quantityBaselineToken', 'notes', 'ingredients']) {
    assert.deepEqual(saved[field], before.items[0][field], field);
  }
  assert.equal(saved.quantity, 400);
  assert.deepEqual(saved.nutrition, before.items[0].nutrition);
  assert.deepEqual(after.plans, before.plans);
  assert.match(after.events.at(-1).detail, /未重新盘点余量/);
  assert.strictEqual(applyMutation(after, payload, NOW), after, 'retry must not create another event or stock change');
  assert.deepEqual(before, originalState);
});

test('fruit and nuts have separate stable food groups and filters without exposing depleted stock', () => {
  const items = [food('walnuts', 'nuts'), food('misc', 'other'), food('banana', 'fruit'), food('berries', 'fruit'),
    food('vegetables', 'vegetable'), food('old-berries', 'fruit', { quantity: 0, status: 'depleted' }),
    food('oil', 'condiment'), food('supplement', 'supplement')];
  const before = structuredClone(items);
  assert.deepEqual(groupInventoryItems(inventoryViewItems(items)).map(group => [group.category, group.items.map(item => item.id)]), [
    ['vegetable', ['vegetables']], ['fruit', ['banana', 'berries']], ['nuts', ['walnuts']], ['other', ['misc']],
  ]);
  assert.deepEqual(inventoryViewItems(items, { category: 'fruit' }).map(item => item.id), ['banana', 'berries']);
  assert.deepEqual(inventoryViewItems(items, { category: 'nuts' }).map(item => item.id), ['walnuts']);
  assert.deepEqual(inventoryViewItems(items, { scope: 'archive', category: 'fruit' }).map(item => item.id), ['old-berries']);
  assert.deepEqual(items, before);
});

test('planning pagination covers every available fruit and nut with unknown amounts without mutating stock', () => {
  const before = state([food('berries', 'fruit'), food('banana', 'fruit'), food('almonds', 'nuts'), food('other', 'other'),
    food('finished', 'fruit', { status: 'depleted', quantity: 0 }), food('calcium', 'supplement')]);
  const original = structuredClone(before);
  const first = readPlanningInventory(before, { limit: 2 }, NOW);
  assert.equal(first.candidateCoverage.availableFoodCategoryTotals.fruit, 2);
  assert.equal(first.candidateCoverage.availableFoodCategoryTotals.nuts, 1);
  assert.equal(first.candidateCoverage.availableRoleTotals.food, 4);
  const all = [...first.items];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const page = readPlanningInventory(before, { limit: 2, cursor, expectedRevision: first.revision }, NOW);
    all.push(...page.items); cursor = page.nextCursor;
  }
  assert.deepEqual(new Set(all.map(item => item.id)), new Set(before.items.map(item => item.id)));
  for (const id of ['berries', 'banana', 'almonds']) {
    assert.equal(all.find(item => item.id === id).quantity, null);
    assert.equal(all.find(item => item.id === id).status, 'available');
  }
  assert.deepEqual(before, original);
});

test('verified aliases still find old ordinary-food categories after reclassification without mixing brands or prepared batches', () => {
  for (const category of ['fruit', 'nuts']) {
    const original = food(`${category}-existing`, 'other', { brand: 'PC', name: `PC ${category}`, aliases: [`常备${category}`] });
    const candidate = food(`${category}-new`, category, { name: `常备${category}`, brand: 'PC' });
    assert.deepEqual(matchExistingProducts([original], candidate), [original]);
    assert.throws(() => applyMutation(state([original]), { action: 'upsert', expectedRevision: 0,
      operationId: `duplicate-${category}`, item: candidate }, NOW), error => error.code === 'DUPLICATE_PRODUCT');
    assert.deepEqual(matchExistingProducts([original], { ...candidate, brand: 'Different' }), []);
    assert.deepEqual(matchExistingProducts([original], { ...candidate, category: 'prepared' }), []);
  }
});

test('backup restoration accepts the added categories and preserves unknown quantities and original nutrition', () => {
  const items = [food('berries', 'fruit'), food('nuts', 'nuts')];
  const restored = applyMutation(state(), { action: 'restore', expectedRevision: 0, operationId: 'restore-categories',
    items, preferences: [] }, NOW);
  assert.deepEqual(restored.items.map(item => item.category), ['fruit', 'nuts']);
  assert.deepEqual(restored.items.map(item => item.quantity), [null, null]);
  assert.deepEqual(restored.items.map(item => item.nutrition), items.map(item => item.nutrition));
});
