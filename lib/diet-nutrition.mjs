const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat'];
const DISCRETE = new Set(['袋', '个', '片', '份', '包', '罐', '条', '粒', '滴']);
const rows = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';

/** Convert a planned quantity using only the nutrition snapshot saved with it. */
export function nutritionFactor(snapshot, quantity, unit) {
  const basis = snapshot?.nutrition;
  if (!basis || !finite(quantity) || !Number.isFinite(basis.basisAmount) || basis.basisAmount <= 0 || typeof unit !== 'string' || !unit || typeof basis.basisUnit !== 'string' || !basis.basisUnit) return null;
  if (unit === basis.basisUnit) return quantity / basis.basisAmount;
  const grams = snapshot.gramsPerUnit;
  if (!Number.isFinite(grams) || grams <= 0 || unit === 'ml' || basis.basisUnit === 'ml') return null;
  if (DISCRETE.has(unit) && basis.basisUnit === 'g') return quantity * grams / basis.basisAmount;
  if (unit === 'g' && DISCRETE.has(basis.basisUnit)) return quantity / grams / basis.basisAmount;
  return null;
}

function plannedLines(entity, supplement) {
  if (supplement) {
    // Legacy doses are scheduled daily. New checklist candidates are not part
    // of the day's menu until scheduled with a known dose or actually reported.
    const requirement = entity.requirement ?? 'daily';
    const scheduled = entity.scheduled ?? requirement === 'daily';
    if (!scheduled || !finite(entity.plannedQuantity)) return [];
  }
  const input = supplement ? [{ ...entity, quantity: entity.plannedQuantity }] : rows(entity.plannedItems);
  return input.map((line, index) => ({
    snapshot: line.nutritionSnapshot ?? null, quantity: line.quantity, unit: line.unit,
    itemId: line.itemId ?? null, name: line.name ?? line.nutritionSnapshot?.name ?? '',
    entityId: entity.id ?? '', lineId: line.id ?? String(index), supplement, origin: 'planned',
  }));
}

function sameFood(a, b) {
  return a.itemId != null || b.itemId != null
    ? a.itemId != null && a.itemId === b.itemId
    : !!nameKey(a.name) && nameKey(a.name) === nameKey(b.name);
}

function stableLineHash(planId, mealId, lineId) {
  const key = JSON.stringify([planId, mealId, lineId]); let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let index = 0; index < key.length; index++) { a = Math.imul(a ^ key.charCodeAt(index), 0x01000193); b = Math.imul(b ^ key.charCodeAt(index), 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Only explicit incoming allocations can add future food to an already-ended
 * meal. Old unconsumed originals remain historical evidence, never revived. */
export function transferredFoodRemainders(planId, meal) {
  const planned = rows(meal?.plannedItems), incoming = planned.filter(line => typeof line.id === 'string' && line.id.startsWith('ui-transfer-'));
  if (!incoming.length) return [];
  const amounts = new Map(incoming.map(line => [line.id, { used: 0, unknown: false }]));
  for (const entry of rows(meal.actualEntries)) {
    const candidates = planned.filter(line => sameFood(line, entry));
    const linked = entry.intakeLineId ? candidates.find(line => line.id === entry.intakeLineId) : null;
    const exact = planId ? candidates.filter(line => {
      const hash = stableLineHash(planId, meal.id, line.id);
      return entry.id === 'ui-intake-' + hash || entry.id === 'planned-' + hash;
    }) : [];
    const original = candidates.filter(line => !line.id.startsWith('ui-transfer-'));
    const anchored = !!entry.intakeLineId || typeof entry.id === 'string' && entry.id.startsWith('ui-intake-');
    const target = linked ?? (exact.length === 1 ? exact[0] : !anchored && original.length === 1 ? original[0] : !anchored && candidates.length === 1 ? candidates[0] : null);
    const balance = target && amounts.get(target.id);
    if (balance) {
      if (!finite(entry.quantity) || entry.unit !== target.unit) balance.unknown = true;
      else balance.used += entry.quantity;
    } else if (!target && !anchored && candidates.length > 1) {
      // Multiple incoming recipes with an unanchored report cannot be assigned
      // one shared amount. Preserve that uncertainty instead of double-counting.
      for (const line of candidates) if (amounts.has(line.id)) amounts.get(line.id).unknown = true;
    }
  }
  return incoming.map(line => {
    const amount = amounts.get(line.id);
    return { ...line, quantity: amount.unknown || !finite(line.quantity) ? null : Math.max(0, Math.round((line.quantity - amount.used) * 1e6) / 1e6) };
  }).filter(line => line.quantity === null || line.quantity > 0);
}

function reportedLines(entity, supplement, planned) {
  return rows(entity.actualEntries).map((entry, index) => {
    const compatible = planned.find(line => sameFood(line, entry) && line.unit === entry.unit);
    return { snapshot: entry.nutritionSnapshot ?? compatible?.snapshot ?? null, quantity: entry.quantity,
      unit: entry.unit, itemId: entry.itemId ?? null, name: entry.name ?? entry.nutritionSnapshot?.name ?? '',
      entityId: entity.id ?? '', lineId: entry.id ?? String(index), supplement, origin: 'reported' };
  });
}

/** Effective daily menu, not proof that unreported meals were eaten. */
export function planNutritionLines(plan) {
  const result = [];
  for (const [entities, supplement] of [[rows(plan?.meals), false], [rows(plan?.supplementDoses), true]]) {
    for (const entity of entities) {
      const planned = plannedLines(entity, supplement);
      const actual = reportedLines(entity, supplement, planned);
      if (supplement && !planned.length) {
        // An optional or label-pending checkbox never creates an implied dose.
        // Explicit actual entries still contribute once, including unknowns.
        result.push(...actual);
      } else if (entity.state === 'cancelled' || plan?.status === 'cancelled') {
        result.push(...actual); // Cancellation never erases already reported food.
      } else if (entity.state === 'completed' && actual.length) {
        result.push(...actual);
        if (!supplement && plan?.status !== 'closed_with_actuals') {
          const incoming = transferredFoodRemainders(plan?.id, entity);
          result.push(...plannedLines({ ...entity, plannedItems: incoming }, false));
        }
      } else if (entity.state === 'in_progress' && actual.length) {
        // A partial report is a lower bound, not a replacement for the rest of
        // the meal. Combine same-food reports and retain the unreported plan.
        const remaining = planned.slice();
        const consumed = [];
        for (const line of actual) {
          const previous = consumed.find(other => sameFood(other, line) && other.unit === line.unit);
          if (previous) previous.quantity = finite(previous.quantity) && finite(line.quantity) ? previous.quantity + line.quantity : null;
          else consumed.push({ ...line });
        }
        for (const line of consumed) {
          const indices = remaining.map((other, index) => sameFood(other, line) ? index : -1).filter(index => index >= 0);
          if (!indices.length) { remaining.push(line); continue; }
          const compatible = indices.every(index => remaining[index].unit === line.unit);
          const total = indices.reduce((sum, index) => sum + (finite(remaining[index].quantity) ? remaining[index].quantity : 0), 0);
          if (!compatible) {
            // Incompatible actual units are unresolved facts, not a second
            // serving added on top of the same planned food.
            remaining[indices[0]] = { ...remaining[indices[0]], quantity: null };
            for (const index of indices.slice(1).reverse()) remaining.splice(index, 1);
          } else if (finite(line.quantity) && line.quantity > total) {
            remaining[indices[0]] = line;
            for (const index of indices.slice(1).reverse()) remaining.splice(index, 1);
          }
        }
        result.push(...remaining);
      } else {
        // No check-in is required. A completion flag without a content report
        // likewise does not justify replacing a planned meal with zero.
        result.push(...planned);
      }
    }
  }
  return result;
}

/** Shared aggregation for saved per-basis snapshots and history portion rows. */
export function nutritionTotalsFromLines(lines, source = 'plan_items') {
  return NUTRIENTS.map(key => {
    let sum = 0, knownCount = 0, missing = 0, supplementMissing = 0, estimated = false;
    for (const line of lines) {
      const ratio = nutritionFactor(line.snapshot, line.quantity, line.unit);
      const nutrient = line.snapshot?.nutrition?.[key];
      if (line.quantity === 0 || ratio !== null && finite(nutrient)) {
        sum += line.quantity === 0 ? 0 : nutrient * ratio;
        knownCount++;
        estimated ||= line.quantity !== 0 && (line.snapshot.nutrition.nutrientSources?.[key] ?? line.snapshot.nutrition.source) === 'estimate';
      } else if (line.supplement) supplementMissing++;
      else missing++;
    }
    const value = knownCount > 0 ? Math.round(sum * 1e6) / 1e6 : lines.length === 0 ? 0 : null;
    const complete = value !== null && missing === 0 && supplementMissing === 0;
    return { key, value, knownCount, missing, supplementMissing, estimated, partial: missing > 0,
      supplementPartial: supplementMissing > 0, complete, completeValue: complete ? value : null, source };
  });
}

/**
 * Unknown food and supplement nutrients remain separately visible. A sum only
 * exists when at least one line provides that nutrient, including explicit zero.
 * This reads saved plan snapshots and never changes the plan or inventory.
 */
export function planNutritionTotals(plan) {
  return nutritionTotalsFromLines(planNutritionLines(plan));
}
