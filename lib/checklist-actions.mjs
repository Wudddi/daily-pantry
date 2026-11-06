import { intakeDraftView } from './intake-draft.mjs';

const round = value => Math.round(value * 1e6) / 1e6;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
const fail = (message, code = 'INVALID_CHECKLIST_ACTION') => { throw Object.assign(new Error(message), { code, status: 409 }); };
const knownSum = (rows, field) => rows.some(row => row[field] === null) ? null : round(rows.reduce((sum, row) => sum + row[field], 0));

function transferId(draftId, source, target, index) {
  const text = JSON.stringify([draftId, source, target, index]); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 0x01000193); b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b); }
  return 'checklist-transfer-' + (a >>> 0).toString(16) + (b >>> 0).toString(16);
}

/** A visual group still owns all original stable lines; no frozen snapshots are merged. */
export function groupChecklistRows(meal) {
  const groups = new Map();
  for (const row of meal?.rows ?? []) {
    const identity = JSON.stringify([row.itemId ?? row.name.normalize('NFKC').trim().toLowerCase(), row.unit]);
    let group = groups.get(identity);
    if (!group) { group = { id: identity, itemId: row.itemId, name: row.name, unit: row.unit, rows: [], lineIds: [] }; groups.set(identity, group); }
    group.rows.push(row); group.lineIds.push(row.lineId);
  }
  return [...groups.values()].map(group => ({ ...group,
    ...Object.fromEntries(['plannedQuantity', 'eatenQuantity', 'reportedQuantity', 'externalReportedQuantity', 'remainingQuantity'].map(field => [field, knownSum(group.rows, field)])),
    canEdit: group.rows.every(row => row.canEdit && !row.unknown), unknown: group.rows.some(row => row.unknown),
    issue: [...new Set(group.rows.map(row => row.issue).filter(Boolean))].join('; '),
  }));
}

/** Meal allocation is editable independently of its old completion report.
 * Receiving planned food never claims that the transferred portion was eaten. */
export function canReceiveChecklistFood(meal) {
  return !!meal && meal.state !== 'cancelled';
}

/** Recommend the usual meal-prep destination without restricting either direction. */
export function nextChecklistMealId(view, mealId) {
  const index = view.meals.findIndex(meal => meal.id === mealId);
  if (index < 0) return null;
  const choices = view.meals.filter(meal => meal.id !== mealId && canReceiveChecklistFood(meal));
  const preferredSlot = { breakfast: 'lunch', lunch: 'dinner', snack: 'dinner', dinner: 'lunch' }[view.meals[index].slot];
  return (choices.find(meal => meal.slot === preferredSlot) ?? choices[0])?.id ?? null;
}

function findMeal(view, id) {
  const meal = view.meals.find(value => value.id === id);
  if (!meal) fail("Meal not found. Refresh the menu.", 'MEAL_NOT_FOUND');
  if (meal.state === 'cancelled') fail("This meal was cancelled and cannot be recorded with quick actions.", 'INTAKE_CANCELLED_MEAL');
  return meal;
}
function findRows(meal, lineIds) {
  if (!Array.isArray(lineIds) || !lineIds.length || new Set(lineIds).size !== lineIds.length) fail("Select a specific food line.");
  const rows = lineIds.map(id => meal.rows.find(row => row.lineId === id));
  if (rows.some(row => !row)) fail("This food changed elsewhere. Refresh the menu.", 'INTAKE_LINE_NOT_FOUND');
  if (rows.some(row => !row.canEdit || row.unknown || !finite(row.plannedQuantity) || !finite(row.eatenQuantity))) {
    fail(rows.find(row => row.issue)?.issue || "This food's previous intake needs review; it cannot be assumed fully eaten.", 'INTAKE_ACTUAL_REQUIRES_REVIEW');
  }
  if (new Set(rows.map(row => row.unit)).size !== 1) fail("These foods use different units. Edit them separately.", 'INTAKE_UNIT_CONFLICT');
  return rows;
}
function putConsumed(draft, mealId, row, target, explicitCorrection) {
  const quantity = round(target);
  if (quantity === row.eatenQuantity) return;
  if (quantity < row.externalReportedQuantity && !explicitCorrection) {
    fail("This quantity is below the actual amount recorded by Chat. Confirm that this is a correction before saving.", 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED');
  }
  draft.consumed.push({ mealId, lineId: row.lineId, quantity, unit: row.unit,
    ...(quantity < row.externalReportedQuantity ? { correctExistingActuals: true } : {}) });
}

/** Keep already-reported distribution where possible; add only the missing portion. */
function distribute(rows, quantity, allowExternalCorrection) {
  const current = rows.map(row => row.eatenQuantity), total = round(current.reduce((a, b) => a + b, 0));
  if (quantity >= total) {
    let extra = round(quantity - total);
    for (let i = 0; i < rows.length && extra > 0; i++) {
      const addition = Math.min(extra, Math.max(0, round(rows[i].plannedQuantity - current[i])));
      current[i] = round(current[i] + addition); extra = round(extra - addition);
    }
    // Actual intake can exceed a plan; no silent capping or borrowing from another meal.
    if (extra > 0) current[0] = round(current[0] + extra);
  } else {
    const external = rows.reduce((sum, row) => sum + row.externalReportedQuantity, 0);
    if (quantity < round(external) && !allowExternalCorrection) fail("This quantity is below the actual amount recorded by Chat. Confirm the correction.", 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED');
    let reduction = round(total - quantity);
    // First reduce UI-owned portions while leaving every outside actual untouched.
    for (let i = rows.length - 1; i >= 0 && reduction > 0; i--) {
      const take = Math.min(reduction, Math.max(0, round(current[i] - rows[i].externalReportedQuantity)));
      current[i] = round(current[i] - take); reduction = round(reduction - take);
    }
    if (allowExternalCorrection) for (let i = rows.length - 1; i >= 0 && reduction > 0; i--) {
      const take = Math.min(reduction, current[i]); current[i] = round(current[i] - take); reduction = round(reduction - take);
    }
    if (reduction > 0) fail("This quantity cannot be changed while preserving existing actual records. Please review it.", 'INTAKE_ACTUAL_REQUIRES_REVIEW');
  }
  return current;
}

/** Build an atomic checklist command. The caller supplies one stable ID per user gesture/retry. */
export function buildChecklistAction(plan, items, action, { draftId } = {}) {
  const view = intakeDraftView(plan, items);
  if (view.hasDraft) fail("An unsubmitted intake draft exists. Continue or resolve it first; checkmarks cannot silently replace it.", 'INTAKE_DRAFT_PENDING');
  if (plan.status === 'cancelled') fail("This day was cancelled. Original records are read-only.", 'PLAN_CLOSED');
  if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > 100) fail("Provide a stable record ID for this operation.");
  if (!action || typeof action !== 'object') fail("Select a specific checklist or meal adjustment action.");
  const draft = { id: draftId, baseFingerprint: view.baseFingerprint, consumed: [], transfers: [], completedMealIds: [] };
  const sourceMeal = findMeal(view, action.type === 'move_remaining' ? action.fromMealId : action.mealId);
  const wholeMeal = action.type === 'complete_meal' || action.type === 'undo_meal';
  const rows = wholeMeal ? sourceMeal.rows.filter(row => row.plannedQuantity > 0 || row.reportedQuantity > 0)
    : findRows(sourceMeal, action.lineIds);
  // Whole meals may contain grams, millilitres and pieces; validate each line in
  // its own unit instead of treating the meal as a same-unit food group.
  if (wholeMeal) for (const row of rows) findRows(sourceMeal, [row.lineId]);

  function move(row, quantity, targetId) {
    if (quantity <= 0) return;
    if (plan.status === 'closed_with_actuals') fail("This day's remaining plan is closed. Future food allocations cannot be changed.", 'PLAN_CLOSED');
    const target = findMeal(view, targetId);
    if (target.id === sourceMeal.id) fail("Select another meal to receive this food.");
    draft.transfers.push({ id: transferId(draft.id, row.lineId, target.id, draft.transfers.length), fromMealId: sourceMeal.id,
      lineId: row.lineId, toMealId: target.id, quantity: round(quantity), unit: row.unit });
  }

  if (action.type === 'complete_item' || action.type === 'complete_meal') {
    for (const row of rows) putConsumed(draft, sourceMeal.id, row, Math.max(row.plannedQuantity, row.eatenQuantity), false);
    if (action.type === 'complete_meal' && sourceMeal.state !== 'completed') draft.completedMealIds.push(sourceMeal.id);
  } else if (action.type === 'undo_meal') {
    for (const row of rows) putConsumed(draft, sourceMeal.id, row, 0, action.correctExistingActuals === true);
  } else if (action.type === 'set_eaten' || action.type === 'undo_item') {
    const quantity = action.type === 'undo_item' ? 0 : action.quantity;
    if (!finite(quantity)) fail("Enter an explicit, nonnegative actual quantity eaten.");
    const distribution = distribute(rows, round(quantity), action.correctExistingActuals === true);
    rows.forEach((row, index) => putConsumed(draft, sourceMeal.id, row, distribution[index], action.correctExistingActuals === true));
    const target = action.moveRemainingToMealId === undefined ? null : action.moveRemainingToMealId;
    if (action.type === 'set_eaten' && target) rows.forEach((row, index) => move(row, Math.max(0, round(row.plannedQuantity - distribution[index])), target));
  } else if (action.type === 'move_remaining') {
    const remaining = knownSum(rows, 'remainingQuantity');
    const quantity = action.quantity === undefined ? remaining : action.quantity;
    if (!finite(quantity) || quantity <= 0 || quantity > remaining) fail("Only the uneaten remainder can be moved.", 'INTAKE_TRANSFER_EXCEEDS_REMAINING');
    let rest = round(quantity);
    for (const row of rows) {
      const portion = Math.min(rest, row.remainingQuantity); move(row, portion, action.toMealId); rest = round(rest - portion);
      if (rest === 0) break;
    }
  } else fail("This quick-record action is not supported.");

  let preview = intakeDraftView(plan, items, draft);
  if (action.type === 'complete_item' && sourceMeal.state !== 'completed') {
    const finished = preview.meals.find(meal => meal.id === sourceMeal.id);
    if (finished.rows.length && finished.rows.every(row => row.canEdit && !row.unknown && row.remainingQuantity === 0)) {
      draft.completedMealIds.push(sourceMeal.id); preview = intakeDraftView(plan, items, draft);
    }
  }
  if (preview.issues.length && !preview.canSubmit && preview.hasChanges) fail(preview.issues[0].message, preview.issues[0].code);
  return { draft, expectedDraftVersion: null, preview, noChange: !preview.hasChanges };
}
