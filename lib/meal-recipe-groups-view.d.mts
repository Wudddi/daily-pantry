export type RecipeViewRow = { id?: string; lineId?: string; origin?: string; itemId?: string | null; name?: string; intakeLineId?: string; actualEntryIds?: readonly string[]; quantity?:number|null; unit?:string };
export type MealRecipeSection<T> = { kind: 'recipe' | 'food'; source:'actual'|'planned'; id: string; groupId?:string; name: string; lineIds: string[]; actualEntryIds:string[]; portion?:number; rows: T[] };
export function groupMealRecipeRows<T extends RecipeViewRow>(meal: unknown, rows: readonly T[], options?: { planId?: string }): MealRecipeSection<T>[];
export function recipeIngredientDisplayName(section: Pick<MealRecipeSection<unknown>,'kind'|'source'|'name'>|undefined, row: {name?:string}): string;
