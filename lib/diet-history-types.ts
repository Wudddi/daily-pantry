export type HistoryNutrition = {
  kcal: number | null; protein: number | null; carbs: number | null; fat: number | null;
  fiber: number | null; sugar: number | null; sodiumMg: number | null;
  source: 'label' | 'recipe' | 'estimate' | 'unknown'; sourceText: string;
};
export type HistoryStatus = 'planned' | 'reported_completed' | 'partial_report' | 'unknown';
export type HistoryEntry = { id: string; name: string; quantity: number | null; plannedQuantity?: number | null; actualQuantity?: number | null; quantitySource?: 'reported' | 'confirmed_plan_portion' | 'unknown'; unit: string; inventoryItemId?: string; nutrition?: Partial<HistoryNutrition>; sourceText?: string };
export type HistoryTimes = { plannedTime?: string | null; plannedTimeText?: string; actualTime?: string | null; actualTimeText?: string };
export type HistoryMeal = HistoryTimes & { id: string; name: string; status: HistoryStatus; items: HistoryEntry[]; nutrition?: Partial<HistoryNutrition>; sourceText?: string };
export type HistorySupplement = HistoryEntry & HistoryTimes & { status: HistoryStatus };
export type HistorySourceRef = { conversationId: string; messageKey: string; date?: string; kind: 'user' | 'assistant' | 'document'; text?: string };
export type DietHistoryInput = {
  id: string; date: string; title: string; timeZone?: string;
  confirmation: 'final_plan' | 'reported_completed' | 'partial_report';
  meals: HistoryMeal[]; supplements?: HistorySupplement[];
  planSourceText?: string; executionSourceText?: string; notes?: string; sourceRefs?: HistorySourceRef[]; nutrition?: Partial<HistoryNutrition>;
};
export type DietHistoryRecord = DietHistoryInput & {
  nutritionSignatures?: Partial<Record<'kcal' | 'protein' | 'carbs' | 'fat', string>>;
  recordType: 'diet_history'; inventoryEffect: 'none'; createdAt: string; updatedAt: string;
  versions: Array<{ at: string; operationId: string; previous: Omit<DietHistoryRecord, 'versions'> }>;
};
