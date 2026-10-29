"use client";

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowRightLeft, Check, ChevronDown, Loader2, MoreHorizontal, X } from 'lucide-react';
import type { DietPlan } from '@/lib/diet-types';
import type { FoodItem } from '@/lib/inventory-types';
import type { PlanNutritionTotal } from '@/lib/diet-nutrition.mjs';
import { intakeDraftView } from '@/lib/intake-draft.mjs';
import { buildChecklistAction, canReceiveChecklistFood, groupChecklistRows, nextChecklistMealId, type ChecklistAction, type ChecklistGroup } from '@/lib/checklist-actions.mjs';
import { isPersonalFoodChecked } from '@/lib/personal-food-checklist.mjs';
import { personalFoodChecklistView } from '@/lib/personal-food-view.mjs';
import './day-food-checklist.css';

type Latest = { plan: DietPlan; items: FoodItem[]; revision: number };
export type DayFoodChecklistProps = Latest & {
  active?: boolean;
  busy: boolean; error?: string; mutate: (action: string, payload: Record<string, unknown>, message: string) => Promise<boolean>;
  refresh: () => Promise<unknown>; getLatest?: () => Latest | null; onOpenAdvanced?: () => void;
};
type PersonalCheck = {type:'personal_check';mealId:string;lineIds:string[];checked:boolean};
type UiAction = Extract<ChecklistAction,{type:'move_remaining'}> | PersonalCheck;
type QueueEntry = { action: UiAction; operationId: string; draftId: string; payload?: Record<string, unknown> };
type Editor = { mealId: string; groupId: string; baseFingerprint: string; mode: 'split' | 'portion'; quantity: string; moveQuantity: string; targetMealId: string };
type Drag = { mealId: string; group: ChecklistGroup; x: number; y: number; targetMealId: string | null; moved: boolean };
const slots: Record<string, string> = { breakfast: '早餐', lunch: '午餐', snack: '加餐', dinner: '晚餐', other: '其他' };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const n = (value: number, digits = 1) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);
const unit = (value: string) => value.toLowerCase() === 'ml' ? 'mL' : value;
const amount = (value: number | null, u: string) => finite(value) ? n(value, 3) + unit(u) : '待核对';
const mealName = (meal: { slot: string; title?: string } | undefined) => meal ? slots[meal.slot] ?? meal.title ?? '其他' : '下一餐';
const key = (mealId: string, lineId: string) => JSON.stringify([mealId, lineId]);
function total(totals: readonly PlanNutritionTotal[], name: PlanNutritionTotal['key']) {
  const value = totals.find(value => value.key === name);
  if (!value || value.partial || !finite(value.value)) return '待补';
  return (value.estimated ? '≈' : '') + n(value.value, name === 'kcal' ? 0 : 1);
}
function shortName(group: ChecklistGroup, items: readonly FoodItem[]) {
  const item = items.find(item => item.id === group.itemId), original = group.name;
  const alias = item?.aliases?.find(alias => /[\u3400-\u9fff]/.test(alias) && alias.length <= 22);
  const withoutPackage = (value: string) => value.replace(/\d+(?:\.\d+)?\s*(?:kg|g|ml|l|lbs?)(?:装|袋|盒|瓶)?/gi, '').trim();
  let text = withoutPackage(alias || original.replace(/（[^）]*）|\([^)]*\)/g, '').trim());
  if (!alias && !/[\u3400-\u9fff]/.test(text)) {
    const description = original.match(/[（(]([^）)]*[\u3400-\u9fff][^）)]*)[）)]/);
    if (description) text = withoutPackage(description[1].split(/[，,]/)[0]);
  }
  if (/[\u3400-\u9fff]/.test(text)) text = text.replace(/[A-Za-z][A-Za-z0-9 .’'&%:/—-]*/g, ' ').replace(/\s+/g, '').trim();
  const description = [original, alias ?? '', item?.brand ?? ''].join(' ');
  if (/yog[ou]rt|酸奶|酸乳/i.test(description)) {
    const brand = /\boikos\b/i.test(description) ? 'Oikos' : /\bPC\b/i.test(description) ? 'PC' : '';
    const fat = description.match(/\d+(?:\.\d+)?\s*%/)?.[0].replace(/\s/g, '') || (/无脂|零脂|脱脂/.test(description) ? '0%' : '');
    text = [brand, fat + '酸奶'].filter(Boolean).join(' ');
  } else if (/cocoa|可可粉/i.test(description)) text = /无糖|unsweetened/i.test(description) ? '无糖可可粉' : '可可粉';
  else if (/whey|乳清/i.test(description)) text = /chocolate|巧克力/i.test(description) ? '巧克力乳清' : '乳清蛋白';
  else if (/broccoli|西兰花/i.test(description)) text = /frozen|冷冻/i.test(description) ? '冷冻西兰花' : '西兰花';
  else if (/mixed\s+garden\s+vegetables|mixed\s+vegetables|冷冻杂蔬|冷冻混合蔬菜/i.test(description)) text = /frozen|冷冻/i.test(description) ? '冷冻杂蔬' : '混合蔬菜';
  else if (!/面包|吐司/.test(text) && /whole\s*wheat|全麦/i.test(description) && (/bread|pan\s+bread/i.test(description) || item?.category === 'bread')) text = '全麦面包';
  if (!/[\u3400-\u9fff]/.test(text)) {
    if (/cocoa/i.test(original)) text = '可可粉';
    else if (/yogurt/i.test(original)) text = /0\s*%/.test(original) ? '0%希腊酸奶' : '希腊酸奶';
    else if (/whey/i.test(original)) text = '乳清蛋白';
  }
  const date = item?.category === 'prepared' ? original.match(/\d{4}[-/.](\d{1,2})[-/.](\d{1,2})/) : null;
  return (text || original).slice(0, 28) + (date ? '·' + Number(date[1]) + '/' + Number(date[2]) : '');
}
function actionKeys(action: UiAction) {
  const mealId = action.type === 'move_remaining' ? action.fromMealId : action.mealId;
  return action.lineIds.map(id => key(mealId, id));
}

export default function DayFoodChecklist({ plan, items, revision, busy, error = '', mutate, refresh, getLatest, onOpenAdvanced, active = true }: DayFoodChecklistProps) {
  const latestRef = useRef<Latest>({ plan, items, revision }); latestRef.current = { plan, items, revision };
  const apiRef = useRef({ mutate, refresh, getLatest }); apiRef.current = { mutate, refresh, getLatest };
  const queueRef = useRef<QueueEntry[]>([]), runningRef = useRef(false), mountedRef = useRef(true);
  const [queued, setQueued] = useState<QueueEntry[]>([]), [saving, setSaving] = useState(false), [paused, setPaused] = useState(false);
  const [localError, setLocalError] = useState(''), [notice, setNotice] = useState(''), [editor, setEditor] = useState<Editor | null>(null);
  const [dayTotalsOpen, setDayTotalsOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null), dragRef = useRef<Drag | null>(null);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; lift: () => void } | null>(null), ignoreClickRef = useRef(false);
  const dragPointer = useRef<{ element: HTMLElement; pointerId: number; pointerType: string } | null>(null);
  const gestureRef = useRef({ updateDrag, finishDrag, cancelDrag, cancelLongPress }); gestureRef.current = { updateDrag, finishDrag, cancelDrag, cancelLongPress };
  const editHeading = useId(), totalsHeading = useId(), dialogRef = useRef<HTMLDivElement>(null), totalsRef = useRef<HTMLDivElement>(null);
  const readOnly = plan.status === 'cancelled', closed = plan.status === 'closed_with_actuals';
  const blocked = readOnly || paused || busy && !saving;
  const allocationBlocked = blocked || !!plan.intakeDraft;
  const view = useMemo(() => personalFoodChecklistView(plan, items, checkedForLine), [plan, items, queued]);
  const pending = new Set(queued.flatMap(entry => actionKeys(entry.action)));
  const editMeal = editor ? view.meals.find(meal => meal.id === editor.mealId) : undefined;
  const editGroup = editMeal ? groupChecklistRows(editMeal).find(group => group.id === editor?.groupId) : undefined;
  const nextMeal = editor ? view.meals.find(meal => meal.id === editor.targetMealId) : undefined;
  const editQuantity = editor?.quantity.trim() ? Number(editor.quantity) : NaN;
  const moveQuantity = editor?.moveQuantity.trim() ? Number(editor.moveQuantity) : NaN;
  const editValid = !!editGroup && finite(editQuantity) && finite(editGroup.plannedQuantity);
  const moveValid = !!editGroup && finite(editGroup.remainingQuantity) && finite(moveQuantity) && moveQuantity > 0 && moveQuantity <= editGroup.remainingQuantity;
  const portionDelta = editGroup && finite(editGroup.plannedQuantity) && editValid ? Math.round((editQuantity - editGroup.plannedQuantity) * 1e6) / 1e6 : null;
  const incomingGroup = editor && nextMeal && editGroup ? groupChecklistRows(nextMeal).find(group => group.itemId === editGroup.itemId && group.unit === editGroup.unit && (group.itemId !== null || group.name === editGroup.name)) : undefined;
  const portionValid = finite(editQuantity) && portionDelta !== null && (portionDelta === 0 || portionDelta < 0 && finite(editGroup?.remainingQuantity) && -portionDelta <= editGroup.remainingQuantity || portionDelta > 0 && finite(incomingGroup?.remainingQuantity) && portionDelta <= incomingGroup.remainingQuantity);
  const editorStale = !!editor && editor.baseFingerprint !== view.baseFingerprint;
  const mealColumns: typeof view.meals[] = [[], []];
  view.meals.forEach((meal, index) => {
    const column = meal.slot === 'breakfast' || meal.slot === 'snack' ? 0 : meal.slot === 'lunch' || meal.slot === 'dinner' ? 1 : index % 2;
    mealColumns[column].push(meal);
  });

  useEffect(() => {
    mountedRef.current = true;
    if (typeof document === 'undefined') return () => { mountedRef.current = false; };
    // Leave ordinary swipes alone. Once a row is held and lifted, cancel native
    // panning so iPhone touch movement keeps carrying the selected food.
    function touchMove(event: TouchEvent) {
      if (!dragRef.current || !event.touches[0]) return;
      if (event.cancelable) event.preventDefault();
      gestureRef.current.updateDrag(event.touches[0].clientX, event.touches[0].clientY);
    }
    function touchEnd() { if (dragRef.current) gestureRef.current.finishDrag(); }
    function touchCancel() { gestureRef.current.cancelDrag(); gestureRef.current.cancelLongPress(); }
    function keyboard(event: KeyboardEvent) { if (event.key === 'Escape') { gestureRef.current.cancelDrag(); gestureRef.current.cancelLongPress(); } }
    document.addEventListener('touchmove', touchMove, { passive: false });
    document.addEventListener('touchend', touchEnd);
    document.addEventListener('touchcancel', touchCancel);
    document.addEventListener('keydown', keyboard);
    return () => {
      mountedRef.current = false; if (longPress.current) clearTimeout(longPress.current.timer);
      document.removeEventListener('touchmove', touchMove); document.removeEventListener('touchend', touchEnd);
      document.removeEventListener('touchcancel', touchCancel); document.removeEventListener('keydown', keyboard);
      if (dragPointer.current?.element.hasPointerCapture?.(dragPointer.current.pointerId)) dragPointer.current.element.releasePointerCapture(dragPointer.current.pointerId);
    };
  }, []);
  useEffect(() => {
    if (!editor && !dayTotalsOpen) return;
    const activeDialog = editor ? dialogRef : totalsRef;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; activeDialog.current?.focus();
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { setEditor(null); setDayTotalsOpen(false); }
      if (event.key !== 'Tab') return;
      const fields = activeDialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])');
      if (!fields?.length) return;
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === activeDialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, [!!editor, dayTotalsOpen]);
  useEffect(() => { setDayTotalsOpen(false); setEditor(null); }, [plan.id, plan.date]);
  useEffect(() => {
    if (!active) { setDayTotalsOpen(false); setEditor(null); cancelLongPress(); cancelDrag(); }
  }, [active]);

  function syncQueue() { if (mountedRef.current) setQueued([...queueRef.current]); }
  async function processQueue() {
    if (runningRef.current) return;
    runningRef.current = true; setSaving(true); setPaused(false); setLocalError('');
    try {
      while (queueRef.current.length) {
        const entry = queueRef.current[0];
        if (!entry.payload) {
          const latest = apiRef.current.getLatest?.() ?? latestRef.current;
          if (latest.plan.id !== plan.id || latest.plan.date !== plan.date) throw new Error('日期已改变，请回到原日期核对未完成操作。');
          if (entry.action.type === 'personal_check') {
            entry.payload = {planId:latest.plan.id,mealId:entry.action.mealId,lineIds:entry.action.lineIds,checked:entry.action.checked,
              expectedRevision:latest.revision,operationId:entry.operationId};
          } else {
            const result = buildChecklistAction(latest.plan, latest.items, entry.action, { draftId: entry.draftId });
            if (result.noChange) { queueRef.current.shift(); syncQueue(); continue; }
            entry.payload = { planId: latest.plan.id, draft: result.draft, expectedDraftVersion: result.expectedDraftVersion,
              expectedRevision: latest.revision, operationId: entry.operationId };
          }
        }
        const success = await apiRef.current.mutate(entry.action.type === 'personal_check' ? 'set_food_personal_check' : 'apply_checklist_intake', entry.payload, '');
        if (!success) throw new Error('这次操作尚未确认保存成功，请核对后重试。');
        queueRef.current.shift(); syncQueue();
        if (mountedRef.current) setNotice(entry.action.type === 'move_remaining' ? '分餐已调整，不提前扣库存' : entry.action.checked ? '个人勾选已保存' : '已取消个人勾选');
      }
    } catch (cause) {
      if (mountedRef.current) { setLocalError(cause instanceof Error ? cause.message : '暂时未确认保存成功，请刷新核对。'); setPaused(true); }
    } finally { runningRef.current = false; if (mountedRef.current) setSaving(false); }
  }
  function enqueue(action: UiAction) {
    const toggle = action.type === 'personal_check';
    if ((toggle ? blocked : allocationBlocked) || paused || !toggle && queueRef.current.some(entry => JSON.stringify(entry.action) === JSON.stringify(action))) return;
    queueRef.current.push({ action, operationId: crypto.randomUUID(), draftId: crypto.randomUUID() }); syncQueue();
    setNotice(''); void processQueue();
  }
  async function retry() { await apiRef.current.refresh(); await processQueue(); }
  async function reloadLatest() {
    await apiRef.current.refresh(); queueRef.current = []; syncQueue(); setPaused(false); setLocalError(''); setNotice('已载入最新记录，请核对后继续');
  }
  function openEditor(mealId: string, group: ChecklistGroup) {
    cancelLongPress();
    const target = nextChecklistMealId(intakeDraftView(plan,items,null), mealId);
    setEditor({ mealId, groupId: group.id, baseFingerprint: view.baseFingerprint, mode: !closed && finite(group.remainingQuantity) && group.remainingQuantity > 0 && target ? 'split' : 'portion',
      quantity: String(group.plannedQuantity ?? ''), moveQuantity: String(group.remainingQuantity ?? ''), targetMealId: target ?? '' });
  }
  function cancelLongPress() { if (longPress.current) clearTimeout(longPress.current.timer); longPress.current = null; }
  function pressStart(event: ReactPointerEvent, mealId: string, group: ChecklistGroup) {
    if (event.button !== 0 || event.isPrimary === false) return;
    ignoreClickRef.current = false; cancelLongPress();
    if (allocationBlocked || closed || !group.canEdit || !finite(group.remainingQuantity) || group.remainingQuantity <= 0 || group.lineIds.some(id => pending.has(key(mealId, id)))) return;
    const element = event.currentTarget as HTMLElement, pointerId = event.pointerId, pointerType = event.pointerType;
    const x = event.clientX, y = event.clientY;
    const lift = () => {
      ignoreClickRef.current = true; cancelLongPress();
      dragPointer.current = { element, pointerId, pointerType };
      element.setPointerCapture?.(pointerId);
      const initial = { mealId, group, x, y, targetMealId: null, moved: false };
      dragRef.current = initial; setDrag(initial);
    };
    longPress.current = { x, y, lift, timer: setTimeout(lift, 380) };
  }
  function pressMove(event: ReactPointerEvent) {
    if (dragRef.current) { event.preventDefault(); updateDrag(event.clientX, event.clientY); return; }
    if (longPress.current && Math.hypot(event.clientX - longPress.current.x, event.clientY - longPress.current.y) > 8) {
      if (event.pointerType === 'mouse') { longPress.current.lift(); event.preventDefault(); updateDrag(event.clientX, event.clientY); }
      else { ignoreClickRef.current = true; cancelLongPress(); }
    }
  }
  function pressEnd() { cancelLongPress(); if (dragRef.current) finishDrag(); }
  function completeItem(mealId: string, group: ChecklistGroup) {
    cancelLongPress();
    if (ignoreClickRef.current) { ignoreClickRef.current = false; return; }
    enqueue({type:'personal_check',mealId,lineIds:group.lineIds,checked:!checkedForGroup(mealId,group)});
  }
  function checkedForLine(mealId:string,lineId:string) {
    let checked = isPersonalFoodChecked(plan,mealId,lineId);
    for (const { action } of queueRef.current) {
      if(action.type === 'personal_check' && action.mealId === mealId && action.lineIds.includes(lineId)) checked=action.checked;
    }
    return checked;
  }
  function checkedForGroup(mealId: string, group: ChecklistGroup) {return group.lineIds.length>0&&group.lineIds.every(lineId=>checkedForLine(mealId,lineId));}
  function mixedForGroup(mealId:string,group:ChecklistGroup) {return !checkedForGroup(mealId,group)&&group.lineIds.some(lineId=>checkedForLine(mealId,lineId));}
  function updateDrag(x: number, y: number) {
    const current = dragRef.current; if (!current) return;
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-checklist-meal]');
    const latest = apiRef.current.getLatest?.() ?? latestRef.current;
    const candidate = element?.closest<HTMLElement>('[data-checklist-plan]')?.dataset.checklistPlan === latest.plan.id ? element.dataset.checklistMeal ?? null : null;
    const eligible = latest.plan.status !== 'cancelled' && latest.plan.meals.some(meal => meal.id === candidate && meal.state !== 'cancelled');
    const target = eligible ? candidate : null;
    const moved = current.moved || Math.hypot(x - current.x, y - current.y) > 6;
    const next = { ...current, x, y, targetMealId: target !== current.mealId ? target : null, moved };
    dragRef.current = next; setDrag(next);
    if (y < 75) window.scrollBy(0, -12);
    else if (y > window.innerHeight - 75) window.scrollBy(0, 12);
  }
  function cancelDrag() {
    dragRef.current = null; setDrag(null);
    const pointer = dragPointer.current; dragPointer.current = null;
    if (pointer?.element.hasPointerCapture?.(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId);
  }
  function finishDrag() {
    const current = dragRef.current; dragRef.current = null; setDrag(null);
    cancelDrag();
    if (current?.moved && current.targetMealId) enqueue({ type: 'move_remaining', fromMealId: current.mealId, lineIds: current.group.lineIds, toMealId: current.targetMealId });
  }
  function saveEdit() {
    if (editor?.mode === 'split') {
      if (!editGroup || !moveValid || editorStale || !editor.targetMealId) return;
      enqueue({ type: 'move_remaining', fromMealId: editor.mealId, lineIds: editGroup.lineIds, toMealId: editor.targetMealId, quantity: moveQuantity });
      setEditor(null); return;
    }
    if (!editor || !editGroup || !portionValid || editorStale || portionDelta === null) return;
    if(portionDelta<0) enqueue({type:'move_remaining',fromMealId:editor.mealId,lineIds:editGroup.lineIds,toMealId:editor.targetMealId,quantity:-portionDelta});
    else if(portionDelta>0&&incomingGroup) enqueue({type:'move_remaining',fromMealId:editor.targetMealId,lineIds:incomingGroup.lineIds,toMealId:editor.mealId,quantity:portionDelta});
    setEditor(null);
  }

  return <section className="food-checklist" data-checklist-plan={plan.id} aria-label="当天饮食清单">
    <div className="food-checklist-toolbar"><p>个人勾选 · 不影响库存结算</p><span role="status">{saving ? <><Loader2 size={12} className="spin"/>保存中{queued.length > 1 ? ' · ' + queued.length + '项' : ''}</> : notice}</span></div>
    <div className="food-progress-strip" aria-label="个人勾选进度"><span>已勾选 <strong>{total(view.totals.checked, 'kcal')}</strong> kcal</span><span>未勾选 <strong>{total(view.totals.unchecked, 'kcal')}</strong> kcal</span><button type="button" className="food-day-trigger" aria-haspopup="dialog" aria-expanded={dayTotalsOpen} onClick={() => setDayTotalsOpen(value => !value)}>全天食材<ChevronDown size={12}/></button></div>
    {!!plan.intakeDraft && <div className="food-checklist-warning" role="status"><span>上次还有未提交的进食草稿；个人勾选不受影响，分餐前请先核对。</span><button type="button" onClick={onOpenAdvanced}>核对进食草稿</button></div>}
    {(error || localError) && <div className="food-checklist-warning" role="alert"><span>{error || localError}</span>{paused ? <><button type="button" onClick={() => void retry()}>重试原操作</button><button type="button" onClick={() => void reloadLatest()}>载入最新并取消待处理</button></> : <button type="button" onClick={() => void refresh()}>刷新核对</button>}</div>}
    {plan.inventoryAccounting === 'pending_reconciliation' && <div className="food-checklist-warning" role="status">实际记录已保留，库存待核对。<button type="button" onClick={onOpenAdvanced}>查看详情</button></div>}
    <div className="food-meal-grid">{mealColumns.map((column, columnIndex) => <div className="food-meal-column" key={columnIndex} aria-label={columnIndex === 0 ? '早餐与加餐' : '午餐与晚餐'}>{column.map(meal => {
      const source = plan.meals.find(entry => entry.id === meal.id)!, groups = groupChecklistRows(meal).filter(group => group.unknown || group.plannedQuantity !== 0 || group.reportedQuantity !== 0);
      const nutrition = view.mealTotals.find(value=>value.mealId===meal.id)!;
      const mealPending = queued.some(entry => entry.action.type === 'personal_check' && entry.action.mealId === meal.id);
      const done = groups.length > 0 && groups.every(group => checkedForGroup(meal.id, group));
      const partlyChecked = !done&&groups.some(group=>group.lineIds.some(lineId=>checkedForLine(meal.id,lineId)));
      const target = drag?.moved && drag.targetMealId === meal.id;
      return <section className={'food-meal-card' + (done ? ' is-complete' : '') + (target ? ' is-drop-target' : '') + (drag && meal.id !== drag.mealId && canReceiveChecklistFood(meal) ? ' can-receive-drag' : '')} key={meal.id} style={{ order: view.meals.indexOf(meal) }} data-checklist-meal={meal.id} aria-label={mealName(meal) + '计划'}>
        <header><div><h3>{mealName(meal)} <small>{source.plannedTime ?? ''}</small></h3><p>{total(nutrition.totals, 'kcal')} kcal <span>· P{total(nutrition.totals, 'protein')} C{total(nutrition.totals, 'carbs')} F{total(nutrition.totals, 'fat')}</span></p></div><button type="button" role="checkbox" aria-checked={partlyChecked?'mixed':done} aria-busy={mealPending} className={'food-meal-check' + (done ? ' checked' : '')} disabled={blocked || !groups.length} onClick={() => {
          const checked = groups.every(group => checkedForGroup(meal.id, group));
          enqueue({type:'personal_check',mealId:meal.id,lineIds:groups.flatMap(group=>group.lineIds),checked:!checked});
        }} aria-label={done ? '取消' + mealName(meal) + '个人勾选' : '个人勾选' + mealName(meal)} title={done ? '取消整餐勾选' : '勾选整餐'}><Check size={16}/><span>{done ? '已勾选' : '勾选整餐'}</span></button></header>
        <ul>{groups.map(group => {
          const queuedForGroup = group.lineIds.some(id => pending.has(key(meal.id, id)));
          const checked = checkedForGroup(meal.id, group);
          const mixed = mixedForGroup(meal.id,group);
          const label = shortName(group, items), displayed = group.plannedQuantity;
          const dragging = drag?.mealId === meal.id && drag.group.id === group.id;
          return <li key={group.id} className={'food-check-row' + (checked ? ' is-eaten' : '') + (queuedForGroup ? ' is-pending' : '') + (dragging ? ' is-dragging' : '')}>
            <button type="button" className="food-row-main" role="checkbox" aria-checked={mixed?'mixed':checked} aria-busy={queuedForGroup} aria-label={(checked ? '取消个人勾选' : '个人勾选') + mealName(meal) + '的' + label} disabled={blocked} title={group.name} onClick={() => completeItem(meal.id, group)} onPointerDown={event => pressStart(event, meal.id, group)} onPointerMove={pressMove} onPointerUp={pressEnd} onPointerCancel={() => { cancelLongPress(); cancelDrag(); }} onLostPointerCapture={() => { if (dragRef.current) cancelDrag(); }} onContextMenu={event => event.preventDefault()}>
              <span className="food-row-box">{checked ? <Check size={13}/> : mixed?'−':null}</span><span className="food-row-name">{label}</span><strong>{amount(displayed, group.unit)}</strong>
            </button><button type="button" className="food-row-more" aria-label={'修改' + mealName(meal) + '的' + label} title="修改计划份量或分餐" disabled={allocationBlocked || queuedForGroup} onClick={() => openEditor(meal.id, group)}><MoreHorizontal size={15}/></button>
          </li>;
        })}</ul>{!groups.length && <p className="food-meal-empty">拖入其他餐的食物</p>}
        {target && <div className="food-drop-label">松开，分到{mealName(meal)}</div>}
      </section>;
    })}</div>)}</div>
    {readOnly && <p className="food-checklist-readonly">这一天已取消，实际记录保留。</p>}
    {drag && <div className="food-drag-ghost" style={{ left: Math.max(8, Math.min(drag.x - 90, (typeof window === 'undefined' ? 390 : window.innerWidth) - 200)), top: Math.max(8, drag.y - 80) }}><strong>{shortName(drag.group, items)}</strong> {amount(drag.group.remainingQuantity, drag.group.unit)}<small>{drag.targetMealId ? '松开调到' + mealName(view.meals.find(meal => meal.id === drag.targetMealId)) : '拖到目标餐次'}</small></div>}
    {dayTotalsOpen && <div className="food-day-overlay" onPointerDown={event => { if (event.target === event.currentTarget) setDayTotalsOpen(false); }}><div className="food-day-dialog" role="dialog" aria-modal="true" aria-labelledby={totalsHeading} tabIndex={-1} ref={totalsRef}>
      <header><div><h2 id={totalsHeading}>全天食材总量</h2><p>同一种食物合并计算</p></div><button type="button" className="food-day-close" aria-label="关闭全天食材总量" onClick={() => setDayTotalsOpen(false)}><X size={20}/><span>关闭</span></button></header>
      <div className="food-day-scroll"><div className="food-day-columns"><span>食材</span><span>全天</span><span>已勾选</span><span>未勾选</span></div>{view.dayRows.map((row, index) => <div className="food-day-total-row" key={row.itemId + ':' + index}><span>{shortName({ ...row, id: String(index), rows: [], lineIds: [], eatenQuantity:null,reportedQuantity:null,remainingQuantity:null,externalReportedQuantity: null, unknown: false, canEdit: false, issue: '' }, items)}</span><strong>{amount(row.plannedQuantity, row.unit)}</strong><span>{amount(row.checkedQuantity, row.unit)}</span><strong>{amount(row.uncheckedQuantity, row.unit)}</strong></div>)}</div>
    </div></div>}
    {editor && editGroup && <div className="food-edit-overlay" onPointerDown={event => { if (event.target === event.currentTarget) setEditor(null); }}><div className="food-edit-sheet" role="dialog" aria-modal="true" aria-labelledby={editHeading} tabIndex={-1} ref={dialogRef}>
      <header><div><span>{mealName(editMeal)}</span><h2 id={editHeading}>{shortName(editGroup, items)}</h2></div><button type="button" className="icon-button" aria-label="关闭食物修改" onClick={() => setEditor(null)}><X size={20}/></button></header>
      <p className="food-edit-original">计划 {amount(editGroup.plannedQuantity, editGroup.unit)} · 个人{checkedForGroup(editor.mealId,editGroup)?'已勾选':'未勾选'}</p>
      {editorStale && <p className="food-checklist-warning" role="alert">菜单或实际记录已更新，请关闭后重新打开，按最新份量修改。</p>}
      {editGroup.canEdit&&!closed ? <>
      <div className="food-edit-tabs" role="tablist" aria-label="食物调整方式"><button type="button" role="tab" aria-selected={editor.mode === 'split'} disabled={!finite(editGroup.remainingQuantity) || editGroup.remainingQuantity <= 0 || !editor.targetMealId} onClick={() => setEditor({ ...editor, mode: 'split' })}><ArrowRightLeft size={14}/>分餐</button><button type="button" role="tab" aria-selected={editor.mode === 'portion'} onClick={() => setEditor({ ...editor, mode: 'portion' })}>本餐份量</button></div>
      {editor.mode === 'split' ? <>
        <label className="food-edit-amount">移动数量<div><input aria-label="移动数量" type="number" min="0" max={editGroup.remainingQuantity ?? undefined} step="any" inputMode="decimal" value={editor.moveQuantity} onChange={event => setEditor({ ...editor, moveQuantity: event.target.value })}/><span>{unit(editGroup.unit)}</span></div></label>
        <div className="food-split-quick"><button type="button" onClick={() => setEditor({ ...editor, moveQuantity: String(Math.round((editGroup.remainingQuantity ?? 0) * 5e5) / 1e6) })}>半份</button><button type="button" onClick={() => setEditor({ ...editor, moveQuantity: String(editGroup.remainingQuantity ?? '') })}>全部</button><span>本餐留下 {amount(moveValid && finite(editGroup.remainingQuantity) ? Math.round((editGroup.remainingQuantity - moveQuantity) * 1e6) / 1e6 : null, editGroup.unit)}</span></div>
        <label className="food-split-target">分到哪餐<select aria-label="分到哪餐" value={editor.targetMealId} onChange={event => setEditor({ ...editor, targetMealId: event.target.value })}>{view.meals.filter(meal => meal.id !== editor.mealId && canReceiveChecklistFood(meal)).map(meal => <option key={meal.id} value={meal.id}>{mealName(meal)}</option>)}</select></label>
        <p className="food-edit-effect">只调整这一天的分配，全天总量保持不变。</p>
        <div className="food-edit-actions"><button type="button" className="button primary" disabled={allocationBlocked || saving || editorStale || !moveValid || !editor.targetMealId} onClick={saveEdit}>分到{mealName(nextMeal)}</button></div>
      </> : <>
        <label className="food-edit-amount">这餐安排多少<div><input aria-label="这餐计划份量" type="number" min="0" step="any" inputMode="decimal" value={editor.quantity} onChange={event => setEditor({ ...editor, quantity: event.target.value })}/><span>{unit(editGroup.unit)}</span></div></label>
        <label className="food-split-target">{portionDelta!==null&&portionDelta>0?'从哪餐调入':'剩余分到哪餐'}<select aria-label="份量调整对应餐次" value={editor.targetMealId} onChange={event => setEditor({ ...editor, targetMealId: event.target.value })}>{view.meals.filter(meal => meal.id !== editor.mealId && canReceiveChecklistFood(meal)).map(meal => <option key={meal.id} value={meal.id}>{mealName(meal)}</option>)}</select></label>
        <p className="food-edit-effect">{portionDelta!==null&&portionDelta<0?amount(-portionDelta,editGroup.unit)+'分到'+mealName(nextMeal):portionDelta!==null&&portionDelta>0?'从'+mealName(nextMeal)+'调入'+amount(portionDelta,editGroup.unit):'只调整当前菜单，全天总量保持不变'}。不记录实际，也不提前扣库存。</p>
        {!portionValid&&editValid&&<p className="food-checklist-warning">所选餐次没有足够可调配的同类食物，或已有实际记录需要另行核对。</p>}
        <div className="food-edit-actions"><button type="button" className="button primary" disabled={allocationBlocked || saving || editorStale || !portionValid || portionDelta!==0&&!editor.targetMealId} onClick={saveEdit}>保存计划份量</button></div>
      </>}
      </> : <p className="food-checklist-warning">{closed?'这份计划已结算，个人勾选不受影响；实际更正请单独核对。':editGroup.issue || '这项计划用量需要先核对。'}<button type="button" onClick={onOpenAdvanced}>高级：实际记录与更正</button></p>}
      <details className="food-edit-details"><summary>完整名称与更多操作</summary><p>{editGroup.name}</p><button type="button" onClick={onOpenAdvanced}>高级：实际记录与更正</button></details>
    </div></div>}
  </section>;
}
