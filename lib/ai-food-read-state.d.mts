export type PersonalCheckContext = {
  available: boolean; basis: 'personal_reminder'; actualIntakeEvidence: false; savedAt: string | null;
  rows: { sourceMealId: string; lineId: string; checked: boolean; displayMealId: string; updatedAt: string | null }[];
  totalRows: number; includedRows: number; truncated: boolean; invalidReferenceCount: number; staleReferenceCount: number; instructions: string;
};
export function personalFoodCheckContext(plan: unknown, options?: { mealIds?: readonly string[]; maxRows?: number }): PersonalCheckContext;
export function aiFoodReadState<T extends { plans?: readonly unknown[] }>(state: T): T;
