import type { FoodItem } from './inventory-types';
export type ItemAccountingContext = { balanceReliable: false; planIds: string[]; codes: string[] };
export type InventoryAccountingContext = { byItemId: Record<string, ItemAccountingContext>; pendingPlanIds: string[]; pendingItemCount: number };
export function inventoryAccountingContext(state: unknown): InventoryAccountingContext;
export function inventoryAccountingFields(item: Pick<FoodItem, 'id' | 'quantity' | 'status'>, context: InventoryAccountingContext): {
  accountingContext?: ItemAccountingContext; bookQuantity?: number | null; quantity?: null;
};
