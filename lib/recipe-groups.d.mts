export type RecipeGroup = { id: string; name: string; lineIds: string[]; portion?: number; baseQuantities?: { lineId: string; quantity: number }[] };
export function normalizeRecipeGroups(value: unknown, plannedItems: readonly { id: string; quantity?: number }[], options?: { pruneMissing?: boolean; previousGroups?: readonly RecipeGroup[]; acceptStoredBasis?: boolean }): RecipeGroup[];
export function pruneRecipeGroups(value: unknown, plannedItems: readonly { id: string }[]): RecipeGroup[];
