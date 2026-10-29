import type { dailyFoodRollup, DailyFoodAllocation, DailyFoodRollupRow } from '@/lib/daily-food-rollup.mjs';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import './daily-food-overview.css';

type Summary = ReturnType<typeof dailyFoodRollup>;
type Nutrient = PlanNutritionTotal['key'];
const keys = ['kcal', 'protein', 'carbs', 'fat'] as const;
const labels = { kcal: '热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' };
const slots = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐', other: '其他' };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const quantityText = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);
const unitText = (unit: string) => unit === 'ml' ? 'mL' : unit;
function nutrientText(value: number, key: Nutrient) {
  const minimum = key === 'kcal' ? 1 : .1;
  return value > 0 && value < minimum ? '<' + minimum : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: key === 'kcal' ? 0 : 1 }).format(value);
}

function NutrientValue({ nutrient, totals, supplement = false }: { nutrient: Nutrient; totals: readonly PlanNutritionTotal[]; supplement?: boolean }) {
  const total = totals.find(value => value.key === nutrient);
  const known = finite(total?.value), missing = !known || total?.partial === true || supplement && total?.supplementPartial === true;
  const unit = nutrient === 'kcal' ? 'kcal' : 'g';
  const value = known ? (total?.estimated ? '≈ ' : '') + nutrientText(total!.value!, nutrient) : '';
  return <div className={'daily-rollup-metric' + (missing ? ' is-incomplete' : '')}>
    <dt>{labels[nutrient]}</dt><dd>{missing ? <><span>待补齐</span>{known && <small className="daily-rollup-known">已知 {value} {unit}</small>}</> : <><span>{value}</span><small>{unit}</small></>}</dd>
  </div>;
}

function Quantity({ quantity, knownQuantity, unit, unknown, uneaten = false }: { quantity: number | null; knownQuantity: number; unit: string; unknown: boolean; uneaten?: boolean }) {
  if (unknown || !finite(quantity)) return <><span>总量待补</span>{knownQuantity > 0 && <small className="daily-rollup-known">已知 {quantityText(knownQuantity)} {unitText(unit)}</small>}</>;
  return <>{uneaten && <small className="daily-rollup-uneaten">未吃 · </small>}{quantityText(quantity)} <small>{unitText(unit)}</small></>;
}

function Allocation({ value }: { value: DailyFoodAllocation }) {
  const amount = value.quantityUnknown || !finite(value.quantity)
    ? value.knownQuantity > 0 ? '已知 ' + quantityText(value.knownQuantity) + ' ' + unitText(value.unit) + '，待补' : '用量未报'
    : quantityText(value.quantity) + ' ' + unitText(value.unit);
  return <li title={value.mealTitle}><span>{slots[value.mealSlot] ?? '其他'}</span><strong>{amount}</strong>{value.origin === 'reported' && <em>实际</em>}</li>;
}

function FoodRow({ row }: { row: DailyFoodRollupRow }) {
  const uneaten = row.quantity === 0 && row.allocations.length > 0 && row.allocations.every(value => value.origin === 'reported');
  return <li className={'daily-rollup-row' + (uneaten ? ' is-uneaten' : '')}>
    <div className="daily-rollup-identity"><h3>{row.name || '未命名食物'}</h3><ul className="daily-rollup-allocations" aria-label={row.name + '的各餐分配'}>{row.allocations.map(value => <Allocation key={value.mealId} value={value}/>)}</ul>{row.nutritionBasisVaries && <p className="daily-rollup-basis-note">各餐营养依据不同，已分别计算后相加。</p>}</div>
    <div className="daily-rollup-quantity" aria-label={row.name + '的全天总用量'}><span className="daily-rollup-mobile-label">全天总量</span><strong><Quantity quantity={row.displayQuantity} knownQuantity={row.knownQuantity} unit={row.displayUnit} unknown={row.quantityUnknown} uneaten={uneaten}/></strong></div>
    <dl className="daily-rollup-metrics" aria-label={row.name + '的全天营养'}>{keys.map(key => <NutrientValue key={key} nutrient={key} totals={row.totals}/>)}</dl>
  </li>;
}

function TotalRow({ title, totals, supplement = false, prominent = false }: { title: string; totals: readonly PlanNutritionTotal[]; supplement?: boolean; prominent?: boolean }) {
  return <div className={'daily-rollup-total' + (prominent ? ' is-grand-total' : '')}><strong>{title}</strong><dl className="daily-rollup-metrics" aria-label={title}>{keys.map(key => <NutrientValue key={key} nutrient={key} totals={totals} supplement={supplement}/>)}</dl></div>;
}

export default function DailyFoodOverview({ summary }: { summary: Summary }) {
  return <section className="panel daily-food-overview" id="daily-food-details" tabIndex={-1} aria-labelledby="daily-food-title">
    <header className="daily-food-heading"><div><span className="daily-food-eyebrow">按全天总量备餐</span><h2 id="daily-food-title">全天明细</h2><p>同一食材合并总量，各餐分配一并保留。</p></div><span className="daily-food-count">{summary.rows.length} 项食材</span></header>
    {summary.rows.length ? <>
      <div className="daily-rollup-table-heading" aria-hidden="true"><span>食物 / 各餐分配</span><span>全天总量</span><div>{keys.map(key => <span key={key}>{labels[key]}<small>{key === 'kcal' ? 'kcal' : 'g'}</small></span>)}</div></div>
      <ul className="daily-rollup-list" aria-label="全天食物总用量与营养">{summary.rows.map(row => <FoodRow key={row.id} row={row}/>)}</ul>
    </> : <p className="daily-food-empty">这一天还没有可汇总的食物明细。</p>}
    <div className="daily-rollup-totals"><TotalRow title="食物小计" totals={summary.foodTotals}/><TotalRow title="补给营养" totals={summary.supplementTotals} supplement/><TotalRow title="全天合计" totals={summary.totals} prominent/></div>
    <p className="daily-food-note">已完成餐按实际，其余按当前菜单；这张表不代表全部已吃。≈ 表示估算。{summary.supplementPartial && '补给仍有营养未提供，全天合计含补给的已知部分。'}</p>
    {summary.issues.length > 0 && <details className="daily-food-issues"><summary>查看汇总依据与待补资料</summary>{summary.issues.map((issue, index) => <p key={issue.code + ':' + index}>{issue.message}</p>)}</details>}
  </section>;
}
