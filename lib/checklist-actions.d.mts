import type { DietPlan } from './diet-types';
import type { FoodItem } from './inventory-types';
import type { IntakeDraftInput, IntakeDraftMeal, IntakeDraftRow, IntakeDraftView } from './intake-draft.mjs';
export type ChecklistAction =
  | { type: 'complete_item'; mealId: string; lineIds: string[] }
  | { type: 'complete_meal'; mealId: string }
  | { type: 'undo_meal'; mealId: string; correctExistingActuals?: boolean }
  | { type: 'set_eaten'; mealId: string; lineIds: string[]; quantity: number; moveRemainingToMealId?: string | null; correctExistingActuals?: boolean }
  | { type: 'undo_item'; mealId: string; lineIds: string[]; correctExistingActuals?: boolean }
  | { type: 'move_remaining'; fromMealId: string; lineIds: string[]; toMealId: string; quantity?: number };
export type ChecklistGroup = Omit<IntakeDraftRow, 'lineId'> & { id: string; rows: IntakeDraftRow[]; lineIds: string[] };
export function groupChecklistRows(meal: IntakeDraftMeal): ChecklistGroup[];
export function canReceiveChecklistFood(meal: IntakeDraftMeal | undefined): boolean;
export function nextChecklistMealId(view: IntakeDraftView, mealId: string): string | null;
export function buildChecklistAction(plan: DietPlan, items: readonly FoodItem[], action: ChecklistAction, options: { draftId: string }): {
  draft: IntakeDraftInput; expectedDraftVersion: null; preview: IntakeDraftView; noChange: boolean;
};
