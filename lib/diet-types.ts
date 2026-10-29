import type { FoodItem, FoodNutrition, Unit } from './inventory-types';
import type { IntakeDraftInput } from './intake-draft.mjs';
import type { PersonalFoodChecks } from './personal-food-checklist.mjs';
import type { DailyMenuSettlement } from './daily-menu-settlement.mjs';

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
export type PlannedFoodInput = { id: string; itemId: string | null; name?: string; quantity: number; unit?: Unit; sourceText?: string; nutrition?: FoodNutrition };
export type MealInput = { id: string; slot: MealSlot; title: string; plannedTime?: string | null; plannedTimeText?: string; plannedItems: PlannedFoodInput[] };
export type SupplementTimingSlot = 'breakfast' | 'lunch' | 'pre_workout' | 'post_workout' | 'dinner' | 'bedtime' | 'other';
export type SupplementRequirement = 'daily' | 'optional' | 'as_needed' | 'label_pending';
export type DoseInput = { id: string; itemId: string; plannedQuantity: number | null; unit?: Unit; plannedMealId?: string | null; plannedTime?: string | null; plannedTimeText?: string; sourceText?: string; timingSlot?: SupplementTimingSlot; requirement?: SupplementRequirement; scheduled?: boolean; instruction?: string; trainingDayOnly?: boolean };
export type DietPlanInput = { id: string; date: string; title: string; timeZone?: string; notes?: string; meals: MealInput[]; supplementDoses?: DoseInput[] };
export type PlannedFoodPatch = { id: string; remove?: boolean } & Partial<Omit<PlannedFoodInput, 'id'>>;
export type MealPatch = { id: string; remove?: boolean; itemPatches?: PlannedFoodPatch[] } & Partial<Omit<MealInput, 'id' | 'plannedItems'>>;
export type SupplementPatch = { id: string; remove?: boolean } & Partial<Omit<DoseInput, 'id'>>;
export type MealPlanPatch = { planId: string; mode: 'draft' | 'apply'; confirmed?: boolean; allocationOnly?: boolean; title?: string; notes?: string; mealPatches?: MealPatch[]; supplementPatches?: SupplementPatch[] };
export type NutritionSnapshot = Pick<FoodItem, 'name' | 'unit' | 'nutrition' | 'gramsPerUnit' | 'ingredients' | 'supplementFacts'> | null;
/** Internal frozen snapshots are written by the server, never accepted by patch inputs. */
export type DietPlanDraft = Omit<DietPlanInput, 'meals' | 'supplementDoses'> & { patchDraft?: true; meals: (Omit<MealInput, 'plannedItems'> & { plannedItems: (PlannedFoodInput & { nutritionSnapshot?: NutritionSnapshot })[] })[]; supplementDoses?: (DoseInput & { nutritionSnapshot?: NutritionSnapshot })[] };
export type ActualEntryInput = { id: string; itemId: string | null; name?: string; quantity: number | null; unit?: string; sourceText: string };
export type ActualNutritionCorrection = { entryId: string; nutrition?: FoodNutrition; gramsPerUnit?: number | null; fromPlannedLineId?: string; sourceText: string };
export type ActualNutritionCorrectionHistory = { at: string; sourceText: string; previous: NutritionSnapshot };
export type ActualEntry = ActualEntryInput & { intakeLineId?: string; nutritionCorrectionHistory?: ActualNutritionCorrectionHistory[]; name: string; unit: string; reportedAt: string; quantitySource: 'reported' | 'confirmed_plan_portion' | 'unknown'; nutritionSnapshot: NutritionSnapshot; correctionHistory: Omit<ActualEntry, 'correctionHistory'>[] };
export type PlannedFood = Omit<PlannedFoodInput, 'unit' | 'sourceText'> & { unit: Unit; sourceText: string; nutritionSnapshot: NutritionSnapshot };
export type AccountingLine = { itemId: string; name: string; quantity: number; unit: string; unknownBalance: boolean; baselineToken: string; shortfallQuantity?: number };
export type AccountingWarning = { code: 'STOCK_SHORTFALL_RECORDED'; itemId: string; quantity: number; unit: string; message: string };
export type AccountingAdjustment = { at: string; itemId: string; unit: string; code: 'STOCK_SHORTFALL_RECORDED' | 'STOCK_SHORTFALL_REDUCED'; basis: 'reported_actual' | 'automatic_menu'; targetBefore: number; targetAfter: number; stockBefore: number | null; stockAfter: number | null; shortfallBefore: number; shortfallAfter: number; inventoryDelta: number };
export type IntakeReportHistory = { reportedAt: string; mode: IntakeMode; sourceText: string; actualTime: string | null; actualTimeText: string; entryIds: string[]; matchesConfirmedPlan: boolean };
export type MealPlanRevision = { at: string; previous: { slot: MealSlot; title: string; plannedTime: string | null; plannedTimeText: string; plannedItems: PlannedFood[] } };
export type Meal = Omit<MealInput, 'plannedItems'> & { plannedTime: string | null; plannedTimeText: string; plannedItems: PlannedFood[]; planRevisionHistory?: MealPlanRevision[]; actualEntries: ActualEntry[]; actualTime: string | null; actualTimeText: string; completionReportedAt: string | null; sourceText: string; reportHistory: IntakeReportHistory[]; state: 'reserved' | 'in_progress' | 'completed' | 'cancelled' };
export type SupplementDose = Required<DoseInput> & { nutritionSnapshot: NutritionSnapshot; actualEntries: ActualEntry[]; actualTime: string | null; actualTimeText: string; actualMealId: string | null; reportSourceText: string; reportHistory: IntakeReportHistory[]; completionReportedAt: string | null; state: 'reserved' | 'in_progress' | 'completed' | 'cancelled' };
export type LegacyReservations = { meals: { id: string; plannedItems: { itemId: string | null; quantity: number; unit: string }[] }[]; supplementDoses: { id: string; itemId: string; plannedQuantity: number | null; unit: string; scheduled: boolean }[]; allocationAdjustments: Record<string, number> };
export type DietPlan = { accountingWarnings?: AccountingWarning[]; accountingAdjustmentHistory?: AccountingAdjustment[]; personalFoodChecks?: PersonalFoodChecks; dailySettlement?: DailyMenuSettlement; id: string; format: 'meals_v1'; date: string; title: string; timeZone: string; notes: string; status: 'draft' | 'reserved' | 'cancelled' | 'closed_with_actuals'; meals: Meal[]; supplementDoses: SupplementDose[]; items: AccountingLine[]; accountedDebits: AccountingLine[]; allocationAdjustments: Record<string, number>; inventoryAccounting: 'settled' | 'pending_reconciliation'; accountingIssues: { code: string; itemId?: string; message: string }[]; draft?: DietPlanDraft; supplementOnly?: boolean; foodAccounting?: 'actual_only'; legacyReservations?: LegacyReservations; supplementAccounting?: 'actual_only' | 'full_plan'; intakeDraft?: IntakeDraftInput; intakeDraftAudit?: { id: string; at: string; draft: IntakeDraftInput }[]; intakeBasis: 'confirmed_daily_plan' | 'reported_only' | 'none'; createdAt: string; updatedAt: string };
export type SupplementRoutine = { sourcePlanId: string | null; updatedAt: string; supplementDoses: DoseInput[] };
export type DailySupplementView = { plan: DietPlan | null; virtual: boolean; sourcePlanId: string | null; issues: { code: string; message: string; doseId?: string }[] };
export type IntakeMode = 'append' | 'correct' | 'complete';
export type DoseReport = { doseId: string; mode?: IntakeMode; entries?: ActualEntryInput[]; matchesPlannedDose?: boolean; actualTime?: string | null; actualTimeText?: string; actualMealId?: string | null; sourceText?: string };
export type MealReport = { mealId: string; mode?: IntakeMode; entries?: ActualEntryInput[]; matchesPlannedFood?: boolean; actualTime?: string | null; actualTimeText?: string; sourceText?: string };
/** Personal reminders never represent actual intake or inventory consumption. */
export type PersonalFoodCheckInput = { planId: string; mealId: string; checked: boolean } &
  ({ lineIds: string[]; wholeMeal?: never } | { wholeMeal: true; lineIds?: never });
export type DietAction =
  | ({ action: 'set_food_personal_check' } & PersonalFoodCheckInput)
  | { action: 'settle_daily_menu'; planId: string; effectiveDate: string; policyStartDate: string; confirmed: true }
  | { action: 'apply_checklist_intake'; planId: string; draft: IntakeDraftInput; expectedDraftVersion: null }
  | { action: 'save_intake_draft'; planId: string; draft: IntakeDraftInput; expectedDraftVersion: string | null }
  | { action: 'submit_intake_draft'; planId: string; draftId: string; baseFingerprint: string; expectedDraftVersion: string }
  | { action: 'discard_intake_draft'; planId: string; draftId?: string; expectedDraftVersion: string | null }
  | { action: 'save_meal_plan_draft'; plan: DietPlanInput }
  | { action: 'commit_meal_plan'; planId: string; confirmed: true }
  | { action: 'revise_unconsumed_meals'; planId: string; confirmed: true; meals?: MealInput[]; supplementDoses?: DoseInput[]; allocationOnly?: boolean }
  | ({ action: 'patch_meal_plan' } & MealPlanPatch)
  | { action: 'record_meal_intake'; planId: string; mealId: string; nutritionCorrections?: ActualNutritionCorrection[]; mode?: IntakeMode; entries?: ActualEntryInput[]; matchesPlannedFood?: boolean; actualTime?: string | null; actualTimeText?: string; sourceText?: string; supplements?: DoseReport[] }
  | { action: 'record_meal_intake'; planId: string; meals: MealReport[]; supplements?: DoseReport[] }
  | ({ action: 'record_supplement_intake'; planId: string } & DoseReport)
  | { action: 'set_supplement_check'; planId: string; doseId: string; checked: boolean }
  | { action: 'set_daily_supplement_check'; date: string; doseId: string; checked: boolean }
  | { action: 'save_supplement_routine'; sourcePlanId: string; confirmed: true }
  | { action: 'cancel_meal_plan' | 'cancel_remaining_meals'; planId: string; confirmed: true };
export type DietReadFilters = { date?: string; from?: string; to?: string; planId?: string; cursor?: string; limit?: number; recordId?: string; offset?: number; summaryOnly?: 'daily_food'; expectedRevision?: number };
