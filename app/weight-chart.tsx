"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BodyMeasurement } from '@/lib/health-types';
import './weight-chart.css';

export type WeightChartProps = { measurements: BodyMeasurement[]; range: '30' | '90' | 'all' };
export type WeightChartPoint = { record: BodyMeasurement; day: number; x: number; y: number };
const DAY = 86_400_000;
const formatted = (value: number, digits = 6) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);
function dayOf(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? timestamp / DAY : null;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** All coordinates and selections refer to measured records, never interpolated days. */
export function buildWeightChartModel(measurements: BodyMeasurement[], range: WeightChartProps['range'], requestedWidth: number) {
  const width = Math.max(240, Number.isFinite(requestedWidth) ? requestedWidth : 360), narrow = width < 600;
  const height = narrow ? 250 : 300, left = 46, top = 24, right = 10, bottom = 40;
  const valid = measurements.filter(record => !record.archived && typeof record.weightKg === 'number' && Number.isFinite(record.weightKg) && record.weightKg > 0 && dayOf(record.date) !== null)
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const end = valid.length ? dayOf(valid.at(-1)!.date)! : 0;
  const cutoff = range === 'all' ? -Infinity : end - Number(range) + 1;
  const records = valid.filter(record => dayOf(record.date)! >= cutoff);
  const start = range === 'all' ? records.length ? dayOf(records[0].date)! : end : cutoff;
  const weights = records.map(record => record.weightKg!);
  const min = weights.length ? Math.floor((Math.min(...weights) - .5) * 2) / 2 : 0;
  const max = weights.length ? Math.ceil((Math.max(...weights) + .5) * 2) / 2 : 1;
  const dateX = (day: number) => end === start ? (width + left - right) / 2 : left + (day - start) / (end - start) * (width - left - right);
  const weightY = (weight: number) => top + (max - weight) / (max - min) * (height - top - bottom);
  const points = records.map(record => ({ record, day: dayOf(record.date)!, x: dateX(dayOf(record.date)!), y: weightY(record.weightKg!) }));
  const segments: WeightChartPoint[][] = [];
  points.forEach((point, index) => { if (!index || point.day - points[index - 1].day > 7) segments.push([]); segments.at(-1)!.push(point); });
  const tickCount = narrow ? 2 : 4;
  const dateTicks = records.length ? [...new Set(Array.from({ length: tickCount }, (_, index) => Math.round(start + (end - start) * index / (tickCount - 1))))] : [];
  const ticks = Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  return { width, height, left, top, right, bottom, start, end, points, segments, ticks, dateTicks, dateX, weightY };
}

export function nearestWeightPoint(points: readonly WeightChartPoint[], x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let result: WeightChartPoint | null = null;
  for (const point of points) {
    if (!result || Math.abs(point.x - x) < Math.abs(result.x - x) || Math.abs(point.x - x) === Math.abs(result.x - x) && Math.abs(point.y - y) < Math.abs(result.y - y)) result = point;
  }
  return result;
}

/** getScreenCTM includes SVG viewBox scaling and any surrounding CSS transform. */
export function clientToWeightChartPoint(svg: Pick<SVGSVGElement, 'createSVGPoint' | 'getScreenCTM'>, clientX: number, clientY: number) {
  try {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return Number.isFinite(local.x) && Number.isFinite(local.y) ? { x: local.x, y: local.y } : null;
  } catch { return null; }
}

export function weightChartKeyboardIndex(key: string, current: number, count: number) {
  if (!count || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return null;
  return key === 'Home' ? 0 : key === 'End' ? count - 1 : current === -1 ? key === 'ArrowLeft' ? count - 1 : 0 : clamp(current + (key === 'ArrowLeft' ? -1 : 1), 0, count - 1);
}

export function weightTooltipPosition(point: Pick<WeightChartPoint, 'x' | 'y'>, width: number, height: number, bottom = 40) {
  const tooltipWidth = Math.min(166, width - 20), tooltipHeight = 62;
  return {
    x: clamp(point.x > width / 2 ? point.x - tooltipWidth - 12 : point.x + 12, 8, width - tooltipWidth - 8),
    y: clamp(point.y - tooltipHeight - 12, 8, height - bottom - tooltipHeight - 6),
    width: tooltipWidth, height: tooltipHeight,
  };
}

type PointerTarget = Pick<SVGSVGElement, 'setPointerCapture' | 'releasePointerCapture' | 'hasPointerCapture'>;
type PointerInput = { pointerId: number; pointerType: string; clientX: number; clientY: number; currentTarget: PointerTarget; preventDefault(): void };
type InteractionOptions = {
  select(clientX: number, clientY: number): void;
  clear(): void;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** A single pointer gesture; before the hold threshold it never prevents scrolling. */
export function createWeightChartInteraction({ select, clear, schedule = setTimeout, unschedule = clearTimeout }: InteractionOptions) {
  let pending: { id: number; type: string; startX: number; startY: number; x: number; y: number; target: PointerTarget; active: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function stopTimer() { if (timer !== null) unschedule(timer); timer = null; }
  function release() {
    if (pending) { try { if (pending.target.hasPointerCapture(pending.id)) pending.target.releasePointerCapture(pending.id); } catch { /* Pointer may already have been cancelled by scrolling. */ } }
    pending = null;
  }
  function activate() {
    if (!pending) return;
    pending.active = true;
    try { pending.target.setPointerCapture(pending.id); } catch { /* Selection still works if capture is unavailable. */ }
    select(pending.x, pending.y);
  }
  const cancel = () => { stopTimer(); release(); clear(); };
  return {
    down(event: PointerInput) {
      cancel();
      pending = { id: event.pointerId, type: event.pointerType, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, target: event.currentTarget, active: false };
      if (event.pointerType === 'mouse') activate();
      else timer = schedule(() => { timer = null; activate(); }, 300);
    },
    move(event: PointerInput) {
      if (!pending) { if (event.pointerType === 'mouse') select(event.clientX, event.clientY); return; }
      if (pending.id !== event.pointerId) return;
      pending.x = event.clientX; pending.y = event.clientY;
      if (pending.active) { if (event.pointerType !== 'mouse') event.preventDefault(); select(event.clientX, event.clientY); }
      else if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) > 8) cancel();
    },
    up(event: PointerInput) {
      if (!pending || pending.id !== event.pointerId) return;
      const mouse = pending.type === 'mouse';
      stopTimer(); release();
      if (!mouse) clear();
    },
    cancel,
    leave: cancel,
    dispose() { stopTimer(); release(); },
    isActive: () => pending?.active === true,
  };
}

export default function WeightChart({ measurements, range }: WeightChartProps) {
  const container = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(360), [selectedId, setSelectedId] = useState<string | null>(null);
  const helpId = useId(), statusId = useId();
  const model = useMemo(() => buildWeightChartModel(measurements, range, width), [measurements, range, width]);
  const modelRef = useRef(model);
  const interaction = useRef<ReturnType<typeof createWeightChartInteraction> | null>(null);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => {
    const controller = createWeightChartInteraction({
      select(clientX, clientY) {
        if (!svg.current) return;
        const local = clientToWeightChartPoint(svg.current, clientX, clientY);
        const nearest = local ? nearestWeightPoint(modelRef.current.points, local.x, local.y) : null;
        setSelectedId(nearest?.record.id ?? null);
      },
      clear: () => setSelectedId(null),
    });
    interaction.current = controller;
    return () => { controller.dispose(); if (interaction.current === controller) interaction.current = null; };
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => { const measured = Math.floor(element.getBoundingClientRect().width); if (measured > 0) setWidth(measured); };
    measure();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { interaction.current?.cancel(); }, [measurements, range]);
  const selected = model.points.find(point => point.record.id === selectedId);
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { interaction.current?.cancel(); return; }
    const index = model.points.findIndex(point => point.record.id === selectedId);
    const next = weightChartKeyboardIndex(event.key, index, model.points.length);
    if (next === null) return;
    event.preventDefault();
    interaction.current?.cancel();
    setSelectedId(model.points[next].record.id);
  }
  const tooltip = weightTooltipPosition(selected ?? { x: 0, y: 0 }, model.width, model.height, model.bottom);
  const selectedText = selected ? selected.record.date + '，' + formatted(selected.record.weightKg!) + ' 千克' + (selected.record.condition ? '，' + selected.record.condition : '') : '';
  return <div className="weight-chart" ref={container} tabIndex={model.points.length ? 0 : undefined} role="group" aria-label="体重趋势，可用左右方向键查看各次实测记录，Escape关闭详情" aria-describedby={helpId + ' ' + statusId} onKeyDown={keyboard} onBlur={() => interaction.current?.cancel()}>
    {model.points.length ? <>
      <svg ref={svg} width={model.width} height={model.height} viewBox={'0 0 ' + model.width + ' ' + model.height} role="img" aria-label="按真实日期绘制的体重变化，超过七天的间隔不连线" onPointerEnter={event => interaction.current?.move(event)} onPointerDown={event => interaction.current?.down(event)} onPointerMove={event => interaction.current?.move(event)} onPointerUp={event => interaction.current?.up(event)} onPointerCancel={() => interaction.current?.cancel()} onPointerLeave={() => interaction.current?.leave()} onContextMenu={event => { if (interaction.current?.isActive()) event.preventDefault(); }}>
        <text x={model.left} y={14} className="weight-chart-axis">kg</text>
        {model.ticks.map(value => <g key={value}><line x1={model.left} x2={model.width - model.right} y1={model.weightY(value)} y2={model.weightY(value)} className="weight-chart-grid"/><text x={model.left - 9} y={model.weightY(value) + 5} textAnchor="end" className="weight-chart-axis">{formatted(value, 1)}</text></g>)}
        {model.dateTicks.map((day, index) => <text key={day} x={model.dateX(day)} y={model.height - 12} textAnchor={model.dateTicks.length === 1 ? 'middle' : index === 0 ? 'start' : index === model.dateTicks.length - 1 ? 'end' : 'middle'} className="weight-chart-axis">{new Date(day * DAY).toISOString().slice(0, 10)}</text>)}
        {model.segments.map((segment, index) => <polyline key={index} points={segment.map(point => point.x + ',' + point.y).join(' ')} fill="none" className="weight-chart-line"/>)}
        {model.points.map(point => <circle key={point.record.id} cx={point.x} cy={point.y} r={model.points.length > 160 ? 2 : 3.5} className="weight-chart-point"><title>{point.record.date + ' · ' + formatted(point.record.weightKg!) + ' kg' + (point.record.condition ? ' · ' + point.record.condition : '')}</title></circle>)}
        {selected && <g className="weight-chart-selection" aria-hidden="true"><line x1={selected.x} x2={selected.x} y1={model.top} y2={model.height - model.bottom} className="weight-chart-guide"/><circle cx={selected.x} cy={selected.y} r={10} className="weight-chart-halo"/><circle cx={selected.x} cy={selected.y} r={5.5} className="weight-chart-active"/><g transform={'translate(' + tooltip.x + ' ' + tooltip.y + ')'}><rect width={tooltip.width} height={tooltip.height} rx={9}/><text x={12} y={23} className="weight-chart-tooltip-date">{selected.record.date}</text><text x={12} y={46} className="weight-chart-tooltip-value">{formatted(selected.record.weightKg!)} kg</text></g></g>}
      </svg>
      <div className="weight-chart-caption"><span><i/>真实记录</span><span>{model.points.length} 条 · {model.points[0].record.date} 至 {model.points.at(-1)!.record.date}</span></div>
      <p className="weight-chart-help" id={helpId}>悬停或长按查看具体数值，按住后可左右拖动。键盘可用 ← → 切换。</p>
    </> : <div className="weight-chart-empty"><h3>这个时间范围没有体重记录</h3><p id={helpId}>可以选择全部查看历史；缺失日期不会补成零。</p></div>}
    <span className="weight-chart-status" id={statusId} role="status" aria-live="polite" aria-atomic="true">{selectedText}</span>
  </div>;
}
