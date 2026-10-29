export type DailyMenuSettlementSummary = {
  source: 'automatic_menu'; basis: 'auto_planned' | 'unknown'; date: string | null;
  accounting: 'settled' | 'pending_reconciliation' | 'unknown';
  attemptedAt: string | null; settledAt: string | null; lastReconciledAt: string | null;
  assumedMealCount: number | null; plannedMealCount: number | null; actualReportsIndependent: true; instructions: string;
};
export function dailyMenuSettlementSummary(plan: { dailySettlement?: unknown }): DailyMenuSettlementSummary | undefined;
