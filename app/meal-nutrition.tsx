import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import type { MealNutritionRow } from '@/lib/meal-nutrition-view.mjs';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import './meal-nutrition.css';

type NutrientKey = PlanNutritionTotal['key'];
const keys = ['kcal', 'protein', 'carbs', 'fat'] as const;
const labels = { kcal: '热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' };
const sourceLabels: Record<string, string> = { label: '营养标签', recipe: '配方计算', estimate: '估算', unknown: '未提供' };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function valueText(value: number) {
  return value > 0 && value < .1 ? '<0.1' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}
function findTotal(totals: readonly PlanNutritionTotal[], key: NutrientKey) { return totals.find(total => total.key === key); }

function NutrientMetric({ nutrient, total, prominent = false }: { nutrient: NutrientKey; total?: PlanNutritionTotal; prominent?: boolean }) {
  const known = finite(total?.value), incomplete = !known || total?.partial === true;
  const unit = nutrient === 'kcal' ? 'kcal' : 'g';
  return <div className={'meal-metric' + (prominent ? ' is-energy' : '') + (incomplete ? ' is-incomplete' : '')}>
    <dt className="meal-metric-label">{labels[nutrient]}</dt>
    <dd className="meal-metric-data"><div className="meal-metric-value">{incomplete ? <span>待补齐</span> : <><span>{total?.estimated ? '≈ ' : ''}{valueText(total!.value!)}</span><small>{unit}</small></>}</div>
      {incomplete && known && <p className="meal-metric-known">已知部分 {total?.estimated ? '≈ ' : ''}{valueText(total!.value!)} {unit}</p>}
    </dd>
  </div>;
}

export type MealNutritionSummaryProps = { totals: readonly PlanNutritionTotal[]; basisLabel?: string; note?: string };
export function MealNutritionSummary({ totals, basisLabel = '本餐营养', note }: MealNutritionSummaryProps) {
  return <section className="meal-nutrition-summary" aria-label={basisLabel}>
    <div className="meal-nutrition-summary-heading"><span>{basisLabel}</span></div>
    <div className="meal-summary-grid"><dl className="meal-summary-energy"><NutrientMetric nutrient="kcal" total={findTotal(totals, 'kcal')} prominent/></dl><dl className="meal-summary-macros">{keys.slice(1).map(key => <NutrientMetric key={key} nutrient={key} total={findTotal(totals, key)}/>)}</dl></div>
    {note && <p className="meal-nutrition-note">{note}</p>}
  </section>;
}

export type FoodNutritionListProps = { rows: readonly MealNutritionRow[]; ariaLabel?: string; emptyText?: string };
export function FoodNutritionList({ rows, ariaLabel = '食物份量与营养明细', emptyText = '尚未提供食物明细。' }: FoodNutritionListProps) {
  const withSources = rows.filter(row => row.sourceText || row.sourceNote || keys.some(key => row.nutrientSources?.[key] && row.nutrientSources[key] !== 'unknown'));
  if (!rows.length) return <p className="meal-nutrition-empty">{emptyText}</p>;
  return <section className="meal-food-nutrition" aria-label={ariaLabel}>
    <div className="meal-food-table-head" aria-hidden="true"><span>食物与份量</span><div>{keys.map(key => <span key={key}>{labels[key]} <small>{key === 'kcal' ? 'kcal' : 'g'}</small></span>)}</div></div>
    <ul className="meal-food-list">{rows.map(row => <li key={row.origin + ':' + row.id} className={'meal-food-row' + (row.zero && row.origin === 'reported' ? ' is-uneaten' : '')}>
      <div className="meal-food-identity"><div className="meal-food-heading"><h4>{row.name || '未命名食物'}</h4><p className="meal-food-quantity">{row.zero && row.origin === 'reported' && <span>未吃 · </span>}{foodDisplayAmount(row).text}</p></div>
        {row.remainingNote ? <p className="meal-food-note">{row.remainingNote}</p> : row.quantityUnknown ? <p className="meal-food-note">用量未报，营养暂不能完整计算。</p> : row.conversionMissing ? <p className="meal-food-note">当前份量与营养口径无法换算，待核对。</p> : null}
      </div>
      <dl className="meal-food-metrics">{keys.map(key => <NutrientMetric key={key} nutrient={key} total={findTotal(row.totals, key)} prominent={key === 'kcal'}/>)}</dl>
    </li>)}</ul>
    <p className="meal-food-legend">按每项当前份量计算 · ≈ 表示估算</p>
    {withSources.length > 0 && <details className="meal-food-sources"><summary>查看营养依据</summary>{withSources.map(row => <div key={row.origin + ':' + row.id}><strong>{row.name}</strong><p>{keys.map(key => labels[key] + '：' + (sourceLabels[row.nutrientSources?.[key] ?? 'unknown'] ?? '已保存的营养依据')).join(' · ')}</p>{row.sourceNote && <p className="meal-source-original">{row.sourceNote}</p>}{row.sourceText && <p className="meal-source-original">{row.sourceText}</p>}</div>)}</details>}
  </section>;
}

export default MealNutritionSummary;
