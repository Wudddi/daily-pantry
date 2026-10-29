import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { foodDisplayAmount } from './food-display-amount.mjs';
import { nutritionTotalsFromLines } from './diet-nutrition.mjs';

const rows = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
const round = value => Math.round(value * 1e6) / 1e6;
const unitKey = unit => unit === 'mL' ? 'ml' : unit;
const nameKey = name => String(name ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const error = (message, code = 'INVALID_INTAKE_DRAFT') => Object.assign(new Error(message), { status: 409, code });
function hash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 0x01000193); b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
const key = (mealId, lineId) => JSON.stringify([mealId, lineId]);
function validId(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 100) throw error(label + '无效。'); return value.trim(); }
function amount(value, nullable = false) { if (nullable && value === null) return null; if (!finite(value)) throw error('已吃量和转餐量必须是明确的非负数字，未知量请留空。'); return round(value); }
function list(value, limit, label) { if (!Array.isArray(value) || value.length > limit) throw error(label + '超过保存上限或格式无效。'); return value; }
function sameFood(line, actual) { return line.itemId != null || actual.itemId != null ? line.itemId != null && line.itemId === actual.itemId : nameKey(line.name ?? line.nutritionSnapshot?.name) === nameKey(actual.name ?? actual.nutritionSnapshot?.name); }
function sum(entries) { return entries.some(entry => entry.quantity === null) ? null : round(entries.reduce((total, entry) => total + entry.quantity, 0)); }
function total(lines) { return nutritionTotalsFromLines(lines.map(line => ({ snapshot: line.nutritionSnapshot ?? null, quantity: line.quantity, unit: line.unit, supplement: false }))); }

export function intakeEntryId(planId, mealId, lineId) { return 'ui-intake-' + hash([planId, mealId, lineId]); }
export function intakeTransferLineId(planId, transferId) { return 'ui-transfer-' + hash([planId, transferId]); }
/** Independent CAS token: supplement refreshes do not overwrite another device's draft. */
export function intakeDraftVersion(draft) {
  if (!draft) return null;
  const text = value => typeof value === 'string' ? value.trim() : value;
  const quantity = value => typeof value === 'number' ? round(value) : value;
  return hash({ id: text(draft.id), baseFingerprint: text(draft.baseFingerprint),
    consumed: rows(draft.consumed).map(entry => ({ mealId: text(entry.mealId), lineId: text(entry.lineId), quantity: quantity(entry.quantity),
      ...(entry.unit === undefined ? {} : { unit: text(entry.unit) }), correctExistingActuals: entry.correctExistingActuals === true })),
    transfers: rows(draft.transfers).map(entry => ({ id: text(entry.id), fromMealId: text(entry.fromMealId), lineId: text(entry.lineId),
      toMealId: text(entry.toMealId), quantity: quantity(entry.quantity), ...(entry.unit === undefined ? {} : { unit: text(entry.unit) }) })),
    completedMealIds: rows(draft.completedMealIds).map(text) });
}
export function intakePlanFingerprint(input, inventoryItems = []) {
  const plan = projectCurrentDietPlan(input, inventoryItems);
  const text = JSON.stringify({ id: plan?.id, date: plan?.date, closed: ['cancelled', 'closed_with_actuals'].includes(plan?.status),
    meals: rows(plan?.meals).map(meal => ({ id: meal.id, slot: meal.slot, title: meal.title, plannedTime: meal.plannedTime,
      plannedTimeText: meal.plannedTimeText, plannedItems: meal.plannedItems,
      actualEntries: meal.actualEntries, state: meal.state, actualTime: meal.actualTime, actualTimeText: meal.actualTimeText,
      completionReportedAt: meal.completionReportedAt, reportHistory: meal.reportHistory })) });
  return hash(text) + '-' + text.length;
}

export function normalizeIntakeDraft(input, raw, inventoryItems = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('请提供进食草稿。');
  const allowed = new Set(['id', 'baseFingerprint', 'consumed', 'transfers', 'completedMealIds', 'updatedAt']);
  if (Object.keys(raw).some(field => !allowed.has(field))) throw error('进食草稿包含不支持的字段。');
  const result = { id: validId(raw.id, '草稿ID'), baseFingerprint: validId(raw.baseFingerprint, '草稿基线'), consumed: [], transfers: [], completedMealIds: [] };
  for (const entry of list(raw.consumed ?? [], 1200, '已吃条目')) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(field => !['mealId', 'lineId', 'quantity', 'unit', 'correctExistingActuals'].includes(field))) throw error('已吃条目字段无效。');
    if (entry.correctExistingActuals !== undefined && typeof entry.correctExistingActuals !== 'boolean') throw error('更正既有实际记录需要明确勾选。');
    result.consumed.push({ mealId: validId(entry.mealId, '餐次ID'), lineId: validId(entry.lineId, '食物行ID'), quantity: amount(entry.quantity, true),
      ...(entry.unit === undefined ? {} : { unit: validId(entry.unit, '单位') }), correctExistingActuals: entry.correctExistingActuals === true });
  }
  if (new Set(result.consumed.map(entry => key(entry.mealId, entry.lineId))).size !== result.consumed.length) throw error('同一食物累计已吃量不能重复填写。');
  for (const transfer of list(raw.transfers ?? [], 100, '转餐记录')) {
    if (!transfer || typeof transfer !== 'object' || Object.keys(transfer).some(field => !['id', 'fromMealId', 'lineId', 'toMealId', 'quantity', 'unit'].includes(field))) throw error('转餐记录字段无效。');
    const quantity = amount(transfer.quantity); if (quantity === 0) throw error('转餐量必须大于0。');
    result.transfers.push({ id: validId(transfer.id, '转餐ID'), fromMealId: validId(transfer.fromMealId, '来源餐次'), lineId: validId(transfer.lineId, '来源食物'),
      toMealId: validId(transfer.toMealId, '目标餐次'), quantity, ...(transfer.unit === undefined ? {} : { unit: validId(transfer.unit, '单位') }) });
  }
  if (new Set(result.transfers.map(entry => entry.id)).size !== result.transfers.length) throw error('转餐记录ID不能重复。');
  result.completedMealIds = list(raw.completedMealIds ?? [], 16, '完成餐次').map(value => validId(value, '完成餐次ID'));
  if (new Set(result.completedMealIds).size !== result.completedMealIds.length) throw error('完成餐次不能重复。');
  if (result.baseFingerprint !== intakePlanFingerprint(input, inventoryItems)) throw error('菜单或实际记录已被更新，请先刷新并重新核对进食草稿。', 'INTAKE_DRAFT_STALE');
  return result;
}

function rowInfo(plan, meal, line, virtual = false) {
  return { meal, line, virtual, external: [], managed: [], blocked: '', factor: 1, displayUnit: line.unit,
    managedId: intakeEntryId(plan.id, meal.id, line.id) };
}
function associate(plan) {
  const infos = new Map();
  for (const meal of rows(plan.meals)) {
    for (const line of rows(meal.plannedItems)) infos.set(key(meal.id, line.id), rowInfo(plan, meal, line));
    // Build external virtual source rows before attaching the UI entries that
    // refer to them. Refreshing must not split one cumulative row into layers.
    for (const actual of rows(meal.actualEntries).slice().sort((a, b) => Number(a.id.startsWith('ui-intake-')) - Number(b.id.startsWith('ui-intake-')))) {
      const candidates = [...infos.values()].filter(info => info.meal.id === meal.id && !info.virtual && sameFood(info.line, actual));
      const exact = candidates.filter(info => actual.intakeLineId === info.line.id || actual.id === intakeEntryId(plan.id, meal.id, info.line.id)
        || actual.id === 'planned-' + hash(JSON.stringify([plan.id, meal.id, info.line.id])));
      const linked = actual.intakeLineId ? infos.get(key(meal.id, actual.intakeLineId)) : null;
      // Adding a later, unconsumed transfer must not make a previously unique
      // Chat report ambiguous. The single original line remains that report's
      // source; several original candidates still require explicit review.
      const original = candidates.filter(info => !info.line.id.startsWith('ui-transfer-'));
      let found = linked && sameFood(linked.line, actual) ? linked : exact.length === 1 ? exact[0]
        : candidates.length === 1 ? candidates[0] : !actual.intakeLineId && !actual.id.startsWith('ui-intake-') && original.length === 1 ? original[0] : null;
      const unitMismatch = found && actual.unit !== found.line.unit;
      if (unitMismatch) { found.blocked = '既有实际记录与菜单单位不同，请先核对原记录，不能猜测换算。'; found = null; }
      if (!found) {
        const lineId = actual.intakeLineId && !infos.has(key(meal.id, actual.intakeLineId)) ? actual.intakeLineId : 'actual-' + hash([meal.id, actual.id]);
        found = rowInfo(plan, meal, { id: lineId, itemId: actual.itemId, name: actual.name, quantity: 0, unit: actual.unit,
          nutritionSnapshot: copy(actual.nutritionSnapshot) }, true);
        infos.set(key(meal.id, lineId), found);
        if (unitMismatch) found.blocked = '既有实际记录与菜单单位不同，请先核对原记录，不能猜测换算。';
        if (candidates.length > 1 && !exact.length && actual.quantity !== 0) {
          found.blocked = '同餐同食材有多条计划，既有实际记录未明确对应哪一行，请先核对。';
          for (const candidate of candidates) candidate.blocked = found.blocked;
        }
      }
      if (actual.id === found.managedId || actual.intakeLineId === found.line.id && actual.id.startsWith('ui-intake-')) {
        found.managed.push(actual); found.managedId = actual.id;
      } else found.external.push(actual);
      if (actual.unit !== found.line.unit) found.blocked = '既有实际记录与菜单单位不同，请先核对原记录，不能猜测换算。';
      if (actual.quantity === null && !actual.id.startsWith('ui-intake-')) found.blocked = '既有实际用量未知，请先核对原记录后再编辑累计量。';
    }
  }
  for (const info of infos.values()) {
    if (info.managed.length > 1) info.blocked = '同一行有多份既有手动实际记录，需要先核对。';
    const display = foodDisplayAmount({ quantity: 1, unit: info.line.unit, nutritionSnapshot: info.line.nutritionSnapshot });
    const knownDifferentWeight = [...info.managed, ...info.external].some(actual => actual.quantity !== 0 && actual.unit === info.line.unit
      && actual.nutritionSnapshot?.gramsPerUnit != null && info.line.nutritionSnapshot?.gramsPerUnit != null
      && actual.nutritionSnapshot.gramsPerUnit !== info.line.nutritionSnapshot.gramsPerUnit);
    // An actual weighed item may differ from the planned average. Retain its
    // original unit rather than re-label that measurement with planned grams.
    if (!knownDifferentWeight && finite(display.quantity) && display.quantity > 0) { info.factor = display.quantity; info.displayUnit = display.unit; }
  }
  return infos;
}
function rawQuantity(entry, info) {
  if (entry.quantity === null) return null;
  const unit = unitKey(entry.unit ?? info.displayUnit);
  if (unit === unitKey(info.line.unit)) return entry.quantity;
  if (unit === unitKey(info.displayUnit) && info.factor > 0) return round(entry.quantity / info.factor);
  throw error('输入单位与此食物已保存的计量依据不一致，未自动猜测换算。', 'INTAKE_UNIT_CONFLICT');
}
function desired(info, entry) {
  if (!entry) return { eaten: sum([...info.external, ...info.managed]), managed: sum(info.managed), corrections: [] };
  if (info.blocked) throw error(info.blocked, 'INTAKE_ACTUAL_REQUIRES_REVIEW');
  const target = rawQuantity(entry, info), fixed = sum(info.external);
  if (fixed === null) throw error('既有实际用量未知，不能由累计量猜测覆盖。', 'INTAKE_ACTUAL_REQUIRES_REVIEW');
  if (target !== null && target < fixed) {
    if (!entry.correctExistingActuals) throw error('填写量低于已记录的实际量；请明确勾选这是对已记录用量的更正。', 'EXISTING_ACTUAL_CONFIRMATION_REQUIRED');
    let retained = target;
    const corrections = info.external.map(actual => { const quantity = Math.min(actual.quantity, retained); retained = round(retained - quantity); return { actual, quantity }; });
    return { eaten: target, managed: 0, corrections };
  }
  return { eaten: target, managed: target === null ? null : round(target - fixed), corrections: [] };
}

/** Detached preparation for the server's single atomic settlement. */
export function prepareIntakeDraft(input, raw, inventoryItems = [], { readOnly = false } = {}) {
  const draft = normalizeIntakeDraft(input, raw, inventoryItems), plan = copy(projectCurrentDietPlan(input, inventoryItems));
  if (!readOnly && !['draft', 'reserved', 'closed_with_actuals'].includes(plan.status)) throw error('已取消菜单不能编辑进食草稿。', 'PLAN_CLOSED');
  if (plan.status === 'closed_with_actuals' && draft.transfers.length) throw error('已结束菜单不能重新分配未来餐次，只能明确更正实际记录。', 'PLAN_CLOSED');
  const infos = associate(plan), consumed = new Map(draft.consumed.map(entry => [key(entry.mealId, entry.lineId), entry]));
  // Same-day plan allocation is independent of historical meal completion.
  // Keep completed state, actuals and legacy credits untouched; transfer-only
  // submission neither records intake nor invokes inventory settlement.
  for (const transfer of draft.transfers) {
    const source = infos.get(key(transfer.fromMealId, transfer.lineId)), targetMeal = rows(plan.meals).find(meal => meal.id === transfer.toMealId);
    if (!source || !targetMeal || source.virtual) throw error('找不到可转移的计划食物或目标餐次。', 'INTAKE_LINE_NOT_FOUND');
    if (source.meal.state === 'cancelled' || targetMeal.state === 'cancelled') throw error('已取消餐次不能接收或转出未来计划食物。', 'INTAKE_CANCELLED_MEAL');
    if (source.meal.id === targetMeal.id) throw error('转餐需要选择另一餐。');
    if (source.blocked) throw error(source.blocked, 'INTAKE_ACTUAL_REQUIRES_REVIEW');
    const quantity = rawQuantity(transfer, source), eaten = desired(source, consumed.get(key(source.meal.id, source.line.id))).eaten;
    if (eaten === null || quantity > round(Math.max(0, source.line.quantity - eaten))) throw error('只能转移尚未吃下的剩余量，不能转走已记录或草稿中的已吃部分。', 'INTAKE_TRANSFER_EXCEEDS_REMAINING');
    const destinationId = intakeTransferLineId(plan.id, transfer.id);
    if (infos.has(key(targetMeal.id, destinationId))) throw error('转餐目标行ID已存在，请复用原记录或新的转餐ID。');
    source.line.quantity = round(source.line.quantity - quantity);
    const line = { ...copy(source.line), id: destinationId, quantity,
      sourceText: '用户在进食草稿中将未吃部分从' + source.meal.title + '分配至' + targetMeal.title + '。' };
    targetMeal.plannedItems.push(line);
    if (targetMeal.plannedItems.length > 100) throw error('该餐食物行达到保存上限。');
    const info = rowInfo(plan, targetMeal, line); info.factor = source.factor; info.displayUnit = source.displayUnit;
    infos.set(key(targetMeal.id, destinationId), info);
  }
  for (const entry of draft.consumed) if (!infos.has(key(entry.mealId, entry.lineId))) throw error('菜单中的食物行已改变，请重新核对。', 'INTAKE_LINE_NOT_FOUND');
  for (const mealId of draft.completedMealIds) {
    const meal = rows(plan.meals).find(meal => meal.id === mealId);
    if (!meal) throw error('找不到要标记完成的餐次。', 'MEAL_NOT_FOUND');
    if (meal.state === 'cancelled') throw error('已取消餐次不能重新标记完成，请保留原事实。', 'INTAKE_CANCELLED_MEAL');
  }
  const changes = [], viewRows = [];
  const shadow = copy(plan);
  for (const info of infos.values()) {
    const entry = consumed.get(key(info.meal.id, info.line.id)), wanted = desired(info, entry);
    if (entry) changes.push({ mealId: info.meal.id, lineId: info.line.id, managedEntryId: info.managedId,
      managedQuantity: wanted.managed, sourceLine: copy(info.line), externalCorrections: wanted.corrections.map(change => ({ entryId: change.actual.id, quantity: change.quantity })) });
    const shadowMeal = shadow.meals.find(meal => meal.id === info.meal.id);
    if (entry) {
      for (const correction of wanted.corrections) shadowMeal.actualEntries.find(actual => actual.id === correction.actual.id).quantity = correction.quantity;
      const owned = shadowMeal.actualEntries.find(actual => actual.id === info.managedId);
      if (owned) owned.quantity = wanted.managed;
      else if (wanted.managed === null || wanted.managed > 0 || entry.quantity === 0) shadowMeal.actualEntries.push({ id: info.managedId,
        itemId: info.line.itemId, name: info.line.name ?? info.line.nutritionSnapshot?.name ?? '', quantity: wanted.managed,
        unit: info.line.unit, nutritionSnapshot: copy(info.line.nutritionSnapshot) });
    }
    const reported = sum([...info.external, ...info.managed]), fixed = sum(info.external);
    const remaining = ['cancelled', 'closed_with_actuals'].includes(plan.status) || info.meal.state === 'cancelled' ? 0
      : wanted.eaten === null || info.blocked ? null : round(Math.max(0, info.line.quantity - wanted.eaten));
    const display = value => value === null ? null : round(value * info.factor);
    viewRows.push({ lineId: info.line.id, itemId: info.line.itemId ?? null, name: info.line.name ?? info.line.nutritionSnapshot?.name ?? '食物',
      unit: info.displayUnit, plannedQuantity: display(info.line.quantity), eatenQuantity: display(wanted.eaten),
      reportedQuantity: display(reported), externalReportedQuantity: display(fixed), remainingQuantity: display(remaining),
      unknown: wanted.eaten === null || remaining === null, canEdit: !info.blocked && plan.status !== 'cancelled' && info.meal.state !== 'cancelled', issue: info.blocked,
      mealId: info.meal.id, mealSlot: info.meal.slot, rawRemaining: remaining, snapshot: info.line.nutritionSnapshot, rawUnit: info.line.unit });
  }
  const dayGroups = new Map();
  for (const row of viewRows) {
    const identity = JSON.stringify([row.itemId ?? nameKey(row.name), row.unit]);
    let group = dayGroups.get(identity);
    if (!group) { group = { itemId: row.itemId, name: row.name, unit: row.unit, rows: [] }; dayGroups.set(identity, group); }
    group.rows.push(row);
  }
  const dayRows = [...dayGroups.values()].map(({ rows: groupRows, ...fields }) => ({ ...fields,
    ...Object.fromEntries(['plannedQuantity', 'eatenQuantity', 'reportedQuantity', 'remainingQuantity'].map(field => [field,
      groupRows.some(row => row[field] === null) ? null : round(groupRows.reduce((sum, row) => sum + row[field], 0))])) }));
  const visibleRows = viewRows.map(({ rawRemaining, snapshot, rawUnit, mealId, mealSlot, ...row }) => row);
  const meals = plan.meals.map(meal => ({ id: meal.id, slot: meal.slot, title: meal.title, state: meal.state,
    completed: meal.state === 'completed' || draft.completedMealIds.includes(meal.id), rows: visibleRows.filter((_, index) => viewRows[index].mealId === meal.id) }));
  const totals = { planned: total(plan.meals.flatMap(meal => meal.plannedItems)), eaten: total(shadow.meals.flatMap(meal => meal.actualEntries)),
    remaining: nutritionTotalsFromLines(viewRows.map(row => ({ snapshot: row.snapshot, quantity: row.rawRemaining, unit: row.rawUnit, supplement: false }))) };
  return { draft, plan, changes, meals, dayRows, totals };
}

export function intakeDraftView(input, inventoryItems = [], draftOverride) {
  const current = projectCurrentDietPlan(input ?? {}, inventoryItems), baseFingerprint = intakePlanFingerprint(current, inventoryItems);
  const raw = draftOverride === undefined ? current.intakeDraft ?? null : draftOverride;
  const empty = { id: 'preview', baseFingerprint, consumed: [], transfers: [], completedMealIds: [] };
  let prepared, issues = [], stale = false, invalid = false;
  try { prepared = prepareIntakeDraft(current, raw ?? empty, inventoryItems); }
  catch (failure) {
    invalid = true; stale = failure.code === 'INTAKE_DRAFT_STALE'; issues.push({ code: failure.code ?? 'INVALID_INTAKE_DRAFT', message: failure.message });
    try { prepared = prepareIntakeDraft(current, empty, inventoryItems, { readOnly: true }); }
    catch { prepared = { meals: [], dayRows: [], totals: { planned: total([]), eaten: total([]), remaining: total([]) } }; }
  }
  for (const meal of prepared.meals) for (const row of meal.rows) if (row.issue && !issues.some(issue => issue.message === row.issue)) issues.push({ code: 'INTAKE_ACTUAL_REQUIRES_REVIEW', message: row.issue, mealId: meal.id, lineId: row.lineId });
  const hasChanges = !!raw && (rows(raw.consumed).length > 0 || rows(raw.transfers).length > 0 || rows(raw.completedMealIds).length > 0);
  return { planId: current.id ?? null, date: current.date ?? null, baseFingerprint, draftVersion: intakeDraftVersion(current.intakeDraft), draft: raw ? copy(raw) : null,
    hasDraft: !!raw, stale, canSubmit: !!raw && !invalid && hasChanges, hasChanges, issues,
    meals: prepared.meals, dayRows: prepared.dayRows, totals: prepared.totals };
}
