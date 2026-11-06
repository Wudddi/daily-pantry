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
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a nonnegative safe integer.`);
  return value;
}

function readFilters(filters, revision) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail("Read parameters must be an object.");
  if (Reflect.ownKeys(filters).some((key) => !FILTER_KEYS.has(key))) fail("Read parameters contain unknown fields.");
  if (filters.expectedRevision !== undefined) {
    nonnegativeInteger(filters.expectedRevision, 'expectedRevision');
    if (filters.expectedRevision !== revision) fail("The inventory revision changed. Read the first page again before requesting more pages or details.", 409, 'REVISION_CONFLICT');
  }
  const limit = filters.limit === undefined ? 100 : filters.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("limit must be an integer from 1 to 100.");
  let cursor = filters.cursor === undefined ? 0 : filters.cursor;
  if (typeof cursor === 'string') {
    if (!/^(0|[1-9]\d*)$/.test(cursor)) fail("Invalid cursor. Use the previously returned nextCursor.");
    cursor = Number(cursor);
  }
  nonnegativeInteger(cursor, 'cursor');
  if (cursor > 0 && filters.expectedRevision === undefined) fail("Inventory continuation pages require the first page's revision as expectedRevision. Restart from page one to avoid mixing preferences and inventory from different revisions.", 409, 'REVISION_REQUIRED');
  if (filters.itemId !== undefined) {
    if (typeof filters.itemId !== 'string' || !filters.itemId.trim() || filters.itemId.length > 100) fail("itemId must be a valid food item ID.");
    if (filters.cursor !== undefined || filters.limit !== undefined) fail("Food details cannot be combined with list cursor or limit.");
  } else if (filters.offset !== undefined) fail("offset must be used with itemId.");
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
  for (const [field, max] of [['notes', 180], ['ingredients', 80], ['supplementFacts', 400]]) {
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
  if (jsonLength(base) > budget) fail("Complete preferences, rules, and the supplement routine exceed the read budget. No incomplete preferences were returned, and original text was not deleted or truncated. Review and organize lengthy active preferences or schedules in the app before reading again; do not ignore preferences and continue planning.", 413, 'PLANNING_CONTEXT_TOO_LARGE');
}

/** Validate the original collection bounds before asking the canonical policy
 * reader for an empty projection. Never materialise its rich items or history. */
function policySnapshot(state, now) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail("Inventory state must be an object.", 400, 'INVALID_INPUT');
  if (!Array.isArray(state.items) || state.items.length > 400) fail("Inventory supports at most 400 items.", 400, 'INVALID_INPUT');
  if (state.plans !== undefined && (!Array.isArray(state.plans) || state.plans.length > 1000)) fail("Invalid plan data format or count.", 400, 'INVALID_INPUT');
  if (state.dietHistory !== undefined && (!Array.isArray(state.dietHistory) || state.dietHistory.length > 1000)) fail("Invalid historical diet data format or count.", 400, 'INVALID_INPUT');
  if (!Array.isArray(state.preferences) || state.preferences.length > 60 || state.preferences.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) fail("Preferences must contain at most 60 complete text entries, each no longer than 500 characters.", 400, 'INVALID_INPUT');
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
  if (routine.supplementDoses.length > 32) fail("The supplement routine exceeds 32 doses. Review the complete routine first.", 400, 'INVALID_SUPPLEMENT_ROUTINE');
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
    instructions: "Routine is planning, not today's intake. Reuse dose.id and canonical day planId, even without meals. Respect training days, requirements and scheduled; optional is not mandatory. Never guess counts/weights or copy actuals/times/checkmarks. No second daily account.",
  };
}

function itemFragment(state, itemId, offset, generatedAt) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) fail("Food item not found. Read the inventory list again.", 404, 'ITEM_NOT_FOUND');
  const text = JSON.stringify(item);
  if (offset > text.length) fail("offset exceeds the food item's JSON text length.");
  const response = (end) => ({
    schemaVersion: 1, responseFormat: 'compact_inventory_v2', format: 'inventory_item_json', revision: state.revision, generatedAt,
    itemId, encoding: 'json_text', offset, totalCharacters: text.length,
    text: text.slice(offset, end), nextOffset: end < text.length ? end : null,
    complete: end === text.length, truncated: end < text.length, charBudget: DETAIL_BUDGET,
    instructions: "Continue with nextOffset and this revision as expectedRevision. Concatenate all text by offset, then JSON.parse to restore the full original food item. One chunk is not a complete label or recipe. Reading does not change inventory.",
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
  if (jsonLength(result) > DETAIL_BUDGET || (offset < text.length && low === offset)) fail("The food detail chunk cannot fit within the read budget.", 500, 'READ_BUDGET_EXCEEDED');
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
  if (cursor > rows.length) fail("cursor is outside the inventory list. Read the first page again.");
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
    ...(accounting.pendingPlanIds.length ? { inventoryAccountingSummary: { pendingPlanCount: accounting.pendingPlanIds.length, pendingItemCount: accounting.pendingItemCount, instructions: "Physical availability and pending accounting are separate. When accountingContext.balanceReliable=false, bookQuantity is only an old book balance. quantity=null means neither unavailable nor zero, and is not an exact remaining balance. Review the specific original plan; saving a menu must not lock physical stock or deduct old accounts." } } : {}),
    mealPatternReferences: mealPatternContext(state, today),
    ...(state.dailyMenuSettlementPolicy ? { dailyMenuSettlementPolicy: readDailyMenuSettlementPolicy(state) } : {}),
    selectionRules: PLANNING_PRIORITY_RULES.slice(),
    plans: planIndex(plans, today),
    planSummary: { total: plans.length, reserved: plans.filter((plan) => plan.status === 'reserved').length, included: 0, omitted: 0, truncated: false, detailTool: 'read_diet_records', instructions: "Limited plan index; omission does not mean unexecuted. Full menus/nutrition/history: read_diet_records by date/recordId." },
    ...preferencesContext, contextCharBudget: LIST_BUDGET,
    preferencesJsonCharacters: jsonLength(preferencesContext.preferences), preferencesContextJsonCharacters,
    rules: snapshot.rules.map((rule) => rule
      .replace('depletedItems', 'indexes.depleted').replace('archivedItems', 'indexes.archived').replace('pendingItems', 'indexes.pending')
      .replace("The plans snapshot includes the latest 14 records plus current-day and future reserved plans. Complete records remain in inventory state; an omitted old plan is not evidence that it was not executed.", "plans is a limited index; omitted does not mean unexecuted. Full menus/nutrition: read_diet_records.")),
    supplementScheduleReference: routineReference(state),
    contextTruncated: false,
    contextSummary: { preferencesTotal: snapshot.preferences.length, preferencesIncluded: snapshot.preferences.length, preferencesOmitted: 0, preferencesTextTruncated: false },
    } : {}),
    instructions: firstPage
      ? "Page one supplies complete preferences/rules/routine (contextTruncated=false). items/indexes are page-local; counts are global. Read every page using nextCursor and expectedRevision; unreturned is not absent. Continuations reuse this context. Nutrition values/sources/units/gramsPerUnit are complete; prose is bounded. textTruncated marks omitted prose, available losslessly by itemId/offset/revision for evidence checks or edits. null is unknown, not zero. Reads never adopt, deduct, or record intake."
      : "Continuation: reuse complete cursor=0 context at revision=contextRevision; omitted preferences/rules/routine/index still apply. Read page one if unavailable. coverage distinguishes page range/global counts. Continue with nextCursor/expectedRevision; restart after 409. null is unknown. Reuse nutrition sources/units/gramsPerUnit; fetch itemId details only for source checks or omitted-field edits. Reads never deduct stock.",
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
  if (!page.length && cursor < rows.length) fail("The next food item cannot fit within the read budget.", 500, 'READ_BUDGET_EXCEEDED');
  const result = response(page);
  if (jsonLength(result) > charBudget) fail("The inventory summary exceeds the output budget.", 500, 'READ_BUDGET_EXCEEDED');
  return result;
}
