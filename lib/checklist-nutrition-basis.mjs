import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { planNutritionLines, nutritionTotalsFromLines } from './diet-nutrition.mjs';

const keys = ['kcal', 'protein', 'carbs', 'fat'];
const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = value => Math.round(value * 1e6) / 1e6;
const totalFor = (totals, key) => totals.find(total => total.key === key);
const complete = total => !!total && finite(total.value) && !total.partial && !total.supplementPartial;

// Use precisely the planned food portions represented by personal checkmarks.
// Neither checkmark state nor reported actuals participates in this baseline.
function plannedFoodLines(meal) {
  return rows(meal.plannedItems).filter(line => !finite(line.quantity) || line.quantity > 0).map(line => ({
    snapshot: line.nutritionSnapshot ?? null, quantity: line.quantity, unit: line.unit,
    itemId: line.itemId ?? null, name: line.name ?? line.nutritionSnapshot?.name ?? '',
    entityId: meal.id, lineId: line.id, supplement: false, origin: 'planned',
  }));
}

function difference(planned, effective) {
  return keys.map(key => {
    const before = totalFor(planned, key), after = totalFor(effective, key);
    const known = complete(before) && complete(after);
    const value = known ? round(after.value - before.value) : null;
    return {
      key, value, knownCount: known ? 1 : 0,
      missing: (before?.missing ?? 0) + (after?.missing ?? 0),
      supplementMissing: (before?.supplementMissing ?? 0) + (after?.supplementMissing ?? 0),
      estimated: !!before?.estimated || !!after?.estimated,
      partial: !known || !!before?.partial || !!after?.partial,
      supplementPartial: !!before?.supplementPartial || !!after?.supplementPartial,
      complete: known, completeValue: value, source: 'food_basis_difference',
    };
  });
}

function sameCoverageAndValue(left, right) {
  if (!left || !right) return false;
  const sameValue = left.value === null && right.value === null
    || finite(left.value) && finite(right.value) && Math.abs(left.value - right.value) <= 0.000002;
  return sameValue && !!left.partial === !!right.partial
    && !!left.supplementPartial === !!right.supplementPartial;
}

/** Explain two existing display bases without editing either one.
 * The personal checklist remains planned food only. Effective food uses the
 * shared actual/retained-plan engine; supplements are counted separately.
 * Supplied header totals are checked, never overwritten or forced to agree.
 */
export function checklistNutritionBasis(input, inventoryItems = [], { headerTotals } = {}) {
  const plan = projectCurrentDietPlan(input ?? {}, inventoryItems);
  const planned = rows(plan.meals).flatMap(plannedFoodLines);
  const effective = planNutritionLines(plan);
  const food = effective.filter(line => !line.supplement);
  const supplement = effective.filter(line => line.supplement);
  const plannedFoodTotals = nutritionTotalsFromLines(planned, 'personal_planned_food');
  const effectiveFoodTotals = nutritionTotalsFromLines(food);
  const supplementTotals = nutritionTotalsFromLines(supplement);
  const totalTotals = nutritionTotalsFromLines(effective);
  const foodDelta = difference(plannedFoodTotals, effectiveFoodTotals);
  const meals = rows(plan.meals).map(meal => {
    const plannedFoodTotals = nutritionTotalsFromLines(planned.filter(line => line.entityId === meal.id), 'personal_planned_food');
    const effectiveFoodTotals = nutritionTotalsFromLines(food.filter(line => line.entityId === meal.id));
    return { mealId: meal.id, state: meal.state, plannedFoodTotals, effectiveFoodTotals,
      foodDelta: difference(plannedFoodTotals, effectiveFoodTotals) };
  });
  const provided = headerTotals !== undefined;
  const displayed = provided ? rows(headerTotals) : totalTotals;
  const byNutrient = keys.map(key => ({ key,
    matches: sameCoverageAndValue(totalFor(displayed, key), totalFor(totalTotals, key)) }));
  const matches = byNutrient.every(total => total.matches);
  // Legacy evidence may fill missing historical values in resolveDietDays. An
  // equal number alone must not reattribute that evidence to current snapshots.
  const historyBasis = provided && displayed.some(total => /history/i.test(total.source ?? ''));
  const calorieFoodKnown = totalFor(foodDelta, 'kcal')?.complete === true;
  const supplementCaloriesKnown = finite(totalFor(supplementTotals, 'kcal')?.value);
  const reason = historyBasis ? 'history_evidence' : !matches ? 'header_mismatch'
    : !calorieFoodKnown ? 'incomplete_food_basis'
      : !supplementCaloriesKnown ? 'unknown_supplement_basis' : null;
  return { plannedFoodTotals, effectiveFoodTotals, supplementTotals, totalTotals, foodDelta, meals,
    headerComparison: { provided, matches, byNutrient, historyBasis,
      canReconcile: reason === null, reason } };
}
