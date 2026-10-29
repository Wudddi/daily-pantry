import type { FoodItem } from './inventory-types';
export type PlanningPriorityMetadata = {
  planningHints?: ('user_priority' | 'named_tail_bag' | 'last_prepared_bag' | 'refrigerated_vegetable')[];
  freshnessHint?: { group: 'use_soon' | 'fresh_first' | 'frozen_flexible' | 'shelf_stable' | 'storage_unknown'; basis: string[] };
  recentAcceptedMenuDays?: number;
  lastAcceptedMenuDate?: string;
};
export const PLANNING_PRIORITY_RULES: string[];
export function inventoryPlanningRole(item: Pick<FoodItem, 'category'>): 'food' | 'condiment' | 'supplement';
export function inventoryItemAvailable(item: Pick<FoodItem, 'status' | 'quantity'>): boolean;
export function inventoryPlanningPriorities(state: unknown, targetDate: string): {
  compare: (a: FoodItem, b: FoodItem) => number;
  metadata: (item: FoodItem) => PlanningPriorityMetadata;
  coverage: {
    source: 'all_paged_inventory_items'; availableRoleTotals: Record<'food' | 'condiment' | 'supplement', number>;
    availableFoodCategoryTotals: Record<string, number>; freshnessGroupTotals: Record<string, number>; instructions: string;
  };
  recentMenuCoverage: {
    from: string; toExclusive: string; windowDays: 14; observedConfirmedMenuDates: string[];
    observedDayCount: number; source: 'confirmed_meals_v1_planned_food_ids'; actualIntakeProven: false; completeEatingHistory: false;
  };
};
