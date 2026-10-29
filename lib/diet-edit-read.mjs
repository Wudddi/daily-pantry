import { materializeDietPlanForEdit } from './diet.mjs';
import { planNutritionTotals } from './diet-nutrition.mjs';
import { resolveDietDays } from './diet-day-summary.mjs';
import { inventoryPlanningPriorities } from './inventory-planning-priority.mjs';
import { foodPreferencesContext } from './food-preferences-context.mjs';
import { readDailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
import { inventoryAccountingContext, inventoryAccountingFields } from './inventory-accounting-context.mjs';
import { dailyMenuSettlementSummary } from './daily-menu-settlement-context.mjs';

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
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail(`${label}必须为1至100字符。`);
  return value.trim();
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('需要真实YYYY-MM-DD日期。');
  return value;
}
function uniqueList(value, label, max, parse = identifier) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > max) fail(`${label}最多${max}项。`);
  const result = value.map(entry => parse(entry, label));
  if (new Set(result).size !== result.length) fail(`${label}不能重复。`);
  return result;
}
function validateFilters(state, filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail('读取参数必须为对象。');
  if (Object.keys(filters).some(key => !FILTERS.has(key))) fail('含不支持的轻量改餐读取参数。');
  if (filters.planId === undefined && filters.date === undefined) fail('请提供planId或date。');
  if (filters.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(filters.expectedRevision) || filters.expectedRevision < 0) fail('expectedRevision无效。');
    if (filters.expectedRevision !== state.revision) fail('库存版本已变化，请重新读取本次改餐上下文。', 409, 'REVISION_CONFLICT');
  }
  if (filters.view !== undefined && !['draft', 'active'].includes(filters.view)) fail('view只能为draft或active。');
  const query = filters.foodQuery === undefined ? '' : filters.foodQuery;
  if (typeof query !== 'string' || query.length > 160) fail('食品名称查询最多160字符。');
  return {
    planId: filters.planId === undefined ? null : identifier(filters.planId, '计划ID'),
    date: filters.date === undefined ? null : day(filters.date), view: filters.view ?? 'draft',
    mealIds: uniqueList(filters.mealIds, '餐次ID', 16),
    mealSlots: uniqueList(filters.mealSlots, '餐次类型', 5, value => { if (!SLOTS.has(value)) fail('餐次类型无效。'); return value; }),
    candidateItemIds: uniqueList(filters.candidateItemIds, '候选食品ID', 12) ?? [], foodQuery: nameKey(query),
  };
}
function selectPlan(state, filters) {
  const candidates = rows(state.plans).filter(plan => filters.planId ? plan.id === filters.planId : plan.date === filters.date);
  if (!candidates.length) fail('找不到目标饮食计划。', 404, 'PLAN_NOT_FOUND');
  if (candidates.length !== 1) fail('同一日期存在多份记录，请核对并提供唯一canonical planId，不猜测合并。', 409, 'AMBIGUOUS_DAILY_PLAN');
  const plan = candidates[0];
  if (plan.format !== 'meals_v1') fail('此记录不是可分餐修改的计划；历史或旧版平铺记录不能猜测转换。', 409, 'PLAN_FORMAT_NOT_EDITABLE');
  if (filters.date && plan.date !== filters.date) fail('planId与date不一致。', 409, 'PLAN_DATE_CONFLICT');
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
  if (!['draft', 'active'].includes(view)) fail('view只能为draft或active。');
  const source = selectPlan(state, { planId: identifier(planId, '计划ID') });
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
    if (uncertain) return { ...line, quantity: null, remainingNote: '余量待核对；原计划 ' + line.quantity + ' ' + line.unit };
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
    selectionInstructions: '明确指定的候选ID优先保留；名称查询中的同类替换参考planningHints及近期已确认菜单覆盖，但不覆盖用户这次口味、营养目标和全部习惯。只改目标餐，不为轮换改动其他餐和补给；近期安排不是实际吃过的证明。营养待补的其他食材不阻碍本次改餐，未知值不补零。' };
}

/** One immutable inventory snapshot, projected for a small meal edit. */
export function readFoodPlanEditContext(state, rawFilters = {}) {
  const filters = validateFilters(state, rawFilters), source = selectPlan(state, filters), view = viewOf(state, source, filters.view);
  const preferencesContext = foodPreferencesContext(state);
  const { plan, editBase } = view, items = rows(state.items), meals = rows(plan.meals);
  if (filters.mealIds) for (const id of filters.mealIds) if (!meals.some(meal => meal.id === id)) fail('目标餐次ID不存在于本次编辑视图。', 404, 'MEAL_NOT_FOUND');
  const selected = meals.filter(meal => (!filters.mealIds || filters.mealIds.includes(meal.id)) && (!filters.mealSlots || filters.mealSlots.includes(meal.slot)));
  if ((filters.mealIds?.length || filters.mealSlots?.length) && !selected.length) fail('没有与指定ID和餐次类型同时匹配的餐次。', 404, 'MEAL_NOT_FOUND');
  const reasons = [];
  if (!['draft', 'reserved'].includes(source.status)) reasons.push('PLAN_CLOSED');
  const canPatch = reasons.length === 0;
  const applyReasons = canPatch ? [] : reasons.slice();
  const selectedIds = new Set(selected.map(meal => meal.id));
  const omitted = meals.filter(meal => !selectedIds.has(meal.id));
  const dailySettlement = dailyMenuSettlementSummary(source);
  const result = {
    revision: state.revision,
    ...(state.dailyMenuSettlementPolicy ? { dailyMenuSettlementPolicy: readDailyMenuSettlementPolicy(state) } : {}),
    plan: { id: source.id, date: plan.date, title: plan.title, status: source.status, hasDraft: !!source.draft, editBase,
      supplementOnly: plan.supplementOnly === true, supplementAccounting: plan.supplementAccounting ?? null,
      inventoryAccounting: source.inventoryAccounting, ...(rows(source.accountingWarnings).length ? { accountingWarnings: rows(source.accountingWarnings).slice(0, 3), accountingWarningCount: rows(source.accountingWarnings).length, accountingWarningsTruncated: rows(source.accountingWarnings).length > 3 } : {}), canPatch, protectionReasons: reasons,
      ...(dailySettlement === undefined ? {} : { dailySettlement }),
      canApply: applyReasons.length === 0, applyProtectionReasons: applyReasons,
      accountingIssueCount: rows(source.accountingIssues).length,
      accountingIssues: rows(source.accountingIssues).slice(0, 3).map(issue => ({ code: issue.code, itemId: issue.itemId ?? null })),
      accountingIssuesTruncated: rows(source.accountingIssues).length > 3 },
    meals: selected.map(meal => projectMeal(meal, plan, canPatch, items)),
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
    instructions: 'preferences是与本次revision一致的全部当前习惯，preferencesComplete=true，不为小改重读全库存或逐组训练。新工作流程优先于旧习惯中的确认即扣库存条款：菜单保存、采用和修改均不预留扣库存，保存即显示；明确实际吃完才record_meal_intake。只patch稳定目标ID，未提供食物、其他餐和补给完整保留，不从摘要重建全天。mode=draft/apply均更新当前planned字段，apply沿用confirmed=true兼容参数；账务pending不阻塞计划编辑，也不因改餐结算旧账。已有actual不可由计划覆盖，完成餐按实际快照、其余餐按最新菜单估算；更正实际用correct复用entryId，营养更正用nutritionCorrections及来源，未知不是0。有facts餐次不能删除。旧账accountedByThisPlan只是原credits，不代表本次应再扣；盘点基线变化不自动退款。原话和审计保留，核证据才定向读原记录。目标上下文24000字符，全部习惯另计，超限缩小mealIds不截断必需事实或习惯。',
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

  result.truncated = result.inventoryCandidates.truncated || result.otherMeals.truncated || result.omittedMealIds.length > 0;
  if (size(result) > BUDGET) fail('目标上下文超过24000字符，请缩小餐次范围并读取原记录。', 413, 'EDIT_CONTEXT_TOO_LARGE');
  // Full current preferences are mandatory and must not compete with target
  // facts or replacement candidates for the meal-context budget. Count their
  // serialized JSON separately, including quotes and escaped characters.
  const preferencesJsonCharacters = size(preferencesContext.preferences);
  const preferencesContextJsonCharacters = size(preferencesContext);
  const charBudget = BUDGET + preferencesContextJsonCharacters + PREFERENCES_METADATA_BUDGET;
  const response = { ...result, ...preferencesContext, contextCharBudget: BUDGET,
    preferencesJsonCharacters, preferencesContextJsonCharacters, charBudget };
  if (size(response) > charBudget) fail('完整改餐上下文超过输出预算，请缩小餐次范围；未截断习惯或实际事实。', 413, 'EDIT_CONTEXT_TOO_LARGE');
  return response;
}
