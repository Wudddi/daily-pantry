const rows = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
function fail(message, code = 'INVALID_ACTUAL_RECIPE_GROUPS', status = 400) {
  throw Object.assign(new Error(message), { code, status });
}
function text(value, label, limit = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(label + ' has an invalid length.');
  return value.trim();
}

/** Actual dish membership references actual entry IDs, never inventory SKUs or
 * planned line IDs. It carries no ingredient quantities or nutrition values. */
export function normalizeActualRecipeGroups(value, actualEntries) {
  if (!Array.isArray(value) || value.length > 20) fail('Each meal supports at most 20 actual recipe groups.');
  const available = new Set(rows(actualEntries).map(entry => entry.id)), groups = new Set(), members = new Set();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['id', 'name', 'actualEntryIds', 'portion'].includes(key))) {
      fail('Actual recipe groups accept id, name, actualEntryIds, and portion only.');
    }
    const id = text(raw.id, 'Actual recipe group ID'), name = text(raw.name, 'Actual recipe name');
    if (groups.has(id)) fail('Actual recipe group IDs must be unique within a meal.');
    groups.add(id);
    if (!Array.isArray(raw.actualEntryIds) || raw.actualEntryIds.length < 1 || raw.actualEntryIds.length > 100) {
      fail('An actual recipe group must reference 1 to 100 actual entry IDs in this meal.');
    }
    const actualEntryIds = raw.actualEntryIds.map(value => {
      const entryId = text(value, 'Actual recipe entry ID', 400);
      if (!available.has(entryId)) fail('An actual recipe group can reference only existing actual entries in this meal.');
      if (members.has(entryId)) fail('An actual entry cannot be referenced twice or belong to multiple actual recipe groups.');
      members.add(entryId); return entryId;
    });
    if (raw.portion !== undefined && (typeof raw.portion !== 'number' || !Number.isFinite(raw.portion) || raw.portion < 0.01 || raw.portion > 100)) {
      fail('Actual recipe portions must be between 0.01 and 100.');
    }
    return { id, name, actualEntryIds, ...(raw.portion === undefined ? {} : { portion: raw.portion }) };
  });
}

/** Metadata-only correction with original definitions retained in audit history. */
export function applyActualRecipeGroups(meal, value, at) {
  const groups = normalizeActualRecipeGroups(value, meal.actualEntries);
  if (JSON.stringify(meal.actualRecipeGroups) === JSON.stringify(groups)) return { meal, changed: false };
  const history = meal.actualRecipeGroupHistory ?? [];
  if (!Array.isArray(history) || history.length >= 200) fail('Actual recipe grouping history requires review before another edit.', 'ACTUAL_RECIPE_GROUP_HISTORY_LIMIT', 409);
  return { changed: true, meal: { ...copy(meal), actualRecipeGroups: groups,
    actualRecipeGroupHistory: [...copy(history), { at, previous: meal.actualRecipeGroups === undefined ? null : copy(meal.actualRecipeGroups) }] } };
}
