import { readInventory, mutateInventory } from './inventory-store';
import { dailyMenuSettlementCandidates } from './daily-menu-runner.mjs';

export async function settleDueDailyMenus(actor: string, rawArgs: unknown = {}) {
  const args = rawArgs as { dryRun?: boolean };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'dryRun') || args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw Object.assign(new Error('仅支持dryRun布尔参数。'), { status: 400 });
  let { state } = await readInventory(actor);
  const context = dailyMenuSettlementCandidates(state);
  if (args.dryRun !== false || !context.enabled) return { available: true, revision: state.revision, dryRun: true, inventoryEffect: 'none', ...context };
  const results = [];
  for (const candidate of context.candidates) {
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      try {
        const policy = dailyMenuSettlementCandidates(state).policy;
        if (!policy?.enabled) break;
        const next = await mutateInventory(actor, { action: 'settle_daily_menu', operationId: 'midnight-food-' + candidate.date,
          expectedRevision: state.revision, planId: candidate.planId, effectiveDate: candidate.date, policyStartDate: policy.startsOn, confirmed: true });
        state = next.state;
        const plan = state.plans?.find((p: { id: string }) => p.id === candidate.planId) as { dailySettlement?: { date: string; accounting: string; settledAt: string | null; basis: string; assumedMealIds: string[] }; inventoryAccounting?: string; accountingIssues?: unknown[]; accountingWarnings?: unknown[] } | undefined;
        const settlement = plan?.dailySettlement;
        results.push({ planId: candidate.planId, date: candidate.date, inventoryAccounting: plan?.inventoryAccounting,
          dailySettlement: settlement ? { date: settlement.date, accounting: settlement.accounting, settledAt: settlement.settledAt, basis: settlement.basis, assumedMealIds: settlement.assumedMealIds } : null,
          ...(plan?.accountingWarnings?.length ? { accountingWarnings: plan.accountingWarnings.slice(0, 10), accountingWarningCount: plan.accountingWarnings.length } : {}), accountingIssues: plan?.accountingIssues?.slice(0, 10) ?? [], accountingIssueCount: plan?.accountingIssues?.length ?? 0 }); saved = true;
      } catch (error) {
        const value = error as { status?: number; code?: string; message?: string };
        if (value.status === 409 && attempt < 2 && ['revision_conflict', 'REVISION_CONFLICT'].includes(value.code ?? '')) { state = (await readInventory(actor)).state; continue; }
        results.push({ planId: candidate.planId, date: candidate.date, available: false, code: value.code ?? 'SETTLEMENT_FAILED', message: value.message }); break;
      }
    }
  }
  return { available: true, revision: state.revision, dryRun: false, localDate: context.localDate, results, ambiguousDates: context.ambiguousDates, hasMore: context.hasMore,
    note: '个人勾选未参与结算；自动按菜单记账与用户明确实际报告分开，已扣部分只调差量。待核项不宣称结算成功。' };
}
