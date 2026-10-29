"use client";

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
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function torontoToday() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

function dateLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function kcalLabel(kcal: number, compact = false) {
  return new Intl.NumberFormat('zh-CN', compact && kcal >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0, useGrouping: false }).format(kcal);
}

function energyDescription(day: CalendarValue) {
  if (day.duplicate) return '同日多份菜单待核对，热量待补齐';
  if (day.partial || day.kcal === null) return `热量待补齐${day.kcal === null ? '' : `，已知部分${day.estimated ? '约' : ''}${kcalLabel(day.kcal)}千卡，非全天总量`}`;
  return `${day.estimated ? '估算约' : ''}${kcalLabel(day.kcal)}千卡`;
}

export default function DietCalendar({ days, month, selectedDate, onMonthChange, onSelectDate }: DietCalendarProps) {
  const headingId = useId();
  const inputId = useId();
  const legendId = useId();
  const today = torontoToday();
  const [year, monthNumber] = month.split('-').map(Number);
  const monthLabel = `${year}年${monthNumber}月`;
  const monthDays = buildMonthDays(month);
  const { byDate, finalCount, draftCount, partialCount } = useMemo(() => {
    const byDate = new Map<string, CalendarValue>();
    for (const day of days) {
      if (!day.date.startsWith(`${month}-`)) continue;
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
      <div><span className="diet-calendar-eyebrow">饮食月历</span><h3 id={headingId}>{monthLabel}</h3></div>
      <button type="button" className="diet-calendar-button" onClick={selectToday}><CalendarDays size={16} aria-hidden="true"/>今天</button>
    </div>
    <div className="diet-calendar-navigation">
      <button type="button" className="diet-calendar-arrow" disabled={month === '0001-01'} aria-label="查看上个月饮食" onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={19} aria-hidden="true"/></button>
      <label className="diet-calendar-month-picker" htmlFor={inputId}><span>跳转月份</span><input id={inputId} type="month" min="0001-01" max="9999-12" value={month} onChange={event => jumpToMonth(event.target.value)}/></label>
      <button type="button" className="diet-calendar-arrow" disabled={month === '9999-12'} aria-label="查看下个月饮食" onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={19} aria-hidden="true"/></button>
    </div>
    <div className="diet-calendar-summary" aria-live="polite" aria-atomic="true"><span><i className="diet-calendar-key-final"/>已保存菜单 {finalCount + draftCount} 天</span>{partialCount > 0 && <span className="diet-calendar-pending-count">热量待补齐 {partialCount} 天</span>}</div>
    <div className="diet-calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((day, index) => <span key={day} className={index > 4 ? 'is-weekend' : undefined}>{day}</span>)}</div>
    <div className="diet-calendar-days" role="group" aria-label={`${monthLabel}饮食日期`} aria-describedby={legendId}>
      {monthDays.map(({ date, day }, index) => {
        if (!date || day === null) return <div className="diet-calendar-empty" key={`empty-${index}`} aria-hidden="true"/>;
        const value = byDate.get(date);
        const incomplete = !!value && (value.partial || value.kcal === null);
        const energy = value ? energyDescription(value) : '';
        const label = `${dateLabel(date)}${date === today ? '，今天' : ''}，${value ? `已保存菜单，${energy}` : '无已保存菜单'}`;
        const className = ['diet-calendar-day', value && 'has-final', incomplete && 'is-partial', selectedDate === date && 'is-selected', today === date && 'is-today'].filter(Boolean).join(' ');
        return <button type="button" className={className} key={date} onClick={() => onSelectDate(date)} aria-label={label} title={label} aria-pressed={selectedDate === date} aria-current={date === today ? 'date' : undefined}>
          <span className="diet-calendar-date" aria-hidden="true">{day}{date === today && <i/>}</span>
          {value && <>
            <span className={`diet-calendar-energy${incomplete ? ' is-incomplete' : ''}`} aria-hidden="true">{incomplete ? '待补齐' : `${value.estimated ? '≈' : ''}${kcalLabel(value.kcal!, true)}`}</span>
            {!incomplete && <span className="diet-calendar-unit" aria-hidden="true">kcal</span>}
            <span className="diet-calendar-state" aria-hidden="true">菜单</span>
          </>}
        </button>;
      })}
    </div>
    <div className="diet-calendar-legend" id={legendId}><span>≈ 为估算热量</span><span>待补齐表示热量不完整</span></div>
    <p className="diet-calendar-selection" aria-live="polite">{dateLabel(selectedDate)}{byDate.has(selectedDate) ? ` · 已保存菜单 · ${energyDescription(byDate.get(selectedDate)!)}` : ' · 点击日期查看或安排当天饮食'}</p>
  </div>;
}
