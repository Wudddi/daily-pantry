import type { DietPlan } from './diet-types';
import type { FoodItem } from './inventory-types';
import type { RecipeGroup } from './recipe-groups.mjs';
export type RecipeGroupAction = { expectedFingerprint?: string; operationId?: string } & (
  { action: 'scale_recipe_group'; planId: string; mealId: string; groupId: string; targetPortion: number }
  | { action: 'move_recipe_group'; planId: string; fromMealId: string; groupId: string; toMealId: string; fractionOfRemaining: number; transferId?: string });
export type RecipeGroupEditView = { fingerprint: string; portion: number; legacyBasis: boolean; canScale: boolean; canMove: boolean;
  issues: { code: string; message: string }[]; rows: { lineId: string; name: string; quantity: number; unit: string; eatenQuantity: number | null; remainingQuantity: number | null }[]; hasIntakeDraft: boolean };
export function recipeGroupEditView(plan: DietPlan, items: readonly FoodItem[], mealId: string, groupId: string): RecipeGroupEditView;
export function previewRecipeGroupAction(plan: DietPlan, items: readonly FoodItem[], action: RecipeGroupAction): {
  plan: DietPlan; noChange: boolean; changes: { mealId: string; lineId: string; name: string; unit: string; before: number; after: number }[];
  sourceGroup?: RecipeGroup; destinationGroup?: RecipeGroup };
