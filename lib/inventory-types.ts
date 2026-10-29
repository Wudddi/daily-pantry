import type { InventoryReconciliationHistoryEntry } from './food-balance-reconciliation.mjs';
import type { DailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
export type Category = 'prepared' | 'vegetable' | 'fruit' | 'nuts' | 'bread' | 'dessert' | 'condiment' | 'protein' | 'staple' | 'supplement' | 'other';
export type Unit = 'g' | 'ml' | '袋' | '个' | '片' | '份' | '包' | '罐' | '条' | '粒' | '滴';
export type NutritionSource = 'label' | 'recipe' | 'estimate' | 'unknown';
export type FoodNutrition = {
  basisAmount: number; basisUnit: Unit;
  kcal: number | null; protein: number | null; carbs: number | null; fat: number | null;
  source: NutritionSource; sourceNote: string; sourceText: string;
  nutrientSources?: Partial<Record<'kcal' | 'protein' | 'carbs' | 'fat', NutritionSource>>;
};
export type FoodFreshness = {
  opened: boolean | null; openedOn: string | null; bestBeforeDate: string | null;
  userConsumeByDate: string | null; sourceText: string;
};
export type FoodItem = {
  id: string; name: string; category: Category; brand: string; aliases?: string[];
  quantity: number | null; unit: Unit; status: 'available' | 'depleted' | 'archived' | 'pending';
  priority: boolean; location: '冷冻' | '冷藏' | '常温' | '';
  nutrition: FoodNutrition; gramsPerUnit: number | null;
  notes: string; ingredients: string; supplementFacts: string;
  confirmedAt: string; updatedAt: string; quantityBaselineToken?: string;
  freshness?: FoodFreshness;
};
export type InventoryEvent = { id: string; at: string; kind?: string; action?: string; itemName?: string; itemId?: string; detail: string; freshnessBefore?: FoodFreshness | null; freshnessAfter?: FoodFreshness | null };
export type PreferenceHistoryEntry = {
  operationId: string; at: string; action: 'preferences' | 'restore'; sourceDate: string | null; reason: string; sourceText?: string;
  revisionBefore: number; revisionAfter: number; previous: string[]; next: string[];
  fingerprint: string; fingerprintLength: number;
};
export type PreferenceOperationReceipt = Omit<PreferenceHistoryEntry, 'action' | 'previous' | 'next' | 'sourceText' | 'sourceDate'> & {
  action: 'patch_preferences'; noChange: true; sourceText: string; sourceDate: string;
};
export type PlanLine = { itemId: string; name: string; quantity: number; unit: Unit; unknownQuantity: boolean; baselineToken?: string };
export type Plan = { id: string; title: string; date: string; notes: string; status: 'reserved' | 'cancelled'; createdAt: string; updatedAt: string; items: PlanLine[] };
export type InventoryState = { inventoryReconciliationHistory?: InventoryReconciliationHistoryEntry[]; dailyMenuSettlementPolicy?: DailyMenuSettlementPolicy; schemaVersion: 1; revision: number; updatedAt: string; items: FoodItem[]; events: InventoryEvent[]; eventHistory?: InventoryEvent[]; preferences: string[]; preferenceHistory?: PreferenceHistoryEntry[]; preferenceOperationReceipts?: PreferenceOperationReceipt[]; plans?: (Plan | DietPlan)[]; dietHistory?: DietHistoryRecord[] };
import type { DietPlan } from './diet-types';


import type { DietHistoryRecord } from './diet-history-types';
