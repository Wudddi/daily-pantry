import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

let compiled = ts.transpileModule(await readFile(new URL('../app/weight-chart.tsx', import.meta.url), 'utf8'), { fileName: 'weight-chart.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import\s+["']\.\/weight-chart\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(import.meta.resolve(specifier)));
const { default: WeightChart, buildWeightChartModel, nearestWeightPoint, clientToWeightChartPoint, weightChartKeyboardIndex, weightTooltipPosition, createWeightChartInteraction } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

function record(id, date, weightKg, extra = {}) { return { id, date, weightKg, archived: false, condition: '', notes: '', sourceText: '', source: 'manual', createdAt: date, updatedAt: date, ...extra }; }
function clock() {
  let now = 0, id = 0; const tasks = new Map();
  return { schedule(callback, delay) { const key = ++id; tasks.set(key, { at: now + delay, callback }); return key; }, unschedule(key) { tasks.delete(key); }, advance(ms) { now += ms; for (const [key, task] of [...tasks]) if (task.at <= now) { tasks.delete(key); task.callback(); } }, count: () => tasks.size };
}
function gesture() {
  const timer = clock(), capture = new Set(), selections = [], clears = [];
  const target = { setPointerCapture(id) { capture.add(id); }, hasPointerCapture(id) { return capture.has(id); }, releasePointerCapture(id) { capture.delete(id); } };
  const controller = createWeightChartInteraction({ select: (x, y) => selections.push([x, y]), clear: () => clears.push(true), schedule: timer.schedule, unschedule: timer.unschedule });
  function event(pointerType, x, y, id = 1) { return { pointerType, clientX: x, clientY: y, pointerId: id, currentTarget: target, prevented: false, preventDefault() { this.prevented = true; } }; }
  return { timer, capture, selections, clears, controller, event };
}

test('ranges end at latest real measurement, retain metadata and never fabricate missing dates or bridge more than seven days', () => {
  const records = [record('old', '2020-01-01', 80), record('cutoff', '2020-01-03', 79.5), record('near', '2020-01-10', 79), record('gap', '2020-01-18', 78), record('last', '2020-02-01', 77.25, { condition: '晨起空腹' }), record('missing', '2020-02-02', null), record('archived', '2025-01-01', 60, { archived: true }), record('bad-date', '2020-02-30', 70)];
  const before = structuredClone(records), month = buildWeightChartModel(records, '30', 390);
  assert.equal(new Date(month.end * 86400000).toISOString().slice(0, 10), '2020-02-01');
  assert.deepEqual(month.points.map(point => point.record.id), ['cutoff', 'near', 'gap', 'last']);
  assert.deepEqual(month.segments.map(segment => segment.map(point => point.record.id)), [['cutoff', 'near'], ['gap'], ['last']]);
  assert.equal(month.points.at(-1).record, records[4]);
  assert.equal(month.height, 250);
  assert.equal(buildWeightChartModel(records, '90', 900).height, 300);
  assert.equal(buildWeightChartModel(records, 'all', 900).points.length, 5);
  assert.deepEqual(records, before);
});

test('nearest selection uses actual plotted x and breaks same-day ties by actual y', () => {
  const model = buildWeightChartModel([record('morning', '2026-10-19', 75), record('evening', '2026-10-19', 76), record('next', '2026-10-20', 74)], 'all', 390);
  const morning = model.points.find(point => point.record.id === 'morning');
  assert.equal(nearestWeightPoint(model.points, morning.x, morning.y).record.id, 'morning');
  assert.equal(nearestWeightPoint(model.points, 10000, 0).record.id, 'next');
  assert.equal(nearestWeightPoint([], 100, 100), null);
  assert.equal(nearestWeightPoint(model.points, NaN, 100), null);
});

test('client coordinates use the inverse SVG screen transform including viewBox scale and offsets', () => {
  let inverseUsed = false;
  const svg = { getScreenCTM: () => ({ inverse() { inverseUsed = true; return { scale: .5, x: -50, y: -25 }; } }), createSVGPoint: () => ({ x: 0, y: 0, matrixTransform(matrix) { return { x: this.x * matrix.scale + matrix.x, y: this.y * matrix.scale + matrix.y }; } }) };
  assert.deepEqual(clientToWeightChartPoint(svg, 200, 100), { x: 50, y: 25 });
  assert.equal(inverseUsed, true);
  assert.equal(clientToWeightChartPoint({ ...svg, getScreenCTM: () => null }, 200, 100), null);
});

test('touch holds 300ms before selecting, then captures and follows drag; release clears the transient detail', () => {
  const { controller, timer, selections, capture, event } = gesture();
  const down = event('touch', 100, 80); controller.down(down);
  timer.advance(299);
  assert.equal(selections.length, 0); assert.equal(down.prevented, false); assert.equal(capture.size, 0);
  const slightMove = event('touch', 104, 81); controller.move(slightMove);
  assert.equal(slightMove.prevented, false);
  timer.advance(1);
  assert.deepEqual(selections, [[104, 81]]); assert.equal(capture.has(1), true);
  const drag = event('touch', 200, 90); controller.move(drag);
  assert.equal(drag.prevented, true); assert.deepEqual(selections.at(-1), [200, 90]);
  controller.up(event('touch', 200, 90));
  assert.equal(capture.size, 0); assert.equal(controller.isActive(), false); assert.equal(timer.count(), 0);
});

test('a short touch scroll cancels the pending hold without ever preventing default or selecting a point', () => {
  const { controller, timer, selections, capture, event } = gesture();
  controller.down(event('touch', 100, 80));
  const scroll = event('touch', 100, 91); controller.move(scroll);
  timer.advance(1000);
  assert.equal(scroll.prevented, false); assert.equal(timer.count(), 0); assert.equal(capture.size, 0); assert.equal(selections.length, 0);
  controller.move(event('touch', 100, 140));
  assert.equal(selections.length, 0);
});

test('mouse hover is immediate and mouse-held dragging works without the touch delay', () => {
  const { controller, timer, selections, capture, event } = gesture();
  controller.move(event('mouse', 90, 40));
  assert.deepEqual(selections, [[90, 40]]);
  controller.down(event('mouse', 120, 70));
  assert.equal(capture.has(1), true); assert.equal(timer.count(), 0);
  controller.move(event('mouse', 220, 60));
  assert.deepEqual(selections.at(-1), [220, 60]);
  controller.leave();
  assert.equal(capture.size, 0); assert.equal(controller.isActive(), false);
});

test('cancel, pointer-leave and disposal clear hold timers and capture, including a second pointer', () => {
  for (const method of ['cancel', 'leave', 'dispose']) {
    const { controller, timer, selections, capture, event } = gesture();
    controller.down(event('pen', 100, 80)); controller[method](); timer.advance(500);
    assert.equal(selections.length, 0); assert.equal(capture.size, 0);
  }
  const { controller, selections, event, capture } = gesture();
  controller.down(event('mouse', 10, 20));
  controller.move(event('mouse', 200, 300, 2));
  assert.deepEqual(selections.at(-1), [10, 20]);
  controller.cancel(); assert.equal(capture.size, 0);
});

test('keyboard traversal stays within real records and edge tooltips flip and clamp inside the viewBox', () => {
  assert.equal(weightChartKeyboardIndex('ArrowRight', -1, 3), 0);
  assert.equal(weightChartKeyboardIndex('ArrowLeft', -1, 3), 2);
  assert.equal(weightChartKeyboardIndex('ArrowRight', 2, 3), 2);
  assert.equal(weightChartKeyboardIndex('ArrowLeft', 0, 3), 0);
  assert.equal(weightChartKeyboardIndex('Home', 2, 3), 0);
  assert.equal(weightChartKeyboardIndex('End', 0, 3), 2);
  assert.equal(weightChartKeyboardIndex('ArrowRight', 0, 0), null);
  for (const point of [{ x: -100, y: -100 }, { x: 1000, y: 1000 }, { x: 200, y: 100 }]) {
    const box = weightTooltipPosition(point, 320, 250);
    assert.ok(box.x >= 8 && box.x + box.width <= 312);
    assert.ok(box.y >= 8 && box.y + box.height < 210);
  }
  assert.ok(weightTooltipPosition({ x: 310, y: 100 }, 320, 250).x < 310);
});

test('SSR keeps responsive SVG, actual point dates, accessible keyboard guidance and an honest empty state', () => {
  const html = renderToStaticMarkup(React.createElement(WeightChart, { measurements: [record('one', '2020-01-01', 77.25), record('two', '2020-01-20', 76.5)], range: 'all' }));
  assert.match(html, /viewBox="0 0 360 250"/);
  assert.equal([...html.matchAll(/class="weight-chart-point"/g)].length, 2);
  assert.equal([...html.matchAll(/<polyline/g)].length, 2);
  assert.match(html, /2020-01-01 · 77.25 kg/);
  assert.match(html, /左右方向键/); assert.match(html, /长按/); assert.match(html, /aria-live="polite"/);
  const empty = renderToStaticMarkup(React.createElement(WeightChart, { measurements: [], range: '30' }));
  assert.match(empty, /没有体重记录/); assert.doesNotMatch(empty, /<circle|tabindex="0"/);
});
