export type DailyMenuSettlementPolicy = { version: 1; enabled: boolean; timeZone: 'America/Toronto'; startsOn: string; updatedAt: string; sourceText: string };
export function readDailyMenuSettlementPolicy(state: { dailyMenuSettlementPolicy?: DailyMenuSettlementPolicy }): DailyMenuSettlementPolicy | null;
export function normalizeDailyMenuSettlementPolicy(payload: unknown, previous: DailyMenuSettlementPolicy | null, at: string): DailyMenuSettlementPolicy;
