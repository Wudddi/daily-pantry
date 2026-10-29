import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { weightStats } from '../lib/weight-stats.mjs';

const source = await readFile(new URL('../app/health-records.tsx', import.meta.url), 'utf8');
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const hooks = dataUrl(`export const useState=v=>[typeof v==='function'?v():v,()=>{}];
export const useRef=v=>({current:v}); export const useEffect=()=>{};
export const useMemo=f=>f(); export const useId=()=>"test-modal";`);
const stub = dataUrl('export default function Stub(){return null}');
let code = ts.transpileModule(source + '\nexport { WeightSummary, WeightComparisons, MeasurementEditor };', {
  fileName: 'health-records.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/import\s+["']\.\/health\.css["'];?/g, '');
code = code.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => {
  const url = specifier === 'react' ? hooks : specifier.startsWith('@/lib/')
    ? new URL('../lib/' + specifier.slice('@/lib/'.length), import.meta.url).href
    : specifier.startsWith('./') ? stub : import.meta.resolve(specifier);
  return 'from ' + JSON.stringify(url);
});
const { WeightSummary, WeightComparisons, MeasurementEditor } = await import(dataUrl(code));
function measurement(patch = {}) {
  return { id: 'weight', date: '2026-10-20', weightKg: 72.8, waistCm: null, bodyFatPct: null,
    archived: false, condition: '', notes: '原话保留', sourceText: '', source: 'manual',
    createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', ...patch };
}
const status = { stale: false, saving: false, conflict: false, loading: false, error: '', onRefresh() {}, onClose() {} };

test('sparse comparison shows actual endpoints and coverage without inventing a complete week', () => {
  const progress = weightStats([
    measurement({ id: 'old', date: '2026-10-10', weightKg: 75 }),
    measurement({ id: 'old2', date: '2026-10-11', weightKg: 74 }),
    measurement({ id: 'earlier', date: '2026-10-15', weightKg: 73.8 }), measurement(),
  ]);
  const html = renderToStaticMarkup(React.createElement(WeightComparisons, { progress }));
  assert.match(html, /截至 2026-10-20/);
  assert.match(html, /2026-10-15 · 73.8 → 2026-10-20 · 72.8 kg/);
  assert.match(html, /本期 2\/7 天 · 前期 2\/7 天/);
  assert.match(html, /首末实测变化/);
  const summary = renderToStaticMarkup(React.createElement(WeightSummary, { progress }));
  assert.match(summary, /73.3/); assert.match(summary, /覆盖 2\/7 天/);
});

test('editing a legacy body-fat-only record hides that input but preserves its saved value and evidence', async () => {
  const original = measurement({ weightKg: null, bodyFatPct: 19.2 });
  let saved;
  const element = MeasurementEditor({ ...status, initial: original, onSave: async record => { saved = record; } });
  const html = renderToStaticMarkup(element);
  assert.doesNotMatch(html, /体脂率|19\.2/);
  assert.match(html, /腰围/); assert.match(html, /原话保留/);
  await element.props.children.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, original);
  assert.equal(saved.bodyFatPct, 19.2);
});

test('new empty measurement cannot save while weight and waist records can', async () => {
  for (const patch of [{ weightKg: null }, { weightKg: 72.8 }, { weightKg: null, waistCm: 82 }]) {
    let calls = 0;
    const initial = measurement(patch);
    const element = MeasurementEditor({ ...status, initial, onSave: async () => { calls++; } });
    await element.props.children.props.onSubmit({ preventDefault() {} });
    assert.equal(calls, initial.weightKg !== null || initial.waistCm !== null ? 1 : 0);
  }
});
