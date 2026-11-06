/** Historical food records are a separate ledger. No function here changes stock. */
import { historyNutritionSignature } from './diet-history-nutrition.mjs';
const CONFIRMATIONS = new Set(['final_plan', 'reported_completed', 'partial_report']);
const STATUSES = new Set(['planned', 'reported_completed', 'partial_report', 'unknown']);
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodiumMg'];
function fail(message, status = 400, code = 'INVALID_HISTORY') { throw Object.assign(new Error(message), { status, code }); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`); return value; }
function text(value, label, max, required = false) { if (value === undefined && !required) return ''; if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(`${label} text is missing or exceeds ${max} characters.`); return value; }
function id(value) { return text(value, "Historical record ID", 100, true).trim(); }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail("Historical records require a valid YYYY-MM-DD date."); return value; }
function stamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail("Invalid import timestamp."); return new Date(value).toISOString(); }
function numeric(value, label) { if (value === null || value === undefined) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) fail(`${label} must be a nonnegative finite number or null.`); return Math.round(value * 1e6) / 1e6; }
function list(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list with at most ${max} entries.`); return value; }
function unique(value, label) { if (new Set(value.map(v => v.id)).size !== value.length) fail(`${label} contains duplicate IDs.`); }
function time(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail("Historical times must use HH:mm; unreported times must be null."); return value; }
function times(raw) { return { plannedTime: time(raw.plannedTime), plannedTimeText: text(raw.plannedTimeText, "Planned time source text", 500), actualTime: time(raw.actualTime), actualTimeText: text(raw.actualTimeText, "Actual time source text", 500) }; }
function nutrition(raw = {}) { object(raw, "Historical nutrition"); const source = raw.source ?? 'unknown'; if (!SOURCES.has(source)) fail("Invalid historical nutrition source."); return { ...Object.fromEntries(NUTRIENTS.map(key => [key, numeric(raw[key], key)])), source, sourceText: text(raw.sourceText, "Historical nutrition source text", 16000) }; }
function entry(raw) { object(raw, "Historical food"); const quantity = numeric(raw.quantity, "Historical quantity"); const plannedQuantity = numeric(raw.plannedQuantity, "Historical planned quantity"); const actualQuantity = numeric(raw.actualQuantity, "Historical actual quantity"); const quantitySource = raw.quantitySource ?? 'unknown'; if (!['reported', 'confirmed_plan_portion', 'unknown'].includes(quantitySource)) fail("Invalid historical quantity source."); const unit = text(raw.unit, "Historical unit", 40); if ([quantity, plannedQuantity, actualQuantity].some(v => v !== null) && !unit.trim()) fail("Known historical quantities must retain their units."); return { id: id(raw.id), name: text(raw.name, "Food name", 200, true), quantity, plannedQuantity, actualQuantity, quantitySource, unit, ...(raw.inventoryItemId === undefined ? {} : { inventoryItemId: id(raw.inventoryItemId) }), nutrition: nutrition(raw.nutrition), sourceText: text(raw.sourceText, "Food source text", 10000) }; }
function status(value) { if (!STATUSES.has(value)) fail("Specify whether the historical food is planned, reported completed, partially reported, or unknown."); return value; }
export function validateDietHistory(raw) {
  object(raw, "Historical diet"); const timeZone = raw.timeZone ?? 'America/Toronto'; if (typeof timeZone !== 'string' || timeZone.length > 100) fail("Invalid timezone."); try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { fail("Invalid timezone."); }
  if (!CONFIRMATIONS.has(raw.confirmation)) fail("Distinguish final plans, reported completion, and partial reports.");
  const meals = list(raw.meals, "Historical meal", 16).map(value => { object(value, "Historical meal"); const items = list(value.items, "Historical food entries", 100).map(entry); unique(items, "Historical food"); return { id: id(value.id), name: text(value.name, "Meal name", 200, true), status: status(value.status), items, nutrition: nutrition(value.nutrition), ...times(value), sourceText: text(value.sourceText, "Meal source text", 10000) }; }); unique(meals, "Historical meal");
  const supplements = list(raw.supplements ?? [], "Historical supplements", 100).map(value => ({ ...entry(value), status: status(value.status), ...times(value) })); unique(supplements, "Historical supplements");
  const sourceRefs = list(raw.sourceRefs ?? [], "Historical source references", 100).map(value => { object(value, "Source reference"); if (!['user', 'assistant', 'document'].includes(value.kind)) fail("Invalid source role."); return { conversationId: text(value.conversationId, "Source chat ID", 200, true), messageKey: text(value.messageKey, "Source message ID", 200, true), kind: value.kind, ...(value.date === undefined ? {} : { date: date(value.date) }), text: text(value.text, "Source text", 16000) }; });
  const result = { id: id(raw.id), date: date(raw.date), title: text(raw.title, "Historical menu title", 200, true), timeZone, confirmation: raw.confirmation, meals, supplements, nutrition: nutrition(raw.nutrition), planSourceText: text(raw.planSourceText, "Complete planned source text", 100000), executionSourceText: text(raw.executionSourceText, "Complete actual source text", 100000), notes: text(raw.notes, "Historical notes", 10000), sourceRefs };
  if (JSON.stringify(result).length > 240000) fail("A historical diet record exceeds 240000 characters. Organize it by date or meal before importing; the original text was not truncated.");
  return result;
}
function content(record) { const { recordType, inventoryEffect, createdAt, updatedAt, versions, ...value } = record; return value; }
function canonical(value) { return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v); }
function applyOne(state, payload, now) {
  const at = stamp(now); const input = object(payload.record, "Historical diet"); const recordId = id(input.id); const history = (state.dietHistory ?? []).slice(); const index = history.findIndex(record => record.id === recordId); const previous = index < 0 ? null : history[index];
  if ((state.plans ?? []).some(plan => plan.id === recordId)) fail("The historical record ID duplicates a regular menu. Use a separate historical ID; inventory accounts cannot be converted.", 409, 'HISTORY_ID_CONFLICT');
  const nextContent = validateDietHistory({ ...(previous ? content(previous) : {}), ...input, ...(input.nutrition === undefined ? {} : { nutrition: { ...previous?.nutrition, ...object(input.nutrition, "Historical nutrition") } }) });
  const nutritionSignatures = { ...previous?.nutritionSignatures };
  if (input.nutrition !== undefined) {
    const signature = historyNutritionSignature(nextContent);
    for (const key of ['kcal', 'protein', 'carbs', 'fat']) if (Object.hasOwn(input.nutrition, key)) {
      if (nextContent.nutrition[key] === null) delete nutritionSignatures[key];
      else nutritionSignatures[key] = signature;
    }
  }
  if (Object.keys(nutritionSignatures).length) nextContent.nutritionSignatures = nutritionSignatures;
  if (JSON.stringify(nextContent).length > 240000) fail("A historical diet record with nutrition evidence exceeds 240000 characters. Split the import; original records and inventory were not changed.");
  if (previous && canonical(content(previous)) === canonical(nextContent)) return { dietHistory: state.dietHistory, noChange: true, detail: "Historical diet content is unchanged. Inventory was not changed." };
  if (!previous && history.length >= 1000) fail("The historical diet limit of 1000 records was reached. Back up and organize records first.");
  const versions = previous?.versions?.slice() ?? []; if (versions.length >= 100) fail("This record reached 100 historical corrections. Back it up first; the original record was preserved.");
  if (previous) { const { versions: _versions, ...before } = previous; versions.push({ at, operationId: id(payload.operationId), previous: structuredClone(before) }); }
  const next = { ...nextContent, recordType: 'diet_history', inventoryEffect: 'none', createdAt: previous?.createdAt ?? at, updatedAt: at, versions };
  if (index < 0) history.push(next); else history[index] = next;
  return { dietHistory: history, detail: `${previous ? "Corrected" : "Imported"} historical diet: ${next.date} ${next.title}; historical archive only, inventory change: 0.` };
}
export function applyDietHistoryAction(state, payload, now = new Date().toISOString()) {
  if (payload.record !== undefined && payload.records !== undefined) fail("Provide either record or records, not both.");
  const records = payload.records === undefined ? [payload.record] : list(payload.records, "Historical import batch", 31);
  if (!records.length) fail("Provide at least one historical record for batch import.");
  const ids = records.map(record => id(object(record, "Historical diet").id)); if (new Set(ids).size !== ids.length) fail("The batch contains duplicate historical IDs.");
  let draft = state; let changed = false;
  for (const record of records) { const result = applyOne(draft, { ...payload, record }, now); if (!result.noChange) { changed = true; draft = { ...draft, dietHistory: result.dietHistory }; } }
  return changed ? { dietHistory: draft.dietHistory, detail: `Imported or corrected ${records.length} historical diet records; inventory change: 0.` } : { dietHistory: state.dietHistory, noChange: true, detail: "Historical content is unchanged; inventory change: 0." };
}
export function historySnapshot(record) { const { versions: _versions, ...current } = record; return { ...structuredClone(current), recordId: record.id }; }
export function historyContext(state, day) {
  const records = []; const all = (state.dietHistory ?? []).filter(record => record.date === day);
  for (const record of all.slice(-14)) { const summary = { id: record.id, recordType: 'diet_history', inventoryEffect: 'none', date: record.date, title: record.title.slice(0, 100), confirmation: record.confirmation, mealCount: record.meals.length, supplementCount: record.supplements.length, detailRequired: true, recordId: record.id }; if (JSON.stringify([...records, summary]).length > 12000) break; records.push(summary); }
  return records;
}
