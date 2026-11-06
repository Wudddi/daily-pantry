import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { intakeEntryId } from './intake-draft.mjs';

const rows = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const key = move => JSON.stringify([move.sourceMealId, move.sourceKind, move.sourceId]);
const kinds = new Set(['planned', 'actual']);
const nameKey = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const sameFood = (a, b) => a.itemId != null || b.itemId != null
  ? a.itemId != null && a.itemId === b.itemId : nameKey(a.name ?? a.nutritionSnapshot?.name) === nameKey(b.name ?? b.nutritionSnapshot?.name);
function fail(message, code = 'INVALID_FOOD_LAYOUT', status = 400) { throw Object.assign(new Error(message), { code, status }); }
function id(value, limit = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail('Food layout identifiers exceed the supported source ID length.');
  return value.trim();
}
function hash(value) {
  const text = JSON.stringify(value); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 0x01000193); b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
function validMove(plan, value, requireReferences = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(field => !['sourceMealId', 'sourceKind', 'sourceId', 'targetMealId'].includes(field))) fail('Food layout moves contain unsupported fields.');
  if (!kinds.has(value.sourceKind)) fail('Food layout sourceKind must be planned or actual.');
  const sourceMealId = id(value.sourceMealId), sourceId = id(value.sourceId, value.sourceKind === 'actual' ? 400 : 100), targetMealId = id(value.targetMealId);
  const source = rows(plan.meals).find(meal => meal.id === sourceMealId);
  if (requireReferences && (!source || !rows(plan.meals).some(meal => meal.id === targetMealId))) fail('Both layout meals must exist in this same menu.');
  const available = value.sourceKind === 'planned' ? rows(source?.plannedItems) : rows(source?.actualEntries);
  if (requireReferences && !available.some(entry => entry.id === sourceId)) fail('The food layout source no longer exists. Refresh the current menu.');
  return { sourceMealId, sourceKind: value.sourceKind, sourceId, targetMealId };
}

/** Saved placement is independent from physical intake and accounting source. */
export function foodLayoutTarget(plan, sourceMeal, sourceKind, sourceId) {
  const sourceMealId = typeof sourceMeal === 'string' ? sourceMeal : sourceMeal?.id;
  const override = rows(plan?.foodLayoutOverrides).find(value => value.sourceMealId === sourceMealId
    && value.sourceKind === sourceKind && value.sourceId === sourceId);
  return override && rows(plan?.meals).some(meal => meal.id === override.targetMealId) ? override.targetMealId : sourceMealId;
}

/** Fingerprint includes identities and proven links, never personal check state. */
export function foodLayoutFingerprint(input) {
  const plan = projectCurrentDietPlan(input ?? {});
  return 'layout-' + hash([plan.id, rows(plan.meals).map(meal => [meal.id,
    rows(meal.plannedItems).map(line => [line.id, line.itemId, line.syncActualEntryIds ?? null]),
    rows(meal.actualEntries).map(entry => [entry.id, entry.itemId, entry.intakeLineId ?? null]),
    meal.recipeGroups ?? null, meal.actualRecipeGroups ?? null]), plan.foodLayoutOverrides ?? null]);
}

function provenPlannedSource(plan, meal, entry) {
  const candidates = rows(meal.plannedItems).filter(line => sameFood(line, entry));
  if (entry.intakeLineId) {
    const linked = candidates.find(line => line.id === entry.intakeLineId);
    if (linked) return linked;
  }
  const synced = candidates.filter(line => line.syncActualEntryIds?.includes(entry.id));
  if (synced.length) return synced.length === 1 ? synced[0] : null;
  const linked = candidates.filter(line => entry.id === intakeEntryId(plan.id, meal.id, line.id)
    || entry.id === 'planned-' + intakeEntryId(plan.id, meal.id, line.id).slice('ui-intake-'.length));
  return linked.length === 1 ? linked[0] : null;
}

/** Metadata only: no source row, quantity, completion, reminder or stock change.
 * Explicit actual moves win over automatic links in the same batch. */
export function applyFoodLayoutMoves(input, moves, at, expectedFingerprint) {
  const plan = projectCurrentDietPlan(input ?? {});
  if (plan.format !== 'meals_v1') fail('A structured menu is required for food layout.');
  if (expectedFingerprint !== undefined && (typeof expectedFingerprint !== 'string' || expectedFingerprint !== foodLayoutFingerprint(plan))) {
    fail('The food layout or its source records changed. Refresh before moving food.', 'FOOD_LAYOUT_STALE', 409);
  }
  if (!Array.isArray(moves) || moves.length > 100) fail('Provide at most 100 food layout moves.');
  const explicit = moves.map(move => validMove(plan, move)), seen = new Set();
  for (const move of explicit) { if (seen.has(key(move))) fail('The same food layout source cannot be moved twice in one request.'); seen.add(key(move)); }
  if (plan.foodLayoutOverrides !== undefined && !Array.isArray(plan.foodLayoutOverrides)) fail('Saved food layout requires review.', 'FOOD_LAYOUT_REQUIRES_REVIEW', 409);
  const existing = new Map();
  for (const value of rows(plan.foodLayoutOverrides)) {
    // Stale placements from removed menu rows are inert historical metadata;
    // they must not block moving a different, valid current row.
    const saved = validMove(plan, value, false);
    if (existing.has(key(saved))) fail('Saved food layout has duplicate source records.', 'FOOD_LAYOUT_REQUIRES_REVIEW', 409);
    if (saved.targetMealId !== saved.sourceMealId) existing.set(key(saved), saved);
  }
  const intended = new Map();
  for (const move of explicit.filter(move => move.sourceKind === 'planned')) {
    const meal = plan.meals.find(meal => meal.id === move.sourceMealId);
    for (const entry of rows(meal.actualEntries)) if (provenPlannedSource(plan, meal, entry)?.id === move.sourceId) {
      const actualMove = { ...move, sourceKind: 'actual', sourceId: entry.id };
      intended.set(key(actualMove), actualMove);
    }
  }
  for (const move of explicit) intended.set(key(move), move);
  const changes = [];
  for (const [sourceKey, move] of intended) {
    const previousTargetMealId = existing.get(sourceKey)?.targetMealId ?? move.sourceMealId;
    if (previousTargetMealId === move.targetMealId) continue;
    if (move.targetMealId === move.sourceMealId) existing.delete(sourceKey); else existing.set(sourceKey, move);
    changes.push({ ...move, previousTargetMealId });
  }
  if (!changes.length) return { plan: input, changed: false, moves: [] };
  const history = plan.foodLayoutHistory ?? [];
  if (!Array.isArray(history) || history.length >= 2000) fail('Food layout history requires review before another edit.', 'FOOD_LAYOUT_HISTORY_LIMIT', 409);
  const next = copy(input);
  next.foodLayoutOverrides = [...existing.values()].sort((a, b) => key(a).localeCompare(key(b)));
  next.foodLayoutHistory = [...copy(history), { at, moves: changes }];
  return { plan: next, changed: true, moves: changes };
}
