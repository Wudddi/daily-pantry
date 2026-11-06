const array = value => Array.isArray(value) ? value : [];
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const sameFood = (a, b) => a.itemId != null || b.itemId != null
  ? a.itemId != null && a.itemId === b.itemId
  : !!nameKey(a.name) && nameKey(a.name) === nameKey(b.name);

function linkedEntryId(prefix, planId, mealId, lineId) {
  const text = JSON.stringify([planId, mealId, lineId]); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    a = Math.imul(a ^ text.charCodeAt(index), 0x01000193);
    b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return prefix + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Presentation only: retain every row exactly once, without changing its
 * amount, nutrition, individual reminder state or original report. */
export function groupMealRecipeRows(meal, input, { planId } = {}) {
  const planned = array(meal?.plannedItems), byLine = new Map(), recipes = new Map();
  for (const recipe of array(meal?.recipeGroups)) {
    if (typeof recipe?.id !== 'string' || !recipe.id || typeof recipe.name !== 'string' || !recipe.name.trim()) continue;
    if (recipes.has(recipe.id)) continue;
    const saved = { id: recipe.id, name: recipe.name, lineIds: [] };
    recipes.set(recipe.id, saved);
    for (const lineId of new Set(array(recipe.lineIds))) {
      if (!planned.some(line => line.id === lineId)) continue;
      // Invalid legacy overlap stays loose rather than appearing in two dishes.
      if (byLine.has(lineId)) { byLine.set(lineId, null); continue; }
      byLine.set(lineId, saved); saved.lineIds.push(lineId);
    }
  }
  const actual = array(meal?.actualEntries);
  function unambiguousFood(row) {
    const candidates = planned.filter(line => sameFood(line, row));
    const recipe = candidates.length ? byLine.get(candidates[0].id) : null;
    if (recipe && candidates.every(line => byLine.get(line.id) === recipe)) return { recipe, lineIds: candidates.map(line => line.id) };
    return { recipe: null, lineIds: [] };
  }
  function membership(row) {
    const rowId = row.lineId ?? row.id;
    if (row.origin !== 'reported') {
      const exact = planned.find(line => line.id === rowId);
      // Partial-meal conflict rows may collapse several same-food portions
      // into one unknown amount while retaining the first planned ID.
      if (exact && row.origin === 'planned' && row.quantity === null && exact.quantity != null) return unambiguousFood(row);
      if (exact) return { recipe: byLine.get(exact.id) ?? null, lineIds: [exact.id] };
    }
    const report = actual.find(entry => entry.id === rowId);
    // The effective nutrition adapter may combine several reports under the
    // first report ID. That aggregate no longer belongs to its first anchor.
    if (report && ('quantity' in row && row.quantity !== report.quantity || 'unit' in row && row.unit !== report.unit)) return unambiguousFood(row);
    const anchor = row.intakeLineId ?? report?.intakeLineId;
    if (typeof anchor === 'string') {
      const line = planned.find(line => line.id === anchor && sameFood(line, row));
      return { recipe: line ? byLine.get(line.id) ?? null : null, lineIds: line ? [line.id] : [] };
    }
    const exact = planned.filter(line => sameFood(line, row) && (line.syncActualEntryIds?.includes(rowId) || line.id === rowId || planId && (
      linkedEntryId('planned-', planId, meal?.id, line.id) === rowId || linkedEntryId('ui-intake-', planId, meal?.id, line.id) === rowId
    )));
    if (exact.length === 1) return { recipe: byLine.get(exact[0].id) ?? null, lineIds: [exact[0].id] };
    // An unmatched stable anchor must not be reassigned by a coincidental SKU.
    if (typeof rowId === 'string' && /^(?:planned-|ui-intake-)/.test(rowId)) return { recipe: null, lineIds: [] };
    return unambiguousFood(row);
  }
  const sections = [], grouped = new Map();
  array(input).forEach((row, index) => {
    const match = membership(row);
    if (!match.recipe) {
      sections.push({ kind: 'food', id: 'food:' + (row.origin ?? '') + ':' + (row.lineId ?? row.id ?? index) + ':' + index,
        name: row.name ?? '', lineIds: match.lineIds, rows: [row] });
      return;
    }
    let section = grouped.get(match.recipe.id);
    if (!section) {
      section = { kind: 'recipe', id: match.recipe.id, name: match.recipe.name, lineIds: [], rows: [] };
      grouped.set(section.id, section); sections.push(section);
    }
    section.rows.push(row);
    for (const lineId of match.lineIds) if (!section.lineIds.includes(lineId)) section.lineIds.push(lineId);
  });
  return sections;
}
