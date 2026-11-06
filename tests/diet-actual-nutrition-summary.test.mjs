import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { applyMutation, validateItem } from '../lib/inventory.mjs';
import { resolveDietDays } from '../lib/diet-day-summary.mjs';
import { readFoodPlanEditContext } from '../lib/diet-edit-read.mjs';

const NOW = '2026-10-20T20:00:00Z';
const unknown = { kcal: null, protein: null, carbs: null, fat: null };
const basis = (values, unit = 'g', source = 'label') => ({ basisAmount: 100, basisUnit: unit, ...values, source, sourceNote: '', sourceText: source === 'unknown' ? '' : "Explicit label or estimate provenance" });
function item(id, category, unit, nutrition) {
  return validateItem({ id, name: id, category, unit, quantity: 1000, nutrition }, NOW);
}
function mutate(state, action, payload) {
  return applyMutation(state, { action, ...payload, expectedRevision: state.revision, operationId: action + '-' + state.revision }, NOW);
}
function fixture() {
  let state = { schemaVersion: 1, revision: 0, updatedAt: NOW, events: [], preferences: [], operationIds: [], plans: [], items: [
    item('bagel', 'bread', 'g', basis(unknown, 'g', 'unknown')),
    item('breakfast', 'prepared', 'g', basis({ kcal: 200, protein: 10, carbs: 30, fat: 4 })),
    item('pasta', 'staple', 'g', basis(unknown, 'g', 'unknown')),
    item('fish-oil', 'supplement', '粒', { ...basis({ kcal: 10, protein: null, carbs: null, fat: null }, '粒'), basisAmount: 1 }),
  ] };
  state = mutate(state, 'save_meal_plan_draft', { plan: { id: 'day', date: '2026-10-20', title: "Final daily menu", meals: [
    { id: 'breakfast', slot: 'breakfast', title: "Breakfast", plannedItems: [{ id: 'breakfast-food', itemId: 'breakfast', quantity: 150, unit: 'g' }] },
    { id: 'dinner', slot: 'dinner', title: "Dinner", plannedItems: [{ id: 'bagel-plan', itemId: 'bagel', quantity: 100, unit: 'g' }, { id: 'pasta-plan', itemId: 'pasta', quantity: 110, unit: 'g' }] },
  ], supplementDoses: [{ id: 'oil', itemId: 'fish-oil', plannedQuantity: 1, unit: '粒' }] } });
  state = mutate(state, 'commit_meal_plan', { planId: 'day', confirmed: true });
  return mutate(state, 'record_meal_intake', { planId: 'day', mealId: 'dinner', mode: 'complete', actualTime: '19:20', sourceText: "Actually ate the bagel, not the pasta", entries: [
    { id: 'actual-bagel', itemId: 'bagel', quantity: 100, unit: 'g', sourceText: "Actual bagel: 100 g" },
    { id: 'actual-pasta', itemId: 'pasta', quantity: 0, unit: 'g', sourceText: "Explicitly did not eat pasta" },
  ] });
}
const daily = state => resolveDietDays(state.plans, [])[0];
const keyed = day => Object.fromEntries(day.totals.map(total => [total.key, total]));
const calendarSource = day => { const energy = keyed(day).kcal; return { date: day.date, kcal: energy.value, partial: energy.partial, estimated: energy.estimated, draft: false }; };

let compiled = ts.transpileModule(await readFile(new URL('../app/diet-calendar.tsx', import.meta.url), 'utf8'), { fileName: 'diet-calendar.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import\s+["']\.\/diet-calendar\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(specifier.startsWith('@/lib/') ? new URL('../lib/' + specifier.slice('@/lib/'.length), import.meta.url).href : import.meta.resolve(specifier)));
const { default: DietCalendar } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('corrected completed actual snapshot naturally clears food partial in daily totals and the calendar without filling zero intake', () => {
  const before = fixture(), previousDay = daily(before);
  assert.equal(previousDay.partial, true);
  assert.equal(keyed(previousDay).kcal.missing, 1, 'zero pasta is already known zero even with unknown nutrients');
  const after = mutate(before, 'record_meal_intake', { planId: 'day', mealId: 'dinner', nutritionCorrections: [{
    entryId: 'actual-bagel', nutrition: basis({ kcal: 250, protein: 20, carbs: 40, fat: 5 }, 'g', 'estimate'),
    sourceText: "Add sourced nutrition per 100 g for the eaten bagel, preserving quantity and facts",
  }] });
  const current = daily(after), values = keyed(current), calendarDay = calendarSource(current);
  assert.equal(current.partial, false);
  assert.equal(values.kcal.value, 560);
  assert.equal(values.kcal.partial, false);
  assert.equal(values.protein.value, 35);
  assert.equal(values.carbs.value, 85);
  assert.equal(values.fat.value, 11);
  for (const key of ['protein', 'carbs', 'fat']) {
    assert.equal(values[key].partial, false);
    assert.equal(values[key].missing, 0);
    assert.equal(values[key].supplementPartial, true);
    assert.equal(values[key].supplementMissing, 1);
  }
  assert.equal(current.supplementPartial, true);
  assert.deepEqual(calendarDay, { date: '2026-10-20', kcal: 560, partial: false, estimated: true, draft: false });
  const html = renderToStaticMarkup(React.createElement(DietCalendar, { days: [calendarDay], month: '2026-10', selectedDate: '2026-10-20', onMonthChange() {}, onSelectDate() {} }));
  const selected = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('aria-pressed="true"'));
  assert.ok(selected);
  assert.match(selected, /560/);
  assert.doesNotMatch(selected, /Incomplete/);
  const zeroBefore = before.plans[0].meals[1].actualEntries[1], zeroAfter = after.plans[0].meals[1].actualEntries[1];
  assert.deepEqual(zeroAfter, zeroBefore);
  assert.equal(zeroAfter.quantity, 0);
  assert.equal(zeroAfter.nutritionSnapshot.nutrition.kcal, null);
  assert.equal(zeroAfter.nutritionCorrectionHistory, undefined);
  assert.deepEqual(after.items, before.items, 'snapshot correction never alters inventory');
  assert.deepEqual(after.plans[0].meals[0], before.plans[0].meals[0], 'unreported breakfast remains its saved final plan');
  const projected = readFoodPlanEditContext(after, { planId: 'day', mealIds: ['dinner'] });
  assert.deepEqual(projected.meals[0].actualEntries.map(entry => entry.nutritionCorrectionCount), [1, 0]);
});
