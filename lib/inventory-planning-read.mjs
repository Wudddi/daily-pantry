/** Bounded, read-only inventory projection for the meal-planning MCP tool. */
import { planningSnapshot } from './inventory.mjs';
import { getSupplementRoutine } from './diet.mjs';
import { nutritionFactor } from './diet-nutrition.mjs';
import { inventoryPlanningPriorities, PLANNING_PRIORITY_RULES } from './inventory-planning-priority.mjs';
import { mealPatternContext } from './meal-pattern-context.mjs';
import { readDailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
import { inventoryAccountingContext, inventoryAccountingFields } from './inventory-accounting-context.mjs';
import { dailyMenuSettlementSummary } from './daily-menu-settlement-context.mjs';
import { foodPreferencesContext } from './food-preferences-context.mjs';

const LIST_BUDGET = 96_000;
// The normal page budget already accommodates 60 unescaped 500-character
// habits. Only JSON expansion beyond that allowance is added separately.
const PREFERENCES_INCLUDED_BUDGET = 32_000;
const DETAIL_BUDGET = 12_000;
const PLAN_BUDGET = 6_000;
const MAX_PLANS = 24;
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat'];
const FILTER_KEYS = new Set(['cursor', 'limit', 'itemId', 'offset', 'expectedRevision']);
const STATUSES = ['available', 'depleted', 'pending', 'archived'];
const jsonLength = (value) => JSON.stringify(value).length;

function fail(message, status = 400, code = 'INVALID_READ_FILTER') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name}必须是非负安全整数。`);
  return value;
}

function readFilters(filters, revision) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail('读取参数必须是对象。');
  if (Reflect.ownKeys(filters).some((key) => !FILTER_KEYS.has(key))) fail('读取参数包含未知字段。');
  if (filters.expectedRevision !== undefined) {
    nonnegativeInteger(filters.expectedRevision, 'expectedRevision');
    if (filters.expectedRevision !== revision) fail('库存版本已变化，请重新读取第一页后再分页或读取详情。', 409, 'REVISION_CONFLICT');
  }
  const limit = filters.limit === undefined ? 100 : filters.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('limit必须是1到100的整数。');
  let cursor = filters.cursor === undefined ? 0 : filters.cursor;
  if (typeof cursor === 'string') {
    if (!/^(0|[1-9]\d*)$/.test(cursor)) fail('cursor无效，请使用上次返回的nextCursor。');
    cursor = Number(cursor);
  }
  nonnegativeInteger(cursor, 'cursor');
  if (cursor > 0 && filters.expectedRevision === undefined) fail('库存续页必须携带首读revision作为expectedRevision；请从第一页重新读取，避免混用不同版本的习惯与库存。', 409, 'REVISION_REQUIRED');
  if (filters.itemId !== undefined) {
    if (typeof filters.itemId !== 'string' || !filters.itemId.trim() || filters.itemId.length > 100) fail('itemId必须是有效食材ID。');
    if (filters.cursor !== undefined || filters.limit !== undefined) fail('食材详情不可与列表cursor或limit混用。');
  } else if (filters.offset !== undefined) fail('offset必须与itemId一起使用。');
  const offset = filters.offset === undefined ? 0 : nonnegativeInteger(filters.offset, 'offset');
  return { cursor, limit, itemId: filters.itemId, offset };
}

function itemBrief(item, priorities, accounting) {
  const nutrition = item.nutrition;
  let textTruncated = !!nutrition.sourceText;
  const excerpt = (value, max) => {
    const text = typeof value === 'string' ? value : '';
    if (text.length > max) textTruncated = true;
    return text.slice(0, max);
  };
  const sourceNote = excerpt(nutrition.sourceNote, 120);
  const row = {
    id: item.id, name: item.name, ...(item.brand ? { brand: item.brand } : {}), category: item.category,
    ...(item.aliases?.length ? { aliases: item.aliases.slice() } : {}),
    quantity: item.quantity, unit: item.unit, status: item.status,
    priority: item.priority, ...(item.location ? { location: item.location } : {}), gramsPerUnit: item.gramsPerUnit,
    confirmedAt: item.confirmedAt, updatedAt: item.updatedAt,
    ...(item.freshness ? { freshness: structuredClone(item.freshness) } : {}),
    nutrition: {
      basisAmount: nutrition.basisAmount, basisUnit: nutrition.basisUnit,
      ...Object.fromEntries(NUTRIENTS.map((key) => [key, nutrition[key]])),
      source: nutrition.source,
      nutrientSources: Object.fromEntries(NUTRIENTS.map(key => [key, nutrition[key] === null ? 'unknown' : nutrition.nutrientSources?.[key] ?? nutrition.source])),
      ...(sourceNote ? { sourceNote } : {}),
    },
  };
  for (const [field, max] of [['notes', 200], ['ingredients', 80], ['supplementFacts', 400]]) {
    const text = excerpt(item[field], max);
    if (text) row[field] = text;
  }
  return { ...row, ...(priorities?.metadata(item) ?? {}), ...inventoryAccountingFields(item, accounting), textTruncated };
}

function indexes(items) {
  const result = Object.fromEntries(STATUSES.map((status) => [status, []]));
  for (const item of items) {
    // Available quantity=null means present, amount unknown. It is not depleted.
    const status = item.status === 'available' && item.quantity === 0 ? 'depleted' : item.status;
    result[status]?.push(item.id);
  }
  return result;
}

function planIndex(plans, today) {
  const sorted = plans.slice().sort((a, b) => {
    const relevant = (plan) => plan.date === today ? 0 : plan.status === 'reserved' && plan.date > today ? 1 : 2;
    const dateOrder = relevant(a) === 1 && relevant(b) === 1 ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
    return relevant(a) - relevant(b) || dateOrder || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id);
  });
  const result = [];
  for (const plan of sorted.slice(0, MAX_PLANS)) {
    const title = String(plan.title ?? '');
    const dailySettlement = dailyMenuSettlementSummary(plan);
    const row = {
      id: plan.id, date: plan.date, title: title.slice(0, 100), status: plan.status,
      accounting: plan.inventoryAccounting ?? 'legacy_reservation',
      hasDraft: !!plan.draft, supplementOnly: plan.supplementOnly === true,
      ...(plan.format === undefined ? { legacyReservation: true } : {}),
      ...(plan.supplementAccounting ? { supplementAccounting: plan.supplementAccounting } : {}),
      ...(dailySettlement === undefined ? {} : { dailySettlement }),
      ...(title.length > 100 ? { textTruncated: true } : {}),
      detail: { tool: 'read_diet_records', recordId: plan.id, offset: 0 },
    };
    if (jsonLength([...result, row]) > PLAN_BUDGET) break;
    result.push(row);
  }
  return result;
}

function markContext(base) {
  base.planSummary.included = base.plans.length;
  base.planSummary.omitted = base.planSummary.total - base.plans.length;
  base.planSummary.truncated = base.planSummary.omitted > 0;
}

/** Only the optional plan index may shrink. Habits, rules and routine stay complete. */
function fitContext(base, budget) {
  markContext(base);
  while (jsonLength(base) > budget && base.plans.length) { base.plans.pop(); markContext(base); }
  if (jsonLength(base) > budget) fail('完整排餐习惯、规则与通用补给安排超过读取预算；未返回不完整习惯，也未删除或截断原文。请在应用中核对并整理过长的有效习惯或时间表后重新读取；不得忽略习惯继续排餐。', 413, 'PLANNING_CONTEXT_TOO_LARGE');
}

/** Validate the original collection bounds before asking the canonical policy
 * reader for an empty projection. Never materialise its rich items or history. */
function policySnapshot(state, now) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('库存状态必须是对象。', 400, 'INVALID_INPUT');
  if (!Array.isArray(state.items) || state.items.length > 400) fail('库存最多保存400项。', 400, 'INVALID_INPUT');
  if (state.plans !== undefined && (!Array.isArray(state.plans) || state.plans.length > 1000)) fail('计划数据格式或数量无效。', 400, 'INVALID_INPUT');
  if (state.dietHistory !== undefined && (!Array.isArray(state.dietHistory) || state.dietHistory.length > 1000)) fail('历史饮食数据格式或数量无效。', 400, 'INVALID_INPUT');
  if (!Array.isArray(state.preferences) || state.preferences.length > 60 || state.preferences.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) fail('排餐习惯必须是最多60条、每条不超过500字的完整文字。', 400, 'INVALID_INPUT');
  return planningSnapshot({
    schemaVersion: state.schemaVersion, revision: state.revision, updatedAt: state.updatedAt,
    events: state.events, operationIds: state.operationIds, preferences: state.preferences,
    items: [], plans: [], dietHistory: [],
  }, now);
}

function inventoryReadiness(items) {
  const result = { availableCount: 0, foodCount: 0, supplementCount: 0, completeCount: 0, partialCount: 0, missingCount: 0, unknownQuantityCount: 0, unconvertibleCount: 0 };
  for (const item of items) {
    if (item.status !== 'available' || item.quantity === 0) continue;
    result.availableCount++;
    if (item.quantity === null) result.unknownQuantityCount++;
    if (item.category === 'supplement') { result.supplementCount++; continue; }
    result.foodCount++;
    const known = NUTRIENTS.filter(key => item.nutrition[key] !== null).length;
    if (!known) result.missingCount++;
    else if (known < NUTRIENTS.length) result.partialCount++;
    else result.completeCount++;
    if (item.quantity !== null && nutritionFactor(item, item.quantity, item.unit) === null) result.unconvertibleCount++;
  }
  return result;
}

/** Keep the canonical fallback selection, but project only arrangement fields.
 * In particular, deriving a routine must never copy source-day actual facts. */
function routineReference(state) {
  const routine = getSupplementRoutine(state);
  if (!routine) return null;
  if (routine.supplementDoses.length > 32) fail('通用补给时间表超过32个剂次，请先核对完整安排。', 400, 'INVALID_SUPPLEMENT_ROUTINE');
  const itemById = new Map(state.items.map(item => [item.id, item]));
  const sourcePlan = (state.plans ?? []).find(plan => plan.id === routine.sourcePlanId);
  const text = value => typeof value === 'string' ? value : '';
  const doses = routine.supplementDoses.map(dose => {
    const requirement = dose.requirement ?? 'daily';
    return {
      id: dose.id, itemId: dose.itemId, name: dose.nutritionSnapshot?.name ?? itemById.get(dose.itemId)?.name ?? '',
      plannedQuantity: dose.plannedQuantity ?? null, unit: dose.unit ?? itemById.get(dose.itemId)?.unit ?? '',
      timingSlot: dose.timingSlot ?? 'other', requirement,
      scheduled: dose.scheduled ?? requirement === 'daily', trainingDayOnly: dose.trainingDayOnly ?? false,
      plannedMealId: dose.plannedMealId ?? null, plannedTime: dose.plannedTime ?? null,
      plannedTimeText: text(dose.plannedTimeText), instruction: text(dose.instruction), sourceText: text(dose.sourceText),
    };
  });
  return {
    sourcePlanId: routine.sourcePlanId ?? null, date: sourcePlan?.date ?? null, updatedAt: routine.updatedAt,
    routineSource: state.supplementRoutine ? 'saved' : 'derived',
    total: doses.length, included: doses.length, omitted: 0, truncated: false, textTruncated: false, doses,
    instructions: '这是完整通用补给安排，不是今天已服用的事实。每天沿用唯一dose.id，结合训练日、daily/optional/as_needed/label_pending与显式scheduled安排；可选不强制，未知粒数或克数不猜。没有三餐也可按日期记录；当天已有补给账时复用其canonical计划ID，不另建第二份账。未复制来源日的actual、服用时间或勾选。',
  };
}

function itemFragment(state, itemId, offset, generatedAt) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) fail('找不到此食材，请重新读取库存列表。', 404, 'ITEM_NOT_FOUND');
  const text = JSON.stringify(item);
  if (offset > text.length) fail('offset超出食材JSON原文长度。');
  const response = (end) => ({
    schemaVersion: 1, responseFormat: 'compact_inventory_v2', format: 'inventory_item_json', revision: state.revision, generatedAt,
    itemId, encoding: 'json_text', offset, totalCharacters: text.length,
    text: text.slice(offset, end), nextOffset: end < text.length ? end : null,
    complete: end === text.length, truncated: end < text.length, charBudget: DETAIL_BUDGET,
    instructions: '按nextOffset及本次revision作为expectedRevision继续；依offset拼接所有text，再JSON.parse还原完整原始食材。单片不是完整标签或配方；读取不修改库存。',
  });
  // Slice the JSON text, not the object. The response itself escapes that text
  // again, so find a length that fits the encoded envelope rather than using a
  // fixed character slice that would fail for control characters/backslashes.
  let low = offset, high = Math.min(text.length, offset + DETAIL_BUDGET);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonLength(response(middle)) <= DETAIL_BUDGET) low = middle;
    else high = middle - 1;
  }
  const result = response(low);
  if (jsonLength(result) > DETAIL_BUDGET || (offset < text.length && low === offset)) fail('无法在预算内读取食材分段。', 500, 'READ_BUDGET_EXCEEDED');
  return result;
}

/**
 * Canonical items occur once per page. Status indexes refer only to that page;
 * readiness counts describe the whole inventory. Reads never confirm quantities.
 */
export function readPlanningInventory(state, filters = {}, now = new Date().toISOString()) {
  const { cursor, limit, itemId, offset } = readFilters(filters, state?.revision);
  const snapshot = policySnapshot(state, now);
  if (itemId !== undefined) return itemFragment(state, itemId, offset, snapshot.generatedAt);
  const dateParts = snapshot.generatedAt.length === 10 ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(snapshot.generatedAt));
  const today = dateParts === null ? snapshot.generatedAt : ['year', 'month', 'day'].map((type) => dateParts.find((part) => part.type === type).value).join('-');
  const priorities = inventoryPlanningPriorities(state, today);
  const accounting = inventoryAccountingContext(state);
  const rows = state.items.slice().sort(priorities.compare);
  if (cursor > rows.length) fail('cursor超出库存列表，请重新读取第一页。');
  const plans = state.plans ?? [];
  const firstPage = cursor === 0;
  // Keep normal pages at 96k. Escaping must not make an otherwise valid full
  // habit collection unreadable or prevent progress through the stock pages.
  const preferencesContext = firstPage ? foodPreferencesContext(state) : null;
  const preferencesContextJsonCharacters = firstPage ? jsonLength(preferencesContext) : 0;
  const charBudget = LIST_BUDGET + Math.max(0, preferencesContextJsonCharacters - PREFERENCES_INCLUDED_BUDGET);
  const statusTotals = Object.fromEntries(STATUSES.map(status => [status, 0]));
  for (const item of rows) statusTotals[item.status === 'available' && item.quantity === 0 ? 'depleted' : item.status]++;
  const lastConfirmedAt = state.items.reduce((latest, item) => item.confirmedAt && (!latest || item.confirmedAt > latest) ? item.confirmedAt : latest, null);
  const base = {
    schemaVersion: 1, responseFormat: 'compact_inventory_v2', format: 'food_inventory_brief_v1', revision: snapshot.revision,
    generatedAt: snapshot.generatedAt, updatedAt: snapshot.updatedAt, lastConfirmedAt,
    quantityMeaning: snapshot.quantityMeaning, quantityExplanation: snapshot.quantityExplanation,
    items: [], indexes: indexes([]), indexScope: 'page',
    total: rows.length, offset: cursor, limit, included: 0, hasMore: cursor < rows.length,
    nextCursor: cursor < rows.length ? String(cursor) : null, charBudget,
    contextIncluded: firstPage, contextRevision: state.revision, requiresFirstPage: !firstPage,
    nutritionReadiness: inventoryReadiness(state.items),
    coverage: { from: cursor, toExclusive: cursor, allItemsIncluded: false, statusTotals, revisionPinned: filters.expectedRevision !== undefined },
    ...(firstPage ? {
    candidateCoverage: priorities.coverage, recentMenuCoverage: priorities.recentMenuCoverage,
    ...(accounting.pendingPlanIds.length ? { inventoryAccountingSummary: { pendingPlanCount: accounting.pendingPlanIds.length, pendingItemCount: accounting.pendingItemCount, instructions: '实物状态与账务待核分开。accountingContext.balanceReliable=false时bookQuantity只是旧账面数，quantity=null不能当无货或0，也不能当精确余量；定向核对原计划，不因保存菜单而锁定实物或补扣旧账。' } } : {}),
    mealPatternReferences: mealPatternContext(state, today),
    ...(state.dailyMenuSettlementPolicy ? { dailyMenuSettlementPolicy: readDailyMenuSettlementPolicy(state) } : {}),
    selectionRules: PLANNING_PRIORITY_RULES.slice(),
    plans: planIndex(plans, today),
    planSummary: { total: plans.length, reserved: plans.filter((plan) => plan.status === 'reserved').length, included: 0, omitted: 0, truncated: false, detailTool: 'read_diet_records', instructions: '仅为有限计划索引；省略不代表未执行。完整菜单、每日完整营养汇总和历史详情使用read_diet_records，可按日期或recordId读取。' },
    ...preferencesContext, contextCharBudget: LIST_BUDGET,
    preferencesJsonCharacters: jsonLength(preferencesContext.preferences), preferencesContextJsonCharacters,
    rules: snapshot.rules.map((rule) => rule
      .replace('depletedItems', 'indexes.depleted').replace('archivedItems', 'indexes.archived').replace('pendingItems', 'indexes.pending')
      .replace('快照 plans 包含最近 14 条及当天和未来仍预留的计划，完整记录保存在库存状态中；快照省略旧计划不代表旧计划未执行。', 'plans仅为有限摘要索引；当天完整菜单和营养使用read_diet_records。完整记录保存在状态中，省略不代表旧计划未执行。')),
    supplementScheduleReference: routineReference(state),
    contextTruncated: false,
    contextSummary: { preferencesTotal: snapshot.preferences.length, preferencesIncluded: snapshot.preferences.length, preferencesOmitted: 0, preferencesTextTruncated: false },
    } : {}),
    instructions: firstPage
      ? '本页完整返回有效preferences、rules及通用补给安排；搭配参考与新鲜度按各自说明使用。contextTruncated=false，习惯从不截短或省略。items是本页唯一食材正文，indexes仅含本页ID；total及coverage.statusTotals描述全库存。hasMore时用nextCursor及revision作为expectedRevision继续，读齐所有页后再从全库存排餐，不得把未返回食材当作没有；续页引用本页上下文，不重复传习惯/时间表/计划索引。nutrition数值、来源、口径单位和gramsPerUnit已完整保留，可直接排餐，无需逐项重读标签。完整nutrition.sourceText未包含，备注/配料/补给成分是有界摘要；textTruncated仅标食材原文省略。只有核实原标签/配方或修改被省略字段时，才用itemId=该食材id、offset=0、expectedRevision=本次revision读取无损JSON。null是未知，不是0。读取不确认、扣减库存或新增实际服用。'
      : '这是库存续页：未重复preferences、rules、通用补给安排或计划索引，不代表没有这些内容。必须结合cursor=0且revision=contextRevision的完整首读上下文；没有首读请先读取cursor=0。coverage只描述当前页范围及全库存各状态数，不能把本页当全库存。hasMore时沿nextCursor及expectedRevision继续；409须从首读重新开始。null为未知；现有数值/来源/单位/gramsPerUnit可直接沿用，仅核实原文或修改省略字段时按itemId读取详情。读取不扣库存。',
  };
  // Complete context is non-negotiable. Reserve progress for the next item,
  // rather than constructing and discarding rich projections of every item.
  const requestedRows = rows.slice(cursor, Math.min(rows.length, cursor + limit)).map(item => itemBrief(item, priorities, accounting));
  const firstRow = requestedRows[0] ?? null;
  if (firstPage) fitContext(base, charBudget - (firstRow ? jsonLength(firstRow) + jsonLength(firstRow.id) + 256 : 0));
  const response = (items) => {
    const next = cursor + items.length;
    return { ...base, items, indexes: indexes(items), included: items.length, hasMore: next < rows.length, nextCursor: next < rows.length ? String(next) : null,
      coverage: { ...base.coverage, toExclusive: next, allItemsIncluded: cursor === 0 && next === rows.length } };
  };
  // An optional old-plan index must not push useful stock onto another page.
  // Encode the requested stock once; only the small context changes while
  // shrinking this index. Full habits, actual combinations and facts stay intact.
  if (firstPage && base.plans.length) {
    const stockCharacters = jsonLength(response(requestedRows)) - jsonLength(response([]));
    while (base.plans.length && jsonLength(response([])) + stockCharacters > charBudget) {
      base.plans.pop(); markContext(base);
    }
  }
  // Count each encoded row once. Only five tiny pagination values change as
  // rows are added; re-encoding the complete context/items for every candidate
  // would turn a 100-item read into quadratic string work.
  const emptyLength = jsonLength(response([]));
  const paginationLength = (count) => {
    const next = cursor + count;
    return jsonLength(count) + jsonLength(next) + jsonLength(next < rows.length)
      + jsonLength(next < rows.length ? String(next) : null) + jsonLength(cursor === 0 && next === rows.length);
  };
  const initialPaginationLength = paginationLength(0);
  const indexCounts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  let itemCharacters = 0, indexCharacters = 0;
  const page = [];
  for (let index = cursor; index < Math.min(rows.length, cursor + limit); index++) {
    const row = requestedRows[index - cursor];
    const status = row.status === 'available' && row.quantity === 0 ? 'depleted' : row.status;
    const rowCharacters = jsonLength(row) + (page.length ? 1 : 0);
    const idCharacters = Object.hasOwn(indexCounts, status) ? jsonLength(row.id) + (indexCounts[status] ? 1 : 0) : 0;
    const candidateLength = emptyLength + itemCharacters + rowCharacters + indexCharacters + idCharacters
      + paginationLength(page.length + 1) - initialPaginationLength;
    if (candidateLength > charBudget) break;
    page.push(row);
    itemCharacters += rowCharacters;
    indexCharacters += idCharacters;
    if (Object.hasOwn(indexCounts, status)) indexCounts[status]++;
  }
  if (!page.length && cursor < rows.length) fail('无法在预算内返回下一项食材。', 500, 'READ_BUDGET_EXCEEDED');
  const result = response(page);
  if (jsonLength(result) > charBudget) fail('库存摘要超过输出预算。', 500, 'READ_BUDGET_EXCEEDED');
  return result;
}
