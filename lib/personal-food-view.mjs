import { intakeDraftView } from './intake-draft.mjs';
import { foodDisplayAmount } from './food-display-amount.mjs';
import { nutritionTotalsFromLines } from './diet-nutrition.mjs';
import { isPersonalFoodChecked } from './personal-food-checklist.mjs';
import { foodLayoutTarget } from './food-layout.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const sum = (a, b) => finite(a) && finite(b) ? Math.round((a + b) * 1e6) / 1e6 : null;

/** Personal reminders always describe planned portions, never inferred intake. */
export function personalFoodChecklistView(plan, items = [], isChecked = (mealId, lineId) => isPersonalFoodChecked(plan, mealId, lineId)) {
  const base = intakeDraftView(plan, items, null), day = new Map(), all = [], checked = [], unchecked = [], mealTotals = [], lineNutrients = new Map();
  const meals = base.meals.map(meal => {
    const source = plan.meals.find(value => value.id === meal.id), nutritionLines = [];
    const rows = (source?.plannedItems ?? []).filter(line => !finite(line.quantity) || line.quantity > 0).map(line => {
      const existing = meal.rows.find(row => row.lineId === line.id), display = foodDisplayAmount(line);
      const name = line.name || line.nutritionSnapshot?.name || existing?.name || line.itemId || "Unnamed food";
      const sameDisplayUnit = !existing || existing.unit.toLowerCase() === display.unit.toLowerCase();
      const row = { lineId: line.id, itemId: line.itemId ?? null, name, unit: display.unit, plannedQuantity: display.quantity,
        eatenQuantity: sameDisplayUnit ? existing?.eatenQuantity ?? null : null, reportedQuantity: sameDisplayUnit ? existing?.reportedQuantity ?? null : null,
        externalReportedQuantity: sameDisplayUnit ? existing?.externalReportedQuantity ?? null : null,
        remainingQuantity: sameDisplayUnit ? existing ? existing.remainingQuantity : display.quantity : null,
        unknown: !sameDisplayUnit || (existing?.unknown ?? !finite(display.quantity)), canEdit: sameDisplayUnit && (existing?.canEdit ?? false),
        issue: !sameDisplayUnit ? "Actual weighed and planned units differ. Review them in advanced records before reallocating." : existing?.issue ?? "Review the specific quantity before reallocating this food." };
      const marked = isChecked(meal.id, line.id) === true;
      const key = JSON.stringify([line.itemId ?? null, line.itemId === null ? name : '', display.unit]);
      const daily = day.get(key) ?? { itemId: line.itemId ?? null, name, unit: display.unit, plannedQuantity: 0, checkedQuantity: 0, uncheckedQuantity: 0 };
      daily.plannedQuantity = sum(daily.plannedQuantity, display.quantity);
      daily.checkedQuantity = sum(daily.checkedQuantity, marked ? display.quantity : 0);
      daily.uncheckedQuantity = sum(daily.uncheckedQuantity, marked ? 0 : display.quantity);
      day.set(key, daily);
      const nutrient = { snapshot: line.nutritionSnapshot ?? null, quantity: line.quantity, unit: line.unit,
        itemId: line.itemId ?? null, name, entityId: meal.id, lineId: line.id, supplement: false, origin: 'planned' };
      all.push(nutrient); nutritionLines.push(nutrient); (marked ? checked : unchecked).push(nutrient);
      lineNutrients.set(JSON.stringify([meal.id,line.id]),nutrient);
      return row;
    });
    mealTotals.push({ mealId: meal.id, totals: nutritionTotalsFromLines(nutritionLines, 'personal_planned_food') });
    return { ...meal, rows };
  });
  const result = { ...base, meals, dayRows: [...day.values()], mealTotals, totals: {
    planned: nutritionTotalsFromLines(all, 'personal_planned_food'),
    checked: nutritionTotalsFromLines(checked, 'personal_checked_food'),
    unchecked: nutritionTotalsFromLines(unchecked, 'personal_unchecked_food'),
  } };
  if (!Array.isArray(plan.foodLayoutOverrides) || !plan.foodLayoutOverrides.length) return result;
  const byMeal = new Map(meals.map(meal => [meal.id,{ ...meal,rows:[] }]));
  const nutritionByMeal = new Map(meals.map(meal => [meal.id,[]]));
  for (const source of meals) for (const row of source.rows) {
    const targetId = foodLayoutTarget(plan,source.id,'planned',row.lineId);
    const target = byMeal.get(targetId) ?? byMeal.get(source.id);
    target.rows.push({ ...row,sourceMealId:source.id });
    const nutrient = lineNutrients.get(JSON.stringify([source.id,row.lineId]));
    if (nutrient) nutritionByMeal.get(target.id).push(nutrient);
  }
  return { ...result,sourceMeals:meals,meals:[...byMeal.values()],mealTotals:meals.map(meal => ({mealId:meal.id,
    totals:nutritionTotalsFromLines(nutritionByMeal.get(meal.id),'personal_planned_food')})) };
}
