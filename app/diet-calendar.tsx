"use client";
import { uiText, uiLocale, getUiLanguage } from '@/lib/ui-language.mjs';

import { useId, useMemo } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { buildMonthDays, shiftMonth } from '@/lib/training-navigation.mjs';
import './diet-calendar.css';

export type DietCalendarDay = {
  date: string;
  kcal: number | null;
  partial: boolean;
  estimated: boolean;
  draft: boolean;
};

export type DietCalendarProps = {
  days: DietCalendarDay[];
  month: string;
  selectedDate: string;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string) => void;
};

type CalendarValue = DietCalendarDay & { duplicate: boolean };
const WEEKDAYS = [uiText("Mon"), uiText("Tue"), uiText("Wed"), uiText("Thu"), uiText("Fri"), uiText("Sat"), uiText("Sun")];

function torontoToday() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join("-");
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
}

function kcalLabel(kcal: number, compact = false) {
  return new Intl.NumberFormat(uiLocale(), compact && kcal >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0, useGrouping: false }).format(kcal);
}

function energyDescription(day: CalendarValue) {
  if (day.duplicate) return uiText("Multiple menus for this date need review; calories incomplete");
  if (day.partial || day.kcal === null) return `${uiText("Calories incomplete")}${day.kcal === null ? '' : `${uiText(", known portion: ")}${day.estimated ? uiText("about ") : ''}${kcalLabel(day.kcal)}${uiText(" kcal, not the full daily total")}`}`;
  return `${day.estimated ? uiText("estimated ") : ''}${kcalLabel(day.kcal)}${uiText(" kcal")}`;
}

export default function DietCalendar({ days, month, selectedDate, onMonthChange, onSelectDate }: DietCalendarProps) {
  const headingId = useId();
  const inputId = useId();
  const legendId = useId();
  const today = torontoToday();
  const [year, monthNumber] = month.split("-").map(Number);
  const monthLabel = new Intl.DateTimeFormat(uiLocale(), { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
  const monthDays = buildMonthDays(month);
  const { byDate, finalCount, draftCount, partialCount } = useMemo(() => {
    const byDate = new Map<string, CalendarValue>();
    for (const day of days) {
      if (!day.date.startsWith(`${month}${"-"}`)) continue;
      const previous = byDate.get(day.date);
      const kcal = typeof day.kcal === 'number' && Number.isFinite(day.kcal) && day.kcal >= 0 ? day.kcal : null;
      // The caller supplies one daily summary. Duplicate inputs cannot safely
      // be summed or let an arbitrary draft overwrite a final menu.
      byDate.set(day.date, previous ? { ...day, kcal: null, partial: true, draft: previous.draft && day.draft, duplicate: true } : { ...day, kcal, duplicate: false });
    }
    const values = [...byDate.values()];
    return { byDate, finalCount: values.filter(day => !day.draft).length, draftCount: values.filter(day => day.draft).length, partialCount: values.filter(day => day.partial || day.kcal === null).length };
  }, [days, month]);

  function jumpToMonth(value: string) {
    if (/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) onMonthChange(value);
  }

  function selectToday() {
    const date = torontoToday();
    onMonthChange(date.slice(0, 7));
    onSelectDate(date);
  }

  return <div className="diet-calendar" role="group" aria-labelledby={headingId}>
    <div className="diet-calendar-heading">
      <div><span className="diet-calendar-eyebrow">{uiText("Meal calendar")}</span><h3 id={headingId}>{monthLabel}</h3></div>
      <button type="button" className="diet-calendar-button" onClick={selectToday}><CalendarDays size={16} aria-hidden="true"/>{uiText("Today")}</button>
    </div>
    <div className="diet-calendar-navigation">
      <button type="button" className="diet-calendar-arrow" disabled={month === '0001-01'} aria-label={uiText("Previous month of meals")} onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={19} aria-hidden="true"/></button>
      <label className="diet-calendar-month-picker" htmlFor={inputId}><span>{uiText("Jump to month")}</span><input id={inputId} type="month" min="0001-01" max="9999-12" value={month} onChange={event => jumpToMonth(event.target.value)}/></label>
      <button type="button" className="diet-calendar-arrow" disabled={month === '9999-12'} aria-label={uiText("Next month of meals")} onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={19} aria-hidden="true"/></button>
    </div>
    <div className="diet-calendar-summary" aria-live="polite" aria-atomic="true"><span><i className="diet-calendar-key-final"/>{uiText("Saved menus: ")}{finalCount + draftCount}{uiText(" days")}</span>{partialCount > 0 && <span className="diet-calendar-pending-count">{uiText("Calories incomplete: ")}{partialCount}{uiText(" days")}</span>}</div>
    <div className="diet-calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((day, index) => <span key={day} className={index > 4 ? 'is-weekend' : undefined}>{day}</span>)}</div>
    <div className="diet-calendar-days" role="group" aria-label={`${monthLabel}${uiText("Meal date")}`} aria-describedby={legendId}>
      {monthDays.map(({ date, day }, index) => {
        if (!date || day === null) return <div className="diet-calendar-empty" key={`empty-${index}`} aria-hidden="true"/>;
        const value = byDate.get(date);
        const incomplete = !!value && (value.partial || value.kcal === null);
        const energy = value ? energyDescription(value) : '';
        const label = `${dateLabel(date)}${date === today ? uiText(", today") : ''}, ${value ? `${uiText("Saved menu, ")}${energy}` : uiText("No saved menu")}`;
        const className = ['diet-calendar-day', value && 'has-final', incomplete && 'is-partial', selectedDate === date && 'is-selected', today === date && 'is-today'].filter(Boolean).join(' ');
        return <button type="button" className={className} key={date} onClick={() => onSelectDate(date)} aria-label={label} title={label} aria-pressed={selectedDate === date} aria-current={date === today ? 'date' : undefined}>
          <span className="diet-calendar-date" aria-hidden="true">{day}{date === today && <i/>}</span>
          {value && <>
            <span className={`diet-calendar-energy${incomplete ? ' is-incomplete' : ''}`} aria-hidden="true">{incomplete ? uiText("Incomplete") : `${value.estimated ? '≈' : ''}${kcalLabel(value.kcal!, true)}`}</span>
            {!incomplete && <span className="diet-calendar-unit" aria-hidden="true">kcal</span>}
            <span className="diet-calendar-state" aria-hidden="true">{uiText("Menu")}</span>
          </>}
        </button>;
      })}
    </div>
    <div className="diet-calendar-legend" id={legendId}><span>{uiText("≈ indicates estimated calories")}</span><span>{uiText("Incomplete means calorie information is missing")}</span></div>
    <p className="diet-calendar-selection" aria-live="polite">{dateLabel(selectedDate)}{byDate.has(selectedDate) ? `${uiText(" · Saved menu · ")}${energyDescription(byDate.get(selectedDate)!)}` : uiText(" · Select a date to view or plan meals")}</p>
  </div>;
}
