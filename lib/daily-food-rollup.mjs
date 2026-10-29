import { planNutritionLines, nutritionTotalsFromLines } from './diet-nutrition.mjs';
import { projectCurrentDietPlan } from './diet-current-plan.mjs';
import { foodDisplayAmount } from './food-display-amount.mjs';

const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = value => Math.round(value * 1e6) / 1e6;
const keyName = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const signature = snapshot => JSON.stringify([snapshot?.unit ?? null, snapshot?.gramsPerUnit ?? null,
  snapshot?.nutrition?.basisAmount ?? null, snapshot?.nutrition?.basisUnit ?? null,
  ...['kcal', 'protein', 'carbs', 'fat'].map(key => snapshot?.nutrition?.[key] ?? null)]);

function amount(lines) {
  const knownQuantity = round(lines.reduce((sum, line) => sum + (finite(line.quantity) ? line.quantity : 0), 0));
  const quantityUnknown = lines.some(line => !finite(line.quantity));
  return { quantity: quantityUnknown ? null : knownQuantity, knownQuantity, quantityUnknown };
}

/**
 * Read-only daily preparation list. Saved snapshots remain its durable source:
 * no inventory labels, current quantities, or user-entered day totals substitute
 * for them. The same effective-menu algorithm drives the meal and day views.
 */
export function dailyFoodRollup(input, inventoryItems = []) {
  const plan = projectCurrentDietPlan(input ?? {}, inventoryItems);
  const allLines = planNutritionLines(plan);
  const foodLines = allLines.filter(line => !line.supplement);
  const supplementLines = allLines.filter(line => line.supplement);
  const meals = new Map(rows(plan.meals).map(meal => [meal.id, meal]));
  const groups = new Map();
  for (const [index, line] of foodLines.entries()) {
    const display = foodDisplayAmount(line);
    const name = line.name || line.snapshot?.name || line.itemId || '未命名食物';
    // A real inventory ID identifies its exact product/batch. Without an ID,
    // differing saved nutrition bases are insufficient proof of the same food.
    const identity = line.itemId != null ? ['item', line.itemId]
      : keyName(name) ? ['named', keyName(name), signature(line.snapshot)] : ['line', line.entityId, line.lineId, index];
    const key = JSON.stringify([...identity, display.unit]);
    let group = groups.get(key);
    if (!group) {
      group = { id: `daily-food:${key}`, itemId: line.itemId ?? null, name, unit: display.unit,
        lines: [], displayLines: [], allocationLines: new Map(), signatures: new Set() };
      groups.set(key, group);
    }
    group.lines.push(line);
    group.displayLines.push({ quantity: display.quantity });
    group.signatures.add(signature(line.snapshot));
    const meal = meals.get(line.entityId);
    let allocation = group.allocationLines.get(line.entityId);
    if (!allocation) {
      allocation = { mealId: line.entityId, mealSlot: meal?.slot ?? 'other', mealTitle: meal?.title ?? '',
        state: meal?.state ?? 'reserved', unit: display.unit, lines: [], origins: new Set() };
      group.allocationLines.set(line.entityId, allocation);
    }
    allocation.lines.push({ quantity: display.quantity });
    allocation.origins.add(line.origin);
  }
  const entries = [...groups.values()].map(group => {
    const totalAmount = amount(group.displayLines);
    const totals = nutritionTotalsFromLines(group.lines);
    return {
      id: group.id, itemId: group.itemId, name: group.name, ...totalAmount, unit: group.unit,
      displayQuantity: totalAmount.quantity, displayUnit: group.unit,
      totals, partial: totals.some(total => total.partial), estimated: totals.some(total => total.estimated),
      nutritionBasisVaries: group.signatures.size > 1,
      allocations: [...group.allocationLines.values()].map(({ lines, origins, ...allocation }) => ({
        ...allocation, ...amount(lines), origin: origins.size > 1 ? 'mixed' : [...origins][0] ?? 'planned',
      })),
    };
  });
  const foodTotals = nutritionTotalsFromLines(foodLines);
  const supplementTotals = nutritionTotalsFromLines(supplementLines);
  const totals = nutritionTotalsFromLines(allLines);
  return {
    format: 'daily_food_rollup_v1', planId: plan.id ?? null, date: plan.date ?? null,
    basis: 'current_menu_with_reported_actuals', rows: entries, rowCount: entries.length,
    foodTotals, supplementTotals, totals,
    partial: totals.some(total => total.partial), estimated: totals.some(total => total.estimated),
    supplementPartial: totals.some(total => total.supplementPartial),
    issues: [
      ...(entries.some(entry => entry.quantityUnknown) ? [{ code: 'QUANTITY_UNKNOWN', message: '部分食物用量或单位换算未明确，未将未知量当作0或与其他单位硬相加。' }] : []),
      ...(entries.some(entry => entry.nutritionBasisVaries) ? [{ code: 'SNAPSHOT_BASES_DIFFER', message: '同一食材的各餐按各自保存的营养依据计算后相加，未使用单一快照覆盖其他餐。' }] : []),
    ],
  };
}

function transportRow(row) {
  const { displayQuantity, displayUnit, knownQuantity, ...fields } = row;
  return {
    ...fields,
    // In the rollup quantity/unit already ARE the reliable display amount.
    // A separate known subtotal is only needed when the total is unknown.
    ...(row.quantity === null ? { knownQuantity } : {}),
    // Repeated calculation bookkeeping belongs to the rich local model, not
    // every food's MCP payload. Preserve all values and coverage/source flags.
    totals: row.totals.map(total => ({ key: total.key, value: total.value, estimated: total.estimated,
      partial: total.partial, supplementPartial: total.supplementPartial,
      ...(total.missing > 0 ? { missing: total.missing } : {}),
      ...(total.supplementMissing > 0 ? { supplementMissing: total.supplementMissing } : {}),
    })),
    allocations: row.allocations.map(({ mealTitle, knownQuantity, ...allocation }) => ({
      ...allocation, ...(allocation.quantity === null ? { knownQuantity } : {}),
    })),
  };
}

/** Bounded transport page; totals always cover the full day, rows never hide truncation. */
export function dailyFoodRollupPage(summary, { cursor = '0', limit = 50, budget = 18000 } = {}) {
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > summary.rows.length
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw Object.assign(new Error('全天明细分页参数无效。'), { status: 400, code: 'INVALID_DAILY_FOOD_PAGE' });
  }
  const page = [];
  const result = () => ({ ...summary, available: true, rows: page, rowOffset: offset, includedRows: page.length,
    hasMore: offset + page.length < summary.rows.length,
    nextCursor: offset + page.length < summary.rows.length ? String(offset + page.length) : null,
    truncated: offset > 0 || offset + page.length < summary.rows.length });
  for (const row of summary.rows.slice(offset, offset + limit)) {
    page.push(transportRow(row));
    if (JSON.stringify(result()).length > budget) { page.pop(); break; }
  }
  if (offset < summary.rows.length && page.length === 0) {
    throw Object.assign(new Error('单项全天明细超出读取预算，请按recordId读取保存的菜单原文。'), { status: 413, code: 'DAILY_FOOD_ROW_TOO_LARGE' });
  }
  return result();
}
