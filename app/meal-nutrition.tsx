import { uiText, uiLocale, getUiLanguage } from '@/lib/ui-language.mjs';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import type { MealNutritionRow } from '@/lib/meal-nutrition-view.mjs';
import type { Meal } from '@/lib/diet-types';
import { groupMealRecipeRows } from '@/lib/meal-recipe-groups-view.mjs';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import './meal-nutrition.css';

type NutrientKey = PlanNutritionTotal['key'];
const keys = ['kcal', 'protein', 'carbs', 'fat'] as const;
const labels = { kcal: uiText("Calories"), protein: uiText("Protein"), carbs: uiText("Carbs"), fat: uiText("Fat") };
const sourceLabels: Record<string, string> = { label: uiText("Nutrition label"), recipe: uiText("Recipe calculation"), estimate: uiText("Estimate"), unknown: uiText("Not provided") };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function valueText(value: number) {
  return value > 0 && value < .1 ? '<0.1' : new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 1 }).format(value);
}
function findTotal(totals: readonly PlanNutritionTotal[], key: NutrientKey) { return totals.find(total => total.key === key); }

function NutrientMetric({ nutrient, total, prominent = false }: { nutrient: NutrientKey; total?: PlanNutritionTotal; prominent?: boolean }) {
  const known = finite(total?.value), incomplete = !known || total?.partial === true;
  const unit = nutrient === 'kcal' ? 'kcal' : 'g';
  return <div className={'meal-metric' + (prominent ? ' is-energy' : '') + (incomplete ? ' is-incomplete' : '')}>
    <dt className="meal-metric-label">{labels[nutrient]}</dt>
    <dd className="meal-metric-data"><div className="meal-metric-value">{incomplete ? <span>{uiText("Incomplete")}</span> : <><span>{total?.estimated ? '≈ ' : ''}{valueText(total!.value!)}</span><small>{unit}</small></>}</div>
      {incomplete && known && <p className="meal-metric-known">{uiText("Known portion: ")}{total?.estimated ? '≈ ' : ''}{valueText(total!.value!)} {unit}</p>}
    </dd>
  </div>;
}

export type MealNutritionSummaryProps = { totals: readonly PlanNutritionTotal[]; basisLabel?: string; note?: string };
export function MealNutritionSummary({ totals, basisLabel = uiText("Meal nutrition"), note }: MealNutritionSummaryProps) {
  return <section className="meal-nutrition-summary" aria-label={uiText(basisLabel)}>
    <div className="meal-nutrition-summary-heading"><span>{uiText(basisLabel)}</span></div>
    <div className="meal-summary-grid"><dl className="meal-summary-energy"><NutrientMetric nutrient="kcal" total={findTotal(totals, 'kcal')} prominent/></dl><dl className="meal-summary-macros">{keys.slice(1).map(key => <NutrientMetric key={key} nutrient={key} total={findTotal(totals, key)}/>)}</dl></div>
    {note && <p className="meal-nutrition-note">{uiText(note)}</p>}
  </section>;
}

export type FoodNutritionListProps = { rows: readonly MealNutritionRow[]; meal?: Meal; planId?: string; ariaLabel?: string; emptyText?: string };
export function FoodNutritionList({ rows, meal, planId, ariaLabel = uiText("Food portions and nutrition details"), emptyText = uiText("No food details provided.") }: FoodNutritionListProps) {
  const withSources = rows.filter(row => row.sourceText || row.sourceNote || keys.some(key => row.nutrientSources?.[key] && row.nutrientSources[key] !== 'unknown'));
  if (!rows.length) return <p className="meal-nutrition-empty">{emptyText}</p>;
  const sections = groupMealRecipeRows(meal, rows, { planId });
  const foodRow = (row: MealNutritionRow) => <li key={row.origin + ':' + row.id} className={'meal-food-row' + (row.zero && row.origin === 'reported' ? ' is-uneaten' : '')}>
    <div className="meal-food-identity"><div className="meal-food-heading"><h4>{row.name || uiText("Unnamed food")}</h4><p className="meal-food-quantity">{row.zero && row.origin === 'reported' && <span>{uiText("Not eaten · ")}</span>}{foodDisplayAmount(row).text}</p></div>
      {row.remainingNote ? <p className="meal-food-note">{uiText(row.remainingNote)}</p> : row.quantityUnknown ? <p className="meal-food-note">{uiText("Amount unreported; complete nutrition cannot be calculated.")}</p> : row.conversionMissing ? <p className="meal-food-note">{uiText("The portion cannot be converted to the nutrition basis. Review required.")}</p> : null}
    </div>
    <dl className="meal-food-metrics">{keys.map(key => <NutrientMetric key={key} nutrient={key} total={findTotal(row.totals, key)} prominent={key === 'kcal'}/>)}</dl>
  </li>;
  return <section className="meal-food-nutrition" aria-label={ariaLabel}>
    <div className="meal-food-table-head" aria-hidden="true"><span>{uiText("Food and amounts")}</span><div>{keys.map(key => <span key={key}>{labels[key]} <small>{key === 'kcal' ? 'kcal' : 'g'}</small></span>)}</div></div>
    <ul className="meal-food-list">{sections.flatMap(section => section.kind === 'recipe' ? [<li key={'recipe:' + section.id} className="meal-food-recipe"><details><summary><strong>{section.name}</strong><span>{section.rows.length}{uiText(" ingredients")}</span></summary><ul className="meal-food-list">{section.rows.map(foodRow)}</ul></details></li>] : section.rows.map(foodRow))}</ul>
    <p className="meal-food-legend">{uiText("Calculated from each current amount · ≈ indicates an estimate")}</p>
    {withSources.length > 0 && <details className="meal-food-sources"><summary>{uiText("View nutrition sources")}</summary>{withSources.map(row => <div key={row.origin + ':' + row.id}><strong>{row.name}</strong><p>{keys.map(key => labels[key] + ": " + (sourceLabels[row.nutrientSources?.[key] ?? 'unknown'] ?? uiText("Saved nutrition sources"))).join(" · ")}</p>{row.sourceNote && <p className="meal-source-original">{row.sourceNote}</p>}{row.sourceText && <p className="meal-source-original">{row.sourceText}</p>}</div>)}</details>}
  </section>;
}

export default MealNutritionSummary;
