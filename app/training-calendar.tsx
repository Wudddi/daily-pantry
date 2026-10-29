"use client";

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

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const uniqueParts = (sessions: TrainingSession[]) => [...new Set(sessions.flatMap(session => sessionBodyParts(session)))];

function torontoToday() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

function dateLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function dayLabel(date: string, records: DayRecords | undefined, today: string) {
  const label = `${dateLabel(date)}${date === today ? '，今天' : ''}`;
  if (!records) return `${label}，未记录训练；未记录不代表没训练`;
  const descriptions = [];
  if (records.completed.length) descriptions.push(`${records.completed.length}次已完成，${records.completedParts.join('、') || '训练部位未标注'}`);
  if (records.planned.length) descriptions.push(`${records.planned.length}次计划，${records.plannedParts.join('、') || '计划部位未标注'}`);
  return `${label}，${records.completed.length + records.planned.length}条记录；${descriptions.join('；')}`;
}

export default function TrainingCalendar({ sessions, month, onMonthChange, selectedDate, onSelectDate }: TrainingCalendarProps) {
  const headingId = useId();
  const monthInputId = useId();
  const legendId = useId();
  const today = torontoToday();
  const [year, monthNumber] = month.split('-').map(Number);
  const monthLabel = `${year}年${monthNumber}月`;
  const days = buildMonthDays(month);
  const { recordsByDate, completedDays, completedCount, plannedCount } = useMemo(() => {
    const recordsByDate = new Map<string, DayRecords>();
    for (const session of sessions) {
      if (!session.date.startsWith(`${month}-`)) continue;
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
      <div><span className="training-calendar-eyebrow">训练月历</span><h3 id={headingId}>{monthLabel}</h3></div>
      <div className="training-calendar-actions">
        <button type="button" className="training-calendar-button" onClick={selectToday}><CalendarDays size={16} aria-hidden="true"/>今天</button>
        <button type="button" className={`training-calendar-button${selectedDate === null ? ' is-active' : ''}`} aria-pressed={selectedDate === null} onClick={() => onSelectDate(null)}>查看整月</button>
      </div>
    </div>

    <div className="training-calendar-navigation">
      <button type="button" className="training-calendar-arrow" aria-label="查看上个月" disabled={month === '0001-01'} onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={19} aria-hidden="true"/></button>
      <label className="training-calendar-month-picker" htmlFor={monthInputId}><span>跳转月份</span><input id={monthInputId} type="month" min="0001-01" max="9999-12" value={month} onChange={event => jumpToMonth(event.target.value)}/></label>
      <button type="button" className="training-calendar-arrow" aria-label="查看下个月" disabled={month === '9999-12'} onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={19} aria-hidden="true"/></button>
    </div>

    <div className="training-calendar-stats" aria-live="polite" aria-atomic="true">
      <div><strong>{completedDays}<small>天</small></strong><span>已记录训练日</span></div>
      <div><strong>{completedCount}<small>次</small></strong><span>已完成记录</span></div>
      <div><strong>{plannedCount}<small>次</small></strong><span>计划记录</span></div>
    </div>

    <div className="training-calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((day, index) => <span key={day} className={index > 4 ? 'is-weekend' : undefined}>{day}</span>)}</div>
    <div className="training-calendar-days" role="group" aria-label={`${monthLabel}日期`} aria-describedby={legendId}>
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
            {hasCompleted && <span className="training-calendar-completed"><Check size={12}/>{records!.completed.length}次</span>}
            {hasPlanned && <span className="training-calendar-planned"><Clock3 size={12}/>{records!.planned.length}次</span>}
            {!records && <span className="training-calendar-no-record">—</span>}
          </span>
          {records && <span className="training-calendar-parts" aria-hidden="true">{parts.length ? parts.join('·') : '未标部位'}</span>}
        </button>;
      })}
    </div>

    <div id={legendId} className="training-calendar-legend"><span><i className="training-calendar-key-completed"/>已完成</span><span><i className="training-calendar-key-planned"/>计划</span><span>未记录不代表没训练</span></div>
    <div className="training-calendar-selection" aria-live="polite">{selectedDate ? <span>已选择 {dateLabel(selectedDate)} · 当日 {(recordsByDate.get(selectedDate)?.completed.length ?? 0) + (recordsByDate.get(selectedDate)?.planned.length ?? 0)} 条记录 · 本月共 {completedCount + plannedCount} 条记录</span> : <span>整月共 {completedCount + plannedCount} 条记录 · 计划不计入完成训练日</span>}</div>
  </div>;
}
