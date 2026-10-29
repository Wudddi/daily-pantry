"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Loader2, Pill, Upload, X } from 'lucide-react';
import type { DietPlan } from '@/lib/diet-types';
import type { FoodItem } from '@/lib/inventory-types';
import { buildSupplementChecklist, parseSupplementTimetable, SUPPLEMENT_REQUIREMENT_LABELS, type ChecklistDose, type SupplementChecklistRow, type SupplementTimetablePreview } from '@/lib/supplement-checklist.mjs';
import { createSupplementCheckQueue, type SupplementCheckPayload, type SupplementCheckReceipt, type SupplementCheckQueueState } from '@/lib/supplement-check-queue.mjs';
import './supplement-checklist.css';

export type SupplementChecklistProps = {
  plan: DietPlan;
  items: FoodItem[];
  revision: number;
  busy: boolean;
  routineSourcePlanId?: string | null;
  mutate: (action: string, payload: Record<string, unknown>, message: string) => Promise<boolean>;
  dispatchCheck: (payload: SupplementCheckPayload, message: string) => Promise<SupplementCheckReceipt>;
};

const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);
const quantityText = (quantity: number | null, unit: string) => quantity === null ? '用量未报' : formatNumber(quantity) + ' ' + unit;
const doseName = (dose: ChecklistDose) => dose.nutritionSnapshot?.name || dose.itemId;
const slotLabels: Record<string, string> = { breakfast: '早餐', lunch: '午餐', pre_workout: '训练前', post_workout: '训练后', dinner: '晚餐', bedtime: '睡前', other: '时间灵活' };

export default function SupplementChecklist({ plan, items = [], revision, busy, mutate, dispatchCheck, routineSourcePlanId }: SupplementChecklistProps) {
  const checklist = useMemo(() => buildSupplementChecklist(plan), [plan]);
  const confirmed = useMemo(() => Object.fromEntries(checklist.groups.flatMap(group => group.rows.map(row => [row.dose.id, row.checked]))), [checklist]);
  const [queueState, setQueueState] = useState<SupplementCheckQueueState>(() => ({ checked: confirmed, pendingDoseIds: [], pendingCount: 0, failedDoseIds: [], blocked: false, error: '', revision }));
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [interacted, setInteracted] = useState(false);
  const [timetable, setTimetable] = useState<{ preview: SupplementTimetablePreview; revision: number } | null>(null);
  const [readingTimetable, setReadingTimetable] = useState(false), [savingTimetable, setSavingTimetable] = useState(false);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const timetableInput = useRef<HTMLInputElement>(null), importLocked = useRef(false);
  const dispatchRef = useRef(dispatchCheck), planRef = useRef(plan);
  dispatchRef.current = dispatchCheck; planRef.current = plan;
  const queue = useRef<ReturnType<typeof createSupplementCheckQueue> | null>(null);
  const readOnly = plan.status === 'cancelled' || plan.status === 'closed_with_actuals';
  const unavailableForImport = busy || queueState.pendingCount > 0 || queueState.blocked || savingTimetable || readingTimetable || savingRoutine || readOnly;
  const unavailableForCheck = readOnly || savingTimetable || readingTimetable || savingRoutine || queueState.blocked;
  const timetableStale = !!timetable && (timetable.preview.planId !== plan.id || timetable.revision !== revision);
  const headingId = useId();
  const typeCount = new Set(plan.supplementDoses.map(dose => dose.itemId)).size;

  useEffect(() => {
    const writer = createSupplementCheckQueue({
      date: plan.date, revision, confirmed,
      send: payload => {
        const dose = planRef.current.supplementDoses.find(entry => entry.id === payload.doseId);
        const message = payload.date + ' · ' + (dose ? doseName(dose) : '补给') + (payload.checked ? '：服用已记录' : '：误勾已撤销');
        return dispatchRef.current(payload, message);
      },
      onChange: setQueueState,
    });
    queue.current = writer;
    setQueueState(writer.snapshot());
    return () => { writer.dispose(); if (queue.current === writer) queue.current = null; };
    // A daily ledger can gain a real plan id after its first check; date is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.date]);
  useEffect(() => { queue.current?.sync(revision, confirmed); }, [revision, confirmed, queueState.pendingCount]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);

  function enqueue(doseId: string, checked: boolean) {
    if (unavailableForCheck || !queue.current) return;
    if (queue.current.set(doseId, checked)) { setInteracted(true); setError(''); setNotice(''); }
  }
  function change(row: SupplementChecklistRow, checked: boolean) {
    if (unavailableForCheck || row.dose.state === 'cancelled') return;
    enqueue(row.dose.id, checked);
  }
  async function readTimetable(file: File | undefined) {
    if (!file || unavailableForImport || importLocked.current) return;
    setReadingTimetable(true); setError(''); setNotice('');
    const importRevision = revision;
    try {
      if (file.size > 100000) throw new Error('时间表文件不能超过 100 KB。');
      const preview = parseSupplementTimetable(await file.text(), plan, items);
      setTimetable({ preview, revision: importRevision });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取补给时间表，请核对文件后再试。'); }
    finally { setReadingTimetable(false); if (timetableInput.current) timetableInput.current.value = ''; }
  }
  async function confirmTimetable() {
    if (!timetable || timetableStale || unavailableForImport || importLocked.current) return;
    importLocked.current = true; setSavingTimetable(true); setError(''); setNotice('');
    const message = '补给时间表已合并；没有自动标记服用，已有实际报告仍保留。';
    try {
      const success = await mutate('revise_unconsumed_meals', { planId: timetable.preview.planId, confirmed: true, supplementDoses: timetable.preview.supplementDoses, expectedRevision: timetable.revision }, message);
      if (success) { setTimetable(null); setNotice('时间表已导入'); }
      else setError('未确认导入成功，请刷新核对后重新选择文件。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '未确认导入成功，请刷新核对后重试。'); }
    finally { importLocked.current = false; setSavingTimetable(false); }
  }
  async function saveRoutine() {
    if (!routineSourcePlanId || unavailableForImport || importLocked.current) return;
    importLocked.current = true; setSavingRoutine(true); setError(''); setNotice('');
    try {
      const success = await mutate('save_supplement_routine', { sourcePlanId: routineSourcePlanId, confirmed: true, expectedRevision: revision }, '每天常用补给安排已保存');
      if (success) setNotice('每天常用安排已更新');
      else setError('未确认常用安排保存成功，请刷新核对后重试。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '未确认常用安排保存成功，请刷新核对。'); }
    finally { importLocked.current = false; setSavingRoutine(false); }
  }

  return <section className="supp-checklist" aria-labelledby={headingId}>
    <header className="supp-checklist-heading"><h2 id={headingId}><Pill size={19}/>每日补给</h2><span className={'supp-save-status' + (queueState.pendingCount ? ' is-pending' : '')} role="status" aria-live="polite">{queueState.blocked ? '有改动未保存' : queueState.pendingCount ? <><Loader2 size={13} className="spin"/>正在保存…</> : interacted ? <><Check size={14}/>已保存</> : typeCount + ' 种'}</span></header>
    {plan.inventoryAccounting === 'pending_reconciliation' && <p className="supp-accounting-note" role="status">服用记录已保存，库存待核对</p>}
    {readOnly && <p className="supp-checklist-readonly">这里只查看已保留的记录。</p>}
    {queueState.blocked && <div className="supp-queue-error" role="alert"><p>未确认保存成功，未保存的勾选已还原。请刷新核对后再勾选。</p><div><button type="button" onClick={() => window.location.reload()}>刷新核对</button></div></div>}
    {error && <p className="supp-checklist-error" role="alert">{error}</p>}
    {notice && <p className="supp-checklist-notice" role="status">{notice}</p>}
    {checklist.groups.length ? <div className="supp-slot-list">{checklist.groups.map(group => <section className="supp-slot" key={group.id} aria-label={slotLabels[group.id] || group.label}><header><h3>{slotLabels[group.id] || group.label}</h3></header><div className="supp-slot-rows">{group.rows.map(row => {
      const checked = queueState.checked[row.dose.id] ?? row.checked;
      return <SupplementRow key={row.dose.id} row={row} checked={checked} pending={queueState.pendingDoseIds.includes(row.dose.id)} disabled={unavailableForCheck || row.dose.state === 'cancelled'} onChange={next => change(row, next)}/>;
    })}</div></section>)}</div> : <p className="supp-checklist-empty">这一天还没有补给安排。</p>}
    <details className="supp-more"><summary>更多操作与说明<ChevronDown size={14}/></summary><div><p>勾选只记录这一剂次。可选、按需项目由你当天决定，用量未报时保持未知。</p><p>切换日期后，刚才的勾选会继续保存到原来的日期。</p>{plan.inventoryAccounting === 'pending_reconciliation' && <details className="supp-accounting-details"><summary>库存核对详情</summary>{plan.accountingIssues?.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}{routineSourcePlanId && <div className="supp-routine-action"><button type="button" className="supp-import-button" disabled={unavailableForImport} onClick={() => void saveRoutine()}>{savingRoutine ? <Loader2 size={16} className="spin"/> : null}设为每天常用安排</button><p>仅更新以后默认安排，已服记录保留。</p></div>}<button type="button" className="supp-import-button" disabled={unavailableForImport || !items.length} onClick={() => timetableInput.current?.click()}>{readingTimetable ? <Loader2 size={16} className="spin"/> : <Upload size={16}/>}导入补给时间表</button></div></details>
    <input type="file" ref={timetableInput} accept="application/json,.json" hidden aria-label="选择补给时间表文件" onChange={event => void readTimetable(event.target.files?.[0])}/>
    {timetable && <TimetableImportDialog preview={timetable.preview} stale={timetableStale} busy={busy || savingTimetable} error={error} close={() => setTimetable(null)} confirm={() => void confirmTimetable()}/>}
  </section>;
}

function SupplementRow({ row, checked, pending, disabled, onChange }: { row: SupplementChecklistRow; checked: boolean; pending: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const dose = row.dose, checkId = useId();
  const snapshot = dose.nutritionSnapshot as (NonNullable<ChecklistDose['nutritionSnapshot']> & { brand?: string }) | null;
  const name = doseName(dose), brand = snapshot?.brand?.trim();
  const positiveEntries = dose.actualEntries.filter(entry => entry.quantity === null || entry.quantity > 0);
  const actualMatches = row.checked && !row.unknownQuantity && positiveEntries.every(entry => entry.unit === dose.unit) && positiveEntries.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0) === dose.plannedQuantity;
  const checkLabel = row.unknownQuantity && checked ? '已服用，用量未报' : row.checked && checked && !actualMatches ? '已记录实际服用，详情可查看' : dose.plannedQuantity === null ? '已服用，用量未报' : '已按计划服用（' + quantityText(dose.plannedQuantity, dose.unit) + '）';
  const timing = [dose.plannedTime, dose.plannedTimeText].filter(Boolean).join(' · ');
  return <article className={'supp-row' + (checked ? ' is-checked' : '') + (dose.state === 'cancelled' ? ' is-cancelled' : '')}>
    <div className="supp-row-main">
      <label className="supp-checkbox-label" htmlFor={checkId}><input id={checkId} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} aria-label={name + '：' + checkLabel}/><span className="supp-custom-check" aria-hidden="true">{checked ? <Check size={17}/> : null}</span></label>
      <div className="supp-row-content"><div className="supp-row-title"><h4>{name}</h4><span className="supp-quantity">{quantityText(dose.plannedQuantity, dose.unit)}</span></div><div className="supp-row-meta">{timing && <span className="supp-short-time" title={timing}>{timing}</span>}{row.requirement !== 'daily' && <span className={'supp-requirement ' + row.requirement}>{SUPPLEMENT_REQUIREMENT_LABELS[row.requirement]}</span>}{dose.trainingDayOnly && <span>仅训练日</span>}{dose.state === 'cancelled' && <span>已取消</span>}{pending && <span className="supp-row-pending">待保存</span>}</div></div>
    </div>
    <details className="supp-row-details"><summary aria-label={'查看' + name + '的详情'}><ChevronDown size={16}/><span className="supp-sr-only">详情</span></summary><div className="supp-detail-content">
      {brand && !name.includes(brand) && <p>{brand}</p>}
      {(dose.plannedTime || dose.plannedTimeText) && <p><strong>安排时间</strong>{timing}</p>}
      {dose.instruction && <p>{dose.instruction}</p>}
      <p>{SUPPLEMENT_REQUIREMENT_LABELS[row.requirement]} · {row.scheduled ? '本日已安排' : row.checked ? '本日已记录' : '当天自行决定'}</p>
      {dose.plannedQuantity === null && <p>用量未报，勾选不会补写剂量。</p>}
      {row.checked && <p>实际时间：{dose.actualTime || dose.actualTimeText || '未记录具体时间'}{row.unknownQuantity ? ' · 实际用量未报' : ''}</p>}
      {snapshot?.supplementFacts && <div><strong>标签成分与每份剂量</strong><p>{snapshot.supplementFacts}</p></div>}
      {snapshot?.ingredients && <div><strong>配料与辅料</strong><p>{snapshot.ingredients}</p></div>}
      {(dose.actualEntries.length > 0 || dose.reportSourceText || dose.reportHistory.length > 0) && <details className="supp-report"><summary>实际报告与更正记录</summary>{dose.actualEntries.map(entry => <div key={entry.id}><strong>{entry.name || name} · {quantityText(entry.quantity, entry.unit)}</strong><p>{entry.sourceText || '未提供原话'}</p>{entry.correctionHistory.length > 0 && <details><summary>这条报告的 {entry.correctionHistory.length} 次更正</summary>{entry.correctionHistory.map((previous, index) => <div key={index}><strong>更正前 · {quantityText(previous.quantity, previous.unit)}</strong><p>{previous.sourceText || '未提供原话'}</p></div>)}</details>}</div>)}{dose.reportSourceText && <p>{dose.reportSourceText}</p>}{dose.reportHistory.length > 0 && <details><summary>历次剂次报告原话</summary>{dose.reportHistory.map((report, index) => <p key={index}>{report.sourceText || '本次未附原话'}{report.actualTime ? '\n实际时间：' + report.actualTime : report.actualTimeText ? '\n' + report.actualTimeText : ''}</p>)}</details>}</details>}
    </div></details>
  </article>;
}

function useSupplementDialogFocus(busy: boolean, close: () => void) {
  const box = useRef<HTMLDivElement>(null), closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; box.current?.focus();
    function keydown(event: globalThis.KeyboardEvent) { if (event.key === 'Escape' && !busy) closeRef.current(); }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [busy]);
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const buttons = box.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
    if (!buttons?.length) { event.preventDefault(); return; }
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return { box, trapFocus };
}

export function TimetableImportDialog({ preview, stale, busy, error, close, confirm }: { preview: SupplementTimetablePreview; stale: boolean; busy: boolean; error: string; close: () => void; confirm: () => void }) {
  const headingId = useId(), descriptionId = useId(), { box, trapFocus } = useSupplementDialogFocus(busy, close);
  return <div className="supp-undo-backdrop"><div className="supp-undo-dialog supp-import-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId} ref={box} tabIndex={-1} onKeyDown={trapFocus}>
    <header><h2 id={headingId}>确认补给时间表</h2><button type="button" aria-label="关闭时间表预览" disabled={busy} onClick={close}><X size={20}/></button></header>
    <p className="supp-import-date">{preview.date} · {preview.typeCount} 种补给 · {preview.rows.length} 个剂次</p>
    <p id={descriptionId}>只合并这份补给时间表，不改三餐，也不自动标记已服用。尚未勾选的仍为空，已有服用报告继续保留。</p>
    <p className="supp-import-merge">更新 {preview.updatedCount} 个现有剂次，新增 {preview.newCount} 个；未列入的 {preview.retainedCount} 个原有剂次会保留。</p>
    <div className="supp-import-preview" tabIndex={0} aria-label="补给时间表预览"><div className="supp-import-columns" aria-hidden="true"><span>补给</span><span>时段 / 时间</span><span>每次用量</span><span>当天安排</span></div>{preview.rows.map(row => <article className="supp-import-row" key={row.dose.id}>
      <div className="supp-import-name"><strong>{row.name}</strong>{row.brand && !row.name.includes(row.brand) && <small>{row.brand}</small>}<span>{row.existing ? '更新已有剂次' : '新增剂次'}</span></div>
      <div className="supp-import-timing"><strong>{row.timingLabel}</strong>{(row.dose.plannedTime || row.dose.plannedTimeText) && <small>{[row.dose.plannedTime, row.dose.plannedTimeText].filter(Boolean).join(' · ')}</small>}</div>
      <div className="supp-import-quantity"><small>每次用量</small><strong>{quantityText(row.dose.plannedQuantity, row.dose.unit)}</strong></div>
      <div className="supp-import-requirement"><span className={'supp-requirement ' + row.dose.requirement}>{SUPPLEMENT_REQUIREMENT_LABELS[row.dose.requirement]}</span><small>{row.dose.scheduled ? '已选入当天' : '本日未安排'}{row.dose.trainingDayOnly ? ' · 仅训练日' : ''}</small></div>
      {row.dose.instruction && <p>{row.dose.instruction}</p>}
    </article>)}</div>
    {stale && <p className="supp-checklist-error" role="alert">菜单或库存版本已经变化。请关闭预览，核对最新内容后重新选择文件。</p>}
    {error && <p className="supp-checklist-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>先不导入</button><button type="button" className="confirm" disabled={busy || stale} onClick={confirm}>{busy ? <Loader2 size={16} className="spin"/> : <Check size={16}/>}确认合并时间表</button></footer>
  </div></div>;
}
