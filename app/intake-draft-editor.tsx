"use client";

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { unitLabel, storageLabel } from '@/lib/english-display.mjs';
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
  onAddFood?: (mealId: string) => void;
};

const slots: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", other: "Other" };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const number = (value: number) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: 6 }).format(value);
const showUnit = (unit: string) => unitLabel(unit);
const amount = (value: number | null, unit: string) => finite(value) ? number(value) + ' ' + unitLabel(unit, value) : "Needs review";
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
  if (!finite(value?.value) || value?.partial) return "Incomplete";
  const n = value.value > 0 && value.value < (key === 'kcal' ? 1 : .1) ? '<' + (key === 'kcal' ? 1 : .1)
    : new Intl.NumberFormat('en-CA', { maximumFractionDigits: key === 'kcal' ? 0 : 1 }).format(value.value);
  return (value.estimated ? '≈ ' : '') + n;
}

export function IntakeProgressSummary({ totals }: { totals: DraftView['totals'] }) {
  return <div className="intake-progress-grid" aria-label="Intake and remaining food preview">{([
    ['planned', "Daily food"], ['eaten', "Consumed · including draft"], ['remaining', "Food remaining"],
  ] as const).map(([key, label]) => <div key={key} className={'intake-progress-card ' + key}>
    <span>{label}</span><strong>{totalValue(totals[key], 'kcal')}<small> kcal</small></strong>
    <p>Protein {totalValue(totals[key], 'protein')}g · Carbs {totalValue(totals[key], 'carbs')}g · Fat {totalValue(totals[key], 'fat')}g</p>
  </div>)}</div>;
}

export default function IntakeDraftEditor({ plan, items, revision, busy, error = '', mutate, refresh, onAddFood }: IntakeDraftEditorProps) {
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
    catch (cause) { return { value: base, error: cause instanceof Error ? cause.message : "Unable to preview this draft. Review the amounts." }; } }, [plan, items, draft, base]);
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
      transferOrigins.set(rowKey(moved.toMealId, intakeTransferLineId(plan.id, moved.id)), "From " + (from ? slots[from.slot] ?? from.title : "Original meal") );
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
      setNotice("Unsaved local inputs restored. Review and save the draft.");
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
    if (!valid) { setLocalError("Enter nonnegative numbers for consumed amounts."); return; }
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
    try { const checked = intakeDraftView(plan, items, next); if (!checked.canSubmit) { setLocalError(checked.issues[0]?.message || "Review the current draft before moving food."); return; } editDraft(next); setSelectedId(transfer.toMealId); setTransfer(null); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : "Unable to move this amount. Review the remaining quantity."); }
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
      const saved = await mutate('save_intake_draft', { ...savePayload, operationId: requestId('save_intake_draft', savePayload) }, "Intake draft saved; actual intake not submitted");
      if (!saved) { setLocalError("Draft save is unconfirmed; your inputs are retained. Refresh and review before retrying."); return; }
      const savedDraftVersion = intakeDraftVersion(pending);
      setCloudDraftBasis(savedDraftVersion);
      if (!submit) { dirtyRef.current = false; setDirty(false); clearLocalCopy(); setNotice("Draft saved; inventory unchanged."); return; }
      const submitPayload = { planId: plan.id, draftId: pending.id, baseFingerprint: pending.baseFingerprint, expectedDraftVersion: savedDraftVersion };
      const success = await mutate('submit_intake_draft', { ...submitPayload, operationId: requestId('submit_intake_draft', submitPayload) }, transferOnly ? "Meal allocation saved; no intake report added" : "Actual intake recorded");
      if (!success) { setLocalError(transferOnly ? "Draft retained; applying the allocation is unconfirmed. Refresh and review before retrying." : "Draft retained; intake submission is unconfirmed. Refresh and review to avoid duplicate records."); return; }
      dirtyRef.current = false; setDirty(false); setCloudDraftBasis(null); clearLocalCopy(); setInputs({}); setInvalidInputs({}); setNotice(transferOnly ? "Meal allocation saved; no intake report added." : "Intake recorded. You can continue entering cumulative consumed amounts.");
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : "Saving is unconfirmed. Refresh and review; your inputs are retained."); }
    finally { writeLocked.current = false; setWriting(false); }
  }
  async function discard() {
    if (blocked || writeLocked.current) return;
    writeLocked.current = true; setWriting(true); setLocalError('');
    try {
      if (draftConflict) {
        dirtyRef.current = false; setDirty(false); clearLocalCopy(); setDraft(editorDraft(base)); setCloudDraftBasis(base.draftVersion);
        setInputs({}); setInvalidInputs({}); setTransfer(null); setNotice("Local changes discarded and latest draft loaded. The saved draft and intake records were not deleted."); return;
      }
      if (hasDraft) {
        const payload = { planId: plan.id, draftId: base.draft?.id, expectedDraftVersion: expectedDraftVersionRef.current };
        const success = await mutate('discard_intake_draft', { ...payload, operationId: requestId('discard_intake_draft', payload) }, "Intake draft discarded; reported intake retained");
        if (!success) { setLocalError("Discarding the draft is unconfirmed. Refresh and review."); return; }
      }
      dirtyRef.current = false; setDirty(false); setCloudDraftBasis(null); clearLocalCopy(); setDraft(freshDraft(base)); setInputs({}); setInvalidInputs({}); setTransfer(null); setNotice("Draft discarded. Reported intake was not changed.");
    } finally { writeLocked.current = false; setWriting(false); }
  }

  async function addFood() {
    if (!onAddFood || !selected || blocked || stale || draftConflict) return;
    if (dirtyRef.current) { await write(false); if (dirtyRef.current) return; }
    onAddFood(selected.id);
  }

  return <section className="intake-editor" aria-labelledby={headingId}>
    <header className="intake-editor-heading"><div><span className="eyebrow">Distribute food around actual intake</span><h2 id={headingId}>Intake draft</h2><p>Enter total amounts consumed so far and move leftovers to other meals. Saving a draft does not deduct inventory.</p></div><span className={'intake-save-status' + (dirty ? ' is-dirty' : '')} role="status">{writing ? "Saving…" : dirty ? "Unsaved changes" : hasDraft ? "Draft saved" : "No draft entered"}</span></header>
    <IntakeProgressSummary totals={view.totals}/>
    {readOnly && <p className="intake-readonly">This day is cancelled. These records are read-only.</p>}
    {transfersClosed && <p className="intake-readonly">Remaining plans are closed. You can review or correct reported amounts, but cannot redistribute uneaten food.</p>}
    {plan.inventoryAccounting === 'pending_reconciliation' && <div className="intake-warning" role="status"><strong>Intake saved; ingredient accounting needs review</strong>{plan.accountingIssues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    {stale && <div className="intake-warning" role="alert"><strong>The menu or intake records changed elsewhere</strong><p>Local inputs are retained and will not overwrite newer records. Refresh to review, or discard the draft to start over.</p><button type="button" className="button secondary small" disabled={blocked} onClick={() => void refresh()}>Refresh and review</button></div>}
    {draftConflict && <div className="intake-warning" role="alert"><strong>{expectedDraftVersion === undefined ? "These local inputs have no saved draft version" : "The intake draft changed elsewhere"}</strong><p>Local inputs are retained and cannot overwrite the saved draft. Refresh to review, or discard local changes and load the latest draft.</p><button type="button" className="button secondary small" disabled={blocked} onClick={() => void refresh()}>Refresh and review</button></div>}
    {feedback && <p className="intake-error" role="alert">{feedback}</p>}
    {notice && <p className="intake-notice" role="status">{notice}</p>}
    <div className="intake-meal-tabs" role="group" aria-label="Choose intake meal">{view.meals.map(meal => <button type="button" key={meal.id} aria-pressed={meal.id === selected?.id} onClick={() => setSelectedId(meal.id)}><strong>{slots[meal.slot] ?? "Other"}</strong><small>{meal.completed ? "Finished" : "Open for intake"}</small></button>)}</div>
    {selected ? <section className="panel intake-meal-panel" aria-label={(slots[selected.slot] ?? "This meal") + " intake editor"}>
      <div className="intake-meal-heading"><div><span>{slots[selected.slot] ?? "This meal"}</span><h3>{selected.title}</h3><p>{nextMeal ? "Next meal: " + (slots[nextMeal.slot] ?? nextMeal.title) : "Last meal of the day"} · Enter total consumed so far</p></div><button type="button" className="button secondary small" disabled={blocked || stale || transfersClosed || !incoming.length} onClick={openIncoming}><ArrowLeftRight size={15}/>Move in from another meal</button></div>
      <div className="intake-row-heading" aria-hidden="true"><span>Food</span><span>Meal plan</span><span>Consumed so far</span><span>Meal remainder</span><span/></div>
      <ul className="intake-food-list">{selected.rows.map(row => {
        const key = rowKey(selected.id, row.lineId);
        const origin = transferOrigins.get(key);
        const consumed = draft.consumed.find(entry => entry.mealId === selected.id && entry.lineId === row.lineId);
        const input = inputs[key] ?? (consumed && (!consumed.unit || consumed.unit === row.unit) && finite(consumed.quantity) ? String(consumed.quantity) : finite(row.eatenQuantity) ? String(row.eatenQuantity) : '');
        const correction = input.trim() !== '' && finite(Number(input)) && finite(row.externalReportedQuantity) && Number(input) < row.externalReportedQuantity;
        return <li className="intake-food-row" key={row.lineId}>
          <div className="intake-food-name"><strong>{row.name}</strong>{origin && <p>{origin}</p>}<p>Reported: {amount(row.reportedQuantity, row.unit)}</p>{row.issue && <p className="intake-row-issue">{row.issue}</p>}</div>
          <div className="intake-fixed-quantity"><span>Meal plan</span><strong>{amount(row.plannedQuantity, row.unit)}</strong></div>
          <div className="intake-amount-field"><label htmlFor={headingId + encodeURIComponent(key)}>Consumed so far</label><div><input id={headingId + encodeURIComponent(key)} aria-label={(slots[selected.slot] ?? "This meal") + ' ' + row.name + (origin ? " (" + origin + ")" : '') + " cumulative consumed amount"} type="number" min="0" step="any" inputMode="decimal" value={input} placeholder={row.unknown ? "Unreported" : '0'} disabled={blocked || stale || !row.canEdit} onChange={event => editAmount(selected, row, event.target.value)}/><span>{showUnit(row.unit)}</span></div>{correction && <label className="intake-correction"><input type="checkbox" checked={consumed?.correctExistingActuals === true} disabled={blocked || stale} onChange={event => editAmount(selected, row, input, event.target.checked)}/><span>This corrects a previously reported amount</span></label>}</div>
          <div className="intake-fixed-quantity intake-remaining"><span>Meal remainder</span><strong>{amount(row.remainingQuantity, row.unit)}</strong></div>
          <button type="button" className="intake-transfer-button" disabled={blocked || stale || transfersClosed || !row.canEdit || !finite(row.remainingQuantity) || row.remainingQuantity <= 0 || view.meals.length < 2} onClick={() => openTransfer(selected, row)}><ArrowLeftRight size={15}/>Save for another meal</button>
        </li>;
      })}</ul>
      {onAddFood && <button type="button" className="button secondary small" disabled={blocked || stale || draftConflict || transfersClosed || selected.state === 'cancelled' || hasInvalid} onClick={() => void addFood()} aria-label={"Add inventory food to " + (slots[selected.slot] ?? "This meal")}>{dirty ? "Save draft and add from inventory" : "＋ Add from inventory"}</button>}
      {!selected.rows.length && <p className="intake-empty">This meal has no food yet. Add from inventory or move food from another meal.</p>}
      <label className="intake-completed"><input type="checkbox" checked={plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed') || draft.completedMealIds.includes(selected.id)} disabled={blocked || stale || plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed')} onChange={event => changeCompleted(selected.id, event.target.checked)}/><span><strong>{plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed') ? "This meal was reported finished" : "This meal is finished"}</strong><small>{plan.meals.some(meal => meal.id === selected.id && meal.state === 'completed') ? "The saved completion state is retained. You can still review actual amounts." : "Leave unchecked if you are still eating this meal."}</small></span></label>
    </section> : <div className="panel intake-empty">No editable menu ingredients for this date.</div>}
    <details className="panel intake-day-remaining"><summary>View remaining daily ingredients<ChevronDown size={16}/></summary><ul>{view.dayRows.map((row, index) => <li key={row.itemId + ':' + row.name + ':' + row.unit + ':' + index}><strong>{row.name}</strong><span>Planned: {amount(row.plannedQuantity, row.unit)}</span><span>Reported and draft: {amount(row.eatenQuantity, row.unit)}</span><b>Remaining: {amount(row.remainingQuantity, row.unit)}</b></li>)}</ul><p>Based only on this daily menu and entered progress. Unknown quantities are not zero.</p></details>
    {!view.canSubmit && hasEdits && view.issues.length > 0 && <div className="intake-warning" role="alert">{view.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    <div className="intake-save-bar"><div><p><strong>{transferOnly ? "Save the draft first, or apply this meal allocation." : "Save the draft first, or explicitly record intake."}</strong></p><small>{dirty ? "Save the draft before switching dates or leaving." : transferOnly ? "Only changes meal allocations; does not report intake or deduct inventory." : "Submitting settles actual intake. Meal transfers preserve daily ingredient totals."}</small></div><div><button type="button" className="button intake-discard" disabled={blocked || !hasDraft && !dirty} onClick={() => void discard()}><Trash2 size={15}/>{draftConflict ? "Discard local changes" : "Discard draft"}</button><button type="button" className="button secondary" disabled={!canWrite || !hasEdits} onClick={() => void write(false)}><Save size={16}/>Save draft</button><button type="button" className="button primary" disabled={!canWrite || !view.canSubmit || !view.hasChanges} onClick={() => void write(true)}>{writing ? <Loader2 size={16} className="spin"/> : <Check size={16}/>} {transferOnly ? "Apply allocation" : "Record this intake"}</button></div></div>
    {view.issues.length > 0 && <details className="intake-issues"><summary>Draft review notes</summary>{view.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}
    {transfer && <div className="modal-backdrop intake-transfer-backdrop"><div className="modal intake-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby={transferHeadingId} tabIndex={-1} ref={dialogRef}>
      <div className="modal-header"><div><span className="eyebrow">Move uneaten food only</span><h2 id={transferHeadingId}>{transfer.mode === 'in' ? "Move in from another meal" : "Save for another meal"}</h2></div><button type="button" className="icon-button" aria-label="Close meal transfer" onClick={() => setTransfer(null)}><X size={20}/></button></div>
      <div className="modal-body"><p className="intake-transfer-help">Eating food from a later meal? Move it here first, then enter the cumulative consumed amount.</p>
        {transfer.mode === 'in' ? <label className="field">Food to move in<select aria-label="Choose incoming food" value={rowKey(transfer.fromMealId, transfer.lineId)} onChange={event => { const [mealId, lineId] = JSON.parse(event.target.value) as string[]; const choice = incoming.find(entry => entry.meal.id === mealId && entry.row.lineId === lineId); if (choice) setTransfer({ ...transfer, fromMealId: mealId, lineId, amount: String(choice.row.remainingQuantity) }); }}>{incoming.map(({ meal, row }) => <option key={rowKey(meal.id, row.lineId)} value={rowKey(meal.id, row.lineId)}>{slots[meal.slot]} · {row.name}(remaining: {amount(row.remainingQuantity, row.unit)})</option>)}</select></label> : <div className="intake-transfer-source"><strong>{sourceRow?.name}</strong><span>{sourceMeal && slots[sourceMeal.slot]} · Remaining: {sourceRow ? amount(sourceRow.remainingQuantity, sourceRow.unit) : "Needs review"}</span></div>}
        <label className="field">Destination meal<select aria-label="Choose target meal" value={transfer.toMealId} disabled={transfer.mode === 'in'} onChange={event => setTransfer({ ...transfer, toMealId: event.target.value })}>{view.meals.filter(meal => meal.id !== transfer.fromMealId && meal.state !== 'cancelled').map(meal => <option key={meal.id} value={meal.id}>{slots[meal.slot] ?? meal.title}</option>)}</select></label>
        <label className="field">Amount to move ({sourceRow ? showUnit(sourceRow.unit) : ''})<input aria-label="Amount to move" type="number" inputMode="decimal" min="0" step="any" max={sourceRow?.remainingQuantity ?? undefined} value={transfer.amount} onChange={event => setTransfer({ ...transfer, amount: event.target.value })}/><small>Cannot exceed the uneaten amount. This only adds a draft transfer; the daily total is not increased.</small></label>
        <label className="intake-completed"><input type="checkbox" checked={transfer.recordEaten === true} onChange={event => setTransfer({ ...transfer, recordEaten: event.target.checked })}/><span><strong>This incoming amount has already been eaten</strong><small>{targetCompleted ? "The target meal is finished. Explicitly confirm that this amount was also eaten." : "Leave unchecked if not eaten. You can enter the actual amount in the target meal later."} Actual intake is submitted only when you click Record this intake.</small></span></label>
      </div><div className="modal-footer"><button type="button" className="button secondary" onClick={() => setTransfer(null)}>Cancel</button><button type="button" className="button primary" disabled={!validTransfer} onClick={addTransfer}>Add draft transfer</button></div>
    </div></div>}
  </section>;
}
