import type { ActualEntry, Meal } from './diet-types';
export type ActualRecipeGroup = { id: string; name: string; actualEntryIds: string[]; portion?: number };
export type ActualRecipeGroupHistory = { at: string; previous: ActualRecipeGroup[] | null };
export function normalizeActualRecipeGroups(value: unknown, actualEntries: readonly ActualEntry[]): ActualRecipeGroup[];
export function applyActualRecipeGroups(meal: Meal, value: unknown, at: string): { meal: Meal; changed: boolean };
