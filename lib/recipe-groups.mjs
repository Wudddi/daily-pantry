/** Named dishes are presentation metadata over the original planned line IDs.
 * They are never another food, nutrient source, actual intake or inventory row. */
function fail(message) { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_RECIPE_GROUPS' }); }
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail(`${label} must contain 1 to 100 characters.`);
  return value.trim();
}

export function normalizeRecipeGroups(value, plannedItems, { pruneMissing = false, previousGroups = [], acceptStoredBasis = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail("Each meal supports at most 20 recipe groups.");
  const lines = new Set((Array.isArray(plannedItems) ? plannedItems : []).map(line => line.id));
  const groups = new Set(), members = new Set(), result = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Reflect.ownKeys(raw).some(key => !['id', 'name', 'lineIds', 'portion', ...(acceptStoredBasis ? ['baseQuantities'] : [])].includes(key))) fail("Recipe groups accept id, name, lineIds, and portion only. The server maintains the recipe scaling basis.");
    const id = text(raw.id, "Recipe group ID"), name = text(raw.name, "Recipe name");
    if (groups.has(id)) fail("Recipe group IDs must be unique within a meal.");
    groups.add(id);
    if (!Array.isArray(raw.lineIds) || raw.lineIds.length < 1 || raw.lineIds.length > 100) fail("A recipe group must reference 1 to 100 food line IDs in this meal.");
    const lineIds = [];
    for (const rawId of raw.lineIds) {
      const lineId = text(rawId, "Recipe food line ID");
      if (members.has(lineId)) fail("A food line cannot be referenced twice or belong to multiple recipe groups.");
      members.add(lineId);
      if (!lines.has(lineId)) {
        if (pruneMissing) continue;
        fail("Recipe groups may reference only existing planned food lines in the current meal.");
      }
      lineIds.push(lineId);
    }
    if (lineIds.length) {
      const previous = (Array.isArray(previousGroups) ? previousGroups : []).find(group => group.id === id);
      const portion = raw.portion === undefined ? previous?.portion : raw.portion;
      if (portion !== undefined && (typeof portion !== 'number' || !Number.isFinite(portion) || portion < 0.01 || portion > 100)) fail("Recipe portions must be between 0.01 and 100.");
      const group = { id, name, lineIds, ...(portion === undefined ? {} : { portion }) };
      const basis = previous?.baseQuantities ?? (acceptStoredBasis ? raw.baseQuantities : undefined);
      if (basis !== undefined || portion !== undefined) {
        const amount = portion ?? 1;
        const valid = Array.isArray(basis) && basis.length === lineIds.length && lineIds.every(lineId => {
          const saved = basis.find(entry => entry.lineId === lineId), line = plannedItems.find(entry => entry.id === lineId);
          return saved && typeof saved.quantity === 'number' && Number.isFinite(saved.quantity) && saved.quantity > 0
            && Math.round(saved.quantity * amount * 1e6) / 1e6 === line?.quantity;
        });
        group.baseQuantities = valid ? structuredClone(basis) : lineIds.map(lineId => {
          const quantity = plannedItems.find(line => line.id === lineId)?.quantity;
          if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) fail("Invalid ingredient quantity. A recipe scaling basis cannot be established.");
          const saved = Array.isArray(basis) ? basis.find(entry => entry.lineId === lineId) : null;
          if (saved && typeof saved.quantity === 'number' && Number.isFinite(saved.quantity) && saved.quantity > 0
            && Math.round(saved.quantity * amount * 1e6) / 1e6 === quantity) return structuredClone(saved);
          return { lineId, quantity: quantity / amount };
        });
      }
      result.push(group);
    }
  }
  return result;
}

/** Apply only to inherited, already-saved metadata after an ingredient is
 * removed or transferred. Explicit incoming invalid references must fail. */
export function pruneRecipeGroups(value, plannedItems) {
  return normalizeRecipeGroups(value, plannedItems, { pruneMissing: true, previousGroups: value, acceptStoredBasis: true });
}
