/** A present physical balance is not stock available for an older, uncredited
 * menu. Resolve only explicit balance metadata or its exact historical event;
 * label confirmation times and report receipt times are not inventory facts. */
const rows = value => Array.isArray(value) ? value : [];
const physicalActions = new Set(['set_quantity', 'restock', 'upsert', 'restore', 'reconcile_food_inventory']);
const validInstant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));

export function inventoryBalanceBoundary(state, item) {
  if (!item || item.quantityBaselineSource === 'initial') return null;
  if (validInstant(item.quantityBaselineAt) && typeof item.quantityBaselineSource === 'string'
    && item.quantityBaselineSource.length) return { at: item.quantityBaselineAt, source: item.quantityBaselineSource };

  const token = item.quantityBaselineToken;
  if (typeof token !== 'string') return null;
  for (const event of [...rows(state?.events), ...rows(state?.eventHistory)]) {
    if (!physicalActions.has(event.action) || !validInstant(event.at)
      || token !== `${event.id}@${event.at}`
      || event.itemId !== item.id && !(event.action === 'restore' && event.itemId === undefined)) continue;
    // Older initial product creation also used an operation token. An initial
    // label/starting balance is not evidence of a later physical recount.
    if (event.action === 'upsert' && typeof event.detail === 'string' && event.detail.startsWith("Added")) return null;
    return { at: event.at, source: event.action };
  }
  for (const entry of rows(state?.inventoryReconciliationHistory)) {
    if (entry.itemAfter?.id === item.id && validInstant(entry.at)
      && token === `${entry.operationId}@${entry.at}`) return { at: entry.at, source: 'reconcile_food_inventory' };
  }
  return null;
}

/** Same-day manual reports retain the established flow. Automatic assumptions
 * cannot establish which side of a same-day count they belong to; a late old
 * report cannot establish that either merely by being written after the count.
 * Existing zero-delta credits are deliberately left to the caller unchanged. */
export function foodBalanceBoundaryIssue(state, item, plan, delta, { previousCredit, previousPlan, accountingPlan } = {}) {
  if (delta === 0 || item?.category === 'supplement') return null;
  const boundary = inventoryBalanceBoundary(state, item);
  if (!boundary || typeof plan?.date !== 'string') return null;
  const actuals = value => rows(value?.meals).flatMap(meal => rows(meal.actualEntries)).filter(entry => entry.itemId === item.id);
  const currentActualIds = new Set(actuals(plan).map(entry => entry.id));
  const hasAssumptions = actuals(accountingPlan).some(entry => !currentActualIds.has(entry.id));
  const previousActuals = actuals(previousPlan);
  const validPriorActuals = previousActuals.every(entry => typeof entry.quantity === 'number' && Number.isFinite(entry.quantity)
    && entry.quantity >= 0 && entry.unit === item.unit);
  const priorActualQuantity = Math.round(previousActuals.reduce((total, entry) => total + (entry.quantity ?? 0), 0) * 1e6) / 1e6;
  const currentToken = item.quantityBaselineToken ?? item.confirmedAt ?? 'initial';
  // A real debit on this same baseline, or a deliberate reconciliation credit,
  // already has a known differential contract. Do not make later manual
  // corrections fail merely because this day also has settlement metadata.
  if (!hasAssumptions && previousCredit?.baselineToken === currentToken && previousCredit.unit === item.unit
    && previousCredit.unknownBalance === (item.quantity === null) && validPriorActuals
    && priorActualQuantity >= previousCredit.quantity) return null;
  // The canonical food date and standing settlement policy are Toronto-based.
  // Editing the display timezone must not move a physical accounting boundary.
  const boundaryDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(boundary.at));
  const automatic = plan.dailySettlement?.source === 'automatic_menu';
  if (plan.date < boundaryDate || automatic && plan.date === boundaryDate) return {
    code: 'BALANCE_COVERAGE_REQUIRES_REVIEW', itemId: item.id,
    message: automatic
      ? "This menu's automatic consumption predates a physical stock count/restock, or occurred on the same day with unclear ordering. Current stock may already include this consumption. Only this item needs review; its new balance was not adjusted again."
      : "This earlier intake predates the current physical stock count/restock. Current stock may already include historical consumption. Only this item needs review; a later report timestamp does not authorize another adjustment.",
  };
  return null;
}
