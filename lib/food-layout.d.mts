import type { DietPlan, Meal } from './diet-types';
export type FoodLayoutMove = { sourceMealId: string; sourceKind: 'planned' | 'actual'; sourceId: string; targetMealId: string };
export type FoodLayoutChange = FoodLayoutMove & { previousTargetMealId: string };
export type FoodLayoutHistory = { at: string; moves: FoodLayoutChange[] };
export function foodLayoutTarget(plan: DietPlan, sourceMeal: string | Pick<Meal, 'id'>, sourceKind: 'planned' | 'actual', sourceId: string): string;
export function foodLayoutFingerprint(plan: DietPlan): string;
export function applyFoodLayoutMoves(plan: DietPlan, moves: readonly FoodLayoutMove[], at: string, expectedFingerprint?: string): {
  plan: DietPlan; changed: boolean; moves: FoodLayoutChange[];
};
