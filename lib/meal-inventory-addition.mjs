import { intakeDraftVersion } from './intake-draft.mjs';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e9;
const round = value => Math.round(value * 1e6) / 1e6;
const discrete = new Set(['袋', '包', '个', '片', '份', '罐', '条']);
function fail(message) { throw new Error(message); }
export function inventoryMealChoices(items, query = '') {
  const search = query.normalize('NFKC').trim().toLocaleLowerCase();
  return items.filter(item => item.category !== 'supplement' && item.status === 'available' && item.quantity !== 0
    && (!search || [item.name, item.brand, ...(item.aliases ?? [])].join(' ').normalize('NFKC').toLocaleLowerCase().includes(search)))
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.name.localeCompare(b.name, 'en-CA'));
}
export function mealAdditionUnits(item) {
  return discrete.has(item.unit) && finite(item.gramsPerUnit) ? [item.unit, 'g'] : [item.unit];
}
export function mealAdditionQuantity(item, quantity, unit = item.unit) {
  if (!finite(quantity)) fail("Enter an explicit portion greater than 0.");
  const result = unit === item.unit ? quantity : unit === 'g' && discrete.has(item.unit) && finite(item.gramsPerUnit)
    ? quantity / item.gramsPerUnit : fail("This unit cannot be reliably converted. Use the original inventory unit.");
  const value = round(result);
  if (!finite(value)) fail("This quantity exceeds the supported save precision. Review it.");
  return value;
}
/** Append a menu line only. Saved intake stays a draft; no completion or stock mutation. */
export function buildMealInventoryAddition(plan, items, input, { operationId, expectedRevision } = {}) {
  if (['cancelled', 'closed_with_actuals'].includes(plan.status)) fail("This day is closed. Planned foods cannot be added.");
  const meal = plan.meals.find(meal => meal.id === input.mealId);
  if (!meal || meal.state === 'cancelled') fail("Choose a meal that can still be adjusted.");
  const item = items.find(item => item.id === input.itemId);
  if (!item || !inventoryMealChoices([item]).length) fail("This food is currently unavailable. Choose another inventory item.");
  if (typeof operationId !== 'string' || !operationId || operationId.length > 100) fail("The save operation ID is missing.");
  return { planId: plan.id, mealId: meal.id, itemId: item.id,
    quantity: mealAdditionQuantity(item, input.quantity, input.unit), expectedDraftVersion: intakeDraftVersion(plan.intakeDraft),
    operationId, expectedRevision };
}
