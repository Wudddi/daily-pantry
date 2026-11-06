"use client";
import { canonicalLocalDate } from '@/lib/calendar-date.mjs';
import { uiText, uiLocale, getUiLanguage } from '@/lib/ui-language.mjs';

import { useId, useMemo } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import type { TrainingSession } from '@/lib/health-types';
import { buildMonthDays, sessionBodyParts, shiftMonth } from '@/lib/training-navigation.mjs';
import './training-calendar.css';

export type TrainingCalendarProps = {
  sessions: TrainingSession[];
  month: string;
  onMonthChange: (month: string) => void;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
};

type DayRecords = {
  completed: TrainingSession[];
  planned: TrainingSession[];
  completedParts: string[];
  plannedParts: string[];
};

const WEEKDAYS = [uiText("Mon"), uiText("Tue"), uiText("Wed"), uiText("Thu"), uiText("Fri"), uiText("Sat"), uiText("Sun")];
const uniqueParts = (sessions: TrainingSession[]) => [...new Set(sessions.flatMap(session => sessionBodyParts(session).map(part => uiText(part))))];

function torontoToday() { return canonicalLocalDate(); }

function dateLabel(date: string) {
  return new Intl.DateTimeFormat(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
}

function dayLabel(date: string, records: DayRecords | undefined, today: string) {
  const label = `${dateLabel(date)}${date === today ? uiText(", today") : ''}`;
  if (!records) return `${label}${uiText(", no training recorded; unrecorded does not mean no training")}`;
  const descriptions = [];
  if (records.completed.length) descriptions.push(`${records.completed.length}${uiText(" completed sessions, ")}${records.completedParts.join(", ") || uiText("Body part unspecified")}`);
  if (records.planned.length) descriptions.push(`${records.planned.length}${uiText(" planned sessions, ")}${records.plannedParts.join(", ") || uiText("Planned body part unspecified")}`);
  return `${label}, ${records.completed.length + records.planned.length}${uiText(" records; ")}${descriptions.join("; ")}`;
}

export default function TrainingCalendar({ sessions, month, onMonthChange, selectedDate, onSelectDate }: TrainingCalendarProps) {
  const headingId = useId();
  const monthInputId = useId();
  const legendId = useId();
  const today = torontoToday();
  const [year, monthNumber] = month.split("-").map(Number);
  const monthLabel = new Intl.DateTimeFormat(uiLocale(), { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
  const days = buildMonthDays(month);
  const { recordsByDate, completedDays, completedCount, plannedCount } = useMemo(() => {
    const recordsByDate = new Map<string, DayRecords>();
    for (const session of sessions) {
      if (!session.date.startsWith(`${month}${"-"}`)) continue;
      let records = recordsByDate.get(session.date);
      if (!records) {
        records = { completed: [], planned: [], completedParts: [], plannedParts: [] };
        recordsByDate.set(session.date, records);
      }
      records[session.status].push(session);
    }
    let completedDays = 0;
    let completedCount = 0;
    let plannedCount = 0;
    for (const records of recordsByDate.values()) {
      records.completedParts = uniqueParts(records.completed);
      records.plannedParts = uniqueParts(records.planned);
      if (records.completed.length) completedDays += 1;
      completedCount += records.completed.length;
      plannedCount += records.planned.length;
    }
    return { recordsByDate, completedDays, completedCount, plannedCount };
  }, [sessions, month]);

  function jumpToMonth(value: string) {
    if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return;
    onMonthChange(value);
  }

  function selectToday() {
    const date = torontoToday();
    onMonthChange(date.slice(0, 7));
    onSelectDate(date);
  }

  return <div className="training-calendar" role="group" aria-labelledby={headingId}>
    <div className="training-calendar-heading">
      <div><span className="training-calendar-eyebrow">{uiText("Training calendar")}</span><h3 id={headingId}>{monthLabel}</h3></div>
      <div className="training-calendar-actions">
        <button type="button" className="training-calendar-button" onClick={selectToday}><CalendarDays size={16} aria-hidden="true"/>{uiText("Today")}</button>
        <button type="button" className={`training-calendar-button${selectedDate === null ? ' is-active' : ''}`} aria-pressed={selectedDate === null} onClick={() => onSelectDate(null)}>{uiText("View whole month")}</button>
      </div>
    </div>

    <div className="training-calendar-navigation">
      <button type="button" className="training-calendar-arrow" aria-label={uiText("Previous month")} disabled={month === '0001-01'} onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={19} aria-hidden="true"/></button>
      <label className="training-calendar-month-picker" htmlFor={monthInputId}><span>{uiText("Jump to month")}</span><input id={monthInputId} type="month" min="0001-01" max="9999-12" value={month} onChange={event => jumpToMonth(event.target.value)}/></label>
      <button type="button" className="training-calendar-arrow" aria-label={uiText("Next month")} disabled={month === '9999-12'} onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={19} aria-hidden="true"/></button>
    </div>

    <div className="training-calendar-stats" aria-live="polite" aria-atomic="true">
      <div><strong>{completedDays}<small>{uiText(" days")}</small></strong><span>{uiText("Recorded training days")}</span></div>
      <div><strong>{completedCount}<small>{uiText(" sessions")}</small></strong><span>{uiText("Completed records")}</span></div>
      <div><strong>{plannedCount}<small>{uiText(" sessions")}</small></strong><span>{uiText("Planned records")}</span></div>
    </div>

    <div className="training-calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((day, index) => <span key={day} className={index > 4 ? 'is-weekend' : undefined}>{day}</span>)}</div>
    <div className="training-calendar-days" role="group" aria-label={`${monthLabel}${uiText("Date")}`} aria-describedby={legendId}>
      {days.map(({ date, day }, index) => {
        if (!date || day === null) return <div key={`empty-${index}`} className="training-calendar-empty" aria-hidden="true"/>;
        const records = recordsByDate.get(date);
        const hasCompleted = !!records?.completed.length;
        const hasPlanned = !!records?.planned.length;
        const parts = [...new Set([...(records?.completedParts ?? []), ...(records?.plannedParts ?? [])])];
        const label = dayLabel(date, records, today);
        const className = ['training-calendar-day', hasCompleted && 'has-completed', hasPlanned && 'has-planned', date === today && 'is-today', selectedDate === date && 'is-selected'].filter(Boolean).join(' ');
        return <button type="button" key={date} className={className} aria-label={label} title={label} aria-pressed={selectedDate === date} aria-current={date === today ? 'date' : undefined} onClick={() => onSelectDate(date)}>
          <span className="training-calendar-date" aria-hidden="true">{day}{date === today && <i/>}</span>
          <span className="training-calendar-day-records" aria-hidden="true">
            {hasCompleted && <span className="training-calendar-completed"><Check size={12}/>{records!.completed.length}{uiText(" sessions")}</span>}
            {hasPlanned && <span className="training-calendar-planned"><Clock3 size={12}/>{records!.planned.length}{uiText(" sessions")}</span>}
            {!records && <span className="training-calendar-no-record">—</span>}
          </span>
          {records && <span className="training-calendar-parts" aria-hidden="true">{parts.length ? parts.join('·') : uiText("Unspecified body part")}</span>}
        </button>;
      })}
    </div>

    <div id={legendId} className="training-calendar-legend"><span><i className="training-calendar-key-completed"/>{uiText("Completed")}</span><span><i className="training-calendar-key-planned"/>{uiText("Planned")}</span><span>{uiText("Unrecorded does not mean no training")}</span></div>
    <div className="training-calendar-selection" aria-live="polite">{selectedDate ? <span>{uiText("Selected: ")}{dateLabel(selectedDate)}{uiText(" · This date: ")}{(recordsByDate.get(selectedDate)?.completed.length ?? 0) + (recordsByDate.get(selectedDate)?.planned.length ?? 0)}{uiText(" records · Monthly total: ")}{completedCount + plannedCount}{uiText(" records")}</span> : <span>{uiText("Monthly total: ")}{completedCount + plannedCount}{uiText(" records · Planned sessions do not count as completed training days")}</span>}</div>
  </div>;
}
