import type { DietPlan, Meal } from './diet-types';
import type { FoodItem } from './inventory-types';
import type { PlanNutritionTotal } from './diet-nutrition.mjs';

export type ChecklistNutritionBasis = {
  plannedFoodTotals: PlanNutritionTotal[];
  effectiveFoodTotals: PlanNutritionTotal[];
  supplementTotals: PlanNutritionTotal[];
  totalTotals: PlanNutritionTotal[];
  /** Signed actual/retained-plan minus checklist-plan values; null if either food basis is incomplete. */
  foodDelta: PlanNutritionTotal[];
  meals: {
    mealId: string;
    state: Meal['state'];
    plannedFoodTotals: PlanNutritionTotal[];
    effectiveFoodTotals: PlanNutritionTotal[];
    foodDelta: PlanNutritionTotal[];
  }[];
  headerComparison: {
    provided: boolean;
    matches: boolean;
    byNutrient: { key: PlanNutritionTotal['key']; matches: boolean }[];
    historyBasis: boolean;
    canReconcile: boolean;
    reason: null | 'history_evidence' | 'header_mismatch' | 'incomplete_food_basis' | 'unknown_supplement_basis';
  };
};

export function checklistNutritionBasis(plan: DietPlan, inventoryItems?: readonly FoodItem[], options?: {
  headerTotals?: readonly PlanNutritionTotal[];
}): ChecklistNutritionBasis;
