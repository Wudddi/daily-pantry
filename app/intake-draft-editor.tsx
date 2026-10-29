"use client";

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, ChevronDown, Loader2, Save, Trash2, X } from 'lucide-react';
import type { DietPlan } from '@/lib/diet-types';
import type { FoodItem } from '@/lib/inventory-types';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import { intakeDraftVersion, intakeDraftView, intakeTransferLineId } from '@/lib/intake-draft.mjs';
import './intake-draft-editor.css';

type DraftConsumed = { mealId: string; lineId: string; quantity: number | null; unit?: string; correctExistingActuals?: boolean };
type DraftTransfer = { id: string; fromMealId: string; lineId: string; toMealId: string; quantity: number; unit?: string };
type EditorDraft = { id: string; baseFingerprint: string; consumed: DraftConsumed[]; transfers: DraftTransfer[]; completedMealIds: string[] };
type DraftView = ReturnType<typeof intakeDraftView>;
type ViewMeal = DraftView['meals'][number];
type ViewRow = ViewMeal['rows'][number];
type TransferForm = { mode: 'in' | 'out'; fromMealId: string; lineId: string; toMealId: string; amount: string; recordEaten?: boolean };
export type IntakeDraftEditorProps = {
  plan: DietPlan; items: FoodItem[]; revision: number; busy: boolean; error?: string;
  mutate: (action: string, payload: Record<string, unknown>, message: string) => Promise<boolean>;
  refresh: () => Promise<unknown>;
};

const slots: Record<string, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐', other: '其他' };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);
const showUnit = (unit: string) => unit.toLowerCase() === 'ml' ? 'mL' : unit;
const amount = (value: number | null, unit: string) => finite(value) ? number(value) + ' ' + showUnit(unit) : '待核对';
const rowKey = (mealId: string, lineId: string) => JSON.stringify([mealId, lineId]);
function freshDraft(view: DraftView): EditorDraft {
  return { id: crypto.randomUUID(), baseFingerprint: view.baseFingerprint, consumed: [], transfers: [], completedMealIds: [] };
}
function editorDraft(view: DraftView): EditorDraft {
  const source = view.draft;
  return source ? { id: source.id, baseFingerprint: source.baseFingerprint,
    consumed: source.consumed.map(entry => ({ ...entry })), transfers: source.transfers.map(entry => ({ ...entry })),
    completedMealIds: [...(source.completedMealIds ?? [])] } : freshDraft(view);
}
function totalValue(totals: readonly PlanNutritionTotal[], key: PlanNutritionTotal['key']) {
  const value = totals.find(total => total.key === key);
  if (!finite(value?.value) || value?.partial) return '待补齐';
  const n = value.value > 0 && value.value < (key === 'kcal' ? 1 : .1) ? '<' + (key === 'kcal' ? 1 : .1)
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: key === 'kcal' ? 0 : 1 }).format(value.value);
  return (value.estimated ? '≈ ' : '') + n;
}

export function IntakeProgressSummary({ totals }: { totals: DraftView['totals'] }) {
  return <div className="intake-progress-grid" aria-label="当天进食与剩余预览">{([
    ['planned', '全天食物'], ['eaten', '已吃 · 含草稿'], ['remaining', '食物还剩'],
  ] as const).map(([key, label]) => <div key={key} className={'intake-progress-card ' + key}>
    <span>{label}</span><strong>{totalValue(totals[key], 'kcal')}<small> kcal</small></strong>
    <p>蛋白 {totalValue(totals[key], 'protein')}g · 碳水 {totalValue(totals[key], 'carbs')}g · 脂肪 {totalValue(totals[key], 'fat')}g</p>
  </div>)}</div>;
}

export default function IntakeDraftEditor({ plan, items, revision, busy, error = '', mutate, refresh }: IntakeDraftEditorProps) {
  const base = useMemo(() => intakeDraftView(plan, items), [plan, items]);
  const [draft, setDraft] = useState<EditorDraft>(() => editorDraft(base));
  const [expectedDraftVersion, setExpectedDraftVersion] = useState<string | null | undefined>(base.draftVersion);
  const [dirty, setDirty] = useState(false), [writing, setWriting] = useState(false), [localError, setLocalError] = useState(''), [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState(base.meals[0]?.id ?? ''), [transfer, setTransfer] = useState<TransferForm | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({}), [invalidInputs, setInvalidInputs] = useState<Record<string, boolean>>({});
  const dirtyRef = useRef(false), writeLocked = useRef(false), requestRef = useRef(new Map<string, string>());
  const expectedDraftVersionRef = useRef<string | null | undefined>(base.draftVersion);
  const headingId = useId(), transferHeadingId = useId(), dialogRef = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => { try { return { value: intakeDraftView(plan, items, draft), error: '' }; }
    catch (cause) { return { value: base, error: cause instanceof Error ? cause.message : '当前草稿无法预览，请核对用量。' }; } }, [plan, items, draft, base]);
  const view = preview.value, selected = view.meals.find(meal => meal.id === selectedId) ?? view.meals[0];
  const readOnly = plan.status === 'cancelled', transfersClosed = plan.status === 'closed_with_actuals';
  const stale = view.stale || draft.baseFingerprint !== base.baseFingerprint;
  const draftConflict = expectedDraftVersion === undefined || expectedDraftVersion !== base.draftVersion;
  const blocked = busy || writing || readOnly, hasInvalid = Object.values(invalidInputs).some(Boolean);
  const canWrite = !blocked && !stale && !draftConflict && !preview.error && !hasInvalid;
  const hasDraft = base.hasDraft, hasEdits = dirty || view.hasChanges;
  const transferOnly = draft.transfers.length > 0 && draft.consumed.length === 0
    && !draft.completedMealIds.some(id => plan.meals.some(meal => meal.id === id && meal.state !== 'completed'));
  const feedback = error || localError || preview.error;
  const nextMeal = selected ? view.meals.slice(view.meals.findIndex(meal => meal.id === selected.id) + 1).find(meal => meal.state !== 'cancelled') : undefined;
  const storageKey = 'daily-pantry:intake-draft:' + plan.id + ':' + plan.date;
  const transferOrigins = new Map<string, string>();
  for (const source of [...(plan.intakeDraftAudit ?? []).map(entry => entry.draft), draft]) {
    for (const moved of source.transfers) {
      const from = view.meals.find(meal => meal.id === moved.fromMealId);
      transferOrigins.set(rowKey(moved.toMealId, intakeTransferLineId(plan.id, moved.id)), '从' + (from ? slots[from.slot] ?? from.title : '原餐次') + '调入');
    }
  }

  function setCloudDraftBasis(version: string | null | undefined) {
    expectedDraftVersionRef.current = version; setExpectedDraftVersion(version);
  }

  useEffect(() => {
    if (!dirtyRef.current && !writeLocked.current) {
      setDraft(editorDraft(base)); setCloudDraftBasis(base.draftVersion); setInputs({}); setInvalidInputs({});
    }
  }, [base, writing]);
  useEffect(() => {
    try {
      const value = sessionStorage.getItem(storageKey);
      if (!value || value.length > 200000) return;
      const restored = JSON.parse(value) as { draft?: EditorDraft; inputs?: Record<string, string>; invalidInputs?: Record<string, boolean>; expectedDraftVersion?: string | null };
      if (!restored.draft || typeof restored.draft.id !== 'string' || typeof restored.draft.baseFingerprint !== 'string'
        || !Array.isArray(restored.draft.consumed) || !Array.isArray(restored.draft.transfers) || !Array.isArray(restored.draft.completedMealIds)) return;
      dirtyRef.current = true; setDirty(true); setDraft(restored.draft);
      setCloudDraftBasis(restored.expectedDraftVersion === null || typeof restored.expectedDraftVersion === 'string' ? restored.expectedDraftVersion : undefined);
      setInputs(restored.inputs ?? {}); setInvalidInputs(restored.invalidInputs ?? {});
      setNotice('已恢复本机未保存的输入；核对后请保存草稿。');
    } catch { /* Session storage may be unavailable; explicit cloud save still works. */ }
  }, [storageKey]);
  useEffect(() => {
    if (!dirty) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ draft, inputs, invalidInputs, expectedDraftVersion })); } catch { /* Keep the in-memory edit. */ }
  }, [draft, inputs, invalidInputs, dirty, storageKey, expectedDraftVersion]);
  useEffect(() => {
    if (!transfer) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialogRef.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') setTransfer(null);
      if (event.key !== 'Tab') return;
      const fields = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])');
      if (!fields?.length) return;
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [!!transfer]);

  function editDraft(next: EditorDraft) {
    dirtyRef.current = true; setDirty(true); setDraft(next); setNotice(''); setLocalError('');
  }
  function editAmount(meal: ViewMeal, row: ViewRow, raw: string, correctExistingActuals?: boolean) {
    const key = rowKey(meal.id, row.lineId);
    setInputs(previous => ({ ...previous, [key]: raw }));
    const valid = raw.trim() === '' || finite(Number(raw));
    setInvalidInputs(previous => ({ ...previous, [key]: !valid }));
    if (!valid) { setLocalError('已吃量请填写非负数字。'); return; }
    const before = draft.consumed.find(entry => entry.mealId === meal.id && entry.lineId === row.lineId);
    const consumed = draft.consumed.filter(entry => entry.mealId !== meal.id || entry.lineId !== row.lineId);
    if (raw.trim() !== '') consumed.push({ mealId: meal.id, lineId: row.lineId, quantity: Number(raw), unit: row.unit,
      ...((correctExistingActuals ?? before?.correctExistingActuals) ? { correctExistingActuals: true } : {}) });
    editDraft({ ...draft, consumed });
  }
  function changeCompleted(mealId: string, checked: boolean) {
    editDraft({ ...draft, completedMealIds: checked ? [...new Set([...draft.completedMealIds, mealId])]
      : draft.completedMealIds.filter(id => id !== mealId) });
  }
  function openTransfer(meal: ViewMeal, row: ViewRow) {
    const target = view.meals.find(entry => entry.id !== meal.id && entry.id === nextMeal?.id)
      ?? view.meals.find(entry => entry.id !== meal.id && entry.state !== 'cancelled');
    if (!target || !finite(row.remainingQuantity) || row.remainingQuantity <= 0) return;
    setTransfer({ mode: 'out', fromMealId: meal.id, lineId: row.lineId, toMealId: target.id, amount: String(row.remainingQuantity) });
  }
  const incoming = selected && selected.state !== 'cancelled' ? view.meals.filter(meal => meal.id !== selected.id && meal.state !== 'cancelled').flatMap(meal => meal.rows
    .filter(row => row.canEdit && finite(row.remainingQuantity) && row.remainingQuantity > 0).map(row => ({ meal, row }))) : [];
  function openIncoming() {
    const first = incoming.find(entry => entry.meal.id === nextMeal?.id) ?? incoming[0];
    if (!first || !selected) return;
    setTransfer({ mode: 'in', fromMealId: first.meal.id, lineId: first.row.lineId, toMealId: selected.id, amount: String(first.row.remainingQuantity) });
  }
  const sourceMeal = transfer ? view.meals.find(meal => meal.id === transfer.fromMealId) : undefined;
  const sourceRow = sourceMeal?.rows.find(row => row.lineId === transfer?.lineId);
  const targetCompleted = !!transfer && plan.meals.some(meal => meal.id === transfer.toMealId && meal.state === 'completed');
  const transferNumber = transfer?.amount.trim() ? Number(transfer.amount) : NaN;
  const validTransfer = !!sourceRow && finite(transferNumber) && transferNumber > 0 && finite(sourceRow.remainingQuantity)
    && transferNumber <= sourceRow.remainingQuantity && transfer?.fromMealId !== transfer?.toMealId && (!targetCompleted || transfer.recordEaten === true);
  function addTransfer() {
    if (!transfer || !sourceRow || !validTransfer) return;
    const transferId = crypto.randomUUID();
    const next: EditorDraft = { ...draft, transfers: [...draft.transfers, { id: transferId, fromMealId: transfer.fromMealId,
      lineId: transfer.lineId, toMealId: transfer.toMealId, quantity: transferNumber, unit: sourceRow.unit }] };
    if (transfer.recordEaten) next.consumed = [...next.consumed, { mealId: transfer.toMealId,
      lineId: intakeTransferLineId(plan.id, transferId), quantity: transferNumber, unit: sourceRow.unit }];
    try { const checked = intakeDraftView(plan, items, next); if (!checked.canSubmit) { setLocalError(checked.issues[0]?.message || '请先核对当前草稿，再调配食物。'); return; } editDraft(next); setSelectedId(transfer.toMealId); setTransfer(null); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : '无法调配这部分，请核对剩余量。'); }
  }
  function requestId(action: string, payload: Record<string, unknown>) {
    const key = JSON.stringify([action, payload]);
    let id = requestRef.current.get(key);
    if (!id) {
      id = crypto.randomUUID(); requestRef.current.set(key, id);
      if (requestRef.current.size > 24) requestRef.current.delete(requestRef.current.keys().next().value!);
    }
    return id;
  }
  function clearLocalCopy() { try { sessionStorage.removeItem(storageKey); } catch { /* Cloud state is authoritative. */ } }
  async function write(submit: boolean) {
    if (!canWrite || writeLocked.current || submit && !view.canSubmit) return;
    writeLocked.current = true; setWriting(true); setLocalError(''); setNotice('');
    const pending = structuredClone(draft);
    try {
      const savePayload = { planId: plan.id, draft: pending, expectedDraftVersion: expectedDraftVersionRef.current };
      const saved = await mutate('save_intake_draft', { ...savePayload, operationId: requestId('save_intake_draft', savePayload) }, '进食草稿已保存，尚未记录实际');
      if (!saved) { setLocalError('未确认草稿保存成功，输入仍保留。请刷新核对后再试。'); return; }
      const savedDraftVersion = intakeDraftVersion(pending);
      setCloudDraftBasis(savedDraftVersion);
      if (!submit) { dirtyRef.current = false; setDirty(false); clearLocalCopy(); setNotice('草稿已保存，尚未扣库存。'); return; }
      const submitPayload = { planId: plan.id, draftId: pending.id, baseFingerprint: pending.baseFingerprint, expectedDraftVersion: savedDraftVersion };
      const success = await mutate('submit_intake_draft', { ...submitPayload, operationId: requestId('submit_intake_draft', submitPayload) }, transferOnly ? '餐次调配已保存，未新增进食记录' : '已记录这些实际进食');
      if (!success) { setLocalError(transferOnly ? '草稿已保留，尚未确认餐次调配应用成功。请刷新核对后再试。' : '草稿已保留，尚未确认实际提交成功。请刷新核对，避免重复记录。'); return; }
      dirtyRef.current = false; setDirty(false); setCloudDraftBasis(null); clearLocalCopy(); setInputs({}); setInvalidInputs({}); setNotice(transferOnly ? '餐次调配已保存，未新增进食记录。' : '已记录这些实际进食，可继续填写累计已吃量。');
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : '未确认保存成功，请刷新核对；输入仍保留。'); }
    finally { writeLocked.current = false; setWriting(false); }
  }
  async function discard() {
    if (blocked || writeLocked.current) return;
    writeLocked.current = true; setWriting(true); setLocalError('');
    try {
      if (draftConflict) {
        dirtyRef.current = false; setDirty(false); clearLocalCopy(); setDraft(editorDraft(base)); setCloudDraftBasis(base.draftVersion);
        setInputs({}); setInvalidInputs({}); setTransfer(null); setNotice('已放弃本机修改并载入最新草稿，云端草稿和实际记录均未删除。'); return;
      }
      if (hasDraft) {
        const payload = { planId: plan.id, draftId: base.draft?.id, expectedDraftVersion: expectedDraftVersionRef.current };
        const success = await mutate('discard_intake_draft', { ...payload, operationId: requestId('discard_intake_draft', payload) }, '进食草稿已放弃，实际记录保留');
        if (!success) { setLocalError('未确认草稿已放弃，请刷新核对。'); return; }
      }
      dirtyRef.current = false; setDirty(false); setCloudDraftBasis(null); clearLocalCopy(); setDraft(freshDraft(base)); setInputs({}); setInvalidInputs({}); setTransfer(null); setNotice('草稿已放弃，已记录的实际进食没有改动。');
    } finally { writeLocked.current = false; setWriting(false); }
  }

  return <section className="intake-editor" aria-labelledby={headingId}>
    <header className="intake-editor-heading"><div><span className="eyebrow">按实际进度灵活分餐</span><h2 id={headingId}>进食草稿</h2><p>填累计已吃量，剩下的可留到其他餐；保存草稿不会扣库存。</p></div><span className={'intake-save-status' + (dirty ? ' is-dirty' : '')} role="status">{writing ? '正在保存…' : dirty ? '有修改待保存' : hasDraft ? '草稿已保存' : '还未填写草稿'}</span></header>
    <IntakeProgressSummary totals={view.totals}/>
    {readOnly && <p className="intake-readonly">这一天已取消，这里仅供查看。</p>}
    {transfersClosed && <p className="intake-readonly">剩余计划已结束，仍可核对、更正已记录的实际用量；不再调整未吃部分的分餐。</p>}
    {plan.inventoryAccounting === 'pending_reconciliation' && <div className="intake-warning" role="status"><strong>实际记录已保存，库存仍待核对</strong>{plan.accountingIssues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    {stale && <div className="intake-warning" role="alert"><strong>菜单或实际记录已在别处更新</strong><p>本地输入先保留，暂不覆盖最新记录。请刷新核对；需要重新开始时可放弃这份草稿。</p><button type="button" className="button secondary small" disabled={blocked} onClick={() => void refresh()}>刷新核对</button></div>}
    {draftConflict && <div className="intake-warning" role="alert"><strong>{expectedDraftVersion === undefined ? '这份本机输入缺少云端版本依据' : '进食草稿已在别处更新'}</strong><p>本机输入已保留，不能直接覆盖云端。刷新核对后，可放弃本机修改并载入最新草稿。</p><button type="button" className="button secondary small" disabled={blocked} onClick={() => void refresh()}>刷新核对</button></div>}
    {feedback && <p className="intake-error" role="alert">{feedback}</p>}
    {notice && <p className="intake-notice" role="status">{notice}</p>}
    <div className="intake-meal-tabs" role="group" aria-label="选择进食餐次">{view.meals.map(meal => <button type="button" key={meal.id} aria-pressed={meal.id === selected?.id} onClick={() => setSelectedId(meal.id)}><strong>{slots[meal.slot] ?? '其他'}</strong><small>{meal.completed ? '已结束' : '可继续记录'}</small></button>)}</div>
    {selected ? <section className="panel intake-meal-panel" aria-label={(slots[selected.slot] ?? '本餐') + '进食编辑'}>
      <div className="intake-meal-heading"><div><span>{slots[selected.slot] ?? '本餐'}</span><h3>{selected.title}</h3><p>{nextMeal ? '下一餐：' + (slots[nextMeal.slot] ?? nextMeal.title) : '已是当天最后一个餐次'} · 已吃量填到目前为止的总量</p></div><button type="button" className="button secondary small" disabled={blocked || stale || transfersClosed || !incoming.length} onClick={openIncoming}><ArrowLeftRight size={15}/>从其他餐调入</button></div>
      <div className="intake-row-heading" aria-hidden="true"><span>食物</span><span>本餐安排</span><span>累计已吃</span><span>本餐还剩</span><span/></div>
      <ul className="intake-food-list">{selected.rows.map(row => {
        const key = rowKey(selected.id, row.lineId);
        const origin = transferOrigins.get(key);
        const consumed = draft.consumed.find(entry => entry.mealId === selected.id && entry.lineId === row.lineId);
        const input = inputs[key] ?? (consumed && (!consumed.unit || consumed.unit === row.unit) && finite(consumed.quantity) ? String(consumed.quantity) : finite(row.eatenQuantity) ? String(row.eatenQuantity) : '');
        const correction = input.trim() !== '' && finite(Number(input)) && finite(row.externalReportedQuantity) && Number(input) < row.externalReportedQuantity;
        return <li className="intake-food-row" key={row.lineId}>
          <div className="intake-food-name"><strong>{row.name}</strong>{origin && <p>{origin}</p>}<p>已记实际：{amount(row.reportedQuantity, row.unit)}</p>{row.issue && <p className="intake-row-issue">{row.issue}</p>}</div>
          <div className="intake-fixed-quantity"><span>本餐安排</span><strong>{amount(row.plannedQuantity, row.unit)}</strong></div>
          <div className="intake-amount-field"><label htmlFor={headingId + encodeURIComponent(key)}>累计已吃</label><div><input id={headingId + encodeURIComponent(key)} aria-label={(slots[selected.slot] ?? '本餐') + ' ' + row.name + (origin ? '（' + origin + '）' : '') + '累计已吃量'} type="number" min="0" step="any" inputMode="decimal" value={input} placeholder={row.unknown ? '未报' : '0'} disabled={blocked || stale || !row.canEdit} onChange={event => editAmount(selected, row, event.target.value)}/><span>{showUnit(row.unit)}</span></div>{correction && <label className="intake-correction"><input type="checkbox" checked={consumed?.correctExistingActuals === true} disabled={blocked || stale} onChange={event => editAmount(selected, row, input, event.target.checked)}/><span>这是对已记录用量的更正</span></label>}</div>
          <div className="intake-fixed-quantity intake-remaining"><span>本餐还剩</span><strong>{amount(row.remainingQuantity, row.unit)}</strong></div>
          <button type="button" className="intake-transfer-button" disabled={blocked || stale || transfersClosed || !row.canEdit || !finite(row.remainingQuantity) || row.remainingQuantity <= 0 || view.meals.length < 2} onClick={() => openTransfer(selected, row)}><ArrowLeftRight size={15}/>留到其他餐</button>
        </li>;
      })}</ul>
      {!selected.rows.length && <p className="intake-empty">这一餐暂时没有食物，可从其他餐调入未吃的部分。</p>}
      <label className="intake-completed"><input type="checkbox" checked={plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed') || draft.completedMealIds.includes(selected.id)} disabled={blocked || stale || plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed')} onChange={event => changeCompleted(selected.id, event.target.checked)}/><span><strong>{plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed') ? '这餐已记录结束' : '这餐已结束'}</strong><small>{plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed') ? '保留已保存的完成状态，仍可核对实际用量。' : '吃了一部分还会继续，就先不勾选。'}</small></span></label>
    </section> : <div className="panel intake-empty">这一天还没有可编辑的菜单食材。</div>}
    <details className="panel intake-day-remaining"><summary>查看全天各食材还剩多少<ChevronDown size={16}/></summary><ul>{view.dayRows.map((row, index) => <li key={row.itemId + ':' + row.name + ':' + row.unit + ':' + index}><strong>{row.name}</strong><span>安排 {amount(row.plannedQuantity, row.unit)}</span><span>已吃与草稿 {amount(row.eatenQuantity, row.unit)}</span><b>还剩 {amount(row.remainingQuantity, row.unit)}</b></li>)}</ul><p>仅按当天菜单和已填进度计算，未知量不算成零。</p></details>
    {!view.canSubmit && hasEdits && view.issues.length > 0 && <div className="intake-warning" role="alert">{view.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    <div className="intake-save-bar"><div><p><strong>{transferOnly ? '先保存草稿，或应用这次餐次调配。' : '先保存草稿，或明确记录已吃。'}</strong></p><small>{dirty ? '切换日期或离开前，请先保存草稿。' : transferOnly ? '只调整餐次，不新增进食记录，不扣库存。' : '记录后才结算实际；分餐调配保持全天食材总量。'}</small></div><div><button type="button" className="button intake-discard" disabled={blocked || !hasDraft && !dirty} onClick={() => void discard()}><Trash2 size={15}/>{draftConflict ? '放弃本机修改' : '放弃草稿'}</button><button type="button" className="button secondary" disabled={!canWrite || !hasEdits} onClick={() => void write(false)}><Save size={16}/>保存草稿</button><button type="button" className="button primary" disabled={!canWrite || !view.canSubmit || !view.hasChanges} onClick={() => void write(true)}>{writing ? <Loader2 size={16} className="spin"/> : <Check size={16}/>} {transferOnly ? '应用餐次调配' : '记录这些已吃'}</button></div></div>
    {view.issues.length > 0 && <details className="intake-issues"><summary>查看草稿核对说明</summary>{view.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}
    {transfer && <div className="modal-backdrop intake-transfer-backdrop"><div className="modal intake-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby={transferHeadingId} tabIndex={-1} ref={dialogRef}>
      <div className="modal-header"><div><span className="eyebrow">只调配尚未吃的部分</span><h2 id={transferHeadingId}>{transfer.mode === 'in' ? '从其他餐调入' : '留到其他餐'}</h2></div><button type="button" className="icon-button" aria-label="关闭转餐弹窗" onClick={() => setTransfer(null)}><X size={20}/></button></div>
      <div className="modal-body"><p className="intake-transfer-help">提前吃下一餐的食物，也可以先调到现在这一餐，再填写累计已吃量。</p>
        {transfer.mode === 'in' ? <label className="field">从哪项调入<select aria-label="选择调入食物" value={rowKey(transfer.fromMealId, transfer.lineId)} onChange={event => { const [mealId, lineId] = JSON.parse(event.target.value) as string[]; const choice = incoming.find(entry => entry.meal.id === mealId && entry.row.lineId === lineId); if (choice) setTransfer({ ...transfer, fromMealId: mealId, lineId, amount: String(choice.row.remainingQuantity) }); }}>{incoming.map(({ meal, row }) => <option key={rowKey(meal.id, row.lineId)} value={rowKey(meal.id, row.lineId)}>{slots[meal.slot]} · {row.name}（还剩 {amount(row.remainingQuantity, row.unit)}）</option>)}</select></label> : <div className="intake-transfer-source"><strong>{sourceRow?.name}</strong><span>{sourceMeal && slots[sourceMeal.slot]} · 还剩 {sourceRow ? amount(sourceRow.remainingQuantity, sourceRow.unit) : '待核对'}</span></div>}
        <label className="field">调到哪一餐<select aria-label="选择目标餐次" value={transfer.toMealId} disabled={transfer.mode === 'in'} onChange={event => setTransfer({ ...transfer, toMealId: event.target.value })}>{view.meals.filter(meal => meal.id !== transfer.fromMealId && meal.state !== 'cancelled').map(meal => <option key={meal.id} value={meal.id}>{slots[meal.slot] ?? meal.title}</option>)}</select></label>
        <label className="field">调配用量（{sourceRow ? showUnit(sourceRow.unit) : ''}）<input aria-label="调配用量" type="number" inputMode="decimal" min="0" step="any" max={sourceRow?.remainingQuantity ?? undefined} value={transfer.amount} onChange={event => setTransfer({ ...transfer, amount: event.target.value })}/><small>不能超过尚未吃的部分。这里只加入草稿，不会重复增加全天用量。</small></label>
        <label className="intake-completed"><input type="checkbox" checked={transfer.recordEaten === true} onChange={event => setTransfer({ ...transfer, recordEaten: event.target.checked })}/><span><strong>调入的这部分已经吃了</strong><small>{targetCompleted ? '目标餐已结束，需要明确确认这部分也已吃。' : '没吃先不勾；之后可以在目标餐填写实际量。'} 仍需点击“记录这些已吃”才提交实际。</small></span></label>
      </div><div className="modal-footer"><button type="button" className="button secondary" onClick={() => setTransfer(null)}>取消</button><button type="button" className="button primary" disabled={!validTransfer} onClick={addTransfer}>加入调配草稿</button></div>
    </div></div>}
  </section>;
}
