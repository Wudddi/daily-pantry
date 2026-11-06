import type { DietPlan, Meal } from './diet-types';
import type { FoodItem } from './inventory-types';
import type { PlanNutritionTotal } from './diet-nutrition.mjs';
export type FoodPlanSyncPreview = {
  fingerprint: string; canApply: boolean; noChange: boolean; hasIntakeDraft: boolean;
  issues: { code: string; message: string; mealId?: string; severity: 'error' | 'warning' | 'skip' }[];
  meals: { mealId: string; slot: Meal['slot']; title: string; state: Meal['state']; supported: boolean; changed: boolean;
    changes: { lineId: string; name: string; beforeQuantity: number | null; beforeUnit: string; afterQuantity: number | null; afterUnit: string; kind: 'add' | 'update' | 'remove' }[];
    beforeTotals: PlanNutritionTotal[]; afterTotals: PlanNutritionTotal[] }[];
};
export function previewFoodPlanSync(plan: DietPlan, items?: readonly FoodItem[]): FoodPlanSyncPreview;
export function applyFoodPlanSync(plan: DietPlan, items: readonly FoodItem[], expectedFingerprint: string): { plan: DietPlan; preview: FoodPlanSyncPreview; noChange: boolean };
