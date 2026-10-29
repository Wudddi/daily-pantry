"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ChevronDown, Clock3, X } from 'lucide-react';
import type { DietPlan, Meal } from '@/lib/diet-types';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import { mealNutritionView } from '@/lib/meal-nutrition-view.mjs';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import './meal-overview.css';

const slots = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐', other: '其他' };
function format(value: number, key = '') {
  if (key && value > 0 && value < (key === 'kcal' ? 1 : .1)) return key === 'kcal' ? '<1' : '<0.1';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: !key ? 6 : key === 'kcal' ? 0 : 1 }).format(value);
}
function Metric({ total, label, energy = false }: { total?: PlanNutritionTotal; label: string; energy?: boolean }) {
  const incomplete = !total || total.value === null || total.partial;
  return <div className={'overview-metric' + (energy ? ' overview-energy' : '')}>
    <dt>{label}</dt><dd>{incomplete ? '待补齐' : (total.estimated ? '≈ ' : '') + format(total.value!, total.key)}{!incomplete && <small>{energy ? ' kcal' : ' g'}</small>}</dd>
    {incomplete && total?.value !== null && total?.value !== undefined && <span>已知 {total.estimated ? '≈ ' : ''}{format(total.value, total.key)}{energy ? ' kcal' : ' g'}</span>}
  </div>;
}

export type MealOverviewCardProps = { meal: Meal; planStatus: DietPlan['status']; planId?: string; expanded?: boolean; targetId: string; triggerId: string; onSelect: () => void };
export function MealOverviewCard({ meal, planStatus, planId, expanded = false, targetId, triggerId, onSelect }: MealOverviewCardProps) {
  const view = mealNutritionView(meal, { planStatus, planId });
  const unreported = view.issues.some(issue => issue.code === 'COMPLETED_CONTENT_UNREPORTED');
  const actualOnly = view.mode === 'actual' && !unreported;
  const foodRows = view.rows.filter(row => !row.zero);
  const title = actualOnly || view.mode === 'partial'
    ? view.rows.filter(row => !row.zero).map(row => row.name).join(' ＋ ') || (actualOnly ? '无已报告的食物' : '食物内容待补充')
    : meal.title;
  const badge = planStatus === 'cancelled' || meal.state === 'cancelled' ? '已取消' : unreported ? '实际内容未报' : actualOnly ? '已完成 · 实际记录' : view.mode === 'partial' ? '部分已报告' : '当前菜单';
  return <article className={'meal-overview-card panel' + (expanded ? ' is-selected' : '')} aria-label={slots[meal.slot] + '总览'}>
    <div className="meal-overview-card-heading"><strong>{slots[meal.slot]}</strong><span className={'diet-badge ' + meal.state}>{badge}</span></div>
    <p className="meal-overview-time"><Clock3 size={13}/>{actualOnly ? '实际：' + (meal.actualTime || meal.actualTimeText || '时间未报') : '计划：' + (meal.plannedTime || meal.plannedTimeText || '时间灵活')}</p>
    <h3 title={title}>{title}</h3>
    <details className="meal-overview-foods"><summary>食材与份量 · {foodRows.length}项<ChevronDown size={14}/></summary><ul>{foodRows.map(row => <li key={row.origin + ':' + row.id}><span>{row.name}</span><strong>{foodDisplayAmount(row).text}</strong></li>)}</ul></details>
    <dl className="meal-overview-metrics" aria-label={slots[meal.slot] + '营养合计'}>
      <Metric label="热量" energy total={view.totals.find(total => total.key === 'kcal')}/>
      <div className="meal-overview-macros"><Metric label="蛋白质" total={view.totals.find(total => total.key === 'protein')}/><Metric label="碳水" total={view.totals.find(total => total.key === 'carbs')}/><Metric label="脂肪" total={view.totals.find(total => total.key === 'fat')}/></div>
    </dl>
    <button className="meal-overview-open" id={triggerId} aria-expanded={expanded} aria-controls={targetId} onClick={onSelect}>{expanded ? '正在查看' : '查看' + slots[meal.slot] + '明细'}<ArrowDown size={15}/></button>
  </article>;
}

export default function MealOverview({ meals, planStatus, planId, renderDetail }: { meals: Meal[]; planStatus: DietPlan['status']; planId?: string; renderDetail: (meal: Meal) => ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const prefix = useId(), detailRef = useRef<HTMLDivElement>(null);
  const selected = meals.find(meal => meal.id === selectedId) ?? null;
  const targetId = prefix + '-detail';
  useEffect(() => { if (selectedId) detailRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [selectedId]);
  return <section className="meal-overview" aria-label="一天饮食总览">
    <div className="meal-overview-heading"><h2>一天吃什么</h2><p>各餐先看全貌，份量和营养明细按需展开；有变动时调整当前菜单。</p></div>
    <div className="meal-overview-grid">{meals.map((meal, index) => <MealOverviewCard key={meal.id} meal={meal} planStatus={planStatus} planId={planId} targetId={targetId} triggerId={prefix + '-meal-' + index} expanded={selected?.id === meal.id} onSelect={() => setSelectedId(meal.id)}/>)}</div>
    <div id={targetId} ref={detailRef} className="meal-overview-detail" hidden={!selected}>
      {selected && <>
        <div className="meal-detail-navigation"><div role="group" aria-label="选择餐次明细">{meals.map(meal => <button key={meal.id} aria-pressed={selected.id === meal.id} onClick={() => setSelectedId(meal.id)}>{slots[meal.slot]}</button>)}</div><button className="meal-detail-close" onClick={() => { const index = meals.findIndex(meal => meal.id === selected.id); setSelectedId(null); document.getElementById(prefix + '-meal-' + index)?.focus(); }}><X size={15}/>收起明细</button></div>
        <div className="diet-meals diet-meals-detailed" role="region" aria-label={slots[selected.slot] + '详细饮食'}>{renderDetail(selected)}</div>
      </>}
    </div>
  </section>;
}
