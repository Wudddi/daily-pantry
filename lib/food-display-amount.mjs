const PACKAGED_UNITS = new Set(['袋', '个', '份', '包', '罐', '条']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);

/** Presentation only: retain the stored/accounting unit and use its frozen conversion. */
export function foodDisplayAmount(line = {}) {
  const snapshot = line.nutritionSnapshot ?? line.snapshot;
  let quantity = finite(line.displayQuantity) ? line.displayQuantity : line.quantity;
  let unit = typeof line.displayUnit === 'string' ? line.displayUnit : line.unit;
  const originalQuantity = line.quantity, originalUnit = line.unit;
  if (!finite(quantity)) return { quantity: null, unit: unit === 'ml' ? 'mL' : unit ?? '', converted: false, text: '用量未报' };
  if (unit?.toLowerCase() === 'ml') unit = 'mL';
  else if (PACKAGED_UNITS.has(unit) && snapshot?.unit === unit && finite(snapshot.gramsPerUnit) && snapshot.gramsPerUnit > 0 && snapshot.nutrition?.basisUnit !== 'ml' && snapshot.nutrition?.basisUnit !== 'mL') {
    quantity = Math.round(quantity * snapshot.gramsPerUnit * 1e6) / 1e6;
    unit = 'g';
  }
  return { quantity, unit: unit ?? '', converted: quantity !== originalQuantity || unit !== originalUnit, text: number(quantity) + (unit ? ' ' + unit : '') };
}

/** Stock keeps its accounting unit; known package mass is clearer on screen. */
export function inventoryDisplayAmount(item = {}) {
  const convert = ['袋', '包'].includes(item.unit) && !['prepared', 'supplement'].includes(item.category)
    && finite(item.gramsPerUnit) && item.gramsPerUnit > 0;
  if (convert) return foodDisplayAmount({ quantity: item.quantity, unit: item.unit, nutritionSnapshot: item });
  return foodDisplayAmount({ quantity: item.quantity, unit: item.unit });
}
