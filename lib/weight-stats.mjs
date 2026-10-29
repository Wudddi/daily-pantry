/** Read-only statistics over recorded weights, never interpolated calendar days. */
const DAY = 86_400_000;
const MIN_DAY = Date.parse('0001-01-01T00:00:00.000Z') / DAY;

function calendarDay(date) {
  if (typeof date !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date
    ? timestamp / DAY : null;
}

function timestamp(value) {
  if (typeof value !== 'string') return -Infinity;
  // A timezone-less clock time would make deduplication depend on the viewer's timezone.
  if (calendarDay(value) === null && !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return -Infinity;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function laterRecord(candidate, existing) {
  for (const key of ['updatedAt', 'createdAt']) {
    const candidateTime = timestamp(candidate[key]), existingTime = timestamp(existing[key]);
    if (candidateTime !== existingTime) return candidateTime > existingTime;
  }
  // The ID breaks ties; it is not interpreted as a measurement time.
  return candidate.id > existing.id;
}

function point(record) {
  return record ? { id: record.id, date: record.date, weightKg: record.weightKg } : null;
}

function rounded(value) {
  const result = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(result, -0) ? 0 : result;
}

function windowStats(points, fromDay, toDay, expectedDays) {
  const representable = fromDay !== null && toDay !== null && toDay >= MIN_DAY;
  const from = representable ? new Date(Math.max(MIN_DAY, fromDay) * DAY).toISOString().slice(0, 10) : '';
  const to = representable ? new Date(toDay * DAY).toISOString().slice(0, 10) : '';
  const rows = representable ? points.filter(row => row.date >= from && row.date <= to) : [];
  const first = rows[0] ?? null, last = rows.at(-1) ?? null;
  return {
    from, to, expectedDays, coverageDays: rows.length,
    averageKg: rows.length ? rows.reduce((sum, row) => sum + row.weightKg, 0) / rows.length : null,
    first: point(first), last: point(last),
    changeKg: rows.length >= 2 ? rounded(last.weightKg - first.weightKg) : null,
    intervalDays: first ? calendarDay(last.date) - calendarDay(first.date) : null,
    complete: rows.length === expectedDays,
  };
}

function comparison(points, anchor, length) {
  const current = windowStats(points, anchor === null ? null : anchor - length + 1, anchor, length);
  const previous = windowStats(points, anchor === null ? null : anchor - 2 * length + 1, anchor === null ? null : anchor - length, length);
  return {
    current, previous,
    // One observation still has a readable mean, but is insufficient for a period comparison.
    averageChangeKg: current.coverageDays >= 2 && previous.coverageDays >= 2
      ? rounded(current.averageKg - previous.averageKg) : null,
  };
}

/**
 * Latest eligible measurement date anchors both periods; no wall-clock date is used.
 * Each day contributes once: latest update, then creation, then stable ID wins.
 * `points` keeps original records and their complete evidence for the chart/details.
 * Archived, missing/invalid date, ID or weight rows are counted in ignoredCount.
 */
export function weightStats(measurements) {
  const byDay = new Map(), duplicates = new Set();
  let ignoredCount = 0;
  for (const record of Array.isArray(measurements) ? measurements : []) {
    if (!record || typeof record !== 'object' || record.archived === true
      || typeof record.id !== 'string' || !record.id.trim()
      || calendarDay(record.date) === null || typeof record.weightKg !== 'number'
      || !Number.isFinite(record.weightKg) || record.weightKg <= 0 || record.weightKg > 1000) {
      ignoredCount++;
      continue;
    }
    const previous = byDay.get(record.date);
    if (previous) {
      duplicates.add(record.date);
      if (laterRecord(record, previous)) byDay.set(record.date, record);
    } else byDay.set(record.date, record);
  }
  const points = [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const anchorDate = points.at(-1)?.date ?? null;
  const anchor = anchorDate === null ? null : calendarDay(anchorDate);
  return {
    anchorDate, points, dayCount: points.length, duplicateDayCount: duplicates.size, ignoredCount,
    weeks: comparison(points, anchor, 7), months: comparison(points, anchor, 30),
  };
}
