"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ChevronDown, Clock3, X } from 'lucide-react';
import type { DietPlan, Meal } from '@/lib/diet-types';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import { mealNutritionView } from '@/lib/meal-nutrition-view.mjs';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import { groupMealRecipeRows } from '@/lib/meal-recipe-groups-view.mjs';
import './meal-overview.css';

const slots = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", other: "Other" };
function format(value: number, key = '') {
  if (key && value > 0 && value < (key === 'kcal' ? 1 : .1)) return key === 'kcal' ? '<1' : '<0.1';
  return new Intl.NumberFormat('en-CA', { maximumFractionDigits: !key ? 6 : key === 'kcal' ? 0 : 1 }).format(value);
}
const portionText = (value?: number) => value === undefined ? '' : value === .5 ? "Half portion" : value === 1 ? "Whole portion" : format(value) + ' portions';
function Metric({ total, label, energy = false }: { total?: PlanNutritionTotal; label: string; energy?: boolean }) {
  const incomplete = !total || total.value === null || total.partial;
  return <div className={'overview-metric' + (energy ? ' overview-energy' : '')}>
    <dt>{label}</dt><dd>{incomplete ? "Incomplete" : (total.estimated ? '≈ ' : '') + format(total.value!, total.key)}{!incomplete && <small>{energy ? ' kcal' : ' g'}</small>}</dd>
    {incomplete && total?.value !== null && total?.value !== undefined && <span>Known: {total.estimated ? '≈ ' : ''}{format(total.value, total.key)}{energy ? ' kcal' : ' g'}</span>}
  </div>;
}

export type MealOverviewCardProps = { meal: Meal; planStatus: DietPlan['status']; planId?: string; expanded?: boolean; targetId: string; triggerId: string; onSelect: () => void; onAddFood?: (mealId: string) => void; onAdjustRecipe?: (mealId: string, groupId: string) => void; busy?: boolean };
export function MealOverviewCard({ meal, planStatus, planId, expanded = false, targetId, triggerId, onSelect, onAddFood, onAdjustRecipe, busy = false }: MealOverviewCardProps) {
  const view = mealNutritionView(meal, { planStatus, planId });
  const unreported = view.issues.some(issue => issue.code === 'COMPLETED_CONTENT_UNREPORTED');
  const actualOnly = view.mode === 'actual' && !unreported;
  const foodRows = view.rows.filter(row => !row.zero);
  const sections=groupMealRecipeRows(meal,foodRows,{planId}),hasRecipes=sections.some(section=>section.kind==='recipe');
  const overviewSections=hasRecipes?[...sections.filter(section=>section.kind==='recipe'),...sections.filter(section=>section.kind==='food')]:sections;
  const title = actualOnly || view.mode === 'partial'
    ? view.rows.filter(row => !row.zero).map(row => row.name).join(' ＋ ') || (actualOnly ? "No reported foods" : "Food details incomplete")
    : meal.title;
  const badge = planStatus === 'cancelled' || meal.state === 'cancelled' ? "Cancelled" : unreported ? "Actual foods unreported" : actualOnly ? "Completed · reported intake" : view.mode === 'partial' ? "Partially reported" : "Current menu";
  return <article className={'meal-overview-card panel' + (expanded ? ' is-selected' : '')} aria-label={slots[meal.slot] + " overview"}>
    <div className="meal-overview-card-heading"><strong>{slots[meal.slot]}</strong><span className={'diet-badge ' + meal.state}>{badge}</span></div>
    <p className="meal-overview-time"><Clock3 size={13}/>{actualOnly ? "Actual: " + (meal.actualTime || meal.actualTimeText || "Time unreported") : "Planned: " + (meal.plannedTime || meal.plannedTimeText || "Flexible time")}</p>
    {hasRecipes?<div className="meal-overview-dishes" aria-label={slots[meal.slot]+" dishes and individual foods"}><ul>{overviewSections.map(section=>section.kind==='recipe'?<li className="meal-overview-recipe" key={'recipe:'+section.id}><details><summary><h3 title={section.name}>{section.name}</h3><span>{portionText(meal.recipeGroups?.find(group => group.id === section.id)?.portion) ? portionText(meal.recipeGroups?.find(group => group.id === section.id)?.portion) + " · " : ""}{section.rows.length} ingredients<ChevronDown size={14}/></span></summary><ul aria-label={section.name+" recipe ingredients"}>{section.rows.map(row=><li key={row.origin+':'+row.id}><span>{row.name}</span><strong>{foodDisplayAmount(row).text}</strong></li>)}</ul></details></li>:<li className="meal-overview-single" key={section.id}><span>{section.rows[0].name}</span><strong>{foodDisplayAmount(section.rows[0]).text}</strong></li>)}</ul></div>:<>
      <h3 title={title}>{title}</h3>
      <details className="meal-overview-foods"><summary>Ingredients and amounts · {foodRows.length} items<ChevronDown size={14}/></summary><ul>{foodRows.map(row => <li key={row.origin + ':' + row.id}><span>{row.name}</span><strong>{foodDisplayAmount(row).text}</strong></li>)}</ul></details>
    </>}
    <dl className="meal-overview-metrics" aria-label={slots[meal.slot] + " nutrition total"}>
      <Metric label="Calories" energy total={view.totals.find(total => total.key === 'kcal')}/>
      <div className="meal-overview-macros"><Metric label="Protein" total={view.totals.find(total => total.key === 'protein')}/><Metric label="Carbs" total={view.totals.find(total => total.key === 'carbs')}/><Metric label="Fat" total={view.totals.find(total => total.key === 'fat')}/></div>
    </dl>
    <button className="meal-overview-open" id={triggerId} aria-expanded={expanded} aria-controls={targetId} onClick={onSelect}>{expanded ? "Viewing" : "View " + slots[meal.slot] + " details"}<ArrowDown size={15}/></button>
    {(onAddFood || onAdjustRecipe && meal.recipeGroups?.length) && <div className="meal-overview-actions">
      {onAdjustRecipe && meal.recipeGroups?.map(group => <button type="button" key={group.id} disabled={busy || ['cancelled', 'closed_with_actuals'].includes(planStatus) || meal.state === 'cancelled'} onClick={() => onAdjustRecipe(meal.id, group.id)} aria-label={"Adjust " + slots[meal.slot] + " · " + group.name + " portions and meal allocation"}>{group.name} · Adjust portion</button>)}
      {onAddFood && <button type="button" disabled={busy || ['cancelled', 'closed_with_actuals'].includes(planStatus) || meal.state === 'cancelled'} onClick={() => onAddFood(meal.id)} aria-label={"Add inventory food to " + slots[meal.slot]}>＋ Add from inventory</button>}
    </div>}
  </article>;
}

export default function MealOverview({ meals, planStatus, planId, renderDetail, onAddFood, onAdjustRecipe, busy }: { meals: Meal[]; planStatus: DietPlan['status']; planId?: string; renderDetail: (meal: Meal) => ReactNode; onAddFood?: (mealId: string) => void; onAdjustRecipe?: (mealId: string, groupId: string) => void; busy?: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const prefix = useId(), detailRef = useRef<HTMLDivElement>(null);
  const selected = meals.find(meal => meal.id === selectedId) ?? null;
  const targetId = prefix + '-detail';
  useEffect(() => { if (selectedId) detailRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [selectedId]);
  return <section className="meal-overview" aria-label="Daily meal overview">
    <div className="meal-overview-heading"><h2>What to eat today</h2><p>See each meal at a glance. Expand portions and nutrition as needed; edit the current menu when plans change.</p></div>
    <div className="meal-overview-grid">{meals.map((meal, index) => <MealOverviewCard key={meal.id} meal={meal} planStatus={planStatus} planId={planId} targetId={targetId} triggerId={prefix + '-meal-' + index} expanded={selected?.id === meal.id} onSelect={() => setSelectedId(meal.id)} onAddFood={onAddFood} onAdjustRecipe={onAdjustRecipe} busy={busy}/>)}</div>
    <div id={targetId} ref={detailRef} className="meal-overview-detail" hidden={!selected}>
      {selected && <>
        <div className="meal-detail-navigation"><div role="group" aria-label="Choose meal details">{meals.map(meal => <button key={meal.id} aria-pressed={selected.id === meal.id} onClick={() => setSelectedId(meal.id)}>{slots[meal.slot]}</button>)}</div><button className="meal-detail-close" onClick={() => { const index = meals.findIndex(meal => meal.id === selected.id); setSelectedId(null); document.getElementById(prefix + '-meal-' + index)?.focus(); }}><X size={15}/>Hide details</button></div>
        <div className="diet-meals diet-meals-detailed" role="region" aria-label={slots[selected.slot] + " meal details"}>{renderDetail(selected)}</div>
      </>}
    </div>
  </section>;
}
