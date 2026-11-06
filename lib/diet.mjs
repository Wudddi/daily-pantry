/** Pure structured diet records. Inventory revisions, actor checks and persistence live in inventory.mjs/store. */
import { unitLabel } from './english-display.mjs';
import { historySnapshot, historyContext } from './diet-history.mjs';
import { resolveDietDays } from './diet-day-summary.mjs';
import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { dailyFoodRollup, dailyFoodRollupPage } from './daily-food-rollup.mjs';
import { intakeDraftView, intakeDraftVersion, intakePlanFingerprint, normalizeIntakeDraft, prepareIntakeDraft } from './intake-draft.mjs';
import { applyPersonalFoodCheck } from './personal-food-checklist.mjs';
import { dailyMenuAccountingPlan, dailyMenuAssumedMealIds, prepareDailyMenuSettlement } from './daily-menu-settlement.mjs';
import { foodBalanceBoundaryIssue } from './inventory-balance-boundary.mjs';
import { normalizeRecipeGroups, pruneRecipeGroups } from './recipe-groups.mjs';
import { previewRecipeGroupAction } from './recipe-group-actions.mjs';
import { applyFoodPlanSync } from './sync-food-plan.mjs';
import { applyActualRecipeGroups, hasActualRecipeGroupResources, actualRecipeGroupResourcePatch } from './actual-recipe-groups.mjs';
import { applyFoodLayoutMoves, foodLayoutFingerprint } from './food-layout.mjs';
const ACTIONS = new Set(['save_meal_plan_draft', 'commit_meal_plan', 'revise_unconsumed_meals', 'patch_meal_plan', 'record_meal_intake', 'record_supplement_intake', 'set_supplement_check', 'set_daily_supplement_check', 'save_supplement_routine', 'cancel_meal_plan', 'cancel_remaining_meals', 'save_intake_draft', 'submit_intake_draft', 'discard_intake_draft', 'apply_checklist_intake', 'set_food_personal_check', 'settle_daily_menu', 'scale_recipe_group', 'move_recipe_group', 'add_food_to_meal', 'sync_food_plan', 'set_actual_recipe_groups', 'set_food_layout']);
const SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'snack', 'other']);
const DOSE_SLOTS = new Set(['breakfast', 'lunch', 'pre_workout', 'post_workout', 'dinner', 'bedtime', 'other']);
const REQUIREMENTS = new Set(['daily', 'optional', 'as_needed', 'label_pending']);
const MODES = new Set(['append', 'correct', 'complete']);
const SCALE = 1_000_000;
const rows = value => Array.isArray(value) ? value : [];
const MAX = 1_000_000_000;
const clone = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const baseline = (item) => item.quantityBaselineToken ?? item.confirmedAt ?? 'initial';
function fail(message, status = 400, code = 'INVALID_INPUT') { throw Object.assign(new Error(message), { status, code }); }
function obj(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`); return value; }
function str(value, label, max = 100, optional = false) { if (value === undefined && optional) return ''; if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) fail(`${label} is invalid or too long.`); return value; }
function id(value, label = "Record ID") { return str(value, label).trim(); }
function qty(value, nullable = false, positive = true) { if (nullable && value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX) fail("Quantity must be an explicit nonnegative finite number. Use null for unknown."); const result = Math.round(value * SCALE) / SCALE; if (positive && result <= 0) fail("Quantity must be greater than 0."); return result; }
function round(value) { return Math.round(value * SCALE) / SCALE; }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail("Provide an explicit valid YYYY-MM-DD date."); return value; }
function time(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail("Time must use HH:mm. Leave unreported times null."); return value; }
function list(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list with at most ${max} entries.`); return value; }
function unique(entries, label) { if (new Set(entries.map((e) => e.id)).size !== entries.length) fail(`${label} contains duplicate IDs.`); }
function stamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail("The report receipt timestamp must include a timezone."); return new Date(value).toISOString(); }
function itemFor(items, targetId) { const item = items.find((i) => i.id === targetId); if (!item) fail("Food item not found. Refresh the inventory.", 404, 'ITEM_NOT_FOUND'); return item; }
function snapshot(item) { return clone(Object.fromEntries(['name', 'unit', 'nutrition', 'gramsPerUnit', 'ingredients', 'supplementFacts'].map((key) => [key, item[key] ?? null]))); }
const UNITS = new Set(['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const nameKey = (value) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, '');
function untrackedNutrition(raw, unit) {
  if (raw === undefined) return { basisAmount: 1, basisUnit: unit, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown', sourceNote: '', sourceText: '', nutrientSources: { kcal: 'unknown', protein: 'unknown', carbs: 'unknown', fat: 'unknown' } };
  obj(raw, "Untracked food nutrition"); if (!UNITS.has(raw.basisUnit)) fail("Nutrition must specify a valid basis unit."); const source = raw.source ?? 'unknown'; if (!SOURCES.has(source)) fail("Invalid nutrition source.");
  const result = { basisAmount: qty(raw.basisAmount), basisUnit: raw.basisUnit, source, sourceNote: str(raw.sourceNote, "Nutrition note", 1000, true), sourceText: str(raw.sourceText, "Nutrition source text", 16000, true), nutrientSources: {} };
  if (raw.nutrientSources !== undefined) obj(raw.nutrientSources, "Per-nutrient sources");
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) { result[key] = qty(raw[key] ?? null, true, false); const fieldSource = raw.nutrientSources?.[key] ?? source; if (!SOURCES.has(fieldSource)) fail("Invalid per-nutrient source."); result.nutrientSources[key] = result[key] === null ? 'unknown' : fieldSource; }
  const sources = new Set(['kcal', 'protein', 'carbs', 'fat'].filter(key => result[key] !== null).map(key => result.nutrientSources[key])); result.source = sources.size === 1 ? [...sources][0] : sources.has('estimate') ? 'estimate' : 'unknown';
  return result;
}
function storedActualLinks(previous, raw, unit) {
  return previous?.id === raw.id && previous.itemId === raw.itemId && previous.unit === unit
    && (raw.itemId !== null || nameKey(previous.name) === nameKey(raw.name)) && Array.isArray(previous.syncActualEntryIds)
    ? { syncActualEntryIds: clone(previous.syncActualEntryIds) } : {};
}
function plannedLine(raw, items, previous) {
  obj(raw, "Planned food");
  if (raw.itemId === null) {
    const name = str(raw.name, "Untracked food name", 200); const unit = str(raw.unit, "Untracked food unit", 20); if (!UNITS.has(unit)) fail("Untracked food must specify a valid unit.");
    if (items.some(item => nameKey(item.name) === nameKey(name))) fail("This food already exists in inventory. Reference its ID; untracked food cannot bypass unavailable or pending status.", 409, 'TRACKED_FOOD_REQUIRES_ID');
    const nutrition = untrackedNutrition(raw.nutrition, unit);
    const preserve = previous?.itemId === null && previous.id === id(raw.id) && previous.name === name && previous.unit === unit && equal(previous.nutrition, raw.nutrition === undefined ? undefined : nutrition);
    return { id: id(raw.id), itemId: null, name, quantity: qty(raw.quantity), unit, sourceText: str(raw.sourceText, "Food source text", 10000, true), ...(raw.nutrition === undefined ? {} : { nutrition }), nutritionSnapshot: preserve && previous.nutritionSnapshot !== undefined ? clone(previous.nutritionSnapshot) : { name, unit, nutrition, gramsPerUnit: null, ingredients: '', supplementFacts: '' }, ...storedActualLinks(previous, raw, unit) };
  }
  const item = itemFor(items, id(raw.itemId, "Food item ID")); if (item.category === 'supplement') fail("Supplements must be recorded separately in supplementDoses."); const unit = raw.unit === undefined ? item.unit : str(raw.unit, "Unit", 20);
  // A server-synchronized weighed line may retain its recorded physical unit.
  // Only the same saved identity/unit is trusted; input cannot create this link.
  const savedSyncUnit = previous?.id === raw.id && previous.itemId === item.id && previous.unit === unit
    && Array.isArray(previous.syncActualEntryIds) && previous.syncActualEntryIds.length > 0;
  if (unit !== item.unit && !savedSyncUnit) fail("The planned unit must match the inventory unit. No automatic conversion is applied.");
  const nutritionSnapshot = snapshot(item);
  let nutrition;
  if (raw.nutrition !== undefined) {
    nutrition = untrackedNutrition(raw.nutrition, unit);
    if (nutrition.basisUnit !== unit) fail("This plan's nutrition estimate must explicitly use the planned food unit. Can-to-gram conversions are not inferred.");
    const known = ['kcal', 'protein', 'carbs', 'fat'].filter(key => nutrition[key] !== null);
    if (!known.length || raw.nutrition.source !== 'estimate' || known.some(key => nutrition.nutrientSources[key] !== 'estimate')) fail("A planned nutrition override for inventory food requires explicit values with source=estimate. Keep unknown values null; do not claim these are inventory label values.");
    if (!nutrition.sourceText.trim() && !nutrition.sourceNote.trim()) fail("This planned nutrition estimate requires a nonempty sourceText or sourceNote explaining its basis.");
    const disclaimer = "[Estimate for this plan only] Does not change inventory nutrition labels or grams per unit.";
    if (!nutrition.sourceNote.startsWith(disclaimer)) nutrition.sourceNote = disclaimer + (nutrition.sourceNote ? '\n' + nutrition.sourceNote : '');
    if (nutrition.sourceNote.length > 1000) fail("The planned nutrition note, including its basis notice, exceeds 1000 characters. Move detailed evidence to sourceText; no text was truncated.");
    nutritionSnapshot.nutrition = clone(nutrition);
  }
  const preserve = previous?.id === id(raw.id) && previous.itemId === item.id && previous.unit === unit && equal(previous.nutrition, nutrition);
  return { id: id(raw.id), itemId: item.id, quantity: qty(raw.quantity), unit, sourceText: str(raw.sourceText, "Food source text", 10000, true), ...(nutrition === undefined ? {} : { nutrition }), nutritionSnapshot: preserve && previous.nutritionSnapshot !== undefined ? clone(previous.nutritionSnapshot) : nutritionSnapshot, ...storedActualLinks(previous, raw, unit) };
}
function meal(raw, items, previous) {
  obj(raw, "Meal"); const mealId = id(raw.id); if (!SLOTS.has(raw.slot)) fail("Invalid meal slot.");
  const lines = list(raw.plannedItems, "Planned food", 100).map((line) => plannedLine(line, items, previous?.plannedItems.find((old) => old.id === line.id))); unique(lines, "Planned food");
  const groups = raw.recipeGroups === undefined ? previous?.recipeGroups : raw.recipeGroups;
  return { id: mealId, slot: raw.slot, title: str(raw.title, "Meal title", 200), plannedTime: time(raw.plannedTime), plannedTimeText: str(raw.plannedTimeText, "Planned time source text", 500, true), plannedItems: lines,
    ...(groups === undefined ? {} : { recipeGroups: normalizeRecipeGroups(groups, lines, { pruneMissing: raw.recipeGroups === undefined,
      previousGroups: previous?.recipeGroups, acceptStoredBasis: raw.recipeGroups === undefined }) }),
    ...(previous?.actualRecipeGroups === undefined ? {} : { actualRecipeGroups: clone(previous.actualRecipeGroups) }),
    ...(previous?.actualRecipeGroupHistory === undefined ? {} : { actualRecipeGroupHistory: clone(previous.actualRecipeGroupHistory) }),
    actualEntries: previous?.actualEntries ?? [], actualTime: previous?.actualTime ?? null, actualTimeText: previous?.actualTimeText ?? '', completionReportedAt: previous?.completionReportedAt ?? null, sourceText: previous?.sourceText ?? '', reportHistory: previous?.reportHistory ?? [], state: previous?.state ?? 'reserved', ...(previous?.planRevisionHistory === undefined ? {} : { planRevisionHistory: clone(previous.planRevisionHistory) }) };
}
function flag(value, fallback, label) { if (value === undefined) return fallback; if (typeof value !== 'boolean') fail(`${label} must explicitly be true or false.`); return value; }
function doseMetadata(raw, previous) {
  const requirement = raw.requirement === undefined ? previous?.requirement ?? 'daily' : raw.requirement; if (!REQUIREMENTS.has(requirement)) fail("Invalid supplement requirement.");
  const timingSlot = raw.timingSlot === undefined ? previous?.timingSlot ?? 'other' : raw.timingSlot; if (!DOSE_SLOTS.has(timingSlot)) fail("Invalid supplement timing slot.");
  const scheduled = flag(raw.scheduled, raw.requirement === undefined ? previous?.scheduled ?? requirement === 'daily' : requirement === 'daily', "Include in this day's plan");
  return { timingSlot, requirement, scheduled, instruction: str(raw.instruction === undefined ? previous?.instruction : raw.instruction, "Supplement instructions", 1000, true), trainingDayOnly: flag(raw.trainingDayOnly, previous?.trainingDayOnly ?? false, "Training days only") };
}
function doseScheduled(entity) { return entity.scheduled ?? (entity.requirement ?? 'daily') === 'daily'; }
export function supplementChecked(entity) { return (entity.actualEntries ?? []).some((entry) => entry.quantity === null || entry.quantity > 0); }
function dose(raw, items, previous) {
  obj(raw, "Supplement dose"); const item = itemFor(items, id(raw.itemId, "Supplement ID")); if (item.category !== 'supplement') fail("Supplement doses may reference only supplement inventory.");
  const unit = raw.unit === undefined ? item.unit : str(raw.unit, "Supplement unit", 20); if (unit !== item.unit) fail("Use the supplement's inventory unit; mg or IU are not automatically converted.");
  const preserve = previous?.id === id(raw.id) && previous.itemId === item.id && previous.unit === unit && previous.nutritionSnapshot !== undefined;
  return { id: id(raw.id), itemId: item.id, plannedQuantity: qty(raw.plannedQuantity, true), unit, ...doseMetadata(raw, previous), plannedMealId: raw.plannedMealId == null ? null : id(raw.plannedMealId), plannedTime: time(raw.plannedTime), plannedTimeText: str(raw.plannedTimeText, "Planned time source text", 500, true), sourceText: str(raw.sourceText, "Supplement source text", 10000, true), nutritionSnapshot: preserve ? clone(previous.nutritionSnapshot) : snapshot(item), actualEntries: previous?.actualEntries ?? [], actualTime: previous?.actualTime ?? null, actualTimeText: previous?.actualTimeText ?? '', actualMealId: previous?.actualMealId ?? null, reportSourceText: previous?.reportSourceText ?? '', reportHistory: previous?.reportHistory ?? [], completionReportedAt: previous?.completionReportedAt ?? null, state: previous?.state ?? 'reserved' };
}
function content(plan) { return { id: plan.id, date: plan.date, title: plan.title, timeZone: plan.timeZone, notes: plan.notes, meals: plan.meals.map((m) => ({ id: m.id, slot: m.slot, title: m.title, plannedTime: m.plannedTime, plannedTimeText: m.plannedTimeText, plannedItems: m.plannedItems.map(({ nutritionSnapshot, ...line }) => line), ...(m.recipeGroups === undefined ? {} : { recipeGroups: clone(m.recipeGroups) }), ...(m.actualRecipeGroups === undefined ? {} : { actualRecipeGroups: clone(m.actualRecipeGroups) }), actualRecipeGroupHistoryCount: rows(m.actualRecipeGroupHistory).length })), supplementDoses: plan.supplementDoses.map((d) => ({ id: d.id, itemId: d.itemId, plannedQuantity: d.plannedQuantity, unit: d.unit, ...doseMetadata(d), plannedMealId: d.plannedMealId, plannedTime: d.plannedTime, plannedTimeText: d.plannedTimeText, sourceText: d.sourceText })) }; }
function draftContent(plan) {
  const result = { ...content(plan), patchDraft: true };
  for (const m of result.meals) for (const line of m.plannedItems) line.nutritionSnapshot = clone(plan.meals.find(old => old.id === m.id).plannedItems.find(old => old.id === line.id).nutritionSnapshot);
  for (const d of result.supplementDoses) d.nutritionSnapshot = clone(plan.supplementDoses.find(old => old.id === d.id).nutritionSnapshot);
  return result;
}
function normalizePlan(raw, items, at, previous, inheritMissingDoses = true) {
  obj(raw, "Diet plan"); const planId = id(raw.id, "Plan ID"); const zone = raw.timeZone ?? 'America/Toronto'; try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { fail("Invalid timezone."); }
  const meals = list(raw.meals, "Meal", 16).map((m) => meal(m, items, previous?.meals.find((p) => p.id === m.id))); unique(meals, "Meal");
  const incomingDoses = list(raw.supplementDoses ?? [], "Supplement dose", 32).map((entry) => {
    obj(entry, "Supplement dose");
    if (!previous || previous.supplementDoses.some((old) => old.id === entry.id)) return entry;
    const matches = previous.supplementDoses.filter((old) => old.itemId === entry.itemId && routineSlot(old, previous) === routineSlot(entry, { meals }));
    if (matches.length > 1) fail("Multiple existing doses share this supplement timing slot. Read and reuse their original dose IDs instead of creating duplicates.", 409, 'SUPPLEMENT_DOSE_AMBIGUOUS');
    return matches.length === 1 ? { ...entry, id: matches[0].id } : entry;
  });
  const inheritedDoses = previous && inheritMissingDoses ? previous.supplementDoses.filter((d) => !incomingDoses.some((entry) => entry.id === d.id) && (previous.supplementOnly || raw.supplementDoses === undefined || hasFacts(d))) : [];
  const doses = list([...incomingDoses, ...inheritedDoses], "Daily supplement doses", 32).map((d) => dose(d, items, previous?.supplementDoses.find((p) => p.id === d.id))); unique(doses, "Supplement dose");
  for (const d of doses) if (d.plannedMealId && !meals.some((m) => m.id === d.plannedMealId)) fail("The meal linked to this supplement does not exist.");
  if (!meals.length && !doses.length) fail("A plan must contain at least one meal or supplement dose.");
  return { id: planId, format: 'meals_v1', date: date(raw.date), title: str(raw.title, "Plan title", 200), timeZone: zone, notes: str(raw.notes, "Plan notes", 10000, true), meals, supplementDoses: doses, status: previous?.status ?? 'draft', items: previous?.items ?? [], accountedDebits: previous?.accountedDebits ?? [], allocationAdjustments: previous?.allocationAdjustments ?? {}, inventoryAccounting: previous?.inventoryAccounting ?? 'settled', accountingIssues: previous?.accountingIssues ?? [], ...(!previous || previous.foodAccounting === 'actual_only' || previous.status === 'draft' || previous.supplementOnly ? { foodAccounting: 'actual_only', supplementAccounting: 'actual_only' } : previous.supplementAccounting ? { supplementAccounting: previous.supplementAccounting } : {}), ...(previous?.legacyReservations ? { legacyReservations: clone(previous.legacyReservations) } : {}), ...(previous?.supplementOnly ? { supplementOnly: meals.length === 0 } : {}), ...(previous?.intakeDraft ? { intakeDraft: clone(previous.intakeDraft) } : {}), ...(previous?.intakeDraftAudit ? { intakeDraftAudit: clone(previous.intakeDraftAudit) } : {}), intakeBasis: previous?.intakeBasis ?? 'none', createdAt: previous?.createdAt ?? at, updatedAt: at };
}

// Historical plans may already have deducted their planned portions. Freeze that
// accounting basis before editing, so a later supplement check cannot reserve the
// newly edited menu or refund untouched historical credits.
function preservePlanAccounting(old, next) {
  // Personal reminders and the frozen automatic-accounting basis belong to
  // the server record, never to a replacement menu supplied by Chat.
  for (const key of ['personalFoodChecks', 'dailySettlement', 'accountingWarnings', 'accountingAdjustmentHistory', 'foodLayoutOverrides', 'foodLayoutHistory']) if (old?.[key] !== undefined) next[key] = clone(old[key]);
  if (!old || next.foodAccounting === 'actual_only' || old.status === 'draft' || old.supplementOnly) return;
  next.legacyReservations = clone(old.legacyReservations ?? {
    meals: old.meals.map(m => ({ id: m.id, plannedItems: m.plannedItems.map(l => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit })) })),
    supplementDoses: old.supplementDoses.map(d => ({ id: d.id, itemId: d.itemId, plannedQuantity: d.plannedQuantity, unit: d.unit, scheduled: doseScheduled(d) })),
    allocationAdjustments: old.allocationAdjustments ?? {},
  });
}
function currentForWrite(state, plan) {
  const next = clone(projectCurrentDietPlan(plan, state.items));
  delete next.draft;
  if (plan.foodAccounting === 'actual_only' || plan.status === 'draft' || plan.supplementOnly) {
    next.foodAccounting = 'actual_only'; next.supplementAccounting = 'actual_only';
  }
  preservePlanAccounting(plan, next);
  if (next.meals.length && plan.supplementOnly) next.supplementOnly = false;
  return next;
}
/** A detached editing view; server-stored draft snapshots are not client inputs. */
export function materializeDietPlanForEdit(state, planOrId, view = 'draft') {
  if (!['draft', 'active'].includes(view)) fail("Edit view must be draft or active.");
  const planId = id(typeof planOrId === 'string' ? planOrId : planOrId?.id, "Plan ID");
  const source = (state.plans ?? []).find(plan => plan.id === planId);
  if (!source) fail("Diet plan not found.", 404, 'PLAN_NOT_FOUND');
  if (source.format !== 'meals_v1') fail("Legacy flat plans cannot serve as a meal edit view.", 409, 'LEGACY_PLAN_CONFLICT');
  if (view === 'active' || !source.draft) return clone(source);
  const result = clone(projectCurrentDietPlan(source, state.items));
  delete result.draft;
  return result;
}

const PATCH_KEYS = new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mode', 'confirmed', 'allocationOnly', 'title', 'notes', 'mealPatches', 'supplementPatches']);
const MEAL_PATCH_KEYS = new Set(['id', 'remove', 'slot', 'title', 'plannedTime', 'plannedTimeText', 'itemPatches', 'recipeGroups']);
const ITEM_PATCH_KEYS = new Set(['id', 'remove', 'itemId', 'name', 'quantity', 'unit', 'sourceText', 'nutrition']);
const NUTRITION_PATCH_KEYS = new Set(['basisAmount', 'basisUnit', 'kcal', 'protein', 'carbs', 'fat', 'source', 'sourceNote', 'sourceText', 'nutrientSources']);
const DOSE_PATCH_KEYS = new Set(['id', 'remove', 'itemId', 'plannedQuantity', 'unit', 'plannedMealId', 'plannedTime', 'plannedTimeText', 'sourceText', 'timingSlot', 'requirement', 'scheduled', 'instruction', 'trainingDayOnly']);
function patchObject(raw, keys, label) {
  obj(raw, label); if (Reflect.ownKeys(raw).some(key => !keys.has(key))) fail(`${label} contains unsupported fields; plan patches cannot overwrite actual reports or snapshots.`, 400, 'UNKNOWN_PATCH_FIELD');
  if (raw.remove !== undefined && typeof raw.remove !== 'boolean') fail("remove must explicitly be true or false.");
  if (raw.remove === true && Object.keys(raw).some(key => !['id', 'remove'].includes(key))) fail("remove=true cannot be combined with edit fields.");
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}
function patches(raw, keys, label, max) {
  const entries = list(raw === undefined ? [] : raw, label, max).map(value => { const result = patchObject(value, keys, label); return { ...result, id: id(result.id) }; });
  unique(entries, label); return entries;
}
function mergePatch(previous, patch) {
  const { remove, itemPatches, ...fields } = patch;
  return { ...(previous ?? {}), ...fields };
}
function patchPlan(base, payload, items) {
  const next = clone(base); delete next.draft;
  if (payload.title !== undefined) next.title = str(payload.title, "Plan title", 200);
  if (payload.notes !== undefined) next.notes = str(payload.notes, "Plan notes", 10000, true);
  const mealPatches = patches(payload.mealPatches, MEAL_PATCH_KEYS, "Meal patches", 16);
  const dosePatches = patches(payload.supplementPatches, DOSE_PATCH_KEYS, "Supplement patches", 32);
  if (!mealPatches.length && !dosePatches.length && payload.title === undefined && payload.notes === undefined) fail("Specify at least one field to edit.");
  for (const patch of mealPatches) {
    const index = next.meals.findIndex(m => m.id === patch.id); const before = index < 0 ? null : next.meals[index];
    if (patch.remove) { if (!before) fail("The meal to delete does not exist.", 404, 'MEAL_NOT_FOUND'); next.meals.splice(index, 1); continue; }
    const input = mergePatch(before, patch);
    let changed = before ? clone(before) : meal({ ...input, plannedItems: [], recipeGroups: undefined }, items);
    if (patch.slot !== undefined) { if (!SLOTS.has(patch.slot)) fail("Invalid meal slot."); changed.slot = patch.slot; }
    if (patch.title !== undefined) changed.title = str(patch.title, "Meal title", 200);
    if (patch.plannedTime !== undefined) changed.plannedTime = time(patch.plannedTime);
    if (patch.plannedTimeText !== undefined) changed.plannedTimeText = str(patch.plannedTimeText, "Planned time source text", 500, true);
    for (const linePatch of patches(patch.itemPatches, ITEM_PATCH_KEYS, "Food patches", 100)) {
      const lineIndex = changed.plannedItems.findIndex(line => line.id === linePatch.id); const oldLine = lineIndex < 0 ? null : changed.plannedItems[lineIndex];
      if (linePatch.remove) { if (!oldLine) fail("The food line to delete does not exist.", 404, 'LINE_NOT_FOUND'); changed.plannedItems.splice(lineIndex, 1); continue; }
      const raw = mergePatch(oldLine, linePatch); delete raw.nutritionSnapshot;
      if (oldLine && raw.itemId !== oldLine.itemId) {
        for (const key of ['unit', 'name', 'sourceText']) if (linePatch[key] === undefined) delete raw[key];
        const newItem = raw.itemId === null ? null : itemFor(items, id(raw.itemId, "Food item ID"));
        if (newItem && newItem.unit !== oldLine.unit && linePatch.quantity === undefined) fail("The replacement food uses a different unit. Specify its new quantity; the old quantity cannot be carried over as a conversion.");
      }
      if (linePatch.nutrition !== undefined) {
        patchObject(linePatch.nutrition, NUTRITION_PATCH_KEYS, "Planned nutrition");
        if (linePatch.nutrition.nutrientSources !== undefined) patchObject(linePatch.nutrition.nutrientSources, new Set(['kcal', 'protein', 'carbs', 'fat']), "Nutrition source");
      }
      const identityChanged = oldLine && (raw.itemId !== oldLine.itemId || raw.unit !== oldLine.unit || raw.itemId === null && raw.name !== oldLine.name);
      if (identityChanged && linePatch.nutrition === undefined) delete raw.nutrition;
      if (identityChanged && linePatch.sourceText === undefined) delete raw.sourceText;
      if (linePatch.name !== undefined && raw.itemId !== null) fail("Inventory food names come from inventory. Change itemId to replace food; name is only for untracked food.");
      const line = plannedLine(raw, items, identityChanged ? undefined : oldLine);
      if (lineIndex < 0) changed.plannedItems.push(line); else changed.plannedItems[lineIndex] = line;
    }
    list(changed.plannedItems, "Planned food", 100); unique(changed.plannedItems, "Planned food");
    if (patch.recipeGroups !== undefined) changed.recipeGroups = normalizeRecipeGroups(patch.recipeGroups, changed.plannedItems, { previousGroups: before?.recipeGroups });
    else if (changed.recipeGroups !== undefined) changed.recipeGroups = pruneRecipeGroups(changed.recipeGroups, changed.plannedItems);
    if (index < 0) next.meals.push(changed); else next.meals[index] = changed;
  }
  for (const patch of dosePatches) {
    const index = next.supplementDoses.findIndex(d => d.id === patch.id); const before = index < 0 ? null : next.supplementDoses[index];
    if (patch.remove) { if (!before) fail("The supplement dose to delete does not exist.", 404, 'DOSE_NOT_FOUND'); next.supplementDoses.splice(index, 1); continue; }
    const input = mergePatch(before, patch);
    if (before && input.itemId !== before.itemId) {
      for (const key of ['unit', 'sourceText']) if (patch[key] === undefined) delete input[key];
      if (itemFor(items, id(input.itemId, "Supplement ID")).unit !== before.unit && patch.plannedQuantity === undefined) fail("The replacement supplement uses a different unit. Specify its new plannedQuantity, or null if unknown.");
    }
    const changed = dose(input, items, before);
    if (index < 0) next.supplementDoses.push(changed); else next.supplementDoses[index] = changed;
  }
  list(next.meals, "Meal", 16); list(next.supplementDoses, "Supplement dose", 32);
  for (const d of next.supplementDoses) if (d.plannedMealId && !next.meals.some(m => m.id === d.plannedMealId) || d.actualMealId && !next.meals.some(m => m.id === d.actualMealId)) fail("This meal is still referenced by a supplement plan or actual report and cannot be deleted. Explicitly update planned links and preserve actual links.", 409, 'MEAL_REFERENCE_CONFLICT');
  if (!next.meals.length && !next.supplementDoses.length) fail("A plan must contain at least one meal or supplement dose.");
  return next;
}
function hasFacts(entity) { return entity.actualEntries.length > 0 || entity.completionReportedAt !== null || entity.actualTime !== null || !!entity.actualTimeText || !!entity.reportHistory?.length; }
function anyFacts(plan) { return [...plan.meals, ...plan.supplementDoses].some(hasFacts); }
function samePlanned(a, b, supplement = false) { return supplement ? equal([a.itemId, a.plannedQuantity, a.unit], [b.itemId, b.plannedQuantity, b.unit]) : equal(a.plannedItems.map(({ nutritionSnapshot, sourceText, ...line }) => line), b.plannedItems.map(({ nutritionSnapshot, sourceText, ...line }) => line)); }
function actualFacts(entity, supplement = false) {
  const keys = ['actualEntries', 'actualTime', 'actualTimeText', 'completionReportedAt', 'reportHistory', 'state', ...(supplement ? ['actualMealId', 'reportSourceText'] : ['sourceText', 'actualRecipeGroups', 'actualRecipeGroupHistory'])];
  return Object.fromEntries(keys.map(key => [key, entity[key]]));
}
function intakeFactsWithoutGrouping(plan) {
  return [plan.meals.map(meal => {
    const { actualRecipeGroups: _groups, actualRecipeGroupHistory: _history, ...facts } = actualFacts(meal);
    return { id: meal.id, ...facts };
  }), plan.supplementDoses.map(dose => ({ id: dose.id, ...actualFacts(dose, true) }))];
}
function guardEdits(old, next) {
  if (old.date !== next.date) fail("A canonical plan's date cannot change. Use the plan ID belonging to the target date.", 409, 'PLAN_DATE_CONFLICT');
  for (const [key, supplement] of [['meals', false], ['supplementDoses', true]]) for (const before of old[key]) {
    const after = next[key].find(e => e.id === before.id);
    if (hasFacts(before) && (!after || supplement && !samePlanned(before, after, true))) fail("Meals with actual records cannot be deleted, and menu edits cannot overwrite supplements already taken. Correct actuals through their original records.", 409, 'CONSUMED_MEAL_CONFLICT');
    if (after && !equal(actualFacts(before, supplement), actualFacts(after, supplement))) fail("Menu edits cannot change actual entries, times, source text, or completion status.", 409, 'ACTUAL_FACTS_CONFLICT');
  }
}
function mealPlanFields(entity) {
  return clone(Object.fromEntries(['slot', 'title', 'plannedTime', 'plannedTimeText', 'plannedItems',
    ...(entity.recipeGroups === undefined ? [] : ['recipeGroups'])].map(key => [key, entity[key]])));
}
function recordMealPlanRevisions(old, next, at, includeDrafts = false) {
  if (old?.status !== 'reserved' && !(includeDrafts && old?.status === 'draft')) return;
  for (const before of old.meals) {
    const after = next.meals.find(meal => meal.id === before.id);
    if (!after || equal(mealPlanFields(before), mealPlanFields(after))) continue;
    const history = before.planRevisionHistory ?? [];
    if (history.length >= 200) fail("This meal reached 200 plan edits. Back up and organize its history; this edit was not saved.", 409, 'MEAL_PLAN_HISTORY_LIMIT');
    after.planRevisionHistory = [...clone(history), { at, previous: mealPlanFields(before) }];
  }
}
function add(map, itemId, quantity, unit) { const old = map.get(itemId); if (old && old.unit !== unit) fail("Conflicting units exist for the same food item.", 409, 'UNIT_CONFLICT'); const total = round((old?.quantity ?? 0) + quantity); if (total > MAX) fail("The cumulative quantity for this food exceeds the accounting limit.", 409, 'QUANTITY_OVERFLOW'); map.set(itemId, { itemId, quantity: total, unit }); }
function plannedFoodTotals(plan) { const result = new Map(); for (const m of plan.meals) for (const l of m.plannedItems) add(result, l.itemId === null ? JSON.stringify(['untracked', nameKey(l.name), l.unit]) : JSON.stringify(['tracked', l.itemId]), l.quantity, l.unit); return result; }
function canonicalTotals(map) { return [...map.values()].sort((a, b) => a.itemId.localeCompare(b.itemId)); }
function entityTarget(entity, supplement, issues, reservePlanned = true) {
  const result = new Map(); const actual = new Map();
  for (const e of entity.actualEntries) if (e.itemId !== null) {
    if (e.quantity === null) issues.push({ code: 'ACTUAL_QUANTITY_UNKNOWN', itemId: e.itemId, message: "Reported eaten, but quantity is unknown. Original text was preserved for review." });
    else add(actual, e.itemId, e.quantity, e.unit);
  }
  const planned = new Map(); if (supplement) { if (reservePlanned && doseScheduled(entity) && entity.plannedQuantity !== null) add(planned, entity.itemId, entity.plannedQuantity, entity.unit); } else if (reservePlanned) for (const l of entity.plannedItems) if (l.itemId !== null) add(planned, l.itemId, l.quantity, l.unit);
  if (!entity.actualEntries.length && !entity.accountingHadActualEntries && hasFacts(entity)) for (const itemId of supplement ? [entity.itemId] : planned.keys()) issues.push({ code: 'ACTUAL_QUANTITY_UNKNOWN', itemId, message: "A time or intake statement was reported without an actual quantity. Missing quantity is not evidence of no intake." });
  for (const itemId of new Set([...actual.keys(), ...planned.keys()])) {
    const p = planned.get(itemId); const a = actual.get(itemId); const quantity = ['completed', 'cancelled'].includes(entity.state) ? a?.quantity ?? 0 : Math.max(p?.quantity ?? 0, a?.quantity ?? 0);
    if (quantity > 0) add(result, itemId, quantity, a?.unit ?? p.unit);
  }
  return result;
}
function targets(plan, alreadyProjected = false) {
  if (!alreadyProjected) plan = dailyMenuAccountingPlan(plan);
  const issues = []; const food = new Map(); const actualFood = new Map(); const all = new Map();
  const reserveFood = plan.foodAccounting !== 'actual_only';
  const legacy = plan.legacyReservations;
  const closed = ['cancelled', 'closed_with_actuals'].includes(plan.status);
  const liveMealsFinished = plan.meals.every(m => ['completed', 'cancelled'].includes(m.state));
  const accountingMeals = legacy ? [
    ...legacy.meals.map(frozen => {
      const current = plan.meals.find(m => m.id === frozen.id);
      return { ...(current ?? { actualEntries: [], actualTime: null, actualTimeText: '', completionReportedAt: null, sourceText: '', reportHistory: [], state: closed || liveMealsFinished ? 'cancelled' : 'reserved' }), plannedItems: frozen.plannedItems };
    }),
    ...plan.meals.filter(m => !legacy.meals.some(frozen => frozen.id === m.id)).map(m => ({ ...m, plannedItems: [] })),
  ] : plan.meals;
  for (const m of accountingMeals) {
    for (const l of entityTarget(m, false, issues, reserveFood).values()) add(food, l.itemId, l.quantity, l.unit);
    for (const e of m.actualEntries) if (e.itemId !== null && e.quantity !== null) add(actualFood, e.itemId, e.quantity, e.unit);
  }
  const foodFinished = accountingMeals.every((m) => ['completed', 'cancelled'].includes(m.state));
  const adjustments = reserveFood ? legacy?.allocationAdjustments ?? plan.allocationAdjustments ?? {} : {};
  for (const itemId of new Set([...food.keys(), ...actualFood.keys(), ...Object.keys(adjustments)])) {
    const line = food.get(itemId) ?? actualFood.get(itemId) ?? plan.accountedDebits.find((l) => l.itemId === itemId);
    const quantity = foodFinished ? actualFood.get(itemId)?.quantity ?? 0 : Math.max(actualFood.get(itemId)?.quantity ?? 0, round((food.get(itemId)?.quantity ?? 0) + (adjustments[itemId] ?? 0)));
    if (quantity > 0) add(all, itemId, quantity, line.unit);
  }
  const accountingDoses = legacy ? [
    ...legacy.supplementDoses.map(frozen => ({ ...(plan.supplementDoses.find(d => d.id === frozen.id) ?? { actualEntries: [], actualTime: null, actualTimeText: '', completionReportedAt: null, reportHistory: [], state: closed ? 'cancelled' : 'reserved' }), ...frozen })),
    ...plan.supplementDoses.filter(d => !legacy.supplementDoses.some(frozen => frozen.id === d.id)).map(d => ({ ...d, scheduled: false })),
  ] : plan.supplementDoses;
  for (const d of accountingDoses) for (const l of entityTarget(d, true, issues, plan.supplementAccounting !== 'actual_only').values()) add(all, l.itemId, l.quantity, l.unit);
  return { lines: all, issues };
}
function isBlockingAccountingIssue(issue, items) {
  // An unknown actual dose cannot make an already unknown balance less exact.
  // Keep the report unknown, while retaining every other accounting safeguard.
  return issue.code !== 'ACTUAL_QUANTITY_UNKNOWN' || items.find((item) => item.id === issue.itemId)?.quantity !== null;
}
function unknownActualUnitIssues(plan, items) {
  const issues = [];
  // A completed unknown quantity has no target debit. Inspect the original
  // entry as well, including legacy plans whose saved issues lack this check.
  for (const entity of [...plan.meals, ...plan.supplementDoses]) for (const entry of entity.actualEntries) {
    const current = entry.quantity === null && entry.unit ? items.find((item) => item.id === entry.itemId) : null;
    if (current && entry.unit !== current.unit && !issues.some((issue) => issue.itemId === current.id)) issues.push({ code: 'UNIT_CONFLICT', itemId: current.id, message: "Actual and inventory units differ. No automatic conversion is applied." });
  }
  return issues;
}
function accountingTargetIds(plan, previous) {
  const ids = new Set(previous.keys());
  for (const meal of [...plan.meals, ...(plan.legacyReservations?.meals ?? [])]) {
    for (const line of [...(meal.plannedItems ?? []), ...(meal.actualEntries ?? [])]) if (line.itemId !== null) ids.add(line.itemId);
  }
  for (const dose of [...plan.supplementDoses, ...(plan.legacyReservations?.supplementDoses ?? [])]) {
    if (dose.itemId !== null) ids.add(dose.itemId);
    for (const entry of dose.actualEntries ?? []) if (entry.itemId !== null) ids.add(entry.itemId);
  }
  for (const key of Object.keys(plan.legacyReservations?.allocationAdjustments ?? plan.allocationAdjustments ?? {})) ids.add(key);
  return ids;
}
function isolateTargetItem(plan, itemId) {
  // Filtering another food out must not turn an originally itemized report
  // into a time-only report whose saved planned amount is now "unknown".
  const meal = value => ({ ...value, plannedItems: (value.plannedItems ?? []).filter(line => line.itemId === itemId),
    actualEntries: (value.actualEntries ?? []).filter(entry => entry.itemId === itemId),
    accountingHadActualEntries: (value.actualEntries?.length ?? 0) > 0 });
  const doses = values => values.filter(value => value.itemId === itemId || value.actualEntries?.some(entry => entry.itemId === itemId)).map(value => ({ ...value,
    actualEntries: (value.actualEntries ?? []).filter(entry => entry.itemId === itemId), accountingHadActualEntries: (value.actualEntries?.length ?? 0) > 0,
    ...(value.itemId === itemId ? {} : { plannedQuantity: null, scheduled: false }) }));
  const adjustments = values => Object.hasOwn(values ?? {}, itemId) ? { [itemId]: values[itemId] } : {};
  return { ...plan, meals: plan.meals.map(meal), supplementDoses: doses(plan.supplementDoses),
    accountedDebits: plan.accountedDebits.filter(line => line.itemId === itemId), allocationAdjustments: adjustments(plan.allocationAdjustments),
    ...(plan.legacyReservations ? { legacyReservations: { ...plan.legacyReservations,
      meals: plan.legacyReservations.meals.map(meal), supplementDoses: plan.legacyReservations.supplementDoses.filter(value => value.itemId === itemId),
      allocationAdjustments: adjustments(plan.legacyReservations.allocationAdjustments) } } : {}) };
}
function itemTargets(plan, previous, allowPending) {
  const projected = dailyMenuAccountingPlan(plan);
  if (!allowPending) return { ...targets(projected, true), projected };
  const lines = new Map(), issues = [];
  for (const itemId of accountingTargetIds(projected, previous)) {
    try {
      const result = targets(isolateTargetItem(projected, itemId), true);
      if (result.lines.has(itemId)) lines.set(itemId, result.lines.get(itemId));
      issues.push(...result.issues);
    } catch (error) {
      if (!['UNIT_CONFLICT', 'QUANTITY_OVERFLOW'].includes(error.code)) throw error;
      issues.push({ code: error.code, itemId, message: error.message });
    }
  }
  return { lines, issues, projected };
}
function shortfallWarnings(lines) {
  return lines.filter(line => (line.shortfallQuantity ?? 0) > 0).map(line => ({ code: 'STOCK_SHORTFALL_RECORDED', itemId: line.itemId,
    quantity: line.shortfallQuantity, unit: line.unit, message: `This item was settled from its intake evidence. The recorded inventory shortfall of ${line.shortfallQuantity} ${unitLabel(line.unit, line.shortfallQuantity)} was recorded separately; inventory is floored at 0. Original intake evidence is preserved and repeated requests do not deduct again.` }));
}
function settle(items, old, next, at, allowPending = false, preserveDebit = false, inventoryState = null) {
  const previous = new Map((old?.accountedDebits ?? []).map((l) => [l.itemId, l]));
  const target = itemTargets(next, previous, allowPending);
  const issues = [...target.issues, ...unknownActualUnitIssues(next, items)].filter((issue) => isBlockingAccountingIssue(issue, items));
  if (preserveDebit) {
    // Explicit redistribution changes attribution, not the day's inventory debit.
    const oldFood = new Map(); const newFood = new Map();
    for (const m of old.meals) for (const l of entityTarget(m, false, []).values()) add(oldFood, l.itemId, l.quantity, l.unit);
    for (const m of next.meals) for (const l of entityTarget(m, false, []).values()) add(newFood, l.itemId, l.quantity, l.unit);
    next.allocationAdjustments = { ...(old.allocationAdjustments ?? {}) };
    for (const itemId of new Set([...oldFood.keys(), ...newFood.keys()])) next.allocationAdjustments[itemId] = round((next.allocationAdjustments[itemId] ?? 0) + (oldFood.get(itemId)?.quantity ?? 0) - (newFood.get(itemId)?.quantity ?? 0));
    next.items = clone(old.items); next.accountedDebits = clone(old.accountedDebits); return { items, plan: next };
  }
  const nextLines = [], changes = new Map(), adjustments = [];
  const supplementIds = new Set([...target.projected.supplementDoses, ...(target.projected.legacyReservations?.supplementDoses ?? [])].map(dose => dose.itemId));
  for (const itemId of new Set([...previous.keys(), ...target.lines.keys()])) {
    const before = previous.get(itemId); const after = target.lines.get(itemId); const current = items.find((i) => i.id === itemId); const delta = round((after?.quantity ?? 0) - (before?.quantity ?? 0));
    if (!current) { issues.push({ code: 'ITEM_NOT_FOUND', itemId, message: "Inventory referenced by an actual record or historical reservation no longer exists." }); if (before) nextLines.push(clone(before)); continue; }
    if (after && after.unit !== current.unit) issues.push({ code: 'UNIT_CONFLICT', itemId, message: "Actual and inventory units differ. No automatic conversion is applied." });
    if (before && after && before.unit !== after.unit) issues.push({ code: 'BASELINE_REQUIRES_REVIEW', itemId, message: "Historical reservation and new usage units differ. Matching numbers cannot reinterpret old accounts; review the inventory baseline first." });
    const priorShortfall = before?.shortfallQuantity ?? 0;
    if (!Number.isFinite(priorShortfall) || priorShortfall < 0 || priorShortfall > (before?.quantity ?? 0)) issues.push({ code: 'INVALID_ACCOUNTING_SHORTFALL', itemId, message: "The earlier shortfall record is invalid. This item was preserved for review." });
    let stockDelta = delta, shortfall = priorShortfall;
    if (delta !== 0) {
      const boundaryIssue = !supplementIds.has(itemId) ? foodBalanceBoundaryIssue(inventoryState, current, next, delta,
        { previousCredit: before, previousPlan: old, accountingPlan: target.projected }) : null;
      if (boundaryIssue) issues.push(boundaryIssue);
      if (before && (baseline(current) !== before.baselineToken || current.unit !== before.unit || (current.quantity === null) !== before.unknownBalance)) issues.push({ code: 'BASELINE_REQUIRES_REVIEW', itemId, message: "Inventory was recounted or its unit changed. Earlier accounts cannot be automatically added or subtracted." });
      if (delta > 0 && ['archived', 'pending'].includes(current.status)) issues.push({ code: 'ITEM_UNAVAILABLE', itemId, message: "The item is archived or pending review and cannot be reliably deducted." });
      if (delta < 0) {
        // A correction first removes the part never withdrawn from stock. Only
        // a genuinely deducted portion may be returned to the same baseline.
        const absorbed = Math.min(priorShortfall, -delta);
        stockDelta = round(delta + absorbed); shortfall = round(priorShortfall - absorbed);
      }
      if (current.quantity !== null && round(current.quantity - stockDelta) < 0) {
        const actual = target.projected.meals.flatMap(meal => meal.actualEntries).filter(entry => entry.itemId === itemId);
        const fullyReported = actual.every(entry => entry.quantity !== null && entry.unit === after?.unit)
          && round(actual.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0)) >= (after?.quantity ?? 0);
        if (allowPending && current.category !== 'supplement' && !supplementIds.has(itemId) && fullyReported) {
          shortfall = round(priorShortfall + stockDelta - current.quantity); stockDelta = current.quantity;
        } else issues.push({ code: 'INSUFFICIENT_STOCK', itemId, message: "Actual or reserved usage exceeds the recorded available balance and requires review." });
      }
      if (current.quantity !== null && round(current.quantity - stockDelta) > MAX) issues.push({ code: 'QUANTITY_OVERFLOW', itemId, message: "The refunded inventory would exceed the quantity limit." });
    }
    if (issues.some(issue => issue.itemId === itemId)) { if (before) nextLines.push(clone(before)); continue; }
    // An unchanged debit is historical credit, even after an independent count.
    // Never silently rebase or rewrite it while retrying another ingredient.
    if (delta === 0) { if (before) nextLines.push(clone(before)); continue; }
    if (after) nextLines.push({ ...after, name: current.name, unknownBalance: before?.unknownBalance ?? current.quantity === null,
      baselineToken: before?.baselineToken ?? baseline(current), ...(shortfall > 0 ? { shortfallQuantity: shortfall } : {}) });
    const quantity = current.quantity === null ? null : round(current.quantity - stockDelta);
    const status = ['archived', 'pending'].includes(current.status) ? current.status : quantity === 0 ? 'depleted' : 'available';
    if (stockDelta !== 0 || status !== current.status) changes.set(itemId, { ...current, quantity, status,
      quantityBaselineToken: baseline(current), updatedAt: at, confirmedAt: at });
    if (shortfall !== priorShortfall) adjustments.push({ at, itemId, unit: current.unit,
      code: shortfall > priorShortfall ? 'STOCK_SHORTFALL_RECORDED' : 'STOCK_SHORTFALL_REDUCED',
      basis: next.dailySettlement?.source === 'automatic_menu' ? 'automatic_menu' : 'reported_actual',
      targetBefore: before?.quantity ?? 0, targetAfter: after?.quantity ?? 0,
      stockBefore: current.quantity, stockAfter: quantity, shortfallBefore: priorShortfall, shortfallAfter: shortfall, inventoryDelta: stockDelta });
  }
  if (issues.length) {
    if (!allowPending) fail(issues[0].message, 409, issues[0].code);
  }
  const updated = items.map(current => changes.get(current.id) ?? current);
  next.accountedDebits = nextLines; next.items = clone(nextLines);
  next.inventoryAccounting = issues.length ? 'pending_reconciliation' : 'settled'; next.accountingIssues = issues;
  const warnings = [...(old?.accountingWarnings ?? []).filter(warning => warning.code !== 'STOCK_SHORTFALL_RECORDED'), ...shortfallWarnings(nextLines)];
  if (warnings.length || old?.accountingWarnings !== undefined) next.accountingWarnings = warnings;
  if (adjustments.length) next.accountingAdjustmentHistory = [...clone(old?.accountingAdjustmentHistory ?? []), ...adjustments];
  else if (old?.accountingAdjustmentHistory !== undefined) next.accountingAdjustmentHistory = clone(old.accountingAdjustmentHistory);
  refreshDailySettlementAccounting(next, at);
  return { items: updated, plan: next };
}
function refreshDailySettlementAccounting(plan, at) {
  if (plan.dailySettlement?.source !== 'automatic_menu') return;
  plan.dailySettlement = { ...plan.dailySettlement, accounting: plan.inventoryAccounting,
    settledAt: plan.inventoryAccounting === 'settled' ? plan.dailySettlement.settledAt ?? at : plan.dailySettlement.settledAt,
    lastReconciledAt: at, assumedMealIds: dailyMenuAssumedMealIds(plan) };
}
function settleFoodOnly(items, old, next, at, inventoryState = null) {
  const supplementIds = new Set([
    ...items.filter(item => item.category === 'supplement').map(item => item.id),
    ...[...old.supplementDoses, ...next.supplementDoses].flatMap(dose => [dose.itemId, ...dose.actualEntries.map(entry => entry.itemId)]),
    ...(old.legacyReservations?.supplementDoses ?? []).map(dose => dose.itemId),
  ].filter(Boolean));
  const supplementLine = line => supplementIds.has(line.itemId);
  const isolate = plan => ({ ...clone(plan), supplementDoses: [],
    items: plan.items.filter(line => !supplementLine(line)), accountedDebits: plan.accountedDebits.filter(line => !supplementLine(line)),
    accountingIssues: plan.accountingIssues.filter(issue => !issue.itemId || !supplementIds.has(issue.itemId)),
    ...(plan.accountingWarnings ? { accountingWarnings: plan.accountingWarnings.filter(warning => !supplementIds.has(warning.itemId)) } : {}),
    ...(plan.legacyReservations ? { legacyReservations: { ...clone(plan.legacyReservations), supplementDoses: [] } } : {}) });
  const result = settle(items, isolate(old), isolate(next), at, true, false, inventoryState);
  next.accountedDebits = [...result.plan.accountedDebits, ...clone(old.accountedDebits.filter(supplementLine))];
  next.items = [...result.plan.items, ...clone(old.items.filter(supplementLine))];
  next.accountingIssues = [...result.plan.accountingIssues, ...clone(old.accountingIssues.filter(issue => issue.itemId && supplementIds.has(issue.itemId)))];
  next.inventoryAccounting = next.accountingIssues.length ? 'pending_reconciliation' : 'settled';
  next.dailySettlement = result.plan.dailySettlement;
  if (result.plan.accountingWarnings !== undefined || old.accountingWarnings !== undefined) next.accountingWarnings = [...(result.plan.accountingWarnings ?? []), ...clone((old.accountingWarnings ?? []).filter(warning => supplementIds.has(warning.itemId)))];
  if (result.plan.accountingAdjustmentHistory !== undefined) next.accountingAdjustmentHistory = clone(result.plan.accountingAdjustmentHistory);
  return { items: result.items, plan: next };
}
function settleSupplements(items, old, next, at) {
  const supplementIds = new Set([...old.supplementDoses, ...next.supplementDoses].flatMap(d => [d.itemId, ...d.actualEntries.map(entry => entry.itemId)]).filter(Boolean));
  const isSupplementLine = line => supplementIds.has(line.itemId);
  const foodDebits = clone(old.accountedDebits.filter(line => !isSupplementLine(line)));
  const foodItems = clone(old.items.filter(line => !isSupplementLine(line)));
  const foodIssues = clone(old.accountingIssues.filter(issue => issue.itemId && !supplementIds.has(issue.itemId)));
  const isolated = plan => { const isolatedPlan = { ...clone(plan), meals: [], allocationAdjustments: {}, items: plan.items.filter(isSupplementLine), accountedDebits: plan.accountedDebits.filter(isSupplementLine), accountingIssues: plan.accountingIssues.filter(issue => !issue.itemId || supplementIds.has(issue.itemId)), ...(plan.accountingWarnings ? { accountingWarnings: plan.accountingWarnings.filter(warning => supplementIds.has(warning.itemId)) } : {}), ...(plan.legacyReservations ? { legacyReservations: { ...clone(plan.legacyReservations), meals: [], allocationAdjustments: {} } } : {}) }; delete isolatedPlan.dailySettlement; return isolatedPlan; };
  const result = settle(items, isolated(old), isolated(next), at, true);
  const preserveOrder = (previous, foodLines, supplementLines) => {
    const lines = new Map([...foodLines, ...supplementLines].map(line => [line.itemId, line]));
    return [...previous.filter(line => lines.has(line.itemId)).map(line => { const result = lines.get(line.itemId); lines.delete(line.itemId); return result; }), ...lines.values()];
  };
  next.accountedDebits = preserveOrder(old.accountedDebits, foodDebits, result.plan.accountedDebits);
  next.items = preserveOrder(old.items, foodItems, result.plan.items);
  next.accountingIssues = [...foodIssues, ...result.plan.accountingIssues];
  next.inventoryAccounting = next.accountingIssues.length ? 'pending_reconciliation' : 'settled';
  if (result.plan.accountingWarnings !== undefined || old.accountingWarnings !== undefined) next.accountingWarnings = [...clone((old.accountingWarnings ?? []).filter(warning => !supplementIds.has(warning.itemId))), ...(result.plan.accountingWarnings ?? [])];
  if (result.plan.accountingAdjustmentHistory !== undefined) next.accountingAdjustmentHistory = clone(result.plan.accountingAdjustmentHistory);
  return { items: result.items, plan: next };
}
const NUTRITION_CORRECTION_KEYS = new Set(['entryId', 'nutrition', 'gramsPerUnit', 'fromPlannedLineId', 'sourceText']);
const NUTRITION_CORRECTION_PAYLOAD_KEYS = new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mealId', 'mode', 'nutritionCorrections']);
const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const DISCRETE_NUTRITION_UNITS = new Set(['袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
function correctionNutrition(raw) {
  patchObject(raw, NUTRITION_PATCH_KEYS, "Actual nutrition");
  for (const key of ['basisAmount', 'basisUnit', 'source', ...NUTRIENT_KEYS]) if (!Object.hasOwn(raw, key) || raw[key] === undefined) fail("Nutrition corrections require a complete basis, source, and all four explicit nutrient values or null. Do not omit previous values or change basis without evidence.");
  if (!SOURCES.has(raw.source)) fail("Invalid actual nutrition source.");
  if (raw.nutrientSources !== undefined) patchObject(raw.nutrientSources, new Set(NUTRIENT_KEYS), "Actual nutrition source");
  const result = untrackedNutrition(raw, raw.basisUnit);
  if (!result.sourceNote.trim() && !result.sourceText.trim()) fail("Actual nutrition corrections require sourceNote or sourceText explaining the evidence.");
  if (NUTRIENT_KEYS.some(key => result[key] !== null && result.nutrientSources[key] === 'unknown')) fail("Provided actual nutrition values must identify a label, recipe, or estimate source.");
  return result;
}
function sameNutritionFood(line, entry) {
  return line.itemId === entry.itemId && line.unit === entry.unit && (entry.itemId !== null || nameKey(line.name) === nameKey(entry.name));
}
function nutritionSnapshotBase(entry) {
  return entry.nutritionSnapshot == null ? { name: entry.name, unit: entry.unit, nutrition: untrackedNutrition(undefined, entry.unit), gramsPerUnit: null, ingredients: '', supplementFacts: '' } : clone(entry.nutritionSnapshot);
}
function correctMealNutrition(state, payload, at) {
  patchObject(payload, NUTRITION_CORRECTION_PAYLOAD_KEYS, "Nutrition-only correction");
  if (payload.mode !== undefined && payload.mode !== 'correct') fail("For nutrition-only corrections, omit mode or use correct. Do not mix intake, time, or supplement reports.");
  const planId = id(payload.planId, "Plan ID"), mealId = id(payload.mealId, "Meal ID");
  const plans = (state.plans ?? []).slice(), index = plans.findIndex(plan => plan.id === planId), old = plans[index];
  if (!old) fail("Diet plan not found.", 404, 'PLAN_NOT_FOUND');
  if (old.format !== 'meals_v1') fail("Nutrition-only corrections apply only to actual records in structured meals.", 409, 'LEGACY_PLAN_CONFLICT');
  if (!['draft', 'reserved', 'closed_with_actuals'].includes(old.status)) fail("Nutrition-only corrections must reference actual records in an open or completed menu.", 409, 'PLAN_CLOSED');
  const next = clone(old), meal = next.meals.find(meal => meal.id === mealId);
  if (!meal) fail("Meal not found.", 404, 'MEAL_NOT_FOUND');
  const corrections = list(payload.nutritionCorrections, "Actual nutrition corrections", 100).map(raw => {
    patchObject(raw, NUTRITION_CORRECTION_KEYS, "Actual nutrition corrections");
    const result = { ...raw, entryId: str(raw.entryId, "Actual record ID", 400).trim(), sourceText: str(raw.sourceText, "Nutrition correction evidence", 10000) };
    if (raw.nutrition === undefined && raw.gramsPerUnit === undefined && raw.fromPlannedLineId === undefined) fail("Specify at least one of nutrition, gramsPerUnit, or fromPlannedLineId.");
    if (raw.nutrition !== undefined && raw.fromPlannedLineId !== undefined) fail("nutrition and fromPlannedLineId cannot be supplied together.");
    return result;
  });
  if (!corrections.length) fail("Provide at least one actual nutrition correction.");
  unique(corrections.map(raw => ({ id: raw.entryId })), "Actual nutrition corrections");
  let changed = 0;
  for (const correction of corrections) {
    const entry = meal.actualEntries.find(entry => entry.id === correction.entryId);
    if (!entry) fail("The actual record to correct was not found in this meal.", 404, 'ACTUAL_NOT_FOUND');
    const previous = entry.nutritionSnapshot == null ? null : clone(entry.nutritionSnapshot), nextSnapshot = nutritionSnapshotBase(entry);
    if (correction.fromPlannedLineId !== undefined) {
      const line = meal.plannedItems.find(line => line.id === id(correction.fromPlannedLineId, "Planned food line ID"));
      if (!line) fail("The food line was not found in the current confirmed meal. Unconfirmed drafts cannot be referenced.", 404, 'PLANNED_LINE_NOT_FOUND');
      if (!sameNutritionFood(line, entry)) fail("The planned nutrition reference must match the actual food identity and unit in this meal. Do not copy across foods or units.", 409, 'NUTRITION_IDENTITY_CONFLICT');
      if (!line.nutritionSnapshot?.nutrition) fail("The planned line has no nutrition evidence to reference.", 409, 'PLAN_NUTRITION_UNKNOWN');
      nextSnapshot.nutrition = clone(line.nutritionSnapshot.nutrition);
    } else if (correction.nutrition !== undefined) nextSnapshot.nutrition = correctionNutrition(correction.nutrition);
    if (correction.gramsPerUnit !== undefined) {
      const grams = qty(correction.gramsPerUnit, true);
      if (grams !== null && (entry.unit === 'ml' || nextSnapshot.nutrition?.basisUnit === 'ml' || !DISCRETE_NUTRITION_UNITS.has(entry.unit) && !(entry.unit === 'g' && DISCRETE_NUTRITION_UNITS.has(nextSnapshot.nutrition?.basisUnit)))) fail("This weight is only for an explicit discrete-unit-to-gram conversion. mL and active-ingredient mg are not grams.");
      nextSnapshot.gramsPerUnit = grams;
    }
    if (equal(previous, nextSnapshot)) continue;
    const history = entry.nutritionCorrectionHistory ?? [];
    if (history.length >= 100) fail("This actual entry reached 100 nutrition corrections. Back up and organize its history first.", 409, 'NUTRITION_HISTORY_LIMIT');
    entry.nutritionSnapshot = nextSnapshot;
    entry.nutritionCorrectionHistory = [...history, { at, sourceText: correction.sourceText, previous }];
    changed++;
  }
  if (!changed) return { items: state.items, plans: state.plans ?? [], detail: "The actual nutrition basis is unchanged. No correction or deduction was repeated.", inventoryEffect: 'none', noChange: true };
  next.updatedAt = at; plans[index] = next;
  // This branch intentionally skips report(), settle(), and pending-item flags.
  // Nutrition evidence changes never count as another intake or re-settle old stock.
  return { items: state.items, plans, detail: "Only the actual entry's nutrition or grams-per-unit basis was corrected. Quantity, actual time, intake source text, and inventory accounting are unchanged; nutrition still uses the saved basis.", inventoryEffect: 'none' };
}
const ACTUAL_NUTRITION_PREFIX = 'actual-nutrition:';
const NUTRITION_BRIDGE_KEYS = new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mode', 'confirmed', 'mealPatches']);
const NUTRITION_BRIDGE_MEAL_KEYS = new Set(['id', 'itemPatches']);
const NUTRITION_BRIDGE_ITEM_KEYS = new Set(['id', 'nutrition', 'sourceText']);
function hasActualNutritionResource(payload) {
  return Array.isArray(payload.mealPatches) && payload.mealPatches.some(meal => Array.isArray(meal?.itemPatches) && meal.itemPatches.some(item => typeof item?.id === 'string' && item.id.startsWith(ACTUAL_NUTRITION_PREFIX)));
}
function correctActualNutritionResource(state, payload, at) {
  patchObject(payload, NUTRITION_BRIDGE_KEYS, "Actual nutrition resource correction");
  if (payload.mode !== 'apply' || payload.confirmed !== true) fail("actual-nutrition resource corrections require mode=apply and confirmed=true; they cannot be saved as menu drafts.");
  const meals = list(payload.mealPatches, "Actual nutrition resource meal", 1);
  if (meals.length !== 1) fail("An actual nutrition resource correction must specify exactly one meal.");
  const meal = patchObject(meals[0], NUTRITION_BRIDGE_MEAL_KEYS, "Actual nutrition resource meal");
  const rows = list(meal.itemPatches, "Actual nutrition resource entries", 100);
  if (!rows.length) fail("Specify at least one existing actual nutrition resource.");
  const planId = id(payload.planId, "Plan ID"), mealId = id(meal.id, "Meal ID"), target = (state.plans ?? []).find(plan => plan.id === planId);
  const targetMeal = target?.meals?.find(meal => meal.id === mealId); let clearedOldWeight = false;
  const plannedIds = new Set([...(target?.meals ?? []), ...(target?.draft?.meals ?? [])].flatMap(meal => (meal.plannedItems ?? []).map(line => line.id)));
  const nutritionCorrections = rows.map(raw => {
    patchObject(raw, NUTRITION_BRIDGE_ITEM_KEYS, "Actual nutrition resource entries");
    const resourceId = str(raw.id, "Actual nutrition resource ID", 100);
    if (!resourceId.startsWith(ACTUAL_NUTRITION_PREFIX)) fail("Actual nutrition resources cannot be mixed with ordinary planned food lines.");
    const entryId = resourceId.slice(ACTUAL_NUTRITION_PREFIX.length);
    if (!entryId.trim() || entryId !== entryId.trim()) fail("The actual-nutrition prefix must be followed by the exact existing actual entry ID.");
    if (plannedIds.has(resourceId)) fail("A planned food line already uses this resource ID. The correction target cannot be inferred.", 409, 'NUTRITION_RESOURCE_AMBIGUOUS');
    if (raw.nutrition === undefined) fail("Actual nutrition resources require complete nutrition replacements with evidence. Other planned fields cannot be used.");
    const existing = targetMeal?.actualEntries.find(entry => entry.id === entryId);
    const wholePortion = existing && DISCRETE_NUTRITION_UNITS.has(existing.unit) && raw.nutrition?.basisUnit === existing.unit;
    if (wholePortion && existing.nutritionSnapshot?.gramsPerUnit != null) clearedOldWeight = true;
    return { entryId, nutrition: raw.nutrition, sourceText: raw.sourceText, ...(wholePortion ? { gramsPerUnit: null } : {}) };
  });
  // The reserved ID namespace is an explicit resource address, never a command
  // parsed from prose. The existing isolated corrector owns all actual lookup,
  // complete-source validation, atomic audit, and zero-inventory behavior.
  const result = correctMealNutrition(state, { action: 'record_meal_intake', operationId: payload.operationId, expectedRevision: payload.expectedRevision, planId, mealId, mode: 'correct', nutritionCorrections }, at);
  if (clearedOldWeight) result.detail += " whole-portion basis. The old average-weight conversion was cleared. No new measured weight was inferred; inventory grams per unit are unchanged.";
  return result;
}
function inheritNewActualNutrition(entry, entity) {
  const candidates = entity.plannedItems.filter(line => sameNutritionFood(line, entry));
  if (candidates.length !== 1 || candidates[0].nutrition === undefined || !candidates[0].nutritionSnapshot?.nutrition) return;
  const nextSnapshot = nutritionSnapshotBase(entry);
  nextSnapshot.nutrition = clone(candidates[0].nutritionSnapshot.nutrition);
  entry.nutritionSnapshot = nextSnapshot;
}
function actual(raw, items, at, supplement, previous, quantitySource = 'reported') {
  obj(raw, "Actual food"); const targetId = raw.itemId === null ? null : id(raw.itemId, "Actual food item ID"); const item = targetId === null ? null : items.find((i) => i.id === targetId);
  if (item && (item.category === 'supplement') !== supplement) fail("Food and supplements must be recorded separately.");
  const unit = raw.unit === undefined ? item?.unit ?? previous?.unit ?? '' : str(raw.unit, "Actual unit", 20, true); const quantity = qty(raw.quantity, true, false);
  if (quantity !== null && !unit) fail("Known actual quantities must specify their unit.");
  const name = str(raw.name ?? item?.name ?? previous?.name, "Actual food name", 200); const sourceText = str(raw.sourceText, "Actual report source text", 10000);
  const sameFood = previous?.itemId === targetId && (targetId !== null || previous.name === name && previous.unit === unit);
  return { id: str(raw.id, "Actual record ID", 400).trim(), itemId: targetId, name, quantity, unit, sourceText, reportedAt: at, quantitySource: quantity === null ? 'unknown' : quantitySource, nutritionSnapshot: sameFood ? previous.nutritionSnapshot : item ? snapshot(item) : null, correctionHistory: previous?.correctionHistory ?? [], ...(sameFood && previous.intakeLineId ? { intakeLineId: previous.intakeLineId } : {}), ...(sameFood && previous.nutritionCorrectionHistory !== undefined ? { nutritionCorrectionHistory: clone(previous.nutritionCorrectionHistory) } : {}) };
}
function comparableActual(entry) { return { id: entry.id, itemId: entry.itemId, name: entry.name, quantity: entry.quantity, unit: entry.unit, sourceText: entry.sourceText, quantitySource: entry.quantitySource }; }
function report(entity, raw, items, at, supplement, planId, quantitySource = 'reported') {
  const mode = raw.mode ?? 'append'; if (!MODES.has(mode)) fail("Invalid actual-record mode.");
  const next = clone(entity); const input = list(raw.entries ?? [], "Actual records", 100).slice(); const matchedLines = new Map();
  const matches = supplement ? raw.matchesPlannedDose : raw.matchesPlannedFood;
  if (matches === true) {
    if (mode !== 'complete') fail("Completing food as planned requires mode=complete.");
    if (input.length) fail("Completion as planned cannot also supply a different food list.");
    const lines = supplement ? [{ id: 'dose', itemId: entity.itemId, quantity: entity.plannedQuantity, unit: entity.unit }] : entity.plannedItems;
    for (const l of lines) {
      const manual = !supplement ? entity.actualEntries.filter(entry => entry.intakeLineId === l.id && entry.id.startsWith('ui-intake-')) : [];
      if (manual.length > 1) fail("Multiple manual actual records reference the same planned line. Review them first.", 409, 'ACTUAL_PLAN_DUPLICATION');
      const entryId = manual[0]?.id ?? plannedEntryId(planId, entity.id, l.id);
      input.push({ id: entryId, itemId: l.itemId, ...(l.itemId === null ? { name: l.name } : {}), quantity: l.quantity, unit: l.unit, sourceText: raw.sourceText || "The user explicitly reported completing the confirmed plan." });
      matchedLines.set(entryId, l);
    }
    if (entity.actualEntries.some((e) => e.quantity !== 0 && !input.some((i) => i.id === e.id))) fail("Different actual foods were already recorded individually. Do not copy the whole planned meal again; preserve existing records and explicitly correct or add the remainder.", 409, 'ACTUAL_PLAN_DUPLICATION');
  }
  // A completion report commonly restates the meal's cumulative portions.
  // A fresh ID for an already-reported food is not evidence of another serving,
  // even when its unit differs from the earlier report. Require reconciliation
  // before appending it so a checkbox followed by a Chat report cannot debit
  // the same portion twice. Explicit append remains the additional-food path.
  if (!supplement && mode === 'complete' && matches !== true) {
    for (const entry of input) {
      if (!entry || typeof entry !== 'object' || entry.quantity === 0
        || entity.actualEntries.some(existing => existing.id === entry.id)) continue;
      const targetId = typeof entry.itemId === 'string' ? entry.itemId.trim() : entry.itemId;
      const duplicateFood = entity.actualEntries.some(existing => existing.quantity !== 0
        && (targetId === null ? existing.itemId === null && typeof entry.name === 'string'
          && nameKey(existing.name ?? existing.nutritionSnapshot?.name ?? '') === nameKey(entry.name)
          : typeof targetId === 'string' && existing.itemId === targetId));
      if (duplicateFood) fail("An actual intake record for this food already exists in this meal. Do not create a new entry for a cumulative quantity. Read actualEntries and reuse the original entry.id with correct to apply the difference. Explicit completion of the current plan may use matchesPlannedFood=true. Use append only for a genuinely additional serving. Review differing units rather than inferring a sum.", 409, 'ACTUAL_INTAKE_RECONCILIATION_REQUIRED');
    }
  }
  unique(input, "Actual records");
  for (const entry of input) {
    const index = next.actualEntries.findIndex((e) => e.id === entry.id); const before = index === -1 ? null : next.actualEntries[index];
    const normalized = actual(entry, items, at, supplement, before, matches === true ? 'confirmed_plan_portion' : quantitySource);
    if (!before && !supplement && matches !== true) inheritNewActualNutrition(normalized, entity);
    if (matches === true && !supplement) { const line = matchedLines.get(entry.id); if (line) normalized.nutritionSnapshot = clone(line.nutritionSnapshot); }
    if (before && equal(comparableActual(before), comparableActual(normalized))) continue;
    const completedSamePortion = matches === true && !supplement && mode === 'complete' && before
      && before.quantity !== null && normalized.quantity >= before.quantity && before.itemId === normalized.itemId
      && before.unit === normalized.unit && equal(before.nutritionSnapshot, matchedLines.get(entry.id)?.nutritionSnapshot)
      && (before.itemId !== null || nameKey(before.name) === nameKey(normalized.name));
    if (before && mode !== 'correct' && !completedSamePortion) fail("This actual record ID already has different content. Explicitly correct it; do not deduct again.", 409, 'ACTUAL_ID_CONFLICT');
    if (!before && mode === 'correct') fail("The actual record to correct was not found.", 404, 'ACTUAL_NOT_FOUND');
    if (before) { const { correctionHistory, ...prior } = before; normalized.correctionHistory = [...correctionHistory, prior]; if (normalized.correctionHistory.length > 100) fail("The correction history limit was reached. Back up first."); next.actualEntries[index] = normalized; } else next.actualEntries.push(normalized);
  }
  if (next.actualEntries.length > 300) fail("The actual-entry limit for this meal was reached. Back up first.");
  if (mode === 'complete' && !next.actualEntries.length && (supplement || entity.plannedItems.length > 0)) fail("Actual food quantities are missing. Explicitly confirm completion as planned, supply actual entries, or report quantity 0. Missing is not zero intake.", 400, 'ACTUAL_CONTENT_REQUIRED');
  if (raw.actualTime !== undefined) next.actualTime = time(raw.actualTime);
  if (raw.actualTimeText !== undefined) next.actualTimeText = str(raw.actualTimeText, "Actual time source text", 500, true);
  if (raw.sourceText !== undefined) next[supplement ? 'reportSourceText' : 'sourceText'] = str(raw.sourceText, "Report source text", 10000, true);
  if (supplement && raw.actualMealId !== undefined) next.actualMealId = raw.actualMealId === null ? null : id(raw.actualMealId, "Meal ID linked to actual supplement intake");
  if (mode === 'complete') { next.state = 'completed'; next.completionReportedAt ??= at; }
  else if (input.length && !['completed', 'cancelled'].includes(next.state)) next.state = 'in_progress';
  if (!input.length && mode === 'append' && raw.actualTime === undefined && raw.actualTimeText === undefined && raw.sourceText === undefined) fail("There is no actual report to save.");
  if (!equal(next, entity)) {
    const history = next.reportHistory ?? []; if (history.length >= 500) fail("This meal reached the limit of 500 report source texts. Back it up first.");
    next.reportHistory = [...history, { reportedAt: at, mode, sourceText: raw.sourceText ?? '', actualTime: Object.hasOwn(raw, 'actualTime') ? next.actualTime : null, actualTimeText: raw.actualTimeText ?? '', entryIds: input.map((e) => e.id), matchesConfirmedPlan: matches === true || quantitySource === 'confirmed_plan_portion' }];
  }
  return next;
}
function requireConfirmed(payload) { if (payload.confirmed !== true) fail("This compatibility action requires confirmed=true. Adopting a menu does not mean it was eaten; only actual reports settle inventory.", 400, 'PLAN_CONFIRMATION_REQUIRED'); }
function plannedEntryId(planId, entityId, lineId) {
  const key = JSON.stringify([planId, entityId, lineId]); let a = 0x811c9dc5; let b = 0x9e3779b9;
  for (let i = 0; i < key.length; i++) { a = Math.imul(a ^ key.charCodeAt(i), 0x01000193); b = Math.imul(b ^ key.charCodeAt(i), 0x85ebca6b); }
  return `planned-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
function routineSlot(entry, plan) {
  if (DOSE_SLOTS.has(entry.timingSlot) && entry.timingSlot !== 'other') return entry.timingSlot;
  const linked = plan?.meals?.find((meal) => meal.id === entry.plannedMealId);
  return ['breakfast', 'lunch', 'dinner'].includes(linked?.slot) ? linked.slot : 'other';
}
function routineDose(entry, plan) {
  return { id: entry.id, itemId: entry.itemId, plannedQuantity: entry.plannedQuantity, unit: entry.unit, ...doseMetadata(entry), timingSlot: routineSlot(entry, plan), plannedMealId: null, plannedTime: entry.plannedTime ?? null, plannedTimeText: entry.plannedTimeText ?? '', sourceText: entry.sourceText ?? '' };
}
function routineFromPlan(plan) { return { sourcePlanId: plan.id, updatedAt: plan.updatedAt ?? plan.createdAt, supplementDoses: plan.supplementDoses.map((entry) => routineDose(entry, plan)) }; }
export function getSupplementRoutine(state) {
  if (state.supplementRoutine && Array.isArray(state.supplementRoutine.supplementDoses)) return clone(state.supplementRoutine);
  const candidates = (state.plans ?? []).filter((plan) => plan.format === 'meals_v1' && ['reserved', 'closed_with_actuals'].includes(plan.status) && plan.supplementDoses?.length && plan.supplementDoses.some((entry) => entry.timingSlot !== undefined || entry.requirement !== undefined));
  // Prefer the complete timetable over a later food plan mentioning only one
  // dose. Once explicitly saved, the routine no longer follows meal plans.
  candidates.sort((a, b) => new Set(b.supplementDoses.map((entry) => entry.itemId)).size - new Set(a.supplementDoses.map((entry) => entry.itemId)).size || b.supplementDoses.length - a.supplementDoses.length || b.date.localeCompare(a.date) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return candidates[0] ? routineFromPlan(candidates[0]) : null;
}
function dailyOwner(state, day) {
  const order = { reserved: 0, draft: 1, closed_with_actuals: 2, cancelled: 3 };
  return (state.plans ?? []).filter((plan) => plan.format === 'meals_v1' && plan.date === day && Object.hasOwn(order, plan.status)).slice().sort((a, b) => order[a.status] - order[b.status] || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0] ?? null;
}
function dailyOwnerConflict(state, day, owner) {
  const records = (state.plans ?? []).filter((plan) => plan.format === 'meals_v1' && plan.date === day);
  const facts = records.filter((plan) => plan.supplementDoses.some(hasFacts));
  if (records.filter((plan) => ['reserved', 'draft'].includes(plan.status)).length > 1 || facts.length > 1 || facts.some((plan) => plan.id !== owner?.id)) return { code: 'DAILY_SUPPLEMENT_OWNER_CONFLICT', message: "Multiple supplement accounts or actual reports exist for the same day. Review original records; do not infer a merge or deduct twice." };
  return null;
}
export function getDailySupplementView(state, forDate) {
  const day = date(forDate), owner = dailyOwner(state, day), routine = getSupplementRoutine(state), issues = [];
  const conflict = dailyOwnerConflict(state, day, owner); if (conflict) issues.push(conflict);
  if (!owner && !routine?.supplementDoses.length) return { plan: null, virtual: true, sourcePlanId: null, issues };
  const plan = owner ? clone(projectCurrentDietPlan(owner, state.items)) : { id: `supplements-${day}`, format: 'meals_v1', date: day, title: "Daily supplement record", timeZone: 'America/Toronto', notes: '', status: 'reserved', meals: [], supplementDoses: [], items: [], accountedDebits: [], allocationAdjustments: {}, inventoryAccounting: 'settled', accountingIssues: [], intakeBasis: 'reported_only', supplementOnly: true, foodAccounting: 'actual_only', supplementAccounting: 'actual_only', createdAt: routine.updatedAt, updatedAt: routine.updatedAt };
  for (const entry of routine?.supplementDoses ?? []) {
    const exact = plan.supplementDoses.find((existing) => existing.id === entry.id);
    if (exact?.itemId === entry.itemId) continue;
    const matches = plan.supplementDoses.filter((existing) => existing.itemId === entry.itemId && routineSlot(existing, plan) === routineSlot(entry));
    if (matches.length === 1) continue;
    if (matches.length > 1) { issues.push({ code: 'SUPPLEMENT_DOSE_AMBIGUOUS', doseId: entry.id, message: "Multiple existing doses for this supplement share this timing slot. Check their original dose IDs rather than inferring a merge." }); continue; }
    if (plan.supplementDoses.length >= 32) { issues.push({ code: 'DAILY_DOSE_LIMIT', doseId: entry.id, message: "The day reached 32 doses. Remaining routine items were not automatically added." }); continue; }
    const projected = exact ? { ...entry, id: `routine-${plannedEntryId(entry.id, entry.itemId, routineSlot(entry)).slice('planned-'.length)}` } : entry;
    try { plan.supplementDoses.push(dose(projected, state.items)); } catch (error) { issues.push({ code: error.code ?? 'INVALID_ROUTINE_DOSE', doseId: projected.id, message: error.message }); }
  }
  // This status belongs only to the independent supplement projection. A closed
  // food record stays closed in state, while supplements can still be reported.
  plan.status = 'reserved';
  return { plan, virtual: !owner, sourcePlanId: routine?.sourcePlanId ?? null, issues };
}
function applyDailySupplementCheck(state, payload, at) {
  const day = date(payload.date); if (typeof payload.checked !== 'boolean') fail("Supplement checked status must explicitly be true or false.");
  const targetId = id(payload.doseId, "Dose ID"), view = getDailySupplementView(state, day), old = dailyOwner(state, day);
  const ownerConflict = view.issues.find((issue) => issue.code === 'DAILY_SUPPLEMENT_OWNER_CONFLICT'); if (ownerConflict) fail(ownerConflict.message, 409, ownerConflict.code);
  const selected = view.plan?.supplementDoses.find((entry) => entry.id === targetId);
  if (!selected) { const issue = view.issues.find((issue) => issue.doseId === targetId); fail(issue?.message ?? "This day's supplement dose was not found. Read the routine and use the displayed dose ID.", 409, issue?.code ?? 'DOSE_NOT_FOUND'); }
  const existing = old?.supplementDoses.find((entry) => entry.id === targetId);
  if (payload.checked === false && !supplementChecked(existing ?? { actualEntries: [] })) return { items: state.items, plans: state.plans ?? [], detail: "This dose is unchecked. No intake record was added.", noChange: true };
  if (!old && (state.plans ?? []).length >= 1000) fail("The limit of 1000 diet records was reached. Back up and organize records first.");
  let owner;
  if (!old) owner = { ...clone(view.plan), createdAt: at, updatedAt: at };
  else {
    owner = currentForWrite(state, old);
    // Keep the food menu and its status; supplement projection status is not a
    // lifecycle transition for a draft, closed, or cancelled food menu.
    if (owner.supplementOnly) owner.supplementDoses = clone(view.plan.supplementDoses);
    else if (!owner.supplementDoses.some(d => d.id === targetId)) owner.supplementDoses.push(clone(selected));
  }
  const plans = (state.plans ?? []).slice(), index = old ? plans.findIndex((plan) => plan.id === old.id) : -1;
  if (index < 0) plans.push(owner); else plans[index] = owner;
  const result = applyDietAction({ ...state, plans }, { action: 'set_supplement_check', planId: owner.id, doseId: targetId, checked: payload.checked }, at);
  const routine = !state.supplementRoutine ? getSupplementRoutine(state) : null;
  if (result.noChange) return routine ? { items: state.items, plans: state.plans ?? [], supplementRoutine: { ...routine, updatedAt: at }, detail: "The supplement routine was saved. Intake and inventory deduction were not repeated." } : { ...result, plans: state.plans ?? [] };
  if (old && ['cancelled', 'closed_with_actuals'].includes(old.status)) result.plans = result.plans.map((plan) => plan.id === old.id ? { ...plan, status: old.status } : plan);
  return { ...result, ...(routine ? { supplementRoutine: { ...routine, updatedAt: at } } : {}) };
}
export function isDietAction(action) { return ACTIONS.has(action); }

function applyDailyMenuSettlement(state, payload, at) {
  const planId = id(payload.planId, "Plan ID");
  const plans = (state.plans ?? []).slice(), index = plans.findIndex(plan => plan.id === planId), old = plans[index];
  if (!old) fail("Diet plan not found.", 404, 'PLAN_NOT_FOUND');
  const prepared = prepareDailyMenuSettlement(state, old, payload, at);
  if (prepared.noChange) return { items: state.items, plans, detail: prepared.detail, noChange: true };
  let next = prepared.plan;
  delete next.draft;
  const result = settleFoodOnly(state.items, old, next, at, state);
  next = result.plan; next.updatedAt = at; plans[index] = next;
  return { items: result.items, plans, detail: next.dailySettlement.accounting === 'settled'
    ? "The saved daily food menu was settled under the midnight policy. Actual reports take precedence; personal checkmarks and supplements were excluded. No actual intake facts were fabricated."
    : "The end-of-day menu was settled per food item. Eligible items were adjusted by the difference; only exceptions retain original credits for review. No actual intake was fabricated." };
}

function applyChecklistIntake(state, payload, at) {
  patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'draft', 'expectedDraftVersion']), "Intake checklist action");
  const planId = id(payload.planId, "Plan ID"), old = (state.plans ?? []).find(plan => plan.id === planId);
  if (!old) fail("Diet plan not found.", 404, 'PLAN_NOT_FOUND');
  if (old.format !== 'meals_v1') fail("This action applies only to structured meal plans.", 409, 'LEGACY_PLAN_CONFLICT');
  if (old.intakeDraft) fail("An unsubmitted intake draft exists for this day. Review or discard it before using checklist actions; the original draft was preserved.", 409, 'INTAKE_DRAFT_PENDING');
  if (!Object.hasOwn(payload, 'expectedDraftVersion') || payload.expectedDraftVersion !== null) {
    fail("The intake draft changed elsewhere. Refresh and review it; do not overwrite the saved record.", 409, 'INTAKE_DRAFT_CONFLICT');
  }
  const draft = normalizeIntakeDraft(old, payload.draft, state.items);
  if (draft.consumed.some(entry => entry.quantity === null)) {
    fail("This quantity is unclear. Review actual usage first; a checkmark cannot infer the quantity eaten.", 409, 'CHECKLIST_QUANTITY_REQUIRED');
  }
  // Both stages are pure. Only the outer inventory transaction persists their
  // combined result, so there is never a half-saved draft, second revision, or
  // separate operation ID that could be retried as a second inventory debit.
  const saved = applyDietAction(state, { action: 'save_intake_draft', planId, draft, expectedDraftVersion: null }, at);
  const staged = { ...state, items: saved.items, plans: saved.plans };
  const cloudDraft = staged.plans.find(plan => plan.id === planId).intakeDraft;
  const submitted = applyDietAction(staged, { action: 'submit_intake_draft', planId,
    draftId: cloudDraft.id, baseFingerprint: cloudDraft.baseFingerprint,
    expectedDraftVersion: intakeDraftVersion(cloudDraft) }, at);
  return submitted;
}

export function applyDietAction(state, payload, now = new Date().toISOString()) {
  obj(state, "Inventory"); obj(payload, "Action"); if (!isDietAction(payload.action)) fail("Unsupported diet action."); const at = stamp(now); let items = state.items.slice(); const plans = (state.plans ?? []).slice(); let old; let next; let index = -1; let detail;
  if (payload.action === 'apply_checklist_intake') return applyChecklistIntake(state, payload, at);
  if (payload.action === 'set_food_personal_check') return applyPersonalFoodCheck(state, payload, at);
  if (payload.action === 'patch_meal_plan' && hasActualRecipeGroupResources(payload)) {
    const resource = actualRecipeGroupResourcePatch(payload);
    return applyDietAction(state, { action: 'set_actual_recipe_groups', operationId: payload.operationId,
      expectedRevision: payload.expectedRevision, ...resource }, at);
  }
  if (payload.action === 'set_food_layout') {
    patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'moves', 'expectedFingerprint']), 'Food display layout');
    const planId = id(payload.planId, 'Plan ID'), planIndex = plans.findIndex(plan => plan.id === planId);
    if (planIndex < 0) fail('Diet plan not found.', 404, 'PLAN_NOT_FOUND');
    const update = applyFoodLayoutMoves(plans[planIndex], payload.moves, at, payload.expectedFingerprint);
    if (!update.changed) return { items: state.items, plans: state.plans ?? [], noChange: true, detail: 'Food display placement is unchanged. Intake and inventory were not changed.' };
    const changed = update.plan; changed.updatedAt = at; plans[planIndex] = changed;
    return { items: state.items, plans, detail: 'Food display placement was saved. Source food records, quantities, actual intake, personal checks, supplements, pending drafts, nutrition and inventory accounting were unchanged.' };
  }
  if (payload.action === 'set_actual_recipe_groups') {
    patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mealId', 'groups']), 'Actual recipe grouping');
    const planId = id(payload.planId, 'Plan ID'), mealId = id(payload.mealId, 'Meal ID');
    const planIndex = plans.findIndex(plan => plan.id === planId), original = plans[planIndex];
    if (!original || original.format !== 'meals_v1') fail('A structured meal plan is required for actual recipe groups.', 404, 'PLAN_NOT_FOUND');
    const mealIndex = original.meals.findIndex(meal => meal.id === mealId);
    if (mealIndex < 0) fail('Meal not found.', 404, 'MEAL_NOT_FOUND');
    const update = applyActualRecipeGroups(original.meals[mealIndex], payload.groups, at);
    if (!update.changed) return { items: state.items, plans: state.plans ?? [], noChange: true, detail: 'Actual recipe groups are unchanged. Intake and inventory were not changed.' };
    const changed = clone(original); changed.meals[mealIndex] = update.meal; changed.updatedAt = at; plans[planIndex] = changed;
    return { items: state.items, plans, detail: 'Actual recipe groups were saved by actual entry ID. Quantities, nutrition, intake reports, menus, supplements, personal checks, and inventory were unchanged.' };
  }
  if (payload.action === 'settle_daily_menu') return applyDailyMenuSettlement(state, payload, at);
  if (Object.hasOwn(payload, 'nutritionCorrections')) {
    if (payload.action !== 'record_meal_intake') fail("nutritionCorrections is only supported by record_meal_intake and cannot be mixed with other actions.");
    return correctMealNutrition(state, payload, at);
  }
  if (payload.action === 'patch_meal_plan' && hasActualNutritionResource(payload)) return correctActualNutritionResource(state, payload, at);
  if (payload.action === 'set_daily_supplement_check') return applyDailySupplementCheck(state, payload, at);
  if (payload.action === 'save_supplement_routine') {
    requireConfirmed(payload); const source = plans.find((plan) => plan.id === id(payload.sourcePlanId, "Source plan ID"));
    if (!source || source.format !== 'meals_v1' || !['reserved', 'closed_with_actuals'].includes(source.status) || !source.supplementDoses.length) fail("Only a confirmed menu containing supplements can be saved as a reusable routine.", 409, 'ROUTINE_SOURCE_NOT_CONFIRMED');
    const routine = routineFromPlan(source); for (const entry of routine.supplementDoses) dose(entry, items);
    if (state.supplementRoutine?.sourcePlanId === routine.sourcePlanId && equal(state.supplementRoutine.supplementDoses, routine.supplementDoses)) return { items: state.items, plans: state.plans ?? [], detail: "The supplement routine is unchanged.", noChange: true };
    return { items: state.items, plans: state.plans ?? [], supplementRoutine: { ...routine, updatedAt: at }, detail: "The supplement routine was saved. Previous intake was not copied; inventory was not reserved or deducted." };
  }
  if (payload.action === 'save_meal_plan_draft') {
    const raw = obj(payload.plan, "Diet plan"); index = plans.findIndex((p) => p.id === raw.id); old = index < 0 ? null : plans[index];
    if (old && old.format !== 'meals_v1') fail("Legacy flat plans cannot be inferred as structured meals. Use a new plan ID.", 409, 'LEGACY_PLAN_CONFLICT');
    if (old && !['draft', 'reserved'].includes(old.status)) fail("A closed plan cannot be reopened.", 409, 'PLAN_CLOSED');
    const current = old ? currentForWrite(state, old) : null;
    next = normalizePlan(raw, items, at, current);
    const sameDay = plans.find((p) => p.format === 'meals_v1' && p.id !== next.id && p.date === next.date);
    if (sameDay) throw Object.assign(new Error(`A record already exists for this day. Reuse the original plan ID ${sameDay.id} to save the menu instead of creating another account.`), { status: 409, code: 'DAY_PLAN_CONFLICT', canonicalPlanId: sameDay.id });
    if (!old && plans.length >= 1000) fail("The limit of 1000 diet records was reached. Back up and organize records first.");
    if (old) guardEdits(old, next);
    preservePlanAccounting(old, next);
    if (old && !old.draft && equal(content(old), content(next))) return { items: state.items, plans: state.plans ?? [], detail: "The current menu is unchanged. No duplicate edit was made.", noChange: true };
    recordMealPlanRevisions(old, next, at);
    detail = "The current menu was saved and is immediately viewable and editable. No inventory was reserved or deducted; existing actual records were preserved.";
  } else {
    const planId = id(payload.planId, "Plan ID"); index = plans.findIndex((p) => p.id === planId); if (index < 0) fail("Diet plan not found.", 404, 'PLAN_NOT_FOUND'); old = plans[index]; if (old.format !== 'meals_v1') fail("This action applies only to structured meal plans.", 409, 'LEGACY_PLAN_CONFLICT'); next = currentForWrite(state, old);
    if (['save_intake_draft', 'submit_intake_draft', 'discard_intake_draft'].includes(payload.action)
      && (old.intakeDraft || payload.action === 'save_intake_draft')
      && (!Object.hasOwn(payload, 'expectedDraftVersion') || payload.expectedDraftVersion !== intakeDraftVersion(old.intakeDraft))) {
      fail("The intake draft was saved, submitted, or discarded elsewhere. Preserve local input, refresh, and review the saved draft before continuing.", 409, 'INTAKE_DRAFT_CONFLICT');
    }
    if (payload.action === 'save_intake_draft') {
      const normalized = normalizeIntakeDraft(old, payload.draft, items);
      prepareIntakeDraft(old, normalized, items);
      next = clone(old);
      const { updatedAt: _updatedAt, ...previousDraft } = old.intakeDraft ?? {};
      if (equal(previousDraft, normalized)) return { items: state.items, plans: state.plans ?? [], detail: "The intake draft is unchanged. No duplicate save or inventory deduction occurred.", noChange: true };
      next.intakeDraft = { ...normalized, updatedAt: at };
      detail = "The intake draft was saved but is not actual intake. The original menu, completion status, and inventory were unchanged.";
    } else if (payload.action === 'discard_intake_draft') {
      if (!old.intakeDraft) return { items: state.items, plans: state.plans ?? [], detail: "There is no intake draft to discard. Actual records and inventory were unchanged.", noChange: true };
      if (payload.draftId !== undefined && payload.draftId !== old.intakeDraft.id) fail("The intake draft changed elsewhere. Refresh it.", 409, 'INTAKE_DRAFT_CONFLICT');
      next = clone(old); delete next.intakeDraft;
      detail = "The unsubmitted intake draft was discarded. The original menu, actual records, and inventory were unchanged.";
    } else if (payload.action === 'submit_intake_draft') {
      if (!old.intakeDraft || payload.draftId !== old.intakeDraft.id) fail("This intake draft was submitted, discarded, or changed. Refresh and review it; do not recreate the account.", 409, 'INTAKE_DRAFT_NOT_FOUND');
      if (payload.baseFingerprint !== old.intakeDraft.baseFingerprint) fail("The intake draft baseline does not match. Refresh and review it.", 409, 'INTAKE_DRAFT_STALE');
      const prepared = prepareIntakeDraft(old, old.intakeDraft, items);
      if (!prepared.changes.length && !prepared.draft.transfers.length && !prepared.draft.completedMealIds.length) fail("The draft has no changes to submit.");
      if (old.status === 'closed_with_actuals' && prepared.draft.transfers.length) fail("A closed menu supports actual-record corrections only; future meals cannot be reallocated.", 409, 'PLAN_CLOSED');
      next.meals = prepared.plan.meals;
      guardEdits(old, next);
      for (const change of prepared.changes) {
        const index = next.meals.findIndex(meal => meal.id === change.mealId);
        for (const correction of change.externalCorrections) {
          const previous = next.meals[index].actualEntries.find(entry => entry.id === correction.entryId);
          if (previous.quantity === correction.quantity) continue;
          next.meals[index] = report(next.meals[index], { mode: 'correct', entries: [{ id: previous.id, itemId: previous.itemId,
            name: previous.name, quantity: correction.quantity, unit: previous.unit, sourceText: "The user explicitly selected correction of a previously recorded cumulative quantity in the intake draft." }] }, items, at, false, next.id);
        }
        const previous = next.meals[index].actualEntries.find(entry => entry.id === change.managedEntryId);
        const input = prepared.draft.consumed.find(entry => entry.mealId === change.mealId && entry.lineId === change.lineId);
        if (previous || change.managedQuantity === null || change.managedQuantity > 0 || input.quantity === 0 && !change.externalCorrections.length) {
          next.meals[index] = report(next.meals[index], { mode: previous ? 'correct' : 'append', entries: [{
            id: change.managedEntryId, itemId: change.sourceLine.itemId, name: change.sourceLine.name ?? change.sourceLine.nutritionSnapshot?.name,
            quantity: change.managedQuantity, unit: change.sourceLine.unit, sourceText: "The user explicitly submitted the cumulative quantity eaten in the intake draft. No actual time was reported.",
          }] }, items, at, false, next.id);
          const saved = next.meals[index].actualEntries.find(entry => entry.id === change.managedEntryId);
          saved.intakeLineId = change.lineId;
          if (!previous) saved.nutritionSnapshot = clone(change.sourceLine.nutritionSnapshot);
        }
      }
      for (const meal of next.meals) {
        meal.plannedItems = meal.plannedItems.filter(line => line.quantity > 0);
        if (meal.recipeGroups !== undefined) meal.recipeGroups = pruneRecipeGroups(meal.recipeGroups, meal.plannedItems);
      }
      for (const mealId of prepared.draft.completedMealIds) {
        const index = next.meals.findIndex(meal => meal.id === mealId);
        if (next.meals[index].state !== 'completed') next.meals[index] = report(next.meals[index], { mode: 'complete', sourceText: "The user explicitly marked this meal finished in the intake draft. Food actually eaten was preserved item by item." }, items, at, false, next.id);
      }
      delete next.intakeDraft;
      const audit = old.intakeDraftAudit ?? [];
      if (audit.length >= 200) fail("This day's manual intake submission audit reached its limit. Back it up first.", 409, 'INTAKE_DRAFT_AUDIT_LIMIT');
      next.intakeDraftAudit = [...clone(audit), { id: old.intakeDraft.id, at, draft: clone(old.intakeDraft) }];
      preservePlanAccounting(old, next);
      recordMealPlanRevisions(old, next, at);
      const actualAmounts = plan => plan.meals.map(meal => ({ id: meal.id, completed: meal.state === 'completed',
        entries: meal.actualEntries.map(entry => ({ id: entry.id, itemId: entry.itemId, name: entry.itemId === null ? entry.name : '', quantity: entry.quantity, unit: entry.unit })) }));
      const actualChanged = !equal(actualAmounts(currentForWrite(state, old)), actualAmounts(next));
      if (actualChanged) {
        next.intakeBasis = 'reported_only';
        ({ items, plan: next } = settle(items, old, next, at, true, false, state));
      }
      detail = !actualChanged ? "Meal allocations were saved. There is no new actual intake; inventory and pending historical accounts were unchanged."
        : next.inventoryAccounting === 'settled' ? "The intake draft was explicitly submitted as actual intake, with cross-meal allocations saved. Inventory was settled only for the actual difference, without duplicate deduction." : "Actual intake and cross-meal allocations were saved. Eligible items were adjusted by the difference; only exceptions need review. Nothing was deducted twice.";
    } else if (payload.action === 'sync_food_plan') {
      patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'expectedFingerprint']), 'Food plan synchronization');
      const result = applyFoodPlanSync(next, items, payload.expectedFingerprint);
      if (result.noChange) return { items: state.items, plans: state.plans ?? [], noChange: true,
        detail: 'The food plan already matches its recorded meals. No intake or inventory changed.' };
      next = result.plan;
      guardEdits(old, next);
      recordMealPlanRevisions(currentForWrite(state, old), next, at, true);
      detail = result.preview.issues.some(issue => issue.severity === 'skip')
        ? 'Supported recorded meals were synchronized to the food plan; meals requiring review were left unchanged. Actuals, supplements, personal checks, and inventory were preserved.'
        : 'Recorded meals were synchronized to the food plan. Actuals, supplements, personal checks, and inventory were preserved.';
    } else if (payload.action === 'scale_recipe_group' || payload.action === 'move_recipe_group') {
      const fields = payload.action === 'scale_recipe_group'
        ? ['mealId', 'targetPortion'] : ['fromMealId', 'toMealId', 'fractionOfRemaining', 'transferId'];
      patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'groupId', 'expectedFingerprint', ...fields]), "Recipe adjustment");
      const preview = previewRecipeGroupAction(next, items, payload);
      if (preview.noChange) return { items: state.items, plans: state.plans ?? [], noChange: true, detail: "Recipe portions are unchanged. No duplicate edit or inventory deduction occurred." };
      next = preview.plan;
      guardEdits(old, next); preservePlanAccounting(old, next);
      detail = payload.action === 'scale_recipe_group' ? "All planned ingredients in the recipe were adjusted to the absolute portion count. Actual records, personal checkmarks, and inventory accounts were preserved."
        : "The specified fraction of this recipe's remainder was moved together to the target meal, preserving its name and ingredient snapshots. Daily totals, actual records, and inventory accounts were unchanged.";
    } else if (payload.action === 'add_food_to_meal') {
      patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mealId', 'itemId', 'quantity', 'expectedDraftVersion']), "Add planned food");
      if (!['draft', 'reserved'].includes(old.status)) fail("Planned foods cannot be added to cancelled or closed menus.", 409, 'PLAN_CLOSED');
      const targetMeal = next.meals.find(meal => meal.id === id(payload.mealId, "Meal ID"));
      if (!targetMeal || targetMeal.state === 'cancelled') fail("The meal for adding planned food was not found.", 404, 'MEAL_NOT_FOUND');
      const item = itemFor(items, id(payload.itemId, "Food item ID"));
      if (item.category === 'supplement' || item.status !== 'available' || item.quantity === 0) fail("Choose currently available food. Depleted, pending, archived, and supplement items cannot be added here.", 409, 'ITEM_UNAVAILABLE');
      const quantity = qty(payload.quantity);
      const lineId = 'menu-add-' + plannedEntryId(next.id, targetMeal.id, id(payload.operationId, "Operation ID")).slice('planned-'.length);
      const existing = next.meals.flatMap(meal => meal.plannedItems).find(line => line.id === lineId);
      if (existing) {
        if (targetMeal.plannedItems.includes(existing) && existing.itemId === item.id && existing.quantity === quantity && existing.unit === item.unit) return { items: state.items, plans: state.plans ?? [], noChange: true, detail: "This addition was already saved. No duplicate food or inventory deduction was added." };
        fail("The food line for this addition changed. Refresh and use a new operation ID.", 409, 'PLANNED_LINE_ID_CONFLICT');
      }
      if ((payload.expectedDraftVersion ?? null) !== intakeDraftVersion(next.intakeDraft)) fail("The intake draft changed. Refresh before adding food; previous input was preserved.", 409, 'INTAKE_DRAFT_CONFLICT');
      const base = intakePlanFingerprint(next, items), canRebase = next.intakeDraft?.baseFingerprint === base;
      next = patchPlan(next, { mealPatches: [{ id: targetMeal.id, itemPatches: [{ id: lineId, itemId: item.id, quantity, unit: item.unit }] }] }, items);
      if (canRebase) next.intakeDraft.baseFingerprint = intakePlanFingerprint(next, items);
      guardEdits(old, next); preservePlanAccounting(old, next);
      detail = "The inventory food was added as a standalone planned item in this meal. No actual intake or inventory deduction was recorded; existing actuals and the intake draft were preserved.";
    } else if (payload.action === 'patch_meal_plan') {
      patchObject(payload, PATCH_KEYS, "Menu patch");
      if (!['draft', 'apply'].includes(payload.mode)) fail("Patch mode must explicitly be draft or apply.");
      if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail("confirmed must explicitly be a boolean.");
      if (payload.allocationOnly !== undefined && typeof payload.allocationOnly !== 'boolean') fail("allocationOnly must explicitly be a boolean.");
      if (!['draft', 'reserved'].includes(old.status)) fail("A closed plan cannot be edited. Preserve original facts.", 409, 'PLAN_CLOSED');
      if (payload.mode === 'draft' && payload.allocationOnly === true) fail("Reallocation requires explicit confirmation in apply mode.");
      if (payload.mode === 'apply') {
        requireConfirmed(payload);
      }
      const base = next;
      const candidate = patchPlan(base, payload, items);
      guardEdits(old, candidate, payload.allocationOnly === true);
      if (payload.allocationOnly === true && (!equal(canonicalTotals(plannedFoodTotals(old)), canonicalTotals(plannedFoodTotals(candidate))) || (payload.supplementPatches?.length ?? 0) > 0)) fail("Same-day reallocation must preserve the daily food totals. Edit supplements separately.", 409, 'DAILY_TOTAL_CONFLICT');
      if (equal(content(base), content(candidate))) return { items: state.items, plans: state.plans ?? [], detail: "The specified fields are unchanged. No duplicate edit or deduction occurred.", noChange: true };
      next = candidate; preservePlanAccounting(old, next);
      if (next.meals.length && old.supplementOnly) next.supplementOnly = false;
      detail = "Only the specified menu fields were edited. Other meals, supplements, and actual records were preserved; inventory was not reserved or deducted.";
    } else if (payload.action === 'commit_meal_plan') {
      requireConfirmed(payload); if (old.status === 'reserved' && !old.draft) return { items: state.items, plans: state.plans ?? [], detail: "This final plan was already adopted. No deduction was repeated.", noChange: true };
      if (!['draft', 'reserved'].includes(old.status)) fail("A closed plan cannot be confirmed again.", 409, 'PLAN_CLOSED');
      if (old.draft) guardEdits(old, next);
      if (old.supplementOnly && next.meals.length) next.supplementOnly = false;
      for (const meal of next.meals) for (const line of meal.plannedItems) if (line.itemId === null) plannedLine(line, items);
      delete next.draft; next.status = 'reserved'; next.intakeBasis = 'confirmed_daily_plan'; preservePlanAccounting(old, next); detail = "The adopted current menu was saved. No inventory was reserved or deducted; settlement occurs only after explicit actual intake.";
    } else if (payload.action === 'revise_unconsumed_meals') {
      requireConfirmed(payload); if (!['draft', 'reserved'].includes(old.status)) fail("Only open menus can be edited.", 409, 'PLAN_CLOSED');
      const meals = payload.meals === undefined ? [] : list(payload.meals, "Meal revisions", 16); const doses = payload.supplementDoses === undefined ? [] : list(payload.supplementDoses, "Supplement revisions", 32); if (!meals.length && !doses.length) fail("Specify at least one meal or supplement to revise."); unique(meals, "Meal revisions"); unique(doses, "Supplement revisions");
      for (const raw of meals) { const i = next.meals.findIndex((m) => m.id === raw.id); if (i < 0) fail("The meal ID to revise does not exist.", 404, 'MEAL_NOT_FOUND'); next.meals[i] = meal(raw, items, next.meals[i]); }
      for (const raw of doses) { const i = next.supplementDoses.findIndex((d) => d.id === raw.id); if (i < 0) next.supplementDoses.push(dose(raw, items)); else next.supplementDoses[i] = dose(raw, items, next.supplementDoses[i]); }
      list(next.supplementDoses, "Daily supplement doses", 32); unique(next.supplementDoses, "Daily supplement doses");
      for (const d of next.supplementDoses) if (d.plannedMealId && !next.meals.some((m) => m.id === d.plannedMealId)) fail("The meal linked to this supplement does not exist.");
      guardEdits(old, next, payload.allocationOnly === true);
      if (payload.allocationOnly === true && (!equal(canonicalTotals(plannedFoodTotals(old)), canonicalTotals(plannedFoodTotals(next))) || doses.length)) fail("Same-day reallocation must preserve the daily food totals. Edit supplements separately.", 409, 'DAILY_TOTAL_CONFLICT');
      if (equal(content(old), content(next))) return { items: state.items, plans: state.plans ?? [], detail: "Plan content is unchanged.", noChange: true };
      delete next.draft; preservePlanAccounting(old, next); detail = "The current menu was revised. Original actual reports were preserved; inventory was not reserved or deducted.";
    } else if (payload.action === 'set_supplement_check') {
      // A dose is a separate actual event. It neither confirms a food menu nor
      // reopens a closed/cancelled meal plan.
      if (typeof payload.checked !== 'boolean') fail("Supplement checked status must explicitly be true or false.");
      const i = next.supplementDoses.findIndex((d) => d.id === id(payload.doseId, "Dose ID")); if (i < 0) fail("Supplement dose not found.", 404, 'DOSE_NOT_FOUND');
      const current = next.supplementDoses[i];
      if (supplementChecked(current) === payload.checked) return { items: state.items, plans: state.plans ?? [], detail: "This supplement checkmark was already saved. No duplicate record was made.", noChange: true };
      const checkboxId = `checkbox-${plannedEntryId(next.id, current.id, 'dose').slice('planned-'.length)}`;
      const before = current.actualEntries.find((entry) => entry.id === checkboxId);
      const sourceText = payload.checked ? current.plannedQuantity === null ? "The user marked this dose taken. Actual quantity is unknown; no other dosage was substituted." : "The user marked this dose taken, using its confirmed planned quantity." : "The user withdrew this dose's taken checkmark, correcting it to not taken (quantity 0). The original report remains in correction history.";
      const entries = payload.checked ? [{ id: checkboxId, itemId: current.itemId, quantity: current.plannedQuantity, unit: current.unit, sourceText }] : current.actualEntries.filter((entry) => entry.quantity !== 0).map((entry) => ({ id: entry.id, itemId: entry.itemId, name: entry.name, quantity: 0, unit: entry.unit, sourceText }));
      const changed = report(current, { mode: payload.checked && !before ? 'append' : 'correct', entries, sourceText }, items, at, true, next.id, payload.checked ? 'confirmed_plan_portion' : 'reported');
      changed.state = 'completed'; changed.completionReportedAt ??= at; next.supplementDoses[i] = changed;
      ({ items, plan: next } = settleSupplements(items, old, next, at)); detail = next.inventoryAccounting === 'settled' ? "The supplement checkmark was saved. Inventory changed only by this dose's difference; no actual time was inferred." : "The supplement checkmark and correction source text were saved. Related inventory accounts require review.";
    } else if (payload.action === 'record_meal_intake' || payload.action === 'record_supplement_intake') {
      if (!['draft', 'reserved', 'closed_with_actuals'].includes(old.status) && !(payload.action === 'record_supplement_intake' && old.status === 'cancelled')) fail("Intake cannot be reported for a cancelled menu. Link actual corrections to the original completed record.", 409, 'PLAN_CLOSED');
      if (payload.action === 'record_meal_intake') {
        if (payload.meals !== undefined && ['mealId', 'mode', 'entries', 'matchesPlannedFood', 'actualTime', 'actualTimeText', 'sourceText', 'actualRecipeGroups'].some(key => Object.hasOwn(payload, key) && payload[key] !== undefined)) fail("A full-day meals report cannot include top-level single-meal fields. Specify mode, entries, source text, and time within each meal.");
        const mealReports = payload.meals === undefined ? [payload] : list(payload.meals, "Meals in this report", 16);
        if (!mealReports.length) fail("Report at least one meal.");
        const mealIds = new Set();
        for (const raw of mealReports) {
          obj(raw, "Actual meal report");
          if (payload.meals !== undefined) patchObject(raw, new Set(['mealId', 'mode', 'entries', 'matchesPlannedFood', 'actualTime', 'actualTimeText', 'sourceText', 'actualRecipeGroups']), "Actual meal report");
          const mealId = id(raw.mealId, "Meal ID");
          if (mealIds.has(mealId)) fail("This report contains duplicate meal IDs."); mealIds.add(mealId);
          const i = next.meals.findIndex(m => m.id === mealId); if (i < 0) fail("Meal not found.", 404, 'MEAL_NOT_FOUND');
          if (raw.actualRecipeGroups !== undefined && !rows(raw.entries).length && raw.matchesPlannedFood !== true
            && raw.mode !== 'complete' && raw.actualTime === undefined && raw.actualTimeText === undefined && raw.sourceText === undefined) {
            fail('Use set_actual_recipe_groups to organize existing actual entries without reporting intake again.', 409, 'ACTUAL_RECIPE_GROUPS_REQUIRE_METADATA_TOOL');
          }
          next.meals[i] = report(next.meals[i], raw, items, at, false, next.id);
          if (Object.hasOwn(raw, 'actualRecipeGroups')) next.meals[i] = applyActualRecipeGroups(next.meals[i], raw.actualRecipeGroups, at).meal;
        }
      }
      const reports = payload.action === 'record_supplement_intake' ? [payload] : list(payload.supplements ?? [], "Supplements in this report", 32); const doseIds = new Set();
      for (const raw of reports) { const doseId = id(raw.doseId, "Dose ID"); if (doseIds.has(doseId)) fail("This report contains duplicate supplement doses."); doseIds.add(doseId); const i = next.supplementDoses.findIndex((d) => d.id === doseId); if (i < 0) fail("Supplement dose not found.", 404, 'DOSE_NOT_FOUND'); const doseReport = payload.action === 'record_meal_intake' ? { ...raw, actualMealId: raw.actualMealId === undefined ? payload.mealId : raw.actualMealId } : raw; if (doseReport.actualMealId != null && !next.meals.some((m) => m.id === doseReport.actualMealId)) fail("The meal linked to actual supplement intake does not exist."); next.supplementDoses[i] = report(next.supplementDoses[i], doseReport, items, at, true, next.id); }
      if (equal(old, next) && old.inventoryAccounting !== 'pending_reconciliation') return { items: state.items, plans: state.plans ?? [], detail: "This actual record was already saved. No deduction was repeated.", noChange: true };
      const priorCurrent = currentForWrite(state, old);
      const groupingOnly = payload.action === 'record_meal_intake'
        && equal(intakeFactsWithoutGrouping(priorCurrent), intakeFactsWithoutGrouping(next))
        && !equal(priorCurrent.meals.map(meal => [meal.actualRecipeGroups, meal.actualRecipeGroupHistory]), next.meals.map(meal => [meal.actualRecipeGroups, meal.actualRecipeGroupHistory]));
      if (groupingOnly) {
        const metadataOnly = clone(old);
        for (const meal of metadataOnly.meals) {
          const changed = next.meals.find(value => value.id === meal.id);
          if (changed?.actualRecipeGroups !== undefined) meal.actualRecipeGroups = clone(changed.actualRecipeGroups);
          if (changed?.actualRecipeGroupHistory !== undefined) meal.actualRecipeGroupHistory = clone(changed.actualRecipeGroupHistory);
        }
        next = metadataOnly;
        detail = 'Only actual recipe grouping metadata changed. Existing intake reports, menu fields, and pending inventory accounting were preserved without settlement.';
      } else {
        next.intakeBasis = 'reported_only';
        ({ items, plan: next } = payload.action === 'record_supplement_intake' ? settleSupplements(items, old, next, at) : settle(items, old, next, at, true, false, state)); detail = next.inventoryAccounting === 'settled' ? "The actual report was saved. Only the difference between actual intake and previous accounted usage was settled, without duplicate deduction." : "The actual report and source text were saved. Eligible items were adjusted by the difference; only exceptions retain original credits for review. No deduction was repeated.";
      }
    } else {
      requireConfirmed(payload); if (old.status === 'cancelled' || old.status === 'closed_with_actuals') return { items: state.items, plans: state.plans ?? [], detail: "The plan was already closed. No refund was repeated.", noChange: true };
      if (old.inventoryAccounting === 'pending_reconciliation') fail("Actual reports have pending accounting issues. Cancellation cannot bypass them.", 409, 'ACCOUNTING_PENDING');
      if (payload.action === 'cancel_meal_plan' && anyFacts(old)) fail("Actual food or supplement intake was already reported. The whole day cannot be refunded; cancel only the uneaten remainder.", 409, 'PLAN_HAS_ACTUALS');
      for (const e of [...next.meals, ...next.supplementDoses]) if (e.state !== 'completed') e.state = 'cancelled';
      next.allocationAdjustments = {}; next.status = anyFacts(old) ? 'closed_with_actuals' : 'cancelled'; next.intakeBasis = anyFacts(old) ? 'reported_only' : 'none'; delete next.draft;
      ({ items, plan: next } = settle(items, old, next, at, false, false, state)); detail = "Uneaten reservations were cancelled. Reported actual food and supplements were not refunded.";
    }
  }
  if (['commit_meal_plan', 'revise_unconsumed_meals', 'patch_meal_plan', 'scale_recipe_group', 'move_recipe_group', 'add_food_to_meal'].includes(payload.action)) recordMealPlanRevisions(old, next, at);
  // Business entry IDs survive the short operation ledger and cannot be reused
  // in another meal/day to silently debit the same reported event twice.
  const actualIds = new Set();
  for (const p of [...plans.filter((p) => p.id !== next.id), next]) if (p.format === 'meals_v1') for (const e of [...p.meals, ...p.supplementDoses]) for (const a of e.actualEntries) { if (actualIds.has(a.id)) fail("This actual record ID is used by another meal or date. Correct the original record instead.", 409, 'ACTUAL_ID_CONFLICT'); actualIds.add(a.id); }
  next.updatedAt = at; if (index < 0) plans.push(next); else plans[index] = next;
  return { items, plans, detail };
}

function compactNutrition(nutrition) { if (!nutrition) return null; return clone(Object.fromEntries(['basisAmount', 'basisUnit', 'kcal', 'protein', 'carbs', 'fat', 'source', 'nutrientSources'].map(key => [key, nutrition[key] ?? null]))); }
function compact(plan, items = []) { plan = projectCurrentDietPlan(plan, items); return { id: plan.id, recordId: plan.id, date: plan.date, title: plan.title, status: plan.status, intakeBasis: plan.intakeBasis, inventoryAccounting: plan.inventoryAccounting, accountingIssues: plan.accountingIssues, hasDraft: !!plan.draft, foodLayoutOverrides: clone(plan.foodLayoutOverrides ?? []), foodLayoutFingerprint: foodLayoutFingerprint(plan), ...(plan.intakeDraft ? { intakeDraftState: intakeDraftStatus(plan, items) } : {}), ...(plan.supplementOnly ? { supplementOnly: true } : {}), ...(plan.supplementAccounting ? { supplementAccounting: plan.supplementAccounting } : {}), meals: plan.meals.map((m) => ({ id: m.id, slot: m.slot, title: m.title, state: m.state, plannedTime: m.plannedTime, actualTime: m.actualTime, completionReportedAt: m.completionReportedAt, ...(m.recipeGroups === undefined ? {} : { recipeGroups: clone(m.recipeGroups) }), ...(m.actualRecipeGroups === undefined ? {} : { actualRecipeGroups: clone(m.actualRecipeGroups) }), actualRecipeGroupHistoryCount: rows(m.actualRecipeGroupHistory).length, plannedItems: m.plannedItems.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name ?? l.nutritionSnapshot?.name ?? null, quantity: l.quantity, unit: l.unit, ...(l.itemId === null ? { nutrition: compactNutrition(l.nutritionSnapshot?.nutrition), nutritionSourceTextAvailable: !!l.nutritionSnapshot?.nutrition?.sourceText } : {}) })), reportedItems: m.actualEntries.map((e) => ({ id: e.id, itemId: e.itemId, name: e.name, quantity: e.quantity, unit: e.unit, quantitySource: e.quantitySource })) })), supplementDoses: plan.supplementDoses.map((d) => ({ id: d.id, itemId: d.itemId, plannedQuantity: d.plannedQuantity, unit: d.unit, ...doseMetadata(d), checked: supplementChecked(d), plannedTime: d.plannedTime, actualTime: d.actualTime, state: d.state, reportedQuantity: d.actualEntries.reduce((sum, e) => sum === null || e.quantity === null ? null : round(sum + e.quantity), 0) })) }; }
// Leave room for the MCP route's available/revision response envelope.
const READ_BUDGET = 63000;
const CONTEXT_BUDGET = 24000;
const SUMMARY_BUDGET = 8000;
const summaryText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const summaryNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
function dailySummaryRows(state, dates) {
  if (!dates.size) return [];
  const plans = (state.plans ?? []).filter(plan => plan.format === 'meals_v1' && dates.has(plan.date));
  const history = (state.dietHistory ?? []).filter(record => dates.has(record.date));
  return resolveDietDays(plans, history, state.items).map(row => {
    const allIssues = Array.isArray(row.issues) ? row.issues : [];
    const issues = allIssues.slice(0, 3).map(issue => ({ code: summaryText(issue.code, 60), message: summaryText(issue.message, 160), ...(typeof issue.recordId === 'string' ? { recordId: issue.recordId } : {}) }));
    return {
      date: row.date, recordId: row.id, planId: row.plan?.id ?? null,
      historyId: row.matchedHistoryId ?? (row.recordType === 'diet_history' ? row.history?.id ?? row.id : null),
      basis: summaryText(row.basis, 80), nutritionSource: summaryText(row.nutritionSource, 80),
      partial: row.partial === true, supplementPartial: row.supplementPartial === true, hasDraft: row.hasDraft === true,
      totals: (row.totals ?? []).filter(total => ['kcal', 'protein', 'carbs', 'fat'].includes(total.key)).map(total => ({
        key: total.key, value: summaryNumber(total.value), partial: total.partial === true,
        supplementPartial: total.supplementPartial === true, estimated: total.estimated === true, source: summaryText(total.source, 80),
        missing: summaryNumber(total.missing), supplementMissing: summaryNumber(total.supplementMissing),
      })),
      issues, issueCount: allIssues.length,
      issuesTruncated: allIssues.length > issues.length || allIssues.slice(0, 3).some((issue, index) => issue.code !== issues[index].code || issue.message !== issues[index].message),
    };
  });
}
function summaryBundle(rows, dates, budget = SUMMARY_BUDGET) {
  const selected = rows.filter(row => dates.has(row.date)); const included = [];
  for (const row of selected) {
    const candidate = { dailyNutritionSummaries: [...included, row], dailyNutritionSummaryTotal: selected.length, dailyNutritionSummariesTruncated: false };
    if (JSON.stringify(candidate).length > budget) break;
    included.push(row);
  }
  return { dailyNutritionSummaries: included, dailyNutritionSummaryTotal: selected.length, dailyNutritionSummariesTruncated: included.length < selected.length };
}
function fragment(record, offset = 0, budget = 64000) { const encoded = JSON.stringify(record); if (!Number.isSafeInteger(offset) || offset < 0 || offset > encoded.length) fail("Invalid record chunk offset."); let end = Math.min(encoded.length, offset + Math.floor(budget / 2)); let result; do { result = { recordId: record.id, encoding: 'json_text', offset, totalCharacters: encoded.length, nextOffset: end < encoded.length ? end : null, text: encoded.slice(offset, end), truncated: end < encoded.length, instructions: "Continue with nextOffset and concatenate text by offset. JSON.parse restores the complete record; a chunk is not the full history." }; if (JSON.stringify(result).length <= budget) return result; end = offset + Math.floor((end - offset) / 2); } while (end > offset); fail("The record cannot fit within the output budget."); }
function intakeDraftStatus(plan, items) {
  return { hasDraft: !!plan?.intakeDraft, draftId: plan?.intakeDraft?.id ?? null, draftVersion: intakeDraftVersion(plan?.intakeDraft),
    stale: !!plan?.intakeDraft && plan.intakeDraft.baseFingerprint !== intakePlanFingerprint(plan, items),
    updatedAt: plan?.intakeDraft?.updatedAt ?? null, draftIsActual: false,
    ...(plan ? { details: { tool: 'read_intake_draft', planId: plan.id } } : {}),
    instructions: "An intake draft is not actual intake. Unsubmitted quantities and meal transfers have not been recorded as actuals or deducted from inventory." };
}
export function readIntakeDraft(state, filters = {}) {
  obj(filters, "Read intake draft");
  if (Object.keys(filters).some(field => !['planId', 'date', 'mealIds'].includes(field))) fail("The intake-draft read contains unsupported fields.");
  const plan = filters.planId ? (state.plans ?? []).find(entry => entry.id === id(filters.planId) && entry.format === 'meals_v1')
    : filters.date ? dailyOwner(state, date(filters.date)) : null;
  if (!plan) fail("No structured menu was found for this day.", 404, 'PLAN_NOT_FOUND');
  if (filters.date && plan.date !== date(filters.date)) fail("The date and menu ID do not match.");
  const view = intakeDraftView(plan, state.items);
  if (filters.mealIds !== undefined) {
    const ids = list(filters.mealIds, "Meal ID", 16).map(value => id(value));
    if (ids.some(value => !view.meals.some(meal => meal.id === value))) fail("The requested meal does not exist.", 404, 'MEAL_NOT_FOUND');
    view.meals = view.meals.filter(meal => ids.includes(meal.id));
  }
  const result = { available: true, revision: state.revision, ...view, foodLayoutOverrides: clone(plan.foodLayoutOverrides ?? []), foodLayoutFingerprint: foodLayoutFingerprint(plan),
    instructions: "This is the latest committed menu's intake draft and balance preview. foodLayoutOverrides is saved display placement only: keep sourceMealId/sourceId for factual edits. It changes neither intake nor canonical nutrition. Read it after web layout edits; never auto-submit draft inputs. Cumulative quantities and transfers in draft are not actuals; reportedQuantity comes only from submitted facts. Saving a draft does not change the menu, actuals, supplements, or inventory. Explicit submit_intake_draft performs atomic settlement; retries with the same ID do not deduct twice. stale requires refreshing and review, not overwriting newer actuals from elsewhere." };
  if (JSON.stringify(result).length > 32000) fail("The intake-draft preview is too large. Narrow the meal selection with mealIds; original data was not truncated.", 413, 'INTAKE_DRAFT_VIEW_TOO_LARGE');
  return result;
}
/** Only targeted day/plan reads expose the preparation rollup; general briefs stay small. */
export function readDailyFoodSummary(state, filters = {}) {
  if (filters.expectedRevision !== undefined && (!Number.isSafeInteger(filters.expectedRevision) || filters.expectedRevision < 0)) fail("expectedRevision must be a nonnegative integer.");
  if (filters.expectedRevision !== undefined && filters.expectedRevision !== state.revision) fail("The inventory and menu revision changed. Restart from the first daily-detail page.", 409, 'REVISION_CONFLICT');
  if (filters.planId && filters.recordId && id(filters.planId) !== id(filters.recordId)) fail("planId and recordId do not match.");
  const targetId = filters.planId ?? filters.recordId;
  const source = targetId ? (state.plans ?? []).find(plan => plan.id === id(targetId) && plan.format === 'meals_v1')
    : filters.date ? resolveDietDays((state.plans ?? []).filter(plan => plan.format === 'meals_v1' && plan.date === date(filters.date)), [], state.items)[0]?.plan : null;
  if (!source) return { available: false, note: "No structured current menu exists for this date. Historical text and historical daily totals remain preserved; no migration or inventory deduction was inferred." };
  if (filters.date && source.date !== date(filters.date)) fail("The date and plan ID do not match.");
  const summary = dailyFoodRollup(source, state.items);
  const page = dailyFoodRollupPage(summary, { cursor: filters.cursor ?? '0', limit: filters.limit ?? 50 });
  return { ...page, revision: state.revision,
    ...(page.hasMore ? { detail: { tool: 'read_diet_records', planId: source.id, summaryOnly: 'daily_food', cursor: page.nextCursor, expectedRevision: state.revision } } : {}),
    instructions: "Daily food totals combine each meal's saved nutrition snapshots without counting both planned and actual food. foodTotals covers food, supplementTotals covers supplements included in nutrition, and totals combines both. allocations preserves meal distribution. Unfinished meals reflect the current menu, not proof of intake. When hasMore is true, continue through detail at the same revision. Historical records and inventory are unchanged." };
}
export function readDietRecords(state, filters = {}) {
  obj(filters, "Read parameters");
  if (filters.summaryOnly !== undefined && filters.summaryOnly !== 'daily_food') fail("summaryOnly supports daily_food only.");
  if (filters.summaryOnly === 'daily_food') {
    if (!(filters.date || filters.planId || filters.recordId) || filters.from || filters.to || filters.offset !== undefined) fail("Daily detail requires a single date, planId, or recordId; do not combine it with historical text chunks or a date range.");
    const dailyFoodSummary = readDailyFoodSummary(state, filters);
    return { dailyFoodSummary, records: [], total: dailyFoodSummary.rowCount ?? 0, included: dailyFoodSummary.includedRows ?? 0,
      nextCursor: dailyFoodSummary.nextCursor ?? null, truncated: dailyFoodSummary.truncated === true };
  }
  const foodSummary = filters.date || filters.planId || filters.recordId ? readDailyFoodSummary(state, { date: filters.date, planId: filters.planId, recordId: filters.recordId }) : null;
  const intakeSource = filters.planId || filters.recordId ? (state.plans ?? []).find(plan => plan.id === (filters.planId ?? filters.recordId) && plan.format === 'meals_v1')
    : filters.date ? dailyOwner(state, filters.date) : null;
  const foodBundle = { ...(foodSummary ? { dailyFoodSummary: foodSummary } : {}),
    ...(intakeSource ? { intakeDraftState: intakeDraftStatus(intakeSource, state.items) } : {}) };
  let plans = [...(state.plans ?? []).filter((p) => p.format === 'meals_v1' || (p.format === undefined && Array.isArray(p.items))), ...(state.dietHistory ?? []).map(historySnapshot)];
  if (filters.recordId !== undefined) {
    const record = plans.find((p) => p.id === id(filters.recordId)); if (!record) fail("Diet record not found.", 404, 'PLAN_NOT_FOUND');
    const dates = new Set([record.date]); const summaries = summaryBundle(dailySummaryRows(state, dates), dates);
    // Only metadata is added. The text still serializes the exact original
    // snapshot, so joining fragments restores the record without derived data.
    return { ...fragment(record, filters.offset ?? 0, READ_BUDGET - JSON.stringify(summaries).length - JSON.stringify(foodBundle).length - 20), ...summaries, ...foodBundle };
  }
  for (const key of ['date', 'from', 'to']) if (filters[key] !== undefined) date(filters[key]);
  if (filters.date) plans = plans.filter((p) => p.date === filters.date); if (filters.from) plans = plans.filter((p) => p.date >= filters.from); if (filters.to) plans = plans.filter((p) => p.date <= filters.to); if (filters.planId) plans = plans.filter((p) => p.id === id(filters.planId));
  plans = plans.slice().sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)); const offset = filters.cursor === undefined ? 0 : Number(filters.cursor); if (!Number.isSafeInteger(offset) || offset < 0 || offset > plans.length) fail("Invalid pagination cursor."); const limit = filters.limit ?? 14; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("limit must be between 1 and 50.");
  const records = []; let cursor = offset;
  const summaryRows = dailySummaryRows(state, new Set(plans.slice(offset, offset + limit).map(record => record.date)));
  const response = (page, next) => {
    const summaries = summaryBundle(summaryRows, new Set(page.map(record => record.date)));
    return { records: page, total: plans.length, included: page.length, nextCursor: next < plans.length ? String(next) : null,
      truncated: next < plans.length || page.some(record => record.recordTruncated) || summaries.dailyNutritionSummariesTruncated || foodSummary?.hasMore === true,
      ...summaries, ...foodBundle, quantityMeaning: 'remaining_after_actual_and_legacy_credits', intakeExplanation: "Current menus become visible and editable when saved. Saving, adopting, and editing never reserve or deduct inventory; only explicit actual intake settles it. New menus use foodAccounting=actual_only. Unmarked historical reservations retain their original credits without another deduction. confirmed_daily_plan does not mean eaten; unreported actualTime stays null. dailyNutritionSummaries uses the same daily calculation as the page. When partial=true, value covers known values only; supplementPartial separately marks missing supplement data. recordType=diet_history is an independent historical archive with inventoryEffect=none and never changes current inventory." };
  };
  while (cursor < plans.length && records.length < limit) {
    const record = plans[cursor]; const full = clone(record);
    if (JSON.stringify(response([...records, full], cursor + 1)).length > READ_BUDGET) {
      if (records.length) break;
      records.push({ id: record.id, date: record.date, title: record.title.slice(0, 100), ...(record.recordType === 'diet_history' ? { recordType: record.recordType, inventoryEffect: record.inventoryEffect, confirmation: record.confirmation } : { status: record.status }), ...(record.supplementOnly ? { supplementOnly: true } : {}), ...(record.supplementAccounting ? { supplementAccounting: record.supplementAccounting } : {}), recordTruncated: true, detail: { recordId: record.id, offset: 0 }, instructions: "This record exceeds the output budget. Read lossless chunks using recordId and offset." }); cursor++; break;
    }
    records.push(full); cursor++;
  }
  return response(records, cursor);
}
export function dietContext(state, forDate) {
  const day = date(forDate); const all = (state.plans ?? []).filter((p) => p.format === 'meals_v1' && p.date === day);
  const history = historyContext(state, day); const historyTotal = (state.dietHistory ?? []).filter(record => record.date === day).length;
  const dates = new Set([day]); const summaries = summaryBundle(dailySummaryRows(state, dates), dates);
  const result = { date: day, records: [], total: all.length + historyTotal, truncated: history.length < historyTotal || summaries.dailyNutritionSummariesTruncated, ...summaries,
    instructions: ["Read current inventory and the day's current menu before planning. Saving or targeted edits display immediately without final confirmation, reservation, or inventory deduction.", "Reuse the day's canonical planId and stable mealId, itemId, and doseId. Supplement checkmarks are independent of food menus. draft.meals under legacy supplementOnly records remains the current menu; do not omit or reconstruct its meals.", "Daily nutrition defaults to the current menu. Reported meals use actuals; unfinished meals keep planned food without claiming it was eaten.", "dailyNutritionSummaries shares the page's daily calculation. When partial=true, value covers known values only and is not a complete daily total. Preserve estimated/source provenance; supplementPartial separately marks missing supplement data.", "Staple foods still need sourced nutrition estimates for kcal/P/C/F even when their stock is not tracked. Do not omit them or replace unknown values with zero.", "Missing actualTime stays null; do not copy planned time. Completing food does not automatically mean supplements were taken.", "Use record_meal_intake only for explicit completion reports, per meal or once for the day with meals[]. Reuse original actual IDs; correct applies only the difference. Historical reservations provide credits. Do not also call ordinary consume and deduct twice.", "diet_history is an independent historical archive with inventoryEffect=none. Never use it for another inventory deduction or refund. final_plan is not evidence of actual intake.", "When truncated or issuesTruncated is true, read original text with read_diet_records by date/planId or recordId and pagination before editing."] };
  for (const plan of all) {
    const record = compact(plan, state.items);
    if (JSON.stringify({ ...result, records: [...result.records, record] }).length <= CONTEXT_BUDGET) result.records.push(record);
    else {
      const pointer = { id: plan.id, date: plan.date, title: plan.title.slice(0, 80), status: plan.status, inventoryAccounting: plan.inventoryAccounting, ...(plan.supplementOnly ? { supplementOnly: true } : {}), ...(plan.supplementAccounting ? { supplementAccounting: plan.supplementAccounting } : {}), detailRequired: true, recordId: plan.id };
      if (JSON.stringify({ ...result, records: [...result.records, pointer] }).length <= CONTEXT_BUDGET) result.records.push(pointer);
      result.truncated = true; break;
    }
  }
  for (const record of history) {
    if (JSON.stringify({ ...result, records: [...result.records, record] }).length > CONTEXT_BUDGET) { result.truncated = true; break; }
    result.records.push(record);
  }
  return result;
}
