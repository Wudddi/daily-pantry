export type SupplementCheckPayload = { date: string; doseId: string; checked: boolean; expectedRevision: number };
export type SupplementCheckReceipt = { ok: boolean; revision: number };
export type SupplementCheckQueueState = { checked: Record<string, boolean>; pendingDoseIds: string[]; pendingCount: number; failedDoseIds: string[]; blocked: boolean; error: string; revision: number };
export function createSupplementCheckQueue(options: { date: string; revision: number; confirmed: Record<string, boolean>; send: (payload: SupplementCheckPayload) => Promise<SupplementCheckReceipt>; onChange?: (state: SupplementCheckQueueState) => void }): {
  snapshot(): SupplementCheckQueueState;
  set(doseId: string, checked: boolean): boolean;
  sync(revision: number, confirmed: Record<string, boolean>): void;
  retry(): void;
  dispose(): void;
};
