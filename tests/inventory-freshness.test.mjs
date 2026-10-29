import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-26T12:00:00.000Z', LATER = '2026-10-27T12:00:00.000Z';
const raw = extra => ({ id: 'yogurt', name: 'Plain Greek Yogurt', brand: 'PC', category: 'protein', unit: 'g', quantity: 300, location: '冷藏', ...extra });
const facts = extra => ({ opened: true, openedOn: '2026-10-25', bestBeforeDate: '2026-10-30', userConsumeByDate: '2026-10-28', sourceText: '用户明确说：这桶25号开封，标签Best Before30号，我希望28号用完。', ...extra });
const fixture = extra => ({ schemaVersion: 1, revision: 0, updatedAt: NOW, items: [validateItem(raw(extra), NOW)], preferences: [], events: [], operationIds: [],
  plans: [{ id: 'historical-menu', notes: '原菜单与实际事实不变', accountedDebits: [] }], dietHistory: [{ id: 'old-intake', sourceText: '用户实际原话' }] });
const mutate = (state, action, extra, operationId = `${action}-${state.revision}`) => applyMutation(state, { action, ...extra, operationId, expectedRevision: state.revision }, LATER);

test('legacy items remain unchanged in shape and explicitly sourced optional facts normalize without inventing dates', () => {
  const legacy = validateItem(raw(), NOW);
  assert.equal(Object.hasOwn(legacy, 'freshness'), false);
  const quote = '  用户说这桶已经打开了。\n具体哪天不记得。  ';
  const withFacts = validateItem(raw({ freshness: { opened: true, sourceText: quote } }), NOW);
  assert.deepEqual(withFacts.freshness, { opened: true, openedOn: null, bestBeforeDate: null, userConsumeByDate: null, sourceText: quote });
  assert.equal(withFacts.confirmedAt, legacy.confirmedAt);
  assert.equal(withFacts.quantityBaselineToken, legacy.quantityBaselineToken);
});

test('freshness input rejects guessed, malformed or contradictory facts rather than inventing shelf life', () => {
  for (const freshness of [null, [], {}, { opened: true }, { sourceText: ' ' }, facts({ sourceText: '字'.repeat(1001) }), facts({ opened: 1 }),
    facts({ openedOn: '2026-02-30' }), facts({ bestBeforeDate: '2026-10-30T12:00:00Z' }), facts({ userConsumeByDate: 123 }),
    facts({ opened: false }), facts({ safeUntilDate: '2026-11-01' }), facts({ openedOn: '' })]) {
    assert.throws(() => validateItem(raw({ freshness }), NOW), error => error.status === 400);
  }
});

test('partial freshness writes require new evidence, preserve omitted facts and never recount stock or overwrite actual history', () => {
  const original = fixture({ freshness: facts() }), before = structuredClone(original);
  const updated = mutate(original, 'upsert', { item: { id: 'yogurt', freshness: { userConsumeByDate: '2026-10-29', sourceText: '用户改口：我想29号之前用完。' } } }, 'freshness-partial');
  const current = updated.items[0];
  assert.deepEqual(current.freshness, { ...original.items[0].freshness, userConsumeByDate: '2026-10-29', sourceText: '用户改口：我想29号之前用完。' });
  for (const key of ['quantity', 'unit', 'status', 'nutrition', 'confirmedAt', 'quantityBaselineToken']) assert.deepEqual(current[key], original.items[0][key], key);
  for (const key of ['plans', 'dietHistory', 'preferences']) assert.deepEqual(updated[key], original[key], key);
  assert.deepEqual(updated.events[0].freshnessBefore, original.items[0].freshness);
  assert.deepEqual(updated.events[0].freshnessAfter, current.freshness);
  assert.notStrictEqual(updated.events[0].freshnessAfter, current.freshness);
  assert.throws(() => mutate(updated, 'upsert', { item: { id: 'yogurt', freshness: { opened: false, openedOn: null } } }), error => error.code === 'FRESHNESS_SOURCE_REQUIRED');
  const labelOnly = mutate(updated, 'upsert', { item: { id: 'yogurt', nutrition: { kcal: 60, source: 'label' } } });
  assert.deepEqual(labelOnly.items[0].freshness, current.freshness);
  assert.equal(labelOnly.events.at(-1).freshnessBefore, undefined);
  assert.deepEqual(original, before);
});

test('explicit null clears only the supplied fact and retains previous sourced facts in the audit', () => {
  const original = fixture({ freshness: facts() });
  const cleared = mutate(original, 'upsert', { item: { id: 'yogurt', freshness: { bestBeforeDate: null, sourceText: '用户纠正：之前抄错了最佳赏味日期，清掉等我看包装。' } } });
  assert.equal(cleared.items[0].freshness.bestBeforeDate, null);
  assert.equal(cleared.items[0].freshness.openedOn, '2026-10-25');
  assert.equal(cleared.events[0].freshnessBefore.bestBeforeDate, '2026-10-30');
  const allCleared = mutate(cleared, 'upsert', { item: { id: 'yogurt', freshness: { opened: null, openedOn: null, bestBeforeDate: null, userConsumeByDate: null, sourceText: '用户明确：这几个开封和日期信息都不确定，先清除。' } } });
  assert.deepEqual(allCleared.items[0].freshness, { opened: null, openedOn: null, bestBeforeDate: null, userConsumeByDate: null, sourceText: '用户明确：这几个开封和日期信息都不确定，先清除。' });
});

test('restock clears the old purchase freshness while preserving product identity, label and the full durable audit', () => {
  const original = fixture({ freshness: facts() }), before = structuredClone(original);
  const payload = { action: 'restock', itemId: 'yogurt', quantity: 1000, operationId: 'new-purchase', expectedRevision: 0 };
  let state = applyMutation(original, payload, LATER);
  assert.equal(Object.hasOwn(state.items[0], 'freshness'), false, 'new purchase does not inherit old opening or dates');
  for (const key of ['id', 'name', 'brand', 'nutrition', 'location']) assert.deepEqual(state.items[0][key], original.items[0][key], key);
  assert.equal(state.items[0].quantity, 1000);
  assert.notEqual(state.items[0].quantityBaselineToken, original.items[0].quantityBaselineToken);
  assert.deepEqual(state.events[0].freshnessBefore, original.items[0].freshness);
  assert.equal(state.events[0].freshnessAfter, null);
  assert.strictEqual(applyMutation(state, payload, NOW), state);
  assert.throws(() => applyMutation(state, { ...payload, quantity: 999 }, NOW), error => error.status === 409 && error.code === 'OPERATION_ID_CONFLICT');
  for (let index = 0; index < 105; index++) state = mutate(state, 'set_quantity', { id: 'yogurt', quantity: 1000 + index % 2 });
  const archived = state.eventHistory.find(event => event.id === 'new-purchase');
  assert.deepEqual(archived.freshnessBefore, original.items[0].freshness);
  assert.equal(archived.freshnessBefore.sourceText, facts().sourceText);
  assert.equal(archived.freshnessAfter, null);
  assert.deepEqual(state.plans, original.plans);
  assert.deepEqual(state.dietHistory, original.dietHistory);
  assert.deepEqual(original, before);
});

test('freshness mutations keep normal revision conflict and retry payload protections', () => {
  const original = fixture();
  const payload = { action: 'upsert', operationId: 'set-opening', expectedRevision: 0, item: { id: 'yogurt', freshness: facts() } };
  const changed = applyMutation(original, payload, LATER);
  assert.strictEqual(applyMutation(changed, payload, NOW), changed);
  assert.throws(() => applyMutation(changed, { ...payload, item: { id: 'yogurt', freshness: facts({ openedOn: '2026-10-26' }) } }, NOW), error => error.code === 'OPERATION_ID_CONFLICT');
  assert.throws(() => applyMutation(changed, { ...payload, operationId: 'stale-freshness' }, NOW), error => error.code === 'REVISION_CONFLICT');
  assert.equal(changed.items[0].quantity, original.items[0].quantity);
});
