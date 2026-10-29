import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { intakePlanFingerprint, prepareIntakeDraft } from '../lib/intake-draft.mjs';

let compiled = ts.transpileModule(await readFile(new URL('../app/intake-draft-editor.tsx', import.meta.url), 'utf8'), {
  fileName: 'intake-draft-editor.tsx',
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/import\s+["']\.\/intake-draft-editor\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(
  specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier),
));
const { default: IntakeDraftEditor } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 100, protein: 10, carbs: 12, fat: 2, source: 'label' };
const food = (id, quantity = 100, patch = {}) => ({ id, itemId: id, name: '食物 ' + id, quantity, unit: 'g',
  nutritionSnapshot: { name: '食物 ' + id, unit: 'g', gramsPerUnit: null, nutrition }, ...patch });
const meal = (id, plannedItems, patch = {}) => ({ id, slot: id, title: id + ' 菜单', state: 'reserved', plannedItems,
  actualEntries: [], actualTime: null, actualTimeText: '', reportHistory: [], completionReportedAt: null, ...patch });
const plan = (meals, patch = {}) => ({ id: 'test-day', format: 'meals_v1', date: '2026-10-26', status: 'draft',
  title: '测试当天菜单', meals, supplementDoses: [], inventoryAccounting: 'settled', accountingIssues: [], ...patch });
function draft(p, patch = {}) { return { id: 'intake-test', baseFingerprint: intakePlanFingerprint(p), consumed: [], transfers: [], completedMealIds: [], ...patch }; }
function render(p, patch = {}) {
  return renderToStaticMarkup(React.createElement(IntakeDraftEditor, { plan: p, items: [], revision: 4, busy: false,
    error: '', mutate: async () => { throw new Error('render must never save'); }, refresh: async () => {}, ...patch }));
}

test('initial editor exposes all meal selectors and a cumulative input without recording food or completing a meal', () => {
  const p = plan(['breakfast', 'lunch', 'snack', 'dinner'].map(id => meal(id, [food(id)]))), before = structuredClone(p);
  const html = render(p);
  for (const name of ['早餐', '午餐', '加餐', '晚餐']) assert.ok(html.includes('<strong>' + name + '</strong>'));
  assert.match(html, /保存草稿不会扣库存/); assert.match(html, /累计已吃/);
  assert.match(html, /早餐 食物 breakfast累计已吃量[^>]*type="number"[^>]*min="0"[^>]*value="0"/);
  assert.doesNotMatch(html, /累计已吃量[^>]*max=/);
  assert.match(html, /disabled=""[^>]*>.*?记录这些已吃/s);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.deepEqual(p, before);
});

test('a saved partial draft retains the actual comparison, shows the correct remaining portion and has an explicit recording action', () => {
  const p = plan([meal('lunch', [food('rice', 200)]), meal('dinner', [food('rice', 100)])]);
  p.intakeDraft = draft(p, { consumed: [{ mealId: 'lunch', lineId: 'rice', quantity: 80, unit: 'g' }] });
  const html = render(p);
  assert.match(html, /草稿已保存/); assert.match(html, /已记实际：0 g/);
  assert.match(html, /value="80"/); assert.match(html, /本餐还剩<\/span><strong>120 g/);
  assert.match(html, /还剩 220 g/); assert.match(html, /已吃 · 含草稿/);
  assert.match(html, /留到其他餐/); assert.match(html, /从其他餐调入/);
  assert.match(html, /<button[^>]*class="button primary"[^>]*>.*?记录这些已吃/s);
});

test('a transfer-only draft applies meal allocation without claiming food was eaten, while actual edits keep the recording action', () => {
  const p = plan([meal('lunch', [food('rice', 200)]), meal('dinner', [food('rice', 100)])]);
  p.intakeDraft = draft(p, { transfers: [{ id: 'move-rice', fromMealId: 'lunch', lineId: 'rice', toMealId: 'dinner', quantity: 50, unit: 'g' }] });
  const moved = render(p);
  assert.match(moved, /class="button primary"[^>]*>.*?应用餐次调配/s);
  assert.match(moved, /只调整餐次，不新增进食记录，不扣库存/);
  assert.doesNotMatch(moved, /记录这些已吃/);
  p.intakeDraft.consumed.push({ mealId: 'lunch', lineId: 'rice', quantity: 80, unit: 'g' });
  assert.match(render(p), /class="button primary"[^>]*>.*?记录这些已吃/s);
  p.intakeDraft.consumed = [];
  p.intakeDraft.completedMealIds = ['lunch'];
  assert.match(render(p), /class="button primary"[^>]*>.*?记录这些已吃/s);
  p.meals[0].state = 'completed';
  p.intakeDraft.baseFingerprint = intakePlanFingerprint(p);
  assert.match(render(p), /class="button primary"[^>]*>.*?应用餐次调配/s);
});

test('transferred rows keep a visible source and distinct input labels before and after submission without merging same-SKU lines', () => {
  const drink = quantity => food('milk', quantity, { unit: 'ml', nutritionSnapshot: { name: '食物 milk', unit: 'ml', nutrition: { ...nutrition, basisUnit: 'ml' } } });
  const p = plan([meal('snack', [drink(150)]), meal('breakfast', [drink(100)])]);
  p.intakeDraft = draft(p, { transfers: [{ id: 'move-drink', fromMealId: 'breakfast', lineId: 'milk', toMealId: 'snack', quantity: 50, unit: 'ml' }] });
  function check(html) {
    assert.match(html, /<p>从早餐调入<\/p>/);
    assert.match(html, /aria-label="加餐 食物 milk累计已吃量"/);
    assert.match(html, /aria-label="加餐 食物 milk（从早餐调入）累计已吃量"/);
    assert.match(html, /150 mL/); assert.match(html, /50 mL/);
    assert.equal((html.match(/class="intake-food-row"/g) ?? []).length, 2);
  }
  check(render(p));
  const applied = prepareIntakeDraft(p, p.intakeDraft).plan;
  applied.intakeDraftAudit = [{ id: p.intakeDraft.id, at: '2026-10-26T12:00:00Z', draft: p.intakeDraft }];
  delete applied.intakeDraft;
  check(render(applied));
});

test('reduction below an existing recorded intake requires the explicit correction checkbox and preserves the typed target', () => {
  const actual = { ...food('chat-entry', 80, { itemId: 'rice' }), sourceText: '原先用户报告80g' };
  const p = plan([meal('lunch', [food('rice', 200)], { actualEntries: [actual], state: 'in_progress' })]);
  p.intakeDraft = draft(p, { consumed: [{ mealId: 'lunch', lineId: 'rice', quantity: 50, unit: 'g' }] });
  const html = render(p);
  assert.match(html, /value="50"/); assert.match(html, /这是对已记录用量的更正/);
  assert.match(html, /请明确勾选这是对已记录用量的更正/);
  assert.match(html, /class="button primary" disabled=""/);
  p.intakeDraft.consumed[0].correctExistingActuals = true;
  const corrected = render(p);
  assert.match(corrected, /type="checkbox" checked=""[^>]*\/><span>这是对已记录用量的更正/);
  assert.match(corrected, /本餐还剩<\/span><strong>150 g/);
});

test('already completed meals retain their completion fact while their cumulative actual quantity remains editable', () => {
  const p = plan([meal('lunch', [food('rice', 200)], { state: 'completed', actualEntries: [food('actual', 80, { itemId: 'rice' })] })]);
  const html = render(p);
  assert.match(html, /这餐已记录结束/); assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /value="80"/); assert.match(html, /保留已保存的完成状态/);
});

test('closed remaining plans still allow actual quantity corrections while both transfer directions stay disabled', () => {
  const p = plan([meal('lunch', [food('rice', 200)], { state: 'completed', actualEntries: [food('actual', 80, { itemId: 'rice' })] }),
    meal('dinner', [food('rice', 100)])], { status: 'closed_with_actuals' });
  const html = render(p);
  const quantityInput = html.match(/<input[^>]*aria-label="午餐 食物 rice累计已吃量"[^>]*>/)?.[0];
  assert.ok(quantityInput); assert.doesNotMatch(quantityInput, /disabled/); assert.match(quantityInput, /value="80"/);
  assert.match(html, /剩余计划已结束，仍可核对、更正已记录的实际用量/);
  assert.match(html, /class="button secondary small" disabled=""[^>]*>.*?从其他餐调入/s);
  assert.match(html, /class="intake-transfer-button" disabled=""/);
});

test('gram conversion and mL units use saved snapshots while unknown actual amounts remain visibly unresolved', () => {
  const bag = food('beef', .5, { unit: '袋', nutritionSnapshot: { name: '分袋牛肉', unit: '袋', gramsPerUnit: 132, nutrition } });
  const milk = food('milk', 150, { unit: 'ml', nutritionSnapshot: { name: '牛奶', unit: 'ml', nutrition: { ...nutrition, basisUnit: 'ml' } } });
  const known = render(plan([meal('lunch', [bag, milk])]));
  assert.match(known, /66 g/); assert.match(known, /150 mL/); assert.doesNotMatch(known, /0.5 袋/);
  const unknown = render(plan([meal('lunch', [food('rice')], { state: 'in_progress', actualEntries: [food('unreported', null, { itemId: 'rice' })] })]));
  assert.match(unknown, /已记实际：待核对/); assert.match(unknown, /既有实际用量未知/);
  assert.doesNotMatch(unknown, /已记实际：0 g/);
});

test('stale draft inputs are retained, submission is blocked, and pending accounting never claims a successful deduction', () => {
  const p = plan([meal('lunch', [food('rice', 200)])], { inventoryAccounting: 'pending_reconciliation', accountingIssues: [{ message: '剩余量需要重新核对' }] });
  p.intakeDraft = draft(p, { baseFingerprint: 'older-menu', consumed: [{ mealId: 'lunch', lineId: 'rice', quantity: 55, unit: 'g' }] });
  const html = render(p);
  assert.match(html, /菜单或实际记录已在别处更新/); assert.match(html, /value="55"/);
  assert.match(html, /class="button primary" disabled=""/); assert.match(html, /刷新核对/);
  assert.match(html, /实际记录已保存，库存仍待核对/); assert.match(html, /剩余量需要重新核对/);
  assert.doesNotMatch(html, /已正确扣库存|库存已结算成功/);
});
