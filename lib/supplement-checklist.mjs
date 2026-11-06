/** Presentation only: all doses come from the saved daily plan. */
export const SUPPLEMENT_TIMING_SLOTS = Object.freeze([
  { id: 'breakfast', label: "Breakfast / After breakfast" },
  { id: 'lunch', label: "Lunch / After lunch" },
  { id: 'pre_workout', label: "Before training" },
  { id: 'post_workout', label: "After training" },
  { id: 'dinner', label: "Dinner / After dinner" },
  { id: 'bedtime', label: "Bedtime" },
  { id: 'other', label: "Other / Flexible timing" },
].map(slot => Object.freeze(slot)));

export const SUPPLEMENT_REQUIREMENT_LABELS = Object.freeze({ daily: "Daily", optional: "Optional", as_needed: "As needed", label_pending: "Label pending review" });

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
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 100000) throw new Error("Schedule files must not exceed 100 KB.");
  if (plan.status !== 'reserved') throw new Error("Supplement schedules can only be imported into confirmed, active menus.");
  let input;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error("This schedule could not be read. Choose a valid schedule file."); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error("The file must contain a supplement schedule.");
  if (Object.keys(input).some(key => !['planId', 'date', 'supplementDoses'].includes(key))) throw new Error("Only supplement schedules are accepted here, not full inventory, meals, or actual reports.");
  if (input.planId !== undefined && input.planId !== plan.id) throw new Error("This schedule belongs to another menu. Switch to its date before importing.");
  if (input.date !== undefined && input.date !== plan.date) throw new Error("The schedule date differs from the current menu. Switch dates before importing.");
  if (!Array.isArray(input.supplementDoses) || !input.supplementDoses.length || input.supplementDoses.length > 32) throw new Error("The schedule must contain 1 to 32 supplement doses.");
  const allowed = new Set(['id', 'itemId', 'plannedQuantity', 'unit', 'plannedMealId', 'plannedTime', 'plannedTimeText', 'sourceText', 'timingSlot', 'requirement', 'scheduled', 'instruction', 'trainingDayOnly']);
  const units = new Set(['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
  const ids = new Set(), existing = new Map((plan.supplementDoses ?? []).map(dose => [dose.id, dose]));
  const inventory = new Map((items ?? []).map(item => [item.id, item]));
  function string(value, label, limit, optional = false) {
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.length > limit || !optional && !value.trim()) throw new Error(`${label} is missing, invalid, or exceeds ${limit} characters.`);
    return value;
  }
  function boolean(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${label} must explicitly be yes or no.`);
    return value;
  }
  const rows = input.supplementDoses.map((raw, index) => {
    const prefix = `Dose ${index + 1}: `;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))) throw new Error(prefix + " contains unsupported content. Actual intake or other records cannot be imported here.");
    const id = string(raw.id, prefix + "Dose ID", 100).trim();
    const itemId = string(raw.itemId, prefix + "Supplement ID", 100).trim();
    if (ids.has(id)) throw new Error(prefix + "Duplicate dose ID. Check the schedule.");
    ids.add(id);
    const item = inventory.get(itemId), previous = existing.get(id);
    if (!item || item.category !== 'supplement') throw new Error(prefix + "Matching supplement inventory was not found. Refresh or check the schedule.");
    if (previous && previous.itemId !== itemId) throw new Error(prefix + "An existing dose cannot be replaced with another supplement. Check the dose ID.");
    const unit = raw.unit === undefined ? item.unit : string(raw.unit, prefix + "Quantity unit", 20);
    if (!units.has(unit) || unit !== item.unit) throw new Error(prefix + "Use the supplement's saved physical unit. mg or IU are not automatically converted.");
    const quantity = raw.plannedQuantity;
    if (quantity !== null && (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0.000001 || quantity > 1e9)) throw new Error(prefix + "Quantity must be an explicit positive number. Leave unknown quantities null.");
    const hasActual = previous && ((previous.actualEntries ?? []).length > 0 || previous.completionReportedAt !== null && previous.completionReportedAt !== undefined || previous.actualTime || previous.actualTimeText || (previous.reportHistory ?? []).length > 0);
    if (hasActual && (quantity !== previous.plannedQuantity || unit !== previous.unit)) throw new Error(prefix + "Actual intake already exists. Importing cannot change this dose's physical quantity.");
    const requirement = raw.requirement === undefined ? previous?.requirement ?? 'daily' : raw.requirement;
    if (!Object.hasOwn(SUPPLEMENT_REQUIREMENT_LABELS, requirement)) throw new Error(prefix + "Invalid requirement marker, such as optional or as needed.");
    const slot = raw.timingSlot === undefined ? previous?.timingSlot ?? 'other' : raw.timingSlot;
    if (!SUPPLEMENT_TIMING_SLOTS.some(value => value.id === slot)) throw new Error(prefix + "Invalid intake timing slot.");
    const scheduled = boolean(raw.scheduled, raw.requirement === undefined ? previous?.scheduled ?? requirement === 'daily' : requirement === 'daily', prefix + "Include in this day");
    const trainingDayOnly = boolean(raw.trainingDayOnly, previous?.trainingDayOnly ?? false, prefix + "Training days only");
    const instruction = string(raw.instruction === undefined ? previous?.instruction : raw.instruction, prefix + "Instructions", 1000, true);
    const plannedMealId = raw.plannedMealId == null ? null : string(raw.plannedMealId, prefix + "Linked meal", 100).trim();
    if (plannedMealId && !(plan.meals ?? []).some(meal => meal.id === plannedMealId)) throw new Error(prefix + "The linked meal is not in the current menu.");
    const plannedTime = raw.plannedTime == null ? null : raw.plannedTime;
    if (plannedTime !== null && (typeof plannedTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plannedTime))) throw new Error(prefix + "Invalid planned time. Leave it blank if unknown.");
    const dose = { id, itemId, plannedQuantity: quantity, unit, timingSlot: slot, requirement, scheduled, instruction, trainingDayOnly, plannedMealId, plannedTime, plannedTimeText: string(raw.plannedTimeText, prefix + "Time source text", 500, true), sourceText: string(raw.sourceText, prefix + "Source text", 10000, true) };
    return { dose, name: item.name, brand: item.brand || '', timingLabel: SUPPLEMENT_TIMING_SLOTS.find(value => value.id === slot).label, existing: !!previous };
  });
  if (new Set([...existing.keys(), ...ids]).size > 32) throw new Error("The merged schedule exceeds 32 doses per day. Existing omitted doses are preserved; review the routine first.");
  return { planId: plan.id, date: plan.date, supplementDoses: rows.map(row => row.dose), rows, typeCount: new Set(rows.map(row => row.dose.itemId)).size, newCount: rows.filter(row => !row.existing).length, updatedCount: rows.filter(row => row.existing).length, retainedCount: [...existing.keys()].filter(id => !ids.has(id)).length };
}
