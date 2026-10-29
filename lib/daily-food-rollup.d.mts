import type { DietPlan, MealSlot } from './diet-types';
import type { FoodItem } from './inventory-types';
import type { PlanNutritionTotal } from './diet-nutrition.mjs';

export type DailyFoodAllocation = {
  mealId: string; mealSlot: MealSlot; mealTitle: string; state: string; unit: string;
  quantity: number | null; knownQuantity: number; quantityUnknown: boolean;
  origin: 'planned' | 'reported' | 'mixed';
};
export type DailyFoodRollupRow = {
  id: string; itemId: string | null; name: string; unit: string; quantity: number | null;
  displayQuantity: number | null; displayUnit: string; knownQuantity: number; quantityUnknown: boolean;
  totals: PlanNutritionTotal[]; partial: boolean; estimated: boolean; nutritionBasisVaries: boolean;
  allocations: DailyFoodAllocation[];
};
export type DailyFoodRollup = {
  format: 'daily_food_rollup_v1'; planId: string | null; date: string | null;
  basis: 'current_menu_with_reported_actuals'; rows: DailyFoodRollupRow[]; rowCount: number;
  foodTotals: PlanNutritionTotal[]; supplementTotals: PlanNutritionTotal[]; totals: PlanNutritionTotal[];
  partial: boolean; estimated: boolean; supplementPartial: boolean;
  issues: { code: string; message: string }[];
};
export function dailyFoodRollup(plan: DietPlan, inventoryItems?: readonly FoodItem[]): DailyFoodRollup;
export type DailyFoodReadTotal = Pick<PlanNutritionTotal, 'key' | 'value' | 'estimated' | 'partial' | 'supplementPartial'>
  & { missing?: number; supplementMissing?: number };
export type DailyFoodReadAllocation = Omit<DailyFoodAllocation, 'mealTitle' | 'knownQuantity'> & {
  /** Only provided when quantity is unknown; otherwise it equals quantity. */
  knownQuantity?: number;
};
export type DailyFoodReadRow = Omit<DailyFoodRollupRow, 'totals' | 'allocations' | 'displayQuantity' | 'displayUnit' | 'knownQuantity'> & {
  /** quantity/unit already use the reliable display amount (g/mL/retained unit). */
  knownQuantity?: number;
  totals: DailyFoodReadTotal[]; allocations: DailyFoodReadAllocation[];
};
export type DailyFoodRollupPage = Omit<DailyFoodRollup, 'rows'> & {
  rows: DailyFoodReadRow[];
  available: true; rowOffset: number; includedRows: number; hasMore: boolean;
  nextCursor: string | null; truncated: boolean;
};
export function dailyFoodRollupPage(summary: DailyFoodRollup, options?: { cursor?: string; limit?: number; budget?: number }): DailyFoodRollupPage;
