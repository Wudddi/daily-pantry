import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { intakeDraftView, intakePlanFingerprint, intakeTransferLineId } from './intake-draft.mjs';
import { normalizeRecipeGroups, pruneRecipeGroups } from './recipe-groups.mjs';

const rows = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const round = value => Math.round(value * 1e6) / 1e6;
const finite = value => typeof value === 'number' && Number.isFinite(value);
function fail(message, code = 'INVALID_RECIPE_GROUP_ACTION', status = 409) { throw Object.assign(new Error(message), { code, status }); }
function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail(label + " is invalid.");
  return value.trim();
}
function hash(input) {
  const value = JSON.stringify(input); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) { a = Math.imul(a ^ value.charCodeAt(index), 0x01000193); b = Math.imul(b ^ value.charCodeAt(index), 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
function select(plan, mealId, groupId) {
  const meal = rows(plan.meals).find(value => value.id === identifier(mealId, "Meal ID"));
  const group = rows(meal?.recipeGroups).find(value => value.id === identifier(groupId, "Recipe ID"));
  if (!meal || !group) fail("This recipe or meal changed. Refresh before adjusting it.", 'RECIPE_GROUP_NOT_FOUND', 404);
  return { meal, group };
}
function fingerprint(plan, items, meal, group) {
  return 'recipe-' + hash([intakePlanFingerprint(plan, items), meal.id, group]);
}

/** Actual quantities come from stable intake associations. Personal marks and
 * unsubmitted drafts never become intake or reduce a group's movable amount. */
export function recipeGroupEditView(input, items = [], mealId, groupId) {
  const plan = projectCurrentDietPlan(input, items), { meal, group } = select(plan, mealId, groupId);
  const view = intakeDraftView(plan, items, null), source = view.meals.find(value => value.id === meal.id);
  const issues = [], addIssue = (code, message) => { if (!issues.some(issue => issue.code === code && issue.message === message)) issues.push({ code, message }); };
  if (!['draft', 'reserved'].includes(plan.status) || meal.state === 'cancelled') addIssue('PLAN_CLOSED', "Planned recipes cannot be adjusted in cancelled or closed menus.");
  if (!rows(meal.actualEntries).length && (meal.state === 'completed' || meal.actualTime != null || meal.actualTimeText
    || meal.completionReportedAt != null || rows(meal.reportHistory).length)) addIssue('RECIPE_ACTUAL_REQUIRES_REVIEW', "This meal has actual reports with missing quantities. Unreported does not mean uneaten.");
  const values = group.lineIds.map(lineId => {
    const line = rows(meal.plannedItems).find(value => value.id === lineId), row = source?.rows.find(value => value.lineId === lineId);
    if (!line || !row || !row.canEdit || row.unknown || !finite(row.reportedQuantity) || !finite(row.plannedQuantity) || row.plannedQuantity <= 0) {
      addIssue('RECIPE_ACTUAL_REQUIRES_REVIEW', row?.issue || "This recipe has unknown actual quantities or records that cannot be linked to ingredients. Review the recipe first.");
    }
    const ratio = finite(row?.plannedQuantity) && row.plannedQuantity > 0 ? (line?.quantity ?? 0) / row.plannedQuantity : 1;
    const eatenQuantity = finite(row?.reportedQuantity) ? round(row.reportedQuantity * ratio) : null;
    return { lineId, name: line?.name ?? line?.nutritionSnapshot?.name ?? line?.itemId ?? "Ingredient", quantity: line?.quantity ?? 0,
      unit: line?.unit ?? '', eatenQuantity, remainingQuantity: eatenQuantity === null ? null : round(Math.max(0, line.quantity - eatenQuantity)) };
  });
  return { fingerprint: fingerprint(plan, items, meal, group), portion: group.portion ?? 1, legacyBasis: !group.baseQuantities,
    canScale: !issues.length, canMove: !issues.length && values.some(row => row.remainingQuantity > 0), issues, rows: values,
    hasIntakeDraft: !!plan.intakeDraft };
}

function withBasis(group, meal) {
  return normalizeRecipeGroups([{ id: group.id, name: group.name, lineIds: group.lineIds, portion: group.portion ?? 1 }],
    meal.plannedItems, { previousGroups: [group] })[0];
}
function validAmount(value) {
  if (!finite(value) || value <= 0 || value > 1e9) fail("A scaled ingredient is too small or exceeds the quantity limit. Adjust the portion count.", 'RECIPE_QUANTITY_OUT_OF_RANGE');
  return value;
}
function rebasedGroup(group, lineIds, meal, portion) {
  return normalizeRecipeGroups([{ id: group.id, name: group.name, lineIds,
    portion: finite(portion) && portion >= 0.01 && portion <= 100 ? portion : 1 }], meal.plannedItems)[0];
}
function proportionalPart(group, mealBefore, changes) {
  const ratios = group.lineIds.map(lineId => {
    const before = mealBefore.plannedItems.find(line => line.id === lineId)?.quantity;
    return before > 0 ? (changes.get(lineId) ?? 0) / before : 0;
  });
  return ratios.length && ratios.every(value => Math.abs(value - ratios[0]) < 1e-6) ? (group.portion ?? 1) * ratios[0] : 1;
}

/** Detached atomic plan preview. It never calls report/settle, touches an
 * actual entry, clears a pending ledger, or submits the user's intake draft. */
export function previewRecipeGroupAction(input, items = [], action) {
  if (!action || !['scale_recipe_group', 'move_recipe_group'].includes(action.action)) fail("Unsupported recipe adjustment action.");
  const plan = copy(projectCurrentDietPlan(input, items));
  delete plan.draft;
  if (action.planId !== plan.id) fail("Recipe adjustments must reuse the current menu ID.");
  const mealId = action.action === 'scale_recipe_group' ? action.mealId : action.fromMealId;
  const { meal, group } = select(plan, mealId, action.groupId), view = recipeGroupEditView(plan, items, meal.id, group.id);
  if (action.expectedFingerprint !== undefined && action.expectedFingerprint !== view.fingerprint) fail("This recipe or its actual records changed. Refresh and review portions again.", 'RECIPE_GROUP_STALE');
  if (!view.canScale) fail(view.issues[0].message, view.issues[0].code);
  const changes = [];
  if (action.action === 'scale_recipe_group') {
    if (!finite(action.targetPortion) || action.targetPortion < 0.01 || action.targetPortion > 100) fail("Enter a portion count from 0.01 to 100.");
    const targetPortion = round(action.targetPortion);
    if (targetPortion === view.portion) return { plan, noChange: true, changes, sourceGroup: copy(group) };
    const basis = withBasis(group, meal);
    for (const row of view.rows) {
      const line = meal.plannedItems.find(value => value.id === row.lineId);
      const quantity = validAmount(round(basis.baseQuantities.find(value => value.lineId === row.lineId).quantity * targetPortion));
      if (quantity < row.eatenQuantity) fail("The reduced ingredient quantity is below the recorded eaten amount. Actual records are preserved; increase the portion or move only the remainder.", 'RECIPE_BELOW_ACTUAL');
      changes.push({ mealId: meal.id, lineId: line.id, name: row.name, unit: line.unit, before: line.quantity, after: quantity });
      line.quantity = quantity;
    }
    const sourceGroup = { ...basis, portion: targetPortion };
    meal.recipeGroups = meal.recipeGroups.map(value => value.id === group.id ? sourceGroup : value);
    return { plan, noChange: false, changes, sourceGroup: copy(sourceGroup) };
  }

  if (!finite(action.fractionOfRemaining) || action.fractionOfRemaining <= 0 || action.fractionOfRemaining > 1) fail("The transfer fraction must be greater than 0 and no more than 100%.");
  const transferId = identifier(action.transferId ?? action.operationId, "Transfer operation ID");
  const destination = plan.meals.find(value => value.id === identifier(action.toMealId, "Target meal ID"));
  if (!destination || destination.id === meal.id || destination.state === 'cancelled') fail("Choose another meal that is not cancelled.");
  const destinationGroupId = 'recipe-transfer-' + hash([plan.id, transferId, meal.id, group.id, destination.id]);
  if (rows(destination.recipeGroups).some(value => value.id === destinationGroupId)) fail("This recipe transfer was already applied. Refresh to view it; the food cannot be moved again.", 'RECIPE_TRANSFER_ALREADY_APPLIED');
  const beforeMeal = copy(meal), moved = new Map(), retained = new Map(), targetIds = [];
  for (const row of view.rows) {
    const line = meal.plannedItems.find(value => value.id === row.lineId), quantity = round(row.remainingQuantity * action.fractionOfRemaining);
    if (quantity <= 0) { retained.set(line.id, line.quantity); continue; }
    validAmount(quantity);
    const targetId = intakeTransferLineId(plan.id, transferId + ':' + line.id);
    if (plan.meals.some(value => value.plannedItems.some(existing => existing.id === targetId))) fail("The transfer target line already exists. Do not submit it twice.", 'RECIPE_TRANSFER_ALREADY_APPLIED');
    const after = round(line.quantity - quantity);
    if (after < row.eatenQuantity) fail("A transfer cannot move food already recorded as eaten.", 'RECIPE_BELOW_ACTUAL');
    moved.set(line.id, quantity); retained.set(line.id, after);
    destination.plannedItems.push({ ...copy(line), id: targetId, quantity }); targetIds.push(targetId);
    changes.push({ mealId: meal.id, lineId: line.id, name: row.name, unit: line.unit, before: line.quantity, after });
    changes.push({ mealId: destination.id, lineId: targetId, name: row.name, unit: line.unit, before: 0, after: quantity });
    line.quantity = after;
  }
  if (!targetIds.length) fail("This recipe has no remaining ingredients to move.", 'RECIPE_NO_REMAINING');
  if (destination.plannedItems.length > 100 || rows(destination.recipeGroups).length >= 20) fail("The target meal reached its food-line or recipe-group limit.");
  meal.plannedItems = meal.plannedItems.filter(line => line.quantity > 0);
  meal.recipeGroups = pruneRecipeGroups(meal.recipeGroups.filter(value => value.id !== group.id), meal.plannedItems);
  const retainedIds = group.lineIds.filter(lineId => retained.get(lineId) > 0);
  let sourceGroup;
  if (retainedIds.length) {
    sourceGroup = rebasedGroup(group, retainedIds, meal, proportionalPart(group, beforeMeal, retained));
    meal.recipeGroups.push(sourceGroup);
  }
  const destinationGroup = rebasedGroup({ id: destinationGroupId, name: group.name }, targetIds, destination,
    proportionalPart(group, beforeMeal, moved));
  destination.recipeGroups = [...rows(destination.recipeGroups), destinationGroup];
  return { plan, noChange: false, changes, ...(sourceGroup ? { sourceGroup: copy(sourceGroup) } : {}), destinationGroup: copy(destinationGroup) };
}
