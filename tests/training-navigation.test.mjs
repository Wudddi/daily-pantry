import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_PARTS, classifyExercise, filterSessionsByBodyPart, groupExercises, sessionBodyParts, buildMonthDays, shiftMonth } from '../lib/training-navigation.mjs';

test('global body-part filtering finds mixed sessions without trimming original exercises or sources', () => {
  const mixed = { id: 'mixed', date: '2026-10-12', status: 'completed', notes: '整场感受保留', sourceText: '胸和三头完整训练原文', exercises: [
    { name: '杠铃平板卧推', sets: [{ weight: 40, unit: 'kg', reps: 10, notes: '后两下吃力' }] },
    { name: '三头下压', sets: [{ weight: 50, unit: 'lb', reps: null, sourceText: '没报告次数' }] },
  ] };
  const chestOnly = { id: 'chest', date: '2026-10-12', exercises: [{ name: '上斜器械推胸', sets: [] }] };
  const backOnly = { id: 'back', date: '2026-10-13', exercises: [{ name: '高位下拉', sets: [] }] };
  const records = [mixed, chestOnly, backOnly], before = structuredClone(records);
  const result = filterSessionsByBodyPart(records, 'chest');
  assert.deepEqual(result.map(session => session.id), ['mixed', 'chest']);
  assert.equal(result[0], mixed);
  assert.equal(result[0].exercises[1], mixed.exercises[1], 'other muscles remain available to internal tabs and editing');
  assert.equal(result[0].sourceText, '胸和三头完整训练原文');
  assert.deepEqual(records, before);
  assert.deepEqual(filterSessionsByBodyPart(records, 'triceps').map(session => session.date), ['2026-10-12']);
});

test('global body-part filtering composes with month and completed/planned filters', () => {
  const records = [
    { id: 'oct-chest', date: '2026-10-12', status: 'completed', exercises: [{ name: '卧推' }] },
    { id: 'oct-back', date: '2026-10-12', status: 'completed', exercises: [{ name: '高位下拉' }] },
    { id: 'oct-planned', date: '2026-10-19', status: 'planned', exercises: [{ name: '卧推' }] },
    { id: 'sep-chest', date: '2026-09-29', status: 'completed', exercises: [{ name: '卧推' }] },
  ];
  const complete = records.filter(session => session.status === 'completed');
  const result = filterSessionsByBodyPart(complete, 'chest').filter(session => session.date.startsWith('2026-10-'));
  assert.deepEqual(result.map(session => session.id), ['oct-chest']);
  assert.equal(new Set(result.map(session => session.date)).size, 1);
  const planned = filterSessionsByBodyPart(records.filter(session => session.status === 'planned'), 'chest');
  assert.deepEqual(planned.map(session => session.id), ['oct-planned']);
});

test('all and other filters preserve empty records without guessing unreported muscles', () => {
  const records = [{ id: 'unknown', exercises: [{ name: '待核器械A', notes: '备注提到胸，不据此分类' }] }, { id: 'empty', exercises: [] }];
  const all = filterSessionsByBodyPart(records, 'all');
  assert.deepEqual(all, records);
  assert.notEqual(all, records);
  assert.equal(all[1], records[1]);
  assert.deepEqual(filterSessionsByBodyPart(records, 'other').map(session => session.id), ['unknown']);
  assert.deepEqual(filterSessionsByBodyPart(records, 'chest'), []);
  assert.deepEqual(filterSessionsByBodyPart(null, 'all'), []);
});

test('body-part navigation has the agreed fixed order and labels', () => {
  assert.deepEqual(BODY_PARTS, [
    { id: 'chest', label: '胸' }, { id: 'back', label: '背' },
    { id: 'shoulders', label: '肩' }, { id: 'biceps', label: '二头' },
    { id: 'triceps', label: '三头' }, { id: 'legs', label: '腿' },
    { id: 'abs', label: '腹部' }, { id: 'other', label: '其他' },
  ]);
});

test('the recorded exercise names classify by their primary navigation group', () => {
  const names = {
    back: ['宽距引体向上', '对握引体向上', '高位下拉', '窄距坐姿划船', '直臂下压', 'Straight-arm pulldown', '胸托划船'],
    biceps: ['坐姿交替哑铃弯举', '站姿杠铃弯举', 'Cross-body锤式弯举', 'Cross-body Hammer Curl'],
    shoulders: ['哑铃肩推', '侧平举', '反向蝴蝶机', 'Reverse Pec Deck', 'Face Pull绳索面拉'],
    abs: ['Rotary Torso旋转躯干机', '器械卷腹', '悬挂举腿', '前臂支撑举腿', '举腿'],
    legs: ['Hack Squat哈克深蹲', '腿弯举', 'RDL罗马尼亚硬拉', 'Leg Extension腿屈伸', '小腿提踵', '坐姿腿弯举Seated Leg Curl'],
    chest: ['杠铃平板卧推', '上斜器械推胸', 'Pec Deck夹胸', '上斜固定器械推胸'],
    triceps: ['Skull Crusher仰卧臂屈伸', 'V-Bar三头下压', '单哑铃颈后臂屈伸', '哑铃颈后臂屈伸', '绳索颈后臂屈伸', '哑铃过头臂屈伸', '平板杠铃臂屈伸Skull Crusher'],
  };
  for (const [expected, exercises] of Object.entries(names)) {
    for (const name of exercises) assert.equal(classifyExercise(name), expected, name);
  }
});

test('ambiguous names resolve before short chest, curl and pushdown cues', () => {
  assert.equal(classifyExercise('REVERSE PEC-DECK / 反向蝴蝶机'), 'shoulders');
  assert.equal(classifyExercise('Pec Deck Reverse'), 'shoulders');
  assert.equal(classifyExercise('Ｐｅｃ Ｄｅｃｋ 夹胸'), 'chest');
  assert.equal(classifyExercise('绳索直臂下压（不是三头下压）'), 'back');
  assert.equal(classifyExercise('V-Bar Triceps Pushdown'), 'triceps');
  assert.equal(classifyExercise('坐姿腿弯举 / Seated Leg Curl'), 'legs');
  assert.equal(classifyExercise('Seated alternating dumbbell curls'), 'biceps');
  assert.equal(classifyExercise('Face—Pull'), 'shoulders');
});

test('the actual seated neutral-grip row retains its grip-test wording and training facts', () => {
  const exercise = {
    name: '坐姿对握划船（测试）',
    sets: [{ weight: 72, unit: 'lb', reps: null, sourceText: '换对握试了一组，次数没报' }],
  };
  const before = structuredClone(exercise);
  const grouped = groupExercises([exercise]);
  assert.equal(classifyExercise(exercise.name), 'back');
  assert.equal(grouped[0].label, '背');
  assert.equal(grouped[0].exercises[0].exercise, exercise);
  assert.equal(grouped[0].exercises[0].index, 0);
  assert.deepEqual(exercise, before);
  assert.equal(classifyExercise('有氧划船机'), 'other');
});

test('unrecognised names stay in other instead of guessing from generic push or pull words', () => {
  for (const name of ['待核器械A', '拉伸放松', '推', '拉', '手腕弯举', '', null, undefined, 42]) {
    assert.equal(classifyExercise(name), 'other');
  }
});

test('grouping keeps every original object, original index and pound-valued set unchanged', () => {
  const original = [
    { name: 'Skull Crusher仰卧臂屈伸', sets: [{ weight: 50, unit: 'lb', reps: 4, notes: '测试了4下，吃力' }] },
    { name: '待核动作', notes: '保留原话，不能因备注胸而推断', sets: [{ weight: null, unit: null, reps: null }] },
    { name: 'Pec Deck夹胸', sets: [{ weight: 72, unit: 'lb', reps: null, sourceText: '72磅，8到9下，不确定' }] },
    { name: '反向蝴蝶机', sets: [] },
    { name: '上斜器械推胸', sets: [{ weight: 40, unit: 'kg', reps: 10 }] },
  ];
  const before = structuredClone(original);
  for (const exercise of original) {
    exercise.sets.forEach(Object.freeze);
    Object.freeze(exercise.sets);
    Object.freeze(exercise);
  }
  Object.freeze(original);
  const groups = groupExercises(original);
  assert.deepEqual(groups.map(({ id }) => id), ['chest', 'shoulders', 'triceps', 'other']);
  assert.deepEqual(groups.map(({ exercises }) => exercises.map(({ index }) => index)), [[2, 4], [3], [0], [1]]);
  const entries = groups.flatMap(({ exercises }) => exercises);
  assert.equal(entries.length, original.length);
  for (const entry of entries) assert.equal(entry.exercise, original[entry.index]);
  assert.equal(groups[2].exercises[0].exercise.sets[0].unit, 'lb');
  assert.deepEqual(original, before);
});

test('session labels are unique in fixed order and do not use titles or status as exercise facts', () => {
  const exercises = [{ name: '哑铃弯举' }, { name: '坐姿交替哑铃弯举' }, { name: '高位下拉' }];
  const planned = { title: '胸与腿训练计划', status: 'planned', exercises };
  const completed = { title: '实际训练', status: 'completed', exercises };
  assert.deepEqual(sessionBodyParts(planned), ['背', '二头']);
  assert.deepEqual(sessionBodyParts(completed), ['背', '二头']);
  assert.equal(planned.status, 'planned');
  assert.deepEqual(groupExercises([]), []);
  assert.deepEqual(sessionBodyParts({ title: '胸', exercises: [] }), []);
  assert.deepEqual(sessionBodyParts(undefined), []);
});

test('February observes leap years including Gregorian century rules', () => {
  const dates = (month) => buildMonthDays(month).filter(({ date }) => date !== null);
  assert.equal(dates('2024-02').length, 29);
  assert.equal(dates('2024-02').at(-1).date, '2024-02-29');
  assert.equal(dates('2025-02').length, 28);
  assert.equal(dates('1900-02').length, 28);
  assert.equal(dates('2000-02').length, 29);
});

test('calendar is always 42 cells, Monday-first and blank outside the requested month', () => {
  for (const [month, offset, days] of [['2026-01', 3, 31], ['2026-03', 6, 31], ['2021-02', 0, 28], ['2024-02', 3, 29]]) {
    const cells = buildMonthDays(month);
    assert.equal(cells.length, 42);
    assert.equal(cells[offset].date, `${month}-01`);
    assert.equal(cells[offset].day, 1);
    assert.equal(cells[offset + days - 1].date, `${month}-${days}`);
    assert.equal(cells.filter(({ date }) => date !== null).length, days);
    for (const [index, cell] of cells.entries()) {
      if (index < offset || index >= offset + days) assert.deepEqual(cell, { date: null, day: null });
    }
  }
});

test('calendar years 0001 through 0099 do not become 1901 through 1999', () => {
  assert.deepEqual(buildMonthDays('0001-01')[0], { date: '0001-01-01', day: 1 });
  assert.equal(buildMonthDays('0004-02').filter(({ date }) => date !== null).length, 29);
  assert.equal(buildMonthDays('0099-12').find(({ day }) => day === 31).date, '0099-12-31');
  assert.equal(buildMonthDays('9999-12').find(({ day }) => day === 31).date, '9999-12-31');
});

test('calendar does not change with local timezone or a daylight-saving transition', () => {
  const previous = process.env.TZ;
  try {
    const expected = buildMonthDays('2026-03');
    for (const zone of ['America/Toronto', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      assert.deepEqual(buildMonthDays('2026-03'), expected);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('month shifts cross years and accept larger integer offsets without day rollover', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2024-02', 12), '2025-02');
  assert.equal(shiftMonth('2026-03', -27), '2023-12');
  assert.equal(shiftMonth('2026-10', 0), '2026-10');
  assert.equal(shiftMonth('0099-12', 1), '0100-01');
});

test('month shifting clamps at four-digit year boundaries', () => {
  assert.equal(shiftMonth('0001-01', -1), '0001-01');
  assert.equal(shiftMonth('9999-12', 1), '9999-12');
  assert.equal(shiftMonth('2026-10', Number.MAX_SAFE_INTEGER), '9999-12');
  assert.equal(shiftMonth('2026-10', -Number.MAX_SAFE_INTEGER), '0001-01');
});

test('malformed months and non-integer offsets are rejected rather than silently normalised', () => {
  for (const month of ['', '2026-1', '2026-00', '2026-13', '0000-01', '10000-01', ' 2026-01', '2026-01-01', null, 202601]) {
    assert.throws(() => buildMonthDays(month), RangeError);
    assert.throws(() => shiftMonth(month, 1), RangeError);
  }
  for (const delta of [0.5, NaN, Infinity, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => shiftMonth('2026-10', delta), RangeError);
  }
});
