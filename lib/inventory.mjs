/** Pure inventory rules shared by the API and the planning snapshot. */

import { unitLabel } from './english-display.mjs';
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function string(value, label, max, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max) fail(`${label} must not be empty or exceed ${max} characters.`);
  return result;
}

function sourceText(value, label, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be text with at most ${max} characters.`);
  return value;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function number(value, label, { nullable = false, positive = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_NUMBER) {
    fail(`${label} must be a finite number from 0 to ${MAX_NUMBER} inclusive${nullable ? "; use null for unknown" : ''}.`);
  }
  const result = round(value);
  if (positive && result <= 0) fail(`${label} must be greater than 0 (minimum precision: 0.000001).`);
  return result;
}

function timestamp(value, label) {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label}Invalid date.`);
    return value;
  }
  if (typeof value !== 'string' || value.length > 50 || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    fail(`${label} must be an ISO date-time with timezone.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${label}Invalid date-time.`);
  return new Date(time).toISOString();
}

function freshnessFacts(value) {
  const facts = object(value, "Food opening and quality facts");
  const allowed = new Set(['opened', 'openedOn', 'bestBeforeDate', 'userConsumeByDate', 'sourceText']);
  if (Reflect.ownKeys(facts).some(key => !allowed.has(key))) fail("Food opening and quality data contains unsupported fields. Do not infer safety deadlines.");
  if (facts.opened !== undefined && facts.opened !== null && typeof facts.opened !== 'boolean') fail("Opened status must be a boolean or null.");
  const evidence = sourceText(facts.sourceText, "User or label source text for opening and quality facts", 1000);
  if (!evidence.trim()) fail("Opening or quality-date updates require explicit user or label source text. Do not infer from old notes.", 400, 'FRESHNESS_SOURCE_REQUIRED');
  const dates = Object.fromEntries(['openedOn', 'bestBeforeDate', 'userConsumeByDate'].map(key => {
    const value = facts[key] ?? null;
    if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value))) fail(`${key} must use YYYY-MM-DD. Use null for unknown or to clear it.`);
    if (value !== null) timestamp(value, key);
    return [key, value];
  }));
  if (facts.opened === false && dates.openedOn !== null) fail("An unopened item cannot also have an opening date. Review the explicit facts.");
  return { opened: facts.opened ?? null, ...dates, sourceText: evidence };
}

function preferences(value) {
  if (!Array.isArray(value) || value.length > 60) fail("Preferences must be a text list with at most 60 entries.");
  return [...new Set(value.map((entry) => string(entry, "Meal preference", 500)))];
}

function preferenceMetadata(payload, restore = false) {
  const allowed = new Set(['action', 'operationId', 'expectedRevision', 'preferences', 'reason', 'sourceDate', ...(restore ? ['items'] : [])]);
  if (Reflect.ownKeys(payload).some(key => !allowed.has(key))) fail("The preference update contains unsupported fields. Requests cannot overwrite existing version history.");
  const reason = sourceText(payload.reason, "Preference change reason", 1000);
  const sourceDate = payload.sourceDate ?? null;
  if (sourceDate !== null && (typeof sourceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(sourceDate))) fail("Preference source date must use YYYY-MM-DD. Leave unknown dates blank.");
  if (sourceDate !== null) timestamp(sourceDate, "Preference source date");
  return { reason, sourceDate };
}

function patchPreferences(current, payload) {
  const allowed = new Set(['action', 'operationId', 'expectedRevision', 'add', 'replace', 'remove', 'confirmed', 'sourceText', 'reason', 'sourceDate']);
  if (Reflect.ownKeys(payload).some(key => !allowed.has(key))) fail("The preference update contains unsupported fields. Requests cannot overwrite existing version history.");
  if (payload.confirmed !== true) fail("Only continuing preferences explicitly expressed by the user may be saved. A single-day menu edit must not automatically become a continuing preference.", 400, 'PREFERENCE_CONFIRMATION_REQUIRED');
  const evidence = sourceText(payload.sourceText, "User preference source text", 1000);
  if (!evidence.trim()) fail("Saving a continuing preference requires the user's explicit source text.", 400, 'PREFERENCE_SOURCE_REQUIRED');
  if (payload.sourceDate === undefined || payload.sourceDate === null) fail("Saving a continuing preference requires the source date of the user's statement (YYYY-MM-DD).");
  const metadata = { ...preferenceMetadata({ reason: payload.reason, sourceDate: payload.sourceDate }), sourceText: evidence };
  if (!validPreferenceSnapshot(current)) fail("Existing preferences exceed the preservable format. No edit was made; back up and review them first.", 409, 'PREFERENCE_HISTORY_REQUIRES_REVIEW');
  const list = (value, label) => {
    const entries = value === undefined ? [] : value;
    if (!Array.isArray(entries) || entries.length > 60) fail(`${label} must be a list with at most 60 entries.`);
    return entries;
  };
  const exactText = (value, label) => {
    if (typeof value !== 'string' || value.length > 500) fail(`${label} must be original text with at most 500 characters.`);
    return value;
  };
  const additions = list(payload.add, "Added preferences").map(entry => string(entry, "Added preferences", 500));
  const replacements = list(payload.replace, "Replaced preferences").map(entry => {
    object(entry, "Replaced preferences");
    if (Reflect.ownKeys(entry).some(key => !['previous', 'next'].includes(key))) fail("A preference replacement supports previous and next only.");
    return { previous: exactText(entry.previous, "Previous preference"), next: string(entry.next, "Replacement preference", 500) };
  });
  const removals = list(payload.remove, "Removed preferences").map(entry => exactText(entry, "Preference to remove"));
  if (!additions.length && !replacements.length && !removals.length) fail("Provide continuing preferences to add, replace, or remove.");
  // Resolve every target against the snapshot the caller read, before applying
  // any changes. A patch must never accidentally target another change in it.
  const targets = new Map();
  for (const previous of [...removals, ...replacements.map(entry => entry.previous)]) {
    if (targets.has(previous)) fail("The same old preference cannot be replaced twice or also removed. Review and retry.", 409, 'PREFERENCE_MATCH_CONFLICT');
    const matches = current.flatMap((entry, index) => entry === previous ? [index] : []);
    if (matches.length !== 1) fail("The old preference does not match exactly one current entry. Read the latest preferences and review them; do not silently overwrite.", 409, 'PREFERENCE_MATCH_CONFLICT');
    targets.set(previous, matches[0]);
  }
  const replacementsByIndex = new Map(replacements.map(entry => [targets.get(entry.previous), entry.next]));
  const removedIndexes = new Set(removals.map(entry => targets.get(entry)));
  const next = current.flatMap((entry, index) => removedIndexes.has(index) ? [] : [replacementsByIndex.get(index) ?? entry]);
  for (const replacement of replacements) {
    if (next.filter(entry => entry === replacement.next).length > 1) fail("The replacement preference duplicates another entry. Explicitly remove the duplicate old entry before retrying.", 409, 'PREFERENCE_MATCH_CONFLICT');
  }
  for (const addition of additions) if (!next.includes(addition)) next.push(addition);
  if (next.length > 60) fail("Preferences support at most 60 entries. Merge explicitly duplicate preferences first.");
  return { preferences: next, metadata };
}

// History snapshots are evidence: do not trim, deduplicate, normalize or cap them.
function validPreferenceSnapshot(value) {
  return Array.isArray(value) && value.length <= 60 && value.every(entry => typeof entry === 'string' && entry.length <= 500);
}
function checkPreferenceHistory(state) {
  if (state.preferenceHistory === undefined) return;
  const invalid = () => fail("Preference version history has an invalid format. Original data was preserved. Review it first.", 503, 'INVALID_PREFERENCE_HISTORY');
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
      timestamp(entry.at, "Preference edit time");
      if (entry.sourceDate !== null) {
        if (typeof entry.sourceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(entry.sourceDate)) invalid();
        timestamp(entry.sourceDate, "Preference source date");
      }
    } catch { invalid(); }
    if (prior && (prior.revisionAfter > entry.revisionBefore || JSON.stringify(prior.next) !== JSON.stringify(entry.previous))) invalid();
    seen.add(entry.operationId); prior = entry;
  }
  if (prior && JSON.stringify(prior.next) !== JSON.stringify(state.preferences)) invalid();
}

function checkPreferenceOperationReceipts(state) {
  if (state.preferenceOperationReceipts === undefined) return;
  const invalid = () => fail("The preference operation receipt has an invalid format. Original data was preserved. Review it first.", 503, 'INVALID_PREFERENCE_OPERATION_RECEIPTS');
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
    try { timestamp(entry.at, "Preference operation time"); timestamp(entry.sourceDate, "Preference source date"); } catch { invalid(); }
    seen.add(entry.operationId); prior = entry;
  }
}

function id(value, label = "Food item ID") {
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
  object(raw, "Food item");
  const at = timestamp(now, "Update time");
  const name = string(raw.name, "Food item name", 120);
  let aliases;
  if (raw.aliases !== undefined) {
    if (!Array.isArray(raw.aliases) || raw.aliases.length > 20) fail("Product aliases must be a text list with at most 20 entries.");
    aliases = [...new Set(raw.aliases.map(value => string(value, "Product alias", 120)))];
  }
  if (!CATEGORIES.has(raw.category)) fail("Select a valid food category.");
  if (!UNITS.has(raw.unit)) fail("Food units must be g, mL, bags, items, slices, servings, packs, cans, pieces, tablets, or drops (using the saved inventory unit identifiers).");
  const quantity = number(raw.quantity, "Inventory quantity", { nullable: true });
  if (raw.status !== undefined && !STATUSES.has(raw.status)) fail("Invalid inventory status.");
  if (raw.priority !== undefined && typeof raw.priority !== 'boolean') fail("Priority status must be a boolean.");
  if (raw.location !== undefined && !LOCATIONS.has(raw.location)) fail("Storage must be frozen, refrigerated, room temperature, or blank (using the saved storage identifiers).");

  const rawNutrition = raw.nutrition === undefined ? {} : object(raw.nutrition, "Nutrition data");
  const basisUnit = rawNutrition.basisUnit === undefined ? raw.unit : rawNutrition.basisUnit;
  if (!UNITS.has(basisUnit)) fail("Nutrition basis units must be g, mL, bags, items, slices, servings, packs, cans, pieces, tablets, or drops (using the saved unit identifiers).");
  const basisAmount = number(rawNutrition.basisAmount === undefined ? (DISCRETE_UNITS.has(basisUnit) ? 1 : 100) : rawNutrition.basisAmount, "Nutrition basis quantity", { positive: true });
  const source = rawNutrition.source === undefined ? 'unknown' : rawNutrition.source;
  if (!SOURCES.has(source)) fail("Nutrition source must be label, recipe, estimate, or unknown.");
  const rawSources = rawNutrition.nutrientSources === undefined ? {} : object(rawNutrition.nutrientSources, "Per-nutrient sources");
  if (Object.keys(rawSources).some((key) => !NUTRIENTS.includes(key))) fail("Per-nutrient sources support kcal, protein, carbs, and fat only.");
  for (const key of NUTRIENTS) if (rawSources[key] !== undefined && !SOURCES.has(rawSources[key])) fail(`${key} has an invalid nutrition source.`);
  const values = Object.fromEntries(NUTRIENTS.map((key) => [key, number(rawNutrition[key] ?? null, key, { nullable: true })]));
  const nutrientSources = Object.fromEntries(NUTRIENTS.map((key) => [key, values[key] === null ? 'unknown' : rawSources[key] ?? source]));
  const knownSources = new Set(NUTRIENTS.filter((key) => values[key] !== null).map((key) => nutrientSources[key]));
  const effectiveSource = knownSources.size === 1 ? [...knownSources][0] : knownSources.has('estimate') ? 'estimate' : 'unknown';
  const rawNote = string(rawNutrition.sourceNote, "Nutrition source note", 1000, { optional: true });
  const baseNote = rawNote.replace(/\n?\[(?:字段来源|Field sources)\][^\n]*$/, '');
  const mixedNote = knownSources.size > 1 ? `[Field sources] ${NUTRIENTS.filter((key) => values[key] !== null).map((key) => `${key}=${nutrientSources[key]}`).join(', ')}; unconfirmed sources are not upgraded to label.` : '';
  const nutrition = {
    basisAmount,
    basisUnit,
    ...values,
    source: effectiveSource,
    nutrientSources,
    sourceNote: string([baseNote, mixedNote].filter(Boolean).join('\n'), "Nutrition source note (including mixed-source notice)", 1000, { optional: true }),
    sourceText: sourceText(rawNutrition.sourceText, "Nutrition label or estimate source text", 16_000),
  };

  return {
    id: raw.id === undefined ? createId() : id(raw.id),
    name,
    ...(aliases === undefined ? {} : { aliases }),
    brand: string(raw.brand, "Brand", 120, { optional: true }),
    category: raw.category,
    ...(raw.freshness === undefined ? {} : { freshness: freshnessFacts(raw.freshness) }),
    quantity,
    unit: raw.unit,
    location: raw.location ?? '',
    nutrition,
    gramsPerUnit: raw.gramsPerUnit === undefined || raw.gramsPerUnit === null
      ? null : number(raw.gramsPerUnit, "Grams per unit", { positive: true }),
    priority: raw.priority ?? false,
    notes: string(raw.notes, "Notes", 2000, { optional: true }),
    ingredients: sourceText(raw.ingredients, "Ingredient list source text", 12_000),
    supplementFacts: sourceText(raw.supplementFacts, "Supplement ingredients and dosage source text", 12_000),
    confirmedAt: timestamp(raw.confirmedAt === undefined ? at : raw.confirmedAt, "Inventory confirmation time"),
    updatedAt: timestamp(raw.updatedAt === undefined ? at : raw.updatedAt, "Food update time"),
    quantityBaselineToken: raw.quantityBaselineToken === undefined
      ? timestamp(raw.confirmedAt === undefined ? at : raw.confirmedAt, "Inventory confirmation time")
      : string(raw.quantityBaselineToken, "Inventory calibration marker", 200),
    ...(raw.quantityBaselineAt === undefined ? {} : { quantityBaselineAt: timestamp(raw.quantityBaselineAt, "Inventory count time") }),
    ...(raw.quantityBaselineSource === undefined ? {} : { quantityBaselineSource: (() => {
      if (!['initial', 'upsert', 'set_quantity', 'restock', 'restore', 'reconcile_food_inventory'].includes(raw.quantityBaselineSource)) fail("Invalid inventory count source.");
      return raw.quantityBaselineSource;
    })() }),
    status: raw.status === 'archived' || raw.status === 'pending' ? raw.status : quantity === 0 ? 'depleted' : 'available',
  };
}

export function seedState() {
  const state = structuredClone(seedData);
  checkState(state);
  return { ...state, items: state.items.map((entry) => validateItem(entry, state.updatedAt)), preferences: preferences(state.preferences), plans: state.plans ?? [] };
}

function checkState(state) {
  object(state, "Inventory state");
  if (state.schemaVersion !== 1) fail("Unsupported inventory data schema version.");
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER) fail("Invalid inventory revision.");
  if (!Array.isArray(state.items) || state.items.length > MAX_ITEMS) fail(`Inventory supports at most ${MAX_ITEMS} items.`);
  if (!Array.isArray(state.events) || !Array.isArray(state.operationIds)) fail("Invalid inventory operation records.");
  if (state.eventHistory !== undefined && !Array.isArray(state.eventHistory)) fail("Archived update records have an invalid format. Original data was preserved.", 503, 'INVALID_EVENT_HISTORY');
  if (!Array.isArray(state.preferences)) fail("Invalid meal preference data.");
  checkPreferenceHistory(state);
  checkPreferenceOperationReceipts(state);
  checkFoodBalanceReconciliationHistory(state);
  if (state.dietHistory !== undefined && (!Array.isArray(state.dietHistory) || state.dietHistory.length > 1000)) fail("Historical diet supports at most 1000 records.");
  if (state.plans !== undefined && (!Array.isArray(state.plans) || state.plans.length > MAX_PLANS)) fail(`The limit is ${MAX_PLANS} plan records. Back up and organize records first.`);
}

function amountText(item) {
  return item.quantity === null ? "Remaining quantity unknown" : `${item.quantity} ${unitLabel(item.unit, item.quantity)}`;
}

function baselineToken(item) {
  return item.quantityBaselineToken ?? item.confirmedAt ?? 'initial';
}

function planContent(rawPlan) {
  const title = string(rawPlan.title, "Plan name", 120);
  if (typeof rawPlan.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(rawPlan.date)) fail("Plan date must use YYYY-MM-DD.");
  const date = timestamp(rawPlan.date, "Plan date");
  const notes = string(rawPlan.notes, "Plan notes", 2000, { optional: true });
  if (!Array.isArray(rawPlan.items) || !rawPlan.items.length || rawPlan.items.length > MAX_PLAN_ITEMS) fail(`The plan must contain 1 to ${MAX_PLAN_ITEMS} food quantity lines.`);
  const amounts = new Map();
  for (const rawLine of rawPlan.items) {
    object(rawLine, "Planned quantity");
    const itemId = id(rawLine.itemId);
    const quantity = number(rawLine.quantity, "Planned quantity", { positive: true });
    // Integer millionths keep aggregation independent of input row order.
    const total = (amounts.get(itemId) ?? 0) + Math.round(quantity * 1_000_000);
    number(total / 1_000_000, "Total quantity for the same food", { positive: true });
    amounts.set(itemId, total);
  }
  const items = [...amounts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([itemId, quantity]) => ({ itemId, quantity: quantity / 1_000_000 }));
  return { title, date, notes, items };
}

/** Apply one confirmed change. Planning and reads never pass through here. */
export function applyMutation(state, payload, now = new Date().toISOString()) {
  checkState(state);
  object(payload, "Action");
  const operationId = id(payload.operationId, "Operation ID");
  // A retry is successful even when its original expectedRevision is now stale.
  const previousOperation = state.operationIds.find((operation) => operation.id === operationId)
    ?? state.preferenceHistory?.find((entry) => entry.operationId === operationId)
    ?? state.preferenceOperationReceipts?.find((entry) => entry.operationId === operationId)
    ?? state.inventoryReconciliationHistory?.find((entry) => entry.operationId === operationId);
  if (previousOperation) {
    if (previousOperation.fingerprint) {
      const incoming = mutationFingerprint(payload);
      if (incoming.fingerprint !== previousOperation.fingerprint || incoming.fingerprintLength !== previousOperation.fingerprintLength) {
        fail("This operation ID was saved with different content. Read the latest records, review them, and use a new operation ID.", 409, 'OPERATION_ID_CONFLICT');
      }
    }
    return state;
  }
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) fail("The operation requires a valid inventory revision.");
  if (payload.expectedRevision !== state.revision) {
    fail("Inventory changed in another page. Refresh the latest inventory and retry.", 409, 'REVISION_CONFLICT');
  }
  const at = timestamp(now, "Operation time");
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
    if (index === -1) fail("Food item not found. Refresh inventory.", 404, 'ITEM_NOT_FOUND');
    itemId = targetId;
    return { index, current: items[index] };
  };

  const legacyMealCancellation = payload.action === 'cancel_plan' && plans.some((plan) => plan.id === payload.planId && plan.format === 'meals_v1');
  const effectiveAction = legacyMealCancellation ? 'cancel_meal_plan' : payload.action === 'patch_preferences' ? 'preferences' : payload.action;
  if (effectiveAction === 'commit_plan' && (state.dietHistory ?? []).some(record => record.id === payload.plan?.id)) fail("Historical archive IDs cannot become inventory reservations.", 409, 'HISTORY_ISOLATED');
  if (effectiveAction === 'import_diet_history') {
    const result = applyDietHistoryAction(state, payload, at);
    if (result.noChange) return state;
    dietHistory = result.dietHistory;
    detail = result.detail;
  } else if (isDietAction(effectiveAction)) {
    const targetPlanId = effectiveAction === 'save_meal_plan_draft' ? payload.plan?.id : payload.planId;
    if ((state.dietHistory ?? []).some(record => record.id === targetPlanId)) fail("Historical archives cannot become inventory settlements. Use the historical import/correction tools.", 409, 'HISTORY_ISOLATED');
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
      detail = policy.enabled ? "Daily midnight settlement from the previous day's latest menu is enabled. Personal checkmarks do not affect inventory." : "End-of-day automatic settlement is disabled. Original records and inventory accounts were preserved.";
      break;
    }
    case 'upsert': {
      const patch = object(payload.item, "Food item");
      const recordId = patch.id === undefined ? createId() : id(patch.id);
      const index = items.findIndex((value) => value.id === recordId);
      const current = index === -1 ? null : items[index];
      const nutritionPatch = patch.nutrition === undefined ? undefined : object(patch.nutrition, "Nutrition data");
      const freshnessPatch = patch.freshness === undefined ? undefined : object(patch.freshness, "Food opening and quality facts");
      if (freshnessPatch !== undefined && (typeof freshnessPatch.sourceText !== 'string' || !freshnessPatch.sourceText.trim())) fail("Opening or quality-date updates require the user's explicit statement or label source text for this update.", 400, 'FRESHNESS_SOURCE_REQUIRED');
      const mergedFreshness = freshnessPatch === undefined ? current?.freshness : { ...current?.freshness, ...freshnessPatch };
      let mergedNutrition = nutritionPatch === undefined ? current?.nutrition : { ...current?.nutrition, ...nutritionPatch };
      if (current && nutritionPatch !== undefined) {
        const patchSources = nutritionPatch.nutrientSources === undefined ? {} : object(nutritionPatch.nutrientSources, "Per-nutrient sources");
        if (Object.keys(patchSources).some((key) => !NUTRIENTS.includes(key))) fail("Per-nutrient sources support kcal, protein, carbs, and fat only.");
        for (const key of NUTRIENTS) if (patchSources[key] !== undefined && !SOURCES.has(patchSources[key])) fail(`${key} has an invalid nutrition source.`);
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
      // A physical total supersedes earlier consumption. Keep its boundary
      // separate from confirmedAt, which ordinary consumption also updates.
      if (stockChanged) {
        entry.quantityBaselineAt = at;
        entry.quantityBaselineSource = current ? 'upsert' : 'initial';
      } else {
        for (const key of ['quantityBaselineAt', 'quantityBaselineSource']) {
          if (current[key] === undefined) delete entry[key];
          else entry[key] = current[key];
        }
      }
      if (index === -1) {
        const duplicates = matchExistingProducts(items, entry);
        if (duplicates.length) {
          const candidates = duplicates.map(({ id, name, status, quantity, unit }) => ({ id, name, status, quantity, unit }));
          throw Object.assign(new Error(`A matching product already exists. Reuse its original ID to update or restock instead of creating another: ${candidates.map(value => `${value.name} (ID: ${value.id})`).join('; ')}. Record newly prepared batches separately.`), { status: 409, code: 'DUPLICATE_PRODUCT', candidates });
        }
        if (items.length >= MAX_ITEMS) fail(`Inventory supports at most ${MAX_ITEMS} items. Organize existing foods first.`);
        items.push(entry);
      } else items[index] = entry;
      itemId = entry.id;
      if (freshnessPatch !== undefined && JSON.stringify(current?.freshness ?? null) !== JSON.stringify(entry.freshness ?? null)) {
        freshnessAudit = { freshnessBefore: structuredClone(current?.freshness ?? null), freshnessAfter: structuredClone(entry.freshness ?? null) };
      }
      detail = `${index === -1 ? "Added" : stockChanged ? "Updated inventory" : "Updated details"}: ${entry.name} (${amountText(entry)}).${current && !stockChanged ? "Remaining stock was not recounted." : ''}`;
      break;
    }
    case 'restock': {
      const targetId = id(payload.itemId);
      const index = items.findIndex(entry => entry.id === targetId);
      if (index === -1) fail("Product to restock not found. Read the latest inventory.", 404, 'ITEM_NOT_FOUND');
      const current = items[index];
      if (!isReusableProduct(current)) fail("Prepared-food or recipe batches cannot restock an old batch. Create a separate record for the newly prepared batch.", 400, 'BATCH_REQUIRES_NEW_ITEM');
      const quantity = number(payload.quantity, "Current available total after restock", { nullable: true });
      itemId = targetId;
      // Opening/quality facts belong to the previous purchase, not the product
      // label reused for a new purchase. Keep the old evidence in the audit.
      const { freshness: previousFreshness, ...product } = current;
      if (previousFreshness !== undefined) freshnessAudit = { freshnessBefore: structuredClone(previousFreshness), freshnessAfter: null };
      items[index] = { ...product, quantity, status: quantity === 0 ? 'depleted' : 'available',
        quantityBaselineToken: `${operationId}@${at}`, quantityBaselineAt: at, quantityBaselineSource: 'restock', confirmedAt: at, updatedAt: at };
      detail = `Restocked existing product: ${current.name}, current available total: ${quantity === null ? "Confirmed available; remaining quantity unknown" : `${quantity} ${unitLabel(current.unit, quantity)}`}. Original nutrition labels were preserved. This is the current total, not an addition to the old balance.`;
      break;
    }
    case 'consume': {
      const { index, current } = findItem();
      const quantity = number(payload.quantity, "Actual consumed quantity", { positive: true });
      const note = string(payload.note, "Consumption notes", 500, { optional: true });
      if (payload.outsidePlan !== true && plans.some((plan) => plan.format === 'meals_v1' && ['draft', 'reserved'].includes(plan.status) && (plan.accountedDebits?.some((line) => line.itemId === current.id) || plan.meals?.some(meal => meal.plannedItems?.some(line => line.itemId === current.id)) || plan.draft?.meals?.some(meal => meal.plannedItems?.some(line => line.itemId === current.id))))) {
        fail("This food is in a meal plan. Record actual intake against its original meal to avoid deducting through both consume and a meal report. Use outsidePlan=true only for explicitly additional food outside the menu.", 409, 'MEAL_INTAKE_REQUIRED');
      }
      if (current.status === 'archived' || current.status === 'pending') fail("Archived or pending items cannot be directly deducted. Confirm inventory first.");
      if (current.quantity === null) fail("This food's balance is unknown. Confirm the current balance before recording consumption.", 400, 'UNKNOWN_QUANTITY');
      if (quantity > current.quantity) fail("Consumed quantity exceeds current inventory. Review the balance first.", 400, 'INSUFFICIENT_STOCK');
      const remaining = round(current.quantity - quantity);
      items[index] = { ...current, quantity: remaining, status: remaining === 0 ? 'depleted' : 'available', quantityBaselineToken: baselineToken(current), confirmedAt: at, updatedAt: at };
      detail = `Consumed: ${current.name} ${quantity} ${unitLabel(current.unit, quantity)}, remaining ${remaining} ${unitLabel(current.unit, remaining)}.${note ? ` Notes: ${note}` : ''}`;
      break;
    }
    case 'set_quantity': {
      const { index, current } = findItem();
      const quantity = number(payload.quantity, "Inventory quantity", { nullable: true });
      const entry = { ...current, quantity, status: quantity === 0 ? 'depleted' : ['archived', 'pending'].includes(current.status) ? current.status : 'available', quantityBaselineToken: `${operationId}@${at}`, quantityBaselineAt: at, quantityBaselineSource: 'set_quantity', confirmedAt: at, updatedAt: at };
      items[index] = entry;
      detail = `Confirmed remaining balance: ${entry.name} (${amountText(entry)}).`;
      break;
    }
    case 'archive': {
      const { index, current } = findItem();
      items[index] = { ...current, status: 'archived', quantityBaselineToken: baselineToken(current), confirmedAt: at, updatedAt: at };
      detail = `Archived food: ${current.name}.`;
      break;
    }
    case 'preferences':
      preferenceChangeMetadata = preferenceMetadata(payload);
      nextPreferences = preferences(payload.preferences);
      if (JSON.stringify(nextPreferences) === JSON.stringify(state.preferences)) return state;
      detail = `Updated continuing meal preferences: ${nextPreferences.length} entries.`;
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
      detail = `Incrementally updated continuing meal preferences: ${nextPreferences.length} entries.`;
      break;
    }
    case 'commit_plan': {
      if (payload.confirmed !== true) fail("Only an explicitly finalized user plan can confirm and reserve planned quantities.", 400, 'PLAN_CONFIRMATION_REQUIRED');
      const rawPlan = object(payload.plan, "Diet plan");
      const planId = id(rawPlan.id, "Plan ID");
      const existing = plans.find((entry) => entry.id === planId);
      if (existing?.format === 'meals_v1') fail("This is a structured meal plan. Use meal confirmation or remaining-meal revision tools; do not overwrite it with a legacy whole-day menu.", 409, 'MEAL_PLAN_ACTION_REQUIRED');
      if (existing && existing.status !== 'reserved') fail("This plan was cancelled and cannot be deducted again. Use a new plan ID.", 409, 'PLAN_ALREADY_CANCELLED');
      const content = planContent(rawPlan);
      if (existing) {
        if (JSON.stringify(content) === JSON.stringify(planContent(existing))) return state;
        fail("This plan ID was confirmed with different content. Cancel the old plan first, then confirm the revised menu with a new plan ID.", 409, 'PLAN_ID_CONFLICT');
      }
      fail("Save new daily menus by meal with save_food_plan_draft. They display immediately without reserving or deducting inventory; only actual intake reports settle it. Legacy flat menus retain original accounts and retry records.", 409, 'STRUCTURED_PLAN_REQUIRED');
    }
    case 'cancel_plan': {
      if (payload.confirmed !== true) fail("Cancelling a plan and refunding quantities requires explicit user confirmation.", 400, 'PLAN_CONFIRMATION_REQUIRED');
      const planId = id(payload.planId, "Plan ID");
      const planIndex = plans.findIndex((entry) => entry.id === planId);
      if (planIndex === -1) fail("This diet plan was not found.", 404, 'PLAN_NOT_FOUND');
      const plan = plans[planIndex];
      if (plan.status === 'cancelled') return state;
      if (plan.status !== 'reserved') fail("Only reserved plans can refund quantities.");
      // Check all refunds first. Never add an old count to a changed unit.
      for (const line of plan.items) {
        if (line.unknownQuantity) continue;
        const current = items.find((entry) => entry.id === line.itemId);
        if (!current) fail("A food item in this plan was removed. Restore or review inventory before cancelling.", 409, 'REFUND_REQUIRES_REVIEW');
        if (baselineToken(current) !== line.baselineToken) fail("This food was recounted after menu confirmation. Old usage cannot be automatically added back; reconcile inventory manually.", 409, 'REFUND_REQUIRES_REVIEW');
        if (current.unit !== line.unit) fail("An item's unit changed after planning. Review inventory; quantities in the old unit cannot be automatically refunded.", 409, 'REFUND_REQUIRES_REVIEW');
        if (current.quantity !== null) number(round(current.quantity + line.quantity), "Inventory quantity after refund");
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
      detail = `Cancelled diet plan and refunded known reserved quantities: ${plan.title}. Unknown balances remain unknown.`;
      break;
    }
    case 'restore': {
      preferenceChangeMetadata = preferenceMetadata(payload, true);
      if (plans.some((plan) => plan.status === 'reserved')) fail("Confirmed menus already exist. Reconcile foods individually; importing will not overwrite deduction records.", 409, 'RESTORE_REQUIRES_REVIEW');
      if (!Array.isArray(payload.items) || payload.items.length > MAX_ITEMS) fail(`Imported inventory must be a list with at most ${MAX_ITEMS} items.`);
      items = payload.items.map((entry) => ({ ...validateItem(entry, at), quantityBaselineToken: `${operationId}@${at}`, quantityBaselineAt: at, quantityBaselineSource: 'restore' }));
      if (new Set(items.map((entry) => entry.id)).size !== items.length) fail("Imported inventory contains duplicate food IDs.");
      nextPreferences = preferences(payload.preferences);
      detail = `Imported inventory backup: ${items.length} food items and ${nextPreferences.length} meal preferences.`;
      break;
    }
    default:
      fail("Unsupported inventory action.");
  }

  if (JSON.stringify(nextPreferences) !== JSON.stringify(state.preferences)) {
    if (!validPreferenceSnapshot(state.preferences)) fail("Existing preferences exceed the preservable format. No edit was made; back up and review them first.", 409, 'PREFERENCE_HISTORY_REQUIRES_REVIEW');
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
  if (item.quantity === null) issues.push("The remaining quantity is unknown. Total remaining nutrition cannot be calculated.");
  if (!supplement && knownCount === 0) issues.push("Calories and macros have not been entered. Do not guess them.");
  else if (!supplement && missingNutrients.length) issues.push(`Missing nutrition data: ${missingNutrients.join(', ')}.`);
  if (item.quantity !== null && factor === null && (!supplement || knownCount > 0)) issues.push("Inventory units cannot be reliably converted to the nutrition basis.");
  if (NUTRIENTS.some((key) => perBasis[key] !== null && nutrientSources[key] === 'estimate')) issues.push("Nutrition includes estimates. Label them explicitly when planning.");
  if (NUTRIENTS.some((key) => perBasis[key] !== null && nutrientSources[key] === 'unknown')) issues.push("The source of some nutrient values is unconfirmed.");
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
    instructions: "This reusable daily supplement routine is not evidence of intake today. It can be viewed by date and explicitly checked without food meals. Browsing dates creates no records or inventory deductions. Adapt each new day to training/rest days and user requests. Optional/as-needed doses are not mandatory; ownership does not mean every supplement should be scheduled. Do not guess dosage for unverified labels. Reuse stable unique dose.id values each day; never copy the source day's checkmarks, actual entries, or actual times. If a supplementOnly record exists for the day, first read its canonical plan ID with read_diet_records, then reuse that ID to save and adopt the meal draft rather than opening a second account.",
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
  const generatedAt = timestamp(now, "Snapshot generation time");
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
    quantityExplanation: "quantity is current book stock. New menus settle explicit actual intake only; saving/adopting/editing deduct nothing. Preserve legacy credits and offset them once. reserved does not prove intake.",
    updatedAt: state.updatedAt,
    lastConfirmedAt: confirmedTimes.at(-1) ?? null,
    items,
    availableItems,
    depletedItems,
    archivedItems: items.filter((entry) => entry.status === 'archived'),
    pendingItems: items.filter((entry) => entry.status === 'pending'),
    plans: visiblePlans.map((plan) => ({ ...plan, items: plan.items.map((line) => ({ ...line })) })),
    planSummary: { total: allPlans.length, reserved: allPlans.filter((plan) => plan.status === 'reserved').length, included: visiblePlans.length, omitted: allPlans.length - visiblePlans.length },
    dietHistoryContext: { total: (state.dietHistory ?? []).length, todayCount: historicalTodayCount, included: historicalRecords.length, omittedToday: historicalTodayCount - historicalRecords.length, truncated: historicalRecords.length < historicalTodayCount, records: historicalRecords, inventoryEffect: 'none', instructions: "This is an overview of today's historical diet only. History is an independent archive and has not deducted current inventory. Do not use historical menus to deduct, refund, or restore current stock. Use read_diet_records for other dates or complete details." },
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
      "New-day planning reads current stock; targeted edits use read_food_plan_edit_context then patch_food_plan. Current revision/confirmedAt beats chat memory.",
      "Returned inventory overrides old ledgers/chats. Never restore old balances. Unreported real-world changes remain unknown.",
      "depletedItems/archivedItems/pendingItems cannot enter new menus. Zero may mean reserved, not eaten.",
      "Prefer existing/priority stock; never force daily clearance.",
      "null macros are unknown, never zero or invented.",
      "Mark estimates; retain label/recipe bases.",
      "Per-macro nutrientSources is authoritative; legacy falls back to source. Partial label edits do not confirm other estimates.",
      "Keep source evidence. Active mg/IU is not stock/macros; package net content is not opened stock.",
      "Use supplementFacts/brand for supplement identity/dose. Macros are optional; count provided values only, never infer from actives.",
      "Routine is planning, not intake. Respect training days, requirement and scheduled. Optional unscheduled doses count only as actual; retain known counts despite unknown IU. Not every dose is daily.",
      "Only verified gramsPerUnit converts discrete units/g. mL or active mg is not g; unreliable nutrition stays unknown.",
      "Keep recipe/batch and raw/cooked bases separate.",
      "Unknown stock may be a candidate; confirm sufficiency when needed.",
      "New workflow overrides old rules: saved menus display immediately; save/adopt/edit never deduct. Explicit actual uses record_meal_intake (meal or meals[]).",
      "Reuse canonical planId and meal/line/dose IDs; retry operationId, correct entryId by delta. Supplements preserve menus.",
      "Preserve accountedDebits credits; actuals offset deltas only. Reads/edits never rededuct or refund recounts. reserved is not eaten.",
      "The plans snapshot includes the latest 14 records plus current-day and future reserved plans. Complete records remain in inventory state; an omitted old plan is not evidence that it was not executed.",
      "One-off requests are not continuing preferences.",
    ],
  };
}
