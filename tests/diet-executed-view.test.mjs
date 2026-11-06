import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { mealExecutionView, readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';

const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 120, protein: 8, carbs: 20, fat: 1, source: 'estimate', sourceText: "Complete label or estimate provenance" };
function line(id, name, quantity, unit = 'g', itemId = id) {
  return { id, itemId, name, quantity, unit, sourceText: "Original plan " + name, nutritionSnapshot: { name, unit, nutrition, gramsPerUnit: null, ingredients: '', supplementFacts: '' } };
}
function actual(id, name, quantity, unit = 'g', itemId = id) {
  return { ...line(id, name, quantity, unit, itemId), reportedAt: '2026-10-20T20:00:00Z', quantitySource: quantity === null ? 'unknown' : 'reported', correctionHistory: [], sourceText: "Complete actual source text " + name };
}
function meal(patch = {}) {
  return { id: 'dinner', slot: 'dinner', title: "Dinner", state: 'reserved', plannedTime: null, plannedTimeText: '', actualTime: null, actualTimeText: '', completionReportedAt: null, sourceText: '', reportHistory: [], plannedItems: [line('pasta', "Pasta", 110)], actualEntries: [], ...patch };
}
function state(target) {
  return { schemaVersion: 1, revision: 7, items: [], preferences: ["Meal edits still follow all current preferences"], plans: [{ id: 'day', format: 'meals_v1', status: 'reserved', date: '2026-10-20', title: "Final menu", intakeBasis: 'confirmed_daily_plan', inventoryAccounting: 'settled', accountingIssues: [], accountedDebits: [], supplementDoses: [], meals: [target] }], dietHistory: [] };
}

const source = await readFile(new URL('../app/diet-records.tsx', import.meta.url), 'utf8');
let nutritionComponent = ts.transpileModule(await readFile(new URL('../app/meal-nutrition.tsx', import.meta.url), 'utf8'), { fileName: 'meal-nutrition.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
nutritionComponent = nutritionComponent.replace(/import\s+["'][^"']+\.css["'];?/g, '').replace(/(?<=^import[^\n]*)from\s+(["'])([^"']+)\1/gm, (_match, _quote, specifier) => 'from ' + JSON.stringify(specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier)));
const nutritionComponentUrl = 'data:text/javascript;base64,' + Buffer.from(nutritionComponent).toString('base64');
let compiled = ts.transpileModule(source, { fileName: 'diet-records.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import\s+["'][^"']+\.css["'];?/g, '');
const stub = 'data:text/javascript;base64,' + Buffer.from('export default function Stub(){return null}').toString('base64');
compiled = compiled.replace(/(?<=^import[^\n]*)from\s+(["'])([^"']+)\1/gm, (_match, _quote, specifier) => {
  const url = specifier === './meal-nutrition' ? nutritionComponentUrl : specifier.startsWith('@/lib/') ? new URL('../lib/' + specifier.slice('@/lib/'.length), import.meta.url).href : specifier.startsWith('./') ? stub : import.meta.resolve(specifier);
  return 'from ' + JSON.stringify(url);
});
const { ExecutedMealCard } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const render = value => renderToStaticMarkup(React.createElement(ExecutedMealCard, { meal: value }));

test('completed swapped dinner leads with actual food, marks zero pasta uneaten and folds the original 110g plan', () => {
  const target = meal({ state: 'completed', title: "Dinner · original plan 110 g pasta", actualEntries: [
    actual('bagel', "Bagel", 1, '个'), actual('butter', "Butter", 5), actual('veg', "Vegetables", 150),
    actual('beef', "Beef", 0.5, '袋'), actual('fish', "Fish", 1, '罐'), actual('no-pasta', "Pasta", 0, 'g', 'pasta'),
  ] });
  const before = structuredClone(target), html = render(target);
  const main = html.split('<details class="diet-actual">')[0];
  assert.match(main, /Bagel/); assert.match(main, /Butter/); assert.match(main, /0\.5 bags/); assert.match(main.replace(/<[^>]*>/g, ''), /Not eaten · 0 g/);
  assert.doesNotMatch(main, /110 ?g/);
  assert.match(main, /Dinner · Reported intake/);
  assert.match(html, /Original plan \(comparison only\)/); assert.match(html, /110 g/);
  assert.match(html, /Complete actual source text Bagel/);
  assert.deepEqual(target, before);
});

test('unreported meals stay on the final plan without requiring a check-in', () => {
  const target = meal(), view = mealExecutionView(target), html = render(target);
  assert.equal(view.mode, 'planned');
  assert.deepEqual(view.remainingItems, []);
  assert.match(html, /110 g/); assert.match(html, /The current menu remains editable\. Personal checks do not affect inventory\. Day-end policy and explicit intake corrections settle separately\./); assert.match(html, /Personal checks do not affect inventory/); assert.match(html, /The current menu remains editable\. Personal checks do not affect inventory\. Day-end policy and explicit intake corrections settle separately\./);
  assert.doesNotMatch(html, /Reported foods|Retained plan/);
});

test('partial reports separate reported food and unreported remaining portions, including repeated planned food', () => {
  const target = meal({ state: 'in_progress', plannedItems: [line('first', "Beef", 1, '袋', 'beef'), line('second', "Beef", 2, '袋', 'beef'), line('veg', "Vegetables", 150)], actualEntries: [actual('beef-entry', "Beef", 2.5, '袋', 'beef'), actual('extra', "Fish", 1, '罐')] });
  const view = mealExecutionView(target), html = render(target);
  assert.equal(view.mode, 'partial');
  assert.deepEqual(view.remainingItems.map(item => [item.id, item.quantity]), [['second', .5], ['veg', 150]]);
  assert.match(html, /Reported foods/); assert.match(html, /Retained plan · unreported/); assert.match(html, /These are remaining planned amounts, not foods already eaten\. Tell Chat if anything changes\./);
  assert.doesNotMatch(html, /Actual intake recorded/);
});

test('a partial completion flag without food details still labels every retained portion as unreported', () => {
  const target = meal({ state: 'in_progress' }), view = mealExecutionView(target), html = render(target);
  assert.equal(view.mode, 'partial');
  assert.equal(view.remainingItems[0].quantity, 110);
  assert.match(html, /Partially reported/); assert.match(html, /Actual foods were not specified\. The original plan is not treated as eaten\./);
  assert.match(html, /Retained plan · unreported/);
});

test('unknown or incompatible actual quantities do not invent a remaining balance', () => {
  for (const entry of [actual('unknown', "Pasta", null, 'g', 'pasta'), actual('different', "Pasta", 1, '袋', 'pasta')]) {
    const view = mealExecutionView(meal({ state: 'in_progress', actualEntries: [entry] }));
    assert.equal(view.remainingItems[0].quantity, null);
    assert.match(view.remainingItems[0].remainingNote, /Remaining balance needs review; original plan /);
  }
  const zero = mealExecutionView(meal({ state: 'in_progress', actualEntries: [actual('zero', "Pasta", 0, 'g', 'pasta')] }));
  assert.equal(zero.remainingItems[0].quantity, 110);
});

test('completed without food details never relabels the old planned food as eaten; original reports and previous plans stay readable', () => {
  const report = "Complete actual source text".repeat(1500);
  const target = meal({ state: 'completed', sourceText: report, planRevisionHistory: [{ at: '2026-10-20T21:00:00Z', previous: { slot: 'dinner', title: "Previous dinner", plannedTime: null, plannedTimeText: "Dinner", plannedItems: [line('old', "Original prepared meal", 1, '袋')] } }] });
  const html = render(target), main = html.split('<details class="diet-actual">')[0];
  assert.match(main, /Actual foods were not specified\. The original plan is not treated as eaten\./); assert.doesNotMatch(main, /110 g/);
  assert.ok(html.includes(report)); assert.match(html, /Previous plan \(1\)/); assert.match(html, /Original prepared meal/);
});

test('light edit read exposes complete immutable actual facts alongside editable planned fields without original report text', () => {
  const target = meal({ state: 'completed', actualEntries: [actual('actual-zero', "Pasta", 0), actual('actual-unknown', "Vegetables", null)], sourceText: "Complete source text excluded from a compact read" });
  const original = state(target), before = structuredClone(original);
  const result = readFoodPlanEditContext(original, { planId: 'day', mealIds: ['dinner'] });
  const value = result.meals[0];
  assert.equal(value.canPatch, true); assert.equal(value.canRemove, false); assert.equal(value.actualFactsImmutable, true);
  assert.equal(value.state, 'completed');
  assert.deepEqual(value.actualEntries.map(entry => [entry.id, entry.itemId, entry.name, entry.quantity, entry.unit]), [['actual-zero', 'actual-zero', "Pasta", 0, 'g'], ['actual-unknown', 'actual-unknown', "Vegetables", null, 'g']]);
  assert.equal(value.actualEntries[0].nutrition.kcal, 120);
  assert.equal(value.actualEntries[0].nutrition.source, 'estimate');
  assert.equal(value.actualEntries[0].sourceTextAvailable, true);
  assert.equal(result.completeForPatch, true);
  assert.ok(JSON.stringify(result).length <= 24000);
  assert.doesNotMatch(JSON.stringify(result), /(?:Complete actual source text |Complete source text excluded from a compact read)/);
  assert.deepEqual(original, before);
});

test('oversized target actual facts reject explicitly instead of dropping entries or returning a partial target meal', () => {
  const target = meal({ state: 'completed', actualEntries: Array.from({ length: 200 }, (_, index) => actual('actual-' + index, '\u0000'.repeat(200), 1)) });
  const original = state(target), before = structuredClone(original);
  assert.throws(() => readFoodPlanEditContext(original, { planId: 'day', mealIds: ['dinner'] }), error => error.status === 413 && error.code === 'EDIT_CONTEXT_TOO_LARGE');
  assert.deepEqual(original, before);
});

test('current actual nutrition is visible while correction history stays folded with its full evidence and old snapshot', () => {
  const entry = actual('actual-bagel', "Bagel", 100);
  entry.nutritionSnapshot = { ...entry.nutritionSnapshot, nutrition: { ...nutrition, kcal: 250, protein: 20, carbs: 40, fat: 0, sourceText: "Complete current nutrition estimate provenance" } };
  entry.nutritionCorrectionHistory = [{ at: '2026-10-20T22:00:00Z', sourceText: "Add nutrition only; do not change food amounts.".repeat(250), previous: { ...entry.nutritionSnapshot, nutrition: { ...nutrition, kcal: null, protein: null, carbs: null, fat: null, source: 'unknown', sourceText: '' } } }];
  const original = meal({ state: 'completed', actualEntries: [entry] }), before = structuredClone(original), html = render(original);
  assert.match(html, /<details><summary>Nutrition corrections and sources \(1\)<\/summary>/);
  assert.match(html, /Current nutrition source/);
  assert.match(html, /250 kcal/);
  assert.match(html, /Fat: 0 g/);
  assert.match(html, /(?: · Before correction|Before correction · )/);
  assert.match(html, /Calories: Not provided/);
  assert.ok(html.includes(entry.nutritionCorrectionHistory[0].sourceText));
  assert.match(html, /Complete current nutrition estimate provenance/);
  assert.match(html, /meal-nutrition-summary/);
  assert.match(html, /meal-metric-value/);
  assert.doesNotMatch(html.split('<details class="health-source">')[0], /Nutrition corrections and sources \(/);
  assert.deepEqual(original, before);
  const light = readFoodPlanEditContext(state(original), { planId: 'day', mealIds: ['dinner'] });
  assert.equal(light.meals[0].actualEntries[0].nutritionCorrectionCount, 1);
  assert.match(light.instructions, /record_meal_intake/);
  assert.match(light.instructions, /nutritionCorrections with evidence/);
  assert.match(light.instructions, /Plans cannot overwrite actuals/);
  assert.match(light.instructions, /Completed meals use actual snapshots/);
  assert.doesNotMatch(JSON.stringify(light), /Add nutrition only; do not change food amounts\./);
});
