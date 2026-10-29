import { nutritionFactor, nutritionTotalsFromLines, planNutritionLines } from './diet-nutrition.mjs';
import { historyNutritionSignature } from './diet-history-nutrition.mjs';
import { projectCurrentDietPlan } from './diet-current-plan.mjs';

const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const keyName = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const close = (a, b) => Math.abs(a - b) <= 0.02;
const issue = (code, message, recordId) => ({ code, message, ...(recordId ? { recordId } : {}) });
const round = value => Math.round(value * 1e6) / 1e6;

function latest(records) {
  return records.map((record, index) => ({ record, index })).sort((a, b) =>
    (Date.parse(b.record.updatedAt ?? b.record.createdAt ?? '') || 0) - (Date.parse(a.record.updatedAt ?? a.record.createdAt ?? '') || 0)
    || b.index - a.index).map(row => row.record);
}

function plannedQuantity(entry) {
  if (finite(entry.plannedQuantity)) return entry.plannedQuantity;
  if (entry.plannedQuantity === null && entry.quantitySource === 'reported' && finite(entry.actualQuantity)) return null;
  return finite(entry.quantity) ? entry.quantity : null;
}

function historyLines(record, actual = true) {
  const result = [];
  for (const [entities, supplement] of [[rows(record.meals), false], [rows(record.supplements), true]]) {
    for (const entity of entities) {
      for (const entry of supplement ? [entity] : rows(entity.items)) {
        const planned = plannedQuantity(entry);
        const hasActual = actual && finite(entry.actualQuantity) && ['reported', 'confirmed_plan_portion'].includes(entry.quantitySource);
        const quantity = hasActual ? entity.status === 'partial_report' && finite(planned)
          ? Math.max(planned, entry.actualQuantity) : entry.actualQuantity : planned;
        // History nutrition is the TOTAL for its saved portion, never per100g.
        const portion = finite(planned) && planned > 0 ? planned : finite(entry.quantity) && entry.quantity > 0 ? entry.quantity : null;
        result.push({ itemId: entry.inventoryItemId ?? null, name: entry.name, quantity, unit: entry.unit,
          entityId: entity.id, lineId: entry.id, supplement, origin: hasActual ? 'reported' : 'planned',
          snapshot: portion === null ? null : { name: entry.name, unit: entry.unit, gramsPerUnit: null,
            ingredients: '', supplementFacts: '', nutrition: { ...entry.nutrition, basisAmount: portion, basisUnit: entry.unit } } });
      }
    }
  }
  return result;
}

function historyFoodChanged(record) {
  return rows(record.meals).some(meal => rows(meal.items).some(entry =>
    ['reported', 'confirmed_plan_portion'].includes(entry.quantitySource) && finite(entry.actualQuantity)
    && (!finite(plannedQuantity(entry)) || Math.abs(entry.actualQuantity - plannedQuantity(entry)) >= 0.000001)));
}

function sameLine(a, b) {
  return a.supplement === b.supplement && (a.supplement || a.entityId === b.entityId)
    && keyName(a.name) !== '' && keyName(a.name) === keyName(b.name)
    && (a.itemId == null || b.itemId == null || a.itemId === b.itemId)
    && typeof a.unit === 'string' && a.unit === b.unit && finite(a.quantity) && finite(b.quantity)
    && Math.abs(a.quantity - b.quantity) < 0.000001;
}

/** One-to-one comparison; repeated foods and separate portions are not merged. */
function matchLines(lines, other) {
  if (lines.length !== other.length) return null;
  const used = new Set();
  const pairs = [];
  for (const line of lines) {
    const index = other.findIndex((candidate, i) => !used.has(i) && sameLine(line, candidate));
    if (index < 0) return null;
    used.add(index);
    pairs.push([line, other[index]]);
  }
  return pairs;
}

function contribution(line, key) {
  if (line.quantity === 0) return 0;
  const factor = nutritionFactor(line.snapshot, line.quantity, line.unit);
  const value = line.snapshot?.nutrition?.[key];
  return factor !== null && finite(value) ? factor * value : null;
}

function conflicts(pair) {
  return KEYS.some(key => {
    const a = contribution(pair[0], key), b = contribution(pair[1], key);
    return a !== null && b !== null && !close(a, b);
  });
}

function fillFromHistory(lines, pairs) {
  const corresponding = new Map(pairs.filter(pair => !conflicts(pair)));
  const filled = new Set();
  const next = lines.map(line => {
    const historical = corresponding.get(line);
    if (!historical) return line;
    const nutrition = { basisAmount: 1, basisUnit: '份', source: 'unknown', nutrientSources: {} };
    for (const key of KEYS) {
      const current = contribution(line, key), fallback = contribution(historical, key);
      nutrition[key] = current ?? fallback;
      const origin = current !== null ? line.snapshot?.nutrition : historical.snapshot?.nutrition;
      nutrition.nutrientSources[key] = nutrition[key] === null ? 'unknown' : origin?.nutrientSources?.[key] ?? origin?.source ?? 'unknown';
      if (current === null && fallback !== null) filled.add(key);
    }
    return { ...line, quantity: 1, unit: '份', snapshot: { name: line.name, unit: '份', gramsPerUnit: null,
      ingredients: '', supplementFacts: '', nutrition } };
  });
  return { lines: next, filled };
}

function withDayTotal(total, value, nutrition, source) {
  const complete = total.supplementMissing === 0;
  return { ...total, value, knownCount: total.knownCount + total.missing, missing: 0,
    estimated: total.estimated || nutrition?.source === 'estimate', partial: false,
    complete, completeValue: complete ? value : null, source };
}

function finish(record, recordType, plan, history, totals, basis, issues, matchedHistoryId = null) {
  const sources = new Set(totals.map(total => total.source));
  return { date: record.date, id: record.id, recordType, record, plan, history, totals,
    partial: totals.some(total => total.partial), supplementPartial: totals.some(total => total.supplementPartial),
    basis, nutritionSource: sources.size === 1 ? [...sources][0] : 'mixed', matchedHistoryId,
    issues, hasDraft: !!plan?.draft };
}

function planSummary(plan, histories) {
  const lines = planNutritionLines(plan);
  let totals = nutritionTotalsFromLines(lines);
  const issues = [];
  if (plan.draft && ['draft', 'reserved'].includes(plan.status)) issues.push(issue('CURRENT_MENU_DRAFT', '已显示最新保存的菜单修改；已报告的实际进食与补给保持原记录。', plan.id));
  if (rows(plan.meals).some(meal => meal.state === 'in_progress')) issues.push(issue('INCOMPLETE_ACTUAL_REPORT', '部分回报未结束；未报告部分继续按菜单保留，不视作没吃。', plan.id));
  if (plan.status === 'cancelled') return finish(plan, 'plan', plan, null, totals, 'cancelled', issues);
  const food = lines.filter(line => !line.supplement), doses = lines.filter(line => line.supplement);
  let matched = null;
  for (const history of histories) {
    const historical = historyLines(history);
    const foodPairs = matchLines(food, historical.filter(line => !line.supplement));
    if (!foodPairs) continue;
    const dosePairs = matchLines(doses, historical.filter(line => line.supplement));
    matched = { history, foodPairs, dosePairs, historical };
    break;
  }
  if (!matched) {
    if (histories.length) issues.push(issue('HISTORY_MENU_MISMATCH', '同日历史菜单的身份、份量、单位或餐次不一致，未合并旧营养。', histories[0].id));
    return finish(plan, 'plan', plan, null, totals,
      plan.status === 'draft' ? 'draft_plan' : plan.status === 'closed_with_actuals' ? 'reported_only' : 'confirmed_plan', issues);
  }
  const { history, foodPairs, dosePairs, historical } = matched;
  const pairs = [...foodPairs, ...(dosePairs ?? [])];
  const conflicting = pairs.some(conflicts);
  if (conflicting) issues.push(issue('HISTORY_NUTRITION_MISMATCH', '历史份量营养与当前快照存在差异，冲突项及旧全天总值未覆盖当前依据。', history.id));
  if (!dosePairs) issues.push(issue('HISTORY_SUPPLEMENT_MISMATCH', '补给份量或身份不同；仅核对相同食物条目，未采用历史整天总值。', history.id));
  const filled = fillFromHistory(lines, pairs);
  totals = nutritionTotalsFromLines(filled.lines);
  totals = totals.map(total => filled.filled.has(total.key) ? { ...total, source: 'matched_history_items' } : total);
  const unchangedHistory = !historyFoodChanged(history);
  totals = totals.map(total => {
    if (!total.partial || !finite(history.nutrition?.[total.key]) || !dosePairs || conflicting || !unchangedHistory) return total;
    if (history.nutritionSignatures?.[total.key] !== undefined && history.nutritionSignatures[total.key] !== historyNutritionSignature(history)) return total;
    // Each already-known current contribution must be independently corroborated
    // by that history portion before its old full-day figure can fill gaps.
    const verified = pairs.every(([a, b]) => {
      const known = contribution(a, total.key);
      return known === null || contribution(b, total.key) !== null && close(known, contribution(b, total.key));
    });
    if (!verified && !issues.some(entry => entry.code === 'HISTORY_TOTAL_UNVERIFIED')) issues.push(issue('HISTORY_TOTAL_UNVERIFIED', '部分当前营养快照缺少同份历史数值佐证，未用旧全天总量掩盖缺失。', history.id));
    return verified ? withDayTotal(total, history.nutrition[total.key], history.nutrition, 'matched_history_total') : total;
  });
  return finish(plan, 'plan', plan, history, totals,
    plan.status === 'draft' ? 'draft_plan' : plan.status === 'closed_with_actuals' ? 'reported_only' : 'confirmed_plan', issues, history.id);
}

function historySummary(history) {
  const lines = historyLines(history);
  let totals = nutritionTotalsFromLines(lines, 'history_items');
  const changedFood = historyFoodChanged(history);
  const issues = changedFood ? [issue('HISTORY_ACTUAL_DIFFERS', '已报告食物与原计划不同；仅与当前证据绑定的重算字段可作为全天值，未绑定旧值不沿用。', history.id)] : [];
  const signature = historyNutritionSignature(history);
  totals = totals.map(total => {
    const saved = history.nutrition?.[total.key];
    if (!finite(saved)) return total;
    const binding = history.nutritionSignatures?.[total.key];
    const currentBinding = binding === signature;
    if (binding !== undefined && !currentBinding) {
      if (!issues.some(item => item.code === 'HISTORY_NUTRITION_STALE')) issues.push(issue('HISTORY_NUTRITION_STALE', '菜单证据已变化，未重新提供的旧全天营养字段已失效。', history.id));
      return total;
    }
    if (changedFood && !currentBinding) return total;
    if (changedFood && currentBinding) return withDayTotal(total, saved, history.nutrition, 'history_total');
    // A complete sum contradicting a recorded total is evidence, not permission
    // to silently overwrite either value. Prefer the auditable item sum.
    if (!total.partial && total.knownCount > 0 && total.supplementMissing === 0 && !close(total.value, saved)) {
      if (!issues.some(item => item.code === 'HISTORY_TOTAL_CONFLICT')) issues.push(issue('HISTORY_TOTAL_CONFLICT', '历史全天值与完整条目求和不一致；显示条目求和并保留原值。', history.id));
      return total;
    }
    return withDayTotal(total, saved, history.nutrition, 'history_total');
  });
  return finish(history, 'diet_history', null, history, totals, 'historical_plan', issues);
}

/**
 * One selected record per date. Never sums native plans and historical copies.
 * Values may be known subtotals: partial and supplementMissing are mandatory
 * coverage signals; completeValue is null unless every included value is known.
 */
export function resolveDietDays(plans = [], history = [], inventoryItems = []) {
  // A daily supplement checklist is not a complete menu or a zero-food day.
  // Its actual facts remain readable through diet records, outside this view.
  const menuPlans = rows(plans).map(plan => projectCurrentDietPlan(plan, inventoryItems))
    .filter(plan => !plan?.supplementOnly || rows(plan.meals).length > 0);
  const dates = new Set([...menuPlans, ...rows(history)].map(record => record?.date).filter(date => typeof date === 'string' && /^\d{4}-\d\d-\d\d$/.test(date)));
  const result = [];
  for (const date of [...dates].sort().reverse()) {
    const candidates = latest(menuPlans.filter(plan => plan?.date === date && Array.isArray(plan.meals)
      && ['draft', 'reserved', 'closed_with_actuals', 'cancelled'].includes(plan.status)));
    const histories = latest(rows(history).filter(record => record?.date === date && Array.isArray(record.meals)));
    const plan = candidates.find(candidate => ['reserved', 'closed_with_actuals'].includes(candidate.status))
      ?? candidates.find(candidate => candidate.status === 'draft')
      ?? candidates.find(candidate => candidate.status === 'cancelled');
    if (plan) result.push(planSummary(plan, histories));
    else if (histories[0]) result.push(historySummary(histories[0]));
  }
  return result;
}
