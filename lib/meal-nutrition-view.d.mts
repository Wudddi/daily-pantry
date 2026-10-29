import type { Meal, DietPlan } from './diet-types';
import type { PlanNutritionTotal } from './diet-nutrition.mjs';

export type MealNutrientSource = 'label' | 'recipe' | 'estimate' | 'unknown';
export type MealNutritionRow = {
  id: string; itemId: string | null; name: string; quantity: number | null; unit: string;
  displayQuantity?: number | null; displayUnit?: string;
  origin: 'planned' | 'reported' | 'remaining'; totals: PlanNutritionTotal[];
  partial: boolean; estimated: boolean; zero: boolean; quantityUnknown: boolean; conversionMissing: boolean;
  nutritionSource: MealNutrientSource;
  nutrientSources: Record<'kcal' | 'protein' | 'carbs' | 'fat', MealNutrientSource>;
  sourceNote: string; sourceText: string; remainingNote: string;
};
export type MealNutritionView = {
  mealId: string; mode: 'planned' | 'partial' | 'actual'; basisLabel: string; note: string;
  issues: { code: string; message: string }[];
  /** Exactly the existing daily algorithm's contribution for this meal, without supplements or history-day fallback. */
  totals: PlanNutritionTotal[]; partial: boolean; estimated: boolean;
  /** Effective contribution rows; normal planned/actual rows add to the meal total. */
  rows: MealNutritionRow[];
  /** Separate evidence/display sections. In partial mode these sections are not an alternate total formula. */
  plannedRows: MealNutritionRow[]; actualRows: MealNutritionRow[]; remainingRows: MealNutritionRow[];
};
export function mealNutritionView(meal: Meal, options?: { planStatus?: DietPlan['status']; planId?: string }): MealNutritionView;
