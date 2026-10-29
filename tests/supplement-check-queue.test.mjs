import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupplementCheckQueue } from '../lib/supplement-check-queue.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(patch = {}) {
  const requests = [], states = [];
  const queue = createSupplementCheckQueue({ date: '2026-10-19', revision: 10, confirmed: { a: false, b: false, c: false },
    send: payload => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })),
    onChange: state => states.push(state), ...patch });
  return { queue, requests, states };
}

test('independent checks are immediate while HTTP requests stay serial and use each server revision', async () => {
  const { queue, requests } = harness();
  queue.set('a', true); queue.set('b', true); queue.set('c', true);
  assert.deepEqual(queue.snapshot().checked, { a: true, b: true, c: true });
  assert.equal(requests.length, 1);
  requests[0].resolve({ ok: true, revision: 11 }); await tick();
  assert.equal(requests[1].payload.expectedRevision, 11);
  requests[1].resolve({ ok: true, revision: 14 }); await tick();
  assert.equal(requests[2].payload.expectedRevision, 14);
  requests[2].resolve({ ok: true, revision: 15 }); await tick();
  assert.equal(queue.snapshot().pendingCount, 0);
  assert.deepEqual(queue.snapshot().checked, { a: true, b: true, c: true });
});

test('rapid unsent edits collapse to the final state and never duplicate a saved check', async () => {
  const { queue, requests } = harness();
  queue.set('a', true);
  queue.set('b', true); queue.set('b', false); queue.set('b', true);
  assert.equal(queue.snapshot().pendingCount, 2);
  requests[0].resolve({ ok: true, revision: 11 }); await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.doseId, 'b');
  queue.set('b', false); queue.set('b', true);
  requests[1].resolve({ ok: true, revision: 12 }); await tick();
  assert.equal(requests.length, 2);
  assert.equal(queue.snapshot().checked.b, true);
});

test('an in-flight check followed by an immediate uncheck persists both in order and ends unchecked', async () => {
  const { queue, requests } = harness();
  queue.set('a', true); queue.set('a', false);
  assert.equal(queue.snapshot().checked.a, false);
  requests[0].resolve({ ok: true, revision: 11 }); await tick();
  assert.deepEqual(requests[1].payload, { date: '2026-10-19', doseId: 'a', checked: false, expectedRevision: 11 });
  requests[1].resolve({ ok: true, revision: 12 }); await tick();
  assert.equal(queue.snapshot().checked.a, false);
  assert.equal(queue.snapshot().pendingCount, 0);
});

test('failure rolls every unsaved optimistic mark back, stops the queue and waits for explicit retry', async () => {
  const { queue, requests } = harness();
  queue.set('a', true); queue.set('b', true);
  requests[0].reject(new Error('revision conflict')); await tick();
  assert.equal(queue.snapshot().blocked, true);
  assert.deepEqual(queue.snapshot().checked, { a: false, b: false, c: false });
  assert.deepEqual(queue.snapshot().failedDoseIds, ['a', 'b']);
  assert.equal(requests.length, 1);
  assert.equal(queue.set('c', true), false);
  queue.sync(99, { a: true, b: true, c: true });
  assert.equal(queue.snapshot().revision, 10, 'a conflict must not silently rebase queued intentions');
  queue.retry();
  assert.equal(requests[1].payload.expectedRevision, 10);
  requests[1].resolve({ ok: true, revision: 11 }); await tick();
  requests[2].resolve({ ok: true, revision: 12 }); await tick();
  assert.deepEqual(queue.snapshot().checked, { a: true, b: true, c: false });
});

test('retry sends a final undo even when a failed response left its old local baseline unchecked', async () => {
  const { queue, requests } = harness();
  queue.set('a', true); queue.set('a', false);
  requests[0].resolve({ ok: false, revision: 10 }); await tick();
  queue.retry();
  assert.equal(requests[1].payload.checked, false, 'the first request may have committed before its response failed');
  requests[1].resolve({ ok: true, revision: 11 }); await tick();
  assert.equal(queue.snapshot().checked.a, false);
});

test('leaving a date detaches UI updates but finishes all clicked writes on the original date', async () => {
  const { queue, requests, states } = harness();
  queue.set('a', true); queue.set('b', true);
  queue.dispose(); const count = states.length;
  assert.equal(queue.set('c', true), false);
  requests[0].resolve({ ok: true, revision: 11 }); await tick();
  assert.equal(requests[1].payload.date, '2026-10-19');
  assert.equal(requests[1].payload.doseId, 'b');
  requests[1].resolve({ ok: true, revision: 12 }); await tick();
  assert.equal(states.length, count);
  assert.equal(queue.snapshot().pendingCount, 0);
});

test('invalid or regressed revision receipts stop rather than send with an invented revision', async () => {
  for (const receipt of [{ ok: true }, { ok: true, revision: 9 }, true]) {
    const { queue, requests } = harness();
    queue.set('a', true); queue.set('b', true);
    requests[0].resolve(receipt); await tick();
    assert.equal(queue.snapshot().blocked, true);
    assert.equal(requests.length, 1);
    assert.equal(queue.snapshot().revision, 10);
  }
});
