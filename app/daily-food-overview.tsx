import { unitLabel, storageLabel } from '@/lib/english-display.mjs';
import type { dailyFoodRollup, DailyFoodAllocation, DailyFoodRollupRow } from '@/lib/daily-food-rollup.mjs';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import './daily-food-overview.css';

type Summary = ReturnType<typeof dailyFoodRollup>;
type Nutrient = PlanNutritionTotal['key'];
const keys = ['kcal', 'protein', 'carbs', 'fat'] as const;
const labels = { kcal: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat" };
const slots = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", other: "Other" };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const quantityText = (value: number) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: 6 }).format(value);
const unitText = (unit: string) => unitLabel(unit);
function nutrientText(value: number, key: Nutrient) {
  const minimum = key === 'kcal' ? 1 : .1;
  return value > 0 && value < minimum ? '<' + minimum : new Intl.NumberFormat('en-CA', { maximumFractionDigits: key === 'kcal' ? 0 : 1 }).format(value);
}

function NutrientValue({ nutrient, totals, supplement = false }: { nutrient: Nutrient; totals: readonly PlanNutritionTotal[]; supplement?: boolean }) {
  const total = totals.find(value => value.key === nutrient);
  const known = finite(total?.value), missing = !known || total?.partial === true || supplement && total?.supplementPartial === true;
  const unit = nutrient === 'kcal' ? 'kcal' : 'g';
  const value = known ? (total?.estimated ? '≈ ' : '') + nutrientText(total!.value!, nutrient) : '';
  return <div className={'daily-rollup-metric' + (missing ? ' is-incomplete' : '')}>
    <dt>{labels[nutrient]}</dt><dd>{missing ? <><span>Incomplete</span>{known && <small className="daily-rollup-known">Known: {value} {unit}</small>}</> : <><span>{value}</span><small>{unit}</small></>}</dd>
  </div>;
}

function Quantity({ quantity, knownQuantity, unit, unknown, uneaten = false }: { quantity: number | null; knownQuantity: number; unit: string; unknown: boolean; uneaten?: boolean }) {
  if (unknown || !finite(quantity)) return <><span>Total unknown</span>{knownQuantity > 0 && <small className="daily-rollup-known">Known: {quantityText(knownQuantity)} {unitText(unit)}</small>}</>;
  return <>{uneaten && <small className="daily-rollup-uneaten">Not eaten · </small>}{quantityText(quantity)} <small>{unitText(unit)}</small></>;
}

function Allocation({ value }: { value: DailyFoodAllocation }) {
  const amount = value.quantityUnknown || !finite(value.quantity)
    ? value.knownQuantity > 0 ? "Known: " + quantityText(value.knownQuantity) + ' ' + unitText(value.unit) + ", incomplete" : "Amount unreported"
    : quantityText(value.quantity) + ' ' + unitText(value.unit);
  return <li title={value.mealTitle}><span>{slots[value.mealSlot] ?? "Other"}</span><strong>{amount}</strong>{value.origin === 'reported' && <em>Reported</em>}</li>;
}

function FoodRow({ row }: { row: DailyFoodRollupRow }) {
  const uneaten = row.quantity === 0 && row.allocations.length > 0 && row.allocations.every(value => value.origin === 'reported');
  return <li className={'daily-rollup-row' + (uneaten ? ' is-uneaten' : '')}>
    <div className="daily-rollup-identity"><h3>{row.name || "Unnamed food"}</h3><ul className="daily-rollup-allocations" aria-label={row.name + " meal allocations"}>{row.allocations.map(value => <Allocation key={value.mealId} value={value}/>)}</ul>{row.nutritionBasisVaries && <p className="daily-rollup-basis-note">Nutrition bases differ between meals; each was calculated separately before adding.</p>}</div>
    <div className="daily-rollup-quantity" aria-label={row.name + " daily total amount"}><span className="daily-rollup-mobile-label">Daily total</span><strong><Quantity quantity={row.displayQuantity} knownQuantity={row.knownQuantity} unit={row.displayUnit} unknown={row.quantityUnknown} uneaten={uneaten}/></strong></div>
    <dl className="daily-rollup-metrics" aria-label={row.name + " daily nutrition"}>{keys.map(key => <NutrientValue key={key} nutrient={key} totals={row.totals}/>)}</dl>
  </li>;
}

function TotalRow({ title, totals, supplement = false, prominent = false }: { title: string; totals: readonly PlanNutritionTotal[]; supplement?: boolean; prominent?: boolean }) {
  return <div className={'daily-rollup-total' + (prominent ? ' is-grand-total' : '')}><strong>{title}</strong><dl className="daily-rollup-metrics" aria-label={title}>{keys.map(key => <NutrientValue key={key} nutrient={key} totals={totals} supplement={supplement}/>)}</dl></div>;
}

export default function DailyFoodOverview({ summary }: { summary: Summary }) {
  return <section className="panel daily-food-overview" id="daily-food-details" tabIndex={-1} aria-labelledby="daily-food-title">
    <header className="daily-food-heading"><div><span className="daily-food-eyebrow">Prep from daily totals</span><h2 id="daily-food-title">Daily breakdown</h2><p>Combined ingredient totals with each meal allocation retained.</p></div><span className="daily-food-count">{summary.rows.length} ingredients</span></header>
    {summary.rows.length ? <>
      <div className="daily-rollup-table-heading" aria-hidden="true"><span>Food / meal allocations</span><span>Daily total</span><div>{keys.map(key => <span key={key}>{labels[key]}<small>{key === 'kcal' ? 'kcal' : 'g'}</small></span>)}</div></div>
      <ul className="daily-rollup-list" aria-label="Daily food amounts and nutrition">{summary.rows.map(row => <FoodRow key={row.id} row={row}/>)}</ul>
    </> : <p className="daily-food-empty">No food details are available for this date yet.</p>}
    <div className="daily-rollup-totals"><TotalRow title="Food subtotal" totals={summary.foodTotals}/><TotalRow title="Supplement nutrition" totals={summary.supplementTotals} supplement/><TotalRow title="Daily total" totals={summary.totals} prominent/></div>
    <p className="daily-food-note">Completed meals use reported intake; others use the current menu. This table does not mean everything was eaten. ≈ indicates an estimate.{summary.supplementPartial && " Some supplement nutrition is missing; daily totals include the known portion."}</p>
    {summary.issues.length > 0 && <details className="daily-food-issues"><summary>Summary sources and missing information</summary>{summary.issues.map((issue, index) => <p key={issue.code + ':' + index}>{issue.message}</p>)}</details>}
  </section>;
}
