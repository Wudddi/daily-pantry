/** Bounded accounting receipt: personal reminders and frozen meal bodies stay private. */
export function dailyMenuSettlementSummary(plan) {
  if (plan.dailySettlement === undefined) return undefined;
  const source = plan.dailySettlement;
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.source !== 'automatic_menu') {
    throw Object.assign(new Error('自动菜单结算摘要无法可靠读取，请核对原记录。'), { status: 503, code: 'DAILY_MENU_SETTLEMENT_CONTEXT_UNAVAILABLE' });
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
    instructions: '这是按已保存菜单进行的自动库存结算，不证明实际吃完。settled表示已结算，pending_reconciliation表示尚待核对；不能再次扣旧账。个人勾选只作提醒，不是实际摄入。以后改计划不重开已结算旧账，明确实际更正仅按差量处理。',
  };
}
