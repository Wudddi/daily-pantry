/** Complete current habits shared by first planning reads, focused edits and write receipts. */
export const preferenceWorkflowInstructions = "App preferences, not chat memory, are authoritative. Save only explicit continuing user rules; not suggestions, examples, or one-off edits. Ask if unclear. Read complete preferences/revision first. patch_food_preferences adds nonduplicates, replaces exact old text, and preserves unrelated rules. Claim saved only after receipt confirms the operation/preferencesComplete. Check every preference, current date/meals/packed-lunch needs; restrictions beat macros/rotation. One-time exceptions do not cancel rules. Edit target meals only; preserve supplements and verify daily nutrition.";

function unavailable() {
  throw Object.assign(new Error("Current meal preferences could not be read completely. Review and retry; a read failure does not mean no preferences exist."), { status: 503, code: 'PREFERENCES_UNAVAILABLE' });
}

function historyOf(state) {
  if (state.preferenceHistory === undefined) return [];
  if (!Array.isArray(state.preferenceHistory)) unavailable();
  return state.preferenceHistory;
}

/** Never shorten, normalize or infer a preference from another record. */
export function foodPreferencesContext(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.preferences) || state.preferences.length > 60
    || state.preferences.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) unavailable();
  const last = historyOf(state).at(-1);
  if (last && (typeof last.at !== 'string' || !Number.isSafeInteger(last.revisionAfter)
    || last.revisionAfter < 1 || last.revisionAfter > state.revision)) unavailable();
  return {
    preferences: state.preferences.slice(), preferencesComplete: true, preferencesCount: state.preferences.length,
    preferencesRevision: state.revision, preferencesLastChangedAt: last?.at ?? null,
    preferencesLastChangedRevision: last?.revisionAfter ?? null, preferenceWorkflow: preferenceWorkflowInstructions,
  };
}

/** A history hit proves a habit change persisted once, including on a retry.
 * No-op receipts prove an already-current save without inventing a change. */
export function foodPreferenceMutationReceipt(state, operationId) {
  const context = foodPreferencesContext(state);
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 100)) {
    throw Object.assign(new Error("The preference operation ID must contain 1 to 100 characters."), { status: 400, code: 'INVALID_INPUT' });
  }
  const entry = operationId === undefined ? null : historyOf(state).findLast(row => row.operationId === operationId) ?? null;
  if (state.preferenceOperationReceipts !== undefined && !Array.isArray(state.preferenceOperationReceipts)) unavailable();
  const noOp = operationId === undefined ? null
    : (state.preferenceOperationReceipts ?? []).findLast(row => row.operationId === operationId) ?? null;
  const operation = entry ?? noOp;
  return {
    ...context, operation: 'preferences_saved_or_already_current', operationId: operationId ?? null,
    operationFound: operation !== null, preferenceChangeApplied: entry !== null, noChange: entry === null,
    inventoryEffect: 'none',
    preferenceOperation: operation === null ? null : {
      operationId: operation.operationId, action: operation.action, at: operation.at,
      sourceDate: operation.sourceDate, reason: operation.reason,
      ...(operation.sourceText === undefined ? {} : { sourceText: operation.sourceText }),
      revisionBefore: operation.revisionBefore, revisionAfter: operation.revisionAfter, noChange: entry === null,
    },
    preferenceChange: entry === null ? null : {
      operationId: entry.operationId, action: entry.action, at: entry.at,
      sourceDate: entry.sourceDate, reason: entry.reason,
      ...(entry.sourceText === undefined ? {} : { sourceText: entry.sourceText }),
      revisionBefore: entry.revisionBefore, revisionAfter: entry.revisionAfter,
      previous: entry.previous.slice(), next: entry.next.slice(),
    },
  };
}
