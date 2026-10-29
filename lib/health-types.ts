export type HealthSource = 'user_note' | 'chat' | 'manual';
export type BodyMeasurement = {
  id: string; date: string; weightKg: number | null; waistCm: number | null; bodyFatPct: number | null;
  condition: string; notes: string; sourceText: string; source: HealthSource;
  archived: boolean; createdAt: string; updatedAt: string;
};
export type TrainingSet = {
  setId?: string;
  weight: number | null; unit: 'kg' | 'lb' | null; reps: number | null;
  kind: 'warmup' | 'working' | 'drop' | 'unknown';
  loadBasis: 'single_hand' | 'total' | 'machine' | 'bodyweight' | 'unknown';
  effortFromRep: number | null; rir: number | null; rpe: number | null;
  notes: string; sourceText: string;
};
export type TrainingExercise = { name: string; equipment: string; notes: string; sets: TrainingSet[] };
export type TrainingSession = {
  id: string; date: string; title: string; status: 'completed' | 'planned'; durationMinutes: number | null;
  notes: string; sourceText: string; source: HealthSource; exercises: TrainingExercise[];
  archived: boolean; createdAt: string; updatedAt: string;
};
export type HealthEvent = { id: string; at: string; action: string; recordId: string; detail: string; previous?: unknown };
export type HealthState = {
  schemaVersion: 1; revision: number; updatedAt: string;
  measurements: BodyMeasurement[]; sessions: TrainingSession[]; events: HealthEvent[]; operationIds?: string[];
};
export type WeightWindow = { from: string; to: string; count: number; averageKg: number | null };
export type HealthSummary = {
  measurementCount: number; weightCount: number; first: BodyMeasurement | null; latest: BodyMeasurement | null;
  lowest: BodyMeasurement | null; changeKg: number | null;
  latest7Days: WeightWindow; previous7Days: WeightWindow; averageChangeKg: number | null;
  gaps: { from: string; to: string; days: number }[];
  completedSessionCount: number; plannedSessionCount: number;
};
export type HealthResponse = { state: HealthState; summary: HealthSummary; error?: string; code?: string };
