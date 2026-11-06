import type { DietPlan } from './diet-types';
import type { FoodItem } from './inventory-types';
import type { IntakeDraftView, IntakeDraftMeal } from './intake-draft.mjs';
import type { PlanNutritionTotal } from './diet-nutrition.mjs';
export type PersonalFoodChecklistView = Omit<IntakeDraftView, 'dayRows' | 'totals'> & {
  /** Original planned-row meal identity, available only while layout overrides are active. */
  sourceMeals?: IntakeDraftMeal[];
  dayRows: {itemId: string | null; name: string; unit: string; plannedQuantity: number | null; checkedQuantity: number | null; uncheckedQuantity: number | null}[];
  mealTotals: {mealId: string; totals: PlanNutritionTotal[]}[];
  totals: {planned: PlanNutritionTotal[]; checked: PlanNutritionTotal[]; unchecked: PlanNutritionTotal[]};
};
export function personalFoodChecklistView(plan: DietPlan, items?: readonly FoodItem[], isChecked?: (mealId:string,lineId:string)=>boolean): PersonalFoodChecklistView;
