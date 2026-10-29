import { readDailyMenuSettlementPolicy } from './daily-menu-policy.mjs';
import { projectCurrentDietPlan } from './diet-current-plan.mjs';
export function dailyMenuSettlementCandidates(state, now = new Date().toISOString()) {
  const policy = readDailyMenuSettlementPolicy(state);
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (!policy?.enabled) return { enabled: false, localDate, policy, candidates: [], ambiguousDates: [], total: 0, hasMore: false };
  const byDate = new Map(), alreadyProcessed = [];
  for (const plan of state.plans ?? []) {
    if (plan.format !== 'meals_v1' || plan.date < policy.startsOn || plan.date >= localDate || ['cancelled', 'closed_with_actuals'].includes(plan.status)) continue;
    // Old supplement-only records may still hold the saved food menu in draft.
    // Match the writer's canonical projection without modifying those records.
    const current = projectCurrentDietPlan(plan, state.items ?? []);
    if (current.supplementOnly === true || !current.meals?.length) continue;
    if (!byDate.has(plan.date)) byDate.set(plan.date, []);
    byDate.get(plan.date).push(plan);
  }
  const ambiguousDates = [], candidates = [];
  for (const [date, plans] of byDate) {
    if (plans.length !== 1) { ambiguousDates.push(date); continue; }
    const plan = plans[0];
    if (plan.dailySettlement?.source === 'automatic_menu' && plan.dailySettlement.date === date) {
      alreadyProcessed.push({ date, planId: plan.id, accounting: plan.dailySettlement.accounting }); continue;
    }
    candidates.push({ date, planId: plan.id, inventoryAccounting: plan.inventoryAccounting, dailySettlement: plan.dailySettlement ?? null });
  }
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  return { enabled: true, localDate, policy, candidates: candidates.slice(0, 7), total: candidates.length, hasMore: candidates.length > 7, ambiguousDates,
    alreadyProcessedCount: alreadyProcessed.length, pendingPreviousCount: alreadyProcessed.filter(p => p.accounting === 'pending_reconciliation').length };
}
