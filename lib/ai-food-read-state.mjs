import { projectCurrentDietPlan } from './diet-current-plan.mjs';

const rows = value => Array.isArray(value) ? value : [];
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value;
const validTime = value => typeof value === 'string' && value.length <= 50 && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const key = (mealId, lineId) => JSON.stringify([mealId, lineId]);
const instructions = 'Personal checkmarks are advisory selection/context, never actual-intake evidence or permission to deduct stock. Unchecked never means uneaten. Use only after the user explicitly reports the selected foods eaten or requests their settlement; reread the latest revision first. Keep sourceMealId/lineId for factual edits; displayMealId is presentation only. Rows can reference source meals omitted by a display-meal filter; read those sourceMealIds for current quantities and actual entries before reporting/settling. Do not derive quantities from the check state. Treat selected current portions as cumulative intake targets, honor explicit corrected quantities, compare existing actual IDs and accountedDebits, and record only the missing amount; never append the full planned amount on top of prior intake or mark a whole meal complete from a partial selection. Do not guess same-SKU associations. Missing, invalid or truncated rows are not unchecked or uneaten; narrow mealIds through read_intake_draft or read_food_plan_edit_context before using omitted references. If source/display overlap still exceeds the cap, inspect the original records and ask for the missing selection rather than guessing.';

/** Bounded current-row references only. Stored reminders, malformed entries,
 * deleted lines and historical/draft reminder objects remain private. */
export function personalFoodCheckContext(input, { mealIds, maxRows = 100 } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100) throw Object.assign(new Error('Personal-check context maxRows must be between 1 and 100.'), { status: 400, code: 'INVALID_PERSONAL_CHECK_CONTEXT' });
  if (mealIds !== undefined && (!Array.isArray(mealIds) || mealIds.length > 16 || mealIds.some(value => !validId(value)))) throw Object.assign(new Error('Personal-check context mealIds must contain valid source or display meal IDs.'), { status: 400, code: 'INVALID_PERSONAL_CHECK_CONTEXT' });
  const plan = projectCurrentDietPlan(input ?? {}), selected = mealIds === undefined ? null : new Set(mealIds);
  const meals = rows(plan.meals), mealCounts = new Map(), lineCounts = new Map(), candidates = [];
  let invalidReferenceCount = 0, staleReferenceCount = 0;
  for (const meal of meals) if (validId(meal?.id)) mealCounts.set(meal.id, (mealCounts.get(meal.id) ?? 0) + 1);
  for (const meal of meals) for (const line of rows(meal?.plannedItems)) {
    if (!validId(meal?.id) || !validId(line?.id) || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) continue;
    const sourceKey = key(meal.id, line.id);
    lineCounts.set(sourceKey, (lineCounts.get(sourceKey) ?? 0) + 1);
    candidates.push({ sourceMealId: meal.id, lineId: line.id, sourceKey });
  }
  const validMeals = new Set([...mealCounts].filter(([, count]) => count === 1).map(([id]) => id));
  const validLines = new Set(candidates.filter(row => validMeals.has(row.sourceMealId) && lineCounts.get(row.sourceKey) === 1).map(row => row.sourceKey));
  const unsafe = new Set(), placements = new Map();
  for (const move of rows(plan.foodLayoutOverrides)) {
    if (move?.sourceKind !== 'planned') continue;
    const sourceKey = key(move.sourceMealId, move.sourceId);
    if (!validLines.has(sourceKey)) { staleReferenceCount++; continue; }
    if (!validMeals.has(move.targetMealId) || Object.keys(move).some(field => !['sourceMealId', 'sourceKind', 'sourceId', 'targetMealId'].includes(field))) {
      unsafe.add(sourceKey); invalidReferenceCount++; continue;
    }
    if (placements.has(sourceKey)) { unsafe.add(sourceKey); invalidReferenceCount++; continue; }
    placements.set(sourceKey, move.targetMealId);
  }
  const saved = input?.personalFoodChecks;
  const available = saved === undefined || !!saved && saved.version === 1 && Array.isArray(saved.checks) && saved.checks.length <= 1600;
  const checked = new Map();
  if (available) for (const check of rows(saved?.checks)) {
    const sourceKey = key(check?.mealId, check?.lineId);
    if (!validLines.has(sourceKey)) { staleReferenceCount++; continue; }
    if (!check || typeof check !== 'object' || typeof check.checked !== 'boolean' || !validTime(check.updatedAt)
      || Object.keys(check).some(field => !['mealId', 'lineId', 'checked', 'updatedAt'].includes(field))) {
      unsafe.add(sourceKey); invalidReferenceCount++; continue;
    }
    if (checked.has(sourceKey)) { unsafe.add(sourceKey); invalidReferenceCount++; continue; }
    checked.set(sourceKey, check);
  }
  else invalidReferenceCount++;
  const references = [], seen = new Set(); let totalRows = 0;
  for (const row of candidates) {
    if (seen.has(row.sourceKey)) continue;
    seen.add(row.sourceKey);
    const displayMealId = placements.get(row.sourceKey) ?? row.sourceMealId;
    if (selected && !selected.has(row.sourceMealId) && !selected.has(displayMealId)) continue;
    totalRows++;
    if (!available || unsafe.has(row.sourceKey) || !validLines.has(row.sourceKey) || references.length >= maxRows) continue;
    const check = checked.get(row.sourceKey);
    references.push({ sourceMealId: row.sourceMealId, lineId: row.lineId, checked: check?.checked ?? false,
      displayMealId, updatedAt: check?.updatedAt ?? null });
  }
  return { available, basis: 'personal_reminder', actualIntakeEvidence: false,
    savedAt: validTime(saved?.updatedAt) ? saved.updatedAt : null, rows: references, totalRows,
    includedRows: references.length, truncated: references.length < totalRows, invalidReferenceCount, staleReferenceCount, instructions };
}

/** Raw reminder storage is never returned to the model. A detached advisory
 * projection is carried through targeted record reads without changing facts. */
export function aiFoodReadState(state) {
  const strip = value => Array.isArray(value) ? value.map(strip) : !value || typeof value !== 'object' ? value
    : Object.fromEntries(Object.entries(value).filter(([key]) => !['personalFoodChecks', 'personalCheckContext'].includes(key)).map(([key, child]) => [key, strip(child)]));
  return { ...state, plans: (state.plans ?? []).map(plan => ({ ...strip(plan), personalCheckContext: personalFoodCheckContext(plan) })) };
}
