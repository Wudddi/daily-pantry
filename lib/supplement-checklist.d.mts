import type { DietPlan, DoseInput, SupplementDose } from './diet-types';
import type { FoodItem } from './inventory-types';

export type SupplementTimingSlot = 'breakfast' | 'lunch' | 'pre_workout' | 'post_workout' | 'dinner' | 'bedtime' | 'other';
export type SupplementRequirement = 'daily' | 'optional' | 'as_needed' | 'label_pending';
export type ChecklistDose = Omit<SupplementDose, 'plannedQuantity'> & {
  plannedQuantity: number | null;
  timingSlot?: SupplementTimingSlot;
  requirement?: SupplementRequirement;
  scheduled?: boolean;
  instruction?: string;
  trainingDayOnly?: boolean;
};
export type ChecklistPlan = Omit<DietPlan, 'supplementDoses'> & { supplementDoses: ChecklistDose[] };
export type SupplementCheckState = { checked: boolean; unknownQuantity: boolean; hasReport: boolean };
export type SupplementChecklistRow = SupplementCheckState & { dose: ChecklistDose; requirement: SupplementRequirement; scheduled: boolean; required: boolean; selected: boolean };
export type SupplementChecklistGroup = { id: SupplementTimingSlot; label: string; rows: SupplementChecklistRow[]; requiredCount: number; checkedRequiredCount: number; optionalCount: number };

export const SUPPLEMENT_TIMING_SLOTS: readonly { readonly id: SupplementTimingSlot; readonly label: string }[];
export const SUPPLEMENT_REQUIREMENT_LABELS: Readonly<Record<SupplementRequirement, string>>;
export function supplementCheckState(dose: Pick<ChecklistDose, 'actualEntries'> | null | undefined): SupplementCheckState;
export function buildSupplementChecklist(plan: ChecklistPlan): { groups: SupplementChecklistGroup[]; requiredCount: number; checkedRequiredCount: number; optionalCount: number };
export type SupplementTimetablePreview = {
  planId: string; date: string; supplementDoses: DoseInput[];
  rows: { dose: Required<DoseInput>; name: string; brand: string; timingLabel: string; existing: boolean }[];
  typeCount: number; newCount: number; updatedCount: number; retainedCount: number;
};
export function parseSupplementTimetable(text: string, plan: ChecklistPlan, items: readonly FoodItem[]): SupplementTimetablePreview;
