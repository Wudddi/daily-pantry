import test from 'node:test';
import assert from 'node:assert/strict';
import { readDietRecords } from '../lib/diet.mjs';

test('legacy reservation IDs in compact inventory can be read losslessly without becoming actual intake', () => {
  const original = { id: 'flat-menu', date: '2026-10-19', title: '旧菜单', status: 'reserved', notes: '预留，不代表已吃', items: [{ itemId: 'beef', quantity: 1, unit: '袋', name: '卤牛肉', unknownQuantity: false }] };
  const state = { revision: 8, items: [], plans: [original], dietHistory: [] };
  const before = structuredClone(state);
  const list = readDietRecords(state, { planId: original.id });
  assert.deepEqual(list.records, [original]);
  assert.deepEqual(list.dailyNutritionSummaries, []);
  const detail = readDietRecords(state, { recordId: original.id });
  assert.deepEqual(JSON.parse(detail.text), original);
  assert.deepEqual(state, before);
});
