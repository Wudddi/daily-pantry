export function dailyMenuSettlementCandidates(state: unknown, now?: string): { enabled: boolean; localDate: string; policy: import('./daily-menu-policy.mjs').DailyMenuSettlementPolicy | null; candidates: { date: string; planId: string; inventoryAccounting?: string; dailySettlement: unknown }[]; total: number; hasMore: boolean; ambiguousDates: string[];
  /** Present while enabled; processed old dates are not returned as new candidates. */
  alreadyProcessedCount?: number; pendingPreviousCount?: number };
