import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const compiledModules = new Map();
async function componentUrl(relative) {
  if (compiledModules.has(relative)) return compiledModules.get(relative);
  let compiled = ts.transpileModule(await readFile(new URL('../app/' + relative, import.meta.url), 'utf8'), {
    fileName: relative, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  compiled = compiled.replace(/import\s+["'][^"']+\.css["'];?/g, '');
  // Historical detail editing is separate from the current-menu state under test.
  compiled = compiled.replace(/import DietHistory from ['"]\.\/diet-history['"];?/, 'const DietHistory = () => null;');
  const matches = [...compiled.matchAll(/from\s+(["'])([^"']+)\1/g)];
  for (const match of matches) {
    const specifier = match[2];
    const url = specifier.startsWith('./') ? await componentUrl(specifier.slice(2) + '.tsx')
      : specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier);
    compiled = compiled.replace(match[0], 'from ' + JSON.stringify(url));
  }
  const url = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
  compiledModules.set(relative, url); return url;
}
const { default: DietRecords, DailyMealProgress, ActualSupplementReceipts } = await import(await componentUrl('diet-records.tsx'));
const { default: SupplementChecklist } = await import(await componentUrl('supplement-checklist.tsx'));
const { MealOverviewCard } = await import(await componentUrl('meal-overview.tsx'));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 100, protein: 10, carbs: 12, fat: 2, source: 'estimate', sourceText: '已保存估算', sourceNote: '' };
function food(id, name = id, quantity = 100, unit = 'g') { return { id, itemId: id, name, quantity, unit, sourceText: '', nutritionSnapshot: { name, unit, gramsPerUnit: null, nutrition, ingredients: '', supplementFacts: '' } }; }
function meal(id, patch = {}) { return { id, slot: id, title: { breakfast: '早餐香蕉燕麦', lunch: '午餐扁豆汤', snack: '下午加餐吐司', dinner: '晚餐Blackbird面包' }[id], plannedItems: [food(id + '-food')], plannedTime: null, plannedTimeText: '', state: 'reserved', actualEntries: [], actualTime: null, actualTimeText: '', completionReportedAt: null, reportHistory: [], sourceText: '', ...patch }; }
function dose(patch = {}) { return { id: 'creatine-am', itemId: 'creatine', plannedQuantity: 5, unit: 'g', state: 'reserved', timingSlot: 'breakfast', requirement: 'daily', scheduled: true, instruction: '', trainingDayOnly: false, plannedMealId: null, plannedTime: null, plannedTimeText: '早餐后', actualEntries: [], actualTime: null, actualTimeText: '', reportHistory: [], reportSourceText: '', nutritionSnapshot: { name: '肌酸', unit: 'g', gramsPerUnit: null, nutrition }, ...patch }; }
function plan(patch = {}) { return { id: 'daily-food-' + today(), format: 'meals_v1', date: today(), title: '完整四餐菜单', timeZone: 'America/Toronto', status: 'draft', notes: '', meals: ['breakfast', 'lunch', 'snack', 'dinner'].map(id => meal(id)), supplementDoses: [dose()], items: [], accountedDebits: [], allocationAdjustments: {}, accountingIssues: [], inventoryAccounting: 'settled', intakeBasis: 'none', createdAt: '2026-10-21T21:00:00Z', updatedAt: '2026-10-22T12:48:00Z', ...patch }; }
function renderDay(p) { return renderToStaticMarkup(React.createElement(DietRecords, { state: { revision: 294, items: [], plans: [p], dietHistory: [] }, loading: false, saving: false, error: '', refresh: async () => {}, mutate: async () => { throw new Error('render must never write'); }, dispatchCheck: async () => { throw new Error('render must never check'); } })); }
const actual = (id, name, quantity, unit = 'g') => ({ ...food(id, name, quantity, unit), quantitySource: 'reported', reportedAt: '2026-10-22T12:48:00Z', correctionHistory: [] });

test('a saved four-meal draft is visible immediately without an adoption or confirmation gate', () => {
  const html = renderDay(plan());
  for (const title of ['早餐香蕉燕麦', '午餐扁豆汤', '下午加餐吐司', '晚餐Blackbird面包']) assert.match(html, new RegExp(title));
  assert.equal([...html.matchAll(/aria-label="(?:早餐|午餐|加餐|晚餐)总览"/g)].length, 4);
  assert.match(html, /当前菜单 · 已保存/); assert.match(html, /当前菜单/);
  assert.doesNotMatch(html, /认可这份最终计划|确认最终版|尚未预留|已扣可用量/);
});

test('legacy supplement-only actual ledger and nested current menu render together and survive a fresh read', () => {
  const saved = plan(), p = plan({ status: 'reserved', supplementOnly: true, supplementAccounting: 'actual_only', meals: [], draft: { id: saved.id, date: saved.date, title: saved.title, meals: saved.meals, supplementDoses: saved.supplementDoses }, supplementDoses: [dose({ state: 'completed', actualEntries: [actual('creatine-actual', '肌酸', 5)], actualTime: '08:48' })] });
  const before = structuredClone(p), html = renderDay(p), refreshed = renderDay(JSON.parse(JSON.stringify(p)));
  assert.equal([...html.matchAll(/aria-label="(?:早餐|午餐|加餐|晚餐)总览"/g)].length, 4);
  assert.match(html, /实际补给记录/); assert.match(html, /肌酸/); assert.match(html, /08:48/); assert.match(html, /5 g/);
  assert.match(refreshed, /早餐香蕉燕麦/); assert.match(refreshed, /晚餐Blackbird面包/);
  assert.deepEqual(p, before);
});

test('current editable menu does not mask actual completion or partial reports', () => {
  const completed = meal('breakfast', { state: 'completed', actualEntries: [actual('banana', '实际香蕉', 103)] });
  const progress = renderToStaticMarkup(React.createElement(DailyMealProgress, { meals: [completed, meal('lunch', { state: 'in_progress' }), meal('snack'), meal('dinner')] }));
  assert.match(progress, /已完成 <strong>1<\/strong> 餐/); assert.match(progress, /未完成 <strong>3<\/strong> 餐/); assert.match(progress, /其中 1 餐已报告部分/);
  const card = renderToStaticMarkup(React.createElement(MealOverviewCard, { meal: completed, planStatus: 'draft', targetId: 'detail', triggerId: 'breakfast', onSelect() {} }));
  assert.match(card, /已完成 · 实际记录/); assert.match(card, /实际香蕉/);
  assert.doesNotMatch(card, />草稿<|计划 · 未完成/);
});

test('supplement checks are enabled on an editable menu without confirming food, while closed days remain read-only', () => {
  const props = { plan: plan(), items: [], revision: 1, busy: false, mutate: async () => true, dispatchCheck: async () => ({ ok: true, revision: 2 }) };
  const editable = renderToStaticMarkup(React.createElement(SupplementChecklist, props));
  assert.match(editable, /type="checkbox"/); assert.doesNotMatch(editable, /确认这一天|type="checkbox"[^>]*disabled/);
  const closed = renderToStaticMarkup(React.createElement(SupplementChecklist, { ...props, plan: plan({ status: 'closed_with_actuals' }) }));
  assert.match(closed, /type="checkbox"[^>]*disabled/);
});

test('actual supplement receipts preserve reported quantities and times instead of copying planned doses', () => {
  const p = plan({ supplementDoses: [dose({ plannedQuantity: 5, actualTime: '08:48', actualEntries: [actual('reported-dose', '肌酸', 3)] }), dose({ id: 'beta', itemId: 'beta', actualEntries: [actual('unknown-dose', 'β-丙氨酸', null)] })] });
  const html = renderToStaticMarkup(React.createElement(ActualSupplementReceipts, { plan: p }));
  assert.match(html, /3 g/); assert.doesNotMatch(html, /5 g/); assert.match(html, /08:48/); assert.match(html, /用量未报/); assert.match(html, /时间未报/);
});

test('compact food portions display frozen grams and drink millilitres without altering saved package accounting', () => {
  const packaged = food('milk-yogurt', '原味酸奶', .025, '袋'); packaged.nutritionSnapshot.gramsPerUnit = 1000;
  const input = meal('breakfast', { plannedItems: [packaged, food('drink', '牛奶', 150, 'ml')] }), before = structuredClone(input);
  const html = renderToStaticMarkup(React.createElement(MealOverviewCard, { meal: input, planStatus: 'draft', targetId: 'detail', triggerId: 'meal', onSelect() {} }));
  assert.match(html, /25 g/); assert.match(html, /150 mL/); assert.doesNotMatch(html, /0.025 袋|150 ml/);
  assert.deepEqual(input, before);
});
