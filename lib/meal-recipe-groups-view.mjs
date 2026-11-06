const array = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
const sameFood = (a, b) => a.itemId != null || b.itemId != null
  ? a.itemId != null && a.itemId === b.itemId
  : !!nameKey(a.name) && nameKey(a.name) === nameKey(b.name);
const sameQuantity = (a,b) => a === b || finite(a) && finite(b) && Math.abs(a-b) <= .000001;
const portion = value => typeof value === 'number' && Number.isFinite(value) && value >= .01 && value <= 100 ? value : undefined;

function linkedEntryId(prefix, planId, mealId, lineId) {
  const text = JSON.stringify([planId, mealId, lineId]); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    a = Math.imul(a ^ text.charCodeAt(index), 0x01000193);
    b = Math.imul(b ^ text.charCodeAt(index), 0x85ebca6b);
  }
  return prefix + (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Presentation only: every input row remains the same object and appears once.
 * Reported recipes require actual-entry membership or a proven legacy anchor;
 * sharing a product with a planned recipe is never evidence of dish membership. */
export function groupMealRecipeRows(meal, input, { planId } = {}) {
  const planned = array(meal?.plannedItems), actual = array(meal?.actualEntries);
  const byLine = new Map(), plannedRecipes = new Map(), byEntry = new Map(), actualRecipes = new Map();
  const explicitActualGroups = !!meal && Object.hasOwn(meal, 'actualRecipeGroups');
  for (const recipe of array(meal?.recipeGroups)) {
    if (typeof recipe?.id !== 'string' || !recipe.id || typeof recipe.name !== 'string' || !recipe.name.trim() || plannedRecipes.has(recipe.id)) continue;
    const saved = { id:recipe.id, groupId:recipe.id, source:'planned', name:recipe.name,
      ...(portion(recipe.portion) === undefined ? {} : {portion:recipe.portion}) };
    plannedRecipes.set(recipe.id, saved);
    for (const lineId of new Set(array(recipe.lineIds))) {
      if (!planned.some(line => line.id === lineId)) continue;
      if (byLine.has(lineId)) { byLine.set(lineId, null); continue; }
      byLine.set(lineId, saved);
    }
  }
  for (const recipe of array(meal?.actualRecipeGroups)) {
    if (typeof recipe?.id !== 'string' || !recipe.id || typeof recipe.name !== 'string' || !recipe.name.trim() || actualRecipes.has(recipe.id)) continue;
    const saved = { id:'actual:'+recipe.id, groupId:recipe.id, source:'actual', name:recipe.name,
      ...(portion(recipe.portion) === undefined ? {} : {portion:recipe.portion}) };
    actualRecipes.set(recipe.id, saved);
    for (const entryId of new Set(array(recipe.actualEntryIds))) {
      if (!actual.some(entry => entry.id === entryId)) continue;
      if (byEntry.has(entryId)) { byEntry.set(entryId, null); continue; }
      byEntry.set(entryId, saved);
    }
  }
  const loose = (source, lineIds = []) => ({ recipe:null, source, lineIds, actualEntryIds:[] });
  function unambiguousPlannedFood(row) {
    const candidates = planned.filter(line => sameFood(line, row));
    const recipe = candidates.length ? byLine.get(candidates[0].id) : null;
    return recipe && candidates.every(line => byLine.get(line.id) === recipe)
      ? { recipe, source:'planned', lineIds:candidates.map(line => line.id), actualEntryIds:[] } : loose('planned');
  }
  function legacyAnchor(row) {
    const rowId = row.lineId ?? row.id, report = actual.find(entry => entry.id === rowId);
    const anchor = row.intakeLineId ?? report?.intakeLineId;
    if (typeof anchor === 'string') {
      const line = planned.find(line => line.id === anchor && sameFood(line, row));
      return line ? {recipe:byLine.get(line.id) ?? null, lineIds:[line.id]} : {recipe:null,lineIds:[]};
    }
    const exact = planned.filter(line => sameFood(line, row) && (line.syncActualEntryIds?.includes(rowId) || line.id === rowId || planId && (
      linkedEntryId('planned-', planId, meal?.id, line.id) === rowId || linkedEntryId('ui-intake-', planId, meal?.id, line.id) === rowId
    )));
    return exact.length === 1 ? { recipe:byLine.get(exact[0].id) ?? null,lineIds:[exact[0].id] } : {recipe:null,lineIds:[]};
  }
  function contributors(row) {
    const rowId = row.lineId ?? row.id, report = actual.find(entry => entry.id === rowId);
    if (Object.hasOwn(row, 'actualEntryIds')) {
      const ids = array(row.actualEntryIds);
      if (!ids.length || new Set(ids).size !== ids.length || !ids.includes(rowId)) return null;
      const entries = ids.map(id => actual.find(entry => entry.id === id));
      if (entries.some(entry => !entry)) return null;
      if ('unit' in row && entries.some(entry => entry.unit !== row.unit)) return null;
      const sum = entries.every(entry => finite(entry.quantity)) ? Math.round(entries.reduce((sum,entry) => sum + entry.quantity,0)*1e6)/1e6 : null;
      if ('quantity' in row && !sameQuantity(row.quantity,sum)) return null;
      return entries;
    }
    if (!report || !('quantity' in row) || row.quantity === report.quantity && (!('unit' in row) || row.unit === report.unit)) return report ? [report] : [];
    // Legacy aggregate input can only be recognized as the exact partial-engine
    // sum under its first actual ID. Membership still needs every explicit ID.
    if (meal?.state !== 'in_progress' || row.unit !== report.unit) return null;
    const entries = actual.filter(entry => sameFood(entry, report) && entry.unit === report.unit);
    const sum = entries.every(entry => finite(entry.quantity)) ? Math.round(entries.reduce((sum,entry) => sum + entry.quantity,0)*1e6)/1e6 : null;
    return entries[0]?.id === rowId && sameQuantity(row.quantity,sum) ? entries : null;
  }
  function membership(row) {
    const rowId = row.lineId ?? row.id;
    if (row.origin !== 'reported') {
      const exact = planned.find(line => line.id === rowId);
      if (exact && row.origin === 'planned' && row.quantity === null && exact.quantity != null) return unambiguousPlannedFood(row);
      if (exact) return {recipe:byLine.get(exact.id) ?? null,source:'planned',lineIds:[exact.id],actualEntryIds:[]};
      return loose('planned');
    }
    const entries = contributors(row);
    if (entries === null) return loose('actual');
    if (explicitActualGroups) {
      const recipe = entries.length ? byEntry.get(entries[0].id) : null;
      return recipe && entries.every(entry => byEntry.get(entry.id) === recipe)
        ? {recipe,source:'actual',lineIds:[],actualEntryIds:entries.map(entry => entry.id)} : loose('actual');
    }
    const anchors = entries.length ? entries.map(entry => legacyAnchor({...entry,...(entries.length === 1 && row.intakeLineId ? {intakeLineId:row.intakeLineId} : {}),origin:'reported'})) : [legacyAnchor(row)];
    const recipe = anchors[0]?.recipe;
    return recipe && anchors.every(anchor => anchor.recipe === recipe)
      ? {recipe,source:'planned',lineIds:[...new Set(anchors.flatMap(anchor => anchor.lineIds))],actualEntryIds:entries.map(entry => entry.id)} : loose('actual');
  }
  const sections = [], grouped = new Map();
  array(input).forEach((row,index) => {
    const match = membership(row);
    if (!match.recipe) {
      sections.push({kind:'food',source:match.source,id:'food:'+(row.origin ?? '')+':'+(row.lineId ?? row.id ?? index)+':'+index,
        name:row.name ?? '',lineIds:match.lineIds,actualEntryIds:match.actualEntryIds,rows:[row]});
      return;
    }
    const groupKey = match.recipe.source+':'+match.recipe.id;
    let section = grouped.get(groupKey);
    if (!section) { section = {kind:'recipe',...match.recipe,lineIds:[],actualEntryIds:[],rows:[]}; grouped.set(groupKey,section); sections.push(section); }
    section.rows.push(row);
    // A planned serving count is not evidence of the portion actually eaten.
    if (row.origin === 'reported' && match.recipe.source === 'planned') delete section.portion;
    for (const id of match.lineIds) if (!section.lineIds.includes(id)) section.lineIds.push(id);
    for (const id of match.actualEntryIds) if (!section.actualEntryIds.includes(id)) section.actualEntryIds.push(id);
  });
  return sections;
}

/** Display-only cleanup with an exact, explicitly grouped recipe-name prefix.
 * Other colons, names and all persisted reports remain untouched. */
export function recipeIngredientDisplayName(section, row) {
  const name = typeof row?.name === 'string' ? row.name : '';
  if (section?.kind !== 'recipe' || section.source !== 'actual' || typeof section.name !== 'string') return name;
  const prefix = '\u534a\u4efd'+section.name+'\uff1a';
  const rest = name.startsWith(prefix) ? name.slice(prefix.length).trimStart() : '';
  return rest ? rest : name;
}
