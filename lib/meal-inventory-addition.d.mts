import type { DietPlan } from './diet-types';
import type { FoodItem } from './inventory-types';
export function inventoryMealChoices(items: readonly FoodItem[], query?: string): FoodItem[];
export function mealAdditionUnits(item: FoodItem): string[];
export function mealAdditionQuantity(item: FoodItem, quantity: number, unit?: string): number;
export function buildMealInventoryAddition(plan: DietPlan, items: readonly FoodItem[], input: { mealId: string; itemId: string; quantity: number; unit?: string }, options: { operationId: string; expectedRevision: number }): { planId: string; mealId: string; itemId: string; quantity: number; expectedDraftVersion: string | null; operationId: string; expectedRevision: number };
