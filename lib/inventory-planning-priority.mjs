/** Read-only meal candidate priorities. These are tie breakers, never a menu. */
const CATEGORY_ORDER = ['prepared', 'protein', 'staple', 'vegetable', 'fruit', 'nuts', 'bread', 'dessert', 'other', 'condiment', 'supplement'];
const CATEGORY_RANK = new Map(CATEGORY_ORDER.map((category, index) => [category, index]));
const STATUS_RANK = new Map(['available', 'pending', 'depleted', 'archived'].map((status, index) => [status, index]));
const rows = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const dayMillis = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value ? millis : null;
};
const nameKey = value => text(value).normalize('NFKC').trim().toLocaleLowerCase('en');

export const PLANNING_PRIORITY_RULES = [
  "Current requests, all preferences and nutrition goals lead. Adapt familiar actually executed meals to current stock/freshness. Hints are tie breakers, never quotas or forced pairings.",
  "Prefer explicit priority/consume-soon requests and opened/chilled perishables when suitable. Frozen tail packs, old updates and Best Before do not justify extra meals/desserts or clearance.",
  "Opening/quality dates need explicit user/label evidence, never inference from notes or timestamps. Best Before is quality; consume-by is user intent. Neither guarantees safety. Do not invent deadlines; check real safety concerns.",
  "Read all pages and check every available candidate ID. Supplements/condiments have separate roles, not main-meal rotation quotas. No daily stock-clearance or dish-change requirement.",
  "Recent planned menus prove neither intake nor preferences; missing plans do not imply ignored food. Skip unsuitable food without creating permanent bans.",
  "Missing nutrition does not block other stock. Label reused estimates; verify unclear pastries if selected. Unknown macros are not zero.",
];

export function inventoryPlanningRole(item) {
  return item.category === 'supplement' ? 'supplement' : item.category === 'condiment' ? 'condiment' : 'food';
}

export function inventoryItemAvailable(item) {
  return item.status === 'available' && item.quantity !== 0;
}

function attention(item) {
  if (!inventoryItemAvailable(item) || inventoryPlanningRole(item) !== 'food') return [];
  const result = [];
  if (item.priority === true) result.push('user_priority');
  // Only the current product name is interpreted. Historical notes can mention
  // already-finished tail bags, so scanning those would invent current facts.
  const tailName = text(item.name);
  if (/(?:尾袋|\btail[\s-]*(?:bags?|packs?)\b)/i.test(tailName)
    && !/(?:非|不是|并非)\s*尾袋|\b(?:not(?:\s+(?:a|an))?|non)[\s-]+tail[\s-]*(?:bags?|packs?)\b/i.test(tailName)) result.push('named_tail_bag');
  if (item.category === 'prepared' && ['袋', '包'].includes(item.unit) && typeof item.quantity === 'number' && item.quantity > 0 && item.quantity <= 1) result.push('last_prepared_bag');
  if (item.category === 'vegetable' && item.location === '冷藏') result.push('refrigerated_vegetable');
  return result;
}

const FRESHNESS_GROUPS = ['use_soon', 'fresh_first', 'frozen_flexible', 'shelf_stable', 'storage_unknown'];
const attentionScore = (hints, frozen) => (hints.includes('user_priority') ? 1000 : 0)
  + (!frozen && hints.includes('named_tail_bag') ? 12 : 0)
  + (!frozen && hints.includes('last_prepared_bag') ? 6 : 0);

function freshnessPriority(item, target) {
  const basis = [];
  const namedFrozen = /冷冻|frozen/i.test(text(item.name)) && !/(?:非|不是|并非)\s*冷冻|not\s+frozen/i.test(text(item.name));
  // A confirmed current location wins over the type printed in a product name.
  const frozen = item.location === '冷冻' || (!item.location && namedFrozen);
  const freshProduce = ['vegetable', 'fruit'].includes(item.category) && !frozen && !namedFrozen
    && !/果干|蔬菜干|脱水|干燥|罐头|dried|dehydrat|canned/i.test(text(item.name));
  const chilledPerishable = item.location === '冷藏' && ['prepared', 'protein', 'vegetable', 'fruit'].includes(item.category);
  let group = 'storage_unknown', score = 0;
  if (frozen) {
    group = 'frozen_flexible'; basis.push(item.location === '冷冻' ? 'confirmed_frozen_storage' : 'named_frozen_product');
  } else if (item.location === '冷藏') {
    basis.push('confirmed_refrigerated_storage');
    group = chilledPerishable ? 'fresh_first' : 'shelf_stable';
    if (chilledPerishable) { basis.push('refrigerated_perishable_category'); score = 120; }
  } else if (item.location === '常温') {
    basis.push('confirmed_room_temperature_storage'); group = freshProduce ? 'fresh_first' : 'shelf_stable';
    if (namedFrozen) { group = 'storage_unknown'; basis.push('storage_product_mismatch'); }
    if (freshProduce) score = 60;
  } else basis.push('storage_unreported');
  if (freshProduce) {
    basis.push('fresh_produce_kind');
    // A fresh product kind is useful for quality planning without claiming a
    // refrigerator location or inventing how long it has been stored.
    if (!item.location) score = 30;
  }
  if (item.freshness !== undefined) {
    const facts = item.freshness;
    const invalid = () => { throw Object.assign(new Error("Opening/quality facts could not be read reliably. Review and retry."), { status: 503, code: 'INVALID_FRESHNESS_FACTS' }); };
    if (!facts || typeof facts !== 'object' || Array.isArray(facts) || Reflect.ownKeys(facts).some(key => !['opened', 'openedOn', 'bestBeforeDate', 'userConsumeByDate', 'sourceText'].includes(key))
      || typeof facts.sourceText !== 'string' || !facts.sourceText.trim() || facts.sourceText.length > 1000
      || (facts.opened !== undefined && facts.opened !== null && typeof facts.opened !== 'boolean')) invalid();
    for (const key of ['openedOn', 'bestBeforeDate', 'userConsumeByDate']) if (facts[key] !== undefined && facts[key] !== null && dayMillis(facts[key]) === null) invalid();
    if (facts.opened === false && facts.openedOn != null) invalid();
    if (facts.opened === true || facts.openedOn != null) {
      basis.push('confirmed_opened');
      if (!frozen) {
        if (item.location) { group = 'fresh_first'; score = Math.max(score, 110); }
        else score = Math.max(score, 25);
      }
    } else if (facts.opened === false) basis.push('confirmed_unopened');
    const qualityDate = dayMillis(facts.bestBeforeDate);
    if (qualityDate !== null) {
      basis.push('best_before_quality_date_recorded');
      if (!frozen && qualityDate <= target + 2 * 86400000) {
        basis.push(qualityDate < target ? 'best_before_quality_date_passed' : 'best_before_quality_date_near');
        score += 20;
      }
    }
    const desiredDate = dayMillis(facts.userConsumeByDate);
    if (desiredDate !== null) {
      basis.push('user_consume_by_recorded');
      if (desiredDate <= target + 2 * 86400000) {
        basis.push(desiredDate < target ? 'user_consume_by_passed' : 'user_consume_by_near');
        group = 'use_soon'; score += 300;
      }
    }
  }
  return { hint: { group, basis }, score, frozen };
}

/** Scan only food IDs in recent accepted meals. Never scan imported history,
 * full labels, report text, training, draft proposals or supplement doses. */
export function inventoryPlanningPriorities(state, targetDate) {
  const target = dayMillis(targetDate);
  if (target === null) throw new Error("Planning priorities require a valid YYYY-MM-DD date.");
  const windowDays = 14, start = target - windowDays * 86400000;
  const foodIds = new Set(rows(state.items).filter(item => inventoryPlanningRole(item) === 'food').map(item => item.id));
  const observedDates = new Set(), menuDatesByItem = new Map();
  for (const plan of rows(state.plans)) {
    if (plan.format !== 'meals_v1' || !['reserved', 'closed_with_actuals'].includes(plan.status) || plan.supplementOnly === true) continue;
    const at = dayMillis(plan.date);
    if (at === null || at < start || at >= target) continue;
    let hasFood = false;
    for (const meal of rows(plan.meals)) {
      if (meal.state === 'cancelled') continue;
      for (const line of rows(meal.plannedItems)) {
        if (!foodIds.has(line.itemId) || !(typeof line.quantity === 'number' && line.quantity > 0)) continue;
        hasFood = true;
        if (!menuDatesByItem.has(line.itemId)) menuDatesByItem.set(line.itemId, new Set());
        menuDatesByItem.get(line.itemId).add(plan.date);
      }
    }
    if (hasFood) observedDates.add(plan.date);
  }
  const byId = new Map();
  const roleTotals = { food: 0, condiment: 0, supplement: 0 };
  const categoryTotals = Object.fromEntries(CATEGORY_ORDER.filter(category => !['condiment', 'supplement'].includes(category)).map(category => [category, 0]));
  const freshnessGroupTotals = Object.fromEntries(FRESHNESS_GROUPS.map(group => [group, 0]));
  for (const item of rows(state.items)) {
    const role = inventoryPlanningRole(item), hints = attention(item), menuDates = menuDatesByItem.get(item.id);
    const available = inventoryItemAvailable(item);
    const freshness = available && role === 'food' ? freshnessPriority(item, target) : null;
    const detail = { hints, score: attentionScore(hints, freshness?.frozen ?? false) + (freshness?.score ?? 0), recentDays: menuDates?.size ?? 0, role };
    const metadata = {};
    if (available && role === 'food') {
      if (hints.length) metadata.planningHints = hints;
      metadata.freshnessHint = freshness.hint;
      if (observedDates.size) metadata.recentAcceptedMenuDays = detail.recentDays;
      if (menuDates?.size) metadata.lastAcceptedMenuDate = [...menuDates].sort().at(-1);
      roleTotals.food++;
      categoryTotals[item.category] = (categoryTotals[item.category] ?? 0) + 1;
      freshnessGroupTotals[freshness.hint.group]++;
    } else if (available) roleTotals[role]++;
    byId.set(item.id, { ...detail, metadata });
  }
  const compare = (a, b) => {
    const effectiveStatus = item => inventoryItemAvailable(item) ? 'available' : item.status === 'available' && item.quantity === 0 ? 'depleted' : item.status;
    const statusOrder = (STATUS_RANK.get(effectiveStatus(a)) ?? 9) - (STATUS_RANK.get(effectiveStatus(b)) ?? 9);
    if (statusOrder) return statusOrder;
    const pa = byId.get(a.id), pb = byId.get(b.id);
    const roleRank = role => role === 'food' ? 0 : role === 'condiment' ? 1 : 2;
    return roleRank(pa.role) - roleRank(pb.role)
      || pb.score - pa.score
      || (CATEGORY_RANK.get(a.category) ?? 9) - (CATEGORY_RANK.get(b.category) ?? 9)
      || pa.recentDays - pb.recentDays
      || nameKey(a.name).localeCompare(nameKey(b.name), 'en-CA')
      || text(a.id).localeCompare(text(b.id));
  };
  return {
    compare,
    metadata: item => structuredClone(byId.get(item.id)?.metadata ?? {}),
    coverage: {
      source: 'all_paged_inventory_items', availableRoleTotals: roleTotals, availableFoodCategoryTotals: categoryTotals, freshnessGroupTotals,
      instructions: "Counts cover all inventory; IDs are in items pages. Check all pages, not priority alone. Supplements/condiments have no main-meal quota.",
    },
    recentMenuCoverage: {
      from: new Date(start).toISOString().slice(0, 10), toExclusive: targetDate, windowDays,
      observedConfirmedMenuDates: [...observedDates].sort(), observedDayCount: observedDates.size,
      source: 'confirmed_meals_v1_planned_food_ids', actualIntakeProven: false, completeEatingHistory: false,
    },
  };
}
