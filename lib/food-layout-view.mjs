import { foodLayoutTarget } from './food-layout.mjs';
import { mealNutritionView } from './meal-nutrition-view.mjs';
import { groupMealRecipeRows } from './meal-recipe-groups-view.mjs';
import { nutritionTotalsFromLines, planNutritionLines } from './diet-nutrition.mjs';

const rows = value => Array.isArray(value) ? value : [];
const fields = ['rows', 'plannedRows', 'actualRows', 'remainingRows'];
const sectionFields = ['sections', 'plannedSections', 'actualSections', 'remainingSections'];

/** Read-only arrangement of existing food contributions. The canonical menu,
 * actual reports, snapshots and daily calculation are never edited or rebuilt.
 * Actual evidence sections are comparisons, never another nutrition formula. */
export function foodLayoutView(plan) {
  const meals = rows(plan?.meals), active = rows(plan?.foodLayoutOverrides).length > 0;
  const original = meals.map(meal => ({ mealId: meal.id, nutrition: mealNutritionView(meal, { planId:plan.id, planStatus:plan.status }) }));
  if (!active) return { active:false, meals:original.map((entry,index) => ({ ...entry,
    ...Object.fromEntries(fields.map((field,i) => [sectionFields[i],groupMealRecipeRows(meals[index],entry.nutrition[field],{planId:plan.id})])) })), issues:[] };
  const issues = [], issueKeys = new Set(), byId = new Map();
  const projected = original.map(entry => {
    const value = { mealId:entry.mealId, nutrition:{ ...entry.nutrition,
      basisLabel:'Food arranged here',
      note:'Meal arrangement only. Original intake records and daily nutrition are unchanged.',
      rows:[],plannedRows:[],actualRows:[],remainingRows:[] },
      sections:[],plannedSections:[],actualSections:[],remainingSections:[], lines:[] };
    byId.set(entry.mealId,value); return value;
  });
  const addIssue = (sourceMealId, sourceId) => {
    const key = JSON.stringify([sourceMealId,sourceId]);
    if (issueKeys.has(key)) return;
    issueKeys.add(key); issues.push({ code:'FOOD_LAYOUT_AGGREGATE_TARGET_CONFLICT',mealId:sourceMealId,lineId:sourceId,
      message:'Combined nutrition contributors have different meal arrangements. Their shared contribution stays in its original meal; individual reported records remain visible in their arranged meals.' });
  };
  original.forEach((entry,index) => {
    const sourceMeal = meals[index], sourceMealId = sourceMeal.id;
    const effective = planNutritionLines({ ...plan,meals:[sourceMeal],supplementDoses:[] });
    fields.forEach((field,fieldIndex) => {
      const targets = new Map(), copies = new Map();
      for (const row of entry.nutrition[field]) {
        const sourceKind = row.origin === 'reported' ? 'actual' : 'planned';
        const ids = sourceKind === 'actual' ? row.actualEntryIds ?? [row.id] : [row.id];
        const destinations = new Set(ids.map(id => foodLayoutTarget(plan,sourceMealId,sourceKind,id)));
        let targetMealId = destinations.size === 1 ? [...destinations][0] : sourceMealId;
        if (destinations.size !== 1 && field === 'rows') addIssue(sourceMealId,row.id);
        if (!byId.has(targetMealId)) targetMealId = sourceMealId;
        const copy = { ...row,sourceMealId,sourceKind };
        targets.set(row,targetMealId); copies.set(row,copy);
        byId.get(targetMealId).nutrition[field].push(copy);
      }
      for (const section of groupMealRecipeRows(sourceMeal,entry.nutrition[field],{planId:plan.id})) {
        const destinations = new Map();
        for (const row of section.rows) {
          const target = targets.get(row), list = destinations.get(target) ?? [];
          list.push(row); destinations.set(target,list);
        }
        for (const [targetMealId,members] of destinations) {
          const partialRecipe = section.kind === 'recipe' && members.length !== section.rows.length;
          const slice = { ...section,id:'layout:'+JSON.stringify([sourceMealId,section.id]),sourceMealId,
            rows:members.map(row => copies.get(row)),
            ...(partialRecipe ? {partialRecipe:true} : {}) };
          if (partialRecipe) delete slice.portion;
          byId.get(targetMealId)[sectionFields[fieldIndex]].push(slice);
        }
      }
      if (field === 'rows') entry.nutrition.rows.forEach((row,rowIndex) => {
        // Both arrays come directly from the same canonical algorithm, in the
        // same order. Moving this original line changes only its display bucket.
        if (effective[rowIndex]) byId.get(targets.get(row)).lines.push(effective[rowIndex]);
      });
    });
  });
  return { active:true,meals:projected.map(({lines,...entry}) => {
    const totals = nutritionTotalsFromLines(lines,'food_layout');
    return { ...entry,nutrition:{ ...entry.nutrition,totals,
      partial:totals.some(total => total.partial),estimated:totals.some(total => total.estimated) } };
  }),issues };
}
