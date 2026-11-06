/** Bounded accounting receipt: personal reminders and frozen meal bodies stay private. */
export function dailyMenuSettlementSummary(plan) {
  if (plan.dailySettlement === undefined) return undefined;
  const source = plan.dailySettlement;
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.source !== 'automatic_menu') {
    throw Object.assign(new Error("The automatic settlement summary could not be read reliably. Review the original record."), { status: 503, code: 'DAILY_MENU_SETTLEMENT_CONTEXT_UNAVAILABLE' });
  }
  const timestamp = value => typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value)) ? value : null;
  const day = typeof source.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(source.date) && Number.isFinite(Date.parse(source.date)) && new Date(source.date).toISOString().slice(0, 10) === source.date ? source.date : null;
  return {
    source: 'automatic_menu', basis: source.basis === 'auto_planned' ? 'auto_planned' : 'unknown', date: day,
    accounting: ['settled', 'pending_reconciliation'].includes(source.accounting) ? source.accounting : 'unknown',
    attemptedAt: timestamp(source.attemptedAt), settledAt: timestamp(source.settledAt), lastReconciledAt: timestamp(source.lastReconciledAt),
    assumedMealCount: Array.isArray(source.assumedMealIds) ? source.assumedMealIds.length : null,
    plannedMealCount: Array.isArray(source.plannedMeals) ? source.plannedMeals.length : null,
    actualReportsIndependent: true,
    instructions: "This is automatic inventory settlement from a saved menu, not evidence of actual meal completion. settled means accounted; pending_reconciliation requires review. Do not deduct old entries again. Personal checkmarks are reminders, not actual intake. Later menu edits do not reopen settled accounts; explicit actual corrections apply only the difference.",
  };
}
