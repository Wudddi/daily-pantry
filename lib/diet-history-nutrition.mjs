/** Binds an explicitly supplied whole-day value to the exact saved menu evidence. */
export function historyNutritionSignature(record) {
  const list = value => Array.isArray(value) ? value : [];
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const fields = nutrition => ['kcal', 'protein', 'carbs', 'fat'].map(key => nutrition?.[key] ?? null);
  const entries = (entities, supplement) => list(entities).flatMap(entity =>
    (supplement ? [entity] : list(entity.items)).map(entry => {
      const planned = finite(entry.plannedQuantity) ? entry.plannedQuantity : entry.plannedQuantity === null && entry.quantitySource === 'reported' && finite(entry.actualQuantity) ? null : finite(entry.quantity) ? entry.quantity : null;
      const actual = finite(entry.actualQuantity) && ['reported', 'confirmed_plan_portion'].includes(entry.quantitySource) ? entry.actualQuantity : null;
      const effective = actual === null ? planned : entity.status === 'partial_report' && finite(planned) ? Math.max(planned, actual) : actual;
      return [
      supplement ? 'supplement' : 'food', entity.id ?? '', entry.id ?? '',
      entry.inventoryItemId ?? null, entry.name ?? '', entry.unit ?? '',
      effective, finite(planned) && planned > 0 ? planned : entry.quantity ?? null, fields(entry.nutrition),
    ]; }));
  return JSON.stringify([record.date, entries(record.meals, false), entries(record.supplements, true)]);
}
