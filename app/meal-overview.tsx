"use client";
import { uiText, uiLocale, getUiLanguage } from '@/lib/ui-language.mjs';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ChevronDown, Clock3, X } from 'lucide-react';
import type { DietPlan, Meal } from '@/lib/diet-types';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import type { FoodLayoutMeal, FoodLayoutView } from '@/lib/food-layout-view.mjs';
import { mealNutritionView } from '@/lib/meal-nutrition-view.mjs';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import { groupMealRecipeRows, recipeIngredientDisplayName } from '@/lib/meal-recipe-groups-view.mjs';
import './meal-overview.css';

const slots = { breakfast: uiText("Breakfast"), lunch: uiText("Lunch"), dinner: uiText("Dinner"), snack: uiText("Snack"), other: uiText("Other") };
function format(value: number, key = '') {
  if (key && value > 0 && value < (key === 'kcal' ? 1 : .1)) return key === 'kcal' ? '<1' : '<0.1';
  return new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: !key ? 6 : key === 'kcal' ? 0 : 1 }).format(value);
}
const portionText = (value?: number) => value === undefined ? '' : value === .5 ? uiText("Half portion") : value === 1 ? uiText("Whole portion") : format(value) + uiText(" portions");
function Metric({ total, label, energy = false }: { total?: PlanNutritionTotal; label: string; energy?: boolean }) {
  const incomplete = !total || total.value === null || total.partial;
  return <div className={'overview-metric' + (energy ? ' overview-energy' : '')}>
    <dt>{label}</dt><dd>{incomplete ? uiText("Incomplete") : (total.estimated ? '≈ ' : '') + format(total.value!, total.key)}{!incomplete && <small>{energy ? uiText(" kcal") : ' g'}</small>}</dd>
    {incomplete && total?.value !== null && total?.value !== undefined && <span>{uiText("Known: ")}{total.estimated ? '≈ ' : ''}{format(total.value, total.key)}{energy ? uiText(" kcal") : ' g'}</span>}
  </div>;
}

export type MealOverviewCardProps = { meal: Meal; planStatus: DietPlan['status']; planId?: string; layout?:FoodLayoutMeal; expanded?: boolean; targetId: string; triggerId: string; onSelect: () => void; onAddFood?: (mealId: string) => void; onAdjustRecipe?: (mealId: string, groupId: string) => void; busy?: boolean };
export function MealOverviewCard({ meal, planStatus, planId, layout, expanded = false, targetId, triggerId, onSelect, onAddFood, onAdjustRecipe, busy = false }: MealOverviewCardProps) {
  const view = layout?.nutrition ?? mealNutritionView(meal, { planStatus, planId });
  const unreported = view.issues.some(issue => issue.code === 'COMPLETED_CONTENT_UNREPORTED');
  const actualOnly = !layout && view.mode === 'actual' && !unreported;
  const foodRows = view.rows.filter(row => !row.zero);
  const sections=layout ? layout.sections.map(section => ({...section,rows:section.rows.filter(row => !row.zero)})).filter(section => section.rows.length) : groupMealRecipeRows(meal,foodRows,{planId});
  const hasRecipes=sections.some(section=>section.kind==='recipe');
  const overviewSections=hasRecipes?[...sections.filter(section=>section.kind==='recipe'),...sections.filter(section=>section.kind==='food')]:sections;
  const adjustableRecipes = overviewSections.filter(section => section.kind === 'recipe' && section.source === 'planned' && !('partialRecipe' in section && section.partialRecipe) && section.rows.some(row => row.origin !== 'reported'));
  const title = layout ? foodRows.map(row => row.name).join(' ＋ ') || uiText("No foods arranged here") : actualOnly || view.mode === 'partial'
    ? view.rows.filter(row => !row.zero).map(row => row.name).join(' ＋ ') || (actualOnly ? uiText("No reported foods") : uiText("Food details incomplete"))
    : meal.title;
  const badge = layout ? uiText("Meal arrangement") : planStatus === 'cancelled' || meal.state === 'cancelled' ? uiText("Cancelled") : unreported ? uiText("Actual foods unreported") : actualOnly ? uiText("Completed · reported intake") : view.mode === 'partial' ? uiText("Partially reported") : uiText("Current menu");
  return <article className={'meal-overview-card panel' + (expanded ? ' is-selected' : '')} aria-label={slots[meal.slot] + uiText(" overview")}>
    <div className="meal-overview-card-heading"><strong>{slots[meal.slot]}</strong><span className={'diet-badge ' + meal.state}>{badge}</span></div>
    <p className="meal-overview-time"><Clock3 size={13}/>{actualOnly ? uiText("Actual: ") + (meal.actualTime || meal.actualTimeText || uiText("Time unreported")) : uiText("Planned: ") + (meal.plannedTime || meal.plannedTimeText || uiText("Flexible time"))}</p>
    {hasRecipes?<div className="meal-overview-dishes" aria-label={slots[meal.slot]+uiText(" dishes and individual foods")}><ul>{overviewSections.map(section=>section.kind==='recipe'?<li className="meal-overview-recipe" data-recipe-source={section.source} key={'recipe:'+section.id}><details><summary><h3 title={section.name}>{section.name}</h3><span>{'partialRecipe' in section && section.partialRecipe ? uiText("Part of recipe") + " · " : portionText(section.portion) ? portionText(section.portion) + " · " : ""}{section.rows.length}{uiText(" ingredients")}<ChevronDown size={14}/></span></summary><ul aria-label={section.name+uiText(" recipe ingredients")}>{section.rows.map(row=><li key={(row.sourceMealId ? row.sourceMealId+':' : '')+row.origin+':'+row.id}><span>{recipeIngredientDisplayName(section,row)}</span><strong>{foodDisplayAmount(row).text}</strong></li>)}</ul></details></li>:<li className="meal-overview-single" key={section.id}><span>{section.rows[0].name}</span><strong>{foodDisplayAmount(section.rows[0]).text}</strong></li>)}</ul></div>:<>
      <h3 title={title}>{title}</h3>
      <details className="meal-overview-foods"><summary>{uiText("Ingredients and amounts · ")}{foodRows.length}{uiText(" items")}<ChevronDown size={14}/></summary><ul>{foodRows.map(row => <li key={(row.sourceMealId ? row.sourceMealId + ':' : '') + row.origin + ':' + row.id}><span>{row.name}</span><strong>{foodDisplayAmount(row).text}</strong></li>)}</ul></details>
    </>}
    <dl className="meal-overview-metrics" aria-label={slots[meal.slot] + uiText(" nutrition total")}>
      <Metric label={uiText("Calories")} energy total={view.totals.find(total => total.key === 'kcal')}/>
      <div className="meal-overview-macros"><Metric label={uiText("Protein")} total={view.totals.find(total => total.key === 'protein')}/><Metric label={uiText("Carbs")} total={view.totals.find(total => total.key === 'carbs')}/><Metric label={uiText("Fat")} total={view.totals.find(total => total.key === 'fat')}/></div>
    </dl>
    <button className="meal-overview-open" id={triggerId} aria-expanded={expanded} aria-controls={targetId} onClick={onSelect}>{expanded ? uiText("Viewing") : uiText("View ") + slots[meal.slot] + uiText(" details")}<ArrowDown size={15}/></button>
    {(onAddFood || onAdjustRecipe && adjustableRecipes.length > 0) && <div className="meal-overview-actions">
      {onAdjustRecipe && adjustableRecipes.map(group => <button type="button" key={group.id} disabled={busy || ['cancelled', 'closed_with_actuals'].includes(planStatus) || meal.state === 'cancelled'} onClick={() => onAdjustRecipe('sourceMealId' in group ? group.sourceMealId as string : meal.id, group.groupId ?? group.id)} aria-label={uiText("Adjust ") + slots[meal.slot] + " · " + group.name + uiText(" portions and meal allocation")}>{group.name}{uiText(" · Adjust portion")}</button>)}
      {onAddFood && <button type="button" disabled={busy || ['cancelled', 'closed_with_actuals'].includes(planStatus) || meal.state === 'cancelled'} onClick={() => onAddFood(meal.id)} aria-label={uiText("Add inventory food to ") + slots[meal.slot]}>{uiText("＋ Add from inventory")}</button>}
    </div>}
  </article>;
}

export default function MealOverview({ meals, planStatus, planId, layout, renderDetail, onAddFood, onAdjustRecipe, busy }: { meals: Meal[]; planStatus: DietPlan['status']; planId?: string; layout?:FoodLayoutView; renderDetail: (meal: Meal, layout?:FoodLayoutMeal) => ReactNode; onAddFood?: (mealId: string) => void; onAdjustRecipe?: (mealId: string, groupId: string) => void; busy?: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const prefix = useId(), detailRef = useRef<HTMLDivElement>(null);
  const selected = meals.find(meal => meal.id === selectedId) ?? null;
  const targetId = prefix + '-detail';
  useEffect(() => { if (selectedId) detailRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [selectedId]);
  return <section className="meal-overview" aria-label={uiText("Daily meal overview")}>
    <div className="meal-overview-heading"><h2>{uiText("What to eat today")}</h2><p>{layout?.active ? uiText("Meal arrangement only. Original intake records and daily nutrition are unchanged.") : uiText("See each meal at a glance. Expand portions and nutrition as needed; edit the current menu when plans change.")}</p></div>
    {layout?.issues.map(issue => <p className="diet-light-note" role="status" key={issue.code+':'+issue.mealId+':'+issue.lineId}>{uiText(issue.message)}</p>)}
    <div className="meal-overview-grid">{meals.map((meal, index) => <MealOverviewCard key={meal.id} meal={meal} layout={layout?.active ? layout.meals.find(entry => entry.mealId === meal.id) : undefined} planStatus={planStatus} planId={planId} targetId={targetId} triggerId={prefix + '-meal-' + index} expanded={selected?.id === meal.id} onSelect={() => setSelectedId(meal.id)} onAddFood={onAddFood} onAdjustRecipe={onAdjustRecipe} busy={busy}/>)}</div>
    <div id={targetId} ref={detailRef} className="meal-overview-detail" hidden={!selected}>
      {selected && <>
        <div className="meal-detail-navigation"><div role="group" aria-label={uiText("Choose meal details")}>{meals.map(meal => <button key={meal.id} aria-pressed={selected.id === meal.id} onClick={() => setSelectedId(meal.id)}>{slots[meal.slot]}</button>)}</div><button className="meal-detail-close" onClick={() => { const index = meals.findIndex(meal => meal.id === selected.id); setSelectedId(null); document.getElementById(prefix + '-meal-' + index)?.focus(); }}><X size={15}/>{uiText("Hide details")}</button></div>
        <div className="diet-meals diet-meals-detailed" role="region" aria-label={slots[selected.slot] + uiText(" meal details")}>{renderDetail(selected,layout?.active ? layout.meals.find(entry => entry.mealId === selected.id) : undefined)}</div>
      </>}
    </div>
  </section>;
}
