export type ExecutedPatternNutrition = {
  basisAmount: number | null; basisUnit: string | null; kcal: number | null; protein: number | null;
  carbs: number | null; fat: number | null; source: string;
  nutrientSources: Record<'kcal' | 'protein' | 'carbs' | 'fat', string>;
};
export type ExecutedPatternEntry = {
  id: string; itemId: string | null; name: string; quantity: number | null; unit: string; quantityKnown: boolean;
  gramsPerUnit: number | null; nutrition: ExecutedPatternNutrition; nutritionComplete: boolean;
  currentInventory: {
    matched: boolean; status: string | null; location: string | null;
    quantity: number | null; unit: string | null; available: boolean; unitMatchesActual: boolean | null;
  };
};
export type ExecutedMealReference = {
  date: string; planId: string; mealId: string; slot: string; state: 'completed' | 'automatic_menu_settled';
  referenceEvidence: 'reported_actual' | 'automatic_menu_assumption'; actualIntakeProven: boolean;
  actualEntries: ExecutedPatternEntry[]; plannedEntries?: ExecutedPatternEntry[]; quantitiesComplete: boolean; nutritionComplete: boolean;
  excludedInvalidActualEntryCount: number;
};
export type ExecutedDayReference = {
  date: string; planId: string; primaryMealsComplete: true; meals: ExecutedMealReference[];
  referenceEvidence: 'reported_actual' | 'automatic_menu_assumption'; actualIntakeProven: boolean;
  quantitiesComplete: boolean; nutritionComplete: boolean;
};
export type MealPatternContext = {
  available: true; revision: number; format: 'executed_meal_patterns_v1'; referenceDate: string;
  from: string; to: string; windowDays: 14; charBudget: 24000;
  referenceMode: 'completed_primary_days' | 'completed_meals_only' | 'mixed_primary_days' | 'automatic_menu_assumptions' | 'automatic_meals_only'; hasCompleteDayReference: boolean;
  completeDayReferences: ExecutedDayReference[]; recentCompletedMealReferences: ExecutedMealReference[];
  omittedCompleteDayReferences: { date: string; planId: string; referenceEvidence: 'reported_actual' | 'automatic_menu_assumption'; actualIntakeProven: boolean;
    detail: { tool: 'read_diet_records'; date: string; planId: string } }[];
  coverage: {
    eligibleCompleteDayCount: number; includedCompleteDayCount: number; omittedCompleteDayCount: number;
    eligibleReportedCompleteDayCount: number; eligibleAutomaticCompleteDayCount: number;
    eligibleCompletedMealCount: number; includedFallbackMealCount: number; omittedFallbackMealCount: number;
    completeDayLimit: 3; fallbackMealLimit: 6;
    excludedPlanCounts: Record<'nonNative' | 'supplementOnly' | 'invalidDate' | 'future' | 'outsideWindow' | 'ambiguousDate' | 'ambiguousMealSlots', number>;
  };
  truncated: boolean;
  noCompleteDayReason: 'NO_COMPLETED_PRIMARY_DAY_IN_WINDOW' | 'COMPLETED_PRIMARY_DAYS_EXCEED_CONTEXT_BUDGET' | null;
  detailsTool: 'read_diet_records'; instructions: string;
};
/** Read-only; referenceDate is the planning context's explicit local YYYY-MM-DD date. */
export function mealPatternContext(state: unknown, referenceDate: string): MealPatternContext;
