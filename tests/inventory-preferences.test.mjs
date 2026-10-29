import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-21T14:00:00.000Z';
const NEXT = '2026-10-21T15:00:00.000Z';
function fixture(preferences = ['旧习惯甲', '旧习惯乙']) {
  return { schemaVersion: 1, revision: 0, updatedAt: '2026-10-17', preferences, events: [], operationIds: [],
    items: [validateItem({ id: 'test-food', name: '测试食材', category: 'vegetable', unit: 'g', quantity: 20 }, NOW)],
    plans: [{ id: 'prior-plan', title: '保留的旧菜单', date: '2026-10-20', status: 'cancelled', items: [], notes: '旧计划原话' }],
    dietHistory: [{ id: 'prior-history', date: '2026-10-20', sourceText: '旧饮食全文' }],
    supplementRoutine: { supplementDoses: [{ id: 'dose', instruction: '原补给安排' }] },
  };
}
function apply(state, action, fields, operationId = action + '-' + state.revision) {
  return applyMutation(state, { action, ...fields, operationId, expectedRevision: state.revision }, NOW);
}
function patch(state, fields, operationId = 'patch-' + state.revision) {
  return apply(state, 'patch_preferences', { confirmed: true, sourceText: '以后长期按这些习惯排餐；今天这顿的临时改动不算长期规则。', sourceDate: '2026-10-21', ...fields }, operationId);
}

test('a legacy update archives complete original wording, order and duplicates plus new wording with explicit metadata', () => {
  const original = fixture(['  旧原话\n不要裁切  ', '重复的旧条目', '重复的旧条目']), before = structuredClone(original);
  const after = apply(original, 'preferences', { preferences: [' 合并后的习惯 ', '保留的第二条'], reason: '整理重复内容\n保留具体条件', sourceDate: '2026-10-21' }, 'merge-legacy');
  assert.equal(after.revision, 1);
  assert.deepEqual(after.preferences, ['合并后的习惯', '保留的第二条']);
  assert.deepEqual(after.preferenceHistory[0].previous, original.preferences);
  assert.deepEqual(after.preferenceHistory[0].next, after.preferences);
  assert.deepEqual(Object.fromEntries(['operationId', 'at', 'action', 'reason', 'sourceDate', 'revisionBefore', 'revisionAfter'].map(key => [key, after.preferenceHistory[0][key]])), {
    operationId: 'merge-legacy', at: NOW, action: 'preferences', reason: '整理重复内容\n保留具体条件', sourceDate: '2026-10-21', revisionBefore: 0, revisionAfter: 1,
  });
  assert.notStrictEqual(after.preferenceHistory[0].previous, original.preferences);
  assert.notStrictEqual(after.preferenceHistory[0].next, after.preferences);
  for (const key of ['items', 'plans', 'dietHistory', 'supplementRoutine']) assert.deepEqual(after[key], original[key], key);
  assert.deepEqual(original, before);
});

test('identical normalized preferences are a true no-op and do not manufacture a historical version or guessed source date', () => {
  const original = fixture(['惯例']);
  assert.strictEqual(apply(original, 'preferences', { preferences: [' 惯例 ', '惯例'], reason: '仅重复保存' }), original);
  assert.equal(original.preferenceHistory, undefined);
  const changed = apply(original, 'preferences', { preferences: ['新惯例'] });
  assert.equal(changed.preferenceHistory[0].sourceDate, null);
  assert.equal(changed.preferenceHistory[0].reason, '');
  assert.strictEqual(apply(changed, 'preferences', { preferences: ['新惯例'] }), changed);
  assert.equal(changed.preferenceHistory.length, 1);
});

test('an incremental habit patch preserves untouched wording, order, historical evidence and every non-preference record', () => {
  const original = fixture(['  原话含空格\n保持原样  ', '待替换的旧条件', '重复但本次不改', '重复但本次不改', '待移除的旧条件']);
  original.healthRecords = [{ id: 'weigh-in', weight: 73.5 }];
  const before = structuredClone(original), quote = '  以后把旧条件改成新条件。\n长期加上新习惯，并去掉旧条件。  ';
  const after = patch(original, { add: [' 新增长期习惯 ', '新增长期习惯'], replace: [{ previous: '待替换的旧条件', next: '替换后的明确条件' }], remove: ['待移除的旧条件'], reason: '用户明确的长期修改', sourceText: quote }, 'incremental-habits');
  assert.deepEqual(after.preferences, ['  原话含空格\n保持原样  ', '替换后的明确条件', '重复但本次不改', '重复但本次不改', '新增长期习惯']);
  assert.equal(after.revision, 1);
  assert.equal(after.preferenceHistory.length, 1);
  assert.deepEqual(after.preferenceHistory[0].previous, original.preferences);
  assert.deepEqual(after.preferenceHistory[0].next, after.preferences);
  assert.equal(after.preferenceHistory[0].sourceText, quote, 'the user quote is preserved without trimming');
  assert.equal(after.preferenceHistory[0].sourceDate, '2026-10-21');
  assert.equal(after.preferenceHistory[0].reason, '用户明确的长期修改');
  assert.equal(after.preferenceHistory[0].action, 'preferences', 'old history readers remain compatible');
  assert.equal(after.events[0].action, 'preferences');
  for (const key of ['items', 'plans', 'dietHistory', 'supplementRoutine', 'healthRecords']) assert.deepEqual(after[key], original[key], key);
  assert.deepEqual(original, before);
  const later = patch(after, { add: ['另一条明确长期习惯'] });
  assert.deepEqual(later.preferenceHistory[0], after.preferenceHistory[0], 'a later update cannot rewrite the previous evidence');
});

test('duplicate additions and identical replacements persist operation receipts without extra habit versions', () => {
  const original = fixture(['惯例', '别的惯例']);
  for (const fields of [{ add: ['惯例', ' 惯例 ', '惯例'] }, { replace: [{ previous: '惯例', next: '惯例' }] }]) {
    const noChange = patch(original, fields);
    assert.deepEqual(noChange.preferences, original.preferences);
    assert.equal(noChange.revision, 1, 'only durable operation receipt persistence advances the state version');
    assert.equal(noChange.preferenceHistory, undefined, 'no fake habit version');
    assert.equal(noChange.preferenceOperationReceipts.length, 1);
    assert.deepEqual(Object.fromEntries(['action', 'noChange', 'revisionBefore', 'revisionAfter'].map(key => [key, noChange.preferenceOperationReceipts[0][key]])), {
      action: 'patch_preferences', noChange: true, revisionBefore: 0, revisionAfter: 1,
    });
    for (const key of ['items', 'plans', 'dietHistory', 'supplementRoutine', 'events']) assert.deepEqual(noChange[key], original[key], key);
  }
  assert.equal(original.preferenceHistory, undefined);
  assert.equal(original.preferenceOperationReceipts, undefined);
  const added = patch(original, { add: ['新惯例', '新惯例', '惯例'] });
  assert.deepEqual(added.preferences, ['惯例', '别的惯例', '新惯例']);
  assert.equal(added.preferenceHistory.length, 1);
});

test('a duplicate-add retry never resurrects a subsequently removed habit, even after ledger eviction', () => {
  const original = fixture(['保留习惯', '后来会移除的习惯']);
  const payload = { action: 'patch_preferences', operationId: 'duplicate-add', expectedRevision: 0, confirmed: true, sourceText: '以后沿用这条习惯。', sourceDate: '2026-10-21', add: ['后来会移除的习惯'] };
  let state = applyMutation(original, payload, NOW);
  const receipt = structuredClone(state.preferenceOperationReceipts[0]);
  assert.equal(state.preferenceHistory, undefined);
  state = patch(state, { remove: ['后来会移除的习惯'], add: ['新习惯'] }, 'later-removal');
  for (let index = 0; index < 1001; index++) state = apply(state, 'set_quantity', { id: 'test-food', quantity: 20 + index % 2 });
  assert.equal(state.operationIds.some(operation => operation.id === payload.operationId), false);
  const before = structuredClone(state);
  assert.strictEqual(applyMutation(state, payload, NEXT), state);
  assert.strictEqual(applyMutation(state, { ...payload, expectedRevision: state.revision }, NEXT), state);
  assert.throws(() => applyMutation(state, { ...payload, add: ['同ID不同内容'], expectedRevision: state.revision }, NEXT), error => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  assert.deepEqual(state.preferences, ['保留习惯', '新习惯']);
  assert.deepEqual(state.preferenceOperationReceipts, [receipt]);
  assert.deepEqual(state, before);
});

test('identical replacement retries never undo later replacements and legacy no-op behavior stays unchanged', () => {
  const original = fixture(['旧条件']);
  const payload = { action: 'patch_preferences', operationId: 'identical-replacement', expectedRevision: 0, confirmed: true, sourceText: '以后沿用旧条件。', sourceDate: '2026-10-21', replace: [{ previous: '旧条件', next: '旧条件' }] };
  let state = applyMutation(original, payload, NOW);
  state = patch(state, { replace: [{ previous: '旧条件', next: '用户更正的新条件' }] }, 'later-replacement');
  assert.strictEqual(applyMutation(state, payload, NEXT), state);
  assert.deepEqual(state.preferences, ['用户更正的新条件']);
  assert.equal(state.preferenceHistory.length, 1);
  assert.equal(state.preferenceHistory[0].revisionBefore, 1);
  const legacy = apply(state, 'preferences', { preferences: state.preferences });
  assert.strictEqual(legacy, state, 'legacy full-list no-op retains original semantics');
});

test('malformed durable preference receipts reject without losing evidence', () => {
  const saved = patch(fixture(), { add: ['旧习惯甲'] });
  for (const corrupt of [
    state => { state.preferenceOperationReceipts = {}; },
    state => { state.preferenceOperationReceipts[0].sourceDate = '2026-02-30'; },
    state => { state.preferenceOperationReceipts[0].noChange = false; },
    state => { state.preferenceOperationReceipts[0].revisionAfter = 50; },
    state => { state.preferenceOperationReceipts.push(structuredClone(state.preferenceOperationReceipts[0])); },
  ]) {
    const state = structuredClone(saved); corrupt(state); const before = structuredClone(state);
    assert.throws(() => patch(state, { add: ['不能吞掉坏回执'] }), error => error.status === 503 && error.code === 'INVALID_PREFERENCE_OPERATION_RECEIPTS');
    assert.deepEqual(state, before);
  }
});

test('replace and remove require exact, unique original matches and conflict atomically', () => {
  const original = fixture(['  原始旧条件  ', '另一个条件', '旧重复', '旧重复']), before = structuredClone(original);
  for (const fields of [
    { replace: [{ previous: '原始旧条件', next: '不允许模糊替换' }] },
    { remove: ['不存在的条件'] },
    { remove: ['旧重复'] },
    { remove: ['另一个条件'], replace: [{ previous: '另一个条件', next: '两次操作同一目标' }] },
    { replace: [{ previous: '另一个条件', next: '第一个新条件' }, { previous: '另一个条件', next: '第二个新条件' }] },
    { replace: [{ previous: '  原始旧条件  ', next: '另一个条件' }] },
    { replace: [{ previous: '另一个条件', next: '新条件' }, { previous: '新条件', next: '不能指向本次生成的条件' }] },
  ]) {
    assert.throws(() => patch(original, { add: ['失败时也不能新增'], ...fields }), error => error.status === 409 && error.code === 'PREFERENCE_MATCH_CONFLICT');
    assert.deepEqual(original, before);
  }
  const changed = patch(original, { replace: [{ previous: '  原始旧条件  ', next: '已核实的新条件' }] });
  assert.deepEqual(changed.preferences, ['已核实的新条件', '另一个条件', '旧重复', '旧重复']);
});

test('incremental persistence requires explicit user evidence and validates its narrow contract', () => {
  const original = fixture(), before = structuredClone(original);
  for (const fields of [
    { confirmed: false }, { confirmed: 'true' }, { confirmed: undefined },
    { sourceText: undefined }, { sourceText: '' }, { sourceText: ' \n ' }, { sourceText: 42 }, { sourceText: '字'.repeat(1001) },
    { sourceDate: undefined }, { sourceDate: null }, { sourceDate: '2026-02-30' }, { sourceDate: NOW },
    { add: null }, { add: [42] }, { add: ['字'.repeat(501)] }, { add: Array(61).fill('新条件') },
    { replace: [{ previous: '旧习惯甲', next: '' }] }, { replace: [{ previous: '旧习惯甲', next: '新条件', extra: true }] },
    { remove: [42] }, { reason: '字'.repeat(1001) }, { preferences: [] }, { preferenceHistory: [] }, { items: [] },
  ]) {
    assert.throws(() => patch(original, { add: ['明确新习惯'], ...fields }), error => error.status === 400);
    assert.deepEqual(original, before);
  }
  assert.throws(() => patch(original, {}), error => error.status === 400);
  const saved = patch(original, { add: ['明确新习惯'], sourceText: '字'.repeat(1000) });
  assert.equal(saved.preferenceHistory[0].sourceText.length, 1000);
  const full = fixture(Array.from({ length: 60 }, (_, index) => '已有条件' + index));
  assert.throws(() => patch(full, { add: ['第61条'] }), error => error.status === 400);
  assert.equal(full.preferences.length, 60);
});

test('patch retries use the original payload even after other writes and short ledger eviction', () => {
  const original = fixture();
  const payload = { action: 'patch_preferences', operationId: 'original-patch', expectedRevision: 0, confirmed: true, sourceText: '以后早餐保留我指定的食物。', sourceDate: '2026-10-21', add: ['早餐保留指定食物'], replace: [{ previous: '旧习惯甲', next: '已明确替换的甲条件' }] };
  let state = applyMutation(original, payload, NOW);
  state = patch(state, { add: ['后来新增的习惯'] });
  for (let index = 0; index < 1001; index++) state = apply(state, 'set_quantity', { id: 'test-food', quantity: 20 + index % 2 });
  assert.equal(state.operationIds.some(operation => operation.id === payload.operationId), false);
  const before = structuredClone(state);
  assert.strictEqual(applyMutation(state, payload, NEXT), state);
  assert.strictEqual(applyMutation(state, { ...payload, expectedRevision: state.revision }, NEXT), state);
  assert.throws(() => applyMutation(state, { ...payload, add: ['同一操作ID换了内容'], expectedRevision: state.revision }, NEXT), error => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  assert.throws(() => applyMutation(state, { ...payload, operationId: 'new-stale-patch' }, NEXT), error => error.status === 409 && error.code === 'REVISION_CONFLICT');
  assert.deepEqual(state, before);
});

test('every old habit version survives both the event cap and short idempotency ledger eviction', () => {
  let state = fixture();
  const firstPayload = { action: 'preferences', operationId: 'first-change', expectedRevision: 0, preferences: ['版本 0'], reason: '第一版' };
  state = applyMutation(state, firstPayload, NOW);
  for (let index = 1; index < 105; index++) state = apply(state, 'preferences', { preferences: ['版本 ' + index] });
  assert.equal(state.events.length, 100);
  assert.equal(state.preferenceHistory.length, 105);
  const completeHistory = structuredClone(state.preferenceHistory), current = state.preferences.slice();
  for (let index = 0; index < 1001; index++) state = apply(state, 'set_quantity', { id: 'test-food', quantity: 20 + index % 2 });
  assert.equal(state.operationIds.length, 1000);
  assert.equal(state.operationIds.some(operation => operation.id === 'first-change'), false);
  assert.deepEqual(state.preferenceHistory, completeHistory);
  assert.strictEqual(applyMutation(state, firstPayload, NEXT), state);
  assert.strictEqual(applyMutation(state, { ...firstPayload, expectedRevision: state.revision }, NEXT), state);
  assert.deepEqual(state.preferences, current, 'a replay must not restore an old preference version');
  assert.throws(() => applyMutation(state, { ...firstPayload, preferences: ['更改重放内容'], expectedRevision: state.revision }, NEXT), error => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  assert.throws(() => applyMutation(state, { action: 'set_quantity', id: 'test-food', quantity: 9, operationId: 'first-change', expectedRevision: state.revision }, NEXT), error => error.code === 'OPERATION_ID_CONFLICT');
});

test('stale preference writes fail before changing habits or appending any history', () => {
  const state = apply(fixture(), 'preferences', { preferences: ['已保存的新版本'] }), before = structuredClone(state);
  assert.throws(() => applyMutation(state, { action: 'preferences', operationId: 'stale-new-operation', expectedRevision: 0, preferences: ['陈旧覆盖'] }, NEXT), error => error.status === 409 && error.code === 'REVISION_CONFLICT');
  assert.deepEqual(state, before);
});

test('restore preserves local preference history and appends the complete replacement without accepting external history', () => {
  const original = fixture(); original.plans = [];
  const changed = apply(original, 'preferences', { preferences: ['本地最新习惯'] });
  const oldHistory = structuredClone(changed.preferenceHistory);
  const restored = apply(changed, 'restore', { items: changed.items, preferences: ['来自备份的习惯'], reason: '明确从备份更换当前习惯' });
  assert.equal(restored.preferenceHistory.length, 2);
  assert.deepEqual(restored.preferenceHistory[0], oldHistory[0]);
  assert.equal(restored.preferenceHistory[1].action, 'restore');
  assert.deepEqual(restored.preferenceHistory[1].previous, ['本地最新习惯']);
  assert.deepEqual(restored.preferenceHistory[1].next, ['来自备份的习惯']);
  const unchanged = apply(restored, 'restore', { items: restored.items, preferences: restored.preferences });
  assert.deepEqual(unchanged.preferenceHistory, restored.preferenceHistory, 'a stock restore with no preference change creates no preference version');
  assert.throws(() => apply(restored, 'restore', { items: restored.items, preferences: [], preferenceHistory: [] }), /不能由请求覆盖/);
});

test('metadata is narrowly validated and a rejected request never alters the old state', () => {
  const original = fixture(), before = structuredClone(original);
  for (const extra of [{ reason: '字'.repeat(1001) }, { reason: 42 }, { sourceDate: '2026-02-30' }, { sourceDate: '2026-10-21T00:00:00Z' }, { sourceDate: 123 }, { sourceNote: '不支持的字段' }, { at: NOW }, { preferenceHistory: [] }, { previous: [] }]) {
    assert.throws(() => apply(original, 'preferences', { preferences: ['新习惯'], ...extra }), error => error.status === 400);
  }
  assert.deepEqual(original, before);
  assert.equal(apply(original, 'preferences', { preferences: ['新习惯'], reason: '字'.repeat(1000), sourceDate: null }).preferenceHistory[0].reason.length, 1000);
});

test('malformed or disconnected history is rejected and never silently discarded or repaired', () => {
  const saved = apply(fixture(), 'preferences', { preferences: ['新习惯'] });
  for (const corrupt of [
    state => { state.preferenceHistory = {}; },
    state => { state.preferenceHistory[0].next = ['与当前不一致']; },
    state => { state.preferenceHistory[0].revisionAfter = 10; },
    state => { state.preferenceHistory[0].sourceDate = '2026-02-30'; },
    state => { state.preferenceHistory.push(structuredClone(state.preferenceHistory[0])); },
    state => { state.preferences = ['绕过历史的改写']; },
  ]) {
    const state = structuredClone(saved); corrupt(state); const before = structuredClone(state);
    assert.throws(() => apply(state, 'preferences', { preferences: ['不能覆盖损坏的历史'] }), error => error.status === 503 && error.code === 'INVALID_PREFERENCE_HISTORY');
    assert.deepEqual(state, before);
  }
});

test('clearing all current preferences is versioned without deleting previous versions', () => {
  const original = fixture(), cleared = apply(original, 'preferences', { preferences: [], reason: '用户明确清空当前规则' });
  assert.deepEqual(cleared.preferences, []);
  assert.deepEqual(cleared.preferenceHistory[0].previous, original.preferences);
  assert.deepEqual(cleared.preferenceHistory[0].next, []);
  const next = apply(cleared, 'preferences', { preferences: ['重新建立的规则'] });
  assert.deepEqual(next.preferenceHistory[1].previous, []);
  assert.equal(next.preferenceHistory.length, 2);
});

test('updating preferences with 100 recent events archives the full displaced event and retains every old archive entry', () => {
  const state = fixture();
  state.events = Array.from({ length: 100 }, (_, index) => ({ id: 'old-' + index, at: NOW, action: 'upsert', detail: '原更新全文 ' + index, previous: { name: '旧食材原文', notes: '完整嵌套证据' } }));
  state.eventHistory = Array.from({ length: 125 }, (_, index) => ({ id: 'archived-' + index, at: NOW, detail: '更早的完整更新 ' + index }));
  const before = structuredClone(state), changed = apply(state, 'preferences', { preferences: ['合并后的习惯'] }, 'merge-with-full-events');
  assert.equal(changed.events.length, 100);
  assert.equal(changed.events[0].id, 'old-1');
  assert.equal(changed.events.at(-1).id, 'merge-with-full-events');
  assert.equal(changed.eventHistory.length, 126);
  assert.deepEqual(changed.eventHistory.slice(0, 125), state.eventHistory);
  assert.deepEqual(changed.eventHistory.at(-1), state.events[0]);
  assert.notStrictEqual(changed.eventHistory.at(-1), state.events[0]);
  assert.equal(changed.eventHistory.at(-1).previous.notes, '完整嵌套证据');
  assert.deepEqual(state, before);
});

test('restoring stock preserves the local event archive and retries never append displaced events twice', () => {
  const state = fixture(); state.events = Array.from({ length: 100 }, (_, index) => ({ id: 'old-' + index, at: NOW, detail: '旧事件 ' + index }));
  const payload = { action: 'preferences', operationId: 'once-only', expectedRevision: 0, preferences: ['新习惯'] };
  const changed = applyMutation(state, payload, NOW);
  assert.equal(changed.eventHistory.length, 1);
  const restored = apply(changed, 'restore', { items: changed.items, preferences: changed.preferences });
  assert.equal(restored.eventHistory.length, 2);
  assert.deepEqual(restored.eventHistory[0], changed.eventHistory[0]);
  assert.deepEqual(restored.eventHistory[1], changed.events[0]);
  const before = structuredClone(restored);
  assert.strictEqual(applyMutation(restored, payload, NEXT), restored);
  assert.deepEqual(restored, before);
  assert.throws(() => apply(restored, 'restore', { items: restored.items, preferences: restored.preferences, eventHistory: [] }), /不能由请求覆盖/);
});
