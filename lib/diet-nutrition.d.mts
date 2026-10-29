import type { DietPlan, Meal, NutritionSnapshot } from './diet-types';

export type PlanNutritionTotal = {
  key: 'kcal' | 'protein' | 'carbs' | 'fat';
  value: number | null;
  knownCount: number;
  missing: number;
  supplementMissing: number;
  estimated: boolean;
  /** Missing food data; unknown supplement values are counted separately. */
  partial: boolean;
  supplementPartial: boolean;
  complete: boolean;
  completeValue: number | null;
  source: string;
};

export type NutritionSummaryLine = {
  snapshot: NutritionSnapshot;
  quantity: number | null;
  unit: string;
  itemId?: string | null;
  name?: string;
  entityId?: string;
  lineId?: string;
  supplement: boolean;
  origin?: 'planned' | 'reported';
};

export function nutritionFactor(snapshot: NutritionSnapshot, quantity: number, unit: string): number | null;
export function transferredFoodRemainders(planId: string | undefined, meal: Meal): (Omit<Meal['plannedItems'][number], 'quantity'> & { quantity: number | null })[];
export function planNutritionTotals(plan: Pick<DietPlan, 'meals' | 'supplementDoses'>): PlanNutritionTotal[];
export function planNutritionLines(plan: Pick<DietPlan, 'meals' | 'supplementDoses'> & Partial<Pick<DietPlan, 'id' | 'status'>>): NutritionSummaryLine[];
export function nutritionTotalsFromLines(lines: NutritionSummaryLine[], source?: string): PlanNutritionTotal[];
