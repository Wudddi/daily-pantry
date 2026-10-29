import type { DailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
import type { FoodNutrition, FoodItem, NutritionSource, Unit } from './inventory-types';
import type { PlanningPriorityMetadata } from './inventory-planning-priority.mjs';
import type { FoodPreferencesContext } from './food-preferences-context.mjs';
import type { MealPatternContext } from './meal-pattern-context.mjs';
import type { ItemAccountingContext } from './inventory-accounting-context.mjs';
import type { DailyMenuSettlementSummary } from './daily-menu-settlement-context.mjs';

export type PlanningInventoryFilters = {
  cursor?: string | number;
  limit?: number;
  itemId?: string;
  offset?: number;
  /** Required on cursor>0; must equal the complete first-page context revision. */
  expectedRevision?: number;
};
export type NutrientKey = 'kcal' | 'protein' | 'carbs' | 'fat';
export type PlanningItem = Pick<FoodItem, 'id' | 'name' | 'category' | 'quantity' | 'unit' | 'status' | 'priority' | 'gramsPerUnit' | 'confirmedAt' | 'updatedAt'> & Partial<Pick<FoodItem, 'brand' | 'location' | 'notes' | 'ingredients' | 'supplementFacts' | 'freshness'>> & PlanningPriorityMetadata & {
  nutrition: Omit<FoodNutrition, 'sourceText' | 'nutrientSources' | 'sourceNote'> & { nutrientSources: Record<NutrientKey, NutritionSource>; sourceNote?: string };
  aliases?: string[];
  accountingContext?: ItemAccountingContext; bookQuantity?: number | null;
  textTruncated: boolean;
};
export type PlanningPlanIndex = {
  id: string; date: string; title: string; status: string;
  accounting: string; hasDraft: boolean; supplementOnly: boolean;
  supplementAccounting?: 'actual_only' | 'full_plan'; legacyReservation?: true; textTruncated?: boolean;
  dailySettlement?: DailyMenuSettlementSummary;
  detail: { tool: 'read_diet_records'; recordId: string; offset: 0 };
};
export type PlanningRoutineReference = {
  sourcePlanId: string | null; date: string | null; updatedAt: string;
  routineSource: 'saved' | 'derived'; instructions: string;
  total: number; included: number; omitted: number; truncated: boolean; textTruncated: boolean;
  doses: {
    id: string; itemId: string; name: string; plannedQuantity: number | null; unit: Unit;
    timingSlot: string; requirement: string; scheduled: boolean; trainingDayOnly: boolean;
    plannedMealId: string | null; plannedTime: string | null; plannedTimeText: string;
    instruction: string; sourceText: string;
  }[];
};
export type PlanningInventoryPageBase = {
  schemaVersion: 1; responseFormat: 'compact_inventory_v2'; format: 'food_inventory_brief_v1';
  revision: number; generatedAt: string; updatedAt: string; lastConfirmedAt: string | null;
  quantityMeaning: 'remaining_after_actual_and_legacy_credits'; quantityExplanation: string;
  items: PlanningItem[];
  indexes: Record<FoodItem['status'], string[]>; indexScope: 'page';
  total: number; offset: number; limit: number; included: number; hasMore: boolean;
  nextCursor: string | null; charBudget: number;
  contextRevision: number;
  coverage: {
    from: number; toExclusive: number; allItemsIncluded: boolean;
    statusTotals: Record<FoodItem['status'], number>; revisionPinned: boolean;
  };
  nutritionReadiness: { availableCount: number; foodCount: number; supplementCount: number; completeCount: number; partialCount: number; missingCount: number; unknownQuantityCount: number; unconvertibleCount: number };
  instructions: string;
};
export type PlanningInventoryFirstPage = PlanningInventoryPageBase & FoodPreferencesContext & {
  contextIncluded: true; requiresFirstPage: false;
  plans: PlanningPlanIndex[];
  candidateCoverage: ReturnType<typeof import('./inventory-planning-priority.mjs').inventoryPlanningPriorities>['coverage'];
  recentMenuCoverage: ReturnType<typeof import('./inventory-planning-priority.mjs').inventoryPlanningPriorities>['recentMenuCoverage'];
  dailyMenuSettlementPolicy?: DailyMenuSettlementPolicy;
  inventoryAccountingSummary?: { pendingPlanCount: number; pendingItemCount: number; instructions: string };
  selectionRules: string[];
  mealPatternReferences: MealPatternContext;
  planSummary: { total: number; reserved: number; included: number; omitted: number; truncated: boolean; detailTool: 'read_diet_records'; instructions: string };
  contextCharBudget: 96000; preferencesJsonCharacters: number; preferencesContextJsonCharacters: number;
  rules: string[]; supplementScheduleReference: PlanningRoutineReference | null;
  /** First-page habits, rules and routine are complete or the read fails explicitly with status413. */
  contextTruncated: false;
  contextSummary: { preferencesTotal: number; preferencesIncluded: number; preferencesOmitted: number; preferencesTextTruncated: boolean };
};
export type PlanningInventoryContinuation = PlanningInventoryPageBase & {
  /** Omitted context refers to the complete cursor0 response with contextRevision; it is never an empty habit list. */
  contextIncluded: false; requiresFirstPage: true;
  preferences?: never; preferencesComplete?: never; preferencesCount?: never; preferencesRevision?: never;
  preferencesLastChangedAt?: never; preferencesLastChangedRevision?: never; preferenceWorkflow?: never;
  contextCharBudget?: never; preferencesJsonCharacters?: never; preferencesContextJsonCharacters?: never;
  rules?: never; supplementScheduleReference?: never;
  plans?: never; planSummary?: never; contextSummary?: never; contextTruncated?: never;
  candidateCoverage?: never; recentMenuCoverage?: never; selectionRules?: never;
  mealPatternReferences?: never;
  inventoryAccountingSummary?: never; dailyMenuSettlementPolicy?: never;
};
export type PlanningInventoryPage = PlanningInventoryFirstPage | PlanningInventoryContinuation;
export type PlanningInventoryDetail = {
  schemaVersion: 1; responseFormat: 'compact_inventory_v2'; format: 'inventory_item_json';
  revision: number; generatedAt: string; itemId: string; encoding: 'json_text';
  offset: number; totalCharacters: number; text: string; nextOffset: number | null;
  complete: boolean; truncated: boolean; charBudget: 12000; instructions: string;
};

/** Includes encoded metadata in its hard budget; no state is modified by reads. */
export function readPlanningInventory(state: unknown, filters: PlanningInventoryFilters & { itemId: string }, now?: string): PlanningInventoryDetail;
export function readPlanningInventory(state: unknown, filters?: PlanningInventoryFilters & { itemId?: undefined }, now?: string): PlanningInventoryPage;
export function readPlanningInventory(state: unknown, filters?: PlanningInventoryFilters, now?: string): PlanningInventoryPage | PlanningInventoryDetail;
