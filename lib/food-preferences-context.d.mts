import type { PreferenceHistoryEntry } from './inventory-types';

export type FoodPreferencesState = {
  revision: number; preferences: readonly string[]; preferenceHistory?: readonly PreferenceHistoryEntry[];
  preferenceOperationReceipts?: readonly (Pick<PreferenceHistoryEntry, 'operationId' | 'at' | 'sourceDate' | 'reason' | 'revisionBefore' | 'revisionAfter'> & {
    action: 'patch_preferences'; noChange: true; sourceText: string;
  })[];
};
export type FoodPreferencesContext = {
  preferences: string[]; preferencesComplete: true; preferencesCount: number; preferencesRevision: number;
  /** Null for legacy records without preserved preference history. */
  preferencesLastChangedAt: string | null; preferencesLastChangedRevision: number | null;
  preferenceWorkflow: string;
};
export type FoodPreferenceMutationReceipt = FoodPreferencesContext & {
  operation: 'preferences_saved_or_already_current'; operationId: string | null;
  /** History or a durable no-op receipt matched; never proof of a second write. */
  operationFound: boolean; preferenceChangeApplied: boolean; noChange: boolean;
  inventoryEffect: 'none';
  preferenceOperation: (Pick<PreferenceHistoryEntry, 'operationId' | 'at' | 'sourceDate' | 'reason' | 'revisionBefore' | 'revisionAfter'> & {
    action: 'preferences' | 'restore' | 'patch_preferences'; noChange: boolean; sourceText?: string;
  }) | null;
  preferenceChange: (Pick<PreferenceHistoryEntry, 'operationId' | 'action' | 'at' | 'sourceDate' | 'reason' | 'revisionBefore' | 'revisionAfter' | 'previous' | 'next'> & { sourceText?: string }) | null;
};
export const preferenceWorkflowInstructions: string;
export function foodPreferencesContext(state: FoodPreferencesState): FoodPreferencesContext;
export function foodPreferenceMutationReceipt(state: FoodPreferencesState, operationId?: string): FoodPreferenceMutationReceipt;
