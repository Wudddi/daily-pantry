import { unitLabel } from './english-display.mjs';
import { materializeDietPlanForEdit } from './diet.mjs';
import { planNutritionTotals } from './diet-nutrition.mjs';
import { resolveDietDays } from './diet-day-summary.mjs';
import { inventoryPlanningPriorities } from './inventory-planning-priority.mjs';
import { foodPreferencesContext } from './food-preferences-context.mjs';
import { readDailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
import { inventoryAccountingContext, inventoryAccountingFields } from './inventory-accounting-context.mjs';
import { dailyMenuSettlementSummary } from './daily-menu-settlement-context.mjs';
import { recipeGroupEditView } from './recipe-group-actions.mjs';
import { intakeDraftVersion } from './intake-draft.mjs';
import { foodLayoutFingerprint } from './food-layout.mjs';
import { personalFoodCheckContext } from './ai-food-read-state.mjs';

const BUDGET = 24000;
const PREFERENCES_METADATA_BUDGET = 512;
const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'snack', 'other']);
const FILTERS = new Set(['planId', 'date', 'mealIds', 'mealSlots', 'candidateItemIds', 'foodQuery', 'view', 'expectedRevision']);
const rows = value => Array.isArray(value) ? value : [];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const size = value => JSON.stringify(value).length;
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
function fail(message, status = 400, code = 'INVALID_EDIT_CONTEXT') { throw Object.assign(new Error(message), { status, code }); }
function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail(`${label} must contain 1 to 100 characters.`);
  return value.trim();
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(" requires a valid YYYY-MM-DD date.");
  return value;
}
function uniqueList(value, label, max, parse = identifier) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > max) fail(`${label} supports at most ${max} entries.`);
  const result = value.map(entry => parse(entry, label));
  if (new Set(result).size !== result.length) fail(`${label} cannot contain duplicates.`);
  return result;
}
function validateFilters(state, filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail("Read parameters must be an object.");
  if (Object.keys(filters).some(key => !FILTERS.has(key))) fail("Unsupported meal-edit context parameters.");
  if (filters.planId === undefined && filters.date === undefined) fail("Provide planId or date.");
  if (filters.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(filters.expectedRevision) || filters.expectedRevision < 0) fail("Invalid expectedRevision.");
    if (filters.expectedRevision !== state.revision) fail("The inventory revision changed. Read the meal-edit context again.", 409, 'REVISION_CONFLICT');
  }
  if (filters.view !== undefined && !['draft', 'active'].includes(filters.view)) fail("view must be draft or active.");
  const query = filters.foodQuery === undefined ? '' : filters.foodQuery;
  if (typeof query !== 'string' || query.length > 160) fail("Food name queries support at most 160 characters.");
  return {
    planId: filters.planId === undefined ? null : identifier(filters.planId, "Plan ID"),
    date: filters.date === undefined ? null : day(filters.date), view: filters.view ?? 'draft',
    mealIds: uniqueList(filters.mealIds, "Meal ID", 16),
    mealSlots: uniqueList(filters.mealSlots, "Meal slot", 5, value => { if (!SLOTS.has(value)) fail("Invalid meal slot."); return value; }),
    candidateItemIds: uniqueList(filters.candidateItemIds, "Candidate food ID", 12) ?? [], foodQuery: nameKey(query),
  };
}
function selectPlan(state, filters) {
  const candidates = rows(state.plans).filter(plan => filters.planId ? plan.id === filters.planId : plan.date === filters.date);
  if (!candidates.length) fail("Target diet plan not found.", 404, 'PLAN_NOT_FOUND');
  if (candidates.length !== 1) fail("Multiple records exist for this date. Provide the unique canonical planId; do not infer a merge.", 409, 'AMBIGUOUS_DAILY_PLAN');
  const plan = candidates[0];
  if (plan.format !== 'meals_v1') fail("This record does not support meal edits. Historical or legacy flat records cannot be converted by inference.", 409, 'PLAN_FORMAT_NOT_EDITABLE');
  if (filters.date && plan.date !== filters.date) fail("planId and date do not match.", 409, 'PLAN_DATE_CONFLICT');
  return plan;
}
function facts(entity) {
  return rows(entity.actualEntries).length > 0 || entity.completionReportedAt != null || entity.actualTime != null
    || !!entity.actualTimeText || rows(entity.reportHistory).length > 0;
}
function nutrition(value) {
  const source = value?.source ?? 'unknown';
  return {
    basisAmount: number(value?.basisAmount), basisUnit: value?.basisUnit ?? null,
    ...Object.fromEntries(KEYS.map(key => [key, number(value?.[key])])), source,
    nutrientSources: Object.fromEntries(KEYS.map(key => [key, number(value?.[key]) === null ? 'unknown' : value?.nutrientSources?.[key] ?? source])),
    sourceTextAvailable: !!value?.sourceText, sourceNoteAvailable: !!value?.sourceNote,
  };
}
function totals(value) {
  return rows(value).filter(total => KEYS.includes(total.key)).map(total => ({
    key: total.key, value: number(total.value), partial: total.partial === true, supplementPartial: total.supplementPartial === true,
    estimated: total.estimated === true, source: total.source ?? 'unknown', missing: number(total.missing),
    supplementMissing: number(total.supplementMissing), complete: total.complete === true, completeValue: number(total.completeValue),
  }));
}
function viewOf(state, source, requestedView) {
  const plan = materializeDietPlanForEdit(state, source, requestedView);
  const editBase = requestedView === 'draft' && (!!source.draft || source.status === 'draft') ? 'draft' : 'active';
  return { source, plan, editBase };
}
function summaryOf(state, view) {
  const { source, plan, editBase } = view;
  const basis = editBase === 'draft' || plan.status === 'draft' ? 'draft_preview'
    : plan.intakeBasis === 'reported_only' || plan.status === 'closed_with_actuals' ? 'reported_only' : 'confirmed_daily_plan';
  const supplementOnly = plan.supplementOnly === true;
  if (supplementOnly && !rows(plan.meals).length) return {
    basis, date: plan.date, totals: [], partial: true, supplementPartial: false, supplementOnly: true, hasDraft: !!source.draft,
  };
  // A materialized draft is a preview, not the active day with its old pending
  // draft attached. This temporary object never changes stored flags or facts.
  const preview = { ...plan, ...(basis === 'draft_preview' ? { status: 'draft', supplementOnly: false } : {}) };
  delete preview.draft;
  const resolved = resolveDietDays([preview], rows(state.dietHistory).filter(record => record.date === plan.date), rows(state.items))[0];
  const values = totals(resolved?.totals ?? planNutritionTotals(preview));
  return { basis, date: plan.date, totals: values, partial: values.some(total => total.partial),
    supplementPartial: values.some(total => total.supplementPartial), supplementOnly, hasDraft: !!source.draft };
}

/** Small post-mutation nutrition receipt. No meal filters, stock reads or writes. */
export function foodPlanNutritionSummary(state, planId, view = 'draft') {
  if (!['draft', 'active'].includes(view)) fail("view must be draft or active.");
  const source = selectPlan(state, { planId: identifier(planId, "Plan ID") });
  return summaryOf(state, viewOf(state, source, view));
}

/** Read-only execution view: reports never rewrite the saved plan. */
export function mealExecutionView(meal) {
  const actualEntries = rows(meal.actualEntries), plannedItems = rows(meal.plannedItems);
  const mode = meal.state === 'completed' || meal.state === 'cancelled' ? 'actual' : meal.state === 'in_progress' || actualEntries.length ? 'partial' : 'planned';
  if (mode !== 'partial') return { mode, actualEntries, plannedItems, remainingItems: [] };
  const sameFood = (a, b) => a.itemId != null || b.itemId != null
    ? a.itemId != null && a.itemId === b.itemId
    : !!nameKey(a.name ?? a.nutritionSnapshot?.name) && nameKey(a.name ?? a.nutritionSnapshot?.name) === nameKey(b.name ?? b.nutritionSnapshot?.name);
  const used = new Map();
  const remainingItems = plannedItems.map(line => {
    const matching = actualEntries.filter(entry => sameFood(line, entry));
    const uncertain = matching.some(entry => number(entry.quantity) === null || entry.unit !== line.unit);
    if (uncertain) return { ...line, quantity: null, remainingNote: "Remaining balance needs review; original plan " + line.quantity + ' ' + unitLabel(line.unit, line.quantity) };
    const taken = matching.reduce((sum, entry) => sum + entry.quantity, 0);
    const previous = used.get(matching[0]) ?? 0;
    const allocated = Math.min(line.quantity, Math.max(0, taken - previous));
    if (matching.length) used.set(matching[0], previous + allocated);
    return { ...line, quantity: Math.max(0, Math.round((line.quantity - allocated) * 1e6) / 1e6), remainingNote: '' };
  }).filter(line => line.quantity === null || line.quantity > 0);
  return { mode, actualEntries, plannedItems, remainingItems };
}

function projectMeal(meal, plan, canPatch, items) {
  const actualEntries = rows(meal.actualEntries), hasActualFacts = facts(meal);
  return {
    id: meal.id, slot: meal.slot, title: meal.title, state: meal.state, hasActualFacts,
    canPatch, canRemove: canPatch && !hasActualFacts, actualFactsImmutable: true,
    protectionReasons: hasActualFacts ? ['ACTUAL_FACTS_IMMUTABLE', 'MEAL_REMOVAL_HAS_FACTS'] : [],
    actualEntryIds: actualEntries.map(entry => entry.id), actualEntryCount: actualEntries.length,
    actualEntries: actualEntries.map(entry => ({ id: entry.id, itemId: entry.itemId ?? null,
      name: entry.name ?? entry.nutritionSnapshot?.name ?? items.find(item => item.id === entry.itemId)?.name ?? '',
      quantity: entry.quantity, unit: entry.unit, nutrition: nutrition(entry.nutritionSnapshot?.nutrition),
      gramsPerUnit: number(entry.nutritionSnapshot?.gramsPerUnit), sourceTextAvailable: !!entry.sourceText,
      nutritionCorrectionCount: rows(entry.nutritionCorrectionHistory).length })),
    reportCount: rows(meal.reportHistory).length, actualTime: meal.actualTime ?? null,
    actualTimeTextPresent: !!meal.actualTimeText, completionReportedAt: meal.completionReportedAt ?? null,
    plannedTime: meal.plannedTime ?? null, plannedTimeTextPresent: !!meal.plannedTimeText,
    ...(meal.actualRecipeGroups === undefined ? {} : { actualRecipeGroups: structuredClone(meal.actualRecipeGroups) }),
    actualRecipeGroupHistoryCount: rows(meal.actualRecipeGroupHistory).length,
    recipeGroups: rows(meal.recipeGroups).map(group => {
      let edit;
      try { edit = recipeGroupEditView(plan, items, meal.id, group.id); } catch { edit = null; }
      return { id: group.id, name: group.name, lineIds: rows(group.lineIds).slice(), portion: group.portion ?? 1,
        legacyBasis: group.portion === undefined, ...(edit ? { editFingerprint: edit.fingerprint, canScale: edit.canScale, canMove: edit.canMove } : {}) };
    }),
    plannedItems: rows(meal.plannedItems).map(line => {
      const snapshot = line.nutritionSnapshot, item = items.find(item => item.id === line.itemId);
      return { id: line.id, itemId: line.itemId ?? null, name: line.name ?? snapshot?.name ?? item?.name ?? '',
        quantity: line.quantity, unit: line.unit, nutrition: nutrition(snapshot?.nutrition ?? line.nutrition),
        gramsPerUnit: number(snapshot?.gramsPerUnit), plannedNutritionOverride: line.nutrition !== undefined,
        sourceTextAvailable: !!line.sourceText };
    }),
    nutritionTotals: totals(planNutritionTotals({ ...plan, meals: [meal], supplementDoses: [] })),
  };
}
function candidateRows(state, plan, meals, filters) {
  const accounting = inventoryAccountingContext(state);
  const priorities = inventoryPlanningPriorities(state, plan.date);
  const selected = new Map(), missingItemIds = [], excludedSupplementItemIds = [];
  const insert = (itemId, origin) => { if (!selected.has(itemId)) selected.set(itemId, origin); };
  for (const id of filters.candidateItemIds) insert(id, 'explicit');
  if (filters.foodQuery) for (const item of rows(state.items).slice().sort(priorities.compare)) if (item.category !== 'supplement' && [item.name, ...rows(item.aliases)].some(name => nameKey(name).includes(filters.foodQuery))) insert(item.id, 'query');
  // Target line nutrition is already inline. Preserve the user's requested
  // replacement candidates before spending this small stock list on old foods.
  for (const meal of meals) for (const line of rows(meal.plannedItems)) if (line.itemId != null) insert(line.itemId, 'target');
  const result = [];
  for (const [id, origin] of selected) {
    const item = rows(state.items).find(item => item.id === id);
    if (!item) { missingItemIds.push(id); continue; }
    if (item.category === 'supplement') { excludedSupplementItemIds.push(id); continue; }
    const debit = rows(plan.accountedDebits).find(line => line.itemId === id);
    const baseline = item.quantityBaselineToken ?? item.confirmedAt ?? 'initial';
    result.push({ id: item.id, name: item.name, brand: item.brand ?? '', category: item.category, origin,
      ...(item.aliases?.length ? { aliases: item.aliases.slice() } : {}),
      quantity: number(item.quantity), unit: item.unit, status: item.status, priority: item.priority === true,
      canUse: item.status === 'available' && item.quantity !== 0,
      ...priorities.metadata(item),
      gramsPerUnit: number(item.gramsPerUnit), nutrition: nutrition(item.nutrition),
      confirmedAt: item.confirmedAt ?? null, updatedAt: item.updatedAt ?? null,
      location: item.location ?? '', ...(item.freshness ? { freshness: structuredClone(item.freshness) } : {}),
      ...inventoryAccountingFields(item, accounting),
      accountedByThisPlan: debit ? { quantity: debit.quantity, unit: debit.unit, unknownBalance: debit.unknownBalance === true, ...(debit.shortfallQuantity > 0 ? { shortfallQuantity: debit.shortfallQuantity } : {}),
        baselineMatches: baseline === debit.baselineToken && item.unit === debit.unit && (item.quantity === null) === debit.unknownBalance } : null,
    });
  }
  return { items: result.slice(0, 12), total: result.length, included: Math.min(12, result.length),
    truncated: result.length > 12 || missingItemIds.length > 12 || excludedSupplementItemIds.length > 12,
    missingItemIds: missingItemIds.slice(0, 12), missingItemCount: missingItemIds.length,
    excludedSupplementItemIds: excludedSupplementItemIds.slice(0, 12), excludedSupplementItemCount: excludedSupplementItemIds.length,
    selectionInstructions: "Explicit candidate IDs take precedence. For same-category name replacements, use planningHints and recent confirmed-menu coverage without overriding the user's current taste, nutrition goals, or complete preferences. Edit only the target meal; do not rotate other meals or supplements. A recent plan is not evidence of intake. Missing nutrition for unrelated foods does not block this edit; unknown values are not zero." };
}

/** One immutable inventory snapshot, projected for a small meal edit. */
export function readFoodPlanEditContext(state, rawFilters = {}) {
  const filters = validateFilters(state, rawFilters), source = selectPlan(state, filters), view = viewOf(state, source, filters.view);
  const preferencesContext = foodPreferencesContext(state);
  const { plan, editBase } = view, items = rows(state.items), meals = rows(plan.meals);
  if (filters.mealIds) for (const id of filters.mealIds) if (!meals.some(meal => meal.id === id)) fail("The target meal ID is not present in this edit view.", 404, 'MEAL_NOT_FOUND');
  const selected = meals.filter(meal => (!filters.mealIds || filters.mealIds.includes(meal.id)) && (!filters.mealSlots || filters.mealSlots.includes(meal.slot)));
  if ((filters.mealIds?.length || filters.mealSlots?.length) && !selected.length) fail("No meal matches both the specified IDs and meal slots.", 404, 'MEAL_NOT_FOUND');
  const reasons = [];
  if (!['draft', 'reserved'].includes(source.status)) reasons.push('PLAN_CLOSED');
  const canPatch = reasons.length === 0;
  const applyReasons = canPatch ? [] : reasons.slice();
  const selectedIds = new Set(selected.map(meal => meal.id));
  const omitted = meals.filter(meal => !selectedIds.has(meal.id));
  const reminderPlan = { ...plan, personalFoodChecks: source.personalFoodChecks };
  delete reminderPlan.draft;
  const dailySettlement = dailyMenuSettlementSummary(source);
  const result = {
    revision: state.revision,
    ...(state.dailyMenuSettlementPolicy ? { dailyMenuSettlementPolicy: readDailyMenuSettlementPolicy(state) } : {}),
    plan: { id: source.id, date: plan.date, title: plan.title, status: source.status, hasDraft: !!source.draft, editBase,
      foodLayoutOverrides: structuredClone(plan.foodLayoutOverrides ?? []), foodLayoutFingerprint: foodLayoutFingerprint(plan),
      hasIntakeDraft: !!source.intakeDraft, intakeDraftVersion: intakeDraftVersion(source.intakeDraft),
      supplementOnly: plan.supplementOnly === true, supplementAccounting: plan.supplementAccounting ?? null,
      inventoryAccounting: source.inventoryAccounting, ...(rows(source.accountingWarnings).length ? { accountingWarnings: rows(source.accountingWarnings).slice(0, 3), accountingWarningCount: rows(source.accountingWarnings).length, accountingWarningsTruncated: rows(source.accountingWarnings).length > 3 } : {}), canPatch, protectionReasons: reasons,
      ...(dailySettlement === undefined ? {} : { dailySettlement }),
      canApply: applyReasons.length === 0, applyProtectionReasons: applyReasons,
      accountingIssueCount: rows(source.accountingIssues).length,
      accountingIssues: rows(source.accountingIssues).slice(0, 3).map(issue => ({ code: issue.code, itemId: issue.itemId ?? null })),
      accountingIssuesTruncated: rows(source.accountingIssues).length > 3 },
    meals: selected.map(meal => projectMeal(meal, plan, canPatch, items)),
    personalCheckContext: personalFoodCheckContext(reminderPlan,
      { mealIds: filters.mealIds || filters.mealSlots ? [...selectedIds] : undefined }),
    requestedMealIds: selected.map(meal => meal.id), omittedMealIds: [],
    otherMeals: { preserve: true, count: omitted.length, included: omitted.length, truncated: false,
      meals: omitted.map(meal => ({ id: meal.id, slot: meal.slot, title: meal.title, hasActualFacts: facts(meal),
        nutritionTotals: totals(planNutritionTotals({ ...plan, meals: [meal], supplementDoses: [] })) })) },
    supplements: { preserve: true, count: rows(plan.supplementDoses).length,
      actualDoseCount: rows(plan.supplementDoses).filter(dose => rows(dose.actualEntries).some(entry => entry.quantity === null || number(entry.quantity) > 0)).length,
      reportedDoseCount: rows(plan.supplementDoses).filter(facts).length },
    dailyNutritionSummary: summaryOf(state, view),
    inventoryCandidates: candidateRows(state, plan, selected, filters),
    quantityMeaning: 'remaining_after_actual_and_legacy_credits',
    instructions: "foodLayoutOverrides records saved web presentation only; sourceMealId/sourceId remain the factual source and targetMealId is display placement, never another serving. Reread the latest revision after web edits. Pending intake drafts are separate, unsubmitted and never auto-adopted. recipeGroups contains named recipes in this meal; lineIds reference existing plannedItems.id only. Preserve ingredient quantities and keep standalone fruit or drinks outside the groups. To edit grouping only, send the complete small recipeGroups array in mealPatches; omission preserves it and [] clears it. Do not add finished-food inventory, change actual records, or deduct inventory. preferences contains all current preferences at this revision; preferencesComplete=true. Small edits do not require rereading full inventory or detailed training. The current workflow overrides older preferences that deducted inventory on plan confirmation: saving, adopting, and editing menus reserve or consume nothing; saved menus display immediately. Use record_meal_intake only for explicit actual completion. Patch stable target IDs only; preserve omitted food, other meals, and supplements, and do not reconstruct the day from summaries. Both mode=draft and mode=apply update current planned fields; apply retains confirmed=true for compatibility. Pending accounting does not block menu edits or cause old accounts to settle. Plans cannot overwrite actuals. Completed meals use actual snapshots; other meals use the latest menu. Correct actuals with correct and the original entryId; use nutritionCorrections with evidence for nutrition changes. Unknown is not zero. Meals with facts cannot be deleted. accountedByThisPlan is historical credit, not another deduction due now; a new inventory baseline does not imply a refund. Preserve original text and audits; read original records only when checking evidence. Target context supports 24000 characters plus complete preferences. Narrow mealIds on overflow rather than truncating required facts or preferences.",
    truncated: false, completeForPatch: true,
  };
  // Candidates and non-target summaries may be reduced; target plans and
  // actual facts must remain complete or the read fails explicitly.
  while (size(result) > BUDGET && result.inventoryCandidates.items.length) {
    result.inventoryCandidates.items.pop(); result.inventoryCandidates.truncated = true;
    result.inventoryCandidates.included = result.inventoryCandidates.items.length;
  }
  while (size(result) > BUDGET && result.otherMeals.meals.length) {
    result.otherMeals.meals.pop(); result.otherMeals.truncated = true; result.otherMeals.included = result.otherMeals.meals.length;
  }

  result.truncated = result.inventoryCandidates.truncated || result.otherMeals.truncated || result.omittedMealIds.length > 0 || result.personalCheckContext.truncated;
  if (size(result) > BUDGET) fail("The target context exceeds 24000 characters. Narrow the meal selection and read the original record.", 413, 'EDIT_CONTEXT_TOO_LARGE');
  // Full current preferences are mandatory and must not compete with target
  // facts or replacement candidates for the meal-context budget. Count their
  // serialized JSON separately, including quotes and escaped characters.
  const preferencesJsonCharacters = size(preferencesContext.preferences);
  const preferencesContextJsonCharacters = size(preferencesContext);
  const charBudget = BUDGET + preferencesContextJsonCharacters + PREFERENCES_METADATA_BUDGET;
  const response = { ...result, ...preferencesContext, contextCharBudget: BUDGET,
    preferencesJsonCharacters, preferencesContextJsonCharacters, charBudget };
  if (size(response) > charBudget) fail("The complete meal-edit context exceeds the output budget. Narrow the meal selection; preferences and actual facts were not truncated.", 413, 'EDIT_CONTEXT_TOO_LARGE');
  return response;
}
