import type { DietPlan } from './diet-types';
import type { DietHistoryRecord } from './diet-history-types';
import type { PlanNutritionTotal } from './diet-nutrition.mjs';
import type { FoodItem } from './inventory-types';

export type DietDayIssue = { code: string; message: string; recordId?: string };
export type DietDaySummary = {
  date: string;
  id: string;
  recordType: 'plan' | 'diet_history';
  record: DietPlan | DietHistoryRecord;
  plan: DietPlan | null;
  history: DietHistoryRecord | null;
  totals: PlanNutritionTotal[];
  /** Missing food nutrients. Unknown supplements have their own coverage flag. */
  partial: boolean;
  supplementPartial: boolean;
  basis: 'confirmed_plan' | 'draft_plan' | 'reported_only' | 'historical_plan' | 'cancelled';
  nutritionSource: string;
  matchedHistoryId: string | null;
  issues: DietDayIssue[];
  hasDraft: boolean;
};

export function resolveDietDays(plans?: readonly DietPlan[], history?: readonly DietHistoryRecord[], inventoryItems?: readonly FoodItem[]): DietDaySummary[];
