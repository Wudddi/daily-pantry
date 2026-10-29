/** Presentation-only helpers: names determine navigation, never training facts. */
export const BODY_PARTS = Object.freeze([
  { id: 'chest', label: '胸' },
  { id: 'back', label: '背' },
  { id: 'shoulders', label: '肩' },
  { id: 'biceps', label: '二头' },
  { id: 'triceps', label: '三头' },
  { id: 'legs', label: '腿' },
  { id: 'abs', label: '腹部' },
  { id: 'other', label: '其他' },
].map((part) => Object.freeze(part)));

function normalizedName(name) {
  return typeof name === 'string'
    ? name.normalize('NFKC').toLowerCase().replace(/[-_‐‑‒–—−]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

/** A single primary navigation group, without inferring secondary muscles. */
export function classifyExercise(name) {
  const value = normalizedName(name);
  if (!value) return 'other';

  // Resolve compound names before the shorter cues (Pec Deck, curl, pushdown).
  if (/反向蝴蝶|蝴蝶机反向|反向飞鸟|面拉|肩推|推肩|侧平举/.test(value)
    || /\b(?:shoulder\s+press|lateral\s+raises?|rear\s+delt(?:\s+fly)?|face\s*pulls?|reverse\s+fly)\b/.test(value)
    || (/\bpec\s*deck\b/.test(value) && /\breverse\b/.test(value))) return 'shoulders';

  if (/旋转躯干|躯干旋转|卷腹|举腿/.test(value)
    || /\b(?:rotary\s+torso|crunch(?:es)?|hanging\s+leg\s+raises?)\b/.test(value)) return 'abs';

  if (/哈克深蹲|深蹲|腿弯举|腿屈伸|罗马尼亚硬拉|小腿提踵|提踵/.test(value)
    || /\b(?:hack\s+squat|squats?|rdl|romanian\s+deadlift|leg\s+curls?|leg\s+extensions?|calf\s+raises?)\b/.test(value)) return 'legs';

  if (/直臂.{0,4}(?:下压|下拉)|引体向上|高位下拉|坐姿[^\n]*划船|胸托划船/.test(value)
    || /\b(?:straight\s+arm\s+(?:pull\s*downs?|push\s*downs?)|lat\s+pull\s*downs?|pull\s*ups?|chin\s*ups?|seated\s+rows?)\b/.test(value)) return 'back';

  if (/哑铃弯举|杠铃弯举|锤式弯举|肱二头|二头弯举/.test(value)
    || /\b(?:biceps?\s+curls?|dumbbell\s+curls?|barbell\s+curls?|hammer\s+curls?)\b/.test(value)) return 'biceps';

  if (/仰卧臂屈伸|臂屈伸|三头下压|肱三头/.test(value)
    || /\b(?:skull\s*crushers?|triceps?\s+(?:push\s*downs?|press\s*downs?|extensions?))\b/.test(value)
    || /\bv\s*bar\b.*(?:push\s*down|press\s*down|下压)/.test(value)) return 'triceps';

  if (/卧推|推胸|夹胸|正向蝴蝶机/.test(value)
    || /\b(?:bench\s+press|chest\s+press|chest\s+fly|pec\s*deck)\b/.test(value)) return 'chest';

  return 'other';
}

/** Preserve every entry and its original index; only wrappers and groups are new. */
export function groupExercises(exercises) {
  if (!Array.isArray(exercises)) return [];
  const groups = BODY_PARTS.map(({ id, label }) => ({ id, label, exercises: [] }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  exercises.forEach((exercise, index) => {
    byId.get(classifyExercise(exercise?.name)).exercises.push({ exercise, index });
  });
  return groups.filter((group) => group.exercises.length > 0);
}

export function sessionBodyParts(session) {
  return groupExercises(session?.exercises).map((group) => group.label);
}

/** Filter session references for navigation without trimming or changing records. */
export function filterSessionsByBodyPart(sessions, bodyPart = 'all') {
  if (!Array.isArray(sessions)) return [];
  if (bodyPart === 'all') return [...sessions];
  return sessions.filter(session => Array.isArray(session?.exercises)
    && session.exercises.some(exercise => classifyExercise(exercise?.name) === bodyPart));
}

function parseMonth(month) {
  const match = typeof month === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match || Number(match[1]) < 1) throw new RangeError('月份必须是 0001-01 至 9999-12 的 YYYY-MM。');
  return { year: Number(match[1]), month: Number(match[2]) };
}

/** Monday-first 6-week grid; neighbouring months deliberately have empty cells. */
export function buildMonthDays(month) {
  const parsed = parseMonth(month);
  const first = new Date(0);
  // Date.UTC(1, ...) means 1901; setUTCFullYear preserves years 0001–0099.
  first.setUTCFullYear(parsed.year, parsed.month - 1, 1);
  first.setUTCHours(0, 0, 0, 0);
  const offset = (first.getUTCDay() + 6) % 7;
  const leap = parsed.year % 4 === 0 && (parsed.year % 100 !== 0 || parsed.year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][parsed.month - 1];
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    return day >= 1 && day <= days
      ? { date: `${month}-${String(day).padStart(2, '0')}`, day }
      : { date: null, day: null };
  });
}

/** Shift by whole months, clamping only at the four-digit year boundaries. */
export function shiftMonth(month, delta) {
  const parsed = parseMonth(month);
  if (!Number.isSafeInteger(delta)) throw new RangeError('月份偏移必须是安全整数。');
  const index = (parsed.year - 1) * 12 + parsed.month - 1;
  const last = 9999 * 12 - 1;
  const shifted = delta <= -index ? 0 : delta >= last - index ? last : index + delta;
  return `${String(Math.floor(shifted / 12) + 1).padStart(4, '0')}-${String(shifted % 12 + 1).padStart(2, '0')}`;
}
