export type BodyPartId = 'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps' | 'legs' | 'abs' | 'other';
export type BodyPartLabel = '胸' | '背' | '肩' | '二头' | '三头' | '腿' | '腹部' | '其他';
export type BodyPart = { readonly id: BodyPartId; readonly label: BodyPartLabel };
export type ExerciseGroup<T> = {
  id: BodyPartId;
  label: BodyPartLabel;
  exercises: { exercise: T; index: number }[];
};
export type MonthDay = { date: string | null; day: number | null };

export const BODY_PARTS: readonly BodyPart[];
export function classifyExercise(name: unknown): BodyPartId;
export function groupExercises<T extends { name?: unknown }>(exercises: readonly T[] | null | undefined): ExerciseGroup<T>[];
export function sessionBodyParts(session: { exercises?: readonly { name?: unknown }[] } | null | undefined): BodyPartLabel[];
/** Returns original session references; every exercise and source field stays intact. */
export function filterSessionsByBodyPart<T extends { exercises?: readonly { name?: unknown }[] }>(sessions: readonly T[] | null | undefined, bodyPart?: BodyPartId | 'all'): T[];
/** Strict YYYY-MM, years 0001 through 9999. Invalid input throws RangeError. */
export function buildMonthDays(month: string): MonthDay[];
/** Safe integer offset; results clamp to 0001-01 or 9999-12 at the boundaries. */
export function shiftMonth(month: string, delta: number): string;
