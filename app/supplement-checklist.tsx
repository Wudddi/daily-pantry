"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { unitLabel, storageLabel } from '@/lib/english-display.mjs';
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

const formatNumber = (value: number) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: 6 }).format(value);
const quantityText = (quantity: number | null, unit: string) => quantity === null ? "Amount unreported" : formatNumber(quantity) + ' ' + unitLabel(unit, quantity);
const doseName = (dose: ChecklistDose) => dose.nutritionSnapshot?.name || dose.itemId;
const slotLabels: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", pre_workout: "Before training", post_workout: "After training", dinner: "Dinner", bedtime: "Bedtime", other: "Flexible time" };

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
        const message = payload.date + ' · ' + (dose ? doseName(dose) : "Supplements") + (payload.checked ? ": intake recorded" : ": accidental check undone");
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
      if (file.size > 100000) throw new Error("The schedule file must be under 100 KB.");
      const preview = parseSupplementTimetable(await file.text(), plan, items);
      setTimetable({ preview, revision: importRevision });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to read the supplement schedule. Check the file and try again."); }
    finally { setReadingTimetable(false); if (timetableInput.current) timetableInput.current.value = ''; }
  }
  async function confirmTimetable() {
    if (!timetable || timetableStale || unavailableForImport || importLocked.current) return;
    importLocked.current = true; setSavingTimetable(true); setError(''); setNotice('');
    const message = "Supplement schedule merged. No doses were marked taken; existing intake reports were retained.";
    try {
      const success = await mutate('revise_unconsumed_meals', { planId: timetable.preview.planId, confirmed: true, supplementDoses: timetable.preview.supplementDoses, expectedRevision: timetable.revision }, message);
      if (success) { setTimetable(null); setNotice("Schedule imported"); }
      else setError("Import is unconfirmed. Refresh and review before selecting the file again.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import is unconfirmed. Refresh and review before retrying."); }
    finally { importLocked.current = false; setSavingTimetable(false); }
  }
  async function saveRoutine() {
    if (!routineSourcePlanId || unavailableForImport || importLocked.current) return;
    importLocked.current = true; setSavingRoutine(true); setError(''); setNotice('');
    try {
      const success = await mutate('save_supplement_routine', { sourcePlanId: routineSourcePlanId, confirmed: true, expectedRevision: revision }, "Daily supplement routine saved");
      if (success) setNotice("Daily routine updated");
      else setError("Routine save is unconfirmed. Refresh and review before retrying.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Routine save is unconfirmed. Refresh and review."); }
    finally { importLocked.current = false; setSavingRoutine(false); }
  }

  return <section className="supp-checklist" aria-labelledby={headingId}>
    <header className="supp-checklist-heading"><h2 id={headingId}><Pill size={19}/>Daily supplements</h2><span className={'supp-save-status' + (queueState.pendingCount ? ' is-pending' : '')} role="status" aria-live="polite">{queueState.blocked ? "Unsaved changes" : queueState.pendingCount ? <><Loader2 size={13} className="spin"/>Saving…</> : interacted ? <><Check size={14}/>Saved</> : typeCount + " types"}</span></header>
    {plan.inventoryAccounting === 'pending_reconciliation' && <p className="supp-accounting-note" role="status">Intake saved; inventory needs review</p>}
    {readOnly && <p className="supp-checklist-readonly">Saved records are read-only here.</p>}
    {queueState.blocked && <div className="supp-queue-error" role="alert"><p>Saving is unconfirmed. Unsaved checks were restored. Refresh and review before checking again.</p><div><button type="button" onClick={() => window.location.reload()}>Refresh and review</button></div></div>}
    {error && <p className="supp-checklist-error" role="alert">{error}</p>}
    {notice && <p className="supp-checklist-notice" role="status">{notice}</p>}
    {checklist.groups.length ? <div className="supp-slot-list">{checklist.groups.map(group => <section className="supp-slot" key={group.id} aria-label={slotLabels[group.id] || group.label}><header><h3>{slotLabels[group.id] || group.label}</h3></header><div className="supp-slot-rows">{group.rows.map(row => {
      const checked = queueState.checked[row.dose.id] ?? row.checked;
      return <SupplementRow key={row.dose.id} row={row} checked={checked} pending={queueState.pendingDoseIds.includes(row.dose.id)} disabled={unavailableForCheck || row.dose.state === 'cancelled'} onChange={next => change(row, next)}/>;
    })}</div></section>)}</div> : <p className="supp-checklist-empty">No supplements scheduled for this date.</p>}
    <details className="supp-more"><summary>More actions and notes<ChevronDown size={14}/></summary><div><p>Checking records this dose only. Optional and as-needed doses are your choice; unreported amounts remain unknown.</p><p>After switching dates, your check will continue saving to its original date.</p>{plan.inventoryAccounting === 'pending_reconciliation' && <details className="supp-accounting-details"><summary>Inventory review details</summary>{plan.accountingIssues?.map((issue, index) => <p key={index}>{issue.message}</p>)}</details>}{routineSourcePlanId && <div className="supp-routine-action"><button type="button" className="supp-import-button" disabled={unavailableForImport} onClick={() => void saveRoutine()}>{savingRoutine ? <Loader2 size={16} className="spin"/> : null}Set as daily routine</button><p>Updates future defaults only; reported doses are retained.</p></div>}<button type="button" className="supp-import-button" disabled={unavailableForImport || !items.length} onClick={() => timetableInput.current?.click()}>{readingTimetable ? <Loader2 size={16} className="spin"/> : <Upload size={16}/>}Import supplement schedule</button></div></details>
    <input type="file" ref={timetableInput} accept="application/json,.json" hidden aria-label="Choose supplement schedule file" onChange={event => void readTimetable(event.target.files?.[0])}/>
    {timetable && <TimetableImportDialog preview={timetable.preview} stale={timetableStale} busy={busy || savingTimetable} error={error} close={() => setTimetable(null)} confirm={() => void confirmTimetable()}/>}
  </section>;
}

function SupplementRow({ row, checked, pending, disabled, onChange }: { row: SupplementChecklistRow; checked: boolean; pending: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const dose = row.dose, checkId = useId();
  const snapshot = dose.nutritionSnapshot as (NonNullable<ChecklistDose['nutritionSnapshot']> & { brand?: string }) | null;
  const name = doseName(dose), brand = snapshot?.brand?.trim();
  const positiveEntries = dose.actualEntries.filter(entry => entry.quantity === null || entry.quantity > 0);
  const actualMatches = row.checked && !row.unknownQuantity && positiveEntries.every(entry => entry.unit === dose.unit) && positiveEntries.reduce((sum, entry) => sum + (entry.quantity ?? 0), 0) === dose.plannedQuantity;
  const checkLabel = row.unknownQuantity && checked ? "Taken; amount unreported" : row.checked && checked && !actualMatches ? "Reported taken; details available" : dose.plannedQuantity === null ? "Taken; amount unreported" : "Taken as planned (" + quantityText(dose.plannedQuantity, dose.unit) + ")";
  const timing = [dose.plannedTime, dose.plannedTimeText].filter(Boolean).join(' · ');
  return <article className={'supp-row' + (checked ? ' is-checked' : '') + (dose.state === 'cancelled' ? ' is-cancelled' : '')}>
    <div className="supp-row-main">
      <label className="supp-checkbox-label" htmlFor={checkId}><input id={checkId} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} aria-label={name + ": " + checkLabel}/><span className="supp-custom-check" aria-hidden="true">{checked ? <Check size={17}/> : null}</span></label>
      <div className="supp-row-content"><div className="supp-row-title"><h4>{name}</h4><span className="supp-quantity">{quantityText(dose.plannedQuantity, dose.unit)}</span></div><div className="supp-row-meta">{timing && <span className="supp-short-time" title={timing}>{timing}</span>}{row.requirement !== 'daily' && <span className={'supp-requirement ' + row.requirement}>{SUPPLEMENT_REQUIREMENT_LABELS[row.requirement]}</span>}{dose.trainingDayOnly && <span>Training days only</span>}{dose.state === 'cancelled' && <span>Cancelled</span>}{pending && <span className="supp-row-pending">Pending save</span>}</div></div>
    </div>
    <details className="supp-row-details"><summary aria-label={"View " + name + " details"}><ChevronDown size={16}/><span className="supp-sr-only">Details</span></summary><div className="supp-detail-content">
      {brand && !name.includes(brand) && <p>{brand}</p>}
      {(dose.plannedTime || dose.plannedTimeText) && <p><strong>Scheduled time</strong>{timing}</p>}
      {dose.instruction && <p>{dose.instruction}</p>}
      <p>{SUPPLEMENT_REQUIREMENT_LABELS[row.requirement]} · {row.scheduled ? "Scheduled today" : row.checked ? "Recorded today" : "Your choice for this date"}</p>
      {dose.plannedQuantity === null && <p>Amount unreported; checking will not invent a dose.</p>}
      {row.checked && <p>Actual time: {dose.actualTime || dose.actualTimeText || "Exact time not recorded"}{row.unknownQuantity ? " · Actual amount unreported" : ''}</p>}
      {snapshot?.supplementFacts && <div><strong>Label ingredients and dose</strong><p>{snapshot.supplementFacts}</p></div>}
      {snapshot?.ingredients && <div><strong>Ingredients and excipients</strong><p>{snapshot.ingredients}</p></div>}
      {(dose.actualEntries.length > 0 || dose.reportSourceText || dose.reportHistory.length > 0) && <details className="supp-report"><summary>Intake reports and corrections</summary>{dose.actualEntries.map(entry => <div key={entry.id}><strong>{entry.name || name} · {quantityText(entry.quantity, entry.unit)}</strong><p>{entry.sourceText || "No original wording provided"}</p>{entry.correctionHistory.length > 0 && <details><summary>This report has {entry.correctionHistory.length} corrections</summary>{entry.correctionHistory.map((previous, index) => <div key={index}><strong>Before correction · {quantityText(previous.quantity, previous.unit)}</strong><p>{previous.sourceText || "No original wording provided"}</p></div>)}</details>}</div>)}{dose.reportSourceText && <p>{dose.reportSourceText}</p>}{dose.reportHistory.length > 0 && <details><summary>Original dose reports</summary>{dose.reportHistory.map((report, index) => <p key={index}>{report.sourceText || "No original wording included"}{report.actualTime ? "\nActual time: " + report.actualTime : report.actualTimeText ? '\n' + report.actualTimeText : ''}</p>)}</details>}</details>}
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
    <header><h2 id={headingId}>Confirm supplement schedule</h2><button type="button" aria-label="Close schedule preview" disabled={busy} onClick={close}><X size={20}/></button></header>
    <p className="supp-import-date">{preview.date} · {preview.typeCount} supplements · {preview.rows.length} doses</p>
    <p id={descriptionId}>Merges this supplement schedule only. Meals stay unchanged and doses are not marked taken. Unchecked doses stay blank; existing intake reports are retained.</p>
    <p className="supp-import-merge">Update {preview.updatedCount} existing doses, add {preview.newCount}; retain {preview.retainedCount} unlisted existing doses.</p>
    <div className="supp-import-preview" tabIndex={0} aria-label="Supplement schedule preview"><div className="supp-import-columns" aria-hidden="true"><span>Supplements</span><span>Time slot / time</span><span>Amount per dose</span><span>Daily selection</span></div>{preview.rows.map(row => <article className="supp-import-row" key={row.dose.id}>
      <div className="supp-import-name"><strong>{row.name}</strong>{row.brand && !row.name.includes(row.brand) && <small>{row.brand}</small>}<span>{row.existing ? "Update existing dose" : "Add dose"}</span></div>
      <div className="supp-import-timing"><strong>{row.timingLabel}</strong>{(row.dose.plannedTime || row.dose.plannedTimeText) && <small>{[row.dose.plannedTime, row.dose.plannedTimeText].filter(Boolean).join(' · ')}</small>}</div>
      <div className="supp-import-quantity"><small>Amount per dose</small><strong>{quantityText(row.dose.plannedQuantity, row.dose.unit)}</strong></div>
      <div className="supp-import-requirement"><span className={'supp-requirement ' + row.dose.requirement}>{SUPPLEMENT_REQUIREMENT_LABELS[row.dose.requirement]}</span><small>{row.dose.scheduled ? "Selected for this date" : "Not scheduled today"}{row.dose.trainingDayOnly ? " · Training days only" : ''}</small></div>
      {row.dose.instruction && <p>{row.dose.instruction}</p>}
    </article>)}</div>
    {stale && <p className="supp-checklist-error" role="alert">The menu or inventory version changed. Close the preview, review the latest records and select the file again.</p>}
    {error && <p className="supp-checklist-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>Not now</button><button type="button" className="confirm" disabled={busy || stale} onClick={confirm}>{busy ? <Loader2 size={16} className="spin"/> : <Check size={16}/>}Merge schedule</button></footer>
  </div></div>;
}
