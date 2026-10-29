const rows = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const owns = (value, key) => value != null && Object.hasOwn(value, key);
const snapshotKeys = ['name', 'unit', 'nutrition', 'gramsPerUnit', 'ingredients', 'supplementFacts'];
const foodKeys = ['id', 'itemId', 'name', 'quantity', 'sourceText', 'nutrition', 'nutritionSnapshot'];
const doseKeys = ['itemId', 'plannedQuantity', 'unit', 'plannedMealId', 'plannedTime', 'plannedTimeText',
  'sourceText', 'timingSlot', 'requirement', 'scheduled', 'instruction', 'trainingDayOnly'];

function facts(entity) {
  return rows(entity?.actualEntries).length > 0 || entity?.completionReportedAt != null
    || entity?.actualTime != null || !!entity?.actualTimeText || rows(entity?.reportHistory).length > 0;
}

function itemSnapshot(item) {
  return item ? copy(Object.fromEntries(snapshotKeys.map(key => [key, item[key] ?? null]))) : null;
}

function lineSnapshot(line, previous, items) {
  // Frozen server snapshots are authoritative, including an explicit null.
  if (owns(line, 'nutritionSnapshot')) return copy(line.nutritionSnapshot);
  const same = previous?.itemId === line.itemId && previous?.unit === line.unit;
  let snapshot = same ? copy(previous?.nutritionSnapshot ?? null) : null;
  snapshot ??= itemSnapshot(items.get(line.itemId));
  if (line.nutrition !== undefined) {
    snapshot = { ...(snapshot ?? { name: line.name ?? '', unit: line.unit, gramsPerUnit: null,
      ingredients: '', supplementFacts: '' }), nutrition: copy(line.nutrition) };
  }
  return snapshot;
}

function plannedLine(line, previous, items) {
  const item = items.get(line.itemId);
  const unit = line.unit ?? previous?.unit ?? item?.unit;
  const result = { sourceText: '', ...Object.fromEntries(foodKeys.filter(key => owns(line, key))
    .map(key => [key, copy(line[key])])), unit };
  result.nutritionSnapshot = lineSnapshot(result, previous, items);
  return result;
}

function actualFields(previous) {
  return {
    actualEntries: copy(rows(previous?.actualEntries)), actualTime: previous?.actualTime ?? null,
    actualTimeText: previous?.actualTimeText ?? '', completionReportedAt: previous?.completionReportedAt ?? null,
    reportHistory: copy(rows(previous?.reportHistory)), state: previous?.state ?? 'reserved',
  };
}

function currentMeal(raw, previous, items) {
  return {
    ...(previous ? copy(previous) : {}), id: raw.id, slot: raw.slot, title: raw.title,
    plannedTime: raw.plannedTime ?? null, plannedTimeText: raw.plannedTimeText ?? '',
    plannedItems: rows(raw.plannedItems).map(line => plannedLine(line,
      rows(previous?.plannedItems).find(old => old.id === line.id), items)),
    ...actualFields(previous), sourceText: previous?.sourceText ?? '',
  };
}

function currentDose(raw, previous, items) {
  const planned = Object.fromEntries(doseKeys.filter(key => owns(raw, key)).map(key => [key, copy(raw[key])]));
  const unit = raw.unit ?? previous?.unit ?? items.get(raw.itemId)?.unit;
  return {
    plannedMealId: null, plannedTime: null, plannedTimeText: '', sourceText: '', timingSlot: 'other',
    requirement: 'daily', scheduled: (raw.requirement ?? previous?.requirement ?? 'daily') === 'daily',
    instruction: '', trainingDayOnly: false, ...(previous ? copy(previous) : {}), ...planned, id: previous?.id ?? raw.id, unit,
    nutritionSnapshot: lineSnapshot({ ...raw, unit }, previous, items), ...actualFields(previous),
    actualMealId: previous?.actualMealId ?? null, reportSourceText: previous?.reportSourceText ?? '',
  };
}

/**
 * Read-only canonical current menu. Planning fields come from the latest saved
 * draft; actual facts and accounting always remain owned by the parent record.
 * This supports old supplement-only + draft records without persisting a
 * migration, issuing inventory writes, or inventing actual intake.
 */
export function projectCurrentDietPlan(plan, inventoryItems = []) {
  if (!plan || !Array.isArray(plan.draft?.meals)
    || !['draft', 'reserved'].includes(plan.status)) return plan;
  const draft = plan.draft, items = new Map(rows(inventoryItems).map(item => [item.id, item]));
  const meals = draft.meals.map(raw => currentMeal(raw, rows(plan.meals).find(old => old.id === raw.id), items));
  for (const old of rows(plan.meals)) if (!meals.some(meal => meal.id === old.id) && facts(old)) meals.push(copy(old));
  const doses = rows(draft.supplementDoses).map(raw => currentDose(raw,
    rows(plan.supplementDoses).find(old => old.id === raw.id), items));
  for (const old of rows(plan.supplementDoses)) {
    if (!doses.some(dose => dose.id === old.id) && (plan.supplementOnly || facts(old))) doses.push(copy(old));
  }
  return {
    ...copy(plan), ...Object.fromEntries(['title', 'timeZone', 'notes'].filter(key => owns(draft, key))
      .map(key => [key, copy(draft[key])])),
    meals, supplementDoses: doses, ...(meals.length ? { supplementOnly: false } : {}),
  };
}
