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
  if (!knownDate(referenceDate)) throw Object.assign(new Error('搭配参考日期必须为真实YYYY-MM-DD日期。'), { status: 400, code: 'INVALID_REFERENCE_DATE' });
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.items)
    || state.plans !== undefined && !Array.isArray(state.plans)) {
    throw Object.assign(new Error('实际饮食参考数据无法完整读取。'), { status: 503, code: 'MEAL_PATTERN_CONTEXT_UNAVAILABLE' });
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
    instructions: '这是用户授权沿用的近期熟悉搭配参考。先遵守全部最新preferences、本次要求和当前库存、新鲜度，再沿用熟悉组合，不为凑营养自行创造陌生搭配。referenceEvidence=reported_actual且actualIntakeProven=true来自已完成的真实actual；automatic_menu_assumption且actualIntakeProven=false仅来自已结算automatic_menu的默认菜单，置信度较低，不是用户报告吃过。优先真实完整执行日，再参考默认结算日；未结算/待核对或未来菜单不作默认参考。actualEntries仅原真实条目，plannedEntries是结算默认余量，不是新实际；个人食物checkbox只是提醒，完全不用于推断吃了什么。执行或默认结算过都不表示每种食物是永久喜好，不自动新增喜欢/禁忌。quantity=null保持未知；没有完整日只提供单餐参考，不假造整天模板。旧实际营养仅是当时快照；默认结算未冻结营养时保留null，不拿当前标签伪装旧营养，新菜单一律按最新库存标签和当前份量重算。currentInventory精确匹配itemId；外部或无货食物不自动入库，单位不自动换算。旧时间和补给实际不迁移，不复制旧actual为今天已吃。omittedCompleteDayReferences保留数量/预算省略的日期、planId及证据等级，需要时定向read_diet_records核对整天搭配。读取不修改菜单、actual、习惯或库存。',
  };
  const refreshDayCoverage = () => {
    const included = new Set(result.completeDayReferences.map(day => day.planId));
    result.coverage.includedCompleteDayCount = result.completeDayReferences.length;
    result.coverage.omittedCompleteDayCount = completeDays.length - result.completeDayReferences.length;
    result.hasCompleteDayReference = result.completeDayReferences.length > 0;
    result.omittedCompleteDayReferences = completeDays.filter(candidate => !included.has(candidate.plan.id)).map(dayPointer);
  };
  if (!completedMeals.length) result.instructions = '近14日无合格实际餐或已结算默认菜单参考。不据草稿、建议、未来菜单、个人checkbox或补给推断已吃或喜好。继续遵守完整习惯和最新库存、新鲜度。读取不修改记录。';
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
  if (size(result) > BUDGET) throw Object.assign(new Error('实际饮食参考元数据超过读取预算。'), { status: 413, code: 'MEAL_PATTERN_CONTEXT_TOO_LARGE' });
  return result;
}
