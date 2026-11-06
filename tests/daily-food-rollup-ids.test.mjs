import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyFoodRollup, dailyFoodRollupPage } from '../lib/daily-food-rollup.mjs';

const line = (id, itemId, unit = 'g') => ({ id, itemId, name: `Long descriptive food name for ${itemId}`, quantity: 25, unit,
  nutritionSnapshot: { name: itemId, unit, gramsPerUnit: null,
    nutrition: { basisAmount: 100, basisUnit: unit, kcal: 100, protein: 10, carbs: 12, fat: 2, source: 'label' } } });
const meal = (id, plannedItems) => ({ id, slot: id, title: id, state: 'reserved', plannedItems, actualEntries: [] });
const plan = meals => ({ id: 'stable-day', date: '2026-11-06', format: 'meals_v1', title: 'Daily menu',
  status: 'draft', meals, supplementDoses: [] });
const identities = summary => new Map(summary.rows.map(row => [JSON.stringify([row.itemId, row.unit]), row.id]));

test('compact read-only row IDs stay stable across meal order, food order and transport pages without changing records', () => {
  const source = plan([meal('lunch', [line('a', 'inventory-product-with-a-long-stable-id-a'), line('b', 'inventory-product-with-a-long-stable-id-b')]),
    meal('dinner', [line('c', 'inventory-product-with-a-long-stable-id-c'), line('a2', 'inventory-product-with-a-long-stable-id-a')])]);
  const before = structuredClone(source), rich = dailyFoodRollup(source);
  const reordered = structuredClone(source); reordered.meals.reverse(); reordered.meals.forEach(value => value.plannedItems.reverse());
  assert.deepEqual(identities(dailyFoodRollup(reordered)), identities(rich));
  const recovered = [];
  let cursor = '0';
  do { const page = dailyFoodRollupPage(rich, { cursor, limit: 1 }); recovered.push(...page.rows); cursor = page.nextCursor; } while (cursor !== null);
  assert.deepEqual(identities({ rows: recovered }), identities(rich));
  assert.ok(rich.rows.every(row => row.id.length < 40));
  assert.deepEqual(source, before);
});

test('unlike units and untracked nutrition bases keep distinct stable IDs despite identical names', () => {
  const first = line('a', 'same-product', 'g'), second = line('b', 'same-product', 'ml');
  const externalA = { ...line('c', null), name: 'Same external food' };
  const externalB = structuredClone(externalA); externalB.id = 'd'; externalB.nutritionSnapshot.nutrition.kcal = 200;
  const source = plan([meal('lunch', [first, second, externalA, externalB])]), before = structuredClone(source);
  const summary = dailyFoodRollup(source);
  assert.equal(summary.rows.length, 4);
  assert.equal(new Set(summary.rows.map(row => row.id)).size, 4);
  assert.deepEqual(summary.rows.filter(row => row.itemId === 'same-product').map(row => row.unit).sort(), ['g', 'mL']);
  assert.deepEqual(source, before);
});
