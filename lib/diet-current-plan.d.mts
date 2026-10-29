import type { DietPlan } from './diet-types';
import type { FoodItem } from './inventory-types';

/** Pure current-menu projection; preserves canonical identity, actual facts and accounting. */
export function projectCurrentDietPlan(plan: DietPlan, inventoryItems?: readonly FoodItem[]): DietPlan;
