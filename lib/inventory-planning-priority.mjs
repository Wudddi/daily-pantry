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
  '先遵守用户这次想吃什么、全部有效习惯和全天营养目标；参考已实际执行的完整饮食搭配，少拼凑陌生组合。熟悉搭配仍要按当前习惯、库存与新鲜度调整，不机械照搬。planningHints与freshnessHint都是软优先级，不是强制菜单或平均分配配额。',
  '同样适合时先考虑用户标记优先、明确希望近期用完、冷藏易损食物和明确开封的非冷冻食物，再考虑尾袋等备餐便利。冷冻食物可灵活轮换，不因只剩一袋、旧更新时间或Best Before而强行清掉；不因清库存额外加餐或增加甜点份数。',
  'freshness只记录用户或标签明确的开封与品质事实，不从备注、收货日、confirmedAt或updatedAt推算生产日期、开封日或安全期限。Best Before是品质提示，userConsumeByDate是用户的安排意向，均不是食物安全保证；信息不明时不编造期限，选用时如有实际安全疑问先核对。',
  '读齐库存分页后，按candidateCoverage的食物分类检查所有可用食物ID再选餐；补给按其时间表独立安排，调料用于搭配，不与主餐争轮换名额。不要求一天用遍库存，也不要求为覆盖率每天更换主餐。',
  'recentAcceptedMenuDays仅保留近期已确认菜单plannedItems的旧口径，不是实际吃过的证明，也不是每天换菜指标；没有近期菜单记录不等于没有吃、被忽略或必须安排。用户不想吃、营养不合适和备餐不便时可跳过，不自动改成长期禁用。',
  '某件食物营养待补不阻碍用其他可用食材排餐。已有估算可沿用并标估算；配方或馅料不明的点心可先保留为候选，选中时再说明或核实，未知宏量不补零。',
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
  if (/尾袋/.test(text(item.name)) && !/(?:非|不是|并非)\s*尾袋/.test(text(item.name))) result.push('named_tail_bag');
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
    const invalid = () => { throw Object.assign(new Error('开封与品质资料无法可靠读取，请核对后重试。'), { status: 503, code: 'INVALID_FRESHNESS_FACTS' }); };
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
  if (target === null) throw new Error('排餐优先级需要有效的YYYY-MM-DD日期。');
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
      || nameKey(a.name).localeCompare(nameKey(b.name), 'zh-CN')
      || text(a.id).localeCompare(text(b.id));
  };
  return {
    compare,
    metadata: item => structuredClone(byId.get(item.id)?.metadata ?? {}),
    coverage: {
      source: 'all_paged_inventory_items', availableRoleTotals: roleTotals, availableFoodCategoryTotals: categoryTotals, freshnessGroupTotals,
      instructions: '计数覆盖全库存；所有ID在items分页中，不是只看第一页或优先项。补给和调料独立，不计主餐覆盖配额。',
    },
    recentMenuCoverage: {
      from: new Date(start).toISOString().slice(0, 10), toExclusive: targetDate, windowDays,
      observedConfirmedMenuDates: [...observedDates].sort(), observedDayCount: observedDates.size,
      source: 'confirmed_meals_v1_planned_food_ids', actualIntakeProven: false, completeEatingHistory: false,
    },
  };
}
