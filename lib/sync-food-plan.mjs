import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { planNutritionLines, nutritionTotalsFromLines } from './diet-nutrition.mjs';
import { intakeEntryId, intakePlanFingerprint } from './intake-draft.mjs';
import { pruneRecipeGroups } from './recipe-groups.mjs';
import { normalizeActualRecipeGroups } from './actual-recipe-groups.mjs';

const rows = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
const units = new Set(['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
const nameKey = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const sameFood = (a, b) => a.itemId != null || b.itemId != null
  ? a.itemId != null && a.itemId === b.itemId : nameKey(a.name ?? a.nutritionSnapshot?.name) === nameKey(b.name ?? b.nutritionSnapshot?.name);
function hash(input) {
  const text = JSON.stringify(input); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 0x01000193); b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
function fingerprint(plan, items) {
  return 'sync-' + hash([intakePlanFingerprint(plan, items), rows(plan.meals).map(meal => [meal.recipeGroups ?? null, meal.actualRecipeGroups ?? null]), plan.intakeDraft ?? null]);
}
function anchoredLine(plan, meal, entry) {
  const candidates = rows(meal.plannedItems).filter(line => sameFood(line, entry) && line.unit === entry.unit);
  const explicit = candidates.filter(line => line.syncActualEntryIds?.includes(entry.id)
    || entry.intakeLineId === line.id || entry.id === intakeEntryId(plan.id, meal.id, line.id)
    || entry.id === 'planned-' + intakeEntryId(plan.id, meal.id, line.id).slice('ui-intake-'.length));
  if (explicit.length === 1) return { line: explicit[0], proven: true };
  const originals = candidates.filter(line => !line.id.startsWith('ui-transfer-'));
  return { line: originals.length === 1 ? originals[0] : candidates.length === 1 ? candidates[0] : null, proven: false };
}
// Preserve actual fallback snapshots, names, units and quantities exactly. The
// richer line identity guard catches changes which happen to cancel in totals.
function effectiveSignature(plan) {
  return planNutritionLines(plan).map(line => JSON.stringify([line.supplement, line.entityId,
    line.itemId, line.name, line.quantity, line.unit, line.snapshot])).sort();
}
function plannedSignature(lines) {
  const groups = new Map();
  for (const line of lines.filter(line => line.quantity !== 0)) {
    const snapshot = line.snapshot ?? line.nutritionSnapshot ?? null;
    const key = JSON.stringify([line.itemId ?? null, line.itemId == null ? nameKey(line.name ?? snapshot?.name) : '', line.unit,
      snapshot?.unit, snapshot?.gramsPerUnit, snapshot?.nutrition ?? null]);
    const previous = groups.get(key) ?? 0;
    groups.set(key, finite(previous) && finite(line.quantity) ? Math.round((previous + line.quantity) * 1e6) / 1e6 : null);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}
function changedRows(before, after) {
  const changes = [];
  for (const line of before) {
    const next = after.find(value => value.id === line.id);
    if (!next) changes.push({ kind: 'remove', lineId: line.id, name: line.name ?? line.nutritionSnapshot?.name ?? line.itemId ?? '', beforeQuantity: line.quantity, beforeUnit: line.unit, afterQuantity: null, afterUnit: line.unit });
    else if (!equal(line, next)) changes.push({ kind: 'update', lineId: line.id, name: next.name ?? next.nutritionSnapshot?.name ?? next.itemId ?? '', beforeQuantity: line.quantity, beforeUnit: line.unit, afterQuantity: next.quantity, afterUnit: next.unit });
  }
  for (const line of after) if (!before.some(value => value.id === line.id)) changes.push({ kind: 'add', lineId: line.id,
    name: line.name ?? line.nutritionSnapshot?.name ?? line.itemId ?? '', beforeQuantity: null, beforeUnit: line.unit, afterQuantity: line.quantity, afterUnit: line.unit });
  return changes;
}
function explicitPlannedGroups(plan, meal, candidate, effective, safeGroups) {
  const groups = normalizeActualRecipeGroups(meal.actualRecipeGroups, meal.actualEntries);
  const futureIds = new Set(effective.filter(line => line.origin === 'planned').map(line => line.lineId));
  const result = safeGroups.filter(group => group.lineIds.every(id => futureIds.has(id))), assigned = new Set();
  let unmapped = 0;
  for (const group of groups) {
    const entries = group.actualEntryIds.map(id => meal.actualEntries.find(entry => entry.id === id));
    const matches = entries.map(entry => anchoredLine(plan, candidate, entry));
    const lineIds = [...new Set(matches.map(match => match.line?.id))];
    const allMapped = matches.every(match => match.proven && match.line && match.line.quantity > 0)
      && lineIds.every(id => !assigned.has(id) && candidate.plannedItems.filter(line => line.id === id).length === 1);
    const exactAmounts = allMapped && lineIds.every(id => {
      const line = candidate.plannedItems.find(value => value.id === id);
      const linked = meal.actualEntries.filter(entry => {
        const match = anchoredLine(plan, candidate, entry); return match.proven && match.line?.id === id && entry.quantity !== 0;
      });
      return linked.every(entry => group.actualEntryIds.includes(entry.id) && finite(entry.quantity) && entry.unit === line.unit)
        && Math.abs(linked.reduce((sum, entry) => sum + entry.quantity, 0) - line.quantity) <= 0.000001;
    });
    if (!exactAmounts) { unmapped++; continue; }
    for (const id of lineIds) assigned.add(id);
    for (let index = result.length - 1; index >= 0; index--) if (result[index].lineIds.some(id => lineIds.includes(id))) result.splice(index, 1);
    let id = group.id;
    if (result.some(value => value.id === id)) id = 'actual-sync-' + hash([meal.id, group.id]);
    result.push({ id, name: group.name, lineIds, ...(group.portion === undefined ? {} : { portion: group.portion }) });
  }
  return { groups: pruneRecipeGroups(result, candidate.plannedItems), unmapped };
}
function candidateMeal(plan, meal, effective) {
  if (effective.some(line => !finite(line.quantity) || !units.has(line.unit))) throw Object.assign(new Error('This meal has unknown quantities or unsupported units. Review it before synchronizing.'), { code: 'SYNC_MEAL_REQUIRES_REVIEW' });
  const incoming = rows(meal.plannedItems).filter(line => line.id.startsWith('ui-transfer-'));
  const nextLines = incoming.map(copy), used = new Set(nextLines.map(line => line.id)), proven = new Set();
  const reported = effective.filter(line => line.origin === 'reported');
  const anchors = reported.map(line => {
    const entries = meal.state === 'in_progress' ? rows(meal.actualEntries).filter(entry => sameFood(line, entry) && line.unit === entry.unit)
      : rows(meal.actualEntries).filter(entry => entry.id === line.lineId);
    return { line, entries, associations: entries.map(entry => anchoredLine(plan, meal, entry)) };
  });
  for (const source of effective) {
    if (source.origin === 'planned') {
      const original = meal.plannedItems.find(line => line.id === source.lineId);
      if (!original) throw Object.assign(new Error('A planned source line is missing. Refresh before synchronizing.'), { code: 'SYNC_MEAL_REQUIRES_REVIEW' });
      if (!used.has(original.id)) { nextLines.push(copy(original)); used.add(original.id); }
      proven.add(original.id);
      continue;
    }
    const info = anchors.find(value => value.line === source), ids = info.entries.map(entry => entry.id).sort();
    const allSame = info.associations.length && info.associations.every(value => value.line && value.line.id === info.associations[0].line.id);
    const target = allSame ? info.associations[0].line : null;
    const uniqueTarget = target && anchors.filter(value => value.associations.some(match => match.line?.id === target.id)).length === 1;
    if (target?.id.startsWith('ui-transfer-')) {
      const kept = nextLines.find(line => line.id === target.id);
      kept.syncActualEntryIds = [...new Set([...(kept.syncActualEntryIds ?? []), ...ids])].sort();
      proven.add(kept.id);
      continue;
    }
    if (source.quantity === 0) {
      // A zero actual can still depend on a legacy planned snapshot. Keep a
      // hidden zero anchor rather than deleting its nutrition fallback.
      if (target && uniqueTarget && !used.has(target.id) && info.entries.some(entry => entry.nutritionSnapshot == null)) {
        nextLines.push({ ...copy(target), quantity: 0, syncActualEntryIds: ids }); used.add(target.id);
      }
      continue;
    }
    const existing = uniqueTarget && !used.has(target.id) ? target : null;
    const lineId = existing?.id ?? 'synced-food-' + hash([plan.id, meal.id, ids]);
    if (used.has(lineId)) throw Object.assign(new Error('Synchronized food line IDs conflict. Review the meal first.'), { code: 'SYNC_MEAL_REQUIRES_REVIEW' });
    const next = { ...(existing ? copy(existing) : {}), id: lineId, itemId: source.itemId ?? null,
      name: source.name ?? source.snapshot?.name ?? '', quantity: source.quantity, unit: source.unit,
      sourceText: existing?.sourceText ?? 'Synchronized from existing actual records; no new intake or inventory deduction.',
      nutritionSnapshot: copy(source.snapshot ?? null), syncActualEntryIds: ids };
    delete next.nutrition;
    nextLines.push(next); used.add(lineId);
    const soleFallback = existing && info.entries.length === 1
      && meal.plannedItems.filter(line => sameFood(line, source) && line.unit === source.unit).length === 1;
    if (existing && (info.associations.every(value => value.proven) || soleFallback)) proven.add(lineId);
  }
  if (nextLines.length > 100) throw Object.assign(new Error('The synchronized meal exceeds the food-line limit.'), { code: 'SYNC_MEAL_REQUIRES_REVIEW' });
  const candidate = { ...copy(meal), plannedItems: nextLines };
  const safeGroups = rows(meal.recipeGroups).filter(group => group.lineIds.every(id => proven.has(id) && nextLines.some(line => line.id === id && line.quantity > 0)));
  let unmappedActualGroups = 0;
  if (meal.actualRecipeGroups !== undefined) {
    const explicit = explicitPlannedGroups(plan, meal, candidate, effective, safeGroups);
    candidate.recipeGroups = explicit.groups; unmappedActualGroups = explicit.unmapped;
  } else if (meal.recipeGroups !== undefined) candidate.recipeGroups = pruneRecipeGroups(safeGroups, nextLines);
  if (!equal(plannedSignature(nextLines), plannedSignature(effective))) throw Object.assign(new Error('This meal cannot be synchronized without changing a saved nutrition basis or incoming remainder. It was left unchanged.'), { code: 'SYNC_MEAL_REQUIRES_REVIEW' });
  return { candidate, removedGroups: meal.actualRecipeGroups === undefined ? rows(meal.recipeGroups).length - safeGroups.length : 0, unmappedActualGroups };
}
function build(input, items) {
  const current = projectCurrentDietPlan(input ?? {}, items), plan = copy(current), issues = [], meals = [];
  const add = (code, message, mealId, severity = 'error') => issues.push({ code, message, ...(mealId ? { mealId } : {}), severity });
  if (current.format !== 'meals_v1') add('LEGACY_PLAN_CONFLICT', 'Only a structured current food menu can be synchronized.');
  if (!['draft', 'reserved'].includes(current.status)) add('PLAN_CLOSED', 'Cancelled or closed menus cannot synchronize future planned food.');
  if (current.intakeDraft) add('INTAKE_DRAFT_PENDING', 'An unsubmitted intake draft exists. Review or discard it before synchronizing the menu.');
  const beforeEffective = effectiveSignature(current), effective = planNutritionLines(current).filter(line => !line.supplement);
  for (const meal of rows(current.meals)) {
    const result = { mealId: meal.id, slot: meal.slot, title: meal.title, state: meal.state, supported: true, changed: false, changes: [],
      beforeTotals: nutritionTotalsFromLines(rows(meal.plannedItems).map(line => ({ snapshot: line.nutritionSnapshot, quantity: line.quantity, unit: line.unit, supplement: false }))), afterTotals: [] };
    result.afterTotals = copy(result.beforeTotals);
    if (['completed', 'in_progress'].includes(meal.state) && rows(meal.actualEntries).length) {
      try {
        const { candidate, removedGroups, unmappedActualGroups } = candidateMeal(current, meal, effective.filter(line => line.entityId === meal.id));
        const staged = { ...plan, meals: plan.meals.map(value => value.id === meal.id ? candidate : value) };
        if (!equal(effectiveSignature(staged), beforeEffective)) throw Object.assign(new Error('Synchronizing this meal would change effective food or an actual nutrition fallback. It was left unchanged.'), { code: 'SYNC_MEAL_REQUIRES_REVIEW' });
        result.changes = changedRows(meal.plannedItems, candidate.plannedItems);
        result.changed = !!result.changes.length || !equal(meal.recipeGroups, candidate.recipeGroups);
        result.afterTotals = nutritionTotalsFromLines(candidate.plannedItems.map(line => ({ snapshot: line.nutritionSnapshot, quantity: line.quantity, unit: line.unit, supplement: false })));
        if (result.changed) {
          plan.meals = staged.meals;
          if (removedGroups) add('SYNC_RECIPE_GROUPS_REMOVED', 'Recipe groups without proven actual-to-ingredient links will be removed. Their original definitions remain in menu revision history.', meal.id, 'warning');
          if (unmappedActualGroups) add('SYNC_ACTUAL_RECIPE_GROUPS_UNMAPPED', 'Some actual recipe groups cannot map completely to separate planned ingredient rows. Actual groups are preserved; no membership or portion was guessed.', meal.id, 'warning');
        }
      } catch (error) { result.supported = false; add(error.code ?? 'SYNC_MEAL_REQUIRES_REVIEW', error.message, meal.id, 'skip'); }
    }
    meals.push(result);
  }
  const noChange = !meals.some(meal => meal.changed), blocked = issues.some(issue => issue.severity === 'error');
  return { plan, preview: { fingerprint: fingerprint(current, items), canApply: !blocked && !noChange, noChange,
    hasIntakeDraft: !!current.intakeDraft, issues, meals } };
}
/** Preview only; personal checkmarks are never evidence for this operation. */
export function previewFoodPlanSync(plan, items = []) { return build(plan, items).preview; }
/** Return a plan-only candidate after the same preview and fingerprint guards. */
export function applyFoodPlanSync(plan, items, expectedFingerprint) {
  const result = build(plan, items);
  if (typeof expectedFingerprint !== 'string' || expectedFingerprint !== result.preview.fingerprint) throw Object.assign(new Error('The menu or actual records changed. Refresh the synchronization preview.'), { code: 'SYNC_FOOD_PLAN_STALE', status: 409 });
  const blocking = result.preview.issues.find(issue => issue.severity === 'error');
  if (blocking || !result.preview.canApply && result.preview.issues.some(issue => issue.severity === 'skip')) {
    const issue = blocking ?? result.preview.issues.find(issue => issue.severity === 'skip');
    throw Object.assign(new Error(issue.message), { code: issue.code, status: 409 });
  }
  return { plan: result.plan, preview: result.preview, noChange: result.preview.noChange };
}
