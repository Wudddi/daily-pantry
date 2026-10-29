import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, validateItem, planningSnapshot } from '../lib/inventory.mjs';
import { validateDietHistory } from '../lib/diet-history.mjs';
import { readDietRecords, dietContext } from '../lib/diet.mjs';
const NOW = '2026-10-18T12:00:00Z';
const LATER = '2026-10-18T13:00:00Z';
function state() { return { schemaVersion: 1, revision: 0, updatedAt: NOW, items: [validateItem({ id: 'current', name: '当前库存', category: 'bread', quantity: 10, unit: '片', status: 'pending' }, NOW)], plans: [], preferences: [], events: [], operationIds: [] }; }
function record(overrides = {}) { return { id: 'history-17', date: '2026-10-17', title: '历史最终版', confirmation: 'partial_report', meals: [{ id: 'lunch', name: '午餐', status: 'reported_completed', plannedTime: '12:00', items: [{ id: 'old-food', name: '已不存在库存的食材', inventoryItemId: 'missing-old-batch', quantity: 100, plannedQuantity: 100, actualQuantity: null, unit: 'g', sourceText: '原文：只说吃了午饭，未说克数' }] }], supplements: [{ id: 'fish', name: '鱼油', quantity: 1, plannedQuantity: 1, actualQuantity: null, unit: '粒', status: 'reported_completed', sourceText: '午饭后吃了鱼油' }], planSourceText: '完整计划\n保留空行与原文 ', executionSourceText: '用户实际原话', sourceRefs: [{ conversationId: 'chat-id', messageKey: 'message-key', date: '2026-10-17', kind: 'document', text: '截图仅证明终稿，不证明实际吃过' }], ...overrides }; }
function apply(s, r, op = `history-${s.revision}`) { return applyMutation(s, { action: 'import_diet_history', record: r, operationId: op, expectedRevision: s.revision }, NOW); }

test('historical completed records never reserve, consume, revive or recount any current inventory', () => {
  const before = state(); const after = apply(before, record());
  assert.deepEqual(after.items, before.items);
  assert.deepEqual(after.plans, []);
  assert.deepEqual(before.dietHistory, undefined);
  assert.equal(after.revision, 1);
  assert.equal(after.dietHistory[0].inventoryEffect, 'none');
  assert.equal(after.dietHistory[0].recordType, 'diet_history');
  assert.match(after.events.at(-1).detail, /库存变化为0/);
  assert.equal(after.dietHistory[0].planSourceText, record().planSourceText);
});

test('planned quantities and times are never copied into unreported actual fields or missing nutrition', () => {
  const h = validateDietHistory(record());
  assert.equal(h.supplements[0].quantity, 1);
  assert.equal(h.supplements[0].plannedQuantity, 1);
  assert.equal(h.supplements[0].actualQuantity, null);
  assert.equal(h.supplements[0].actualTime, null);
  assert.equal(h.meals[0].plannedTime, '12:00');
  assert.equal(h.meals[0].actualTime, null);
  for (const key of ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodiumMg']) assert.equal(h.meals[0].items[0].nutrition[key], null);
  assert.equal(h.confirmation, 'partial_report');
  assert.equal(validateDietHistory(record({ confirmation: 'final_plan' })).confirmation, 'final_plan');
});

test('stable record and operation retries are idempotent, while a reused operation with changed facts conflicts', () => {
  const payload = { action: 'import_diet_history', record: record(), operationId: 'once', expectedRevision: 0 };
  const after = applyMutation(state(), payload, NOW);
  assert.strictEqual(applyMutation(after, { ...payload, expectedRevision: 999 }, LATER), after);
  assert.strictEqual(apply(after, record(), 'new-op-same-record'), after);
  assert.throws(() => applyMutation(after, { ...payload, record: record({ executionSourceText: '不同实际原话' }) }, LATER), e => e.status === 409 && e.code === 'OPERATION_ID_CONFLICT');
  assert.equal(after.dietHistory.length, 1);
});

test('historical corrections preserve prior complete versions and never change stock after an absolute recount', () => {
  const original = apply(state(), record());
  const recounted = applyMutation(original, { action: 'set_quantity', id: 'current', quantity: 3, operationId: 'recount', expectedRevision: original.revision }, LATER);
  const corrected = apply(recounted, { id: 'history-17', title: '更正标题', meals: [{ ...record().meals[0], actualTime: '13:20' }] });
  assert.deepEqual(corrected.items, recounted.items);
  assert.equal(corrected.dietHistory[0].meals[0].actualTime, '13:20');
  assert.equal(corrected.dietHistory[0].executionSourceText, original.dietHistory[0].executionSourceText);
  assert.equal(corrected.dietHistory[0].versions.length, 1);
  assert.equal(corrected.dietHistory[0].versions[0].previous.meals[0].actualTime, null);
  assert.equal(original.dietHistory[0].versions.length, 0);
  assert.equal(corrected.dietHistory[0].versions[0].previous.planSourceText, record().planSourceText);
});

test('whole-day and meal nutrition preserve original estimates and do not derive sums from conflicting source totals', () => {
  const h = apply(state(), record({ nutrition: { kcal: 2000, protein: 150, source: 'estimate', sourceText: '原Chat总计2000；明细合计不同，保留原文' }, meals: [{ ...record().meals[0], nutrition: { kcal: 999, source: 'estimate', sourceText: '午餐原估算' } }] }));
  const patch = apply(h, { id: 'history-17', nutrition: { kcal: 1900 } });
  assert.equal(patch.dietHistory[0].nutrition.protein, 150);
  assert.equal(patch.dietHistory[0].nutrition.kcal, 1900);
  assert.equal(patch.dietHistory[0].meals[0].nutrition.kcal, 999);
  assert.equal(patch.dietHistory[0].nutrition.source, 'estimate');
  assert.deepEqual(patch.items, state().items);
});

test('a batch saves once, is atomic on validation failure and rejects duplicate or excessive records', () => {
  const before = state(); const payload = { action: 'import_diet_history', records: [record(), record({ id: 'other', date: '2026-10-16' })], operationId: 'batch', expectedRevision: 0 };
  const after = applyMutation(before, payload, NOW);
  assert.equal(after.revision, 1); assert.equal(after.events.length, 1); assert.equal(after.dietHistory.length, 2);
  assert.deepEqual(after.items, before.items);
  assert.throws(() => applyMutation(before, { ...payload, records: [record(), record({ id: 'bad', date: '2026-02-30' })] }, NOW));
  assert.equal(before.dietHistory, undefined);
  assert.throws(() => applyMutation(before, { ...payload, records: [record(), record()] }, NOW), /重复/);
  assert.throws(() => applyMutation(before, { ...payload, records: Array.from({ length: 32 }, (_, i) => record({ id: String(i) })) }, NOW), /31/);
});

test('historical records cannot be committed, cancelled, reported or converted into a stock-backed plan', () => {
  const s = apply(state(), record());
  for (const action of ['commit_meal_plan', 'cancel_meal_plan', 'record_meal_intake']) assert.throws(() => applyMutation(s, { action, planId: 'history-17', confirmed: true, operationId: action, expectedRevision: s.revision }, NOW), e => e.status === 409 && e.code === 'HISTORY_ISOLATED');
  assert.throws(() => applyMutation(s, { action: 'commit_plan', plan: { id: 'history-17' }, confirmed: true, operationId: 'legacy-convert', expectedRevision: s.revision }, NOW), e => e.code === 'HISTORY_ISOLATED');
  assert.throws(() => applyMutation(s, { action: 'save_meal_plan_draft', planId: 'unrelated', plan: { id: 'history-17' }, operationId: 'draft-convert', expectedRevision: s.revision }, NOW), e => e.code === 'HISTORY_ISOLATED');
  assert.throws(() => apply(stateWithPlan(), record({ id: 'live-plan' })), e => e.code === 'HISTORY_ID_CONFLICT');
  function stateWithPlan() { return { ...state(), plans: [{ id: 'live-plan' }] }; }
});

test('history is discoverable by date, list, detail and today context, with audits kept out of AI snapshots', () => {
  let s = apply(state(), record({ date: '2026-10-18' })); s = apply(s, { id: 'history-17', title: '更正' });
  const list = readDietRecords(s, { date: '2026-10-18' });
  assert.equal(list.records[0].recordType, 'diet_history'); assert.equal(list.records[0].recordId, 'history-17'); assert.equal(list.records[0].versions, undefined);
  const detail = readDietRecords(s, { recordId: 'history-17' });
  assert.equal(JSON.parse(detail.text).planSourceText, record().planSourceText);
  assert.equal(JSON.parse(detail.text).versions, undefined);
  const context = dietContext(s, '2026-10-18'); assert.equal(context.records[0].inventoryEffect, 'none'); assert.equal(context.total, 1);
  const snapshot = planningSnapshot(s, NOW); assert.equal(snapshot.dietHistoryContext.records[0].recordId, 'history-17'); assert.equal(snapshot.dietHistoryContext.inventoryEffect, 'none');
  assert.equal(s.dietHistory[0].versions.length, 1);
});

test('bounded AI reads preserve long control-character originals through lossless detail fragments', () => {
  const original = '\u0000'.repeat(12000) + '\n原文'; const s = apply(state(), record({ executionSourceText: original, date: '2026-10-18' }));
  const listed = readDietRecords(s).records[0]; assert.equal(listed.recordTruncated, true); assert.equal(listed.recordType, 'diet_history'); assert.equal(listed.inventoryEffect, 'none'); assert.equal(listed.confirmation, 'partial_report');
  let offset = 0, encoded = ''; do { const part = readDietRecords(s, { recordId: 'history-17', offset }); assert.ok(JSON.stringify(part).length <= 64000); encoded += part.text; offset = part.nextOffset; } while (offset !== null);
  assert.equal(JSON.parse(encoded).executionSourceText, original);
  assert.ok(JSON.stringify(dietContext(s, '2026-10-18')).length <= 24000);
  assert.equal(s.dietHistory[0].executionSourceText, original);
});

test('invalid dates, quantities, times and excess text reject without silent truncation', () => {
  for (const patch of [{ date: '2026-02-30' }, { timeZone: 'invalid' }, { confirmation: 'ate_by_assumption' }, { planSourceText: 'x'.repeat(100001) }]) assert.throws(() => validateDietHistory(record(patch)));
  assert.throws(() => validateDietHistory(record({ meals: [{ ...record().meals[0], actualTime: '25:00' }] })));
  assert.throws(() => validateDietHistory(record({ supplements: [{ ...record().supplements[0], actualQuantity: -1 }] })));
  assert.throws(() => validateDietHistory(record({ sourceRefs: [{ ...record().sourceRefs[0], date: '2026-02-30' }] })));
});
