import test from 'node:test';
import assert from 'node:assert/strict';
import { foodPreferencesContext, foodPreferenceMutationReceipt, preferenceWorkflowInstructions } from '../lib/food-preferences-context.mjs';
import { applyMutation } from '../lib/inventory.mjs';

const AT = '2026-10-26T14:00:00.000Z';
// All preferences and human quotes in this fixture are fictional examples.
const original = () => ({ schemaVersion: 1, revision: 12, updatedAt: AT, items: [], plans: [], events: [], operationIds: [], preferences: ['演示菜单优先使用示例食材A。'] });
function change(state, id, preferences) {
  return applyMutation(state, { action: 'preferences', operationId: id, expectedRevision: state.revision,
    preferences, sourceDate: '2026-10-26', reason: '用户明确长期要求' }, AT);
}

test('legacy preferences stay complete and detached without inventing a modification time', () => {
  const state = original(), before = structuredClone(state), context = foodPreferencesContext(state);
  assert.deepEqual(context.preferences, state.preferences);
  assert.equal(context.preferencesComplete, true);
  assert.equal(context.preferencesCount, 1);
  assert.equal(context.preferencesRevision, 12);
  assert.equal(context.preferencesLastChangedAt, null);
  assert.equal(context.preferencesLastChangedRevision, null);
  assert.equal(context.preferenceWorkflow, preferenceWorkflowInstructions);
  assert.match(context.preferenceWorkflow, /patch_food_preferences/);
  assert.match(context.preferenceWorkflow, /逐条比较/);
  context.preferences.push('只改调用方响应');
  assert.deepEqual(state, before);
});

test('history metadata describes the last preference change rather than the last inventory edit', () => {
  const state = change(original(), 'persist-habit', ['演示菜单优先使用示例食材A。', '示例午餐包含一份示例蔬菜。']);
  state.revision += 5;
  const before = structuredClone(state), context = foodPreferencesContext(state);
  assert.equal(context.preferencesRevision, 18);
  assert.equal(context.preferencesLastChangedRevision, 13);
  assert.equal(context.preferencesLastChangedAt, AT);
  assert.deepEqual(state, before);
});

test('mutation receipt resolves an original operation after later changes and never exposes mutable history', () => {
  const once = change(original(), 'first-change', ['演示菜单优先使用示例食材A。', '示例午餐包含一份示例蔬菜。']);
  const latest = change(once, 'second-change', ['演示菜单优先使用示例食材A。', '示例午餐包含一份示例蔬菜。', '示例晚餐不额外增加示例加餐。']);
  const before = structuredClone(latest), receipt = foodPreferenceMutationReceipt(latest, 'first-change');
  assert.equal(receipt.operation, 'preferences_saved_or_already_current');
  assert.equal(receipt.operationFound, true);
  assert.equal(receipt.preferenceChangeApplied, true);
  assert.equal(receipt.noChange, false);
  assert.equal(receipt.inventoryEffect, 'none');
  assert.equal(receipt.preferenceChange.revisionAfter, 13);
  assert.equal(receipt.preferenceChange.sourceDate, '2026-10-26');
  assert.equal(receipt.preferenceChange.reason, '用户明确长期要求');
  assert.deepEqual(receipt.preferences, latest.preferences, 'a replay receipt still returns the current full habit collection');
  assert.deepEqual(receipt.preferenceChange.next, once.preferences, 'the historical operation describes its own persisted change');
  receipt.preferenceChange.previous.push('caller only'); receipt.preferenceChange.next[0] = 'caller only'; receipt.preferences.length = 0;
  assert.deepEqual(latest, before);
});

test('a no-op duplicate habit has no historical write and no stock effect', () => {
  const before = original(), after = change(before, 'duplicate-habit', before.preferences);
  assert.strictEqual(after, before);
  const receipt = foodPreferenceMutationReceipt(after, 'duplicate-habit');
  assert.equal(receipt.operationFound, false);
  assert.equal(receipt.preferenceChangeApplied, false);
  assert.equal(receipt.noChange, true);
  assert.equal(receipt.preferenceChange, null);
  assert.equal(receipt.inventoryEffect, 'none');
  assert.equal(foodPreferenceMutationReceipt(after).operationId, null);
});

test('durable no-op operation is found without inventing a preference change or modification date', () => {
  const sourceText = '合成示例：以后菜单优先使用示例食材A。';
  const state = applyMutation(original(), { action: 'patch_preferences', operationId: 'current-already', expectedRevision: 12,
    confirmed: true, add: original().preferences, sourceDate: '2026-10-26', sourceText, reason: '现有规则已覆盖' }, AT);
  const before = structuredClone(state), receipt = foodPreferenceMutationReceipt(state, 'current-already');
  assert.equal(receipt.operationFound, true);
  assert.equal(receipt.preferenceChangeApplied, false);
  assert.equal(receipt.noChange, true);
  assert.equal(receipt.preferenceChange, null);
  assert.equal(receipt.preferencesLastChangedAt, null);
  assert.equal(receipt.preferencesLastChangedRevision, null);
  assert.equal(receipt.preferenceOperation.sourceText, sourceText);
  assert.equal(receipt.preferenceOperation.noChange, true);
  assert.equal(receipt.inventoryEffect, 'none');
  receipt.preferenceOperation.reason = 'caller only';
  assert.deepEqual(state, before);
});

test('the incremental mutation receipt includes the human quote behind the durable change', () => {
  const sourceText = '合成示例：以后每份示例午餐都附带示例蔬菜，明确另选时例外。';
  const state = applyMutation(original(), { action: 'patch_preferences', operationId: 'human-rule', expectedRevision: 12,
    confirmed: true, add: ['示例午餐附带示例蔬菜，明确另选时例外。'], sourceDate: '2026-10-26', sourceText }, AT);
  const receipt = foodPreferenceMutationReceipt(state, 'human-rule');
  assert.equal(receipt.operationFound, true);
  assert.equal(receipt.preferenceChange.sourceText, sourceText);
  assert.equal(receipt.preferenceOperation.sourceText, sourceText);
  assert.deepEqual(receipt.preferences, ['演示菜单优先使用示例食材A。', '示例午餐附带示例蔬菜，明确另选时例外。']);
});

test('all sixty maximum-length strings survive escaping and unreadable collections fail explicitly', () => {
  const state = original();
  state.preferences = Array.from({ length: 60 }, (_, index) => `${index}:"${'\u0000'.repeat(490)}`.padEnd(500, '字'));
  const before = structuredClone(state), context = foodPreferencesContext(state);
  assert.equal(context.preferencesCount, 60);
  assert.deepEqual(context.preferences, state.preferences);
  assert.ok(JSON.stringify(context).length > 96000);
  assert.deepEqual(state, before);
  for (const preferences of [null, 'old', [undefined], [''], Array(61).fill('规则'), ['a'.repeat(501)]]) {
    assert.throws(() => foodPreferencesContext({ ...original(), preferences }), error => error.status === 503 && error.code === 'PREFERENCES_UNAVAILABLE');
  }
  assert.throws(() => foodPreferenceMutationReceipt(original(), ''), error => error.status === 400);
});
