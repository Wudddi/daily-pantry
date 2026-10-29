import type { BodyMeasurement } from './health-types';

export type WeightMeasurement = {
  id: string; date: string; weightKg: number | null;
  archived?: boolean; updatedAt?: string; createdAt?: string;
};
export type WeightPoint = { id: string; date: string; weightKg: number };
export type WeightStatsWindow = {
  /** Inclusive calendar boundaries. Empty strings only when no date range exists. */
  from: string; to: string; expectedDays: number; coverageDays: number;
  averageKg: number | null; first: WeightPoint | null; last: WeightPoint | null;
  /** Last minus first, unknown with fewer than two distinct measured dates. */
  changeKg: number | null;
  /** Actual elapsed days between first and last observations, not the requested window length. */
  intervalDays: number | null; complete: boolean;
};
export type WeightStatsComparison = {
  current: WeightStatsWindow; previous: WeightStatsWindow;
  /** Current minus previous mean; unknown if either window covers fewer than two days. */
  averageChangeKg: number | null;
};
export type WeightStats<T extends WeightMeasurement = BodyMeasurement> = {
  anchorDate: string | null;
  /** Original selected records, in ascending date order; missing weights have been excluded. */
  points: (T & { weightKg: number })[];
  dayCount: number;
  /** Number of dates with more than one eligible weight, not number of extra rows. */
  duplicateDayCount: number;
  /** Archived, missing or invalid date/ID/weight input rows; duplicates counted separately. */
  ignoredCount: number;
  weeks: WeightStatsComparison; months: WeightStatsComparison;
};
export function weightStats<T extends WeightMeasurement>(measurements: readonly T[] | null | undefined): WeightStats<T>;
