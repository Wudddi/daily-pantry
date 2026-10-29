import { nutritionFactor, nutritionTotalsFromLines, planNutritionLines, transferredFoodRemainders } from './diet-nutrition.mjs';
import { mealExecutionView } from './diet-edit-read.mjs';
import { foodDisplayAmount } from './food-display-amount.mjs';

const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
const SOURCES = new Set(['label', 'recipe', 'estimate', 'unknown']);
const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const issue = (code, message) => ({ code, message });

function sameFood(a, b) {
  return a.itemId != null || b.itemId != null
    ? a.itemId != null && a.itemId === b.itemId
    : !!nameKey(a.name) && nameKey(a.name) === nameKey(b.name);
}

function viewRows(lines, origin, notes = new Map()) {
  return lines.map((line, index) => {
    const totals = nutritionTotalsFromLines([line]);
    const nutrition = line.snapshot?.nutrition;
    const display = foodDisplayAmount(line);
    return {
      id: line.lineId ?? String(index), itemId: line.itemId ?? null,
      name: line.name || line.snapshot?.name || line.itemId || '未命名食物',
      quantity: line.quantity, unit: line.unit, origin: origin ?? line.origin ?? 'planned',
      displayQuantity: display.quantity, displayUnit: display.unit,
      totals, partial: totals.some(total => total.partial), estimated: totals.some(total => total.estimated),
      zero: line.quantity === 0, quantityUnknown: !finite(line.quantity),
      conversionMissing: finite(line.quantity) && line.quantity !== 0 && nutritionFactor(line.snapshot, line.quantity, line.unit) === null,
      nutritionSource: SOURCES.has(nutrition?.source) ? nutrition.source : 'unknown',
      nutrientSources: Object.fromEntries(KEYS.map(key => [key, finite(nutrition?.[key])
        ? SOURCES.has(nutrition.nutrientSources?.[key] ?? nutrition.source) ? nutrition.nutrientSources?.[key] ?? nutrition.source : 'unknown'
        : 'unknown'])),
      sourceNote: typeof nutrition?.sourceNote === 'string' ? nutrition.sourceNote : '',
      sourceText: typeof nutrition?.sourceText === 'string' ? nutrition.sourceText : '',
      remainingNote: notes.get(line.lineId) ?? '',
    };
  });
}

function differentNutritionBasis(a, b) {
  const aRatio = nutritionFactor(a.snapshot, 1, a.unit), bRatio = nutritionFactor(b.snapshot, 1, b.unit);
  return KEYS.some(key => {
    const av = aRatio !== null && finite(a.snapshot?.nutrition?.[key]) ? aRatio * a.snapshot.nutrition[key] : null;
    const bv = bRatio !== null && finite(b.snapshot?.nutrition?.[key]) ? bRatio * b.snapshot.nutrition[key] : null;
    return av === null || bv === null ? av !== bv : Math.abs(av - bv) > 0.000001;
  });
}

/**
 * Native meals_v1 display adapter. Aggregation and unit conversion belong to the
 * existing daily algorithm; presentation sections must never be added again.
 * No current inventory, history-day totals or pending draft is substituted.
 */
export function mealNutritionView(meal, { planStatus = 'reserved', planId } = {}) {
  const input = meal && typeof meal === 'object' ? meal : {};
  const execution = mealExecutionView(input);
  const plan = { id: planId, status: planStatus, meals: [input], supplementDoses: [] };
  const incoming = input.state === 'completed' && rows(input.actualEntries).length && !['cancelled', 'closed_with_actuals'].includes(planStatus)
    ? transferredFoodRemainders(planId, input) : [];
  const effective = planNutritionLines(plan);
  const planned = planNutritionLines({ ...plan, status: 'reserved', meals: [{ ...input, state: 'reserved', actualEntries: [] }] });
  // Cancellation's existing branch is explicitly actual-only, including [] and 0.
  const actual = planNutritionLines({ ...plan, status: 'cancelled' });
  const remaining = planNutritionLines({ ...plan, status: 'reserved', meals: [{
    ...input, state: 'reserved', actualEntries: [], plannedItems: incoming.length ? incoming : execution.remainingItems,
  }] });
  const totals = nutritionTotalsFromLines(effective);
  const mode = planStatus === 'cancelled' ? 'actual' : incoming.length ? 'partial' : execution.mode;
  const issues = [];
  let basisLabel = '本餐计划', note = '按保存的本餐计划计算；未打卡不等于没有吃，不要求逐餐确认。';
  if (mode === 'planned' && planStatus === 'draft') {
    basisLabel = '本餐当前菜单';
    note = '按已保存的当前菜单计算；随时可改，实际吃完并报告后才结算食物库存。';
  }
  if (incoming.length) {
    basisLabel = '已报告＋重新分配';
    note = '合计包含原实际记录和后来转入但尚未吃下的食物；分餐不代表已吃，原完成记录与其它未吃的旧计划保持不变。';
    issues.push(issue('TRANSFERRED_MENU_REMAINING', note));
  } else if (mode === 'partial') {
    basisLabel = '已报告＋保留计划';
    note = '本餐合计沿用全天的当前安排口径：同食物保留计划与已报告量的较大值，其余计划继续保留。实际与剩余明细用于对照，请勿另行相加。';
    issues.push(issue('PARTIAL_MENU_BASIS', note));
    if (actual.some(entry => planned.some(line => sameFood(line, entry) && line.unit !== entry.unit))) {
      issues.push(issue('PARTIAL_UNIT_CONFLICT', '同一食物的计划与实际单位不兼容；该食物在本餐合计中保留未知，不当成两份相加。'));
    }
    if (actual.some(entry => entry.quantity === null)) {
      issues.push(issue('PARTIAL_QUANTITY_UNKNOWN', '部分实际用量未报告；仍保留原计划，未知实际量不会当作零或额外一份。'));
    }
    if (actual.some(entry => planned.some(line => sameFood(line, entry) && line.unit === entry.unit && differentNutritionBasis(line, entry)))) {
      issues.push(issue('PARTIAL_NUTRITION_BASIS_DIFFERENCE', '同食物的实际与计划营养依据不同；本餐合计继续沿用全天的有效完整计划口径，不按实际明细加剩余明细重算，也不刷新已保存快照。'));
    }
  } else if (mode === 'actual') {
    if (actual.length) {
      basisLabel = '本餐实际';
      note = '按已报告的实际食物计算；零用量表示未吃，未知用量或营养保留未知，原计划仅供对照。';
    } else if (input.state === 'cancelled' || planStatus === 'cancelled') {
      basisLabel = '已取消 · 无实际记录';
      note = '取消部分不计入菜单；没有已报告的实际食物，本餐当前计入零。';
    } else {
      basisLabel = '本餐计划 · 实际内容未报';
      note = '已标记完成但尚未报告具体实际食物；合计沿用原计划，不将此数值称为实际摄入。';
      issues.push(issue('COMPLETED_CONTENT_UNREPORTED', note));
    }
  }
  return {
    mealId: input.id ?? '', mode, basisLabel, note, issues,
    totals, partial: totals.some(total => total.partial), estimated: totals.some(total => total.estimated),
    rows: viewRows(effective), plannedRows: viewRows(planned, 'planned'),
    actualRows: viewRows(actual, 'reported'),
    remainingRows: viewRows(remaining, 'remaining', new Map(rows(execution.remainingItems).map(line => [line.id, line.remainingNote ?? '']))),
  };
}
