/** Pure inventory rules shared by the API and the planning snapshot. */

import seedData from './seed-inventory.json' with { type: 'json' };
import { applyDietAction, isDietAction, getSupplementRoutine } from './diet.mjs';
import { applyDietHistoryAction, historyContext } from './diet-history.mjs';
import { isReusableProduct, matchExistingProducts } from './inventory-product-identity.mjs';
import { reconcileFoodInventoryBalance, checkFoodBalanceReconciliationHistory } from './food-balance-reconciliation.mjs';
import { readDailyMenuSettlementPolicy, normalizeDailyMenuSettlementPolicy } from './daily-menu-policy.mjs';

const CATEGORIES = new Set(['prepared', 'vegetable', 'fruit', 'nuts', 'bread', 'dessert', 'condiment', 'protein', 'staple', 'supplement', 'other']);
const UNITS = new Set(['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
const DISCRETE_UNITS = new Set(['袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const STATUSES = new Set(['available', 'depleted', 'archived', 'pending']);
const LOCATIONS = new Set(['冷冻', '冷藏', '常温', '']);
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat'];
const MAX_ITEMS = 400;
const MAX_PLANS = 1000;
const MAX_PLAN_ITEMS = 100;
const MAX_NUMBER = 1_000_000_000;

function fail(message, status = 400, code = 'INVALID_INPUT') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  return value;
}

function string(value, label, max, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') fail(`${label}必须是文字。`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max) fail(`${label}不能为空且不能超过 ${max} 个字符。`);
  return result;
}

function sourceText(value, label, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) fail(`${label}必须是最多 ${max} 个字符的文字。`);
  return value;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function number(value, label, { nullable = false, positive = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_NUMBER) {
    fail(`${label}必须是 0 到 ${MAX_NUMBER} 之间的有限数值${nullable ? '，未知请填 null' : ''}。`);
  }
  const result = round(value);
  if (positive && result <= 0) fail(`${label}必须大于 0（最小精度为 0.000001）。`);
  return result;
}

function timestamp(value, label) {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label}日期无效。`);
    return value;
  }
  if (typeof value !== 'string' || value.length > 50 || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    fail(`${label}必须是带时区的 ISO 日期时间。`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${label}日期时间无效。`);
  return new Date(time).toISOString();
}

function freshnessFacts(value) {
  const facts = object(value, '食物开封与品质资料');
  const allowed = new Set(['opened', 'openedOn', 'bestBeforeDate', 'userConsumeByDate', 'sourceText']);
  if (Reflect.ownKeys(facts).some(key => !allowed.has(key))) fail('食物开封与品质资料包含不支持的字段；不能推算安全期限。');
  if (facts.opened !== undefined && facts.opened !== null && typeof facts.opened !== 'boolean') fail('开封状态必须是布尔值或null。');
  const evidence = sourceText(facts.sourceText, '开封与品质资料的用户或标签原话', 1000);
  if (!evidence.trim()) fail('更新开封或品质日期必须提供用户明确报告或标签原话，不能从旧备注推断。', 400, 'FRESHNESS_SOURCE_REQUIRED');
  const dates = Object.fromEntries(['openedOn', 'bestBeforeDate', 'userConsumeByDate'].map(key => {
    const value = facts[key] ?? null;
    if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value))) fail(`${key}必须是YYYY-MM-DD，未知或清除请用null。`);
    if (value !== null) timestamp(value, key);
    return [key, value];
  }));
  if (facts.opened === false && dates.openedOn !== null) fail('未开封状态不能同时带已开封日期，请核对明确事实。');
  return { opened: facts.opened ?? null, ...dates, sourceText: evidence };
}

function preferences(value) {
  if (!Array.isArray(value) || value.length > 60) fail('饮食习惯必须是最多 60 条的文字列表。');
  return [...new Set(value.map((entry) => string(entry, '饮食习惯', 500)))];
}

function preferenceMetadata(payload, restore = false) {
  const allowed = new Set(['action', 'operationId', 'expectedRevision', 'preferences', 'reason', 'sourceDate', ...(restore ? ['items'] : [])]);
  if (Reflect.ownKeys(payload).some(key => !allowed.has(key))) fail('习惯更新包含不支持的字段；既有版本历史不能由请求覆盖。');
  const reason = sourceText(payload.reason, '习惯修改原因', 1000);
  const sourceDate = payload.sourceDate ?? null;
  if (sourceDate !== null && (typeof sourceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(sourceDate))) fail('习惯来源日期必须是YYYY-MM-DD，未知请留空。');
  if (sourceDate !== null) timestamp(sourceDate, '习惯来源日期');
  return { reason, sourceDate };
}

function patchPreferences(current, payload) {
  const allowed = new Set(['action', 'operationId', 'expectedRevision', 'add', 'replace', 'remove', 'confirmed', 'sourceText', 'reason', 'sourceDate']);
  if (Reflect.ownKeys(payload).some(key => !allowed.has(key))) fail('习惯更新包含不支持的字段；既有版本历史不能由请求覆盖。');
  if (payload.confirmed !== true) fail('只有用户明确表达的长期习惯才能保存，单日菜单调整不能自动变成长期习惯。', 400, 'PREFERENCE_CONFIRMATION_REQUIRED');
  const evidence = sourceText(payload.sourceText, '用户习惯原话', 1000);
  if (!evidence.trim()) fail('保存长期习惯必须附上用户明确表达的原话。', 400, 'PREFERENCE_SOURCE_REQUIRED');
  if (payload.sourceDate === undefined || payload.sourceDate === null) fail('保存长期习惯必须提供用户原话的来源日期（YYYY-MM-DD）。');
  const metadata = { ...preferenceMetadata({ reason: payload.reason, sourceDate: payload.sourceDate }), sourceText: evidence };
  if (!validPreferenceSnapshot(current)) fail('旧习惯超出可留存格式，修改未执行，请先备份并核对。', 409, 'PREFERENCE_HISTORY_REQUIRES_REVIEW');
  const list = (value, label) => {
    const entries = value === undefined ? [] : value;
    if (!Array.isArray(entries) || entries.length > 60) fail(`${label}必须是最多 60 条的列表。`);
    return entries;
  };
  const exactText = (value, label) => {
    if (typeof value !== 'string' || value.length > 500) fail(`${label}必须是最多 500 个字符的原始文字。`);
    return value;
  };
  const additions = list(payload.add, '新增习惯').map(entry => string(entry, '新增习惯', 500));
  const replacements = list(payload.replace, '替换习惯').map(entry => {
    object(entry, '替换习惯');
    if (Reflect.ownKeys(entry).some(key => !['previous', 'next'].includes(key))) fail('替换习惯只能包含 previous 和 next。');
    return { previous: exactText(entry.previous, '被替换的习惯'), next: string(entry.next, '替换后的习惯', 500) };
  });
  const removals = list(payload.remove, '移除习惯').map(entry => exactText(entry, '被移除的习惯'));
  if (!additions.length && !replacements.length && !removals.length) fail('请提供要新增、替换或移除的长期习惯。');
  // Resolve every target against the snapshot the caller read, before applying
  // any changes. A patch must never accidentally target another change in it.
  const targets = new Map();
  for (const previous of [...removals, ...replacements.map(entry => entry.previous)]) {
    if (targets.has(previous)) fail('同一条旧习惯不能重复替换或同时移除，请核对后重试。', 409, 'PREFERENCE_MATCH_CONFLICT');
    const matches = current.flatMap((entry, index) => entry === previous ? [index] : []);
    if (matches.length !== 1) fail('要修改的旧习惯与最新记录不唯一匹配，请读取最新习惯后核对，不要静默覆盖。', 409, 'PREFERENCE_MATCH_CONFLICT');
    targets.set(previous, matches[0]);
  }
  const replacementsByIndex = new Map(replacements.map(entry => [targets.get(entry.previous), entry.next]));
  const removedIndexes = new Set(removals.map(entry => targets.get(entry)));
  const next = current.flatMap((entry, index) => removedIndexes.has(index) ? [] : [replacementsByIndex.get(index) ?? entry]);
  for (const replacement of replacements) {
    if (next.filter(entry => entry === replacement.next).length > 1) fail('替换后的习惯与另一条相同，请明确移除重复旧条目后重试。', 409, 'PREFERENCE_MATCH_CONFLICT');
  }
  for (const addition of additions) if (!next.includes(addition)) next.push(addition);
  if (next.length > 60) fail('饮食习惯最多 60 条，请先合并明确重复的习惯。');
  return { preferences: next, metadata };
}

// History snapshots are evidence: do not trim, deduplicate, normalize or cap them.
function validPreferenceSnapshot(value) {
  return Array.isArray(value) && value.length <= 60 && value.every(entry => typeof entry === 'string' && entry.length <= 500);
}
function checkPreferenceHistory(state) {
  if (state.preferenceHistory === undefined) return;
  const invalid = () => fail('习惯版本历史格式异常，原始数据已保留，请先核对。', 503, 'INVALID_PREFERENCE_HISTORY');
  if (!Array.isArray(state.preferenceHistory)) invalid();
  const seen = new Set();
  let prior = null;
  for (const entry of state.preferenceHistory) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.operationId !== 'string' || !entry.operationId.trim() || entry.operationId.length > 100 || seen.has(entry.operationId)
      || !['preferences', 'restore'].includes(entry.action)
      || !Number.isSafeInteger(entry.revisionBefore) || entry.revisionBefore < 0
      || entry.revisionAfter !== entry.revisionBefore + 1 || entry.revisionAfter > state.revision
      || !validPreferenceSnapshot(entry.previous) || !validPreferenceSnapshot(entry.next)
      || typeof entry.reason !== 'string' || entry.reason.length > 1000
      || (entry.sourceText !== undefined && (typeof entry.sourceText !== 'string' || !entry.sourceText.trim() || entry.sourceText.length > 1000))
      || typeof entry.fingerprint !== 'string' || !/^v1:[a-f\d]{32}$/.test(entry.fingerprint)
      || !Number.isSafeInteger(entry.fingerprintLength) || entry.fingerprintLength < 0) invalid();
    try {
      timestamp(entry.at, '习惯修改时间');
      if (entry.sourceDate !== null) {
        if (typeof entry.sourceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(entry.sourceDate)) invalid();
        timestamp(entry.sourceDate, '习惯来源日期');
      }
    } catch { invalid(); }
    if (prior && (prior.revisionAfter > entry.revisionBefore || JSON.stringify(prior.next) !== JSON.stringify(entry.previous))) invalid();
    seen.add(entry.operationId); prior = entry;
  }
  if (prior && JSON.stringify(prior.next) !== JSON.stringify(state.preferences)) invalid();
}

function checkPreferenceOperationReceipts(state) {
  if (state.preferenceOperationReceipts === undefined) return;
  const invalid = () => fail('习惯操作回执格式异常，原始数据已保留，请先核对。', 503, 'INVALID_PREFERENCE_OPERATION_RECEIPTS');
  if (!Array.isArray(state.preferenceOperationReceipts)) invalid();
  const seen = new Set((state.preferenceHistory ?? []).map(entry => entry.operationId));
  let prior = null;
  for (const entry of state.preferenceOperationReceipts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.operationId !== 'string' || !entry.operationId.trim() || entry.operationId.length > 100 || seen.has(entry.operationId)
      || entry.action !== 'patch_preferences' || entry.noChange !== true
      || !Number.isSafeInteger(entry.revisionBefore) || entry.revisionBefore < 0
      || entry.revisionAfter !== entry.revisionBefore + 1 || entry.revisionAfter > state.revision
      || typeof entry.reason !== 'string' || entry.reason.length > 1000
      || typeof entry.sourceText !== 'string' || !entry.sourceText.trim() || entry.sourceText.length > 1000
      || typeof entry.sourceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(entry.sourceDate)
      || typeof entry.fingerprint !== 'string' || !/^v1:[a-f\d]{32}$/.test(entry.fingerprint)
      || !Number.isSafeInteger(entry.fingerprintLength) || entry.fingerprintLength < 0
      || (prior && prior.revisionAfter > entry.revisionBefore)) invalid();
    try { timestamp(entry.at, '习惯操作时间'); timestamp(entry.sourceDate, '习惯来源日期'); } catch { invalid(); }
    seen.add(entry.operationId); prior = entry;
  }
}

function id(value, label = '食材 ID') {
  return string(value, label, 100);
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `food-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

// Stable JSON identity is independent of object key order and retry revision.
// Keep only a small synchronous 128-bit hash and the encoded length in storage;
// photographed labels and source text must not be duplicated in the retry ledger.
function mutationFingerprint(payload) {
  const { operationId: _operationId, expectedRevision: _expectedRevision, ...content } = payload;
  const encoded = JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let index = 0; index < encoded.length; index++) {
    const char = encoded.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ char, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ char, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ char, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ char, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return { fingerprint: `v1:${[h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1].map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('')}`, fingerprintLength: encoded.length };
}

/**
 * Missing nutrition stays unknown. Quantity must be explicitly supplied: null
 * means "present, amount unknown" and is never coerced to zero.
 */
export function validateItem(raw, now = new Date().toISOString()) {
  object(raw, '食材');
  const at = timestamp(now, '更新时间');
  const name = string(raw.name, '食材名称', 120);
  let aliases;
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases) || raw.aliases.length > 20) fail('商品别名必须是最多 20 条的文字列表。');
    aliases = [...new Set(raw.aliases.map(value => string(value, '商品别名', 120)))];
  }
  if (!CATEGORIES.has(raw.category)) fail('请选择有效的食材分类。');
  if (!UNITS.has(raw.unit)) fail('食材单位必须是 g、ml、袋、个、片、份、包、罐、条、粒或滴。');
  const quantity = number(raw.quantity, '库存数量', { nullable: true });
  if (raw.status !== undefined && !STATUSES.has(raw.status)) fail('库存状态无效。');
  if (raw.priority !== undefined && typeof raw.priority !== 'boolean') fail('优先食用必须是布尔值。');
  if (raw.location !== undefined && !LOCATIONS.has(raw.location)) fail('存放位置必须是冷冻、冷藏、常温或空白。');

  const rawNutrition = raw.nutrition === undefined ? {} : object(raw.nutrition, '营养数据');
  const basisUnit = rawNutrition.basisUnit === undefined ? raw.unit : rawNutrition.basisUnit;
  if (!UNITS.has(basisUnit)) fail('营养口径单位必须是 g、ml、袋、个、片、份、包、罐、条、粒或滴。');
  const basisAmount = number(rawNutrition.basisAmount === undefined ? (DISCRETE_UNITS.has(basisUnit) ? 1 : 100) : rawNutrition.basisAmount, '营养口径数量', { positive: true });
  const source = rawNutrition.source === undefined ? 'unknown' : rawNutrition.source;
  if (!SOURCES.has(source)) fail('营养来源必须是标签、配方、估算或未知。');
  const rawSources = rawNutrition.nutrientSources === undefined ? {} : object(rawNutrition.nutrientSources, '各项营养来源');
  if (Object.keys(rawSources).some((key) => !NUTRIENTS.includes(key))) fail('各项营养来源只支持 kcal、protein、carbs、fat。');
  for (const key of NUTRIENTS) if (rawSources[key] !== undefined && !SOURCES.has(rawSources[key])) fail(`${key} 的营养来源无效。`);
  const values = Object.fromEntries(NUTRIENTS.map((key) => [key, number(rawNutrition[key] ?? null, key, { nullable: true })]));
  const nutrientSources = Object.fromEntries(NUTRIENTS.map((key) => [key, values[key] === null ? 'unknown' : rawSources[key] ?? source]));
  const knownSources = new Set(NUTRIENTS.filter((key) => values[key] !== null).map((key) => nutrientSources[key]));
  const effectiveSource = knownSources.size === 1 ? [...knownSources][0] : knownSources.has('estimate') ? 'estimate' : 'unknown';
  const rawNote = string(rawNutrition.sourceNote, '营养来源说明', 1000, { optional: true });
  const baseNote = rawNote.replace(/\n?\[字段来源\][^\n]*$/, '');
  const mixedNote = knownSources.size > 1 ? `[字段来源] ${NUTRIENTS.filter((key) => values[key] !== null).map((key) => `${key}=${nutrientSources[key]}`).join(', ')}；未确认来源不升级为标签。` : '';
  const nutrition = {
    basisAmount,
    basisUnit,
    ...values,
    source: effectiveSource,
    nutrientSources,
    sourceNote: string([baseNote, mixedNote].filter(Boolean).join('\n'), '营养来源说明（含混合来源提示）', 1000, { optional: true }),
    sourceText: sourceText(rawNutrition.sourceText, '营养标签或估算来源原文', 16_000),
  };

  return {
    id: raw.id === undefined ? createId() : id(raw.id),
    name,
    ...(aliases === undefined ? {} : { aliases }),
    brand: string(raw.brand, '品牌', 120, { optional: true }),
    category: raw.category,
    ...(raw.freshness === undefined ? {} : { freshness: freshnessFacts(raw.freshness) }),
    quantity,
    unit: raw.unit,
    location: raw.location ?? '',
    nutrition,
    gramsPerUnit: raw.gramsPerUnit === undefined || raw.gramsPerUnit === null
      ? null : number(raw.gramsPerUnit, '每单位克重', { positive: true }),
    priority: raw.priority ?? false,
    notes: string(raw.notes, '备注', 2000, { optional: true }),
    ingredients: sourceText(raw.ingredients, '配料表原文', 12_000),
    supplementFacts: sourceText(raw.supplementFacts, '补给成分与剂量原文', 12_000),
    confirmedAt: timestamp(raw.confirmedAt === undefined ? at : raw.confirmedAt, '库存确认时间'),
    updatedAt: timestamp(raw.updatedAt === undefined ? at : raw.updatedAt, '食材更新时间'),
    quantityBaselineToken: raw.quantityBaselineToken === undefined
      ? timestamp(raw.confirmedAt === undefined ? at : raw.confirmedAt, '库存确认时间')
      : string(raw.quantityBaselineToken, '库存校准标记', 200),
    status: raw.status === 'archived' || raw.status === 'pending' ? raw.status : quantity === 0 ? 'depleted' : 'available',
  };
}

export function seedState() {
  const state = structuredClone(seedData);
  checkState(state);
  return { ...state, items: state.items.map((entry) => validateItem(entry, state.updatedAt)), preferences: preferences(state.preferences), plans: state.plans ?? [] };
}

function checkState(state) {
  object(state, '库存状态');
  if (state.schemaVersion !== 1) fail('库存数据版本不受支持。');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER) fail('库存版本号无效。');
  if (!Array.isArray(state.items) || state.items.length > MAX_ITEMS) fail(`库存最多保存 ${MAX_ITEMS} 项。`);
  if (!Array.isArray(state.events) || !Array.isArray(state.operationIds)) fail('库存操作记录无效。');
  if (state.eventHistory !== undefined && !Array.isArray(state.eventHistory)) fail('归档更新记录格式异常，原始数据已保留。', 503, 'INVALID_EVENT_HISTORY');
  if (!Array.isArray(state.preferences)) fail('饮食习惯数据无效。');
  checkPreferenceHistory(state);
  checkPreferenceOperationReceipts(state);
  checkFoodBalanceReconciliationHistory(state);
  if (state.dietHistory !== undefined && (!Array.isArray(state.dietHistory) || state.dietHistory.length > 1000)) fail('历史饮食最多保存1000条。');
  if (state.plans !== undefined && (!Array.isArray(state.plans) || state.plans.length > MAX_PLANS)) fail(`最多保留 ${MAX_PLANS} 条计划记录，请先备份并整理。`);
}

function amountText(item) {
  return item.quantity === null ? '余量未知' : `${item.quantity} ${item.unit}`;
}

function baselineToken(item) {
  return item.quantityBaselineToken ?? item.confirmedAt ?? 'initial';
}

function planContent(rawPlan) {
  const title = string(rawPlan.title, '计划名称', 120);
  if (typeof rawPlan.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(rawPlan.date)) fail('计划日期必须是 YYYY-MM-DD。');
  const date = timestamp(rawPlan.date, '计划日期');
  const notes = string(rawPlan.notes, '计划备注', 2000, { optional: true });
  if (!Array.isArray(rawPlan.items) || !rawPlan.items.length || rawPlan.items.length > MAX_PLAN_ITEMS) fail(`计划必须包含 1 到 ${MAX_PLAN_ITEMS} 行食材用量。`);
  const amounts = new Map();
  for (const rawLine of rawPlan.items) {
    object(rawLine, '计划用量');
    const itemId = id(rawLine.itemId);
    const quantity = number(rawLine.quantity, '计划用量', { positive: true });
    // Integer millionths keep aggregation independent of input row order.
    const total = (amounts.get(itemId) ?? 0) + Math.round(quantity * 1_000_000);
    number(total / 1_000_000, '同一食材总用量', { positive: true });
    amounts.set(itemId, total);
  }
  const items = [...amounts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([itemId, quantity]) => ({ itemId, quantity: quantity / 1_000_000 }));
  return { title, date, notes, items };
}

/** Apply one confirmed change. Planning and reads never pass through here. */
export function applyMutation(state, payload, now = new Date().toISOString()) {
  checkState(state);
  object(payload, '操作');
  const operationId = id(payload.operationId, '操作 ID');
  // A retry is successful even when its original expectedRevision is now stale.
  const previousOperation = state.operationIds.find((operation) => operation.id === operationId)
    ?? state.preferenceHistory?.find((entry) => entry.operationId === operationId)
    ?? state.preferenceOperationReceipts?.find((entry) => entry.operationId === operationId)
    ?? state.inventoryReconciliationHistory?.find((entry) => entry.operationId === operationId);
  if (previousOperation) {
    if (previousOperation.fingerprint) {
      const incoming = mutationFingerprint(payload);
      if (incoming.fingerprint !== previousOperation.fingerprint || incoming.fingerprintLength !== previousOperation.fingerprintLength) {
        fail('这个操作 ID 已保存过不同内容，请读取最新记录，核对后使用新的操作 ID。', 409, 'OPERATION_ID_CONFLICT');
      }
    }
    return state;
  }
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) fail('操作必须携带有效的库存版本号。');
  if (payload.expectedRevision !== state.revision) {
    fail('库存已在其他页面更新，请刷新最新库存后重试。', 409, 'REVISION_CONFLICT');
  }
  const at = timestamp(now, '操作时间');
  const fingerprint = mutationFingerprint(payload);
  let items = state.items.slice();
  let nextPreferences = state.preferences.slice();
  let preferenceHistory = state.preferenceHistory;
  let inventoryReconciliationHistory = state.inventoryReconciliationHistory;
  let preferenceChangeMetadata;
  let plans = (state.plans ?? []).slice();
  let dietHistory = state.dietHistory;
  let supplementRoutine = state.supplementRoutine;
  let detail;
  let itemId;
  let freshnessAudit;
  let dailyMenuSettlementPolicy = state.dailyMenuSettlementPolicy;
  const findItem = () => {
    const targetId = id(payload.id);
    const index = items.findIndex((entry) => entry.id === targetId);
    if (index === -1) fail('找不到这项食材，请刷新库存。', 404, 'ITEM_NOT_FOUND');
    itemId = targetId;
    return { index, current: items[index] };
  };

  const legacyMealCancellation = payload.action === 'cancel_plan' && plans.some((plan) => plan.id === payload.planId && plan.format === 'meals_v1');
  const effectiveAction = legacyMealCancellation ? 'cancel_meal_plan' : payload.action === 'patch_preferences' ? 'preferences' : payload.action;
  if (effectiveAction === 'commit_plan' && (state.dietHistory ?? []).some(record => record.id === payload.plan?.id)) fail('历史存档ID不能转入库存预留。', 409, 'HISTORY_ISOLATED');
  if (effectiveAction === 'import_diet_history') {
    const result = applyDietHistoryAction(state, payload, at);
    if (result.noChange) return state;
    dietHistory = result.dietHistory;
    detail = result.detail;
  } else if (isDietAction(effectiveAction)) {
    const targetPlanId = effectiveAction === 'save_meal_plan_draft' ? payload.plan?.id : payload.planId;
    if ((state.dietHistory ?? []).some(record => record.id === targetPlanId)) fail('历史存档不能转入库存结算；请使用历史导入更正工具。', 409, 'HISTORY_ISOLATED');
    const result = applyDietAction(state, { ...payload, action: effectiveAction }, at);
    if (result.noChange) return state;
    items = result.items;
    plans = result.plans;
    if (result.supplementRoutine !== undefined) supplementRoutine = result.supplementRoutine;
    detail = result.detail;
  } else switch (payload.action) {
    case 'reconcile_food_inventory': {
      const result = reconcileFoodInventoryBalance(state, payload, at);
      items = result.items; plans = result.plans; itemId = payload.itemId; detail = result.detail;
      inventoryReconciliationHistory = [...(state.inventoryReconciliationHistory ?? []), { ...result.historyEntry, ...fingerprint }];
      break;
    }
    case 'set_daily_menu_settlement_policy': {
      const previous = readDailyMenuSettlementPolicy(state);
      const policy = normalizeDailyMenuSettlementPolicy(payload, previous, at);
      if (previous && previous.enabled === policy.enabled && previous.startsOn === policy.startsOn && previous.timeZone === policy.timeZone) return state;
      dailyMenuSettlementPolicy = policy;
      detail = policy.enabled ? '已开启每日00:00按前一天最新菜单结算；个人勾选不影响库存。' : '已关闭日终自动结算；原记录和库存账务保留。';
      break;
    }
    case 'upsert': {
      const patch = object(payload.item, '食材');
      const recordId = patch.id === undefined ? createId() : id(patch.id);
      const index = items.findIndex((value) => value.id === recordId);
      const current = index === -1 ? null : items[index];
      const nutritionPatch = patch.nutrition === undefined ? undefined : object(patch.nutrition, '营养数据');
      const freshnessPatch = patch.freshness === undefined ? undefined : object(patch.freshness, '食物开封与品质资料');
      if (freshnessPatch !== undefined && (typeof freshnessPatch.sourceText !== 'string' || !freshnessPatch.sourceText.trim())) fail('更新开封或品质日期必须附上本次用户明确报告或标签原话。', 400, 'FRESHNESS_SOURCE_REQUIRED');
      const mergedFreshness = freshnessPatch === undefined ? current?.freshness : { ...current?.freshness, ...freshnessPatch };
      let mergedNutrition = nutritionPatch === undefined ? current?.nutrition : { ...current?.nutrition, ...nutritionPatch };
      if (current && nutritionPatch !== undefined) {
        const patchSources = nutritionPatch.nutrientSources === undefined ? {} : object(nutritionPatch.nutrientSources, '各项营养来源');
        if (Object.keys(patchSources).some((key) => !NUTRIENTS.includes(key))) fail('各项营养来源只支持 kcal、protein、carbs、fat。');
        for (const key of NUTRIENTS) if (patchSources[key] !== undefined && !SOURCES.has(patchSources[key])) fail(`${key} 的营养来源无效。`);
        mergedNutrition = { ...mergedNutrition, nutrientSources: Object.fromEntries(NUTRIENTS.map((key) => {
          const oldSource = current.nutrition[key] === null ? 'unknown' : current.nutrition.nutrientSources?.[key] ?? current.nutrition.source;
          return [key, Object.hasOwn(nutritionPatch, key) ? patchSources[key] ?? nutritionPatch.source ?? oldSource : oldSource];
        })) };
      }
      // Updating a label is not a recount. Omitted top-level and nutrition
      // fields inherit their old values; explicit null retains "unknown".
      const entry = validateItem({ ...current, ...patch, id: recordId,
        nutrition: mergedNutrition,
        ...(mergedFreshness === undefined ? {} : { freshness: mergedFreshness }),
        confirmedAt: current?.confirmedAt ?? at, updatedAt: at,
      }, at);
      if (entry.quantity === 0 && entry.status !== 'archived') entry.status = 'depleted';
      const stockChanged = !current || current.quantity !== entry.quantity || current.unit !== entry.unit;
      if (current && !stockChanged && (patch.status === undefined || patch.status === current.status)) entry.status = current.status;
      if (stockChanged || (current && entry.status !== current.status)) entry.confirmedAt = at;
      entry.quantityBaselineToken = stockChanged
        ? `${operationId}@${at}` : baselineToken(current);
      if (index === -1) {
        const duplicates = matchExistingProducts(items, entry);
        if (duplicates.length) {
          const candidates = duplicates.map(({ id, name, status, quantity, unit }) => ({ id, name, status, quantity, unit }));
          throw Object.assign(new Error(`已有相同商品记录，请复用原 ID 更新资料或补货，不要再新建：${candidates.map(value => `${value.name}（ID: ${value.id}）`).join('；')}。备餐新批次请单独记录。`), { status: 409, code: 'DUPLICATE_PRODUCT', candidates });
        }
        if (items.length >= MAX_ITEMS) fail(`库存最多保存 ${MAX_ITEMS} 项，请先整理已有食材。`);
        items.push(entry);
      } else items[index] = entry;
      itemId = entry.id;
      if (freshnessPatch !== undefined && JSON.stringify(current?.freshness ?? null) !== JSON.stringify(entry.freshness ?? null)) {
        freshnessAudit = { freshnessBefore: structuredClone(current?.freshness ?? null), freshnessAfter: structuredClone(entry.freshness ?? null) };
      }
      detail = `${index === -1 ? '新增' : stockChanged ? '更新库存' : '更新资料'}：${entry.name}（${amountText(entry)}）。${current && !stockChanged ? '未重新盘点余量。' : ''}`;
      break;
    }
    case 'restock': {
      const targetId = id(payload.itemId);
      const index = items.findIndex(entry => entry.id === targetId);
      if (index === -1) fail('找不到要补货的商品，请读取最新库存。', 404, 'ITEM_NOT_FOUND');
      const current = items[index];
      if (!isReusableProduct(current)) fail('备餐或配方批次不能复用旧批次补货，请为新制作批次建立独立记录。', 400, 'BATCH_REQUIRES_NEW_ITEM');
      const quantity = number(payload.quantity, '补货后当前可用总量', { nullable: true });
      itemId = targetId;
      // Opening/quality facts belong to the previous purchase, not the product
      // label reused for a new purchase. Keep the old evidence in the audit.
      const { freshness: previousFreshness, ...product } = current;
      if (previousFreshness !== undefined) freshnessAudit = { freshnessBefore: structuredClone(previousFreshness), freshnessAfter: null };
      items[index] = { ...product, quantity, status: quantity === 0 ? 'depleted' : 'available',
        quantityBaselineToken: `${operationId}@${at}`, confirmedAt: at, updatedAt: at };
      detail = `复用商品补货：${current.name}，当前可用总量${quantity === null ? '已确认有货，余量未知' : `${quantity} ${current.unit}`}。保留原营养标签；这是当前总量，不与旧余量累加。`;
      break;
    }
    case 'consume': {
      const { index, current } = findItem();
      const quantity = number(payload.quantity, '实际食用量', { positive: true });
      const note = string(payload.note, '食用备注', 500, { optional: true });
      if (payload.outsidePlan !== true && plans.some((plan) => plan.format === 'meals_v1' && ['draft', 'reserved'].includes(plan.status) && (plan.accountedDebits?.some((line) => line.itemId === current.id) || plan.meals?.some(meal => meal.plannedItems?.some(line => line.itemId === current.id)) || plan.draft?.meals?.some(meal => meal.plannedItems?.some(line => line.itemId === current.id))))) {
        fail('这项食材已在分餐菜单中，请关联原餐次记录实际摄入，避免同时consume和餐次报告重复扣减。明确属于菜单以外的额外食用时，才可标记outsidePlan=true。', 409, 'MEAL_INTAKE_REQUIRED');
      }
      if (current.status === 'archived' || current.status === 'pending') fail('已归档或待核对食材不能直接扣减，请先确认库存。');
      if (current.quantity === null) fail('这项食材余量未知，请先确认当前余量，再记录实际食用量。', 400, 'UNKNOWN_QUANTITY');
      if (quantity > current.quantity) fail('实际食用量超过当前库存，请先核对余量。', 400, 'INSUFFICIENT_STOCK');
      const remaining = round(current.quantity - quantity);
      items[index] = { ...current, quantity: remaining, status: remaining === 0 ? 'depleted' : 'available', quantityBaselineToken: baselineToken(current), confirmedAt: at, updatedAt: at };
      detail = `实际食用：${current.name} ${quantity} ${current.unit}，剩余 ${remaining} ${current.unit}。${note ? ` 备注：${note}` : ''}`;
      break;
    }
    case 'set_quantity': {
      const { index, current } = findItem();
      const quantity = number(payload.quantity, '库存数量', { nullable: true });
      const entry = { ...current, quantity, status: quantity === 0 ? 'depleted' : ['archived', 'pending'].includes(current.status) ? current.status : 'available', quantityBaselineToken: `${operationId}@${at}`, confirmedAt: at, updatedAt: at };
      items[index] = entry;
      detail = `确认余量：${entry.name}（${amountText(entry)}）。`;
      break;
    }
    case 'archive': {
      const { index, current } = findItem();
      items[index] = { ...current, status: 'archived', quantityBaselineToken: baselineToken(current), confirmedAt: at, updatedAt: at };
      detail = `归档食材：${current.name}。`;
      break;
    }
    case 'preferences':
      preferenceChangeMetadata = preferenceMetadata(payload);
      nextPreferences = preferences(payload.preferences);
      if (JSON.stringify(nextPreferences) === JSON.stringify(state.preferences)) return state;
      detail = `更新长期饮食习惯，共 ${nextPreferences.length} 条。`;
      break;
    case 'patch_preferences': {
      const patch = patchPreferences(state.preferences, payload);
      preferenceChangeMetadata = patch.metadata;
      nextPreferences = patch.preferences;
      if (JSON.stringify(nextPreferences) === JSON.stringify(state.preferences)) {
        // Even a duplicate-add request needs a durable identity: after a later
        // user correction, a delayed retry must not restore the old habit.
        // Receipt persistence changes only the state revision, not habit history.
        const receipt = { operationId, action: 'patch_preferences', at, revisionBefore: state.revision, revisionAfter: state.revision + 1,
          noChange: true, ...preferenceChangeMetadata, ...fingerprint };
        return { ...state, revision: state.revision + 1, updatedAt: at,
          preferenceOperationReceipts: [...(state.preferenceOperationReceipts ?? []), receipt],
          operationIds: [...state.operationIds, { id: operationId, at, ...fingerprint }].slice(-1000) };
      }
      detail = `增量更新长期饮食习惯，共 ${nextPreferences.length} 条。`;
      break;
    }
    case 'commit_plan': {
      if (payload.confirmed !== true) fail('只有用户敲定最终版后，才能确认并预留计划用量。', 400, 'PLAN_CONFIRMATION_REQUIRED');
      const rawPlan = object(payload.plan, '饮食计划');
      const planId = id(rawPlan.id, '计划 ID');
      const existing = plans.find((entry) => entry.id === planId);
      if (existing?.format === 'meals_v1') fail('这是分餐饮食计划，请使用确认分餐或修改未吃餐次的工具，不要用旧版整日菜单覆盖。', 409, 'MEAL_PLAN_ACTION_REQUIRED');
      if (existing && existing.status !== 'reserved') fail('这份计划已经取消，不能再次扣减；请使用新的计划 ID。', 409, 'PLAN_ALREADY_CANCELLED');
      const content = planContent(rawPlan);
      if (existing) {
        if (JSON.stringify(content) === JSON.stringify(planContent(existing))) return state;
        fail('同一计划 ID 已确认过不同内容。请先取消旧计划，再使用新的计划 ID 确认修改后的菜单。', 409, 'PLAN_ID_CONFLICT');
      }
      fail('新的每日菜单请使用save_food_plan_draft按餐保存；菜单立即显示且不预留或扣库存，只有实际进食报告才结算。旧平铺菜单仍保留原账与重试记录。', 409, 'STRUCTURED_PLAN_REQUIRED');
    }
    case 'cancel_plan': {
      if (payload.confirmed !== true) fail('取消计划并退回用量需要用户明确确认。', 400, 'PLAN_CONFIRMATION_REQUIRED');
      const planId = id(payload.planId, '计划 ID');
      const planIndex = plans.findIndex((entry) => entry.id === planId);
      if (planIndex === -1) fail('找不到这份饮食计划。', 404, 'PLAN_NOT_FOUND');
      const plan = plans[planIndex];
      if (plan.status === 'cancelled') return state;
      if (plan.status !== 'reserved') fail('只有已预留的计划可以退回用量。');
      // Check all refunds first. Never add an old count to a changed unit.
      for (const line of plan.items) {
        if (line.unknownQuantity) continue;
        const current = items.find((entry) => entry.id === line.itemId);
        if (!current) fail('计划中的食材已被移除，请先恢复或核对库存再取消。', 409, 'REFUND_REQUIRES_REVIEW');
        if (baselineToken(current) !== line.baselineToken) fail('这项食材在确认菜单后已重新盘点，不能自动加回旧用量；请手动校准库存。', 409, 'REFUND_REQUIRES_REVIEW');
        if (current.unit !== line.unit) fail('计划中的食材单位已改变，请先核对库存，不能自动退回旧单位用量。', 409, 'REFUND_REQUIRES_REVIEW');
        if (current.quantity !== null) number(round(current.quantity + line.quantity), '退回后的库存数量');
      }
      const byId = new Map(plan.items.map((entry) => [entry.itemId, entry]));
      items = items.map((current) => {
        const line = byId.get(current.id);
        if (!line || line.unknownQuantity) return current;
        const quantity = current.quantity === null ? null : round(current.quantity + line.quantity);
        const status = ['archived', 'pending'].includes(current.status) ? current.status : quantity === 0 ? 'depleted' : 'available';
        return { ...current, quantity, status, quantityBaselineToken: baselineToken(current), confirmedAt: at, updatedAt: at };
      });
      plans[planIndex] = { ...plan, status: 'cancelled', updatedAt: at };
      detail = `取消饮食计划并退回已知的预留用量：${plan.title}。未知余量仍保持未知。`;
      break;
    }
    case 'restore': {
      preferenceChangeMetadata = preferenceMetadata(payload, true);
      if (plans.some((plan) => plan.status === 'reserved')) fail('已有确认菜单，请逐项校准库存；导入不会覆盖已扣减记录。', 409, 'RESTORE_REQUIRES_REVIEW');
      if (!Array.isArray(payload.items) || payload.items.length > MAX_ITEMS) fail(`导入库存必须是最多 ${MAX_ITEMS} 项的列表。`);
      items = payload.items.map((entry) => ({ ...validateItem(entry, at), quantityBaselineToken: `${operationId}@${at}` }));
      if (new Set(items.map((entry) => entry.id)).size !== items.length) fail('导入库存包含重复的食材 ID。');
      nextPreferences = preferences(payload.preferences);
      detail = `导入库存备份：${items.length} 项食材、${nextPreferences.length} 条饮食习惯。`;
      break;
    }
    default:
      fail('不支持的库存操作。');
  }

  if (JSON.stringify(nextPreferences) !== JSON.stringify(state.preferences)) {
    if (!validPreferenceSnapshot(state.preferences)) fail('旧习惯超出可留存格式，修改未执行，请先备份并核对。', 409, 'PREFERENCE_HISTORY_REQUIRES_REVIEW');
    preferenceHistory = [...(preferenceHistory ?? []), {
      operationId, at, action: effectiveAction, revisionBefore: state.revision, revisionAfter: state.revision + 1,
      previous: state.preferences.slice(), next: nextPreferences.slice(), ...preferenceChangeMetadata, ...fingerprint,
    }];
  }

  const allEvents = [...state.events, { id: operationId, action: effectiveAction, at, ...(itemId ? { itemId } : {}), ...(freshnessAudit ?? {}), detail }];
  const archivedEvents = allEvents.slice(0, Math.max(0, allEvents.length - 100));
  // Keep recent-page compatibility without discarding any displaced original event.
  const eventHistory = archivedEvents.length ? [...(state.eventHistory ?? []), ...archivedEvents.map(entry => structuredClone(entry))] : state.eventHistory;

  return {
    ...state,
    ...(dailyMenuSettlementPolicy === undefined ? {} : { dailyMenuSettlementPolicy }),
    schemaVersion: 1,
    revision: state.revision + 1,
    updatedAt: at,
    items,
    events: allEvents.slice(-100),
    ...(eventHistory === undefined ? {} : { eventHistory }),
    plans,
    ...(dietHistory === undefined ? {} : { dietHistory }),
    ...(supplementRoutine === undefined ? {} : { supplementRoutine }),
    preferences: nextPreferences,
    ...(preferenceHistory === undefined ? {} : { preferenceHistory }),
    ...(inventoryReconciliationHistory === undefined ? {} : { inventoryReconciliationHistory }),
    operationIds: [...state.operationIds, { id: operationId, at, ...fingerprint }].slice(-1000),
  };
}

function nutritionFactor(item) {
  if (item.quantity === null) return null;
  const basis = item.nutrition;
  if (item.unit === basis.basisUnit) return item.quantity / basis.basisAmount;
  if (!item.gramsPerUnit) return null;
  if (DISCRETE_UNITS.has(item.unit) && basis.basisUnit === 'g') return item.quantity * item.gramsPerUnit / basis.basisAmount;
  if (item.unit === 'g' && DISCRETE_UNITS.has(basis.basisUnit)) return item.quantity / item.gramsPerUnit / basis.basisAmount;
  // ml is volume: even with gramsPerUnit present it cannot imply a density.
  return null;
}

function planningItem(item) {
  const supplement = item.category === 'supplement';
  const nutrientSources = Object.fromEntries(NUTRIENTS.map((key) => [key, item.nutrition[key] === null ? 'unknown' : item.nutrition.nutrientSources?.[key] ?? item.nutrition.source]));
  const perBasis = { ...item.nutrition, nutrientSources };
  const missingNutrients = NUTRIENTS.filter((key) => perBasis[key] === null);
  const factor = nutritionFactor(item);
  const knownCount = NUTRIENTS.length - missingNutrients.length;
  const remainingNutrition = factor === null || knownCount === 0 ? null : Object.fromEntries(
    NUTRIENTS.map((key) => [key, perBasis[key] === null ? null : round(perBasis[key] * factor)]),
  );
  const issues = [];
  if (item.quantity === null) issues.push('余量未知，不能计算全部剩余营养。');
  if (!supplement && knownCount === 0) issues.push('热量和三大营养素尚未录入，不得补猜。');
  else if (!supplement && missingNutrients.length) issues.push(`缺少营养数据：${missingNutrients.join('、')}。`);
  if (item.quantity !== null && factor === null && (!supplement || knownCount > 0)) issues.push('库存单位与营养口径无法可靠换算。');
  if (NUTRIENTS.some((key) => perBasis[key] !== null && nutrientSources[key] === 'estimate')) issues.push('营养数据含估算，排餐时应明确标记。');
  if (NUTRIENTS.some((key) => perBasis[key] !== null && nutrientSources[key] === 'unknown')) issues.push('部分营养数值的来源尚未确认。');
  return {
    ...item,
    nutrition: { ...item.nutrition, nutrientSources: { ...nutrientSources } },
    perBasis,
    remainingNutrition,
    nutritionReadiness: {
      status: supplement ? 'not_required' : knownCount === 0 ? 'missing' : missingNutrients.length ? 'partial' : 'complete',
      required: !supplement,
      missingNutrients: supplement ? [] : missingNutrients,
      ...(supplement ? { optionalMissingNutrients: missingNutrients } : {}),
      canCalculateRemaining: remainingNutrition !== null,
      issues,
    },
  };
}

function supplementScheduleReference(state) {
  const routine = getSupplementRoutine(state);
  if (!routine) return null;
  const sourcePlan = (state.plans ?? []).find(plan => plan.id === routine.sourcePlanId);
  const result = {
    sourcePlanId: routine.sourcePlanId, date: sourcePlan?.date ?? null, updatedAt: routine.updatedAt,
    routineSource: state.supplementRoutine ? 'saved' : 'derived',
    instructions: '这是每天通用的补给时间表，不代表今天已服；没有三餐菜单也可按日期查看和明确勾选，浏览日期不新增记录或扣库存。排新一天须结合训练/休息日和用户要求；可选/按需不是每日强制，不因拥有就安排全吃，标签待核不猜剂量。同一天沿用稳定且唯一的dose.id，不得复制来源日的勾选、实际条目或实际时间。若当天已有supplementOnly记录，先read_diet_records读取canonical计划ID，再复用同ID保存三餐草稿并确认，不另建第二份账。',
    total: routine.supplementDoses.length, included: 0, truncated: false, textTruncated: false, doses: [],
  };
  const shorten = (value, max) => {
    const original = typeof value === 'string' ? value : '';
    if (original.length > max) result.textTruncated = true;
    return original.slice(0, max);
  };
  for (const dose of routine.supplementDoses.slice(0, 32)) {
    const requirement = dose.requirement ?? 'daily';
    const row = {
      id: dose.id, itemId: dose.itemId,
      name: shorten(dose.nutritionSnapshot?.name ?? state.items.find(item => item.id === dose.itemId)?.name, 160),
      plannedQuantity: dose.plannedQuantity ?? null, unit: dose.unit,
      timingSlot: dose.timingSlot ?? 'other', requirement,
      scheduled: dose.scheduled ?? requirement === 'daily', trainingDayOnly: dose.trainingDayOnly ?? false,
      plannedMealId: dose.plannedMealId ?? null, plannedTime: dose.plannedTime ?? null,
      plannedTimeText: shorten(dose.plannedTimeText, 160), instruction: shorten(dose.instruction, 300), sourceText: shorten(dose.sourceText, 300),
    };
    let candidate = { ...result, doses: [...result.doses, row], included: result.doses.length + 1 };
    if (JSON.stringify(candidate).length > 10000) {
      row.plannedTimeText = ''; row.instruction = ''; row.sourceText = ''; row.name = shorten(row.name, 60);
      result.textTruncated = true;
      candidate = { ...result, doses: [...result.doses, row], included: result.doses.length + 1 };
    }
    if (JSON.stringify(candidate).length > 10000) break;
    result.doses.push(row);
  }
  result.included = result.doses.length;
  result.truncated = result.included < result.total || result.textTruncated;
  return result;
}

/** A freshly read, non-mutating inventory document for the meal planner. */
export function planningSnapshot(state, now = new Date().toISOString()) {
  checkState(state);
  const items = state.items.map(planningItem);
  const availableItems = items.filter((entry) => entry.status === 'available' && entry.quantity !== 0);
  const depletedItems = items.filter((entry) => entry.status === 'depleted');
  const confirmedTimes = items.map((entry) => entry.confirmedAt).filter(Boolean).sort();
  const generatedAt = timestamp(now, '快照生成时间');
  const dateParts = generatedAt.length === 10 ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(generatedAt));
  const today = dateParts === null ? generatedAt : ['year', 'month', 'day'].map((type) => dateParts.find((part) => part.type === type).value).join('-');
  const allPlans = state.plans ?? [];
  const recentPlanIds = new Set(allPlans.slice(-14).map((entry) => entry.id));
  const visiblePlans = allPlans.filter((entry) => recentPlanIds.has(entry.id) || (entry.status === 'reserved' && entry.date >= today));
  const historicalRecords = historyContext(state, today); const historicalTodayCount = (state.dietHistory ?? []).filter(record => record.date === today).length;
  return {
    schemaVersion: 1,
    revision: state.revision,
    generatedAt,
    quantityMeaning: 'remaining_after_actual_and_legacy_credits',
    quantityExplanation: '新菜单只按明确实际摄入结算，保存、采用和改餐不预扣；quantity为当前账面余量，旧版预扣credits原样保留并在实际结算时抵扣，不重复扣。status=reserved是兼容采用标记，不证明已吃。',
    updatedAt: state.updatedAt,
    lastConfirmedAt: confirmedTimes.at(-1) ?? null,
    items,
    availableItems,
    depletedItems,
    archivedItems: items.filter((entry) => entry.status === 'archived'),
    pendingItems: items.filter((entry) => entry.status === 'pending'),
    plans: visiblePlans.map((plan) => ({ ...plan, items: plan.items.map((line) => ({ ...line })) })),
    planSummary: { total: allPlans.length, reserved: allPlans.filter((plan) => plan.status === 'reserved').length, included: visiblePlans.length, omitted: allPlans.length - visiblePlans.length },
    dietHistoryContext: { total: (state.dietHistory ?? []).length, todayCount: historicalTodayCount, included: historicalRecords.length, omittedToday: historicalTodayCount - historicalRecords.length, truncated: historicalRecords.length < historicalTodayCount, records: historicalRecords, inventoryEffect: 'none', instructions: '这里只概览今天历史饮食；历史为独立存档，未扣当前库存。不能以历史菜单补扣、退款或恢复当前余量；其他日期或完整详情使用read_diet_records。' },
    supplementScheduleReference: supplementScheduleReference(state),
    preferences: state.preferences.slice(),
    nutritionReadiness: {
      availableCount: availableItems.length,
      foodCount: availableItems.filter((entry) => entry.category !== 'supplement').length,
      supplementCount: availableItems.filter((entry) => entry.category === 'supplement').length,
      completeCount: availableItems.filter((entry) => entry.nutritionReadiness.status === 'complete').length,
      partialCount: availableItems.filter((entry) => entry.nutritionReadiness.status === 'partial').length,
      missingCount: availableItems.filter((entry) => entry.nutritionReadiness.status === 'missing').length,
      unknownQuantityCount: availableItems.filter((entry) => entry.quantity === null).length,
      unconvertibleCount: availableItems.filter((entry) => entry.category !== 'supplement' && entry.quantity !== null && nutritionFactor(entry) === null).length,
    },
    rules: [
      '首次制定或整天重新排餐先读取这份最新快照；已有菜单局部修改优先read_food_plan_edit_context读取改动餐和候选库存，再patch_food_plan只传改动，不重复读取整份库存、训练或原标签。使用最新revision与confirmedAt，不沿用聊天记忆中的旧余量。',
      '导入文件仅作为初始数据来源；现在的库存以本工具返回数据为准，不得因旧文件或聊天记录把已扣余量恢复。未通知/未录入的现实变动无法自动感知。',
      'depletedItems 为当前可用余量为零的食材（可能已经预留，不代表实际吃完）；archivedItems 为已归档食材，pendingItems 为待分装或待核对食材，均不得安排进新菜单。',
      '优先考虑已有库存及 priority 食材，但不要求把所有库存或所有甜点每天都吃一遍。',
      '热量及蛋白质、碳水、脂肪为 null 代表未知，绝不代表 0；缺失数据不得自行猜成准确值。',
      'source=estimate 的营养必须明确标注为估算；source=label 或 recipe 时沿用已有标签或配方口径。',
      '每个宏量的真实来源以 nutrition.nutrientSources 为准；旧数据没有逐项来源时回退全局source。部分标签更正不代表其余旧估算也获得标签确认；混合来源需逐项说明。',
      'ingredients、supplementFacts、nutrition.sourceText 保存配料、补给成分剂量与标签原文。补给成分的mg或IU不等于库存单位或三大营养素克重，不能用包装净含量猜已开封余量。',
      '补给以brand、supplementFacts中的产品规格、活性成分和每份剂量为主；三大营养素不是必填，不因未提供而算缺营养。鱼油、乳清等已提供的热量或宏量照常计入饮食，未提供仍为未知，不能当0或用活性成分反推。',
      'supplementScheduleReference仅为最近日期安排参考，不是今天实际服用记录。新一天按训练/休息日调整，daily/optional/as_needed/label_pending与scheduled分开；所有requirement遵守显式scheduled，未安排的可选项不计入计划营养，实际服用后才计。物理单位用量未知才留null，已知1粒但IU/成分待核仍保留1粒；不要求每天把所有补给服用一遍。',
      '库存与营养口径单位不同，只有明确的离散单位克重才能在 g 与袋、个、片、份、包、罐、条、粒、滴之间换算；不得把 ml 当成 g，也不能用活性成分mg推算整粒或每滴克重。无法可靠换算时不推算营养。',
      '备餐按具体配方和批次使用已有营养，注意记录的生重、熟重口径，不能把不同批次或生熟口径混合。',
      '余量未知的食材可以作为候选，但不能断言库存足够；需要确定用量时先确认。',
      '最新工作流程优先于旧习惯里“确认菜单即扣库存”的旧条款：save_food_plan_draft保存即显示，采用和修改菜单也不预扣；用户明确报告吃完才record_meal_intake，可逐餐或meals数组一次全天。',
      '同日期必须沿用canonical planId和稳定meal/line/dose ID，补给实际独立，不能隐藏或清空菜单；重试沿用operationId，实际更正沿用entryId按差量结算。',
      '旧历史accountedDebits保留为原预扣credits，读取、保存、采用和编辑均不回滚或重新扣减；实际完成按原账抵扣差量，基线重新盘点不自动退款。reserved不证明已吃，未知余量不伪造。',
      '快照 plans 包含最近 14 条及当天和未来仍预留的计划，完整记录保存在库存状态中；快照省略旧计划不代表旧计划未执行。',
      '习惯与当日要求要区分；一次性的口味或搭配要求不自动写成长期习惯。',
    ],
  };
}
