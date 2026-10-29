/** Accounting uncertainty is separate from physical inventory availability. */
const unavailable = () => { throw Object.assign(new Error('库存账务待核资料无法可靠读取，请核对后重试。'), { status: 503, code: 'INVENTORY_ACCOUNTING_CONTEXT_UNAVAILABLE' }); };

export function inventoryAccountingContext(state) {
  if (!state || !Array.isArray(state.items) || (state.plans !== undefined && !Array.isArray(state.plans))) unavailable();
  const items = new Map(state.items.map(item => [item.id, item]));
  const grouped = new Map(), pendingPlanIds = [];
  for (const plan of state.plans ?? []) {
    if (plan.format !== 'meals_v1' || plan.inventoryAccounting !== 'pending_reconciliation') continue;
    if (typeof plan.id !== 'string' || !plan.id || !Array.isArray(plan.accountingIssues)) unavailable();
    pendingPlanIds.push(plan.id);
    for (const issue of plan.accountingIssues) {
      if (!issue || typeof issue.code !== 'string' || !issue.code) unavailable();
      if (typeof issue.itemId !== 'string' || !items.has(issue.itemId)) continue;
      const item = items.get(issue.itemId);
      // An unspecified dose cannot make an already unknown balance less exact.
      if (issue.code === 'ACTUAL_QUANTITY_UNKNOWN' && item.quantity === null) continue;
      if (!grouped.has(item.id)) grouped.set(item.id, { balanceReliable: false, planIds: new Set(), codes: new Set() });
      const row = grouped.get(item.id); row.planIds.add(plan.id); row.codes.add(issue.code);
    }
  }
  const byItemId = Object.fromEntries([...grouped].map(([itemId, row]) => [itemId, { balanceReliable: false, planIds: [...row.planIds].sort(), codes: [...row.codes].sort() }]));
  return { byItemId, pendingPlanIds: [...new Set(pendingPlanIds)].sort(), pendingItemCount: grouped.size };
}

/** Spread after the ordinary read projection. Preserve original numeric balance
 * as bookQuantity; never promote a physically pending/depleted/archived item. */
export function inventoryAccountingFields(item, context) {
  const row = Object.hasOwn(context.byItemId, item.id) ? context.byItemId[item.id] : null;
  if (!row) return {};
  return { accountingContext: { balanceReliable: false, planIds: row.planIds.slice(), codes: row.codes.slice() },
    bookQuantity: item.quantity,
    ...(item.status === 'available' && item.quantity !== null ? { quantity: null } : {}) };
}
