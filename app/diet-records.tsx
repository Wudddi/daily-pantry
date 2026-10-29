"use client";
import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Clock3, MessageCircle, Pill, RefreshCw, Utensils } from 'lucide-react';
import type { DietPlan, Meal, NutritionSnapshot } from '@/lib/diet-types';
import { mealExecutionView } from '@/lib/diet-edit-read.mjs';
import { mealNutritionView } from '@/lib/meal-nutrition-view.mjs';
import { dailyFoodRollup } from '@/lib/daily-food-rollup.mjs';
import type { DailyMenuSettlementPolicy } from '@/lib/daily-menu-policy.mjs';
import type { FoodItem } from '@/lib/inventory-types';
import { resolveDietDays } from '@/lib/diet-day-summary.mjs';
import { projectCurrentDietPlan } from '@/lib/diet-current-plan.mjs';
import { getDailySupplementView } from '@/lib/diet.mjs';
import { foodDisplayAmount } from '@/lib/food-display-amount.mjs';
import DietCalendar from './diet-calendar';
import SupplementChecklist from './supplement-checklist';
import MealNutritionSummary, { FoodNutritionList } from './meal-nutrition';
import MealOverview from './meal-overview';
import DailyFoodOverview from './daily-food-overview';
import IntakeDraftEditor from './intake-draft-editor';
import DayFoodChecklist from './day-food-checklist';
import './diet.css';
import './diet-checklist-layout.css';
import DietHistory from './diet-history';
import type { DietHistoryRecord } from '@/lib/diet-history-types';

type DietState = { revision: number; items?: FoodItem[]; plans?: unknown[]; dietHistory?: DietHistoryRecord[]; supplementRoutine?: unknown; dailyMenuSettlementPolicy?: DailyMenuSettlementPolicy };
type Props = { state: DietState | null; getLatest?: () => DietState | null; loading: boolean; saving: boolean; error: string; refresh: () => Promise<void>; mutate: (action: string, payload: Record<string, unknown>, message: string) => Promise<boolean>; dispatchCheck: (payload: { date: string; doseId: string; checked: boolean; expectedRevision: number }, message: string) => Promise<{ ok: boolean; revision: number }> };
const names = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐', other: '其他' };
const number = (n: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(n);
const dailyNumber = (n: number, key: string) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: key === 'kcal' ? 0 : 1 }).format(n);
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function shift(date: string, days: number) { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function amount(value: number | null, unit: string) { return value === null ? '用量未报' : number(value) + ' ' + unit; }
function mealState(state: string) { return state === 'completed' ? '已完成 · 实际记录' : state === 'in_progress' ? '已报告部分' : state === 'cancelled' ? '已取消' : '当前菜单'; }

export default function DietRecords({ state, getLatest, loading, saving, error, refresh, mutate, dispatchCheck }: Props) {
  const [date, setDate] = useState(today), [month, setMonth] = useState(() => today().slice(0, 7)), [copied, setCopied] = useState(false);
  const [view, setView] = useState<'meals' | 'checklist' | 'supplements' | 'intake'>('meals'), [showCalendar, setShowCalendar] = useState(false);
  const days = useMemo(() => resolveDietDays((state?.plans ?? []).filter((entry): entry is DietPlan => !!entry && typeof entry === 'object' && 'format' in entry && entry.format === 'meals_v1'), state?.dietHistory ?? [], state?.items ?? []), [state]);
  const day = days.find(entry => entry.date === date), current = day?.plan;
  function latestChecklistState() {
    const latest = getLatest?.() ?? state;
    if (!latest || !current) return null;
    const saved = (latest.plans ?? []).find((entry): entry is DietPlan => !!entry && typeof entry === 'object' && 'format' in entry && entry.format === 'meals_v1' && 'id' in entry && entry.id === current.id && 'date' in entry && entry.date === date);
    const plan = saved ? projectCurrentDietPlan(saved, latest.items ?? []) : null;
    return plan && plan.id === current.id ? { plan, items: latest.items ?? [], revision: latest.revision } : null;
  }
  const foodSummary = useMemo(() => current ? dailyFoodRollup(current, state?.items ?? []) : null, [current, state?.items]);
  const supplementView = useMemo(() => state ? getDailySupplementView(state, date) : null, [state, date]);
  const supplementPlan = supplementView?.plan as DietPlan | null | undefined;
  const history = state?.dietHistory ?? [], hasHistory = history.some(record => record.date === date);
  function selectDate(value: string) { setDate(value); setMonth(value.slice(0, 7)); }
  function selectMonth(value: string) { setMonth(value); setDate(days.find(entry => entry.date.startsWith(value + '-'))?.date ?? value + '-01'); }
  const calendarDays = days.map(entry => { const energy = entry.totals.find(total => total.key === 'kcal'); return { date: entry.date, kcal: energy?.value ?? null, partial: energy?.partial ?? true, estimated: energy?.estimated ?? false, draft: entry.plan?.status === 'draft' }; });
  const prompt = `@每日库存 请先读取最新库存、排餐习惯、体重训练背景和${date}饮食记录，帮我安排${date}的饮食与补给。沿用当天canonical planId和稳定的mealId、itemId、doseId，菜单保存后立即显示并保持可改；只保存或修改菜单不预留、不扣库存。默认按完整当前菜单统计全天热量和三大营养素；保存后核对回执的dailyFoodSummary，包含同食材跨餐合并的全天总用量、各餐分配与四项营养，回复也附全天总量。不要另抄一份容易过时的总数，不需要逐餐打卡；有变化我会告诉你。午晚餐可按备餐方便合炒均分或拆分主餐主食。食物勾选仅为个人提醒，不读取或推断是否已吃；开启日终策略后，每日多伦多00:00按前一天最后保存菜单结算，未勾选不代表没吃。我的明确实际报告及更正优先，已结算部分只调差量，重复报告不能重复扣减。已有实际记录保留，更正按差量调整。用户自行保存的进食草稿不代表已吃；先读取并保留，不将未提交的已吃量或跨餐调配当成实际，也不静默清空。补给打卡独立，不能覆盖或隐藏菜单。常备食物保存有来源的营养估值，食物按g、饮料按mL显示；实际时间未报告就留空。`;
  async function copyPrompt() { try { await navigator.clipboard.writeText(prompt); setCopied(true); } catch { setCopied(false); } }
  return <div className={'diet-page' + ((view === 'meals' || view === 'checklist') && current ? ' diet-checklist-home' : '')}>
    <div className="page-heading"><div><div className="eyebrow"><span/>DAILY MEALS</div><h1>每日饮食<span className="heading-dot">.</span></h1><p>{view === 'supplements' ? '固定安排每天可用，服用后点一下；可选和按需由你决定。' : view === 'intake' ? '填累计已吃量，灵活调配餐次；草稿与实际记录分开保存。' : '让 Chat 安排，按全天总量执行；午晚餐灵活分配。'}</p></div><button className="button secondary" onClick={() => void refresh()} disabled={loading || saving}><RefreshCw size={17} className={loading ? 'spin' : ''}/>刷新记录</button></div>
    <div className="diet-day-bar panel"><div className="diet-date-picker"><button aria-label="前一天饮食" onClick={() => selectDate(shift(date, -1))}><ChevronLeft size={19}/></button><label>日期<input aria-label="饮食日期" type="date" value={date} onChange={e => { if (e.target.value) selectDate(e.target.value); }}/></label><button aria-label="后一天饮食" onClick={() => selectDate(shift(date, 1))}><ChevronRight size={19}/></button><button className="diet-today" onClick={() => selectDate(today())}>今天</button></div>{view === 'meals' && !current && <button className="button primary" onClick={() => void copyPrompt()}><MessageCircle size={17}/>{copied ? '指令已复制' : '让 Chat 安排这一天'}</button>}</div>
    {state && <div className="diet-footnote" aria-label="日终结算设置"><span>{state.dailyMenuSettlementPolicy?.enabled ? '个人勾选仅作提醒 · 每日00:00按前一天菜单结算' : '个人勾选仅作提醒 · 日终自动结算尚未开启'}</span><button className="text-button" disabled={saving || loading} onClick={() => void mutate('set_daily_menu_settlement_policy', { enabled: !state.dailyMenuSettlementPolicy?.enabled, timeZone: 'America/Toronto', startsOn: state.dailyMenuSettlementPolicy?.enabled ? state.dailyMenuSettlementPolicy.startsOn : today(), confirmed: true, sourceText: '用户在每日饮食页面明确设置：个人勾选仅为提醒，不作为实际进食依据；按每天午夜前最新菜单结算前一天，明确更正优先，已经结算的部分不再重复扣减。' }, state.dailyMenuSettlementPolicy?.enabled ? '已关闭日终自动结算' : '日终结算规则已开启')}>{state.dailyMenuSettlementPolicy?.enabled ? '关闭自动结算' : '开启00:00结算'}</button></div>}
    <div className="diet-view-tabs" role="tablist" aria-label="每日饮食内容"><button id="diet-meals-tab" role="tab" aria-selected={view === 'meals'} aria-controls="diet-meals-content" onClick={() => setView('meals')}><Utensils size={17}/>一天吃什么</button><button id="diet-checklist-tab" role="tab" aria-selected={view === 'checklist'} aria-controls="diet-checklist-content" onClick={() => setView('checklist')}><CheckCircle2 size={17}/>记录与调整</button><button id="diet-supplements-tab" role="tab" aria-selected={view === 'supplements'} aria-controls="diet-supplements-content" onClick={() => setView('supplements')}><Pill size={17}/>补给清单</button>{view === 'intake' && <button id="diet-intake-tab" role="tab" aria-selected aria-controls="diet-intake-content"><CheckCircle2 size={17}/>逐项核对</button>}<button className="diet-calendar-toggle" aria-expanded={showCalendar} onClick={() => setShowCalendar(value => !value)}>{showCalendar ? '收起月历' : '月历'}</button></div>
    {showCalendar && <DietCalendar days={calendarDays} month={month} selectedDate={date} onMonthChange={selectMonth} onSelectDate={selectDate}/>}
    {(view === 'meals' || view === 'checklist') && day && <section className="diet-daily-summary" aria-label="全天饮食统计"><div className="diet-summary-heading"><div><span className="diet-badge">当前菜单与实际记录</span><h2>{date} · 全天营养</h2></div><p>已完成餐按实际，未完成餐按当前菜单计入；可在晚上一次性报告。</p></div><div className="diet-nutrition-grid">{day.totals.map(total => <div className="panel" key={total.key}><span>{{ kcal: '全天热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' }[total.key]}</span><strong>{total.value === null || total.partial ? '待补齐' : (total.estimated ? '≈ ' : '') + dailyNumber(total.value, total.key)}{total.value !== null && !total.partial && <small>{total.key === 'kcal' ? ' kcal' : ' g'}</small>}</strong><p>{total.partial ? total.value === null ? '营养资料未提供' : '已知部分 ' + dailyNumber(total.value, total.key) + (total.key === 'kcal' ? ' kcal' : ' g') + '，非全天总量' : total.estimated ? '全天菜单估算' : '全天菜单合计'}</p></div>)}</div><p className="diet-summary-note">{!!day.matchedHistoryId ? '已核对同一份菜单的完整营养资料。' : '以当前菜单及已报告的实际食物计算。'}补给营养包含已安排用量和实际更正，未服用不冒称已服；缺少的营养保留未知。</p>{day.issues.length > 0 && <details className="diet-summary-details"><summary>查看统计依据与待补资料</summary>{day.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}</section>}
    {view === 'supplements' && <div id="diet-supplements-content" role="tabpanel" aria-labelledby="diet-supplements-tab">{supplementPlan && state ? <SupplementChecklist key={date} plan={supplementPlan} items={state.items ?? []} revision={state.revision} busy={saving || loading} mutate={mutate} dispatchCheck={dispatchCheck} routineSourcePlanId={supplementView?.sourcePlanId ?? null}/> : <div className="panel diet-empty"><Pill size={30}/><h2>{loading ? '正在读取补给时间表' : '还没有常用补给时间表'}</h2><p>只需保存一次常用安排，以后每天都能查看，服用记录按日期分别保存。</p></div>}{error && <p className="form-error" role="alert">{error}</p>}</div>}
    {view === 'intake' && <div id="diet-intake-content" role="tabpanel" aria-labelledby="diet-intake-tab">{current && state ? <IntakeDraftEditor key={current.id + ':' + date} plan={current} items={state.items ?? []} revision={state.revision} busy={saving || loading} error={error} mutate={mutate} refresh={refresh}/> : <div className="panel diet-empty"><Utensils size={30}/><h2>{loading ? '正在读取当天菜单' : '这一天还没有可编辑菜单'}</h2><p>先让 Chat 保存当天菜单，再在这里填写已吃量和调配餐次。</p><button className="button secondary" onClick={() => setView('meals')}>查看当天饮食</button></div>}</div>}
    <div id="diet-meals-content" role="tabpanel" aria-labelledby="diet-meals-tab" hidden={view !== 'meals'}>
    {!current && <div className="diet-chat-guide"><MessageCircle size={18}/><p>在手机健康项目里选择 <strong>@每日库存</strong>，让 Chat 排餐，保存后这里就是当天的饮食清单。</p></div>}
    {copied && <details className="diet-prompt"><summary>查看已复制的排餐指令</summary><p>{prompt}</p></details>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {loading && !state ? <div className="panel diet-empty"><h2>正在读取你的饮食记录</h2></div> : !current ? hasHistory ? null : <>
      <div className="panel diet-empty"><span className="diet-empty-icon"><Utensils size={30}/></span><h2>这一天的饮食还没保存</h2><p>让 Chat 按库存制定菜单，保存后就会显示在这里。补给清单每天都能单独查看和记录。</p><p className="diet-light-note">菜单随时可改；个人勾选不影响库存，开启日终策略后由每日00:00按菜单结算。</p></div>
      <div className="diet-empty-slots">{['早餐', '午餐', '晚餐'].map((label, i) => <div className="panel" key={label}><Utensils size={21}/><h3>{label}</h3><p>等待 Chat 保存计划</p></div>)}</div>
    </> : <>
      <section className="panel diet-menu-overview">{current.dailySettlement && <p className="diet-light-note">{current.dailySettlement.accounting === 'settled' ? '本日已按菜单结算 · 不代表实报进食时间' : '本日已保存日终记录 · 库存差额待核对'}</p>}{current.accountingWarnings?.length ? <p className="diet-light-note" role="status">账面不足差额已记，实际用量已保留：{current.accountingWarnings.slice(0, 3).map(w => `${state?.items?.find(item => item.id === w.itemId)?.name ?? w.itemId} ${w.quantity}${w.unit}`).join("；")}</p> : null}<span className="diet-badge">当前菜单 · 已保存</span><p className="diet-light-note">{current.title}</p><MealOverview key={current.id + ':' + date} meals={current.meals} planStatus={current.status} planId={current.id} renderDetail={meal => <ExecutedMealCard key={meal.id} meal={meal} draft={current.status === 'draft'} planStatus={current.status} planId={current.id}/>}/></section>
      {foodSummary && <details className="panel diet-reference-details"><summary>全天食材合计 · {foodSummary.rows.length} 项</summary><DailyFoodOverview summary={foodSummary}/></details>}
      {current.notes && <details className="panel diet-notes"><summary>这份计划的备注</summary><p className="health-original">{current.notes}</p></details>}
    </>}
    {(supplementPlan ?? current)?.supplementDoses.some(dose => dose.actualEntries.length > 0) && <details className="panel diet-reference-details"><summary>实际补给记录</summary><ActualSupplementReceipts plan={(supplementPlan ?? current)!}/></details>}
    {state && <DietHistory records={history} date={date} selectDate={selectDate} showNutrition={false} showDateNavigation={false} collapsed={!!current} revision={state.revision} busy={saving || loading} error={error} mutate={mutate}/>}
    </div>
    <div id="diet-checklist-content" role="tabpanel" aria-labelledby="diet-checklist-tab" hidden={view !== 'checklist'}>{current && state ? <DayFoodChecklist key={current.id + ':' + date} active={view === 'checklist'} plan={current} items={state.items ?? []} revision={state.revision} busy={saving || loading} error={error} mutate={mutate} refresh={refresh} getLatest={latestChecklistState} onOpenAdvanced={() => setView('intake')}/> : <div className="panel diet-empty"><h2>这一天还没有可调整菜单</h2><p>让 Chat 保存当天菜单后，就可以在这里勾选和分餐。</p><button className="button secondary" onClick={() => setView('meals')}>查看当天饮食</button></div>}</div>
    {(view === 'meals' || view === 'checklist') && <div className="diet-footnote"><CheckCircle2 size={15}/>菜单保存即显示；个人勾选不影响库存；开启日终策略后按菜单结算，明确更正只调差量。</div>}
  </div>;
}

export function DailyMealProgress({ meals }: { meals: Meal[] }) {
  const completed = meals.filter(meal => meal.state === 'completed').length;
  const partial = meals.filter(meal => meal.state === 'in_progress').length;
  const cancelled = meals.filter(meal => meal.state === 'cancelled').length;
  return <div className="diet-meal-progress" role="status" aria-label="餐次完成情况"><span>已完成 <strong>{completed}</strong> 餐</span><span>未完成 <strong>{meals.length - completed - cancelled}</strong> 餐{partial > 0 && <small>（其中 {partial} 餐已报告部分）</small>}</span>{cancelled > 0 && <span>已取消 {cancelled} 餐</span>}<p>完成状态来自实际报告；不用为了看完整菜单逐餐打卡。</p></div>;
}

export function ActualSupplementReceipts({ plan }: { plan: DietPlan }) {
  const receipts = plan.supplementDoses.flatMap(dose => dose.actualEntries.filter(entry => entry.quantity === null || entry.quantity > 0).map(entry => ({ doseId: dose.id, ...entry, actualTime: dose.actualTime || dose.actualTimeText })));
  return <section className="panel diet-supplement-receipts" aria-label="当天实际补给记录"><header><h2><Pill size={17}/>实际补给记录</h2><span>{receipts.length ? receipts.length + ' 条已记录' : '尚未报告'}</span></header>{receipts.length ? <ul>{receipts.map(entry => <li key={entry.doseId + ':' + entry.id}><span>{entry.name || entry.nutritionSnapshot?.name || '补给'}</span><strong>{amount(entry.quantity, entry.unit)}</strong><small>{entry.actualTime || '时间未报'}</small></li>)}</ul> : <p>安排中的补给不代表已服用；服用后在补给清单勾选，或直接告诉 Chat。</p>}</section>;
}

type FoodDisplayLine = { id: string; itemId: string | null; name?: string; quantity: number | null; unit: string; nutritionSnapshot?: { name: string; unit?: string; gramsPerUnit?: number | null; nutrition?: { basisUnit?: string } } | null; sourceText?: string; remainingNote?: string };
function FoodLines({ lines, actual = false }: { lines: FoodDisplayLine[]; actual?: boolean }) {
  return <ul className="diet-food-lines">{lines.map(line => <li key={line.id}><span>{line.name || line.nutritionSnapshot?.name || line.itemId || '未命名食物'}{line.remainingNote && <small>{line.remainingNote}</small>}</span><strong>{actual && line.quantity === 0 ? '未吃（' + foodDisplayAmount(line).text + '）' : foodDisplayAmount(line).text}</strong></li>)}</ul>;
}

export function ExecutedMealCard({ meal, draft = false, planStatus = 'reserved', planId }: { meal: Meal; draft?: boolean; planStatus?: DietPlan['status']; planId?: string }) {
  const nutrition = mealNutritionView(meal, { planStatus: draft ? 'draft' : planStatus, planId });
  const baseExecution = mealExecutionView(planStatus === 'cancelled' ? { ...meal, state: 'cancelled' } : meal);
  const execution = nutrition.mode === 'partial' && baseExecution.mode === 'actual' ? { ...baseExecution, mode: 'partial', remainingItems: nutrition.remainingRows.map(row => ({ id: row.id, itemId: row.itemId, name: row.name, quantity: row.displayQuantity ?? row.quantity, unit: row.displayUnit ?? row.unit })) } : baseExecution;
  const revisions = meal.planRevisionHistory ?? [];
  const hasReports = meal.actualEntries.length > 0 || !!meal.sourceText || meal.reportHistory.length > 0;
  const unreportedCompletion = meal.state === 'completed' && !meal.actualEntries.length && planStatus !== 'cancelled';
  const originalPlan = <details className="diet-actual"><summary>{unreportedCompletion ? '暂按计划计入的营养明细 · 实际内容未报' : '原计划（仅供对照）'}</summary><p className="health-original">{meal.title}</p>{unreportedCompletion ? <FoodNutritionList rows={nutrition.plannedRows} ariaLabel="实际未报时保留的计划营养"/> : <FoodLines lines={meal.plannedItems}/>}{meal.plannedItems.filter(line => line.sourceText).map(line => <p className="health-original" key={line.id}>{line.sourceText}</p>)}</details>;
  return <section className="panel diet-meal">
    <div className="diet-meal-heading"><div><span className="diet-meal-slot">{names[meal.slot]}</span><h3>{meal.state === 'completed' ? names[meal.slot] + (unreportedCompletion ? ' · 实际内容待补' : ' · 实际记录') : execution.mode === 'partial' ? names[meal.slot] + ' · 部分已报告' : meal.title}</h3></div><span className={'diet-badge ' + meal.state}>{unreportedCompletion ? '实际内容未报' : mealState(planStatus === 'cancelled' ? 'cancelled' : meal.state)}</span></div>
    <div className="diet-times"><span><Clock3 size={15}/>计划：{meal.plannedTime || meal.plannedTimeText || '时间灵活'}</span><span>实际：{meal.actualTime || meal.actualTimeText || '未记录时间'}</span></div>
    <MealNutritionSummary totals={nutrition.totals} basisLabel={nutrition.basisLabel} note={nutrition.note}/>
    {execution.mode === 'planned' ? <FoodNutritionList rows={nutrition.rows} ariaLabel={names[meal.slot] + '食物与营养明细'}/> : execution.mode === 'actual' ? <>
      {meal.actualEntries.length ? <FoodNutritionList rows={nutrition.actualRows} ariaLabel={names[meal.slot] + '实际食物与营养明细'}/> : <p className="diet-light-note">尚未提供具体实际食物，不把原计划当作已吃。</p>}
      {originalPlan}
    </> : <>
      <p className="diet-meal-counted-label">本餐计入的食物</p>
      <FoodNutritionList rows={nutrition.rows} ariaLabel={names[meal.slot] + '计入合计的食物与营养'}/>
      <details className="diet-execution-details"><summary>查看实际食物与剩余计划</summary>
        <p className="diet-light-note">已报告的实际食物</p>
        {meal.actualEntries.length ? <FoodLines lines={meal.actualEntries} actual/> : <p className="diet-light-note">尚未提供具体实际食物，不把原计划当作已吃。</p>}
        <div aria-label="尚未报告的剩余计划"><p className="diet-light-note">仍保留的计划 · 尚未报告</p>{execution.remainingItems.length ? <FoodLines lines={execution.remainingItems}/> : <p className="diet-light-note">计划数量已报告；这餐仍未报告结束。</p>}<p className="diet-light-note">以上是剩余计划，不代表已经吃了；有变化再告诉 Chat 即可。</p></div>
      </details>
      {originalPlan}
    </>}
    {nutrition.issues.length > 0 && <details className="diet-meal-nutrition-issues"><summary>查看本餐营养依据与待补资料</summary>{nutrition.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}
    {hasReports && <details className="health-source"><summary>实际报告原话与更正</summary>{meal.sourceText && <p className="health-original">{meal.sourceText}</p>}{meal.actualEntries.map(entry => <div key={entry.id}><p className="health-original">{entry.name} · {entry.quantity === 0 ? '未吃（' + amount(0, entry.unit) + '）' : amount(entry.quantity, entry.unit)}{entry.sourceText ? '\n' + entry.sourceText : ''}</p><ActualNutritionDetails entry={entry}/>{entry.correctionHistory?.length > 0 && <details><summary>这条实际记录的更正</summary>{entry.correctionHistory.map((previous, index) => <p className="health-original" key={index}>{previous.name} · {amount(previous.quantity, previous.unit)}{previous.sourceText ? '\n' + previous.sourceText : ''}</p>)}</details>}</div>)}{meal.reportHistory.map((report, index) => <p className="health-original" key={index}>{report.sourceText || '本次未附原话'}{report.actualTime ? '\n实际时间：' + report.actualTime : report.actualTimeText ? '\n' + report.actualTimeText : ''}</p>)}</details>}
    {revisions.length > 0 && <details className="diet-actual"><summary>之前的计划（{revisions.length}）</summary>{revisions.map((entry, index) => <div key={index}><p className="diet-light-note">{entry.at} · {entry.previous.title}</p>{(entry.previous.plannedTime || entry.previous.plannedTimeText) && <p className="diet-light-note">{[entry.previous.plannedTime, entry.previous.plannedTimeText].filter(Boolean).join(' · ')}</p>}<FoodLines lines={entry.previous.plannedItems}/>{entry.previous.plannedItems.filter(line => line.sourceText).map(line => <p className="health-original" key={line.id}>{line.sourceText}</p>)}</div>)}</details>}
    <div className="diet-meal-footer"><p>{execution.mode === 'actual' ? '按已报告的实际食物展示，原计划与更正记录保留。' : execution.mode === 'partial' ? '只将已报告部分视为实际；其余继续保留计划。' : '当前菜单可随时修改；个人勾选不影响库存，日终策略及明确实际更正分别结算。'}</p></div>
  </section>;
}


function NutritionEvidence({ snapshot }: { snapshot: NutritionSnapshot }) {
  if (!snapshot) return <p className="health-original">未提供营养快照</p>;
  const value = snapshot.nutrition;
  const labels: Record<string, string> = { label: '标签', recipe: '配方计算', estimate: '估算', unknown: '未提供' };
  return <div><p className="health-original">{snapshot.name}{value.basisAmount > 0 ? ' · 每 ' + amount(value.basisAmount, value.basisUnit) : ' · 口径未提供'}{'\n'}{(['kcal', 'protein', 'carbs', 'fat'] as const).map(key => ({ kcal: '热量', protein: '蛋白质', carbs: '碳水', fat: '脂肪' }[key]) + '：' + (value[key] === null ? '未提供' : number(value[key]) + (key === 'kcal' ? ' kcal' : ' g')) + '（' + (labels[value.nutrientSources?.[key] ?? value.source] ?? '未提供') + '）').join(' · ')}</p>{value.sourceText && <p className="health-original">{value.sourceText}</p>}{value.sourceNote && <p className="health-original">{value.sourceNote}</p>}</div>;
}

function ActualNutritionDetails({ entry }: { entry: { nutritionSnapshot: NutritionSnapshot; nutritionCorrectionHistory?: { at: string; sourceText: string; previous: NutritionSnapshot }[] } }) {
  const history = entry.nutritionCorrectionHistory ?? [];
  if (!history.length) return null;
  return <details><summary>营养更正与依据（{history.length}）</summary><p className="diet-light-note">当前营养依据</p><NutritionEvidence snapshot={entry.nutritionSnapshot}/>{history.map((change, index) => <div key={index}><p className="diet-light-note">{change.at} · 更正前</p><p className="health-original">{change.sourceText}</p><NutritionEvidence snapshot={change.previous}/></div>)}</details>;
}
