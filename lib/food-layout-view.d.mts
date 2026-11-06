import type { DietPlan } from './diet-types';
import type { MealNutritionView, MealNutritionRow } from './meal-nutrition-view.mjs';
import type { MealRecipeSection } from './meal-recipe-groups-view.mjs';
export type FoodLayoutRow = MealNutritionRow & { sourceMealId?:string; sourceKind?:'planned'|'actual' };
export type FoodLayoutSection = MealRecipeSection<FoodLayoutRow> & { sourceMealId?:string; partialRecipe?:boolean };
export type FoodLayoutMeal = {
  mealId:string;
  nutrition:Omit<MealNutritionView,'rows'|'plannedRows'|'actualRows'|'remainingRows'> & {
    rows:FoodLayoutRow[]; plannedRows:FoodLayoutRow[]; actualRows:FoodLayoutRow[]; remainingRows:FoodLayoutRow[];
  };
  sections:FoodLayoutSection[]; plannedSections:FoodLayoutSection[]; actualSections:FoodLayoutSection[]; remainingSections:FoodLayoutSection[];
};
export type FoodLayoutView = {active:boolean;meals:FoodLayoutMeal[];issues:{code:string;mealId:string;lineId:string;message:string}[]};
export function foodLayoutView(plan:DietPlan):FoodLayoutView;
