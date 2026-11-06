"use client";
import { uiText, uiLocale, getUiLanguage } from '@/lib/ui-language.mjs';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { unitLabel, storageLabel } from '@/lib/english-display.mjs';
import { Plus, Search, X } from 'lucide-react';
import type { DietPlan } from '@/lib/diet-types';
import type { FoodItem } from '@/lib/inventory-types';
import { inventoryDisplayAmount } from '@/lib/food-display-amount.mjs';
import { nutritionTotalsFromLines } from '@/lib/diet-nutrition.mjs';
import { buildMealInventoryAddition, inventoryMealChoices, mealAdditionQuantity, mealAdditionUnits } from '@/lib/meal-inventory-addition.mjs';
import './meal-inventory-picker.css';

export type MealInventoryPickerProps = { plan: DietPlan; items: FoodItem[]; revision: number; mealId: string; busy: boolean;
  mutate: (action: string, payload: Record<string, unknown>, message: string) => Promise<boolean>; onClose: () => void };
const slots: Record<string, string> = { breakfast: uiText("Breakfast"), lunch: uiText("Lunch"), dinner: uiText("Dinner"), snack: uiText("Snack"), other: uiText("Other") };
const labelUnit = (unit: string) => unitLabel(unit);
const n = (value: number) => new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 2 }).format(value);
export default function MealInventoryPicker({ plan, items, revision, mealId, busy, mutate, onClose }: MealInventoryPickerProps) {
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState(''), [quantity, setQuantity] = useState(''), [unit, setUnit] = useState('');
  const [writing, setWriting] = useState(false), [error, setError] = useState('');
  const heading = useId(), dialog = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), lock = useRef(false);
  const requests = useRef(new Map<string, ReturnType<typeof buildMealInventoryAddition>>());
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const meal = plan.meals.find(meal => meal.id === mealId), choices = useMemo(() => inventoryMealChoices(items, query), [items, query]);
  const selected = items.find(item => item.id === selectedId), units = selected ? mealAdditionUnits(selected) : [];
  const validItem = selected && inventoryMealChoices([selected]).length > 0;
  let nativeQuantity: number | null = null;
  try { if (selected && quantity.trim()) nativeQuantity = mealAdditionQuantity(selected, Number(quantity), unit); } catch { /* Show a precise error only on submit. */ }
  const nutrition = selected && nativeQuantity !== null ? nutritionTotalsFromLines([{ snapshot: selected, quantity: nativeQuantity, unit: selected.unit, supplement: false }]) : [];
  const blocked = busy || writing || !meal || meal.state === 'cancelled' || ['cancelled', 'closed_with_actuals'].includes(plan.status);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; search.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !lock.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const fields = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])');
      if (!fields?.length) return;
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  async function save() {
    if (blocked || lock.current) return;
    try {
      const identity = JSON.stringify([plan.id, mealId, selectedId, quantity, unit]);
      let payload = requests.current.get(identity);
      if (!payload) {
        payload = buildMealInventoryAddition(plan, items, { mealId, itemId: selectedId, quantity: Number(quantity), unit }, { operationId: crypto.randomUUID(), expectedRevision: revision });
        requests.current.set(identity, payload);
      }
      lock.current = true; setWriting(true); setError('');
      const success = await mutate('add_food_to_meal', payload, uiText("Added to this meal; inventory unchanged"));
      if (success) onClose(); else setError(uiText("Saving is unconfirmed. Refresh to verify; retrying uses the same operation ID."));
    } catch (cause) { setError(cause instanceof Error ? uiText(cause.message) : uiText("Review the food and amount.")); }
    finally { lock.current = false; setWriting(false); }
  }
  return <div className="meal-stock-overlay" onPointerDown={event => { if (event.target === event.currentTarget && !writing) onClose(); }}>
    <div className="meal-stock-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} ref={dialog} tabIndex={-1}>
      <header><div><span>{meal ? slots[meal.slot] ?? meal.title : uiText("This meal")}</span><h2 id={heading}>{uiText("Add from inventory")}</h2><p>{uiText("Choose a food and amount for the current menu.")}</p></div><button type="button" aria-label={uiText("Close inventory picker")} disabled={writing} onClick={onClose}><X size={20}/></button></header>
      <label className="meal-stock-search"><Search size={17}/><input ref={search} type="search" aria-label={uiText("Search inventory food")} placeholder={uiText("Search name or brand")} value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="meal-stock-options" role="group" aria-label={uiText("Available inventory food")}>{choices.map(item => <button type="button" key={item.id} aria-pressed={selectedId === item.id} disabled={writing} onClick={() => { setSelectedId(item.id); setUnit(mealAdditionUnits(item).includes('g') ? 'g' : item.unit); setError(''); }}>
        <span><strong>{item.name}</strong><small>{[item.brand, item.location ? storageLabel(item.location) : ''].filter(Boolean).join(" · ")}</small></span><span>{item.quantity === null ? uiText("Available · balance unrecorded") : inventoryDisplayAmount(item).text}</span>
      </button>)}{!choices.length && <p>{uiText("No matching available food. Try another name.")}</p>}</div>
      {selected && <section className="meal-stock-portion" aria-label={uiText("Amount to add")}><strong>{selected.name}</strong><label>{uiText("Amount for this meal")}<div><input aria-label={uiText("Food amount to add")} type="number" min="0" step="any" inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)}/>{units.length > 1 ? <select aria-label={uiText("Food unit to add")} value={unit} onChange={event => setUnit(event.target.value)}>{units.map(value => <option key={value} value={value}>{labelUnit(value)}</option>)}</select> : <span>{labelUnit(unit)}</span>}</div></label>
        {!validItem && <p role="alert">{uiText("This food is no longer available. Choose another.")}</p>}
        {nativeQuantity !== null && <p className="meal-stock-nutrition">{nutrition.map(total => <span key={total.key}>{{ kcal: uiText("Calories"), protein: uiText("Protein"), carbs: uiText("Carbs"), fat: uiText("Fat") }[total.key]} {total.partial || total.value === null ? uiText("Unknown") : (total.estimated ? '≈' : '') + n(total.value)}{!total.partial && total.value !== null ? total.key === 'kcal' ? uiText(" kcal") : 'g' : ''}</span>)}</p>}
        {meal?.state === 'completed' && <p>{uiText("This meal has reported intake. Adding food updates the plan comparison only; actual intake still follows your report.")}</p>}
      </section>}
      {error && <p className="meal-stock-error" role="alert">{uiText(error)}</p>}
      <footer><span>{uiText("Adds to the menu only. Record after eating.")}</span><button type="button" className="button primary" disabled={blocked || !validItem || nativeQuantity === null} onClick={() => void save()}><Plus size={16}/>{writing ? uiText("Saving…") : uiText("Add to meal")}</button></footer>
    </div>
  </div>;
}
