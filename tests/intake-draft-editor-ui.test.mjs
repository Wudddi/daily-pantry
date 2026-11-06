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
compiled = compiled.replace(/(?<=^import[^;\n]*\s)from\s+(["'])([^"']+)\1/gm, (_match, _quote, specifier) => 'from ' + JSON.stringify(
  specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier),
));
const { default: IntakeDraftEditor } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 100, protein: 10, carbs: 12, fat: 2, source: 'label' };
const food = (id, quantity = 100, patch = {}) => ({ id, itemId: id, name: "Food " + id, quantity, unit: 'g',
  nutritionSnapshot: { name: "Food " + id, unit: 'g', gramsPerUnit: null, nutrition }, ...patch });
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
  for (const name of ["Breakfast", "Lunch", "Snack", "Dinner"]) assert.ok(html.includes('<strong>' + name + '</strong>'));
  assert.match(html, /Saving a draft does not deduct inventory/); assert.match(html, /Consumed so far/);
  assert.match(html, /Breakfast Food breakfast cumulative consumed amount[^>]*type="number"[^>]*min="0"[^>]*value="0"/);
  assert.doesNotMatch(html, /cumulative consumed amount[^>]*max=/);
  assert.match(html, /disabled=""[^>]*>.*?Record this intake/s);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.deepEqual(p, before);
});

test('a saved partial draft retains the actual comparison, shows the correct remaining portion and has an explicit recording action', () => {
  const p = plan([meal('lunch', [food('rice', 200)]), meal('dinner', [food('rice', 100)])]);
  p.intakeDraft = draft(p, { consumed: [{ mealId: 'lunch', lineId: 'rice', quantity: 80, unit: 'g' }] });
  const html = render(p);
  assert.match(html, /Draft saved/); assert.match(html, /Reported: 0 g/);
  assert.match(html, /value="80"/); assert.match(html, /Meal remainder<\/span><strong>120 g/);
  assert.match(html, /Remaining: 220 g/); assert.match(html, /Consumed · including draft/);
  assert.match(html, /Save for another meal/); assert.match(html, /Move in from another meal/);
  assert.match(html, /<button[^>]*class="button primary"[^>]*>.*?Record this intake/s);
});

test('a transfer-only draft applies meal allocation without claiming food was eaten, while actual edits keep the recording action', () => {
  const p = plan([meal('lunch', [food('rice', 200)]), meal('dinner', [food('rice', 100)])]);
  p.intakeDraft = draft(p, { transfers: [{ id: 'move-rice', fromMealId: 'lunch', lineId: 'rice', toMealId: 'dinner', quantity: 50, unit: 'g' }] });
  const moved = render(p);
  assert.match(moved, /class="button primary"[^>]*>.*?Apply allocation/s);
  assert.match(moved, /Only changes meal allocations; does not report intake or deduct inventory/);
  assert.doesNotMatch(moved, /Record this intake/);
  p.intakeDraft.consumed.push({ mealId: 'lunch', lineId: 'rice', quantity: 80, unit: 'g' });
  assert.match(render(p), /class="button primary"[^>]*>.*?Record this intake/s);
  p.intakeDraft.consumed = [];
  p.intakeDraft.completedMealIds = ['lunch'];
  assert.match(render(p), /class="button primary"[^>]*>.*?Record this intake/s);
  p.meals[0].state = 'completed';
  p.intakeDraft.baseFingerprint = intakePlanFingerprint(p);
  assert.match(render(p), /class="button primary"[^>]*>.*?Apply allocation/s);
});

test('transferred rows keep a visible source and distinct input labels before and after submission without merging same-SKU lines', () => {
  const drink = quantity => food('milk', quantity, { unit: 'ml', nutritionSnapshot: { name: '食物 milk', unit: 'ml', nutrition: { ...nutrition, basisUnit: 'ml' } } });
  const p = plan([meal('snack', [drink(150)]), meal('breakfast', [drink(100)])]);
  p.intakeDraft = draft(p, { transfers: [{ id: 'move-drink', fromMealId: 'breakfast', lineId: 'milk', toMealId: 'snack', quantity: 50, unit: 'ml' }] });
  function check(html) {
    assert.match(html, /<p>From Breakfast<\/p>/);
    assert.match(html, /aria-label="Snack Food milk cumulative consumed amount"/);
    assert.match(html, /aria-label="Snack Food milk \(From Breakfast\) cumulative consumed amount"/);
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
  assert.match(html, /value="50"/); assert.match(html, /This corrects a previously reported amount/);
  assert.match(html, /Explicitly select/);
  assert.match(html, /class="button primary" disabled=""/);
  p.intakeDraft.consumed[0].correctExistingActuals = true;
  const corrected = render(p);
  assert.match(corrected, /type="checkbox" checked=""[^>]*\/><span>This corrects a previously reported amount/);
  assert.match(corrected, /Meal remainder<\/span><strong>150 g/);
});

test('already completed meals retain their completion fact while their cumulative actual quantity remains editable', () => {
  const p = plan([meal('lunch', [food('rice', 200)], { state: 'completed', actualEntries: [food('actual', 80, { itemId: 'rice' })] })]);
  const html = render(p);
  assert.match(html, /This meal was reported finished/); assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /value="80"/); assert.match(html, /The saved completion state is retained/);
});

test('closed remaining plans still allow actual quantity corrections while both transfer directions stay disabled', () => {
  const p = plan([meal('lunch', [food('rice', 200)], { state: 'completed', actualEntries: [food('actual', 80, { itemId: 'rice' })] }),
    meal('dinner', [food('rice', 100)])], { status: 'closed_with_actuals' });
  const html = render(p);
  const quantityInput = html.match(/<input[^>]*aria-label="Lunch Food rice cumulative consumed amount"[^>]*>/)?.[0];
  assert.ok(quantityInput); assert.doesNotMatch(quantityInput, /disabled/); assert.match(quantityInput, /value="80"/);
  assert.match(html, /Remaining plans are closed. You can review or correct reported amounts/);
  assert.match(html, /class="button secondary small" disabled=""[^>]*>.*?Move in from another meal/s);
  assert.match(html, /class="intake-transfer-button" disabled=""/);
});

test('gram conversion and mL units use saved snapshots while unknown actual amounts remain visibly unresolved', () => {
  const bag = food('beef', .5, { unit: '袋', nutritionSnapshot: { name: '分袋牛肉', unit: '袋', gramsPerUnit: 132, nutrition } });
  const milk = food('milk', 150, { unit: 'ml', nutritionSnapshot: { name: "Milk", unit: 'ml', nutrition: { ...nutrition, basisUnit: 'ml' } } });
  const known = render(plan([meal('lunch', [bag, milk])]));
  assert.match(known, /66 g/); assert.match(known, /150 mL/); assert.doesNotMatch(known, /0.5 bags/);
  const unknown = render(plan([meal('lunch', [food('rice')], { state: 'in_progress', actualEntries: [food('unreported', null, { itemId: 'rice' })] })]));
  assert.match(unknown, /Reported: Needs review/); assert.match(unknown, /Existing actual quantities are unknown/);
  assert.doesNotMatch(unknown, /Reported: 0 g/);
});

test('stale draft inputs are retained, submission is blocked, and pending accounting never claims a successful deduction', () => {
  const p = plan([meal('lunch', [food('rice', 200)])], { inventoryAccounting: 'pending_reconciliation', accountingIssues: [{ message: '剩余量需要重新核对' }] });
  p.intakeDraft = draft(p, { baseFingerprint: 'older-menu', consumed: [{ mealId: 'lunch', lineId: 'rice', quantity: 55, unit: 'g' }] });
  const html = render(p);
  assert.match(html, /The menu or intake records changed elsewhere/); assert.match(html, /value="55"/);
  assert.match(html, /class="button primary" disabled=""/); assert.match(html, /Refresh and review/);
  assert.match(html, /Intake saved; ingredient accounting needs review/); assert.match(html, /剩余量需要重新核对/);
  assert.doesNotMatch(html, /Inventory deducted correctly|Inventory settled successfully/);
});
