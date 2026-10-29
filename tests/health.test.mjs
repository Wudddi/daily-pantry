import test from 'node:test';
import assert from 'node:assert/strict';
import { seedHealthState, applyHealthMutation, validateMeasurement, validateTrainingSession, validateHealthDate, healthSummary, readHealthRecords, healthContext } from '../lib/health.mjs';

const NOW = '2026-10-18T02:00:00.000Z';
const LATER = '2026-10-18T03:00:00.000Z';
const empty = () => ({ schemaVersion: 1, revision: 0, updatedAt: '2026-10-17', measurements: [], sessions: [], events: [], operationIds: [] });
// DEMO: all measurements, training records and source text in this suite are synthetic.
const measurement = (overrides = {}) => ({ id: 'weight-one', date: '2026-10-17', weightKg: 64.2, source: 'chat', sourceText: 'DEMO synthetic measurement: 64.2 kg; waist not measured.', ...overrides });
const set = (overrides = {}) => ({ weight: 20, unit: 'lb', reps: 12, kind: 'working', loadBasis: 'single_hand', effortFromRep: 9, rir: null, rpe: null, notes: 'DEMO：后几次的动作备注示例', sourceText: 'DEMO synthetic set: 20 lb per hand, 12 reps, effort from rep 9.', ...overrides });
const session = (overrides = {}) => ({ id: 'session-one', date: '2026-10-17', title: 'DEMO 背部与手臂训练', status: 'completed', source: 'chat', sourceText: 'DEMO synthetic completed back-and-arms session.', exercises: [{ name: '哑铃弯举', equipment: '哑铃', sets: [set()] }], ...overrides });
const mutate = (state, action, payload, operationId = `op-${state.revision}`) => applyHealthMutation(state, { action, expectedRevision: state.revision, operationId, ...payload }, NOW);

function paginationFixture() {
  const state = empty();
  const start = Date.parse('2026-02-20T00:00:00.000Z');
  state.measurements = Array.from({ length: 240 }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return validateMeasurement(measurement({ id: `demo-page-${index}`, date, weightKg: 65 + (index % 11) / 10, sourceText: `DEMO synthetic pagination measurement ${index}.` }), NOW);
  });
  return state;
}

test('the DEMO seed imports 20 unique synthetic measurements across three years and no training', () => {
  const state = seedHealthState();
  assert.equal(state.measurements.length, 20);
  assert.equal(state.sessions.length, 0);
  assert.equal(new Set(state.measurements.map((row) => row.date)).size, 20);
  assert.deepEqual([2025, 2026, 2027].map((year) => state.measurements.filter((row) => row.date.startsWith(String(year))).length), [3, 2, 15]);
  assert.equal(state.measurements[0].id, 'weight-2025-12-28');
  assert.equal(state.measurements[1].sourceText, 'DEMO synthetic measurement 02: 82.10 kg; fictional example, not a real person.');
  assert.equal(state.measurements[1].weightKg, 82.1);
  assert.ok(state.measurements.every((row) => row.source === 'user_note' && row.waistCm === null && row.bodyFatPct === null && !row.archived && row.sourceText.startsWith('DEMO synthetic')));
  state.measurements[0].sourceText = 'changed copy';
  assert.notEqual(seedHealthState().measurements[0].sourceText, 'changed copy');
});

test('DEMO seed summary computes the latest, first, lowest, change, calendar means and four exact gaps', () => {
  const summary = healthSummary(seedHealthState());
  assert.equal(summary.first.weightKg, 82);
  assert.equal(summary.latest.weightKg, 81);
  assert.equal(summary.lowest.weightKg, 80.9);
  assert.equal(summary.changeKg, -1);
  assert.equal(summary.latest7Days.count, 7);
  assert.equal(summary.latest7Days.from, '2027-01-12');
  assert.equal(summary.previous7Days.to, '2027-01-11');
  assert.equal(summary.previous7Days.count, 6);
  assert.ok(Math.abs(summary.latest7Days.averageKg - 81.12857142857142) < 1e-10);
  assert.ok(Math.abs(summary.previous7Days.averageKg - 81.41666666666667) < 1e-10);
  assert.deepEqual(summary.gaps, [
    { from: '2025-12-31', to: '2026-12-27', days: 362 },
    { from: '2026-12-30', to: '2027-01-01', days: 3 },
    { from: '2027-01-04', to: '2027-01-04', days: 1 },
    { from: '2027-01-06', to: '2027-01-06', days: 1 },
  ]);
});

test('calendar averages count recorded days only and never interpolate missing days or use latest seven entries', () => {
  let state = empty();
  for (const [date, weightKg] of [['2026-10-01', 90], ['2026-10-10', 80], ['2026-10-17', 70]]) state = mutate(state, 'upsert_measurement', { measurement: measurement({ id: date, date, weightKg }) });
  const summary = healthSummary(state);
  assert.deepEqual(summary.latest7Days, { from: '2026-10-11', to: '2026-10-17', count: 1, averageKg: 70 });
  assert.deepEqual(summary.previous7Days, { from: '2026-10-04', to: '2026-10-10', count: 1, averageKg: 80 });
  assert.equal(summary.averageChangeKg, -10);
  assert.equal(summary.gaps[0].days, 8);
  assert.equal(healthSummary(empty()).latest7Days.averageKg, null);
});

test('invalid dates, coercions, nonfinite values, negatives and impossible measurement ranges are rejected', () => {
  assert.equal(validateHealthDate('2024-02-29'), '2024-02-29');
  for (const date of ['2025-02-29', '2026-02-30', '2026-13-01', '10/17/2026']) assert.throws(() => validateHealthDate(date));
  for (const weightKg of [0, -1, NaN, Infinity, '64.2']) assert.throws(() => validateMeasurement(measurement({ weightKg }), NOW));
  assert.throws(() => validateMeasurement(measurement({ bodyFatPct: 101 }), NOW));
  assert.throws(() => validateMeasurement(measurement({ weightKg: null }), NOW), /至少记录/);
  assert.equal(validateMeasurement(measurement({ weightKg: null, waistCm: 80 }), NOW).weightKg, null);
  assert.equal(validateMeasurement(measurement(), NOW).waistCm, null);
});

test('duplicate dates conflict even when archived; updates must target the existing measurement ID', () => {
  let state = mutate(empty(), 'upsert_measurement', { measurement: measurement() });
  assert.throws(() => mutate(state, 'upsert_measurement', { measurement: measurement({ id: 'new-id' }) }), (error) => error.status === 409 && error.code === 'MEASUREMENT_DATE_CONFLICT');
  state = mutate(state, 'archive_measurement', { id: 'weight-one', archived: true });
  assert.throws(() => mutate(state, 'upsert_measurement', { measurement: measurement({ id: 'another-id' }) }), /已有身体记录/);
  const corrected = mutate(state, 'upsert_measurement', { measurement: measurement({ weightKg: 64.3 }) });
  assert.equal(corrected.measurements.length, 1);
  assert.equal(corrected.measurements[0].archived, true);
});

test('partial measurement corrections preserve unmentioned weight, evidence and timestamps while explicit null clears a value', () => {
  const before = mutate(empty(), 'upsert_measurement', { measurement: measurement() });
  const after = applyHealthMutation(before, { action: 'upsert_measurement', operationId: 'waist-only', expectedRevision: before.revision, measurement: { id: 'weight-one', waistCm: 80 } }, LATER);
  assert.equal(after.measurements[0].weightKg, 64.2);
  assert.equal(after.measurements[0].waistCm, 80);
  assert.equal(after.measurements[0].sourceText, before.measurements[0].sourceText);
  assert.equal(after.measurements[0].createdAt, NOW);
  assert.equal(after.measurements[0].updatedAt, LATER);
  assert.equal(after.events.at(-1).previous.weightKg, 64.2);
  assert.equal(after.events.at(-1).previous.waistCm, null);
  assert.equal(before.measurements[0].waistCm, null);
  const cleared = mutate(after, 'upsert_measurement', { measurement: { id: 'weight-one', weightKg: null } });
  assert.equal(cleared.measurements[0].weightKg, null);
  assert.equal(cleared.measurements[0].waistCm, 80);
});

test('a retry is idempotent before revision checking and a new stale operation is rejected', () => {
  const payload = { action: 'upsert_measurement', operationId: 'record-once', expectedRevision: 0, measurement: measurement() };
  const after = applyHealthMutation(empty(), payload, NOW);
  assert.strictEqual(applyHealthMutation(after, payload, LATER), after);
  assert.equal(after.measurements.length, 1);
  assert.equal(after.events.length, 1);
  assert.throws(() => applyHealthMutation(after, { ...payload, operationId: 'new-stale' }, LATER), (error) => error.status === 409 && error.code === 'HEALTH_REVISION_CONFLICT');
});

test('archiving and restoring preserves complete records and changes active summary without physical deletion', () => {
  let state = mutate(empty(), 'upsert_measurement', { measurement: measurement() });
  state = mutate(state, 'archive_measurement', { id: 'weight-one', archived: true });
  assert.equal(state.measurements.length, 1);
  assert.equal(healthSummary(state).weightCount, 0);
  assert.equal(state.events.at(-1).previous.sourceText, measurement().sourceText);
  state = mutate(state, 'archive_measurement', { id: 'weight-one', archived: false });
  assert.equal(healthSummary(state).weightCount, 1);
  assert.equal(state.measurements[0].sourceText, measurement().sourceText);
});

test('per-set original reporting, pounds and single-hand load basis are preserved without inferred RPE or conversion', () => {
  const stored = validateTrainingSession(session(), NOW);
  assert.deepEqual(stored.exercises[0].sets[0], set());
  assert.equal(stored.durationMinutes, null);
  const unknown = validateTrainingSession(session({ exercises: [{ name: '引体', sets: [{}] }] }), NOW).exercises[0].sets[0];
  assert.equal(unknown.weight, null);
  assert.equal(unknown.reps, null);
  assert.equal(unknown.unit, null);
  assert.equal(unknown.loadBasis, 'unknown');
  assert.equal(unknown.rir, null);
  assert.throws(() => validateTrainingSession(session({ status: undefined }), NOW), /明确区分/);
  assert.throws(() => validateTrainingSession(session({ exercises: [{ name: '划船', sets: [set({ unit: '斤' })] }] }), NOW));
  assert.throws(() => validateTrainingSession(session({ exercises: [{ name: '划船', sets: [set({ rpe: 11 })] }] }), NOW));
});

test('session corrections merge unmentioned fields, planned sessions never count as actual training, and archives can restore', () => {
  let state = mutate(empty(), 'upsert_session', { session: session({ status: 'planned' }) });
  assert.equal(healthSummary(state).completedSessionCount, 0);
  assert.equal(healthSummary(state).plannedSessionCount, 1);
  state = mutate(state, 'upsert_session', { session: { id: 'session-one', notes: '计划备注更正' } });
  assert.equal(state.sessions[0].status, 'planned');
  assert.equal(state.sessions[0].exercises[0].sets[0].sourceText, set().sourceText);
  assert.equal(state.sessions[0].sourceText, session().sourceText);
  state = mutate(state, 'upsert_session', { session: { id: 'session-one', status: 'completed' } });
  assert.equal(state.sessions.length, 1);
  assert.equal(healthSummary(state).completedSessionCount, 1);
  state = mutate(state, 'archive_session', { id: 'session-one', archived: true });
  assert.equal(healthSummary(state).completedSessionCount, 0);
  state = mutate(state, 'archive_session', { id: 'session-one', archived: false });
  assert.equal(healthSummary(state).completedSessionCount, 1);
});

test('all reads are nonmutating and bounded, with usable cursors and date/exercise filters', () => {
  const state = paginationFixture();
  const before = structuredClone(state);
  const first = readHealthRecords(state, { limit: 100 });
  const second = readHealthRecords(state, { limit: 100, cursor: first.nextCursor });
  const third = readHealthRecords(state, { limit: 100, cursor: second.nextCursor });
  assert.equal(state.measurements.length, 240);
  assert.equal(first.returnedCount, 100);
  assert.equal(second.returnedCount, 100);
  assert.equal(third.returnedCount, 40);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  assert.notEqual(first.measurements[0].id, second.measurements[0].id);
  assert.equal(new Set([...first.measurements, ...second.measurements, ...third.measurements].map((row) => row.id)).size, 240);
  const range = readHealthRecords(state, { from: '2026-10-11', to: '2026-10-17' });
  assert.equal(range.returnedCount, 7);
  assert.throws(() => readHealthRecords(state, { limit: 101 }));
  assert.throws(() => readHealthRecords(state, { from: '2026-10-17', to: '2026-10-01' }));
  assert.deepEqual(state, before);
  const withSession = mutate(state, 'upsert_session', { session: session() });
  const filtered = readHealthRecords(withSession, { exercise: '弯举' });
  assert.equal(filtered.measurements.length, 0);
  assert.equal(filtered.sessions.length, 1);
});

test('food inventory health context contains at most three actual sessions and never audit or all weight records', () => {
  let state = empty();
  for (let index = 1; index <= 5; index++) state = mutate(state, 'upsert_session', { session: session({ id: `session-${index}`, date: `2026-10-${10 + index}`, status: index === 5 ? 'planned' : 'completed' }) });
  const context = healthContext(state);
  assert.equal(context.available, true);
  assert.equal(context.revision, state.revision);
  assert.equal(context.recentCompletedSessions.length, 3);
  assert.equal(context.recentCompletedSessions[0].id, 'session-4');
  assert.ok(context.recentCompletedSessions.every((row) => row.status === 'completed'));
  assert.equal(context.operationIds, undefined);
  assert.equal(context.events, undefined);
  assert.equal(context.measurements, undefined);
});

test('large training originals stay intact while AI context and detailed pages respect total character budgets', () => {
  let state = empty();
  const longText = ' 原始感受不确定 '.repeat(400);
  for (let index = 0; index < 3; index++) state = mutate(state, 'upsert_session', { session: session({ id: `long-${index}`, exercises: [{ name: '弯举', sets: Array.from({ length: 60 }, () => set({ sourceText: longText })) }] }) });
  const context = healthContext(state);
  assert.ok(JSON.stringify(context).length <= 24_000);
  assert.ok(context.recentCompletedSessions.every((row) => row.truncated));
  assert.equal(state.sessions[0].exercises[0].sets[0].sourceText, longText);
  const page = readHealthRecords(state);
  assert.ok(JSON.stringify(page).length <= 64_000);
  assert.equal(page.truncated, true);
  assert.ok(page.sessions[0].detailRecordId);
  let offset = 0; let originalJson = ''; let pages = 0;
  while (true) {
    const part = readHealthRecords(state, { recordId: 'long-0', offset });
    assert.ok(JSON.stringify(part).length <= 64_000);
    originalJson += part.detailChunk.text; pages++;
    if (!part.hasMore) break;
    assert.ok(part.detailChunk.nextOffset > offset);
    offset = part.detailChunk.nextOffset;
  }
  assert.ok(pages > 1);
  const restored = JSON.parse(originalJson);
  for (const movement of restored.exercises) movement.sets = movement.sets.map(({ setId: _setId, ...original }) => original);
  assert.deepEqual(restored, state.sessions[0]);
});

test('AI gap summaries are bounded and disclose total counts while full API summary retains all gaps', () => {
  const state = empty();
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let index = 0; index < 80; index++) {
    const date = new Date(start + index * 3 * 86400000).toISOString().slice(0, 10);
    state.measurements.push(validateMeasurement(measurement({ id: date, date }), NOW));
  }
  assert.equal(healthSummary(state).gaps.length, 79);
  const context = healthContext(state);
  assert.equal(context.summary.gaps.length, 50);
  assert.equal(context.summary.gapCount, 79);
  assert.equal(context.summary.gapsTruncated, true);
});

test('client-supplied archive and creation timestamps cannot overwrite server-managed fields', () => {
  const state = mutate(empty(), 'upsert_session', { session: session({ archived: true, createdAt: '2000-01-01', updatedAt: '2000-01-01' }) });
  assert.equal(state.sessions[0].archived, false);
  assert.equal(state.sessions[0].createdAt, NOW);
  assert.equal(state.sessions[0].updatedAt, NOW);
});

test('health context enforces its final serialized budget when control characters expand in JSON', () => {
  let state = empty();
  for (let index = 0; index < 60; index++) {
    const date = new Date(Date.parse('2026-01-01T00:00:00Z') + index * 2 * 86400000).toISOString().slice(0, 10);
    state.measurements.push(validateMeasurement(measurement({ id: `gap-control-${index}`, date, weightKg: 90, condition: '\u0000'.repeat(900), notes: '\u0000'.repeat(5000), sourceText: '\u0000'.repeat(10_000) }), NOW));
  }
  for (let index = 0; index < 3; index++) {
    state = mutate(state, 'upsert_measurement', { measurement: measurement({ id: `control-weight-${index}`, date: `2026-10-${15 + index}`, weightKg: 80 - index, condition: '\u0000'.repeat(900), notes: '\u0000'.repeat(5000), sourceText: '\u0000'.repeat(10_000) }) });
    state = mutate(state, 'upsert_session', { session: session({ id: `control-session-${index}`, date: `2026-10-${15 + index}`, title: '\u0000'.repeat(160), notes: '\u0000'.repeat(5000), sourceText: '\u0000'.repeat(10_000), exercises: [{ name: '\u0000'.repeat(160), equipment: '\u0000'.repeat(300), notes: '\u0000'.repeat(2000), sets: Array.from({ length: 20 }, () => set({ notes: '\u0000'.repeat(1000), sourceText: '\u0000'.repeat(5000) })) }] }) });
  }
  const before = structuredClone(state);
  const context = healthContext(state);
  assert.ok(JSON.stringify(context).length <= context.charBudget);
  assert.equal(context.truncated, true);
  assert.ok(context.omittedSessionCount > 0);
  assert.equal(context.recentCompletedSessions.length + context.omittedSessionCount, 3);
  assert.match(context.detailsTool, /read_health_records/);
  assert.deepEqual(state, before);
  assert.equal(readHealthRecords(state, { recordId: 'control-session-0' }).detailChunk.format, 'json_text');
});

function append(state, sets, overrides = {}, operationId) {
  return mutate(state, 'append_training_sets', { sessionId: 'session-one', exerciseName: '哑铃弯举', equipment: '哑铃', sets, ...overrides }, operationId);
}

test('appending a second reported set preserves the first set, unrelated movements, original quotes and session metadata', () => {
  const first = session({ exercises: [{ name: '哑铃弯举', equipment: '哑铃', notes: '先前动作备注', sets: [set()] }, { name: '高位下拉', equipment: '拉力器', sets: [set({ weight: 40, sourceText: 'DEMO synthetic pulldown: 40 lb, 10 reps.', reps: 10 })] }] });
  const before = mutate(empty(), 'upsert_session', { session: first });
  const after = append(before, [set({ setId: 'curl-set-2', weight: 25, reps: 10, sourceText: 'DEMO synthetic second set: 25 lb, 10 reps.' })]);
  assert.equal(after.sessions[0].exercises[0].sets.length, 2);
  assert.equal(after.sessions[0].exercises[0].sets[0].sourceText, set().sourceText);
  assert.equal(after.sessions[0].exercises[0].sets[0].setId, 'legacy-1-1');
  assert.equal(after.sessions[0].exercises[0].notes, '先前动作备注');
  assert.equal(after.sessions[0].exercises[1].sets[0].sourceText, 'DEMO synthetic pulldown: 40 lb, 10 reps.');
  assert.equal(after.sessions[0].sourceText, first.sourceText);
  assert.equal(after.sessions[0].createdAt, before.sessions[0].createdAt);
  assert.equal(before.sessions[0].exercises[0].sets.length, 1);
  assert.equal(before.sessions[0].exercises[0].sets[0].setId, undefined);
});

test('append retries deduplicate operation IDs first and also deduplicate stable set IDs with a fresh operation', () => {
  const before = mutate(empty(), 'upsert_session', { session: session({ exercises: [] }) });
  const payload = { action: 'append_training_sets', sessionId: 'session-one', exerciseName: '哑铃弯举', equipment: '哑铃', sets: [set({ setId: 'stable-1' })], operationId: 'append-once', expectedRevision: before.revision };
  const after = applyHealthMutation(before, payload, NOW);
  assert.strictEqual(applyHealthMutation(after, payload, LATER), after);
  assert.strictEqual(append(after, [set({ setId: 'stable-1' })], {}, 'fresh-retry'), after);
  assert.equal(after.sessions[0].exercises[0].sets.length, 1);
  assert.equal(after.events.length, 2);
  assert.throws(() => applyHealthMutation(after, { ...payload, operationId: 'stale-new-operation' }, LATER), (error) => error.code === 'HEALTH_REVISION_CONFLICT');
});

test('same set ID with different content or movement conflicts without partially adding other sets', () => {
  let state = mutate(empty(), 'upsert_session', { session: session({ exercises: [] }) });
  state = append(state, [set({ setId: 'stable-1' })]);
  const before = structuredClone(state);
  assert.throws(() => append(state, [set({ setId: 'brand-new' }), set({ setId: 'stable-1', reps: 13 })]), (error) => error.status === 409 && error.code === 'TRAINING_SET_CONFLICT');
  assert.throws(() => append(state, [set({ setId: 'stable-1' })], { exerciseName: '另一动作' }), (error) => error.code === 'TRAINING_SET_CONFLICT');
  assert.deepEqual(state, before);
});

test('duplicate IDs in one append are deduplicated only when their normalized contents agree', () => {
  const state = mutate(empty(), 'upsert_session', { session: session({ exercises: [] }) });
  const duplicate = append(state, [set({ setId: 'one' }), set({ setId: 'one' })]);
  assert.equal(duplicate.sessions[0].exercises[0].sets.length, 1);
  assert.throws(() => append(state, [set({ setId: 'one' }), set({ setId: 'one', unit: 'kg' })]), (error) => error.code === 'TRAINING_SET_CONFLICT');
  assert.equal(state.sessions[0].exercises.length, 0);
});

test('correcting one set merges only the provided changes and preserves the full before value for audit', () => {
  let state = mutate(empty(), 'upsert_session', { session: session() });
  state = append(state, [set({ setId: 'second-set', reps: 10, sourceText: 'DEMO synthetic second set: 10 reps.' })]);
  const before = structuredClone(state);
  const corrected = mutate(state, 'correct_training_set', { sessionId: 'session-one', setId: 'second-set', set: { reps: 11, sourceText: 'DEMO synthetic correction: second set has 11 reps.' } });
  const group = corrected.sessions[0].exercises[0].sets[1];
  assert.equal(group.reps, 11);
  assert.equal(group.weight, 20);
  assert.equal(group.unit, 'lb');
  assert.equal(group.loadBasis, 'single_hand');
  assert.equal(group.rpe, null);
  assert.deepEqual(corrected.sessions[0].exercises[0].sets[0], before.sessions[0].exercises[0].sets[0]);
  assert.deepEqual(corrected.events.at(-1).previous.set, before.sessions[0].exercises[0].sets[1]);
  assert.equal(corrected.events.at(-1).previous.set.sourceText, 'DEMO synthetic second set: 10 reps.');
  assert.deepEqual(state, before);
  assert.strictEqual(mutate(corrected, 'correct_training_set', { sessionId: 'session-one', setId: 'second-set', set: { reps: 11 } }), corrected);
  assert.throws(() => mutate(corrected, 'correct_training_set', { sessionId: 'session-one', setId: 'second-set', set: { setId: 'different-id' } }), /不能改变/);
});

test('legacy set IDs are stable through nonmutating reads and can target a single correction', () => {
  const state = mutate(empty(), 'upsert_session', { session: session() });
  const before = structuredClone(state);
  const firstRead = readHealthRecords(state, { recordId: 'session-one', recordType: 'session' });
  const secondRead = readHealthRecords(state, { recordId: 'session-one', recordType: 'session' });
  const setId = firstRead.record.exercises[0].sets[0].setId;
  assert.equal(setId, secondRead.record.exercises[0].sets[0].setId);
  assert.deepEqual(state, before);
  assert.equal(state.sessions[0].exercises[0].sets[0].setId, undefined);
  const corrected = mutate(state, 'correct_training_set', { sessionId: 'session-one', setId, set: { effortFromRep: 10 } });
  assert.equal(corrected.sessions[0].exercises[0].sets[0].setId, setId);
  assert.equal(corrected.sessions[0].exercises[0].sets[0].effortFromRep, 10);
  assert.equal(corrected.events.at(-1).previous.set.effortFromRep, 9);
});

test('legacy IDs avoid explicit ID collisions and full-session validation rejects duplicate explicit IDs', () => {
  const state = mutate(empty(), 'upsert_session', { session: session({ exercises: [{ name: '弯举', sets: [set(), set({ setId: 'legacy-1-1' })] }] }) });
  const read = readHealthRecords(state, { recordId: 'session-one' });
  const ids = read.record.exercises[0].sets.map((group) => group.setId);
  assert.equal(new Set(ids).size, 2);
  assert.notEqual(ids[0], 'legacy-1-1');
  assert.throws(() => validateTrainingSession(session({ exercises: [{ name: '弯举', sets: [set({ setId: 'duplicate' }), set({ setId: 'duplicate' })] }] }), NOW), (error) => error.code === 'DUPLICATE_SET_ID');
});

test('equipment disambiguates repeated movement names without changing a different machine', () => {
  const state = mutate(empty(), 'upsert_session', { session: session({ exercises: [{ name: '划船', equipment: '哑铃', sets: [set()] }, { name: '划船', equipment: '器械', sets: [set({ loadBasis: 'machine' })] }] }) });
  const one = set({ setId: 'row-next', loadBasis: 'machine' });
  assert.throws(() => append(state, [one], { exerciseName: '划船', equipment: undefined }), (error) => error.code === 'AMBIGUOUS_EXERCISE');
  const after = append(state, [one], { exerciseName: '划船', equipment: '器械' });
  assert.equal(after.sessions[0].exercises[0].sets.length, 1);
  assert.equal(after.sessions[0].exercises[1].sets.length, 2);
});

test('planned and archived sessions reject actual-group append and unknown sessions or sets return not-found', () => {
  const planned = mutate(empty(), 'upsert_session', { session: session({ status: 'planned' }) });
  assert.throws(() => append(planned, [set({ setId: 'actual' })]), (error) => error.code === 'PLANNED_SESSION_NOT_ACTUAL');
  const archived = mutate(mutate(empty(), 'upsert_session', { session: session() }), 'archive_session', { id: 'session-one', archived: true });
  assert.throws(() => append(archived, [set({ setId: 'actual' })]), (error) => error.code === 'TRAINING_SESSION_ARCHIVED');
  assert.throws(() => append(empty(), [set({ setId: 'actual' })]), (error) => error.status === 404);
  assert.throws(() => mutate(planned, 'correct_training_set', { sessionId: 'session-one', setId: 'missing', set: { reps: 12 } }), (error) => error.code === 'TRAINING_SET_NOT_FOUND');
});

test('append requires stable IDs, preserves unknown values and enforces per-movement capacity atomically', () => {
  const state = mutate(empty(), 'upsert_session', { session: session({ exercises: [] }) });
  assert.throws(() => append(state, [set()]), /训练组 ID/);
  const unknown = append(state, [{ setId: 'unknown-unit', sourceText: 'DEMO synthetic set: 12 reps; load unknown.', reps: 12 }]);
  const recorded = unknown.sessions[0].exercises[0].sets[0];
  assert.equal(recorded.weight, null);
  assert.equal(recorded.unit, null);
  assert.equal(recorded.loadBasis, 'unknown');
  const full = mutate(empty(), 'upsert_session', { session: session({ exercises: [{ name: '哑铃弯举', equipment: '哑铃', sets: Array.from({ length: 100 }, () => set()) }] }) });
  assert.throws(() => append(full, [set({ setId: 'too-many' })]), /最多保存 100 组/);
  assert.equal(full.sessions[0].exercises[0].sets.length, 100);
});
