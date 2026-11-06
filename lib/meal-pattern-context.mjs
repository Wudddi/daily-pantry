/** Familiar combinations from reported actuals and labelled settled defaults. */
import { dailyMenuAccountingPlan } from './daily-menu-settlement.mjs';
const BUDGET = 24_000;
const WINDOW_DAYS = 14;
const MAX_DAYS = 3;
const MAX_MEALS = 6;
const PRIMARY_SLOTS = ['breakfast', 'lunch', 'dinner'];
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat'];
const rows = value => Array.isArray(value) ? value : [];
const size = value => JSON.stringify(value).length;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? value : '';
const knownDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

function actualEntries(meal) {
  // Zero means explicitly not eaten. Invalid negative/NaN values are not
  // reinterpreted as unknown intake; only a saved null is an unknown portion.
  return rows(meal.actualEntries).filter(entry => entry && (entry.quantity === null || number(entry.quantity) !== null && entry.quantity > 0));
}

function frozenNutrition(snapshot) {
  const nutrition = snapshot?.nutrition;
  const source = ['label', 'recipe', 'estimate', 'unknown'].includes(nutrition?.source) ? nutrition.source : 'unknown';
  return {
    basisAmount: number(nutrition?.basisAmount), basisUnit: text(nutrition?.basisUnit) || null,
    ...Object.fromEntries(NUTRIENTS.map(key => [key, number(nutrition?.[key])])), source,
    nutrientSources: Object.fromEntries(NUTRIENTS.map(key => [key, number(nutrition?.[key]) === null
      ? 'unknown' : nutrition?.nutrientSources?.[key] ?? source])),
  };
}

function projectEntry(entry, itemById, actual = true) {
  const itemId = typeof entry.itemId === 'string' ? entry.itemId : null;
  const current = itemId === null ? null : itemById.get(itemId);
  const nutrition = frozenNutrition(entry.nutritionSnapshot);
  const unit = text(entry.unit);
  return {
    id: entry.id, itemId, name: text(entry.name) || text(entry.nutritionSnapshot?.name) || text(current?.name),
    quantity: entry.quantity, unit, quantityKnown: entry.quantity !== null,
    gramsPerUnit: number(entry.nutritionSnapshot?.gramsPerUnit), nutrition,
    nutritionComplete: NUTRIENTS.every(key => nutrition[key] !== null),
    currentInventory: {
      matched: !!current,
      status: current ? current.status : null, location: current ? text(current.location) : null,
      quantity: current ? number(current.quantity) : null, unit: current ? text(current.unit) : null,
      available: !!current && current.status === 'available' && current.quantity !== 0,
      unitMatchesActual: actual && current ? current.unit === unit : null,
    },
  };
}

function projectMeal(plan, meal, itemById, referenceEvidence = 'reported_actual') {
  const entries = actualEntries(meal).map(entry => projectEntry(entry, itemById));
  const plannedEntries = rows(meal.assumedEntries).map(entry => projectEntry(entry, itemById, false));
  const combined = [...entries, ...plannedEntries];
  const excludedInvalidActualEntryCount = rows(meal.actualEntries).filter(entry => entry?.quantity !== null && number(entry?.quantity) === null).length;
  return {
    date: plan.date, planId: plan.id, mealId: meal.id, slot: meal.slot,
    state: referenceEvidence === 'reported_actual' ? 'completed' : 'automatic_menu_settled',
    referenceEvidence, actualIntakeProven: referenceEvidence === 'reported_actual',
    actualEntries: entries, ...(referenceEvidence === 'automatic_menu_assumption' ? { plannedEntries } : {}),
    quantitiesComplete: excludedInvalidActualEntryCount === 0 && combined.every(entry => entry.quantityKnown),
    nutritionComplete: combined.every(entry => entry.nutritionComplete),
    excludedInvalidActualEntryCount,
  };
}

function projectDay(candidate, itemById) {
  const meals = candidate.completedMeals.map(meal => projectMeal(candidate.plan, meal, itemById, candidate.referenceEvidence));
  return {
    date: candidate.plan.date, planId: candidate.plan.id, primaryMealsComplete: true, meals,
    referenceEvidence: candidate.referenceEvidence, actualIntakeProven: candidate.referenceEvidence === 'reported_actual',
    quantitiesComplete: meals.every(meal => meal.quantitiesComplete && meal.excludedInvalidActualEntryCount === 0),
    nutritionComplete: meals.every(meal => meal.nutritionComplete),
  };
}

function automaticMeals(plan) {
  const settlement = plan.dailySettlement;
  if (settlement?.version !== 1 || settlement.source !== 'automatic_menu' || settlement.basis !== 'auto_planned'
    || settlement.date !== plan.date || settlement.accounting !== 'settled' || !Array.isArray(settlement.plannedMeals)
    || typeof settlement.settledAt !== 'string' || !Number.isFinite(Date.parse(settlement.settledAt))) return [];
  const originals = new Map(rows(plan.meals).map(meal => [meal.id, meal]));
  // The helper receives only accounting inputs. In particular no personal
  // checkbox, UI progress, time, transcript or mutable nutrition is consulted.
  const view = dailyMenuAccountingPlan({ id: plan.id, date: plan.date,
    dailySettlement: { source: 'automatic_menu', date: settlement.date, plannedMeals: settlement.plannedMeals },
    meals: rows(plan.meals).map(meal => ({ id: meal.id, slot: meal.slot, state: meal.state,
      actualEntries: rows(meal.actualEntries).map(entry => ({ id: entry.id, itemId: entry.itemId, name: entry.name, quantity: entry.quantity, unit: entry.unit })),
      reportHistory: rows(meal.reportHistory).map(report => ({ mode: report.mode, entryIds: rows(report.entryIds) })),
    })),
  });
  const result = [];
  for (const meal of rows(view.meals)) {
    const original = originals.get(meal.id);
    if (!original) continue; // Frozen old IDs without a known slot are not guessed.
    const basis = settlement.plannedMeals.find(row => row.mealId === meal.id);
    const real = new Map(rows(original.actualEntries).map(entry => [entry.id, entry]));
    const actual = [], assumed = [];
    for (const entry of actualEntries(meal)) {
      if (real.has(entry.id)) { actual.push(real.get(entry.id)); continue; }
      const line = rows(basis?.plannedItems).find(row => entry.id === 'auto-menu-' + meal.id + '-' + row.id || entry.id === 'auto-unknown-' + row.id);
      if (!line) continue;
      assumed.push({ id: line.id, itemId: entry.itemId, name: text(line.name), quantity: entry.quantity, unit: entry.unit,
        // This settlement format froze identity/portion only, not nutrition.
        nutritionSnapshot: null });
    }
    if (actual.length || assumed.length) result.push({ id: meal.id, slot: original.slot, actualEntries: actual, assumedEntries: assumed });
  }
  return result;
}

function dayPointer(candidate) {
  return { date: candidate.plan.date, planId: candidate.plan.id, referenceEvidence: candidate.referenceEvidence,
    actualIntakeProven: candidate.referenceEvidence === 'reported_actual',
    detail: { tool: 'read_diet_records', date: candidate.plan.date, planId: candidate.plan.id } };
}

/** Reported data wins; an ended, settled automatic menu may supplement it as
 * explicitly lower-confidence history, never as a newly reported actual. */
export function mealPatternContext(state, referenceDate) {
  if (!knownDate(referenceDate)) throw Object.assign(new Error("Meal-reference dates must be valid YYYY-MM-DD dates."), { status: 400, code: 'INVALID_REFERENCE_DATE' });
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items)
    || state.plans !== undefined && !Array.isArray(state.plans)) {
    throw Object.assign(new Error("Actual meal reference data could not be read completely."), { status: 503, code: 'MEAL_PATTERN_CONTEXT_UNAVAILABLE' });
  }
  const from = new Date(Date.parse(referenceDate + 'T00:00:00Z') - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const exclusions = { nonNative: 0, supplementOnly: 0, invalidDate: 0, future: 0, outsideWindow: 0, ambiguousDate: 0, ambiguousMealSlots: 0 };
  const byDate = new Map();
  for (const plan of rows(state.plans)) {
    if (plan?.format !== 'meals_v1') { exclusions.nonNative++; continue; }
    if (plan.supplementOnly === true) { exclusions.supplementOnly++; continue; }
    if (!knownDate(plan.date)) { exclusions.invalidDate++; continue; }
    if (plan.date > referenceDate) { exclusions.future++; continue; }
    if (plan.date < from) { exclusions.outsideWindow++; continue; }
    if (!byDate.has(plan.date)) byDate.set(plan.date, []);
    byDate.get(plan.date).push(plan);
  }
  const candidates = [];
  for (const plans of byDate.values()) {
    if (plans.length !== 1) { exclusions.ambiguousDate += plans.length; continue; }
    const plan = plans[0], meals = rows(plan.meals), slots = meals.map(meal => meal.slot);
    if (new Set(slots).size !== slots.length) { exclusions.ambiguousMealSlots++; continue; }
    const completedMeals = meals.filter(meal => meal.state === 'completed' && actualEntries(meal).length > 0);
    const completeDay = PRIMARY_SLOTS.every(slot => completedMeals.some(meal => meal.slot === slot));
    if (completedMeals.length) candidates.push({ plan, completedMeals, completeDay, referenceEvidence: 'reported_actual' });
    if (!completeDay) {
      const automatic = automaticMeals(plan);
      if (automatic.length) candidates.push({ plan, completedMeals: automatic,
        completeDay: PRIMARY_SLOTS.every(slot => automatic.some(meal => meal.slot === slot)), referenceEvidence: 'automatic_menu_assumption' });
    }
  }
  candidates.sort((a, b) => Number(a.referenceEvidence === 'automatic_menu_assumption') - Number(b.referenceEvidence === 'automatic_menu_assumption')
    || b.plan.date.localeCompare(a.plan.date) || String(a.plan.id).localeCompare(String(b.plan.id)));
  const completeDays = candidates.filter(candidate => candidate.completeDay);
  const completedMeals = [], seenMeals = new Set();
  for (const candidate of candidates) for (const meal of candidate.completedMeals) {
    const key = JSON.stringify([candidate.plan.id, meal.id]);
    if (seenMeals.has(key)) continue;
    seenMeals.add(key); completedMeals.push({ plan: candidate.plan, meal, referenceEvidence: candidate.referenceEvidence });
  }
  const itemById = new Map(state.items.map(item => [item.id, item]));
  const result = {
    available: true, revision: state.revision, format: 'executed_meal_patterns_v1',
    referenceDate, from, to: referenceDate, windowDays: WINDOW_DAYS, charBudget: BUDGET,
    referenceMode: completeDays.length ? 'completed_primary_days' : 'completed_meals_only',
    hasCompleteDayReference: false, completeDayReferences: [], recentCompletedMealReferences: [],
    omittedCompleteDayReferences: completeDays.map(dayPointer),
    coverage: {
      eligibleCompleteDayCount: completeDays.length, includedCompleteDayCount: 0, omittedCompleteDayCount: completeDays.length,
      eligibleReportedCompleteDayCount: completeDays.filter(day => day.referenceEvidence === 'reported_actual').length,
      eligibleAutomaticCompleteDayCount: completeDays.filter(day => day.referenceEvidence === 'automatic_menu_assumption').length,
      eligibleCompletedMealCount: completedMeals.length, includedFallbackMealCount: 0,
      omittedFallbackMealCount: completeDays.length ? 0 : completedMeals.length,
      completeDayLimit: MAX_DAYS, fallbackMealLimit: MAX_MEALS,
      excludedPlanCounts: exclusions,
    },
    truncated: false, noCompleteDayReason: completeDays.length ? null : 'NO_COMPLETED_PRIMARY_DAY_IN_WINDOW',
    detailsTool: 'read_diet_records',
    instructions: "These recent familiar combinations are authorized by the user as planning references. First follow complete current preferences, this request, current inventory, and freshness; then adapt familiar combinations rather than inventing unfamiliar pairings just to hit nutrition targets. referenceEvidence=reported_actual with actualIntakeProven=true comes from real completed actual records. automatic_menu_assumption with actualIntakeProven=false comes only from settled automatic_menu assumptions, has lower confidence, and is not a user intake report. Prefer complete actual days before assumed settlement days. Unsettled, pending, and future menus are not default references. actualEntries are original actual facts; plannedEntries are assumed settled remainders, not new actuals. Personal food checkboxes are reminders and never evidence of intake. Executed or assumed-settled meals do not imply every food is a permanent preference, and must not create likes or restrictions automatically. quantity=null remains unknown. Without a complete day, provide single-meal references rather than inventing a daily template. Old actual nutrition is a historical snapshot; keep unfrozen automatic-settlement nutrition null instead of disguising current labels as old nutrition. Recalculate new menus using current inventory labels and quantities. currentInventory matches itemId exactly. External or unavailable foods are not automatically stocked, and units are not automatically converted. Do not migrate old times or supplement actuals, or copy old actuals as today's intake. omittedCompleteDayReferences preserves omitted dates, planIds, and evidence levels; read the specific day with read_diet_records when needed. Reading changes no menus, actuals, preferences, or inventory.",
  };
  const refreshDayCoverage = () => {
    const included = new Set(result.completeDayReferences.map(day => day.planId));
    result.coverage.includedCompleteDayCount = result.completeDayReferences.length;
    result.coverage.omittedCompleteDayCount = completeDays.length - result.completeDayReferences.length;
    result.hasCompleteDayReference = result.completeDayReferences.length > 0;
    result.omittedCompleteDayReferences = completeDays.filter(candidate => !included.has(candidate.plan.id)).map(dayPointer);
  };
  if (!completedMeals.length) result.instructions = "No eligible actual/settled-assumed references in 14 days. Drafts, suggestions, future plans, checkboxes and supplements prove no intake/preference. Follow current preferences/stock/freshness; reads change nothing.";
  if (completeDays.length) {
    // Fit whole days, never drop food lines or a meal from an included day.
    for (const candidate of completeDays) {
      if (result.completeDayReferences.length >= MAX_DAYS) break;
      const day = projectDay(candidate, itemById);
      result.completeDayReferences.push(day);
      refreshDayCoverage();
      if (size(result) <= BUDGET) continue;
      result.completeDayReferences.pop();
      refreshDayCoverage();
    }
    if (!result.hasCompleteDayReference) result.noCompleteDayReason = 'COMPLETED_PRIMARY_DAYS_EXCEED_CONTEXT_BUDGET';
  } else {
    for (const { plan, meal, referenceEvidence } of completedMeals) {
      if (result.recentCompletedMealReferences.length >= MAX_MEALS) break;
      const reference = projectMeal(plan, meal, itemById, referenceEvidence);
      result.recentCompletedMealReferences.push(reference);
      result.coverage.includedFallbackMealCount = result.recentCompletedMealReferences.length;
      result.coverage.omittedFallbackMealCount = completedMeals.length - result.recentCompletedMealReferences.length;
      if (size(result) <= BUDGET) continue;
      result.recentCompletedMealReferences.pop();
      result.coverage.includedFallbackMealCount = result.recentCompletedMealReferences.length;
      result.coverage.omittedFallbackMealCount = completedMeals.length - result.recentCompletedMealReferences.length;
    }
  }
  const includedEvidence = new Set([...result.completeDayReferences, ...result.recentCompletedMealReferences].map(reference => reference.referenceEvidence));
  if (includedEvidence.size > 1) result.referenceMode = 'mixed_primary_days';
  else if (includedEvidence.has('automatic_menu_assumption')) result.referenceMode = result.hasCompleteDayReference ? 'automatic_menu_assumptions' : 'automatic_meals_only';
  result.truncated = result.coverage.omittedCompleteDayCount > 0 || result.coverage.omittedFallbackMealCount > 0;
  if (size(result) > BUDGET) throw Object.assign(new Error("Actual meal reference metadata exceeds the read budget."), { status: 413, code: 'MEAL_PATTERN_CONTEXT_TOO_LARGE' });
  return result;
}
