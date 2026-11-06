import { nutritionFactor, nutritionTotalsFromLines, planNutritionLines, transferredFoodRemainders } from './diet-nutrition.mjs';
import { mealExecutionView } from './diet-edit-read.mjs';
import { foodDisplayAmount } from './food-display-amount.mjs';

const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const issue = (code, message) => ({ code, message });

function sameFood(a, b) {
  return a.itemId != null || b.itemId != null
    ? a.itemId != null && a.itemId === b.itemId
    : !!nameKey(a.name) && nameKey(a.name) === nameKey(b.name);
}

function viewRows(lines, origin, notes = new Map(), actualProvenance = new Map()) {
  return lines.map((line, index) => {
    const totals = nutritionTotalsFromLines([line]);
    const nutrition = line.snapshot?.nutrition;
    const display = foodDisplayAmount(line);
    return {
      id: line.lineId ?? String(index), itemId: line.itemId ?? null,
      name: line.name || line.snapshot?.name || line.itemId || "Unnamed food",
      quantity: line.quantity, unit: line.unit, origin: origin ?? line.origin ?? 'planned',
      ...((origin ?? line.origin) === 'reported' ? {actualEntryIds:actualProvenance.get(line.lineId) ?? [line.lineId ?? String(index)]} : {}),
      displayQuantity: display.quantity, displayUnit: display.unit,
      totals, partial: totals.some(total => total.partial), estimated: totals.some(total => total.estimated),
      zero: line.quantity === 0, quantityUnknown: !finite(line.quantity),
      conversionMissing: finite(line.quantity) && line.quantity !== 0 && nutritionFactor(line.snapshot, line.quantity, line.unit) === null,
      nutritionSource: SOURCES.has(nutrition?.source) ? nutrition.source : 'unknown',
      nutrientSources: Object.fromEntries(KEYS.map(key => [key, finite(nutrition?.[key])
        ? SOURCES.has(nutrition.nutrientSources?.[key] ?? nutrition.source) ? nutrition.nutrientSources?.[key] ?? nutrition.source : 'unknown'
        : 'unknown'])),
      sourceNote: typeof nutrition?.sourceNote === 'string' ? nutrition.sourceNote : '',
      sourceText: typeof nutrition?.sourceText === 'string' ? nutrition.sourceText : '',
      remainingNote: notes.get(line.lineId) ?? '',
    };
  });
}

// Provenance for presentation only. Partial effective rows combine all actuals
// of the same food and unit under their first ID. Retain that complete identity
// set so recipe grouping cannot inherit only the first dish in an aggregate.
function effectiveActualProvenance(effective, actual, aggregate) {
  const result = new Map();
  for (const line of effective.filter(line => line.origin === 'reported')) {
    const contributors = aggregate ? actual.filter(entry => sameFood(entry,line) && entry.unit === line.unit)
      : actual.filter(entry => entry.lineId === line.lineId);
    const sum = contributors.every(entry => finite(entry.quantity))
      ? contributors.reduce((sum,entry) => sum+entry.quantity,0) : null;
    const sameAmount = line.quantity === sum || finite(line.quantity) && finite(sum) && Math.abs(line.quantity-sum) <= .000001;
    result.set(line.lineId, contributors.length && contributors[0].lineId === line.lineId && sameAmount
      ? contributors.map(entry => entry.lineId) : []);
  }
  return result;
}

function differentNutritionBasis(a, b) {
  const aRatio = nutritionFactor(a.snapshot, 1, a.unit), bRatio = nutritionFactor(b.snapshot, 1, b.unit);
  return KEYS.some(key => {
    const av = aRatio !== null && finite(a.snapshot?.nutrition?.[key]) ? aRatio * a.snapshot.nutrition[key] : null;
    const bv = bRatio !== null && finite(b.snapshot?.nutrition?.[key]) ? bRatio * b.snapshot.nutrition[key] : null;
    return av === null || bv === null ? av !== bv : Math.abs(av - bv) > 0.000001;
  });
}

/**
 * Native meals_v1 display adapter. Aggregation and unit conversion belong to the
 * existing daily algorithm; presentation sections must never be added again.
 * No current inventory, history-day totals or pending draft is substituted.
 */
export function mealNutritionView(meal, { planStatus = 'reserved', planId } = {}) {
  const input = meal && typeof meal === 'object' ? meal : {};
  const execution = mealExecutionView(input);
  const plan = { id: planId, status: planStatus, meals: [input], supplementDoses: [] };
  const incoming = input.state === 'completed' && rows(input.actualEntries).length && !['cancelled', 'closed_with_actuals'].includes(planStatus)
    ? transferredFoodRemainders(planId, input) : [];
  const effective = planNutritionLines(plan);
  const planned = planNutritionLines({ ...plan, status: 'reserved', meals: [{ ...input, state: 'reserved', actualEntries: [] }] });
  // Cancellation's existing branch is explicitly actual-only, including [] and 0.
  const actual = planNutritionLines({ ...plan, status: 'cancelled' });
  const remaining = planNutritionLines({ ...plan, status: 'reserved', meals: [{
    ...input, state: 'reserved', actualEntries: [], plannedItems: incoming.length ? incoming : execution.remainingItems,
  }] });
  const totals = nutritionTotalsFromLines(effective);
  const mode = planStatus === 'cancelled' ? 'actual' : incoming.length ? 'partial' : execution.mode;
  const issues = [];
  let basisLabel = "Meal plan", note = "Calculated from the saved meal plan. An unchecked meal does not mean uneaten; no per-meal confirmation is required.";
  if (mode === 'planned' && planStatus === 'draft') {
    basisLabel = "Current meal menu";
    note = "Calculated from the saved current menu, which remains editable. Food inventory settles only after actual completion is reported.";
  }
  if (incoming.length) {
    basisLabel = "Reported + reallocated";
    note = "Totals include original actual records and later incoming food not yet eaten. Reallocation does not mean intake; original completion records and other uneaten old planned food remain unchanged.";
    issues.push(issue('TRANSFERRED_MENU_REMAINING', note));
  } else if (mode === 'partial') {
    basisLabel = "Reported + retained plan";
    note = "This meal total uses the day's current allocation basis. For the same food, it retains the greater of planned and reported quantities; other planned food remains. Actual and remainder details are for comparison and must not be added again.";
    issues.push(issue('PARTIAL_MENU_BASIS', note));
    if (actual.some(entry => planned.some(line => sameFood(line, entry) && line.unit !== entry.unit))) {
      issues.push(issue('PARTIAL_UNIT_CONFLICT', "Planned and actual units for the same food are incompatible. This food remains unknown in meal totals rather than being counted twice."));
    }
    if (actual.some(entry => entry.quantity === null)) {
      issues.push(issue('PARTIAL_QUANTITY_UNKNOWN', "Some actual quantities are unreported. The original plan remains; unknown actuals are neither zero nor an additional portion."));
    }
    if (actual.some(entry => planned.some(line => sameFood(line, entry) && line.unit === entry.unit && differentNutritionBasis(line, entry)))) {
      issues.push(issue('PARTIAL_NUTRITION_BASIS_DIFFERENCE', "Actual and planned nutrition for the same food use different bases. Meal totals retain the day's valid complete plan basis; do not recalculate by adding actual details to remainder details or refresh saved snapshots."));
    }
  } else if (mode === 'actual') {
    if (actual.length) {
      basisLabel = "Actual meal intake";
      note = "Calculated from reported actual foods. A zero quantity means not eaten; unknown quantities or nutrition remain unknown. The original plan is for comparison only.";
    } else if (input.state === 'cancelled' || planStatus === 'cancelled') {
      basisLabel = "Cancelled · No actual records";
      note = "Cancelled portions are excluded from the menu. No actual food was reported, so this meal currently contributes zero.";
    } else {
      basisLabel = "Meal plan · Actual food unreported";
      note = "The meal is marked completed, but specific actual food has not been reported. Totals retain the original plan and must not be described as actual intake.";
      issues.push(issue('COMPLETED_CONTENT_UNREPORTED', note));
    }
  }
  return {
    mealId: input.id ?? '', mode, basisLabel, note, issues,
    totals, partial: totals.some(total => total.partial), estimated: totals.some(total => total.estimated),
    rows: viewRows(effective, undefined, new Map(), effectiveActualProvenance(effective, actual, input.state === 'in_progress' && planStatus !== 'cancelled')), plannedRows: viewRows(planned, 'planned'),
    actualRows: viewRows(actual, 'reported'),
    remainingRows: viewRows(remaining, 'remaining', new Map(rows(execution.remainingItems).map(line => [line.id, line.remainingNote ?? '']))),
  };
}
