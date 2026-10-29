import type { DailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
import type { AccountingWarning, DietPlan, Meal, PlannedFood, ActualEntry, MealSlot } from './diet-types';
import type { FoodItem, FoodFreshness, Plan } from './inventory-types';
import type { DietHistoryRecord } from './diet-history-types';
import type { PlanningPriorityMetadata } from './inventory-planning-priority.mjs';
import type { FoodPreferencesContext } from './food-preferences-context.mjs';
import type { ItemAccountingContext } from './inventory-accounting-context.mjs';
import type { DailyMenuSettlementSummary } from './daily-menu-settlement-context.mjs';

export type DietEditState = {
  revision: number; preferences: readonly string[]; items: readonly FoodItem[]; plans?: readonly (DietPlan | Plan)[]; dietHistory?: readonly DietHistoryRecord[];
};
export type FoodPlanEditFilters = {
  planId?: string; date?: string; mealIds?: string[]; mealSlots?: MealSlot[]; candidateItemIds?: string[];
  foodQuery?: string; view?: 'draft' | 'active'; expectedRevision?: number;
};
export type EditNutrition = {
  basisAmount: number | null; basisUnit: string | null; kcal: number | null; protein: number | null;
  carbs: number | null; fat: number | null; source: string;
  nutrientSources: Record<'kcal' | 'protein' | 'carbs' | 'fat', string>;
  sourceTextAvailable: boolean; sourceNoteAvailable: boolean;
};
export type EditNutritionTotal = {
  key: 'kcal' | 'protein' | 'carbs' | 'fat'; value: number | null; partial: boolean;
  supplementPartial: boolean; estimated: boolean; source: string; missing: number | null;
  supplementMissing: number | null; complete: boolean; completeValue: number | null;
};
export type FoodPlanNutritionSummary = {
  basis: 'draft_preview' | 'confirmed_daily_plan' | 'reported_only'; date: string; totals: EditNutritionTotal[];
  partial: boolean; supplementPartial: boolean; supplementOnly: boolean; hasDraft: boolean;
};
export type FoodPlanEditMeal = {
  id: string; slot: MealSlot; title: string; state: string; hasActualFacts: boolean; canPatch: boolean;
  canRemove: boolean; actualFactsImmutable: true; protectionReasons: string[];
  actualEntries: { id: string; itemId: string | null; name: string; quantity: number | null; unit: string;
    nutrition: EditNutrition; gramsPerUnit: number | null; sourceTextAvailable: boolean; nutritionCorrectionCount: number }[];
  actualEntryIds: string[]; actualEntryCount: number; reportCount: number; actualTime: string | null;
  actualTimeTextPresent: boolean; completionReportedAt: string | null; plannedTime: string | null; plannedTimeTextPresent: boolean;
  plannedItems: { id: string; itemId: string | null; name: string; quantity: number; unit: string; nutrition: EditNutrition;
    gramsPerUnit: number | null; plannedNutritionOverride: boolean; sourceTextAvailable: boolean }[];
  nutritionTotals: EditNutritionTotal[];
};
export type FoodPlanEditContext = FoodPreferencesContext & {
  revision: number; dailyMenuSettlementPolicy?: DailyMenuSettlementPolicy;
  contextCharBudget: number; preferencesJsonCharacters: number; preferencesContextJsonCharacters: number; charBudget: number;
  plan: { id: string; date: string; title: string; status: string; hasDraft: boolean; editBase: 'draft' | 'active';
    accountingWarnings?: AccountingWarning[]; accountingWarningCount?: number; accountingWarningsTruncated?: boolean; supplementOnly: boolean; supplementAccounting: string | null; inventoryAccounting: string; canPatch: boolean;
    dailySettlement?: DailyMenuSettlementSummary;
    protectionReasons: string[]; canApply: boolean; applyProtectionReasons: string[];
    accountingIssueCount: number; accountingIssues: { code: string; itemId: string | null }[];
    accountingIssuesTruncated: boolean };
  meals: FoodPlanEditMeal[]; requestedMealIds: string[]; omittedMealIds: string[];
  otherMeals: { preserve: true; count: number; included: number; truncated: boolean;
    meals: { id: string; slot: MealSlot; title: string; hasActualFacts: boolean; nutritionTotals: EditNutritionTotal[] }[] };
  supplements: { preserve: true; count: number; actualDoseCount: number; reportedDoseCount: number };
  dailyNutritionSummary: FoodPlanNutritionSummary;
  inventoryCandidates: { total: number; included: number; truncated: boolean; missingItemIds: string[]; missingItemCount: number;
    selectionInstructions: string;
    excludedSupplementItemIds: string[]; excludedSupplementItemCount: number;
    items: ({ id: string; name: string; aliases?: string[]; brand: string; category: string; origin: 'target' | 'explicit' | 'query';
      quantity: number | null; unit: string; status: string; priority: boolean; canUse: boolean; gramsPerUnit: number | null;
      nutrition: EditNutrition; confirmedAt: string | null; updatedAt: string | null;
      location: string; freshness?: FoodFreshness;
      accountingContext?: ItemAccountingContext; bookQuantity?: number | null;
      accountedByThisPlan: { quantity: number; unit: string; unknownBalance: boolean; shortfallQuantity?: number; baselineMatches: boolean } | null } & PlanningPriorityMetadata)[] };
  quantityMeaning: 'remaining_after_actual_and_legacy_credits'; instructions: string; truncated: boolean; completeForPatch: boolean;
};

export function readFoodPlanEditContext(state: unknown, filters: FoodPlanEditFilters): FoodPlanEditContext;
/** Independent of meal filters: safe to call after a meal has been removed. */
export function foodPlanNutritionSummary(state: unknown, planId: string, view?: 'draft' | 'active'): FoodPlanNutritionSummary;

export type MealExecutionView = {
  mode: "actual" | "partial" | "planned"; actualEntries: ActualEntry[]; plannedItems: PlannedFood[];
  remainingItems: (Omit<PlannedFood, "quantity"> & { quantity: number | null; remainingNote: string })[];
};
export function mealExecutionView(meal: Meal): MealExecutionView;
