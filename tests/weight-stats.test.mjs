import test from 'node:test';
import assert from 'node:assert/strict';
import { weightStats } from '../lib/weight-stats.mjs';

// All measurements below are independent synthetic arithmetic fixtures.
const DAY = 86_400_000;
const row = (date, weightKg, extra = {}) => ({ id: `weight-${date}`, date, weightKg, archived: false, updatedAt: date, createdAt: date, ...extra });
const offset = (date, count) => new Date(Date.parse(`${date}T00:00:00.000Z`) + count * DAY).toISOString().slice(0, 10);

test('both comparisons anchor to the latest actual measurement and use adjacent inclusive calendar windows', () => {
  const records = Array.from({ length: 60 }, (_, index) => row(offset('2026-10-20', index - 59), 100 - index));
  const result = weightStats(records);
  assert.equal(result.anchorDate, '2026-10-20');
  assert.equal(result.dayCount, 60);
  assert.deepEqual([result.weeks.current.from, result.weeks.current.to, result.weeks.previous.from, result.weeks.previous.to], ['2026-10-14', '2026-10-20', '2026-10-07', '2026-10-13']);
  assert.deepEqual([result.months.current.from, result.months.current.to, result.months.previous.from, result.months.previous.to], ['2026-09-21', '2026-10-20', '2026-08-22', '2026-09-20']);
  assert.equal(result.weeks.current.averageKg, 44);
  assert.equal(result.weeks.previous.averageKg, 51);
  assert.equal(result.weeks.averageChangeKg, -7);
  assert.equal(result.months.current.averageKg, 55.5);
  assert.equal(result.months.previous.averageKg, 85.5);
  assert.equal(result.months.averageChangeKg, -30);
  assert.equal(result.weeks.current.changeKg, -6);
  assert.equal(result.weeks.current.intervalDays, 6);
  assert.equal(result.months.current.changeKg, -29);
  assert.equal(result.months.current.intervalDays, 29);
  assert.equal(result.weeks.current.complete, true);
  assert.equal(result.months.previous.complete, true);
});

test('sparse periods average only actual days and expose the actual dates and coverage rather than zero-filled losses', () => {
  const result = weightStats([row('2026-10-07', 80), row('2026-10-13', 79), row('2026-10-16', 78), row('2026-10-20', 77)]);
  const { current, previous } = result.weeks;
  assert.equal(current.coverageDays, 2);
  assert.equal(current.expectedDays, 7);
  assert.equal(current.averageKg, 77.5);
  assert.equal(current.complete, false);
  assert.equal(previous.averageKg, 79.5);
  assert.equal(result.weeks.averageChangeKg, -2);
  assert.deepEqual([current.first.date, current.last.date, current.intervalDays, current.changeKg], ['2026-10-16', '2026-10-20', 4, -1]);
});

test('an isolated day has a mean but cannot imply a weekly change or a comparison to one prior observation', () => {
  const result = weightStats([row('2026-10-08', 75), row('2026-10-20', 73)]);
  assert.equal(result.weeks.current.averageKg, 73);
  assert.equal(result.weeks.previous.averageKg, 75);
  assert.equal(result.weeks.current.changeKg, null);
  assert.equal(result.weeks.current.intervalDays, 0);
  assert.equal(result.weeks.averageChangeKg, null);
  assert.equal(result.weeks.current.coverageDays, 1);
  assert.equal(result.weeks.current.complete, false);
});

test('one empty comparison period remains unknown and long historical gaps never become inferred weight change', () => {
  const result = weightStats([row('2024-01-01', 95), row('2026-10-18', 62.4), row('2026-10-20', 62.3)]);
  assert.equal(result.weeks.current.changeKg, -0.1);
  assert.equal(result.weeks.previous.averageKg, null);
  assert.equal(result.weeks.previous.changeKg, null);
  assert.equal(result.weeks.previous.first, null);
  assert.equal(result.weeks.previous.coverageDays, 0);
  assert.equal(result.weeks.averageChangeKg, null);
  assert.equal(result.months.previous.averageKg, null);
  assert.equal(result.dayCount, 3);
});

test('missing weights, archived records, invalid dates and non-finite or non-positive numbers cannot change the anchor or become zero', () => {
  const records = [row('2026-10-20', 65.5), row('2026-10-21', null), row('2026-10-22', 60, { archived: true }), row('2026-02-30', 65), row('2026-10-23', NaN), row('2026-10-24', Infinity), row('2026-10-25', 0), row('2026-10-26', -2), row('2026-10-27', '70'), row('2026-10-28', 1001), row('0000-01-01', 72), row('2026-10-29', 70, { id: '' }), null];
  const result = weightStats(records);
  assert.equal(result.anchorDate, '2026-10-20');
  assert.equal(result.dayCount, 1);
  assert.equal(result.ignoredCount, 12);
  assert.equal(result.weeks.current.averageKg, 65.5);
});

test('duplicate dates choose the most recently updated eligible weight and do not overweight that date', () => {
  const older = row('2026-10-20', 80, { id: 'older', updatedAt: '2026-10-20T08:00:00Z' });
  const newest = row('2026-10-20', 63, { id: 'newest', updatedAt: '2026-10-20T12:00:00-04:00' });
  const result = weightStats([older, newest, row('2026-10-20', 60, { id: 'archived', archived: true, updatedAt: '2026-10-21' }), row('2026-10-20', null, { id: 'waist-only', updatedAt: '2026-10-22' }), row('2026-10-19', 65)]);
  assert.equal(result.points.at(-1), newest);
  assert.equal(result.dayCount, 2);
  assert.equal(result.duplicateDayCount, 1);
  assert.equal(result.weeks.current.averageKg, 64);
  assert.equal(result.weeks.current.changeKg, -2);
  assert.equal(result.ignoredCount, 2);
});

test('deduplication uses creation time and a stable ID to break update-time ties without depending on input order', () => {
  const base = { updatedAt: '2026-10-20T12:00:00Z' };
  const records = [row('2026-10-20', 64, { ...base, id: 'z', createdAt: '2026-10-20T08:00:00Z' }), row('2026-10-20', 63.5, { ...base, id: 'a', createdAt: '2026-10-20T09:00:00Z' }), row('2026-10-20', 63, { ...base, id: 'b', createdAt: '2026-10-20T09:00:00Z' })];
  assert.equal(weightStats(records).points[0].id, 'b');
  assert.deepEqual(weightStats([...records].reverse()), weightStats(records));
});

test('a duplicate count represents affected dates, not the total number of old rows', () => {
  const result = weightStats([row('2026-10-19', 64, { id: 'a' }), row('2026-10-19', 63.9, { id: 'b' }), row('2026-10-19', 63.8, { id: 'c' }), row('2026-10-20', 64, { id: 'd' }), row('2026-10-20', 63.7, { id: 'e' })]);
  assert.equal(result.dayCount, 2);
  assert.equal(result.duplicateDayCount, 2);
  assert.equal(result.weeks.current.averageKg, 63.75);
});

test('leap days and year boundaries are real calendar days rather than fixed month approximations', () => {
  const leap = weightStats([row('2024-02-29', 80), row('2024-03-01', 79.5)]);
  assert.equal(leap.weeks.current.from, '2024-02-24');
  assert.equal(leap.months.current.from, '2024-02-01');
  assert.equal(leap.weeks.current.intervalDays, 1);
  const crossing = weightStats([row('2025-12-31', 75), row('2026-01-02', 74.9)]);
  assert.equal(crossing.weeks.current.from, '2025-12-27');
  assert.equal(crossing.months.current.from, '2025-12-04');
  assert.equal(crossing.weeks.current.intervalDays, 2);
});

test('calendar math is timezone-independent across the Toronto daylight-saving boundary', () => {
  const records = [row('2026-03-07', 75), row('2026-03-09', 74.8)];
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Toronto';
    const toronto = weightStats(records);
    process.env.TZ = 'Pacific/Auckland';
    assert.deepEqual(weightStats(records), toronto);
    assert.equal(toronto.weeks.current.intervalDays, 2);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('empty or entirely unmeasured input has null statistics, never a fabricated zero trend', () => {
  for (const records of [[], undefined, null, [row('2026-10-20', null)]]) {
    const result = weightStats(records);
    assert.equal(result.anchorDate, null);
    assert.equal(result.dayCount, 0);
    assert.equal(result.weeks.current.from, '');
    assert.equal(result.weeks.current.to, '');
    assert.equal(result.weeks.current.averageKg, null);
    assert.equal(result.weeks.current.changeKg, null);
    assert.equal(result.weeks.averageChangeKg, null);
    assert.equal(result.months.previous.averageKg, null);
    assert.equal(result.weeks.current.complete, false);
  }
});

test('points preserve complete original objects and sources while the input array and records remain untouched', () => {
  const early = Object.freeze(row('2026-10-18', 62, { sourceText: '合成体重记录\n完整保留', condition: '示例条件', bodyFatPct: null }));
  const late = Object.freeze(row('2026-10-20', 61.25, { notes: '只读备注', waistCm: 80 }));
  const records = Object.freeze([late, early]);
  const before = structuredClone(records);
  const result = weightStats(records);
  assert.deepEqual(records, before);
  assert.equal(result.points[0], early);
  assert.equal(result.points[1], late);
  assert.equal(result.points[0].sourceText, '合成体重记录\n完整保留');
  assert.equal(result.points[1].waistCm, 80);
  result.weeks.current.first.weightKg = 1;
  assert.equal(early.weightKg, 62, 'compact statistics must not alias mutable record data');
});

test('decimal changes avoid floating point noise and an actual unchanged period is a known zero', () => {
  const result = weightStats([row('2026-10-07', 61.2), row('2026-10-13', 61.2), row('2026-10-14', 61.2), row('2026-10-20', 61.25)]);
  assert.equal(result.weeks.current.changeKg, 0.05);
  assert.equal(result.weeks.previous.changeKg, 0);
  assert.equal(result.weeks.averageChangeKg, 0.025);
});

test('the earliest supported year keeps four-digit dates without generating year-zero comparison periods', () => {
  const result = weightStats([row('0001-01-01', 75), row('0001-01-02', 74.9)]);
  assert.equal(result.weeks.current.from, '0001-01-01');
  assert.equal(result.weeks.current.to, '0001-01-02');
  assert.equal(result.weeks.previous.from, '');
  assert.equal(result.weeks.previous.averageKg, null);
  assert.equal(result.weeks.current.coverageDays, 2);
  assert.equal(result.weeks.current.complete, false);
});
