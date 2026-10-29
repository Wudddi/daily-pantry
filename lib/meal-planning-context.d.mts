export function mealPlanningHealthContext(state: unknown): {
  available: true; revision: number; format: string; summary: Record<string, unknown>;
  recentCompletedSessions: Record<string, unknown>[]; omittedSessionCount: number;
  truncated: boolean; charBudget: number; detailsTool: string; instructions: string;
};
export function mealPlanningDietContext(state: unknown, date: string): {
  date: string; revision: number; format: string; summaryOnly: true;
  total: number; nativePlanCount: number; historyCount: number;
  records: Record<string, unknown>[]; dailyNutritionSummaries: Record<string, unknown>[];
  truncated: boolean; charBudget: number; instructions: string;
};
