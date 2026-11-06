export type RecipeViewRow = { id?: string; lineId?: string; origin?: string; itemId?: string | null; name?: string; intakeLineId?: string; quantity?:number|null; unit?:string };
export type MealRecipeSection<T> = { kind: 'recipe' | 'food'; id: string; name: string; lineIds: string[]; rows: T[] };
export function groupMealRecipeRows<T extends RecipeViewRow>(meal: unknown, rows: readonly T[], options?: { planId?: string }): MealRecipeSection<T>[];
