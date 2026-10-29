/** Pure structured diet records. Inventory revisions, actor checks and persistence live in inventory.mjs/store. */
import { historySnapshot, historyContext } from './diet-history.mjs';
import { resolveDietDays } from './diet-day-summary.mjs';
import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { dailyFoodRollup, dailyFoodRollupPage } from './daily-food-rollup.mjs';
import { intakeDraftView, intakeDraftVersion, intakePlanFingerprint, normalizeIntakeDraft, prepareIntakeDraft } from './intake-draft.mjs';
import { applyPersonalFoodCheck } from './personal-food-checklist.mjs';
import { dailyMenuAccountingPlan, dailyMenuAssumedMealIds, prepareDailyMenuSettlement } from './daily-menu-settlement.mjs';
const ACTIONS = new Set(['save_meal_plan_draft', 'commit_meal_plan', 'revise_unconsumed_meals', 'patch_meal_plan', 'record_meal_intake', 'record_supplement_intake', 'set_supplement_check', 'set_daily_supplement_check', 'save_supplement_routine', 'cancel_meal_plan', 'cancel_remaining_meals', 'save_intake_draft', 'submit_intake_draft', 'discard_intake_draft', 'apply_checklist_intake', 'set_food_personal_check', 'settle_daily_menu']);
const SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'snack', 'other']);
const DOSE_SLOTS = new Set(['breakfast', 'lunch', 'pre_workout', 'post_workout', 'dinner', 'bedtime', 'other']);
const REQUIREMENTS = new Set(['daily', 'optional', 'as_needed', 'label_pending']);
const MODES = new Set(['append', 'correct', 'complete']);
const SCALE = 1_000_000;
const MAX = 1_000_000_000;
const clone = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const baseline = (item) => item.quantityBaselineToken ?? item.confirmedAt ?? 'initial';
function fail(message, status = 400, code = 'INVALID_INPUT') { throw Object.assign(new Error(message), { status, code }); }
function obj(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`); return value; }
function str(value, label, max = 100, optional = false) { if (value === undefined && optional) return ''; if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) fail(`${label}文字无效或过长。`); return value; }
function id(value, label = '记录ID') { return str(value, label).trim(); }
function qty(value, nullable = false, positive = true) { if (nullable && value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX) fail('数量必须明确为非负有限数字，未知请填null。'); const result = Math.round(value * SCALE) / SCALE; if (positive && result <= 0) fail('数量必须大于0。'); return result; }
function round(value) { return Math.round(value * SCALE) / SCALE; }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('必须提供明确有效的YYYY-MM-DD日期。'); return value; }
function time(value) { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('时间必须为HH:mm，未报告请留null。'); return value; }
function list(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label}必须为最多${max}项列表。`); return value; }
function unique(entries, label) { if (new Set(entries.map((e) => e.id)).size !== entries.length) fail(`${label}包含重复ID。`); }
function stamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('报告接收时间必须带时区。'); return new Date(value).toISOString(); }
function itemFor(items, targetId) { const item = items.find((i) => i.id === targetId); if (!item) fail('找不到食材，请刷新最新库存。', 404, 'ITEM_NOT_FOUND'); return item; }
function snapshot(item) { return clone(Object.fromEntries(['name', 'unit', 'nutrition', 'gramsPerUnit', 'ingredients', 'supplementFacts'].map((key) => [key, item[key] ?? null]))); }
const UNITS = new Set(['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const nameKey = (value) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, '');
function untrackedNutrition(raw, unit) {
  if (raw === undefined) return { basisAmount: 1, basisUnit: unit, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown', sourceNote: '', sourceText: '', nutrientSources: { kcal: 'unknown', protein: 'unknown', carbs: 'unknown', fat: 'unknown' } };
  obj(raw, '未跟踪食品营养'); if (!UNITS.has(raw.basisUnit)) fail('营养标签必须明确有效计量单位。'); const source = raw.source ?? 'unknown'; if (!SOURCES.has(source)) fail('营养来源无效。');
  const result = { basisAmount: qty(raw.basisAmount), basisUnit: raw.basisUnit, source, sourceNote: str(raw.sourceNote, '营养说明', 1000, true), sourceText: str(raw.sourceText, '营养原文', 16000, true), nutrientSources: {} };
  if (raw.nutrientSources !== undefined) obj(raw.nutrientSources, '营养逐项来源');
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) { result[key] = qty(raw[key] ?? null, true, false); const fieldSource = raw.nutrientSources?.[key] ?? source; if (!SOURCES.has(fieldSource)) fail('营养逐项来源无效。'); result.nutrientSources[key] = result[key] === null ? 'unknown' : fieldSource; }
  const sources = new Set(['kcal', 'protein', 'carbs', 'fat'].filter(key => result[key] !== null).map(key => result.nutrientSources[key])); result.source = sources.size === 1 ? [...sources][0] : sources.has('estimate') ? 'estimate' : 'unknown';
  return result;
}
function plannedLine(raw, items, previous) {
  obj(raw, '计划食物');
  if (raw.itemId === null) {
    const name = str(raw.name, '未跟踪食品名称', 200); const unit = str(raw.unit, '未跟踪食品单位', 20); if (!UNITS.has(unit)) fail('未跟踪食品必须明确有效单位。');
    if (items.some(item => nameKey(item.name) === nameKey(name))) fail('该食品已在库存中，必须引用其ID，不能以未跟踪食品绕过缺货或待核状态。', 409, 'TRACKED_FOOD_REQUIRES_ID');
    const nutrition = untrackedNutrition(raw.nutrition, unit);
    const preserve = previous?.itemId === null && previous.id === id(raw.id) && previous.name === name && previous.unit === unit && equal(previous.nutrition, raw.nutrition === undefined ? undefined : nutrition);
    return { id: id(raw.id), itemId: null, name, quantity: qty(raw.quantity), unit, sourceText: str(raw.sourceText, '食物原话', 10000, true), ...(raw.nutrition === undefined ? {} : { nutrition }), nutritionSnapshot: preserve && previous.nutritionSnapshot !== undefined ? clone(previous.nutritionSnapshot) : { name, unit, nutrition, gramsPerUnit: null, ingredients: '', supplementFacts: '' } };
  }
  const item = itemFor(items, id(raw.itemId, '食材ID')); if (item.category === 'supplement') fail('补给必须独立记在supplementDoses。'); const unit = raw.unit === undefined ? item.unit : str(raw.unit, '单位', 20); if (unit !== item.unit) fail('计划单位必须与库存单位一致，不自动换算。');
  const nutritionSnapshot = snapshot(item);
  let nutrition;
  if (raw.nutrition !== undefined) {
    nutrition = untrackedNutrition(raw.nutrition, unit);
    if (nutrition.basisUnit !== unit) fail('本次计划营养估算须按计划食物单位明确填写，不自动推算罐与克的换算。');
    const known = ['kcal', 'protein', 'carbs', 'fat'].filter(key => nutrition[key] !== null);
    if (!known.length || raw.nutrition.source !== 'estimate' || known.some(key => nutrition.nutrientSources[key] !== 'estimate')) fail('库存食品的计划营养覆盖必须提供明确数值及estimate来源；未知项保留null，不能冒称库存标签。');
    if (!nutrition.sourceText.trim() && !nutrition.sourceNote.trim()) fail('本次计划营养估算必须提供非空sourceText或sourceNote说明依据。');
    const disclaimer = '[仅本次计划口径估算] 不修改库存营养标签或每单位克重。';
    if (!nutrition.sourceNote.startsWith(disclaimer)) nutrition.sourceNote = disclaimer + (nutrition.sourceNote ? '\n' + nutrition.sourceNote : '');
    if (nutrition.sourceNote.length > 1000) fail('计划营养说明含口径提示超过1000字，请把详细依据移到sourceText，原文未截断。');
    nutritionSnapshot.nutrition = clone(nutrition);
  }
  const preserve = previous?.id === id(raw.id) && previous.itemId === item.id && previous.unit === unit && equal(previous.nutrition, nutrition);
  return { id: id(raw.id), itemId: item.id, quantity: qty(raw.quantity), unit, sourceText: str(raw.sourceText, '食物原话', 10000, true), ...(nutrition === undefined ? {} : { nutrition }), nutritionSnapshot: preserve && previous.nutritionSnapshot !== undefined ? clone(previous.nutritionSnapshot) : nutritionSnapshot };
}
function meal(raw, items, previous) {
  obj(raw, '餐次'); const mealId = id(raw.id); if (!SLOTS.has(raw.slot)) fail('餐次类型无效。');
  const lines = list(raw.plannedItems, '计划食物', 100).map((line) => plannedLine(line, items, previous?.plannedItems.find((old) => old.id === line.id))); unique(lines, '计划食物');
  return { id: mealId, slot: raw.slot, title: str(raw.title, '餐次标题', 200), plannedTime: time(raw.plannedTime), plannedTimeText: str(raw.plannedTimeText, '计划时间原话', 500, true), plannedItems: lines,
    actualEntries: previous?.actualEntries ?? [], actualTime: previous?.actualTime ?? null, actualTimeText: previous?.actualTimeText ?? '', completionReportedAt: previous?.completionReportedAt ?? null, sourceText: previous?.sourceText ?? '', reportHistory: previous?.reportHistory ?? [], state: previous?.state ?? 'reserved', ...(previous?.planRevisionHistory === undefined ? {} : { planRevisionHistory: clone(previous.planRevisionHistory) }) };
}
function flag(value, fallback, label) { if (value === undefined) return fallback; if (typeof value !== 'boolean') fail(`${label}必须明确为true或false。`); return value; }
function doseMetadata(raw, previous) {
  const requirement = raw.requirement === undefined ? previous?.requirement ?? 'daily' : raw.requirement; if (!REQUIREMENTS.has(requirement)) fail('补给必需性无效。');
  const timingSlot = raw.timingSlot === undefined ? previous?.timingSlot ?? 'other' : raw.timingSlot; if (!DOSE_SLOTS.has(timingSlot)) fail('补给时段无效。');
  const scheduled = flag(raw.scheduled, raw.requirement === undefined ? previous?.scheduled ?? requirement === 'daily' : requirement === 'daily', '是否纳入当日计划');
  return { timingSlot, requirement, scheduled, instruction: str(raw.instruction === undefined ? previous?.instruction : raw.instruction, '补给用法说明', 1000, true), trainingDayOnly: flag(raw.trainingDayOnly, previous?.trainingDayOnly ?? false, '是否仅训练日') };
}
function doseScheduled(entity) { return entity.scheduled ?? (entity.requirement ?? 'daily') === 'daily'; }
export function supplementChecked(entity) { return (entity.actualEntries ?? []).some((entry) => entry.quantity === null || entry.quantity > 0); }
function dose(raw, items, previous) {
  obj(raw, '补给剂次'); const item = itemFor(items, id(raw.itemId, '补给ID')); if (item.category !== 'supplement') fail('补给剂次只能引用补给类别库存。');
  const unit = raw.unit === undefined ? item.unit : str(raw.unit, '补给单位', 20); if (unit !== item.unit) fail('补给使用库存物理单位，不自动换算mg或IU。');
  const preserve = previous?.id === id(raw.id) && previous.itemId === item.id && previous.unit === unit && previous.nutritionSnapshot !== undefined;
  return { id: id(raw.id), itemId: item.id, plannedQuantity: qty(raw.plannedQuantity, true), unit, ...doseMetadata(raw, previous), plannedMealId: raw.plannedMealId == null ? null : id(raw.plannedMealId), plannedTime: time(raw.plannedTime), plannedTimeText: str(raw.plannedTimeText, '计划时间原话', 500, true), sourceText: str(raw.sourceText, '补给原话', 10000, true), nutritionSnapshot: preserve ? clone(previous.nutritionSnapshot) : snapshot(item), actualEntries: previous?.actualEntries ?? [], actualTime: previous?.actualTime ?? null, actualTimeText: previous?.actualTimeText ?? '', actualMealId: previous?.actualMealId ?? null, reportSourceText: previous?.reportSourceText ?? '', reportHistory: previous?.reportHistory ?? [], completionReportedAt: previous?.completionReportedAt ?? null, state: previous?.state ?? 'reserved' };
}
function content(plan) { return { id: plan.id, date: plan.date, title: plan.title, timeZone: plan.timeZone, notes: plan.notes, meals: plan.meals.map((m) => ({ id: m.id, slot: m.slot, title: m.title, plannedTime: m.plannedTime, plannedTimeText: m.plannedTimeText, plannedItems: m.plannedItems.map(({ nutritionSnapshot, ...line }) => line) })), supplementDoses: plan.supplementDoses.map((d) => ({ id: d.id, itemId: d.itemId, plannedQuantity: d.plannedQuantity, unit: d.unit, ...doseMetadata(d), plannedMealId: d.plannedMealId, plannedTime: d.plannedTime, plannedTimeText: d.plannedTimeText, sourceText: d.sourceText })) }; }
function draftContent(plan) {
  const result = { ...content(plan), patchDraft: true };
  for (const m of result.meals) for (const line of m.plannedItems) line.nutritionSnapshot = clone(plan.meals.find(old => old.id === m.id).plannedItems.find(old => old.id === line.id).nutritionSnapshot);
  for (const d of result.supplementDoses) d.nutritionSnapshot = clone(plan.supplementDoses.find(old => old.id === d.id).nutritionSnapshot);
  return result;
}
function normalizePlan(raw, items, at, previous, inheritMissingDoses = true) {
  obj(raw, '饮食计划'); const planId = id(raw.id, '计划ID'); const zone = raw.timeZone ?? 'America/Toronto'; try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { fail('时区无效。'); }
  const meals = list(raw.meals, '餐次', 16).map((m) => meal(m, items, previous?.meals.find((p) => p.id === m.id))); unique(meals, '餐次');
  const incomingDoses = list(raw.supplementDoses ?? [], '补给剂次', 32).map((entry) => {
    obj(entry, '补给剂次');
    if (!previous || previous.supplementDoses.some((old) => old.id === entry.id)) return entry;
    const matches = previous.supplementDoses.filter((old) => old.itemId === entry.itemId && routineSlot(old, previous) === routineSlot(entry, { meals }));
    if (matches.length > 1) fail('同一补给时段有多个既有剂次，请读取并复用原剂次ID，不另建重复剂次。', 409, 'SUPPLEMENT_DOSE_AMBIGUOUS');
    return matches.length === 1 ? { ...entry, id: matches[0].id } : entry;
  });
  const inheritedDoses = previous && inheritMissingDoses ? previous.supplementDoses.filter((d) => !incomingDoses.some((entry) => entry.id === d.id) && (previous.supplementOnly || raw.supplementDoses === undefined || hasFacts(d))) : [];
  const doses = list([...incomingDoses, ...inheritedDoses], '当日补给剂次', 32).map((d) => dose(d, items, previous?.supplementDoses.find((p) => p.id === d.id))); unique(doses, '补给剂次');
  for (const d of doses) if (d.plannedMealId && !meals.some((m) => m.id === d.plannedMealId)) fail('补给关联的餐次不存在。');
  if (!meals.length && !doses.length) fail('计划至少包含一个餐次或补给剂次。');
  return { id: planId, format: 'meals_v1', date: date(raw.date), title: str(raw.title, '计划标题', 200), timeZone: zone, notes: str(raw.notes, '计划备注', 10000, true), meals, supplementDoses: doses, status: previous?.status ?? 'draft', items: previous?.items ?? [], accountedDebits: previous?.accountedDebits ?? [], allocationAdjustments: previous?.allocationAdjustments ?? {}, inventoryAccounting: previous?.inventoryAccounting ?? 'settled', accountingIssues: previous?.accountingIssues ?? [], ...(!previous || previous.foodAccounting === 'actual_only' || previous.status === 'draft' || previous.supplementOnly ? { foodAccounting: 'actual_only', supplementAccounting: 'actual_only' } : previous.supplementAccounting ? { supplementAccounting: previous.supplementAccounting } : {}), ...(previous?.legacyReservations ? { legacyReservations: clone(previous.legacyReservations) } : {}), ...(previous?.supplementOnly ? { supplementOnly: meals.length === 0 } : {}), ...(previous?.intakeDraft ? { intakeDraft: clone(previous.intakeDraft) } : {}), ...(previous?.intakeDraftAudit ? { intakeDraftAudit: clone(previous.intakeDraftAudit) } : {}), intakeBasis: previous?.intakeBasis ?? 'none', createdAt: previous?.createdAt ?? at, updatedAt: at };
}

// Historical plans may already have deducted their planned portions. Freeze that
// accounting basis before editing, so a later supplement check cannot reserve the
// newly edited menu or refund untouched historical credits.
function preservePlanAccounting(old, next) {
  // Personal reminders and the frozen automatic-accounting basis belong to
  // the server record, never to a replacement menu supplied by Chat.
  for (const key of ['personalFoodChecks', 'dailySettlement', 'accountingWarnings', 'accountingAdjustmentHistory']) if (old?.[key] !== undefined) next[key] = clone(old[key]);
  if (!old || next.foodAccounting === 'actual_only' || old.status === 'draft' || old.supplementOnly) return;
  next.legacyReservations = clone(old.legacyReservations ?? {
    meals: old.meals.map(m => ({ id: m.id, plannedItems: m.plannedItems.map(l => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit })) })),
    supplementDoses: old.supplementDoses.map(d => ({ id: d.id, itemId: d.itemId, plannedQuantity: d.plannedQuantity, unit: d.unit, scheduled: doseScheduled(d) })),
    allocationAdjustments: old.allocationAdjustments ?? {},
  });
}
function currentForWrite(state, plan) {
  const next = clone(projectCurrentDietPlan(plan, state.items));
  delete next.draft;
  if (plan.foodAccounting === 'actual_only' || plan.status === 'draft' || plan.supplementOnly) {
    next.foodAccounting = 'actual_only'; next.supplementAccounting = 'actual_only';
  }
  preservePlanAccounting(plan, next);
  if (next.meals.length && plan.supplementOnly) next.supplementOnly = false;
  return next;
}
/** A detached editing view; server-stored draft snapshots are not client inputs. */
export function materializeDietPlanForEdit(state, planOrId, view = 'draft') {
  if (!['draft', 'active'].includes(view)) fail('编辑视图必须为draft或active。');
  const planId = id(typeof planOrId === 'string' ? planOrId : planOrId?.id, '计划ID');
  const source = (state.plans ?? []).find(plan => plan.id === planId);
  if (!source) fail('找不到饮食计划。', 404, 'PLAN_NOT_FOUND');
  if (source.format !== 'meals_v1') fail('旧平铺计划不能作为餐次编辑视图。', 409, 'LEGACY_PLAN_CONFLICT');
  if (view === 'active' || !source.draft) return clone(source);
  const result = clone(projectCurrentDietPlan(source, state.items));
  delete result.draft;
  return result;
}

const PATCH_KEYS = new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mode', 'confirmed', 'allocationOnly', 'title', 'notes', 'mealPatches', 'supplementPatches']);
const MEAL_PATCH_KEYS = new Set(['id', 'remove', 'slot', 'title', 'plannedTime', 'plannedTimeText', 'itemPatches']);
const ITEM_PATCH_KEYS = new Set(['id', 'remove', 'itemId', 'name', 'quantity', 'unit', 'sourceText', 'nutrition']);
const NUTRITION_PATCH_KEYS = new Set(['basisAmount', 'basisUnit', 'kcal', 'protein', 'carbs', 'fat', 'source', 'sourceNote', 'sourceText', 'nutrientSources']);
const DOSE_PATCH_KEYS = new Set(['id', 'remove', 'itemId', 'plannedQuantity', 'unit', 'plannedMealId', 'plannedTime', 'plannedTimeText', 'sourceText', 'timingSlot', 'requirement', 'scheduled', 'instruction', 'trainingDayOnly']);
function patchObject(raw, keys, label) {
  obj(raw, label); if (Reflect.ownKeys(raw).some(key => !keys.has(key))) fail(`${label}包含不支持的字段；实际报告和快照不能由计划补丁覆盖。`, 400, 'UNKNOWN_PATCH_FIELD');
  if (raw.remove !== undefined && typeof raw.remove !== 'boolean') fail('remove必须明确为true或false。');
  if (raw.remove === true && Object.keys(raw).some(key => !['id', 'remove'].includes(key))) fail('remove=true不能与修改字段混用。');
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}
function patches(raw, keys, label, max) {
  const entries = list(raw === undefined ? [] : raw, label, max).map(value => { const result = patchObject(value, keys, label); return { ...result, id: id(result.id) }; });
  unique(entries, label); return entries;
}
function mergePatch(previous, patch) {
  const { remove, itemPatches, ...fields } = patch;
  return { ...(previous ?? {}), ...fields };
}
function patchPlan(base, payload, items) {
  const next = clone(base); delete next.draft;
  if (payload.title !== undefined) next.title = str(payload.title, '计划标题', 200);
  if (payload.notes !== undefined) next.notes = str(payload.notes, '计划备注', 10000, true);
  const mealPatches = patches(payload.mealPatches, MEAL_PATCH_KEYS, '餐次补丁', 16);
  const dosePatches = patches(payload.supplementPatches, DOSE_PATCH_KEYS, '补给补丁', 32);
  if (!mealPatches.length && !dosePatches.length && payload.title === undefined && payload.notes === undefined) fail('至少指定一个要修改的字段。');
  for (const patch of mealPatches) {
    const index = next.meals.findIndex(m => m.id === patch.id); const before = index < 0 ? null : next.meals[index];
    if (patch.remove) { if (!before) fail('要删除的餐次不存在。', 404, 'MEAL_NOT_FOUND'); next.meals.splice(index, 1); continue; }
    const input = mergePatch(before, patch);
    let changed = before ? clone(before) : meal({ ...input, plannedItems: [] }, items);
    if (patch.slot !== undefined) { if (!SLOTS.has(patch.slot)) fail('餐次类型无效。'); changed.slot = patch.slot; }
    if (patch.title !== undefined) changed.title = str(patch.title, '餐次标题', 200);
    if (patch.plannedTime !== undefined) changed.plannedTime = time(patch.plannedTime);
    if (patch.plannedTimeText !== undefined) changed.plannedTimeText = str(patch.plannedTimeText, '计划时间原话', 500, true);
    for (const linePatch of patches(patch.itemPatches, ITEM_PATCH_KEYS, '食物补丁', 100)) {
      const lineIndex = changed.plannedItems.findIndex(line => line.id === linePatch.id); const oldLine = lineIndex < 0 ? null : changed.plannedItems[lineIndex];
      if (linePatch.remove) { if (!oldLine) fail('要删除的食物行不存在。', 404, 'LINE_NOT_FOUND'); changed.plannedItems.splice(lineIndex, 1); continue; }
      const raw = mergePatch(oldLine, linePatch); delete raw.nutritionSnapshot;
      if (oldLine && raw.itemId !== oldLine.itemId) {
        for (const key of ['unit', 'name', 'sourceText']) if (linePatch[key] === undefined) delete raw[key];
        const newItem = raw.itemId === null ? null : itemFor(items, id(raw.itemId, '食材ID'));
        if (newItem && newItem.unit !== oldLine.unit && linePatch.quantity === undefined) fail('替换食品的单位不同，必须明确新食品quantity，不能沿用旧数量换算。');
      }
      if (linePatch.nutrition !== undefined) {
        patchObject(linePatch.nutrition, NUTRITION_PATCH_KEYS, '计划营养');
        if (linePatch.nutrition.nutrientSources !== undefined) patchObject(linePatch.nutrition.nutrientSources, new Set(['kcal', 'protein', 'carbs', 'fat']), '营养来源');
      }
      const identityChanged = oldLine && (raw.itemId !== oldLine.itemId || raw.unit !== oldLine.unit || raw.itemId === null && raw.name !== oldLine.name);
      if (identityChanged && linePatch.nutrition === undefined) delete raw.nutrition;
      if (identityChanged && linePatch.sourceText === undefined) delete raw.sourceText;
      if (linePatch.name !== undefined && raw.itemId !== null) fail('库存食品名称来自库存；替换食品请修改itemId，name只用于未跟踪食品。');
      const line = plannedLine(raw, items, identityChanged ? undefined : oldLine);
      if (lineIndex < 0) changed.plannedItems.push(line); else changed.plannedItems[lineIndex] = line;
    }
    list(changed.plannedItems, '计划食物', 100); unique(changed.plannedItems, '计划食物');
    if (index < 0) next.meals.push(changed); else next.meals[index] = changed;
  }
  for (const patch of dosePatches) {
    const index = next.supplementDoses.findIndex(d => d.id === patch.id); const before = index < 0 ? null : next.supplementDoses[index];
    if (patch.remove) { if (!before) fail('要删除的补给剂次不存在。', 404, 'DOSE_NOT_FOUND'); next.supplementDoses.splice(index, 1); continue; }
    const input = mergePatch(before, patch);
    if (before && input.itemId !== before.itemId) {
      for (const key of ['unit', 'sourceText']) if (patch[key] === undefined) delete input[key];
      if (itemFor(items, id(input.itemId, '补给ID')).unit !== before.unit && patch.plannedQuantity === undefined) fail('替换补给的单位不同，必须明确新补给plannedQuantity，未知填null。');
    }
    const changed = dose(input, items, before);
    if (index < 0) next.supplementDoses.push(changed); else next.supplementDoses[index] = changed;
  }
  list(next.meals, '餐次', 16); list(next.supplementDoses, '补给剂次', 32);
  for (const d of next.supplementDoses) if (d.plannedMealId && !next.meals.some(m => m.id === d.plannedMealId) || d.actualMealId && !next.meals.some(m => m.id === d.actualMealId)) fail('餐次仍被补给计划或实际报告引用，不能删除；计划关联须明确修改，实际关联须保留。', 409, 'MEAL_REFERENCE_CONFLICT');
  if (!next.meals.length && !next.supplementDoses.length) fail('计划至少包含一个餐次或补给剂次。');
  return next;
}
function hasFacts(entity) { return entity.actualEntries.length > 0 || entity.completionReportedAt !== null || entity.actualTime !== null || !!entity.actualTimeText || !!entity.reportHistory?.length; }
function anyFacts(plan) { return [...plan.meals, ...plan.supplementDoses].some(hasFacts); }
function samePlanned(a, b, supplement = false) { return supplement ? equal([a.itemId, a.plannedQuantity, a.unit], [b.itemId, b.plannedQuantity, b.unit]) : equal(a.plannedItems.map(({ nutritionSnapshot, sourceText, ...line }) => line), b.plannedItems.map(({ nutritionSnapshot, sourceText, ...line }) => line)); }
function actualFacts(entity, supplement = false) {
  const keys = ['actualEntries', 'actualTime', 'actualTimeText', 'completionReportedAt', 'reportHistory', 'state', ...(supplement ? ['actualMealId', 'reportSourceText'] : ['sourceText'])];
  return Object.fromEntries(keys.map(key => [key, entity[key]]));
}
function guardEdits(old, next) {
  if (old.date !== next.date) fail('同一canonical计划不能改日期；请在目标日期沿用该日计划ID。', 409, 'PLAN_DATE_CONFLICT');
  for (const [key, supplement] of [['meals', false], ['supplementDoses', true]]) for (const before of old[key]) {
    const after = next[key].find(e => e.id === before.id);
    if (hasFacts(before) && (!after || supplement && !samePlanned(before, after, true))) fail('已有实际记录的餐次不能删除，已服补给不能被计划修改覆盖；请关联原记录更正实际。', 409, 'CONSUMED_MEAL_CONFLICT');
    if (after && !equal(actualFacts(before, supplement), actualFacts(after, supplement))) fail('计划修改不能更改实际条目、时间、原话或完成状态。', 409, 'ACTUAL_FACTS_CONFLICT');
  }
}
function mealPlanFields(entity) {
  return clone(Object.fromEntries(['slot', 'title', 'plannedTime', 'plannedTimeText', 'plannedItems'].map(key => [key, entity[key]])));
}
function recordMealPlanRevisions(old, next, at) {
  if (old?.status !== 'reserved') return;
  for (const before of old.meals) {
    const after = next.meals.find(meal => meal.id === before.id);
    if (!after || equal(mealPlanFields(before), mealPlanFields(after))) continue;
    const history = before.planRevisionHistory ?? [];
    if (history.length >= 200) fail('单餐计划修改历史已达200条，请先备份整理；本次修改未保存。', 409, 'MEAL_PLAN_HISTORY_LIMIT');
    after.planRevisionHistory = [...clone(history), { at, previous: mealPlanFields(before) }];
  }
}
function add(map, itemId, quantity, unit) { const old = map.get(itemId); if (old && old.unit !== unit) fail('同一食材记录出现单位冲突。', 409, 'UNIT_CONFLICT'); const total = round((old?.quantity ?? 0) + quantity); if (total > MAX) fail('同一食材累计数量超出记账上限。', 409, 'QUANTITY_OVERFLOW'); map.set(itemId, { itemId, quantity: total, unit }); }
function plannedFoodTotals(plan) { const result = new Map(); for (const m of plan.meals) for (const l of m.plannedItems) add(result, l.itemId === null ? JSON.stringify(['untracked', nameKey(l.name), l.unit]) : JSON.stringify(['tracked', l.itemId]), l.quantity, l.unit); return result; }
function canonicalTotals(map) { return [...map.values()].sort((a, b) => a.itemId.localeCompare(b.itemId)); }
function entityTarget(entity, supplement, issues, reservePlanned = true) {
  const result = new Map(); const actual = new Map();
  for (const e of entity.actualEntries) if (e.itemId !== null) {
    if (e.quantity === null) issues.push({ code: 'ACTUAL_QUANTITY_UNKNOWN', itemId: e.itemId, message: '实际已吃但数量未知，保留原话等待核对。' });
    else add(actual, e.itemId, e.quantity, e.unit);
  }
  const planned = new Map(); if (supplement) { if (reservePlanned && doseScheduled(entity) && entity.plannedQuantity !== null) add(planned, entity.itemId, entity.plannedQuantity, entity.unit); } else if (reservePlanned) for (const l of entity.plannedItems) if (l.itemId !== null) add(planned, l.itemId, l.quantity, l.unit);
  if (!entity.actualEntries.length && !entity.accountingHadActualEntries && hasFacts(entity)) for (const itemId of supplement ? [entity.itemId] : planned.keys()) issues.push({ code: 'ACTUAL_QUANTITY_UNKNOWN', itemId, message: '已报告时间或进食原话，但没有实际数量；不把缺失当作没吃。' });
  for (const itemId of new Set([...actual.keys(), ...planned.keys()])) {
    const p = planned.get(itemId); const a = actual.get(itemId); const quantity = ['completed', 'cancelled'].includes(entity.state) ? a?.quantity ?? 0 : Math.max(p?.quantity ?? 0, a?.quantity ?? 0);
    if (quantity > 0) add(result, itemId, quantity, a?.unit ?? p.unit);
  }
  return result;
}
function targets(plan, alreadyProjected = false) {
  if (!alreadyProjected) plan = dailyMenuAccountingPlan(plan);
  const issues = []; const food = new Map(); const actualFood = new Map(); const all = new Map();
  const reserveFood = plan.foodAccounting !== 'actual_only';
  const legacy = plan.legacyReservations;
  const closed = ['cancelled', 'closed_with_actuals'].includes(plan.status);
  const liveMealsFinished = plan.meals.every(m => ['completed', 'cancelled'].includes(m.state));
  const accountingMeals = legacy ? [
    ...legacy.meals.map(frozen => {
      const current = plan.meals.find(m => m.id === frozen.id);
      return { ...(current ?? { actualEntries: [], actualTime: null, actualTimeText: '', completionReportedAt: null, sourceText: '', reportHistory: [], state: closed || liveMealsFinished ? 'cancelled' : 'reserved' }), plannedItems: frozen.plannedItems };
    }),
    ...plan.meals.filter(m => !legacy.meals.some(frozen => frozen.id === m.id)).map(m => ({ ...m, plannedItems: [] })),
  ] : plan.meals;
  for (const m of accountingMeals) {
    for (const l of entityTarget(m, false, issues, reserveFood).values()) add(food, l.itemId, l.quantity, l.unit);
    for (const e of m.actualEntries) if (e.itemId !== null && e.quantity !== null) add(actualFood, e.itemId, e.quantity, e.unit);
  }
  const foodFinished = accountingMeals.every((m) => ['completed', 'cancelled'].includes(m.state));
  const adjustments = reserveFood ? legacy?.allocationAdjustments ?? plan.allocationAdjustments ?? {} : {};
  for (const itemId of new Set([...food.keys(), ...actualFood.keys(), ...Object.keys(adjustments)])) {
    const line = food.get(itemId) ?? actualFood.get(itemId) ?? plan.accountedDebits.find((l) => l.itemId === itemId);
    const quantity = foodFinished ? actualFood.get(itemId)?.quantity ?? 0 : Math.max(actualFood.get(itemId)?.quantity ?? 0, round((food.get(itemId)?.quantity ?? 0) + (adjustments[itemId] ?? 0)));
    if (quantity > 0) add(all, itemId, quantity, line.unit);
  }
  const accountingDoses = legacy ? [
    ...legacy.supplementDoses.map(frozen => ({ ...(plan.supplementDoses.find(d => d.id === frozen.id) ?? { actualEntries: [], actualTime: null, actualTimeText: '', completionReportedAt: null, reportHistory: [], state: closed ? 'cancelled' : 'reserved' }), ...frozen })),
    ...plan.supplementDoses.filter(d => !legacy.supplementDoses.some(frozen => frozen.id === d.id)).map(d => ({ ...d, scheduled: false })),
  ] : plan.supplementDoses;
  for (const d of accountingDoses) for (const l of entityTarget(d, true, issues, plan.supplementAccounting !== 'actual_only').values()) add(all, l.itemId, l.quantity, l.unit);
  return { lines: all, issues };
}
function isBlockingAccountingIssue(issue, items) {
  // An unknown actual dose cannot make an already unknown balance less exact.
  // Keep the report unknown, while retaining every other accounting safeguard.
  return issue.code !== 'ACTUAL_QUANTITY_UNKNOWN' || items.find((item) => item.id === issue.itemId)?.quantity !== null;
}
function unknownActualUnitIssues(plan, items) {
  const issues = [];
  // A completed unknown quantity has no target debit. Inspect the original
  // entry as well, including legacy plans whose saved issues lack this check.
  for (const entity of [...plan.meals, ...plan.supplementDoses]) for (const entry of entity.actualEntries) {
    const current = entry.quantity === null && entry.unit ? items.find((item) => item.id === entry.itemId) : null;
    if (current && entry.unit !== current.unit && !issues.some((issue) => issue.itemId === current.id)) issues.push({ code: 'UNIT_CONFLICT', itemId: current.id, message: '实际单位和库存单位不同，不自动换算。' });
  }
  return issues;
}
function accountingTargetIds(plan, previous) {
  const ids = new Set(previous.keys());
  for (const meal of [...plan.meals, ...(plan.legacyReservations?.meals ?? [])]) {
    for (const line of [...(meal.plannedItems ?? []), ...(meal.actualEntries ?? [])]) if (line.itemId !== null) ids.add(line.itemId);
  }
  for (const dose of [...plan.supplementDoses, ...(plan.legacyReservations?.supplementDoses ?? [])]) {
    if (dose.itemId !== null) ids.add(dose.itemId);
    for (const entry of dose.actualEntries ?? []) if (entry.itemId !== null) ids.add(entry.itemId);
  }
  for (const key of Object.keys(plan.legacyReservations?.allocationAdjustments ?? plan.allocationAdjustments ?? {})) ids.add(key);
  return ids;
}
function isolateTargetItem(plan, itemId) {
  // Filtering another food out must not turn an originally itemized report
  // into a time-only report whose saved planned amount is now "unknown".
  const meal = value => ({ ...value, plannedItems: (value.plannedItems ?? []).filter(line => line.itemId === itemId),
    actualEntries: (value.actualEntries ?? []).filter(entry => entry.itemId === itemId),
    accountingHadActualEntries: (value.actualEntries?.length ?? 0) > 0 });
  const doses = values => values.filter(value => value.itemId === itemId || value.actualEntries?.some(entry => entry.itemId === itemId)).map(value => ({ ...value,
    actualEntries: (value.actualEntries ?? []).filter(entry => entry.itemId === itemId), accountingHadActualEntries: (value.actualEntries?.length ?? 0) > 0,
    ...(value.itemId === itemId ? {} : { plannedQuantity: null, scheduled: false }) }));
  const adjustments = values => Object.hasOwn(values ?? {}, itemId) ? { [itemId]: values[itemId] } : {};
  return { ...plan, meals: plan.meals.map(meal), supplementDoses: doses(plan.supplementDoses),
    accountedDebits: plan.accountedDebits.filter(line => line.itemId === itemId), allocationAdjustments: adjustments(plan.allocationAdjustments),
    ...(plan.legacyReservations ? { legacyReservations: { ...plan.legacyReservations,
      meals: plan.legacyReservations.meals.map(meal), supplementDoses: plan.legacyReservations.supplementDoses.filter(value => value.itemId === itemId),
      allocationAdjustments: adjustments(plan.legacyReservations.allocationAdjustments) } } : {}) };
}
function itemTargets(plan, previous, allowPending) {
  const projected = dailyMenuAccountingPlan(plan);
  if (!allowPending) return { ...targets(projected, true), projected };
  const lines = new Map(), issues = [];
  for (const itemId of accountingTargetIds(projected, previous)) {
    try {
      const result = targets(isolateTargetItem(projected, itemId), true);
      if (result.lines.has(itemId)) lines.set(itemId, result.lines.get(itemId));
      issues.push(...result.issues);
    } catch (error) {
      if (!['UNIT_CONFLICT', 'QUANTITY_OVERFLOW'].includes(error.code)) throw error;
      issues.push({ code: error.code, itemId, message: error.message });
    }
  }
  return { lines, issues, projected };
}
function shortfallWarnings(lines) {
  return lines.filter(line => (line.shortfallQuantity ?? 0) > 0).map(line => ({ code: 'STOCK_SHORTFALL_RECORDED', itemId: line.itemId,
    quantity: line.shortfallQuantity, unit: line.unit, message: `该食材已按摄入依据完成结算，账面不足${line.shortfallQuantity} ${line.unit}已记差额，库存最低为0；原摄入依据保留，重复请求不再扣减。` }));
}
function settle(items, old, next, at, allowPending = false, preserveDebit = false) {
  const previous = new Map((old?.accountedDebits ?? []).map((l) => [l.itemId, l]));
  const target = itemTargets(next, previous, allowPending);
  const issues = [...target.issues, ...unknownActualUnitIssues(next, items)].filter((issue) => isBlockingAccountingIssue(issue, items));
  if (preserveDebit) {
    // Explicit redistribution changes attribution, not the day's inventory debit.
    const oldFood = new Map(); const newFood = new Map();
    for (const m of old.meals) for (const l of entityTarget(m, false, []).values()) add(oldFood, l.itemId, l.quantity, l.unit);
    for (const m of next.meals) for (const l of entityTarget(m, false, []).values()) add(newFood, l.itemId, l.quantity, l.unit);
    next.allocationAdjustments = { ...(old.allocationAdjustments ?? {}) };
    for (const itemId of new Set([...oldFood.keys(), ...newFood.keys()])) next.allocationAdjustments[itemId] = round((next.allocationAdjustments[itemId] ?? 0) + (oldFood.get(itemId)?.quantity ?? 0) - (newFood.get(itemId)?.quantity ?? 0));
    next.items = clone(old.items); next.accountedDebits = clone(old.accountedDebits); return { items, plan: next };
  }
  const nextLines = [], changes = new Map(), adjustments = [];
  const supplementIds = new Set([...target.projected.supplementDoses, ...(target.projected.legacyReservations?.supplementDoses ?? [])].map(dose => dose.itemId));
  for (const itemId of new Set([...previous.keys(), ...target.lines.keys()])) {
    const before = previous.get(itemId); const after = target.lines.get(itemId); const current = items.find((i) => i.id === itemId); const delta = round((after?.quantity ?? 0) - (before?.quantity ?? 0));
    if (!current) { issues.push({ code: 'ITEM_NOT_FOUND', itemId, message: '实际或原预留所引用库存已不存在。' }); if (before) nextLines.push(clone(before)); continue; }
    if (after && after.unit !== current.unit) issues.push({ code: 'UNIT_CONFLICT', itemId, message: '实际单位和库存单位不同，不自动换算。' });
    if (before && after && before.unit !== after.unit) issues.push({ code: 'BASELINE_REQUIRES_REVIEW', itemId, message: '原预留和新用量单位不同，不能因数字相同就重新解释旧账；请先核对盘点。' });
    const priorShortfall = before?.shortfallQuantity ?? 0;
    if (!Number.isFinite(priorShortfall) || priorShortfall < 0 || priorShortfall > (before?.quantity ?? 0)) issues.push({ code: 'INVALID_ACCOUNTING_SHORTFALL', itemId, message: '原账短缺记录无效，已保留该项等待核对。' });
    let stockDelta = delta, shortfall = priorShortfall;
    if (delta !== 0) {
      if (before && (baseline(current) !== before.baselineToken || current.unit !== before.unit || (current.quantity === null) !== before.unknownBalance)) issues.push({ code: 'BASELINE_REQUIRES_REVIEW', itemId, message: '库存已重新盘点或单位已变，不能自动加减旧账。' });
      if (delta > 0 && ['archived', 'pending'].includes(current.status)) issues.push({ code: 'ITEM_UNAVAILABLE', itemId, message: '食材已归档或待核，不能可靠扣减。' });
      if (delta < 0) {
        // A correction first removes the part never withdrawn from stock. Only
        // a genuinely deducted portion may be returned to the same baseline.
        const absorbed = Math.min(priorShortfall, -delta);
        stockDelta = round(delta + absorbed); shortfall = round(priorShortfall - absorbed);
      }
      if (current.quantity !== null && round(current.quantity - stockDelta) < 0) {
        const actual = target.projected.meals.flatMap(meal => meal.actualEntries).filter(entry => entry.itemId === itemId);
        const fullyReported = actual.every(entry => entry.quantity !== null && entry.unit === after?.unit)
          && round(actual.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0)) >= (after?.quantity ?? 0);
        if (allowPending && current.category !== 'supplement' && !supplementIds.has(itemId) && fullyReported) {
          shortfall = round(priorShortfall + stockDelta - current.quantity); stockDelta = current.quantity;
        } else issues.push({ code: 'INSUFFICIENT_STOCK', itemId, message: '实际或预留用量超过账面可用量，等待核对。' });
      }
      if (current.quantity !== null && round(current.quantity - stockDelta) > MAX) issues.push({ code: 'QUANTITY_OVERFLOW', itemId, message: '退回后的库存超出数量上限。' });
    }
    if (issues.some(issue => issue.itemId === itemId)) { if (before) nextLines.push(clone(before)); continue; }
    // An unchanged debit is historical credit, even after an independent count.
    // Never silently rebase or rewrite it while retrying another ingredient.
    if (delta === 0) { if (before) nextLines.push(clone(before)); continue; }
    if (after) nextLines.push({ ...after, name: current.name, unknownBalance: before?.unknownBalance ?? current.quantity === null,
      baselineToken: before?.baselineToken ?? baseline(current), ...(shortfall > 0 ? { shortfallQuantity: shortfall } : {}) });
    const quantity = current.quantity === null ? null : round(current.quantity - stockDelta);
    const status = ['archived', 'pending'].includes(current.status) ? current.status : quantity === 0 ? 'depleted' : 'available';
    if (stockDelta !== 0 || status !== current.status) changes.set(itemId, { ...current, quantity, status,
      quantityBaselineToken: baseline(current), updatedAt: at, confirmedAt: at });
    if (shortfall !== priorShortfall) adjustments.push({ at, itemId, unit: current.unit,
      code: shortfall > priorShortfall ? 'STOCK_SHORTFALL_RECORDED' : 'STOCK_SHORTFALL_REDUCED',
      basis: next.dailySettlement?.source === 'automatic_menu' ? 'automatic_menu' : 'reported_actual',
      targetBefore: before?.quantity ?? 0, targetAfter: after?.quantity ?? 0,
      stockBefore: current.quantity, stockAfter: quantity, shortfallBefore: priorShortfall, shortfallAfter: shortfall, inventoryDelta: stockDelta });
  }
  if (issues.length) {
    if (!allowPending) fail(issues[0].message, 409, issues[0].code);
  }
  const updated = items.map(current => changes.get(current.id) ?? current);
  next.accountedDebits = nextLines; next.items = clone(nextLines);
  next.inventoryAccounting = issues.length ? 'pending_reconciliation' : 'settled'; next.accountingIssues = issues;
  const warnings = [...(old?.accountingWarnings ?? []).filter(warning => warning.code !== 'STOCK_SHORTFALL_RECORDED'), ...shortfallWarnings(nextLines)];
  if (warnings.length || old?.accountingWarnings !== undefined) next.accountingWarnings = warnings;
  if (adjustments.length) next.accountingAdjustmentHistory = [...clone(old?.accountingAdjustmentHistory ?? []), ...adjustments];
  else if (old?.accountingAdjustmentHistory !== undefined) next.accountingAdjustmentHistory = clone(old.accountingAdjustmentHistory);
  refreshDailySettlementAccounting(next, at);
  return { items: updated, plan: next };
}
function refreshDailySettlementAccounting(plan, at) {
  if (plan.dailySettlement?.source !== 'automatic_menu') return;
  plan.dailySettlement = { ...plan.dailySettlement, accounting: plan.inventoryAccounting,
    settledAt: plan.inventoryAccounting === 'settled' ? plan.dailySettlement.settledAt ?? at : plan.dailySettlement.settledAt,
    lastReconciledAt: at, assumedMealIds: dailyMenuAssumedMealIds(plan) };
}
function settleFoodOnly(items, old, next, at) {
  const supplementIds = new Set([
    ...items.filter(item => item.category === 'supplement').map(item => item.id),
    ...[...old.supplementDoses, ...next.supplementDoses].flatMap(dose => [dose.itemId, ...dose.actualEntries.map(entry => entry.itemId)]),
    ...(old.legacyReservations?.supplementDoses ?? []).map(dose => dose.itemId),
  ].filter(Boolean));
  const supplementLine = line => supplementIds.has(line.itemId);
  const isolate = plan => ({ ...clone(plan), supplementDoses: [],
    items: plan.items.filter(line => !supplementLine(line)), accountedDebits: plan.accountedDebits.filter(line => !supplementLine(line)),
    accountingIssues: plan.accountingIssues.filter(issue => !issue.itemId || !supplementIds.has(issue.itemId)),
    ...(plan.accountingWarnings ? { accountingWarnings: plan.accountingWarnings.filter(warning => !supplementIds.has(warning.itemId)) } : {}),
    ...(plan.legacyReservations ? { legacyReservations: { ...clone(plan.legacyReservations), supplementDoses: [] } } : {}) });
  const result = settle(items, isolate(old), isolate(next), at, true);
  next.accountedDebits = [...result.plan.accountedDebits, ...clone(old.accountedDebits.filter(supplementLine))];
  next.items = [...result.plan.items, ...clone(old.items.filter(supplementLine))];
  next.accountingIssues = [...result.plan.accountingIssues, ...clone(old.accountingIssues.filter(issue => issue.itemId && supplementIds.has(issue.itemId)))];
  next.inventoryAccounting = next.accountingIssues.length ? 'pending_reconciliation' : 'settled';
  next.dailySettlement = result.plan.dailySettlement;
  if (result.plan.accountingWarnings !== undefined || old.accountingWarnings !== undefined) next.accountingWarnings = [...(result.plan.accountingWarnings ?? []), ...clone((old.accountingWarnings ?? []).filter(warning => supplementIds.has(warning.itemId)))];
  if (result.plan.accountingAdjustmentHistory !== undefined) next.accountingAdjustmentHistory = clone(result.plan.accountingAdjustmentHistory);
  return { items: result.items, plan: next };
}
function settleSupplements(items, old, next, at) {
  const supplementIds = new Set([...old.supplementDoses, ...next.supplementDoses].flatMap(d => [d.itemId, ...d.actualEntries.map(entry => entry.itemId)]).filter(Boolean));
  const isSupplementLine = line => supplementIds.has(line.itemId);
  const foodDebits = clone(old.accountedDebits.filter(line => !isSupplementLine(line)));
  const foodItems = clone(old.items.filter(line => !isSupplementLine(line)));
  const foodIssues = clone(old.accountingIssues.filter(issue => issue.itemId && !supplementIds.has(issue.itemId)));
  const isolated = plan => { const isolatedPlan = { ...clone(plan), meals: [], allocationAdjustments: {}, items: plan.items.filter(isSupplementLine), accountedDebits: plan.accountedDebits.filter(isSupplementLine), accountingIssues: plan.accountingIssues.filter(issue => !issue.itemId || supplementIds.has(issue.itemId)), ...(plan.accountingWarnings ? { accountingWarnings: plan.accountingWarnings.filter(warning => supplementIds.has(warning.itemId)) } : {}), ...(plan.legacyReservations ? { legacyReservations: { ...clone(plan.legacyReservations), meals: [], allocationAdjustments: {} } } : {}) }; delete isolatedPlan.dailySettlement; return isolatedPlan; };
  const result = settle(items, isolated(old), isolated(next), at, true);
  const preserveOrder = (previous, foodLines, supplementLines) => {
    const lines = new Map([...foodLines, ...supplementLines].map(line => [line.itemId, line]));
    return [...previous.filter(line => lines.has(line.itemId)).map(line => { const result = lines.get(line.itemId); lines.delete(line.itemId); return result; }), ...lines.values()];
  };
  next.accountedDebits = preserveOrder(old.accountedDebits, foodDebits, result.plan.accountedDebits);
  next.items = preserveOrder(old.items, foodItems, result.plan.items);
  next.accountingIssues = [...foodIssues, ...result.plan.accountingIssues];
  next.inventoryAccounting = next.accountingIssues.length ? 'pending_reconciliation' : 'settled';
  if (result.plan.accountingWarnings !== undefined || old.accountingWarnings !== undefined) next.accountingWarnings = [...clone((old.accountingWarnings ?? []).filter(warning => !supplementIds.has(warning.itemId))), ...(result.plan.accountingWarnings ?? [])];
  if (result.plan.accountingAdjustmentHistory !== undefined) next.accountingAdjustmentHistory = clone(result.plan.accountingAdjustmentHistory);
  return { items: result.items, plan: next };
}
const NUTRITION_CORRECTION_KEYS = new Set(['entryId', 'nutrition', 'gramsPerUnit', 'fromPlannedLineId', 'sourceText']);
const NUTRITION_CORRECTION_PAYLOAD_KEYS = new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mealId', 'mode', 'nutritionCorrections']);
const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const DISCRETE_NUTRITION_UNITS = new Set(['袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
function correctionNutrition(raw) {
  patchObject(raw, NUTRITION_PATCH_KEYS, '实际营养');
  for (const key of ['basisAmount', 'basisUnit', 'source', ...NUTRIENT_KEYS]) if (!Object.hasOwn(raw, key) || raw[key] === undefined) fail('营养更正必须提供完整口径、source及四项显式数字或null；不能省略旧值或盲目换口径。');
  if (!SOURCES.has(raw.source)) fail('实际营养来源无效。');
  if (raw.nutrientSources !== undefined) patchObject(raw.nutrientSources, new Set(NUTRIENT_KEYS), '实际营养来源');
  const result = untrackedNutrition(raw, raw.basisUnit);
  if (!result.sourceNote.trim() && !result.sourceText.trim()) fail('实际营养更正须提供sourceNote或sourceText说明依据。');
  if (NUTRIENT_KEYS.some(key => result[key] !== null && result.nutrientSources[key] === 'unknown')) fail('已提供的实际营养数值必须明确标签、配方或估算来源。');
  return result;
}
function sameNutritionFood(line, entry) {
  return line.itemId === entry.itemId && line.unit === entry.unit && (entry.itemId !== null || nameKey(line.name) === nameKey(entry.name));
}
function nutritionSnapshotBase(entry) {
  return entry.nutritionSnapshot == null ? { name: entry.name, unit: entry.unit, nutrition: untrackedNutrition(undefined, entry.unit), gramsPerUnit: null, ingredients: '', supplementFacts: '' } : clone(entry.nutritionSnapshot);
}
function correctMealNutrition(state, payload, at) {
  patchObject(payload, NUTRITION_CORRECTION_PAYLOAD_KEYS, '营养独立更正');
  if (payload.mode !== undefined && payload.mode !== 'correct') fail('营养独立更正mode只能省略或correct，不能混合进食、时间或补给报告。');
  const planId = id(payload.planId, '计划ID'), mealId = id(payload.mealId, '餐次ID');
  const plans = (state.plans ?? []).slice(), index = plans.findIndex(plan => plan.id === planId), old = plans[index];
  if (!old) fail('找不到饮食计划。', 404, 'PLAN_NOT_FOUND');
  if (old.format !== 'meals_v1') fail('营养独立更正仅用于结构化餐次实际记录。', 409, 'LEGACY_PLAN_CONFLICT');
  if (!['draft', 'reserved', 'closed_with_actuals'].includes(old.status)) fail('营养独立更正须关联开放或已完成菜单的实际记录。', 409, 'PLAN_CLOSED');
  const next = clone(old), meal = next.meals.find(meal => meal.id === mealId);
  if (!meal) fail('找不到餐次。', 404, 'MEAL_NOT_FOUND');
  const corrections = list(payload.nutritionCorrections, '实际营养更正', 100).map(raw => {
    patchObject(raw, NUTRITION_CORRECTION_KEYS, '实际营养更正');
    const result = { ...raw, entryId: str(raw.entryId, '实际记录ID', 400).trim(), sourceText: str(raw.sourceText, '营养更正依据', 10000) };
    if (raw.nutrition === undefined && raw.gramsPerUnit === undefined && raw.fromPlannedLineId === undefined) fail('至少指定nutrition、gramsPerUnit或fromPlannedLineId一项。');
    if (raw.nutrition !== undefined && raw.fromPlannedLineId !== undefined) fail('nutrition和fromPlannedLineId不能同时提供。');
    return result;
  });
  if (!corrections.length) fail('至少提供一条实际营养更正。');
  unique(corrections.map(raw => ({ id: raw.entryId })), '实际营养更正');
  let changed = 0;
  for (const correction of corrections) {
    const entry = meal.actualEntries.find(entry => entry.id === correction.entryId);
    if (!entry) fail('找不到本餐需要更正营养的实际记录。', 404, 'ACTUAL_NOT_FOUND');
    const previous = entry.nutritionSnapshot == null ? null : clone(entry.nutritionSnapshot), nextSnapshot = nutritionSnapshotBase(entry);
    if (correction.fromPlannedLineId !== undefined) {
      const line = meal.plannedItems.find(line => line.id === id(correction.fromPlannedLineId, '计划食物行ID'));
      if (!line) fail('找不到当前已确认餐次的计划食物行；不能引用未确认草稿。', 404, 'PLANNED_LINE_NOT_FOUND');
      if (!sameNutritionFood(line, entry)) fail('计划营养引用必须与本餐实际食物身份及单位一致，不能跨食物或单位复制。', 409, 'NUTRITION_IDENTITY_CONFLICT');
      if (!line.nutritionSnapshot?.nutrition) fail('计划行没有可引用的营养依据。', 409, 'PLAN_NUTRITION_UNKNOWN');
      nextSnapshot.nutrition = clone(line.nutritionSnapshot.nutrition);
    } else if (correction.nutrition !== undefined) nextSnapshot.nutrition = correctionNutrition(correction.nutrition);
    if (correction.gramsPerUnit !== undefined) {
      const grams = qty(correction.gramsPerUnit, true);
      if (grams !== null && (entry.unit === 'ml' || nextSnapshot.nutrition?.basisUnit === 'ml' || !DISCRETE_NUTRITION_UNITS.has(entry.unit) && !(entry.unit === 'g' && DISCRETE_NUTRITION_UNITS.has(nextSnapshot.nutrition?.basisUnit)))) fail('本条克重仅用于明确的离散单位与g换算，不能把ml或活性成分mg当成g。');
      nextSnapshot.gramsPerUnit = grams;
    }
    if (equal(previous, nextSnapshot)) continue;
    const history = entry.nutritionCorrectionHistory ?? [];
    if (history.length >= 100) fail('实际条目的营养更正历史已达100条，请先备份整理。', 409, 'NUTRITION_HISTORY_LIMIT');
    entry.nutritionSnapshot = nextSnapshot;
    entry.nutritionCorrectionHistory = [...history, { at, sourceText: correction.sourceText, previous }];
    changed++;
  }
  if (!changed) return { items: state.items, plans: state.plans ?? [], detail: '实际营养依据未改变，未重复更正或扣减。', inventoryEffect: 'none', noChange: true };
  next.updatedAt = at; plans[index] = next;
  // This branch intentionally skips report(), settle(), and pending-item flags.
  // Nutrition evidence changes never count as another intake or re-settle old stock.
  return { items: state.items, plans, detail: '已仅更正实际条目的营养或单位克重依据；数量、实际时间、进食原话与库存账务未变化，营养仍按所存口径计算。', inventoryEffect: 'none' };
}
const ACTUAL_NUTRITION_PREFIX = 'actual-nutrition:';
const NUTRITION_BRIDGE_KEYS = new Set(['action', 'operationId', 'expectedRevision', 'planId', 'mode', 'confirmed', 'mealPatches']);
const NUTRITION_BRIDGE_MEAL_KEYS = new Set(['id', 'itemPatches']);
const NUTRITION_BRIDGE_ITEM_KEYS = new Set(['id', 'nutrition', 'sourceText']);
function hasActualNutritionResource(payload) {
  return Array.isArray(payload.mealPatches) && payload.mealPatches.some(meal => Array.isArray(meal?.itemPatches) && meal.itemPatches.some(item => typeof item?.id === 'string' && item.id.startsWith(ACTUAL_NUTRITION_PREFIX)));
}
function correctActualNutritionResource(state, payload, at) {
  patchObject(payload, NUTRITION_BRIDGE_KEYS, '实际营养资源更正');
  if (payload.mode !== 'apply' || payload.confirmed !== true) fail('actual-nutrition资源更正必须mode=apply且confirmed=true，不能保存为计划草稿。');
  const meals = list(payload.mealPatches, '实际营养资源餐次', 1);
  if (meals.length !== 1) fail('实际营养资源更正只能指定一个餐次。');
  const meal = patchObject(meals[0], NUTRITION_BRIDGE_MEAL_KEYS, '实际营养资源餐次');
  const rows = list(meal.itemPatches, '实际营养资源条目', 100);
  if (!rows.length) fail('至少指定一个既存实际营养资源。');
  const planId = id(payload.planId, '计划ID'), mealId = id(meal.id, '餐次ID'), target = (state.plans ?? []).find(plan => plan.id === planId);
  const targetMeal = target?.meals?.find(meal => meal.id === mealId); let clearedOldWeight = false;
  const plannedIds = new Set([...(target?.meals ?? []), ...(target?.draft?.meals ?? [])].flatMap(meal => (meal.plannedItems ?? []).map(line => line.id)));
  const nutritionCorrections = rows.map(raw => {
    patchObject(raw, NUTRITION_BRIDGE_ITEM_KEYS, '实际营养资源条目');
    const resourceId = str(raw.id, '实际营养资源ID', 100);
    if (!resourceId.startsWith(ACTUAL_NUTRITION_PREFIX)) fail('实际营养资源不能混合普通计划食物行。');
    const entryId = resourceId.slice(ACTUAL_NUTRITION_PREFIX.length);
    if (!entryId.trim() || entryId !== entryId.trim()) fail('actual-nutrition前缀后必须是精确的既存actual entry ID。');
    if (plannedIds.has(resourceId)) fail('同一资源ID已被计划食物行占用，不能猜测更正对象。', 409, 'NUTRITION_RESOURCE_AMBIGUOUS');
    if (raw.nutrition === undefined) fail('实际营养资源必须提供完整有来源的nutrition替换，不能借用其它计划字段。');
    const existing = targetMeal?.actualEntries.find(entry => entry.id === entryId);
    const wholePortion = existing && DISCRETE_NUTRITION_UNITS.has(existing.unit) && raw.nutrition?.basisUnit === existing.unit;
    if (wholePortion && existing.nutritionSnapshot?.gramsPerUnit != null) clearedOldWeight = true;
    return { entryId, nutrition: raw.nutrition, sourceText: raw.sourceText, ...(wholePortion ? { gramsPerUnit: null } : {}) };
  });
  // The reserved ID namespace is an explicit resource address, never a command
  // parsed from prose. The existing isolated corrector owns all actual lookup,
  // complete-source validation, atomic audit, and zero-inventory behavior.
  const result = correctMealNutrition(state, { action: 'record_meal_intake', operationId: payload.operationId, expectedRevision: payload.expectedRevision, planId, mealId, mode: 'correct', nutritionCorrections }, at);
  if (clearedOldWeight) result.detail += ' 整份口径，旧平均克重换算已清除；没有据此推断新的实称克重，库存克重未改。';
  return result;
}
function inheritNewActualNutrition(entry, entity) {
  const candidates = entity.plannedItems.filter(line => sameNutritionFood(line, entry));
  if (candidates.length !== 1 || candidates[0].nutrition === undefined || !candidates[0].nutritionSnapshot?.nutrition) return;
  const nextSnapshot = nutritionSnapshotBase(entry);
  nextSnapshot.nutrition = clone(candidates[0].nutritionSnapshot.nutrition);
  entry.nutritionSnapshot = nextSnapshot;
}
function actual(raw, items, at, supplement, previous, quantitySource = 'reported') {
  obj(raw, '实际食物'); const targetId = raw.itemId === null ? null : id(raw.itemId, '实际食材ID'); const item = targetId === null ? null : items.find((i) => i.id === targetId);
  if (item && (item.category === 'supplement') !== supplement) fail('食物和补给必须分别记录。');
  const unit = raw.unit === undefined ? item?.unit ?? previous?.unit ?? '' : str(raw.unit, '实际单位', 20, true); const quantity = qty(raw.quantity, true, false);
  if (quantity !== null && !unit) fail('实际数量已知时必须明确单位。');
  const name = str(raw.name ?? item?.name ?? previous?.name, '实际食物名称', 200); const sourceText = str(raw.sourceText, '实际报告原话', 10000);
  const sameFood = previous?.itemId === targetId && (targetId !== null || previous.name === name && previous.unit === unit);
  return { id: str(raw.id, '实际记录ID', 400).trim(), itemId: targetId, name, quantity, unit, sourceText, reportedAt: at, quantitySource: quantity === null ? 'unknown' : quantitySource, nutritionSnapshot: sameFood ? previous.nutritionSnapshot : item ? snapshot(item) : null, correctionHistory: previous?.correctionHistory ?? [], ...(sameFood && previous.intakeLineId ? { intakeLineId: previous.intakeLineId } : {}), ...(sameFood && previous.nutritionCorrectionHistory !== undefined ? { nutritionCorrectionHistory: clone(previous.nutritionCorrectionHistory) } : {}) };
}
function comparableActual(entry) { return { id: entry.id, itemId: entry.itemId, name: entry.name, quantity: entry.quantity, unit: entry.unit, sourceText: entry.sourceText, quantitySource: entry.quantitySource }; }
function report(entity, raw, items, at, supplement, planId, quantitySource = 'reported') {
  const mode = raw.mode ?? 'append'; if (!MODES.has(mode)) fail('实际记录mode无效。');
  const next = clone(entity); const input = list(raw.entries ?? [], '实际记录', 100).slice(); const matchedLines = new Map();
  const matches = supplement ? raw.matchesPlannedDose : raw.matchesPlannedFood;
  if (matches === true) {
    if (mode !== 'complete') fail('按计划吃完需要mode=complete。');
    if (input.length) fail('按计划吃完不能同时提供另一份食物清单。');
    const lines = supplement ? [{ id: 'dose', itemId: entity.itemId, quantity: entity.plannedQuantity, unit: entity.unit }] : entity.plannedItems;
    for (const l of lines) {
      const manual = !supplement ? entity.actualEntries.filter(entry => entry.intakeLineId === l.id && entry.id.startsWith('ui-intake-')) : [];
      if (manual.length > 1) fail('同一计划行存在多份手动实际记录，请先核对。', 409, 'ACTUAL_PLAN_DUPLICATION');
      const entryId = manual[0]?.id ?? plannedEntryId(planId, entity.id, l.id);
      input.push({ id: entryId, itemId: l.itemId, ...(l.itemId === null ? { name: l.name } : {}), quantity: l.quantity, unit: l.unit, sourceText: raw.sourceText || '用户明确报告按已确认计划完成' });
      matchedLines.set(entryId, l);
    }
    if (entity.actualEntries.some((e) => e.quantity !== 0 && !input.some((i) => i.id === e.id))) fail('已逐项记录过不同的实际食物，不能再整餐按计划复制；请保留已有记录并明确更正或补充剩余。', 409, 'ACTUAL_PLAN_DUPLICATION');
  }
  // A completion report commonly restates the meal's cumulative portions.
  // A fresh ID for an already-reported food is not evidence of another serving,
  // even when its unit differs from the earlier report. Require reconciliation
  // before appending it so a checkbox followed by a Chat report cannot debit
  // the same portion twice. Explicit append remains the additional-food path.
  if (!supplement && mode === 'complete' && matches !== true) {
    for (const entry of input) {
      if (!entry || typeof entry !== 'object' || entry.quantity === 0
        || entity.actualEntries.some(existing => existing.id === entry.id)) continue;
      const targetId = typeof entry.itemId === 'string' ? entry.itemId.trim() : entry.itemId;
      const duplicateFood = entity.actualEntries.some(existing => existing.quantity !== 0
        && (targetId === null ? existing.itemId === null && typeof entry.name === 'string'
          && nameKey(existing.name ?? existing.nutritionSnapshot?.name ?? '') === nameKey(entry.name)
          : typeof targetId === 'string' && existing.itemId === targetId));
      if (duplicateFood) fail('这餐已有同一食物的实际进食记录，不能用新条目再次记录累计用量。请读取已有 actualEntries，复用原 entry.id 用 correct 按差量更正；明确按当前计划吃完可用 matchesPlannedFood=true。确实另外又吃了一份才用 append，单位不同需先核对，不能猜测相加。', 409, 'ACTUAL_INTAKE_RECONCILIATION_REQUIRED');
    }
  }
  unique(input, '实际记录');
  for (const entry of input) {
    const index = next.actualEntries.findIndex((e) => e.id === entry.id); const before = index === -1 ? null : next.actualEntries[index];
    const normalized = actual(entry, items, at, supplement, before, matches === true ? 'confirmed_plan_portion' : quantitySource);
    if (!before && !supplement && matches !== true) inheritNewActualNutrition(normalized, entity);
    if (matches === true && !supplement) { const line = matchedLines.get(entry.id); if (line) normalized.nutritionSnapshot = clone(line.nutritionSnapshot); }
    if (before && equal(comparableActual(before), comparableActual(normalized))) continue;
    const completedSamePortion = matches === true && !supplement && mode === 'complete' && before
      && before.quantity !== null && normalized.quantity >= before.quantity && before.itemId === normalized.itemId
      && before.unit === normalized.unit && equal(before.nutritionSnapshot, matchedLines.get(entry.id)?.nutritionSnapshot)
      && (before.itemId !== null || nameKey(before.name) === nameKey(normalized.name));
    if (before && mode !== 'correct' && !completedSamePortion) fail('同一实际记录ID已有不同内容；请明确更正，不能重复扣减。', 409, 'ACTUAL_ID_CONFLICT');
    if (!before && mode === 'correct') fail('找不到需要更正的实际记录。', 404, 'ACTUAL_NOT_FOUND');
    if (before) { const { correctionHistory, ...prior } = before; normalized.correctionHistory = [...correctionHistory, prior]; if (normalized.correctionHistory.length > 100) fail('更正历史达到上限，请先备份。'); next.actualEntries[index] = normalized; } else next.actualEntries.push(normalized);
  }
  if (next.actualEntries.length > 300) fail('单餐实际记录达到上限，请先备份。');
  if (mode === 'complete' && !next.actualEntries.length && (supplement || entity.plannedItems.length > 0)) fail('尚无实际食物数量；请明确按计划完成、提供实际条目，或明确数量0，不能把缺失当作没吃。', 400, 'ACTUAL_CONTENT_REQUIRED');
  if (raw.actualTime !== undefined) next.actualTime = time(raw.actualTime);
  if (raw.actualTimeText !== undefined) next.actualTimeText = str(raw.actualTimeText, '实际时间原话', 500, true);
  if (raw.sourceText !== undefined) next[supplement ? 'reportSourceText' : 'sourceText'] = str(raw.sourceText, '报告原话', 10000, true);
  if (supplement && raw.actualMealId !== undefined) next.actualMealId = raw.actualMealId === null ? null : id(raw.actualMealId, '实际服用关联餐次ID');
  if (mode === 'complete') { next.state = 'completed'; next.completionReportedAt ??= at; }
  else if (input.length && !['completed', 'cancelled'].includes(next.state)) next.state = 'in_progress';
  if (!input.length && mode === 'append' && raw.actualTime === undefined && raw.actualTimeText === undefined && raw.sourceText === undefined) fail('没有可保存的实际报告。');
  if (!equal(next, entity)) {
    const history = next.reportHistory ?? []; if (history.length >= 500) fail('单餐报告原话达到500条上限，请先备份。');
    next.reportHistory = [...history, { reportedAt: at, mode, sourceText: raw.sourceText ?? '', actualTime: Object.hasOwn(raw, 'actualTime') ? next.actualTime : null, actualTimeText: raw.actualTimeText ?? '', entryIds: input.map((e) => e.id), matchesConfirmedPlan: matches === true || quantitySource === 'confirmed_plan_portion' }];
  }
  return next;
}
function requireConfirmed(payload) { if (payload.confirmed !== true) fail('此兼容操作需要confirmed=true；采用菜单不等于已吃，只有实际报告才结算库存。', 400, 'PLAN_CONFIRMATION_REQUIRED'); }
function plannedEntryId(planId, entityId, lineId) {
  const key = JSON.stringify([planId, entityId, lineId]); let a = 0x811c9dc5; let b = 0x9e3779b9;
  for (let i = 0; i < key.length; i++) { a = Math.imul(a ^ key.charCodeAt(i), 0x01000193); b = Math.imul(b ^ key.charCodeAt(i), 0x85ebca6b); }
  return `planned-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
function routineSlot(entry, plan) {
  if (DOSE_SLOTS.has(entry.timingSlot) && entry.timingSlot !== 'other') return entry.timingSlot;
  const linked = plan?.meals?.find((meal) => meal.id === entry.plannedMealId);
  return ['breakfast', 'lunch', 'dinner'].includes(linked?.slot) ? linked.slot : 'other';
}
function routineDose(entry, plan) {
  return { id: entry.id, itemId: entry.itemId, plannedQuantity: entry.plannedQuantity, unit: entry.unit, ...doseMetadata(entry), timingSlot: routineSlot(entry, plan), plannedMealId: null, plannedTime: entry.plannedTime ?? null, plannedTimeText: entry.plannedTimeText ?? '', sourceText: entry.sourceText ?? '' };
}
function routineFromPlan(plan) { return { sourcePlanId: plan.id, updatedAt: plan.updatedAt ?? plan.createdAt, supplementDoses: plan.supplementDoses.map((entry) => routineDose(entry, plan)) }; }
export function getSupplementRoutine(state) {
  if (state.supplementRoutine && Array.isArray(state.supplementRoutine.supplementDoses)) return clone(state.supplementRoutine);
  const candidates = (state.plans ?? []).filter((plan) => plan.format === 'meals_v1' && ['reserved', 'closed_with_actuals'].includes(plan.status) && plan.supplementDoses?.length && plan.supplementDoses.some((entry) => entry.timingSlot !== undefined || entry.requirement !== undefined));
  // Prefer the complete timetable over a later food plan mentioning only one
  // dose. Once explicitly saved, the routine no longer follows meal plans.
  candidates.sort((a, b) => new Set(b.supplementDoses.map((entry) => entry.itemId)).size - new Set(a.supplementDoses.map((entry) => entry.itemId)).size || b.supplementDoses.length - a.supplementDoses.length || b.date.localeCompare(a.date) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return candidates[0] ? routineFromPlan(candidates[0]) : null;
}
function dailyOwner(state, day) {
  const order = { reserved: 0, draft: 1, closed_with_actuals: 2, cancelled: 3 };
  return (state.plans ?? []).filter((plan) => plan.format === 'meals_v1' && plan.date === day && Object.hasOwn(order, plan.status)).slice().sort((a, b) => order[a.status] - order[b.status] || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0] ?? null;
}
function dailyOwnerConflict(state, day, owner) {
  const records = (state.plans ?? []).filter((plan) => plan.format === 'meals_v1' && plan.date === day);
  const facts = records.filter((plan) => plan.supplementDoses.some(hasFacts));
  if (records.filter((plan) => ['reserved', 'draft'].includes(plan.status)).length > 1 || facts.length > 1 || facts.some((plan) => plan.id !== owner?.id)) return { code: 'DAILY_SUPPLEMENT_OWNER_CONFLICT', message: '同一天存在多份补给账或实际报告，请先核对原记录，不能猜测合并或重复扣减。' };
  return null;
}
export function getDailySupplementView(state, forDate) {
  const day = date(forDate), owner = dailyOwner(state, day), routine = getSupplementRoutine(state), issues = [];
  const conflict = dailyOwnerConflict(state, day, owner); if (conflict) issues.push(conflict);
  if (!owner && !routine?.supplementDoses.length) return { plan: null, virtual: true, sourcePlanId: null, issues };
  const plan = owner ? clone(projectCurrentDietPlan(owner, state.items)) : { id: `supplements-${day}`, format: 'meals_v1', date: day, title: '每日补给记录', timeZone: 'America/Toronto', notes: '', status: 'reserved', meals: [], supplementDoses: [], items: [], accountedDebits: [], allocationAdjustments: {}, inventoryAccounting: 'settled', accountingIssues: [], intakeBasis: 'reported_only', supplementOnly: true, foodAccounting: 'actual_only', supplementAccounting: 'actual_only', createdAt: routine.updatedAt, updatedAt: routine.updatedAt };
  for (const entry of routine?.supplementDoses ?? []) {
    const exact = plan.supplementDoses.find((existing) => existing.id === entry.id);
    if (exact?.itemId === entry.itemId) continue;
    const matches = plan.supplementDoses.filter((existing) => existing.itemId === entry.itemId && routineSlot(existing, plan) === routineSlot(entry));
    if (matches.length === 1) continue;
    if (matches.length > 1) { issues.push({ code: 'SUPPLEMENT_DOSE_AMBIGUOUS', doseId: entry.id, message: '同种补给在该时段有多个既有剂次，请按原剂次ID核对，不猜测合并。' }); continue; }
    if (plan.supplementDoses.length >= 32) { issues.push({ code: 'DAILY_DOSE_LIMIT', doseId: entry.id, message: '当天已达32个剂次，未自动添加其余模板项目。' }); continue; }
    const projected = exact ? { ...entry, id: `routine-${plannedEntryId(entry.id, entry.itemId, routineSlot(entry)).slice('planned-'.length)}` } : entry;
    try { plan.supplementDoses.push(dose(projected, state.items)); } catch (error) { issues.push({ code: error.code ?? 'INVALID_ROUTINE_DOSE', doseId: projected.id, message: error.message }); }
  }
  // This status belongs only to the independent supplement projection. A closed
  // food record stays closed in state, while supplements can still be reported.
  plan.status = 'reserved';
  return { plan, virtual: !owner, sourcePlanId: routine?.sourcePlanId ?? null, issues };
}
function applyDailySupplementCheck(state, payload, at) {
  const day = date(payload.date); if (typeof payload.checked !== 'boolean') fail('补给勾选状态必须明确为true或false。');
  const targetId = id(payload.doseId, '剂次ID'), view = getDailySupplementView(state, day), old = dailyOwner(state, day);
  const ownerConflict = view.issues.find((issue) => issue.code === 'DAILY_SUPPLEMENT_OWNER_CONFLICT'); if (ownerConflict) fail(ownerConflict.message, 409, ownerConflict.code);
  const selected = view.plan?.supplementDoses.find((entry) => entry.id === targetId);
  if (!selected) { const issue = view.issues.find((issue) => issue.doseId === targetId); fail(issue?.message ?? '找不到当天补给剂次，请读取通用时间表后使用显示的剂次ID。', 409, issue?.code ?? 'DOSE_NOT_FOUND'); }
  const existing = old?.supplementDoses.find((entry) => entry.id === targetId);
  if (payload.checked === false && !supplementChecked(existing ?? { actualEntries: [] })) return { items: state.items, plans: state.plans ?? [], detail: '此剂次未勾选，未新增服用记录。', noChange: true };
  if (!old && (state.plans ?? []).length >= 1000) fail('饮食记录达到1000条上限，请先备份整理。');
  let owner;
  if (!old) owner = { ...clone(view.plan), createdAt: at, updatedAt: at };
  else {
    owner = currentForWrite(state, old);
    // Keep the food menu and its status; supplement projection status is not a
    // lifecycle transition for a draft, closed, or cancelled food menu.
    if (owner.supplementOnly) owner.supplementDoses = clone(view.plan.supplementDoses);
    else if (!owner.supplementDoses.some(d => d.id === targetId)) owner.supplementDoses.push(clone(selected));
  }
  const plans = (state.plans ?? []).slice(), index = old ? plans.findIndex((plan) => plan.id === old.id) : -1;
  if (index < 0) plans.push(owner); else plans[index] = owner;
  const result = applyDietAction({ ...state, plans }, { action: 'set_supplement_check', planId: owner.id, doseId: targetId, checked: payload.checked }, at);
  const routine = !state.supplementRoutine ? getSupplementRoutine(state) : null;
  if (result.noChange) return routine ? { items: state.items, plans: state.plans ?? [], supplementRoutine: { ...routine, updatedAt: at }, detail: '通用补给时间表已保存，未重复记录服用或扣库存。' } : { ...result, plans: state.plans ?? [] };
  if (old && ['cancelled', 'closed_with_actuals'].includes(old.status)) result.plans = result.plans.map((plan) => plan.id === old.id ? { ...plan, status: old.status } : plan);
  return { ...result, ...(routine ? { supplementRoutine: { ...routine, updatedAt: at } } : {}) };
}
export function isDietAction(action) { return ACTIONS.has(action); }

function applyDailyMenuSettlement(state, payload, at) {
  const planId = id(payload.planId, '计划ID');
  const plans = (state.plans ?? []).slice(), index = plans.findIndex(plan => plan.id === planId), old = plans[index];
  if (!old) fail('找不到饮食计划。', 404, 'PLAN_NOT_FOUND');
  const prepared = prepareDailyMenuSettlement(state, old, payload, at);
  if (prepared.noChange) return { items: state.items, plans, detail: prepared.detail, noChange: true };
  let next = prepared.plan;
  delete next.draft;
  const result = settleFoodOnly(state.items, old, next, at);
  next = result.plan; next.updatedAt = at; plans[index] = next;
  return { items: result.items, plans, detail: next.dailySettlement.accounting === 'settled'
    ? '已按午夜策略结算已保存的全天食物菜单；实际报告优先，个人勾选与补给不参与，未伪造进食事实。'
    : '日终菜单已按食材分别结算；可结算项已按差量处理，仅异常项保留原信用待核，未伪造实际进食。' };
}

function applyChecklistIntake(state, payload, at) {
  patchObject(payload, new Set(['action', 'operationId', 'expectedRevision', 'planId', 'draft', 'expectedDraftVersion']), '进食清单操作');
  const planId = id(payload.planId, '计划ID'), old = (state.plans ?? []).find(plan => plan.id === planId);
  if (!old) fail('找不到饮食计划。', 404, 'PLAN_NOT_FOUND');
  if (old.format !== 'meals_v1') fail('此操作仅用于结构化餐次计划。', 409, 'LEGACY_PLAN_CONFLICT');
  if (old.intakeDraft) fail('这一天还有未提交的进食草稿，请先核对或放弃草稿，再勾选清单；原草稿已保留。', 409, 'INTAKE_DRAFT_PENDING');
  if (!Object.hasOwn(payload, 'expectedDraftVersion') || payload.expectedDraftVersion !== null) {
    fail('进食草稿已在别处改变，请刷新核对，不覆盖云端记录。', 409, 'INTAKE_DRAFT_CONFLICT');
  }
  const draft = normalizeIntakeDraft(old, payload.draft, state.items);
  if (draft.consumed.some(entry => entry.quantity === null)) {
    fail('这项用量还不明确，请先核对实际用量，不能用勾选猜测已吃数量。', 409, 'CHECKLIST_QUANTITY_REQUIRED');
  }
  // Both stages are pure. Only the outer inventory transaction persists their
  // combined result, so there is never a half-saved draft, second revision, or
  // separate operation ID that could be retried as a second inventory debit.
  const saved = applyDietAction(state, { action: 'save_intake_draft', planId, draft, expectedDraftVersion: null }, at);
  const staged = { ...state, items: saved.items, plans: saved.plans };
  const cloudDraft = staged.plans.find(plan => plan.id === planId).intakeDraft;
  const submitted = applyDietAction(staged, { action: 'submit_intake_draft', planId,
    draftId: cloudDraft.id, baseFingerprint: cloudDraft.baseFingerprint,
    expectedDraftVersion: intakeDraftVersion(cloudDraft) }, at);
  return submitted;
}

export function applyDietAction(state, payload, now = new Date().toISOString()) {
  obj(state, '库存'); obj(payload, '操作'); if (!isDietAction(payload.action)) fail('不支持的饮食操作。'); const at = stamp(now); let items = state.items.slice(); const plans = (state.plans ?? []).slice(); let old; let next; let index = -1; let detail;
  if (payload.action === 'apply_checklist_intake') return applyChecklistIntake(state, payload, at);
  if (payload.action === 'set_food_personal_check') return applyPersonalFoodCheck(state, payload, at);
  if (payload.action === 'settle_daily_menu') return applyDailyMenuSettlement(state, payload, at);
  if (Object.hasOwn(payload, 'nutritionCorrections')) {
    if (payload.action !== 'record_meal_intake') fail('nutritionCorrections仅用于record_meal_intake，不能混入其它操作。');
    return correctMealNutrition(state, payload, at);
  }
  if (payload.action === 'patch_meal_plan' && hasActualNutritionResource(payload)) return correctActualNutritionResource(state, payload, at);
  if (payload.action === 'set_daily_supplement_check') return applyDailySupplementCheck(state, payload, at);
  if (payload.action === 'save_supplement_routine') {
    requireConfirmed(payload); const source = plans.find((plan) => plan.id === id(payload.sourcePlanId, '来源计划ID'));
    if (!source || source.format !== 'meals_v1' || !['reserved', 'closed_with_actuals'].includes(source.status) || !source.supplementDoses.length) fail('只能从已确认且包含补给的菜单保存通用时间表。', 409, 'ROUTINE_SOURCE_NOT_CONFIRMED');
    const routine = routineFromPlan(source); for (const entry of routine.supplementDoses) dose(entry, items);
    if (state.supplementRoutine?.sourcePlanId === routine.sourcePlanId && equal(state.supplementRoutine.supplementDoses, routine.supplementDoses)) return { items: state.items, plans: state.plans ?? [], detail: '通用补给时间表未改变。', noChange: true };
    return { items: state.items, plans: state.plans ?? [], supplementRoutine: { ...routine, updatedAt: at }, detail: '已保存通用补给时间表，未复制已服记录、未预留或扣减库存。' };
  }
  if (payload.action === 'save_meal_plan_draft') {
    const raw = obj(payload.plan, '饮食计划'); index = plans.findIndex((p) => p.id === raw.id); old = index < 0 ? null : plans[index];
    if (old && old.format !== 'meals_v1') fail('旧平铺计划不能猜测迁移为餐次；请用新计划ID。', 409, 'LEGACY_PLAN_CONFLICT');
    if (old && !['draft', 'reserved'].includes(old.status)) fail('已关闭计划不能再次启用。', 409, 'PLAN_CLOSED');
    const current = old ? currentForWrite(state, old) : null;
    next = normalizePlan(raw, items, at, current);
    const sameDay = plans.find((p) => p.format === 'meals_v1' && p.id !== next.id && p.date === next.date);
    if (sameDay) throw Object.assign(new Error(`同一天已有记录，请复用原计划ID ${sameDay.id} 保存菜单，不要重复建账。`), { status: 409, code: 'DAY_PLAN_CONFLICT', canonicalPlanId: sameDay.id });
    if (!old && plans.length >= 1000) fail('饮食记录达到1000条上限，请先备份整理。');
    if (old) guardEdits(old, next);
    preservePlanAccounting(old, next);
    if (old && !old.draft && equal(content(old), content(next))) return { items: state.items, plans: state.plans ?? [], detail: '当前菜单内容相同，未重复修改。', noChange: true };
    recordMealPlanRevisions(old, next, at);
    detail = '已保存当前菜单，可立即查看及修改；未预留或扣减库存，已有实际记录保留。';
  } else {
    const planId = id(payload.planId, '计划ID'); index = plans.findIndex((p) => p.id === planId); if (index < 0) fail('找不到饮食计划。', 404, 'PLAN_NOT_FOUND'); old = plans[index]; if (old.format !== 'meals_v1') fail('此操作仅用于结构化餐次计划。', 409, 'LEGACY_PLAN_CONFLICT'); next = currentForWrite(state, old);
    if (['save_intake_draft', 'submit_intake_draft', 'discard_intake_draft'].includes(payload.action)
      && (old.intakeDraft || payload.action === 'save_intake_draft')
      && (!Object.hasOwn(payload, 'expectedDraftVersion') || payload.expectedDraftVersion !== intakeDraftVersion(old.intakeDraft))) {
      fail('另一处已保存、提交或丢弃进食草稿，请保留本地输入，刷新并核对云草稿后再操作。', 409, 'INTAKE_DRAFT_CONFLICT');
    }
    if (payload.action === 'save_intake_draft') {
      const normalized = normalizeIntakeDraft(old, payload.draft, items);
      prepareIntakeDraft(old, normalized, items);
      next = clone(old);
      const { updatedAt: _updatedAt, ...previousDraft } = old.intakeDraft ?? {};
      if (equal(previousDraft, normalized)) return { items: state.items, plans: state.plans ?? [], detail: '进食草稿内容相同，未重复保存或扣库存。', noChange: true };
      next.intakeDraft = { ...normalized, updatedAt: at };
      detail = '已保存进食草稿；尚未记为实际，未改变原菜单、完成状态或库存。';
    } else if (payload.action === 'discard_intake_draft') {
      if (!old.intakeDraft) return { items: state.items, plans: state.plans ?? [], detail: '没有待丢弃的进食草稿，实际记录和库存未改变。', noChange: true };
      if (payload.draftId !== undefined && payload.draftId !== old.intakeDraft.id) fail('进食草稿已在另一处改变，请刷新。', 409, 'INTAKE_DRAFT_CONFLICT');
      next = clone(old); delete next.intakeDraft;
      detail = '已丢弃未提交的进食草稿；原菜单、实际记录和库存未改变。';
    } else if (payload.action === 'submit_intake_draft') {
      if (!old.intakeDraft || payload.draftId !== old.intakeDraft.id) fail('该进食草稿已提交、丢弃或改变，请刷新核对，不要重新建账。', 409, 'INTAKE_DRAFT_NOT_FOUND');
      if (payload.baseFingerprint !== old.intakeDraft.baseFingerprint) fail('进食草稿基线不一致，请刷新核对。', 409, 'INTAKE_DRAFT_STALE');
      const prepared = prepareIntakeDraft(old, old.intakeDraft, items);
      if (!prepared.changes.length && !prepared.draft.transfers.length && !prepared.draft.completedMealIds.length) fail('草稿没有需要提交的变化。');
      if (old.status === 'closed_with_actuals' && prepared.draft.transfers.length) fail('已结束的菜单只能更正实际记录，不能重新分配未来餐次。', 409, 'PLAN_CLOSED');
      next.meals = prepared.plan.meals;
      guardEdits(old, next);
      for (const change of prepared.changes) {
        const index = next.meals.findIndex(meal => meal.id === change.mealId);
        for (const correction of change.externalCorrections) {
          const previous = next.meals[index].actualEntries.find(entry => entry.id === correction.entryId);
          if (previous.quantity === correction.quantity) continue;
          next.meals[index] = report(next.meals[index], { mode: 'correct', entries: [{ id: previous.id, itemId: previous.itemId,
            name: previous.name, quantity: correction.quantity, unit: previous.unit, sourceText: '用户在进食草稿中明确勾选更正已记录的累计用量。' }] }, items, at, false, next.id);
        }
        const previous = next.meals[index].actualEntries.find(entry => entry.id === change.managedEntryId);
        const input = prepared.draft.consumed.find(entry => entry.mealId === change.mealId && entry.lineId === change.lineId);
        if (previous || change.managedQuantity === null || change.managedQuantity > 0 || input.quantity === 0 && !change.externalCorrections.length) {
          next.meals[index] = report(next.meals[index], { mode: previous ? 'correct' : 'append', entries: [{
            id: change.managedEntryId, itemId: change.sourceLine.itemId, name: change.sourceLine.name ?? change.sourceLine.nutritionSnapshot?.name,
            quantity: change.managedQuantity, unit: change.sourceLine.unit, sourceText: '用户明确提交进食草稿中的累计已吃量；未报告实际时间。',
          }] }, items, at, false, next.id);
          const saved = next.meals[index].actualEntries.find(entry => entry.id === change.managedEntryId);
          saved.intakeLineId = change.lineId;
          if (!previous) saved.nutritionSnapshot = clone(change.sourceLine.nutritionSnapshot);
        }
      }
      for (const meal of next.meals) meal.plannedItems = meal.plannedItems.filter(line => line.quantity > 0);
      for (const mealId of prepared.draft.completedMealIds) {
        const index = next.meals.findIndex(meal => meal.id === mealId);
        if (next.meals[index].state !== 'completed') next.meals[index] = report(next.meals[index], { mode: 'complete', sourceText: '用户在进食草稿中明确标记这餐已结束；已吃食物按逐项记录保留。' }, items, at, false, next.id);
      }
      delete next.intakeDraft;
      const audit = old.intakeDraftAudit ?? [];
      if (audit.length >= 200) fail('该日手动进食提交审计已达保存上限，请先备份。', 409, 'INTAKE_DRAFT_AUDIT_LIMIT');
      next.intakeDraftAudit = [...clone(audit), { id: old.intakeDraft.id, at, draft: clone(old.intakeDraft) }];
      preservePlanAccounting(old, next);
      recordMealPlanRevisions(old, next, at);
      const actualAmounts = plan => plan.meals.map(meal => ({ id: meal.id, completed: meal.state === 'completed',
        entries: meal.actualEntries.map(entry => ({ id: entry.id, itemId: entry.itemId, name: entry.itemId === null ? entry.name : '', quantity: entry.quantity, unit: entry.unit })) }));
      const actualChanged = !equal(actualAmounts(currentForWrite(state, old)), actualAmounts(next));
      if (actualChanged) {
        next.intakeBasis = 'reported_only';
        ({ items, plan: next } = settle(items, old, next, at, true));
      }
      detail = !actualChanged ? '已保存餐间分配；没有新的实际进食，库存和待核旧账均未改变。'
        : next.inventoryAccounting === 'settled' ? '进食草稿已明确提交为实际，跨餐分配已同步；库存仅结算实际差量，未重复扣减。' : '实际进食和跨餐分配已保存；可结算食材已按差量处理，仅异常项待核，未重复扣减。';
    } else if (payload.action === 'patch_meal_plan') {
      patchObject(payload, PATCH_KEYS, '菜单补丁');
      if (!['draft', 'apply'].includes(payload.mode)) fail('补丁mode必须明确为draft或apply。');
      if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail('confirmed必须明确为布尔值。');
      if (payload.allocationOnly !== undefined && typeof payload.allocationOnly !== 'boolean') fail('allocationOnly必须明确为布尔值。');
      if (!['draft', 'reserved'].includes(old.status)) fail('已关闭计划不能修改，请保留原事实。', 409, 'PLAN_CLOSED');
      if (payload.mode === 'draft' && payload.allocationOnly === true) fail('重分配只能在apply模式明确确认后进行。');
      if (payload.mode === 'apply') {
        requireConfirmed(payload);
      }
      const base = next;
      const candidate = patchPlan(base, payload, items);
      guardEdits(old, candidate, payload.allocationOnly === true);
      if (payload.allocationOnly === true && (!equal(canonicalTotals(plannedFoodTotals(old)), canonicalTotals(plannedFoodTotals(candidate))) || (payload.supplementPatches?.length ?? 0) > 0)) fail('同日重分配必须保持食物全天总量不变，补给请独立修改。', 409, 'DAILY_TOTAL_CONFLICT');
      if (equal(content(base), content(candidate))) return { items: state.items, plans: state.plans ?? [], detail: '指定字段未改变，未重复修改或扣减。', noChange: true };
      next = candidate; preservePlanAccounting(old, next);
      if (next.meals.length && old.supplementOnly) next.supplementOnly = false;
      detail = '已仅修改指定菜单字段，其余餐次、补给与实际记录保留，库存未预留或扣减。';
    } else if (payload.action === 'commit_meal_plan') {
      requireConfirmed(payload); if (old.status === 'reserved' && !old.draft) return { items: state.items, plans: state.plans ?? [], detail: '该最终计划已确认，未重复扣减。', noChange: true };
      if (!['draft', 'reserved'].includes(old.status)) fail('已关闭计划不能重复确认。', 409, 'PLAN_CLOSED');
      if (old.draft) guardEdits(old, next);
      if (old.supplementOnly && next.meals.length) next.supplementOnly = false;
      for (const meal of next.meals) for (const line of meal.plannedItems) if (line.itemId === null) plannedLine(line, items);
      delete next.draft; next.status = 'reserved'; next.intakeBasis = 'confirmed_daily_plan'; preservePlanAccounting(old, next); detail = '已保存采用的当前菜单；没有预留或扣减库存，明确实际进食后才结算。';
    } else if (payload.action === 'revise_unconsumed_meals') {
      requireConfirmed(payload); if (!['draft', 'reserved'].includes(old.status)) fail('只有开放菜单可以修改。', 409, 'PLAN_CLOSED');
      const meals = payload.meals === undefined ? [] : list(payload.meals, '修改餐次', 16); const doses = payload.supplementDoses === undefined ? [] : list(payload.supplementDoses, '修改补给', 32); if (!meals.length && !doses.length) fail('至少指定一个要修改的餐次或补给。'); unique(meals, '修改餐次'); unique(doses, '修改补给');
      for (const raw of meals) { const i = next.meals.findIndex((m) => m.id === raw.id); if (i < 0) fail('修改餐次ID不存在。', 404, 'MEAL_NOT_FOUND'); next.meals[i] = meal(raw, items, next.meals[i]); }
      for (const raw of doses) { const i = next.supplementDoses.findIndex((d) => d.id === raw.id); if (i < 0) next.supplementDoses.push(dose(raw, items)); else next.supplementDoses[i] = dose(raw, items, next.supplementDoses[i]); }
      list(next.supplementDoses, '当日补给剂次', 32); unique(next.supplementDoses, '当日补给剂次');
      for (const d of next.supplementDoses) if (d.plannedMealId && !next.meals.some((m) => m.id === d.plannedMealId)) fail('补给关联的餐次不存在。');
      guardEdits(old, next, payload.allocationOnly === true);
      if (payload.allocationOnly === true && (!equal(canonicalTotals(plannedFoodTotals(old)), canonicalTotals(plannedFoodTotals(next))) || doses.length)) fail('同日重分配必须保持食物全天总量不变，补给请独立修改。', 409, 'DAILY_TOTAL_CONFLICT');
      if (equal(content(old), content(next))) return { items: state.items, plans: state.plans ?? [], detail: '计划内容未变。', noChange: true };
      delete next.draft; preservePlanAccounting(old, next); detail = '已修改当前菜单；原实际报告保留，库存未预留或扣减。';
    } else if (payload.action === 'set_supplement_check') {
      // A dose is a separate actual event. It neither confirms a food menu nor
      // reopens a closed/cancelled meal plan.
      if (typeof payload.checked !== 'boolean') fail('补给勾选状态必须明确为true或false。');
      const i = next.supplementDoses.findIndex((d) => d.id === id(payload.doseId, '剂次ID')); if (i < 0) fail('找不到补给剂次。', 404, 'DOSE_NOT_FOUND');
      const current = next.supplementDoses[i];
      if (supplementChecked(current) === payload.checked) return { items: state.items, plans: state.plans ?? [], detail: '此补给勾选状态已保存，未重复记录。', noChange: true };
      const checkboxId = `checkbox-${plannedEntryId(next.id, current.id, 'dose').slice('planned-'.length)}`;
      const before = current.actualEntries.find((entry) => entry.id === checkboxId);
      const sourceText = payload.checked ? current.plannedQuantity === null ? '用户勾选此剂次已服用；实际数量未知，未套用其它剂量。' : '用户勾选此剂次已服用，按该剂次已确认计划份量记录。' : '用户撤回此剂次已服用勾选，更正为未服用（数量0）；原报告保留在更正历史。';
      const entries = payload.checked ? [{ id: checkboxId, itemId: current.itemId, quantity: current.plannedQuantity, unit: current.unit, sourceText }] : current.actualEntries.filter((entry) => entry.quantity !== 0).map((entry) => ({ id: entry.id, itemId: entry.itemId, name: entry.name, quantity: 0, unit: entry.unit, sourceText }));
      const changed = report(current, { mode: payload.checked && !before ? 'append' : 'correct', entries, sourceText }, items, at, true, next.id, payload.checked ? 'confirmed_plan_portion' : 'reported');
      changed.state = 'completed'; changed.completionReportedAt ??= at; next.supplementDoses[i] = changed;
      ({ items, plan: next } = settleSupplements(items, old, next, at)); detail = next.inventoryAccounting === 'settled' ? '补给勾选已保存，库存仅调整该剂次差量，实际时间未推测。' : '补给勾选和更正原话已保存，相关库存账务待核对。';
    } else if (payload.action === 'record_meal_intake' || payload.action === 'record_supplement_intake') {
      if (!['draft', 'reserved', 'closed_with_actuals'].includes(old.status) && !(payload.action === 'record_supplement_intake' && old.status === 'cancelled')) fail('已取消的菜单不能报告进食；实际更正请关联原完成记录。', 409, 'PLAN_CLOSED');
      if (payload.action === 'record_meal_intake') {
        if (payload.meals !== undefined && ['mealId', 'mode', 'entries', 'matchesPlannedFood', 'actualTime', 'actualTimeText', 'sourceText'].some(key => Object.hasOwn(payload, key) && payload[key] !== undefined)) fail('全天meals报告不能混入顶层逐餐字段；mode、条目、原话和时间应逐餐填写。');
        const mealReports = payload.meals === undefined ? [payload] : list(payload.meals, '同次餐次报告', 16);
        if (!mealReports.length) fail('至少报告一个餐次。');
        const mealIds = new Set();
        for (const raw of mealReports) {
          obj(raw, '餐次实际报告');
          if (payload.meals !== undefined) patchObject(raw, new Set(['mealId', 'mode', 'entries', 'matchesPlannedFood', 'actualTime', 'actualTimeText', 'sourceText']), '餐次实际报告');
          const mealId = id(raw.mealId, '餐次ID');
          if (mealIds.has(mealId)) fail('同一报告包含重复餐次ID。'); mealIds.add(mealId);
          const i = next.meals.findIndex(m => m.id === mealId); if (i < 0) fail('找不到餐次。', 404, 'MEAL_NOT_FOUND');
          next.meals[i] = report(next.meals[i], raw, items, at, false, next.id);
        }
      }
      const reports = payload.action === 'record_supplement_intake' ? [payload] : list(payload.supplements ?? [], '同次补给报告', 32); const doseIds = new Set();
      for (const raw of reports) { const doseId = id(raw.doseId, '剂次ID'); if (doseIds.has(doseId)) fail('同一报告包含重复补给剂次。'); doseIds.add(doseId); const i = next.supplementDoses.findIndex((d) => d.id === doseId); if (i < 0) fail('找不到补给剂次。', 404, 'DOSE_NOT_FOUND'); const doseReport = payload.action === 'record_meal_intake' ? { ...raw, actualMealId: raw.actualMealId === undefined ? payload.mealId : raw.actualMealId } : raw; if (doseReport.actualMealId != null && !next.meals.some((m) => m.id === doseReport.actualMealId)) fail('实际补给关联餐次不存在。'); next.supplementDoses[i] = report(next.supplementDoses[i], doseReport, items, at, true, next.id); }
      if (equal(old, next) && old.inventoryAccounting !== 'pending_reconciliation') return { items: state.items, plans: state.plans ?? [], detail: '此实际记录已保存，未重复扣减。', noChange: true };
      next.intakeBasis = 'reported_only';
      ({ items, plan: next } = payload.action === 'record_supplement_intake' ? settleSupplements(items, old, next, at) : settle(items, old, next, at, true)); detail = next.inventoryAccounting === 'settled' ? '实际报告已保存；仅结算真实摄入与原已记账用量的差量，未重复扣减。' : '实际报告和原话已保存；可结算食材已按差量处理，仅异常项保留原信用待核，未重复扣减。';
    } else {
      requireConfirmed(payload); if (old.status === 'cancelled' || old.status === 'closed_with_actuals') return { items: state.items, plans: state.plans ?? [], detail: '计划已关闭，未重复退款。', noChange: true };
      if (old.inventoryAccounting === 'pending_reconciliation') fail('实际报告有待核账务，不能通过取消绕过。', 409, 'ACCOUNTING_PENDING');
      if (payload.action === 'cancel_meal_plan' && anyFacts(old)) fail('已有实际进食或服用报告，不能整天退款；只能取消未吃剩余部分。', 409, 'PLAN_HAS_ACTUALS');
      for (const e of [...next.meals, ...next.supplementDoses]) if (e.state !== 'completed') e.state = 'cancelled';
      next.allocationAdjustments = {}; next.status = anyFacts(old) ? 'closed_with_actuals' : 'cancelled'; next.intakeBasis = anyFacts(old) ? 'reported_only' : 'none'; delete next.draft;
      ({ items, plan: next } = settle(items, old, next, at)); detail = '已取消未吃的预留，已报告实际食物和补给没有退款。';
    }
  }
  if (payload.action === 'commit_meal_plan' || payload.action === 'revise_unconsumed_meals' || payload.action === 'patch_meal_plan') recordMealPlanRevisions(old, next, at);
  // Business entry IDs survive the short operation ledger and cannot be reused
  // in another meal/day to silently debit the same reported event twice.
  const actualIds = new Set();
  for (const p of [...plans.filter((p) => p.id !== next.id), next]) if (p.format === 'meals_v1') for (const e of [...p.meals, ...p.supplementDoses]) for (const a of e.actualEntries) { if (actualIds.has(a.id)) fail('实际记录ID已被另一餐次或日期使用，请关联原记录更正。', 409, 'ACTUAL_ID_CONFLICT'); actualIds.add(a.id); }
  next.updatedAt = at; if (index < 0) plans.push(next); else plans[index] = next;
  return { items, plans, detail };
}

function compactNutrition(nutrition) { if (!nutrition) return null; return clone(Object.fromEntries(['basisAmount', 'basisUnit', 'kcal', 'protein', 'carbs', 'fat', 'source', 'nutrientSources'].map(key => [key, nutrition[key] ?? null]))); }
function compact(plan, items = []) { plan = projectCurrentDietPlan(plan, items); return { id: plan.id, recordId: plan.id, date: plan.date, title: plan.title, status: plan.status, intakeBasis: plan.intakeBasis, inventoryAccounting: plan.inventoryAccounting, accountingIssues: plan.accountingIssues, hasDraft: !!plan.draft, ...(plan.intakeDraft ? { intakeDraftState: intakeDraftStatus(plan, items) } : {}), ...(plan.supplementOnly ? { supplementOnly: true } : {}), ...(plan.supplementAccounting ? { supplementAccounting: plan.supplementAccounting } : {}), meals: plan.meals.map((m) => ({ id: m.id, slot: m.slot, title: m.title, state: m.state, plannedTime: m.plannedTime, actualTime: m.actualTime, completionReportedAt: m.completionReportedAt, plannedItems: m.plannedItems.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name ?? l.nutritionSnapshot?.name ?? null, quantity: l.quantity, unit: l.unit, ...(l.itemId === null ? { nutrition: compactNutrition(l.nutritionSnapshot?.nutrition), nutritionSourceTextAvailable: !!l.nutritionSnapshot?.nutrition?.sourceText } : {}) })), reportedItems: m.actualEntries.map((e) => ({ id: e.id, itemId: e.itemId, name: e.name, quantity: e.quantity, unit: e.unit, quantitySource: e.quantitySource })) })), supplementDoses: plan.supplementDoses.map((d) => ({ id: d.id, itemId: d.itemId, plannedQuantity: d.plannedQuantity, unit: d.unit, ...doseMetadata(d), checked: supplementChecked(d), plannedTime: d.plannedTime, actualTime: d.actualTime, state: d.state, reportedQuantity: d.actualEntries.reduce((sum, e) => sum === null || e.quantity === null ? null : round(sum + e.quantity), 0) })) }; }
// Leave room for the MCP route's available/revision response envelope.
const READ_BUDGET = 63000;
const CONTEXT_BUDGET = 24000;
const SUMMARY_BUDGET = 8000;
const summaryText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const summaryNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
function dailySummaryRows(state, dates) {
  if (!dates.size) return [];
  const plans = (state.plans ?? []).filter(plan => plan.format === 'meals_v1' && dates.has(plan.date));
  const history = (state.dietHistory ?? []).filter(record => dates.has(record.date));
  return resolveDietDays(plans, history, state.items).map(row => {
    const allIssues = Array.isArray(row.issues) ? row.issues : [];
    const issues = allIssues.slice(0, 3).map(issue => ({ code: summaryText(issue.code, 60), message: summaryText(issue.message, 160), ...(typeof issue.recordId === 'string' ? { recordId: issue.recordId } : {}) }));
    return {
      date: row.date, recordId: row.id, planId: row.plan?.id ?? null,
      historyId: row.matchedHistoryId ?? (row.recordType === 'diet_history' ? row.history?.id ?? row.id : null),
      basis: summaryText(row.basis, 80), nutritionSource: summaryText(row.nutritionSource, 80),
      partial: row.partial === true, supplementPartial: row.supplementPartial === true, hasDraft: row.hasDraft === true,
      totals: (row.totals ?? []).filter(total => ['kcal', 'protein', 'carbs', 'fat'].includes(total.key)).map(total => ({
        key: total.key, value: summaryNumber(total.value), partial: total.partial === true,
        supplementPartial: total.supplementPartial === true, estimated: total.estimated === true, source: summaryText(total.source, 80),
        missing: summaryNumber(total.missing), supplementMissing: summaryNumber(total.supplementMissing),
      })),
      issues, issueCount: allIssues.length,
      issuesTruncated: allIssues.length > issues.length || allIssues.slice(0, 3).some((issue, index) => issue.code !== issues[index].code || issue.message !== issues[index].message),
    };
  });
}
function summaryBundle(rows, dates, budget = SUMMARY_BUDGET) {
  const selected = rows.filter(row => dates.has(row.date)); const included = [];
  for (const row of selected) {
    const candidate = { dailyNutritionSummaries: [...included, row], dailyNutritionSummaryTotal: selected.length, dailyNutritionSummariesTruncated: false };
    if (JSON.stringify(candidate).length > budget) break;
    included.push(row);
  }
  return { dailyNutritionSummaries: included, dailyNutritionSummaryTotal: selected.length, dailyNutritionSummariesTruncated: included.length < selected.length };
}
function fragment(record, offset = 0, budget = 64000) { const encoded = JSON.stringify(record); if (!Number.isSafeInteger(offset) || offset < 0 || offset > encoded.length) fail('记录分段offset无效。'); let end = Math.min(encoded.length, offset + Math.floor(budget / 2)); let result; do { result = { recordId: record.id, encoding: 'json_text', offset, totalCharacters: encoded.length, nextOffset: end < encoded.length ? end : null, text: encoded.slice(offset, end), truncated: end < encoded.length, instructions: '按nextOffset继续读取并依offset拼接text，JSON.parse后还原完整记录；片段并非完整历史。' }; if (JSON.stringify(result).length <= budget) return result; end = offset + Math.floor((end - offset) / 2); } while (end > offset); fail('无法在输出预算内返回记录。'); }
function intakeDraftStatus(plan, items) {
  return { hasDraft: !!plan?.intakeDraft, draftId: plan?.intakeDraft?.id ?? null, draftVersion: intakeDraftVersion(plan?.intakeDraft),
    stale: !!plan?.intakeDraft && plan.intakeDraft.baseFingerprint !== intakePlanFingerprint(plan, items),
    updatedAt: plan?.intakeDraft?.updatedAt ?? null, draftIsActual: false,
    ...(plan ? { details: { tool: 'read_intake_draft', planId: plan.id } } : {}),
    instructions: '进食草稿不是已吃事实；未提交的已吃量和转餐均未记入实际或扣库存。' };
}
export function readIntakeDraft(state, filters = {}) {
  obj(filters, '读取进食草稿');
  if (Object.keys(filters).some(field => !['planId', 'date', 'mealIds'].includes(field))) fail('读取进食草稿包含不支持的字段。');
  const plan = filters.planId ? (state.plans ?? []).find(entry => entry.id === id(filters.planId) && entry.format === 'meals_v1')
    : filters.date ? dailyOwner(state, date(filters.date)) : null;
  if (!plan) fail('找不到该日结构化菜单。', 404, 'PLAN_NOT_FOUND');
  if (filters.date && plan.date !== date(filters.date)) fail('日期与菜单ID不一致。');
  const view = intakeDraftView(plan, state.items);
  if (filters.mealIds !== undefined) {
    const ids = list(filters.mealIds, '餐次ID', 16).map(value => id(value));
    if (ids.some(value => !view.meals.some(meal => meal.id === value))) fail('要读取的餐次不存在。', 404, 'MEAL_NOT_FOUND');
    view.meals = view.meals.filter(meal => ids.includes(meal.id));
  }
  const result = { available: true, revision: state.revision, ...view,
    instructions: '这是当前菜单的实际进食草稿与余额预览。draft里的累计量/转餐未成为实际；reportedQuantity才来自已提交事实。保存草稿不动菜单、实际、补给或库存，submit_intake_draft明确提交才原子结算；同ID重试不重扣。stale需要刷新重核，不能覆盖其他处新实际。' };
  if (JSON.stringify(result).length > 32000) fail('进食草稿预览过大，请用mealIds缩小餐次范围，原数据未截断。', 413, 'INTAKE_DRAFT_VIEW_TOO_LARGE');
  return result;
}
/** Only targeted day/plan reads expose the preparation rollup; general briefs stay small. */
export function readDailyFoodSummary(state, filters = {}) {
  if (filters.expectedRevision !== undefined && (!Number.isSafeInteger(filters.expectedRevision) || filters.expectedRevision < 0)) fail('expectedRevision必须为非负整数。');
  if (filters.expectedRevision !== undefined && filters.expectedRevision !== state.revision) fail('库存与菜单版本已变化，请从全天明细第一页重新读取。', 409, 'REVISION_CONFLICT');
  if (filters.planId && filters.recordId && id(filters.planId) !== id(filters.recordId)) fail('planId与recordId不一致。');
  const targetId = filters.planId ?? filters.recordId;
  const source = targetId ? (state.plans ?? []).find(plan => plan.id === id(targetId) && plan.format === 'meals_v1')
    : filters.date ? resolveDietDays((state.plans ?? []).filter(plan => plan.format === 'meals_v1' && plan.date === date(filters.date)), [], state.items)[0]?.plan : null;
  if (!source) return { available: false, note: '没有该日期的结构化当前菜单；历史原文及历史全天总量仍保留，不猜测迁移或重扣库存。' };
  if (filters.date && source.date !== date(filters.date)) fail('日期与计划ID不一致。');
  const summary = dailyFoodRollup(source, state.items);
  const page = dailyFoodRollupPage(summary, { cursor: filters.cursor ?? '0', limit: filters.limit ?? 50 });
  return { ...page, revision: state.revision,
    ...(page.hasMore ? { detail: { tool: 'read_diet_records', planId: source.id, summaryOnly: 'daily_food', cursor: page.nextCursor, expectedRevision: state.revision } } : {}),
    instructions: '全天食物按各餐保存的营养快照合并，不包含重复的计划和实际；foodTotals是食物合计，supplementTotals是计入营养的补给，totals为两者合计。allocations保留各餐分配，未完成餐为当前菜单，不证明已吃。hasMore时沿detail按同revision继续；历史记录与库存不变。' };
}
export function readDietRecords(state, filters = {}) {
  obj(filters, '读取参数');
  if (filters.summaryOnly !== undefined && filters.summaryOnly !== 'daily_food') fail('summaryOnly仅支持daily_food。');
  if (filters.summaryOnly === 'daily_food') {
    if (!(filters.date || filters.planId || filters.recordId) || filters.from || filters.to || filters.offset !== undefined) fail('全天明细需要单一date、planId或recordId，不与历史原文分段或日期范围混用。');
    const dailyFoodSummary = readDailyFoodSummary(state, filters);
    return { dailyFoodSummary, records: [], total: dailyFoodSummary.rowCount ?? 0, included: dailyFoodSummary.includedRows ?? 0,
      nextCursor: dailyFoodSummary.nextCursor ?? null, truncated: dailyFoodSummary.truncated === true };
  }
  const foodSummary = filters.date || filters.planId || filters.recordId ? readDailyFoodSummary(state, { date: filters.date, planId: filters.planId, recordId: filters.recordId }) : null;
  const intakeSource = filters.planId || filters.recordId ? (state.plans ?? []).find(plan => plan.id === (filters.planId ?? filters.recordId) && plan.format === 'meals_v1')
    : filters.date ? dailyOwner(state, filters.date) : null;
  const foodBundle = { ...(foodSummary ? { dailyFoodSummary: foodSummary } : {}),
    ...(intakeSource ? { intakeDraftState: intakeDraftStatus(intakeSource, state.items) } : {}) };
  let plans = [...(state.plans ?? []).filter((p) => p.format === 'meals_v1' || (p.format === undefined && Array.isArray(p.items))), ...(state.dietHistory ?? []).map(historySnapshot)];
  if (filters.recordId !== undefined) {
    const record = plans.find((p) => p.id === id(filters.recordId)); if (!record) fail('找不到饮食记录。', 404, 'PLAN_NOT_FOUND');
    const dates = new Set([record.date]); const summaries = summaryBundle(dailySummaryRows(state, dates), dates);
    // Only metadata is added. The text still serializes the exact original
    // snapshot, so joining fragments restores the record without derived data.
    return { ...fragment(record, filters.offset ?? 0, READ_BUDGET - JSON.stringify(summaries).length - JSON.stringify(foodBundle).length - 20), ...summaries, ...foodBundle };
  }
  for (const key of ['date', 'from', 'to']) if (filters[key] !== undefined) date(filters[key]);
  if (filters.date) plans = plans.filter((p) => p.date === filters.date); if (filters.from) plans = plans.filter((p) => p.date >= filters.from); if (filters.to) plans = plans.filter((p) => p.date <= filters.to); if (filters.planId) plans = plans.filter((p) => p.id === id(filters.planId));
  plans = plans.slice().sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)); const offset = filters.cursor === undefined ? 0 : Number(filters.cursor); if (!Number.isSafeInteger(offset) || offset < 0 || offset > plans.length) fail('分页cursor无效。'); const limit = filters.limit ?? 14; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('limit必须为1至50。');
  const records = []; let cursor = offset;
  const summaryRows = dailySummaryRows(state, new Set(plans.slice(offset, offset + limit).map(record => record.date)));
  const response = (page, next) => {
    const summaries = summaryBundle(summaryRows, new Set(page.map(record => record.date)));
    return { records: page, total: plans.length, included: page.length, nextCursor: next < plans.length ? String(next) : null,
      truncated: next < plans.length || page.some(record => record.recordTruncated) || summaries.dailyNutritionSummariesTruncated || foodSummary?.hasMore === true,
      ...summaries, ...foodBundle, quantityMeaning: 'remaining_after_actual_and_legacy_credits', intakeExplanation: '当前菜单保存后立即可见并可编辑；保存、采用、修改不预留或扣库存，只有明确实际摄入才结算。foodAccounting=actual_only为新菜单，未标记的历史已预留用量保留原抵扣、不重新扣除。confirmed_daily_plan不等于实际已吃；actualTime未报告则为null。dailyNutritionSummaries与网页共用每日汇总，value在partial=true时只是已知部分；supplementPartial单独保留补给缺项。recordType=diet_history是独立历史存档，inventoryEffect=none，绝不影响当前库存。' };
  };
  while (cursor < plans.length && records.length < limit) {
    const record = plans[cursor]; const full = clone(record);
    if (JSON.stringify(response([...records, full], cursor + 1)).length > READ_BUDGET) {
      if (records.length) break;
      records.push({ id: record.id, date: record.date, title: record.title.slice(0, 100), ...(record.recordType === 'diet_history' ? { recordType: record.recordType, inventoryEffect: record.inventoryEffect, confirmation: record.confirmation } : { status: record.status }), ...(record.supplementOnly ? { supplementOnly: true } : {}), ...(record.supplementAccounting ? { supplementAccounting: record.supplementAccounting } : {}), recordTruncated: true, detail: { recordId: record.id, offset: 0 }, instructions: '此记录超出单次输出预算，使用recordId+offset读取无损分段。' }); cursor++; break;
    }
    records.push(full); cursor++;
  }
  return response(records, cursor);
}
export function dietContext(state, forDate) {
  const day = date(forDate); const all = (state.plans ?? []).filter((p) => p.format === 'meals_v1' && p.date === day);
  const history = historyContext(state, day); const historyTotal = (state.dietHistory ?? []).filter(record => record.date === day).length;
  const dates = new Set([day]); const summaries = summaryBundle(dailySummaryRows(state, dates), dates);
  const result = { date: day, records: [], total: all.length + historyTotal, truncated: history.length < historyTotal || summaries.dailyNutritionSummariesTruncated, ...summaries,
    instructions: ['排餐先读取最新库存与当天当前菜单；保存或局部修改立即显示，不需要确认最终版，不预留或扣库存。', '同一天沿用canonical planId及稳定的mealId、itemId和doseId；补给打卡独立于食物菜单。旧supplementOnly的draft.meals仍为当前菜单，不能遗漏或重建三餐。', '全天营养默认按当前菜单展示；已报告餐次使用实际，未完成餐次保留计划，不冒称已吃。', 'dailyNutritionSummaries与网页共用每日汇总；value在partial=true时只是已知部分，不得当全天完整总量，estimated/source保留来源。补给缺项另见supplementPartial。', '常备食品不盘点仍应保存带来源的nutrition估算kcal/P/C/F，不能遗漏或用0代替未知。', 'actualTime缺失保持null，不能复制计划时间。食物完成不自动表示补给已服。', '用户明确吃完才record_meal_intake结算实际；可逐餐或meals[]全天一次报告。复用原实际ID，更正用correct只调差量，历史预留作为抵扣，不再调用普通consume重复扣减。', 'diet_history是独立历史且inventoryEffect=none，不得据其再次扣库存或退款；final_plan不等于实际已吃。', 'truncated或issuesTruncated为true时，使用read_diet_records按日期/planId或recordId分页读取原文后再修改。'] };
  for (const plan of all) {
    const record = compact(plan, state.items);
    if (JSON.stringify({ ...result, records: [...result.records, record] }).length <= CONTEXT_BUDGET) result.records.push(record);
    else {
      const pointer = { id: plan.id, date: plan.date, title: plan.title.slice(0, 80), status: plan.status, inventoryAccounting: plan.inventoryAccounting, ...(plan.supplementOnly ? { supplementOnly: true } : {}), ...(plan.supplementAccounting ? { supplementAccounting: plan.supplementAccounting } : {}), detailRequired: true, recordId: plan.id };
      if (JSON.stringify({ ...result, records: [...result.records, pointer] }).length <= CONTEXT_BUDGET) result.records.push(pointer);
      result.truncated = true; break;
    }
  }
  for (const record of history) {
    if (JSON.stringify({ ...result, records: [...result.records, record] }).length > CONTEXT_BUDGET) { result.truncated = true; break; }
    result.records.push(record);
  }
  return result;
}
