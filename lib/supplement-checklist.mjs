/** Presentation only: all doses come from the saved daily plan. */
export const SUPPLEMENT_TIMING_SLOTS = Object.freeze([
  { id: 'breakfast', label: '早餐 / 早餐后' },
  { id: 'lunch', label: '午餐 / 午餐后' },
  { id: 'pre_workout', label: '训练前' },
  { id: 'post_workout', label: '训练后' },
  { id: 'dinner', label: '晚餐 / 晚餐后' },
  { id: 'bedtime', label: '睡前' },
  { id: 'other', label: '其他 / 时间灵活' },
].map(slot => Object.freeze(slot)));

export const SUPPLEMENT_REQUIREMENT_LABELS = Object.freeze({ daily: '每日安排', optional: '可选', as_needed: '按需', label_pending: '标签待核' });

/** A positive or explicitly unknown intake is a report of taking this dose. */
export function supplementCheckState(dose) {
  const entries = Array.isArray(dose?.actualEntries) ? dose.actualEntries : [];
  const taken = entries.filter(entry => entry.quantity === null || typeof entry.quantity === 'number' && Number.isFinite(entry.quantity) && entry.quantity > 0);
  return { checked: taken.length > 0, unknownQuantity: taken.some(entry => entry.quantity === null), hasReport: entries.length > 0 };
}

function timingSlot(dose, meals) {
  if (SUPPLEMENT_TIMING_SLOTS.some(slot => slot.id === dose.timingSlot)) return dose.timingSlot;
  const linked = dose.plannedMealId ? meals.find(meal => meal.id === dose.plannedMealId) : null;
  return ['breakfast', 'lunch', 'dinner'].includes(linked?.slot) ? linked.slot : 'other';
}

/** Optional/needed doses stay separate from scheduled daily-dose progress. */
export function buildSupplementChecklist(plan) {
  const groups = SUPPLEMENT_TIMING_SLOTS.map(slot => ({ ...slot, rows: [], requiredCount: 0, checkedRequiredCount: 0, optionalCount: 0 }));
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const dose of plan.supplementDoses ?? []) {
    const requirement = Object.hasOwn(SUPPLEMENT_REQUIREMENT_LABELS, dose.requirement ?? '') ? dose.requirement : 'daily';
    const scheduled = dose.scheduled ?? requirement === 'daily';
    const check = supplementCheckState(dose);
    const required = requirement === 'daily' && scheduled && dose.state !== 'cancelled';
    const selected = scheduled || check.checked;
    const group = byId.get(timingSlot(dose, plan.meals ?? []));
    group.rows.push({ dose, ...check, requirement, scheduled, required, selected });
    if (required) {
      group.requiredCount++;
      if (check.checked) group.checkedRequiredCount++;
    }
    if (requirement === 'optional' || requirement === 'as_needed') group.optionalCount++;
  }
  return {
    groups: groups.filter(group => group.rows.length > 0),
    requiredCount: groups.reduce((count, group) => count + group.requiredCount, 0),
    checkedRequiredCount: groups.reduce((count, group) => count + group.checkedRequiredCount, 0),
    optionalCount: groups.reduce((count, group) => count + group.optionalCount, 0),
  };
}

/** Validate a user-selected timetable; it cannot restore state or actual reports. */
export function parseSupplementTimetable(text, plan, items) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 100000) throw new Error('时间表文件不能超过 100 KB。');
  if (plan.status !== 'reserved') throw new Error('只能给已确认且仍生效的菜单导入补给时间表。');
  let input;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('无法读取这份时间表，请选择有效的时间表文件。'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('文件需要是一份补给时间表。');
  if (Object.keys(input).some(key => !['planId', 'date', 'supplementDoses'].includes(key))) throw new Error('这里只接受补给时间表，不能导入整份库存、三餐或实际报告。');
  if (input.planId !== undefined && input.planId !== plan.id) throw new Error('这份时间表对应另一份菜单，请切换到对应日期后再导入。');
  if (input.date !== undefined && input.date !== plan.date) throw new Error('时间表日期与当前菜单不一致，请切换日期后再导入。');
  if (!Array.isArray(input.supplementDoses) || !input.supplementDoses.length || input.supplementDoses.length > 32) throw new Error('时间表需要包含 1 至 32 个补给剂次。');
  const allowed = new Set(['id', 'itemId', 'plannedQuantity', 'unit', 'plannedMealId', 'plannedTime', 'plannedTimeText', 'sourceText', 'timingSlot', 'requirement', 'scheduled', 'instruction', 'trainingDayOnly']);
  const units = new Set(['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
  const ids = new Set(), existing = new Map((plan.supplementDoses ?? []).map(dose => [dose.id, dose]));
  const inventory = new Map((items ?? []).map(item => [item.id, item]));
  function string(value, label, limit, optional = false) {
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.length > limit || !optional && !value.trim()) throw new Error(`${label}缺失、无效或超过 ${limit} 字。`);
    return value;
  }
  function boolean(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${label}需要明确为是或否。`);
    return value;
  }
  const rows = input.supplementDoses.map((raw, index) => {
    const prefix = `第 ${index + 1} 个剂次：`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))) throw new Error(prefix + '包含不支持的内容，不能写入实际服用或其他记录。');
    const id = string(raw.id, prefix + '剂次编号', 100).trim();
    const itemId = string(raw.itemId, prefix + '补给编号', 100).trim();
    if (ids.has(id)) throw new Error(prefix + '剂次编号重复，请检查时间表。');
    ids.add(id);
    const item = inventory.get(itemId), previous = existing.get(id);
    if (!item || item.category !== 'supplement') throw new Error(prefix + '找不到对应的补给库存，请刷新或核对时间表。');
    if (previous && previous.itemId !== itemId) throw new Error(prefix + '已有剂次不能被替换成另一种补给，请核对剂次编号。');
    const unit = raw.unit === undefined ? item.unit : string(raw.unit, prefix + '用量单位', 20);
    if (!units.has(unit) || unit !== item.unit) throw new Error(prefix + '需使用该补给已保存的物理单位，不自动换算毫克或 IU。');
    const quantity = raw.plannedQuantity;
    if (quantity !== null && (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0.000001 || quantity > 1e9)) throw new Error(prefix + '用量须为明确的正数；未知请保留为空值。');
    const hasActual = previous && ((previous.actualEntries ?? []).length > 0 || previous.completionReportedAt !== null && previous.completionReportedAt !== undefined || previous.actualTime || previous.actualTimeText || (previous.reportHistory ?? []).length > 0);
    if (hasActual && (quantity !== previous.plannedQuantity || unit !== previous.unit)) throw new Error(prefix + '已有实际服用记录，不能通过导入更改这次的物理用量。');
    const requirement = raw.requirement === undefined ? previous?.requirement ?? 'daily' : raw.requirement;
    if (!Object.hasOwn(SUPPLEMENT_REQUIREMENT_LABELS, requirement)) throw new Error(prefix + '可选、按需等安排标记无效。');
    const slot = raw.timingSlot === undefined ? previous?.timingSlot ?? 'other' : raw.timingSlot;
    if (!SUPPLEMENT_TIMING_SLOTS.some(value => value.id === slot)) throw new Error(prefix + '服用时段无效。');
    const scheduled = boolean(raw.scheduled, raw.requirement === undefined ? previous?.scheduled ?? requirement === 'daily' : requirement === 'daily', prefix + '是否纳入当天');
    const trainingDayOnly = boolean(raw.trainingDayOnly, previous?.trainingDayOnly ?? false, prefix + '是否仅训练日');
    const instruction = string(raw.instruction === undefined ? previous?.instruction : raw.instruction, prefix + '用法说明', 1000, true);
    const plannedMealId = raw.plannedMealId == null ? null : string(raw.plannedMealId, prefix + '关联餐次', 100).trim();
    if (plannedMealId && !(plan.meals ?? []).some(meal => meal.id === plannedMealId)) throw new Error(prefix + '关联餐次不在当前菜单内。');
    const plannedTime = raw.plannedTime == null ? null : raw.plannedTime;
    if (plannedTime !== null && (typeof plannedTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plannedTime))) throw new Error(prefix + '计划时间无效，未知时请留空。');
    const dose = { id, itemId, plannedQuantity: quantity, unit, timingSlot: slot, requirement, scheduled, instruction, trainingDayOnly, plannedMealId, plannedTime, plannedTimeText: string(raw.plannedTimeText, prefix + '时间原话', 500, true), sourceText: string(raw.sourceText, prefix + '来源原话', 10000, true) };
    return { dose, name: item.name, brand: item.brand || '', timingLabel: SUPPLEMENT_TIMING_SLOTS.find(value => value.id === slot).label, existing: !!previous };
  });
  if (new Set([...existing.keys(), ...ids]).size > 32) throw new Error('合并后超过每天 32 个剂次；未列入的已有剂次会保留，请先核对安排。');
  return { planId: plan.id, date: plan.date, supplementDoses: rows.map(row => row.dose), rows, typeCount: new Set(rows.map(row => row.dose.itemId)).size, newCount: rows.filter(row => !row.existing).length, updatedCount: rows.filter(row => row.existing).length, retainedCount: [...existing.keys()].filter(id => !ids.has(id)).length };
}
