/** Validated, auditable body measurements and training records. */
import seedWeightRows from './seed-health-weights.json' with { type: 'json' };

const SOURCES = new Set(['user_note', 'chat', 'manual']);
const SET_KINDS = new Set(['warmup', 'working', 'drop', 'unknown']);
const LOAD_BASES = new Set(['single_hand', 'total', 'machine', 'bodyweight', 'unknown']);
const MAX_RECORDS = 20_000;
const MAX_EVENTS = 20_000;
const DAY = 86_400_000;

function fail(message, status = 400, code = 'INVALID_HEALTH_INPUT') {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  return value;
}
function text(value, label, max = 2000, required = false, preserve = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') fail(`${label}必须是文字。`);
  const result = preserve ? value : value.trim();
  if ((required && !result.trim()) || result.length > max) fail(`${label}${required ? '不能为空，且' : ''}不能超过 ${max} 个字符。`);
  return result;
}
function id(value, label = '记录 ID') { return text(value, label, 100, true); }
function numeric(value, label, max, { positive = false, integer = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (positive && value === 0) || (integer && !Number.isInteger(value))) {
    fail(`${label}必须是${positive ? '正' : '非负'}${integer ? '整数' : '有限数值'}，上限 ${max}；未知请留空，不要猜数值。`);
  }
  return value;
}
export function validateHealthDate(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label}必须是 YYYY-MM-DD。`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label}不是有效的日历日期。`);
  return value;
}
function timestamp(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return validateHealthDate(value);
  if (typeof value !== 'string' || value.length > 50 || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('记录时间必须是有效的带时区 ISO 时间。');
  return new Date(value).toISOString();
}
function source(value) {
  if (value === undefined) return 'manual';
  if (!SOURCES.has(value)) fail('记录来源必须是 user_note、chat 或 manual。');
  return value;
}
function archived(value) {
  if (value !== undefined && typeof value !== 'boolean') fail('归档状态必须是布尔值。');
  return value ?? false;
}

export function validateMeasurement(raw, now = new Date().toISOString()) {
  object(raw, '身体记录');
  const at = timestamp(now);
  const record = {
    id: id(raw.id), date: validateHealthDate(raw.date),
    weightKg: numeric(raw.weightKg, '体重（kg）', 1000, { positive: true }),
    waistCm: numeric(raw.waistCm, '腰围（cm）', 500, { positive: true }),
    bodyFatPct: numeric(raw.bodyFatPct, '体脂率（%）', 100),
    condition: text(raw.condition, '测量条件', 1000),
    notes: text(raw.notes, '身体记录备注', 6000),
    sourceText: text(raw.sourceText, '身体记录原话', 12_000, false, true),
    source: source(raw.source), archived: archived(raw.archived),
    createdAt: timestamp(raw.createdAt ?? at), updatedAt: timestamp(raw.updatedAt ?? at),
  };
  if (record.weightKg === null && record.waistCm === null && record.bodyFatPct === null) fail('至少记录体重、腰围或体脂率其中一项，未知数值无需补猜。');
  return record;
}

function validateSet(raw) {
  object(raw, '训练组');
  const unit = raw.unit === undefined ? null : raw.unit;
  if (unit !== null && unit !== 'kg' && unit !== 'lb') fail('训练重量单位只能是 kg、lb 或未知。');
  const kind = raw.kind ?? 'unknown';
  const loadBasis = raw.loadBasis ?? 'unknown';
  if (!SET_KINDS.has(kind)) fail('训练组类型无效。');
  if (!LOAD_BASES.has(loadBasis)) fail('负重口径无效，请注明单手、总重量、器械、自重或未知。');
  return {
    ...(raw.setId === undefined ? {} : { setId: id(raw.setId, '训练组 ID') }),
    weight: numeric(raw.weight, '训练重量', 5000), unit,
    reps: numeric(raw.reps, '次数', 2000, { integer: true }), kind, loadBasis,
    effortFromRep: numeric(raw.effortFromRep, '开始吃力的次数', 2000, { integer: true, positive: true }),
    rir: numeric(raw.rir, '剩余次数 RIR', 100), rpe: numeric(raw.rpe, '主观用力 RPE', 10),
    notes: text(raw.notes, '训练组备注', 2000),
    sourceText: text(raw.sourceText, '训练组原话', 6000, false, true),
  };
}

export function validateTrainingSession(raw, now = new Date().toISOString()) {
  object(raw, '训练记录');
  const at = timestamp(now);
  if (raw.status !== 'completed' && raw.status !== 'planned') fail('请明确区分已完成训练 completed 与训练计划 planned。');
  const exercises = raw.exercises === undefined ? [] : raw.exercises;
  if (!Array.isArray(exercises) || exercises.length > 40) fail('一条训练记录最多包含 40 个动作。');
  const result = {
    id: id(raw.id), date: validateHealthDate(raw.date), title: text(raw.title, '训练名称', 160, true), status: raw.status,
    durationMinutes: numeric(raw.durationMinutes, '训练时长（分钟）', 1440),
    notes: text(raw.notes, '训练备注', 6000), sourceText: text(raw.sourceText, '训练原话', 30_000, false, true), source: source(raw.source),
    exercises: exercises.map((rawExercise) => {
      object(rawExercise, '训练动作');
      const sets = rawExercise.sets === undefined ? [] : rawExercise.sets;
      if (!Array.isArray(sets) || sets.length > 100) fail('每个训练动作最多记录 100 组。');
      return { name: text(rawExercise.name, '动作名称', 160, true), equipment: text(rawExercise.equipment, '训练器材', 300), notes: text(rawExercise.notes, '动作备注', 2000), sets: sets.map(validateSet) };
    }),
    archived: archived(raw.archived), createdAt: timestamp(raw.createdAt ?? at), updatedAt: timestamp(raw.updatedAt ?? at),
  };
  const setIds = result.exercises.flatMap((movement) => movement.sets.map((set) => set.setId).filter((value) => value !== undefined));
  if (new Set(setIds).size !== setIds.length) fail('同一次训练的组 ID 不能重复，请使用逐组更正而不是复制已有组 ID。', 409, 'DUPLICATE_SET_ID');
  return result;
}

/** Legacy IDs are deterministic and remain read-only until a real mutation. */
function withTrainingSetIds(session) {
  const reserved = new Set();
  for (const movement of session.exercises) {
    for (const set of movement.sets) {
      if (set.setId === undefined) continue;
      if (reserved.has(set.setId)) fail('这次训练存在重复组 ID，请先核对原始记录。', 409, 'DUPLICATE_SET_ID');
      reserved.add(set.setId);
    }
  }
  return { ...session, exercises: session.exercises.map((movement, exerciseIndex) => ({
    ...movement,
    sets: movement.sets.map((set, setIndex) => {
      if (set.setId !== undefined) return { ...set };
      const base = `legacy-${exerciseIndex + 1}-${setIndex + 1}`;
      let setId = base; let suffix = 0;
      while (reserved.has(setId)) setId = `${base}-${++suffix}`;
      reserved.add(setId);
      return { ...set, setId };
    }),
  })) };
}

function sameSet(a, b) { return JSON.stringify(validateSet(a)) === JSON.stringify(validateSet(b)); }
function exerciseKey(value) { return value.normalize('NFKC').toLocaleLowerCase(); }

export function seedHealthState() {
  const rows = structuredClone(seedWeightRows);
  if (!Array.isArray(rows)) fail('初始体重数据格式无效。', 503, 'INVALID_HEALTH_SEED');
  const measurements = rows.map((row) => validateMeasurement({ ...row, id: `weight-${row.date}`, source: 'user_note', archived: false, createdAt: row.date, updatedAt: row.date }, row.date));
  if (new Set(measurements.map((row) => row.date)).size !== measurements.length) fail('初始体重数据包含重复日期。', 503, 'INVALID_HEALTH_SEED');
  const latestDate = measurements.map((row) => row.date).sort().at(-1) ?? '2026-10-17';
  return { schemaVersion: 1, revision: 0, updatedAt: latestDate, measurements, sessions: [], events: [], operationIds: [] };
}

function checkState(state) {
  object(state, '健康记录');
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER) fail('健康记录版本无效。');
  if (!Array.isArray(state.measurements) || !Array.isArray(state.sessions) || !Array.isArray(state.events) || (state.operationIds !== undefined && !Array.isArray(state.operationIds))) fail('健康记录格式无效。');
  if (state.measurements.length > MAX_RECORDS || state.sessions.length > MAX_RECORDS || state.events.length > MAX_EVENTS) fail('健康记录已达到容量上限，请先备份并整理。');
}

export function applyHealthMutation(state, payload, now = new Date().toISOString()) {
  checkState(state); object(payload, '健康记录操作');
  const operationId = id(payload.operationId, '操作 ID');
  const operationIds = state.operationIds ?? [];
  if (operationIds.includes(operationId)) return state;
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) fail('更新前请先读取有效的健康记录版本号。');
  if (payload.expectedRevision !== state.revision) fail('健康记录已在另一处更新，请先重新读取最新版本再保存。', 409, 'HEALTH_REVISION_CONFLICT');
  if (state.events.length >= MAX_EVENTS) fail('健康变更记录已达上限，请先备份并整理，旧记录不会自动删除。');
  const at = timestamp(now);
  const measurements = state.measurements.slice(); const sessions = state.sessions.slice();
  let event;
  const upsert = (collection, raw, validator, label) => {
    object(raw, label);
    const recordId = id(raw.id);
    const index = collection.findIndex((record) => record.id === recordId);
    const previous = index < 0 ? null : collection[index];
    const record = validator({ ...previous, ...raw, archived: previous?.archived ?? false, createdAt: previous?.createdAt ?? at, updatedAt: at }, at);
    if (label === '身体记录') {
      const sameDate = collection.find((entry) => entry.date === record.date && entry.id !== recordId);
      if (sameDate) fail(`这天已有身体记录（ID：${sameDate.id}），请明确编辑已有记录，避免重复称重。`, 409, 'MEASUREMENT_DATE_CONFLICT');
    }
    if (previous) collection[index] = record;
    else {
      if (collection.length >= MAX_RECORDS) fail(`${label}已达 ${MAX_RECORDS} 条上限，请先备份并整理。`);
      collection.push(record);
    }
    event = { id: operationId, at, action: payload.action, recordId, detail: `${previous ? '更正' : '新增'}${label}：${record.date}${label === '训练记录' ? ` ${record.title}（${record.status === 'planned' ? '计划' : '已完成'}）` : ''}。`, ...(previous ? { previous: structuredClone(previous) } : {}) };
  };
  const setArchive = (collection, label) => {
    const recordId = id(payload.id);
    if (typeof payload.archived !== 'boolean') fail('请明确提供要归档 true 还是恢复 false。');
    const index = collection.findIndex((record) => record.id === recordId);
    if (index < 0) fail(`找不到这条${label}。`, 404, 'HEALTH_RECORD_NOT_FOUND');
    const previous = collection[index];
    collection[index] = { ...previous, archived: payload.archived, updatedAt: at };
    event = { id: operationId, at, action: payload.action, recordId, detail: `${payload.archived ? '归档' : '恢复'}${label}：${previous.date}。`, previous: structuredClone(previous) };
  };
  const findTrainingSession = () => {
    const sessionId = id(payload.sessionId, '训练记录 ID');
    const index = sessions.findIndex((entry) => entry.id === sessionId);
    if (index < 0) fail('找不到这次训练，请先读取已有训练，或明确新建一条训练记录。', 404, 'HEALTH_RECORD_NOT_FOUND');
    if (sessions[index].archived) fail('这次训练已经归档，请先恢复后再追加或更正组。', 409, 'TRAINING_SESSION_ARCHIVED');
    return { index, previous: sessions[index], current: withTrainingSetIds(sessions[index]) };
  };
  switch (payload.action) {
    case 'upsert_measurement': upsert(measurements, payload.measurement, validateMeasurement, '身体记录'); break;
    case 'archive_measurement': setArchive(measurements, '身体记录'); break;
    case 'upsert_session': upsert(sessions, payload.session, validateTrainingSession, '训练记录'); break;
    case 'archive_session': setArchive(sessions, '训练记录'); break;
    case 'append_training_sets': {
      const { index, previous, current } = findTrainingSession();
      if (current.status !== 'completed') fail('这条是训练计划，不能把实际组追加进去冒充全部已完成；请新建实际训练记录，只保存已完成的组。', 409, 'PLANNED_SESSION_NOT_ACTUAL');
      const exerciseName = text(payload.exerciseName, '动作名称', 160, true);
      const equipmentProvided = payload.equipment !== undefined;
      const equipment = text(payload.equipment, '训练器材', 300);
      const matches = current.exercises.map((movement, movementIndex) => ({ movement, movementIndex })).filter(({ movement }) => exerciseKey(movement.name) === exerciseKey(exerciseName) && (!equipmentProvided || exerciseKey(movement.equipment) === exerciseKey(equipment)));
      if (matches.length > 1) fail('这次训练有多个同名动作，请明确器械 equipment，不能猜要追加到哪个动作。', 409, 'AMBIGUOUS_EXERCISE');
      const movementIndex = matches[0]?.movementIndex ?? current.exercises.length;
      if (!Array.isArray(payload.sets) || !payload.sets.length || payload.sets.length > 100) fail('每次追加必须包含 1 到 100 组。');
      const incoming = new Map();
      for (const rawSet of payload.sets) {
        object(rawSet, '追加训练组');
        const setId = id(rawSet.setId, '训练组 ID');
        const set = validateSet({ ...rawSet, setId });
        if (incoming.has(setId) && !sameSet(incoming.get(setId), set)) fail('同一个训练组 ID 对应不同内容，请明确更正这组，不能追加覆盖。', 409, 'TRAINING_SET_CONFLICT');
        incoming.set(setId, set);
      }
      const existing = new Map(current.exercises.flatMap((movement, existingIndex) => movement.sets.map((set) => [set.setId, { set, movementIndex: existingIndex }])));
      const newSets = [];
      for (const [setId, set] of incoming) {
        const old = existing.get(setId);
        if (old && (old.movementIndex !== movementIndex || !sameSet(old.set, set))) fail('这个训练组 ID 已保存且动作或内容不同；请先读取原组，再用 correct 明确更正。', 409, 'TRAINING_SET_CONFLICT');
        if (!old) newSets.push(set);
      }
      if (!newSets.length) return state;
      if (!matches.length) {
        if (current.exercises.length >= 40) fail('这次训练已经达到 40 个动作上限。');
        current.exercises.push({ name: exerciseName, equipment, notes: '', sets: [] });
      }
      const movement = current.exercises[movementIndex];
      if (movement.sets.length + newSets.length > 100) fail('每个动作最多保存 100 组，旧组不会自动删除。');
      movement.sets.push(...newSets);
      sessions[index] = { ...current, updatedAt: at };
      event = { id: operationId, at, action: payload.action, recordId: current.id,
        detail: `追加实际完成训练组：${current.date} ${current.title} / ${movement.name}，新增 ${newSets.length} 组；保留此前动作、组和原话。`,
        previous: { sessionId: current.id, exerciseName: movement.name, equipment: movement.equipment, previousSetCount: previous.exercises[movementIndex]?.sets.length ?? 0, addedSetIds: newSets.map((set) => set.setId) },
      };
      break;
    }
    case 'correct_training_set': {
      const { index, current } = findTrainingSession();
      const setId = id(payload.setId, '训练组 ID');
      const patch = object(payload.set, '训练组更正');
      if (patch.setId !== undefined && patch.setId !== setId) fail('更正不能改变训练组 ID。');
      let located;
      for (const movement of current.exercises) {
        const setIndex = movement.sets.findIndex((set) => set.setId === setId);
        if (setIndex >= 0) { located = { movement, setIndex, old: movement.sets[setIndex] }; break; }
      }
      if (!located) fail('找不到这组训练，请先读取原训练获取 setId。', 404, 'TRAINING_SET_NOT_FOUND');
      const corrected = validateSet({ ...located.old, ...patch, setId });
      if (sameSet(located.old, corrected)) return state;
      located.movement.sets[located.setIndex] = corrected;
      sessions[index] = { ...current, updatedAt: at };
      event = { id: operationId, at, action: payload.action, recordId: current.id,
        detail: `更正单组训练：${current.date} ${current.title} / ${located.movement.name}，组 ID ${setId}。`,
        previous: { sessionId: current.id, exerciseName: located.movement.name, equipment: located.movement.equipment, set: structuredClone(located.old) },
      };
      break;
    }
    default: fail('不支持的健康记录操作。');
  }
  return { schemaVersion: 1, revision: state.revision + 1, updatedAt: at, measurements, sessions, events: [...state.events, event], operationIds: [...operationIds, operationId].slice(-2000) };
}

function dateOffset(date, days) { return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10); }
function rounded(value) { return Math.round((value + Number.EPSILON) * 1000) / 1000; }
function byDate(a, b) { return a.date.localeCompare(b.date) || a.id.localeCompare(b.id); }

export function healthSummary(state) {
  checkState(state);
  const active = state.measurements.filter((entry) => !entry.archived);
  const weights = active.filter((entry) => entry.weightKg !== null).sort(byDate);
  const first = weights[0] ?? null; const latest = weights.at(-1) ?? null;
  const window = (from, to) => {
    const rows = weights.filter((entry) => entry.date >= from && entry.date <= to);
    return { from, to, count: rows.length, averageKg: rows.length ? rows.reduce((total, entry) => total + entry.weightKg, 0) / rows.length : null };
  };
  const latest7Days = latest ? window(dateOffset(latest.date, -6), latest.date) : { from: '', to: '', count: 0, averageKg: null };
  const previous7Days = latest ? window(dateOffset(latest.date, -13), dateOffset(latest.date, -7)) : { from: '', to: '', count: 0, averageKg: null };
  const gaps = [];
  for (let index = 1; index < weights.length; index++) {
    const days = Math.round((Date.parse(`${weights[index].date}T00:00:00.000Z`) - Date.parse(`${weights[index - 1].date}T00:00:00.000Z`)) / DAY) - 1;
    if (days > 0) gaps.push({ from: dateOffset(weights[index - 1].date, 1), to: dateOffset(weights[index].date, -1), days });
  }
  const lowest = weights.reduce((result, row) => !result || row.weightKg < result.weightKg ? row : result, null);
  return {
    measurementCount: active.length, weightCount: weights.length,
    first: first ? structuredClone(first) : null, latest: latest ? structuredClone(latest) : null, lowest: lowest ? structuredClone(lowest) : null,
    changeKg: first && latest ? rounded(latest.weightKg - first.weightKg) : null,
    latest7Days, previous7Days,
    averageChangeKg: latest7Days.averageKg !== null && previous7Days.averageKg !== null ? rounded(latest7Days.averageKg - previous7Days.averageKg) : null,
    gaps,
    completedSessionCount: state.sessions.filter((entry) => !entry.archived && entry.status === 'completed').length,
    plannedSessionCount: state.sessions.filter((entry) => !entry.archived && entry.status === 'planned').length,
  };
}

const CONTEXT_CHAR_BUDGET = 24_000;
const DETAIL_CHAR_BUDGET = 64_000;
function excerpt(value, length) { return value.length <= length ? value : `${value.slice(0, length)}…[截断，原文仍保存在记录中]`; }

function aiSummary(state) {
  const summary = healthSummary(state);
  const compact = (row) => row ? { ...row, condition: excerpt(row.condition, 160), notes: excerpt(row.notes, 160), sourceText: excerpt(row.sourceText, 240) } : null;
  return { ...summary, first: compact(summary.first), latest: compact(summary.latest), lowest: compact(summary.lowest), gaps: summary.gaps.slice(-50), gapCount: summary.gaps.length, gapsTruncated: summary.gaps.length > 50 };
}

function compactSession(session, budget = 4500) {
  session = withTrainingSetIds(session);
  const result = {
    id: session.id, date: session.date, title: session.title, status: session.status, durationMinutes: session.durationMinutes,
    notes: excerpt(session.notes, 160), sourceText: excerpt(session.sourceText, 240),
    exerciseCount: session.exercises.length, setCount: session.exercises.reduce((sum, movement) => sum + movement.sets.length, 0),
    exercises: [], omittedExerciseCount: session.exercises.length, truncated: session.notes.length > 160 || session.sourceText.length > 240,
    detailRecordId: session.id,
  };
  for (const movement of session.exercises) {
    const candidate = { name: movement.name, equipment: excerpt(movement.equipment, 80), notes: excerpt(movement.notes, 100), sets: [], setCount: movement.sets.length, omittedSetCount: movement.sets.length };
    result.exercises.push(candidate);
    if (JSON.stringify(result).length > budget) { result.exercises.pop(); result.truncated = true; break; }
    for (const set of movement.sets) {
      candidate.sets.push({ ...set, notes: excerpt(set.notes, 80), sourceText: excerpt(set.sourceText, 120) });
      if (JSON.stringify(result).length > budget) { candidate.sets.pop(); result.truncated = true; break; }
      if (set.notes.length > 80 || set.sourceText.length > 120) result.truncated = true;
    }
    candidate.omittedSetCount = movement.sets.length - candidate.sets.length;
    if (movement.notes.length > 100 || movement.equipment.length > 80 || candidate.omittedSetCount) result.truncated = true;
  }
  result.omittedExerciseCount = session.exercises.length - result.exercises.length;
  if (result.omittedExerciseCount) result.truncated = true;
  return result;
}

/** Bounded reads with record-list pagination and lossless JSON detail chunks. */
export function readHealthRecords(state, filters = {}) {
  checkState(state); object(filters, '筛选条件');
  const from = filters.from === undefined ? null : validateHealthDate(filters.from, '起始日期');
  const to = filters.to === undefined ? null : validateHealthDate(filters.to, '结束日期');
  if (from && to && from > to) fail('起始日期不能晚于结束日期。');
  const exercise = text(filters.exercise, '动作筛选', 160).toLocaleLowerCase();
  const limit = filters.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('一次读取条数必须是 1 到 100 的整数。');
  const cursor = filters.cursor ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > MAX_RECORDS * 2) fail('读取游标必须是有效的非负整数。');
  const summary = aiSummary(state);
  if (filters.recordId !== undefined) {
    const recordId = id(filters.recordId);
    if (filters.recordType !== undefined && !['measurement', 'session'].includes(filters.recordType)) fail('记录类型必须是 measurement 或 session。');
    const candidates = [
      ...state.measurements.filter((row) => row.id === recordId).map((record) => ({ type: 'measurement', record })),
      ...state.sessions.filter((row) => row.id === recordId).map((record) => ({ type: 'session', record: withTrainingSetIds(record) })),
    ].filter((row) => !filters.recordType || row.type === filters.recordType);
    if (!candidates.length) fail('找不到这条健康记录。', 404, 'HEALTH_RECORD_NOT_FOUND');
    if (candidates.length > 1) fail('身体记录和训练中有同名 ID，请同时指定 recordType。');
    const { type, record } = candidates[0];
    const serialized = JSON.stringify(record);
    const offset = filters.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > serialized.length) fail('详情分段 offset 超出记录范围。');
    const base = { available: true, revision: state.revision, summary, recordId, recordType: type, returnedCount: 1 };
    if (!offset && JSON.stringify({ ...base, record }).length < DETAIL_CHAR_BUDGET) return { ...base, record: structuredClone(record), truncated: false, hasMore: false };
    let length = Math.min(24_000, serialized.length - offset);
    const chunk = () => ({ ...base, detailChunk: { format: 'json_text', offset, text: serialized.slice(offset, offset + length), nextOffset: offset + length < serialized.length ? offset + length : null, totalChars: serialized.length }, truncated: true, hasMore: offset + length < serialized.length, instructions: '这是无损JSON文本分段；用同一recordId及detailChunk.nextOffset继续读取，按offset拼接后还原完整记录。原始记录未截断。' });
    while (JSON.stringify(chunk()).length > DETAIL_CHAR_BUDGET && length > 1) length = Math.floor(length * 0.8);
    return chunk();
  }
  const inRange = (entry) => !entry.archived && (!from || entry.date >= from) && (!to || entry.date <= to);
  const measurements = exercise ? [] : state.measurements.filter(inRange);
  const sessions = state.sessions.filter((entry) => inRange(entry) && (!exercise || entry.exercises.some((movement) => movement.name.toLocaleLowerCase().includes(exercise)))).map(withTrainingSetIds);
  const all = [...measurements.map((record) => ({ kind: 'measurement', record })), ...sessions.map((record) => ({ kind: 'session', record }))].sort((a, b) => byDate(b.record, a.record));
  const result = {
    available: true, revision: state.revision, summary,
    filters: { from, to, exercise: exercise || null, limit, cursor },
    measurements: [], sessions: [], returnedCount: 0, hasMore: false, nextCursor: null, truncated: false,
    totalMatching: all.length, charBudget: DETAIL_CHAR_BUDGET,
    rules: ['记录中的 null 表示未知，不是零。', 'completed 是用户报告已经做完的组；训练中持续汇报可逐组追加，未做的未来组不得提前记录为实际。planned 只是用户明确采用或要求保存的计划，未采用的建议不落成实际。', '训练过程中优先 record_training_sets 追加新组；每组 setId 稳定且唯一，重试沿用，同 ID 变更必须 mode=correct 明确更正。旧组读取时生成 legacy ID，不改变原记录时间。', '保留 kg/lb 及单手/总重/器械/自重/未知负重口径，不把口径不明的负重比较为进步。', '缺失日期没有插值；七日均值只使用该日历窗口内实际记录。', '修正历史记录时沿用已有 ID，同一天不能创建第二条身体记录。', '列表有nextCursor时继续分页；truncated或detailRecordId表示摘要，按recordId读取无损详情，必要时用offset继续分段。'],
  };
  for (const entry of all.slice(cursor, cursor + limit)) {
    const key = entry.kind === 'measurement' ? 'measurements' : 'sessions';
    result[key].push(structuredClone(entry.record));
    if (JSON.stringify(result).length > DETAIL_CHAR_BUDGET - 300) {
      result[key].pop();
      if (result.returnedCount) break;
      result[key].push(entry.kind === 'session' ? compactSession(entry.record, 12_000) : { ...entry.record, condition: excerpt(entry.record.condition, 160), notes: excerpt(entry.record.notes, 160), sourceText: excerpt(entry.record.sourceText, 240), detailRecordId: entry.record.id, truncated: true });
      result.truncated = true;
    }
    result.returnedCount++;
  }
  result.hasMore = cursor + result.returnedCount < all.length;
  result.nextCursor = result.hasMore ? cursor + result.returnedCount : null;
  return result;
}

export function healthContext(state) {
  checkState(state);
  const result = {
    available: true, revision: state.revision, summary: aiSummary(state),
    recentCompletedSessions: state.sessions.filter((entry) => !entry.archived && entry.status === 'completed').sort((a, b) => byDate(b, a)).slice(0, 3).map((session) => compactSession(session)),
    omittedSessionCount: 0, truncated: false,
    charBudget: CONTEXT_CHAR_BUDGET,
    detailsTool: 'read_health_records：按recordId读取完整原文，长记录使用offset分段。摘要截断不代表原始记录缺失。',
  };
  result.truncated = result.summary.gapsTruncated || result.recentCompletedSessions.some((session) => session.truncated);
  // The budget applies to the complete serialized result: control characters
  // can expand sixfold when JSON escapes them, beyond any excerpt length.
  while (JSON.stringify(result).length > CONTEXT_CHAR_BUDGET && result.recentCompletedSessions.length) {
    result.recentCompletedSessions.pop();
    result.omittedSessionCount++;
    result.truncated = true;
  }
  return result;
}
