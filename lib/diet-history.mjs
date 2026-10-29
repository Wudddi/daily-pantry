/** Historical food records are a separate ledger. No function here changes stock. */
import { historyNutritionSignature } from './diet-history-nutrition.mjs';
const CONFIRMATIONS = new Set(['final_plan', 'reported_completed', 'partial_report']);
const STATUSES = new Set(['planned', 'reported_completed', 'partial_report', 'unknown']);
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodiumMg'];
function fail(message, status = 400, code = 'INVALID_HISTORY') { throw Object.assign(new Error(message), { status, code }); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`); return value; }
function text(value, label, max, required = false) { if (value === undefined && !required) return ''; if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(`${label}文字缺失或超过${max}字符。`); return value; }
function id(value) { return text(value, '历史记录ID', 100, true).trim(); }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('历史记录需要真实YYYY-MM-DD日期。'); return value; }
function stamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('导入时间无效。'); return new Date(value).toISOString(); }
function numeric(value, label) { if (value === null || value === undefined) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) fail(`${label}必须是非负有限数值或null。`); return Math.round(value * 1e6) / 1e6; }
function list(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label}必须为最多${max}项列表。`); return value; }
function unique(value, label) { if (new Set(value.map(v => v.id)).size !== value.length) fail(`${label}ID重复。`); }
function time(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('历史时间必须为HH:mm，未报告用null。'); return value; }
function times(raw) { return { plannedTime: time(raw.plannedTime), plannedTimeText: text(raw.plannedTimeText, '计划时间原话', 500), actualTime: time(raw.actualTime), actualTimeText: text(raw.actualTimeText, '实际时间原话', 500) }; }
function nutrition(raw = {}) { object(raw, '历史营养'); const source = raw.source ?? 'unknown'; if (!SOURCES.has(source)) fail('历史营养来源无效。'); return { ...Object.fromEntries(NUTRIENTS.map(key => [key, numeric(raw[key], key)])), source, sourceText: text(raw.sourceText, '历史营养原文', 16000) }; }
function entry(raw) { object(raw, '历史食物'); const quantity = numeric(raw.quantity, '历史数量'); const plannedQuantity = numeric(raw.plannedQuantity, '历史计划数量'); const actualQuantity = numeric(raw.actualQuantity, '历史实际数量'); const quantitySource = raw.quantitySource ?? 'unknown'; if (!['reported', 'confirmed_plan_portion', 'unknown'].includes(quantitySource)) fail('历史数量来源无效。'); const unit = text(raw.unit, '历史单位', 40); if ([quantity, plannedQuantity, actualQuantity].some(v => v !== null) && !unit.trim()) fail('已知历史数量须保留单位。'); return { id: id(raw.id), name: text(raw.name, '食物名称', 200, true), quantity, plannedQuantity, actualQuantity, quantitySource, unit, ...(raw.inventoryItemId === undefined ? {} : { inventoryItemId: id(raw.inventoryItemId) }), nutrition: nutrition(raw.nutrition), sourceText: text(raw.sourceText, '食物原话', 10000) }; }
function status(value) { if (!STATUSES.has(value)) fail('请明确历史食物是计划、完成报告、部分报告或未知。'); return value; }
export function validateDietHistory(raw) {
  object(raw, '历史饮食'); const timeZone = raw.timeZone ?? 'America/Toronto'; if (typeof timeZone !== 'string' || timeZone.length > 100) fail('时区无效。'); try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { fail('时区无效。'); }
  if (!CONFIRMATIONS.has(raw.confirmation)) fail('请区分最终计划、已执行报告和部分报告。');
  const meals = list(raw.meals, '历史餐次', 16).map(value => { object(value, '历史餐次'); const items = list(value.items, '历史食物条目', 100).map(entry); unique(items, '历史食物'); return { id: id(value.id), name: text(value.name, '餐次名称', 200, true), status: status(value.status), items, nutrition: nutrition(value.nutrition), ...times(value), sourceText: text(value.sourceText, '餐次原话', 10000) }; }); unique(meals, '历史餐次');
  const supplements = list(raw.supplements ?? [], '历史补给', 100).map(value => ({ ...entry(value), status: status(value.status), ...times(value) })); unique(supplements, '历史补给');
  const sourceRefs = list(raw.sourceRefs ?? [], '历史来源引用', 100).map(value => { object(value, '来源引用'); if (!['user', 'assistant', 'document'].includes(value.kind)) fail('来源角色无效。'); return { conversationId: text(value.conversationId, '来源聊天ID', 200, true), messageKey: text(value.messageKey, '来源消息ID', 200, true), kind: value.kind, ...(value.date === undefined ? {} : { date: date(value.date) }), text: text(value.text, '来源原话', 16000) }; });
  const result = { id: id(raw.id), date: date(raw.date), title: text(raw.title, '历史菜单标题', 200, true), timeZone, confirmation: raw.confirmation, meals, supplements, nutrition: nutrition(raw.nutrition), planSourceText: text(raw.planSourceText, '完整计划原文', 100000), executionSourceText: text(raw.executionSourceText, '完整执行原话', 100000), notes: text(raw.notes, '历史备注', 10000), sourceRefs };
  if (JSON.stringify(result).length > 240000) fail('单条历史饮食记录超过240000字符，请按日期/餐次整理后导入，原文未截断。');
  return result;
}
function content(record) { const { recordType, inventoryEffect, createdAt, updatedAt, versions, ...value } = record; return value; }
function canonical(value) { return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v); }
function applyOne(state, payload, now) {
  const at = stamp(now); const input = object(payload.record, '历史饮食'); const recordId = id(input.id); const history = (state.dietHistory ?? []).slice(); const index = history.findIndex(record => record.id === recordId); const previous = index < 0 ? null : history[index];
  if ((state.plans ?? []).some(plan => plan.id === recordId)) fail('历史记录ID与普通菜单重复，请使用独立历史ID，不能转换库存账。', 409, 'HISTORY_ID_CONFLICT');
  const nextContent = validateDietHistory({ ...(previous ? content(previous) : {}), ...input, ...(input.nutrition === undefined ? {} : { nutrition: { ...previous?.nutrition, ...object(input.nutrition, '历史营养') } }) });
  const nutritionSignatures = { ...previous?.nutritionSignatures };
  if (input.nutrition !== undefined) {
    const signature = historyNutritionSignature(nextContent);
    for (const key of ['kcal', 'protein', 'carbs', 'fat']) if (Object.hasOwn(input.nutrition, key)) {
      if (nextContent.nutrition[key] === null) delete nutritionSignatures[key];
      else nutritionSignatures[key] = signature;
    }
  }
  if (Object.keys(nutritionSignatures).length) nextContent.nutritionSignatures = nutritionSignatures;
  if (JSON.stringify(nextContent).length > 240000) fail('单条历史饮食含营养核对资料超过240000字符，请分批整理；原记录和库存未修改。');
  if (previous && canonical(content(previous)) === canonical(nextContent)) return { dietHistory: state.dietHistory, noChange: true, detail: '历史饮食内容相同，库存未变。' };
  if (!previous && history.length >= 1000) fail('历史饮食达到1000条，请先备份整理。');
  const versions = previous?.versions?.slice() ?? []; if (versions.length >= 100) fail('本记录更正历史达到100次，请先备份，原记录已保留。');
  if (previous) { const { versions: _versions, ...before } = previous; versions.push({ at, operationId: id(payload.operationId), previous: structuredClone(before) }); }
  const next = { ...nextContent, recordType: 'diet_history', inventoryEffect: 'none', createdAt: previous?.createdAt ?? at, updatedAt: at, versions };
  if (index < 0) history.push(next); else history[index] = next;
  return { dietHistory: history, detail: `${previous ? '更正' : '导入'}历史饮食：${next.date} ${next.title}；历史存档，库存变化为0。` };
}
export function applyDietHistoryAction(state, payload, now = new Date().toISOString()) {
  if (payload.record !== undefined && payload.records !== undefined) fail('一次请提供record或records其中之一。');
  const records = payload.records === undefined ? [payload.record] : list(payload.records, '批量历史记录', 31);
  if (!records.length) fail('批量导入至少一条历史记录。');
  const ids = records.map(record => id(object(record, '历史饮食').id)); if (new Set(ids).size !== ids.length) fail('批量导入存在重复历史ID。');
  let draft = state; let changed = false;
  for (const record of records) { const result = applyOne(draft, { ...payload, record }, now); if (!result.noChange) { changed = true; draft = { ...draft, dietHistory: result.dietHistory }; } }
  return changed ? { dietHistory: draft.dietHistory, detail: `导入或更正${records.length}条历史饮食；库存变化为0。` } : { dietHistory: state.dietHistory, noChange: true, detail: '历史内容相同；库存变化为0。' };
}
export function historySnapshot(record) { const { versions: _versions, ...current } = record; return { ...structuredClone(current), recordId: record.id }; }
export function historyContext(state, day) {
  const records = []; const all = (state.dietHistory ?? []).filter(record => record.date === day);
  for (const record of all.slice(-14)) { const summary = { id: record.id, recordType: 'diet_history', inventoryEffect: 'none', date: record.date, title: record.title.slice(0, 100), confirmation: record.confirmation, mealCount: record.meals.length, supplementCount: record.supplements.length, detailRequired: true, recordId: record.id }; if (JSON.stringify([...records, summary]).length > 12000) break; records.push(summary); }
  return records;
}
