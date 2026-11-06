import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { buildSupplementChecklist, parseSupplementTimetable, supplementCheckState, SUPPLEMENT_TIMING_SLOTS } from '../lib/supplement-checklist.mjs';

function actual(quantity, unit = '粒', patch = {}) {
  return { id: 'actual', itemId: 'supplement', name: "Supplements", quantity, unit, sourceText: '用户原话：已经服用，保留原报告', reportedAt: '2026-10-19T13:00:00Z', quantitySource: quantity === null ? 'unknown' : 'reported', correctionHistory: [], ...patch };
}
function dose(id, patch = {}) {
  return { id, itemId: 'supplement-' + id, plannedQuantity: 1, unit: '粒', timingSlot: 'breakfast', requirement: 'daily', scheduled: true, instruction: '', trainingDayOnly: false, plannedMealId: null, plannedTime: null, plannedTimeText: '', sourceText: '', state: 'reserved', nutritionSnapshot: { name: '品牌补给 ' + id, unit: '粒', supplementFacts: '每粒有效成分 100 µg\n按保存的标签核对', ingredients: '胶囊辅料原文', nutrition: {}, gramsPerUnit: null }, actualEntries: [], actualTime: null, actualTimeText: '', reportSourceText: '', reportHistory: [], completionReportedAt: null, ...patch };
}
function plan(doses, patch = {}) {
  return { id: 'day-oct19', date: '2026-10-19', status: 'reserved', meals: [{ id: 'lunch', slot: 'lunch' }], supplementDoses: doses, ...patch };
}

test('only scheduled daily doses count toward progress; optional, as-needed and label-pending are separate', () => {
  const value = buildSupplementChecklist(plan([
    dose('daily', { actualEntries: [actual(1)] }),
    dose('optional', { requirement: 'optional' }),
    dose('needed', { requirement: 'as_needed', scheduled: false }),
    dose('pending', { requirement: 'label_pending', plannedQuantity: 1 }),
    dose('off', { scheduled: false }),
    dose('cancelled', { state: 'cancelled' }),
  ]));
  assert.equal(value.requiredCount, 1);
  assert.equal(value.checkedRequiredCount, 1);
  assert.equal(value.optionalCount, 2);
  assert.equal(value.groups[0].rows.find(row => row.dose.id === 'pending').required, false);
  assert.equal(value.groups[0].rows.find(row => row.dose.id === 'pending').selected, true);
});

test('positive or explicitly unknown intake is checked; all-zero correction is unchecked without inventing a quantity', () => {
  assert.deepEqual(supplementCheckState(dose('unknown', { actualEntries: [actual(null)] })), { checked: true, unknownQuantity: true, hasReport: true });
  assert.equal(supplementCheckState(dose('partial', { actualEntries: [actual(0), actual(0.5)] })).checked, true);
  assert.deepEqual(supplementCheckState(dose('zero', { actualEntries: [actual(0)] })), { checked: false, unknownQuantity: false, hasReport: true });
  assert.equal(supplementCheckState(dose('empty')).checked, false);
});

test('unscheduled optional intake remains visible once reported, while an unselected option stays available', () => {
  const taken = dose('taken', { requirement: 'optional', scheduled: false, plannedQuantity: null, actualEntries: [actual(null)] });
  const waiting = dose('waiting', { requirement: 'as_needed', scheduled: false });
  const before = structuredClone([taken, waiting]);
  const value = buildSupplementChecklist(plan([taken, waiting]));
  assert.equal(value.groups[0].rows[0].selected, true);
  assert.equal(value.groups[0].rows[0].dose, taken);
  assert.equal(value.groups[0].rows[0].dose.plannedQuantity, null);
  assert.equal(value.groups[0].rows[1].selected, false);
  assert.equal(value.requiredCount, 0);
  assert.deepEqual([taken, waiting], before);
});

test('seven timing slots preserve all thirteen independent doses and legacy doses default to scheduled daily', () => {
  const doses = Array.from({ length: 13 }, (_, index) => dose('dose-' + index, { timingSlot: SUPPLEMENT_TIMING_SLOTS[index % 7].id }));
  const value = buildSupplementChecklist(plan(doses));
  assert.deepEqual(value.groups.map(group => group.id), SUPPLEMENT_TIMING_SLOTS.map(slot => slot.id));
  assert.equal(value.groups.flatMap(group => group.rows).length, 13);
  assert.equal(value.requiredCount, 13);
  const legacy = dose('legacy', { plannedMealId: 'lunch' }); delete legacy.requirement; delete legacy.scheduled; delete legacy.timingSlot;
  const legacyResult = buildSupplementChecklist(plan([legacy]));
  assert.equal(legacyResult.groups[0].id, 'lunch');
  assert.equal(legacyResult.requiredCount, 1);
  const candidate = dose('candidate', { requirement: 'optional' }); delete candidate.scheduled;
  assert.equal(buildSupplementChecklist(plan([candidate])).groups[0].rows[0].selected, false);
});

// Load the actual component without a browser or generated files. The helper
// remains its normal module; only TSX syntax and the stylesheet import change.
const source = await readFile(new URL('../app/supplement-checklist.tsx', import.meta.url), 'utf8');
let compiled = ts.transpileModule(source, { fileName: 'supplement-checklist.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import\s+["']\.\/supplement-checklist\.css["'];?/g, '');
compiled = compiled.replace(/(?<=^import[^;\n]*\s)from\s+(["'])([^"']+)\1/gm, (_match, _quote, specifier) => {
  const url = specifier.startsWith('@/lib/') ? new URL('../lib/' + specifier.slice('@/lib/'.length), import.meta.url).href : import.meta.resolve(specifier);
  return 'from ' + JSON.stringify(url);
});
const { default: SupplementChecklist } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const { TimetableImportDialog } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const render = value => renderToStaticMarkup(React.createElement(SupplementChecklist, { plan: value, revision: 7, busy: false, mutate: () => { throw new Error('SSR must never change a dose'); } }));

test('SSR shows unknown dose as unknown, keeps optional markers, saved label text and full actual wording', () => {
  const html = render(plan([dose('unknown', { plannedQuantity: null, requirement: 'optional', scheduled: false, actualEntries: [actual(null)] })]));
  assert.match(html, /Taken; amount unreported/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /Recorded today/);
  assert.match(html, /Optional/);
  assert.doesNotMatch(html, /daily doses recorded|0 \/ 0/);
  assert.match(html, /<details class="supp-row-details">/);
  assert.match(html, /用户原话：已经服用，保留原报告/);
  assert.match(html, /每粒有效成分 100 µg/);
  assert.doesNotMatch(html, /Taken as planned \(1 unit\)/);
});

test('SSR lets label-pending physical amounts remain readable and editable-menu checkboxes work without food confirmation', () => {
  const value = plan([dose('D3', { requirement: 'label_pending', plannedQuantity: 1, instruction: '物理数量已确认，IU标签尚待核对' })], { status: 'draft' });
  const html = render(value);
  assert.match(html, /Label pending review/);
  assert.match(html, /Taken as planned \(1 unit\)/);
  assert.match(html, /IU标签尚待核对/);
  const input = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
  assert.ok(input);
  assert.doesNotMatch(input, /disabled=""/);
  assert.doesNotMatch(html, /Confirm the schedule for this day to check doses/);
});

test('SSR keeps every optional choice visible in the compact list and collapses long details', () => {
  const html = render(plan([dose('one', { requirement: 'optional', scheduled: false }), dose('two', { requirement: 'as_needed', scheduled: false })]));
  assert.match(html, /品牌补给 one/);
  assert.match(html, /品牌补给 two/);
  assert.equal([...html.matchAll(/type="checkbox"/g)].length, 2);
  assert.equal([...html.matchAll(/<details class="supp-row-details">/g)].length, 2);
  assert.match(html, /<details class="supp-more">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  const controls = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].replace(/<[^>]*>/g, '')).join(' ');
  assert.doesNotMatch(controls, /Take all|One-click intake|Finish all/);
  assert.doesNotMatch(html, /supp-inline-undo|Undo accidental check|Confirm undo/);
});

test('SSR global saving does not disable individual checks and routine controls use the real source only', () => {
  const html = renderToStaticMarkup(React.createElement(SupplementChecklist, { plan: plan([dose('one')]), items: [], revision: 7, busy: true, routineSourcePlanId: 'real-source', mutate() { throw new Error('SSR must not save'); }, dispatchCheck() { throw new Error('SSR must not check'); } }));
  const input = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
  assert.ok(input);
  assert.doesNotMatch(input, /disabled/);
  assert.match(html, /Set as daily routine/);
  assert.match(html, /Updates future defaults only; reported doses are retained/);
});

test('SSR separates a saved intake from inventory pending reconciliation and folds its issues', () => {
  const html = render(plan([dose('one', { actualEntries: [actual(1)] })], { inventoryAccounting: 'pending_reconciliation', accountingIssues: [{ code: 'unknown_balance', message: '原库存余量未知' }] }));
  assert.match(html, /Intake saved; inventory needs review/);
  assert.match(html, /<details class="supp-accounting-details">/);
  assert.match(html, /原库存余量未知/);
  assert.doesNotMatch(html, /<details class="supp-accounting-details" open/);
});

function importFixture() {
  const value = plan([dose('one'), dose('untouched')]);
  const items = ['one', 'two', 'untouched'].map(id => ({ id: 'supplement-' + id, name: '补给名称 ' + id, brand: "Brand", category: 'supplement', unit: '粒' }));
  const input = { planId: value.id, date: value.date, supplementDoses: [
    { id: 'one', itemId: 'supplement-one', plannedQuantity: 1, unit: '粒', timingSlot: 'lunch', requirement: 'daily', scheduled: true, plannedMealId: 'lunch', plannedTime: '12:30', plannedTimeText: '午餐后', instruction: '按已保存的标签与当前安排', trainingDayOnly: false },
    { id: 'two', itemId: 'supplement-two', plannedQuantity: null, unit: '粒', timingSlot: 'bedtime', requirement: 'label_pending', scheduled: false, instruction: '物理用量尚未确认' },
  ] };
  return { value, items, input };
}

test('timetable import retains null amounts, previews only the dose merge and leaves original records untouched', () => {
  const { value, items, input } = importFixture(), before = structuredClone({ value, items, input });
  const preview = parseSupplementTimetable(JSON.stringify(input), value, items);
  assert.equal(preview.supplementDoses[1].plannedQuantity, null);
  assert.equal(preview.rows[0].name, '补给名称 one');
  assert.equal(preview.rows[0].timingLabel, "Lunch / After lunch");
  assert.deepEqual([preview.updatedCount, preview.newCount, preview.retainedCount], [1, 1, 1]);
  assert.equal(Object.hasOwn(preview.supplementDoses[0], 'actualEntries'), false);
  assert.equal(Object.hasOwn(preview.supplementDoses[0], 'meals'), false);
  assert.deepEqual({ value, items, input }, before);
});

test('timetable import preserves existing actual facts and blocks changing their physical amount or item', () => {
  const { value, items, input } = importFixture();
  value.supplementDoses[0].actualEntries = [actual(1)];
  const before = structuredClone(value);
  assert.equal(parseSupplementTimetable(JSON.stringify(input), value, items).updatedCount, 1);
  assert.deepEqual(value, before);
  input.supplementDoses[0].plannedQuantity = null;
  assert.throws(() => parseSupplementTimetable(JSON.stringify(input), value, items), /Actual intake already exists/);
  input.supplementDoses[0].plannedQuantity = 1;
  input.supplementDoses[0].itemId = 'supplement-two';
  assert.throws(() => parseSupplementTimetable(JSON.stringify(input), value, items), /another supplement/i);
});

test('timetable validation rejects wrong target, hidden actual/state writes, invalid quantities, units and metadata', () => {
  const { value, items, input } = importFixture();
  const check = mutate => { const invalid = structuredClone(input); mutate(invalid); assert.throws(() => parseSupplementTimetable(JSON.stringify(invalid), value, items)); };
  check(data => { data.date = '2026-10-20'; });
  check(data => { data.planId = 'different-plan'; });
  check(data => { data.meals = []; });
  check(data => { data.supplementDoses[0].actualEntries = []; });
  check(data => { data.supplementDoses[0].state = 'completed'; });
  check(data => { delete data.supplementDoses[0].plannedQuantity; });
  for (const quantity of [0, -1, 1e10, '1']) check(data => { data.supplementDoses[0].plannedQuantity = quantity; });
  check(data => { data.supplementDoses[0].unit = 'IU'; });
  check(data => { data.supplementDoses[0].itemId = 'missing'; });
  check(data => { data.supplementDoses[0].scheduled = 'true'; });
  check(data => { data.supplementDoses[0].timingSlot = 'midnight'; });
  check(data => { data.supplementDoses[0].plannedTime = '25:30'; });
  check(data => { data.supplementDoses[0].plannedMealId = 'missing-meal'; });
  check(data => { data.supplementDoses[0].instruction = '字'.repeat(1001); });
  check(data => { data.supplementDoses.push(structuredClone(data.supplementDoses[0])); });
  assert.throws(() => parseSupplementTimetable(JSON.stringify(input), { ...value, status: 'draft' }, items), /can only be imported/);
  assert.throws(() => parseSupplementTimetable(JSON.stringify(input), value, items.map(item => ({ ...item, category: 'staple' }))), /supplement inventory/);
});

test('timetable limits include imported row count, merged count and UTF-8 file bytes', () => {
  const { value, items, input } = importFixture();
  assert.throws(() => parseSupplementTimetable(' '.repeat(100001), value, items), /100 KB/);
  assert.throws(() => parseSupplementTimetable('字'.repeat(40000), value, items), /100 KB/);
  assert.throws(() => parseSupplementTimetable(JSON.stringify({ supplementDoses: Array.from({ length: 33 }, (_, i) => ({ ...input.supplementDoses[0], id: 'dose-' + i })) }), value, items), /32/);
  const many = { ...value, supplementDoses: Array.from({ length: 32 }, (_, i) => dose('old-' + i)) };
  assert.throws(() => parseSupplementTimetable(JSON.stringify(input), many, items), /merged schedule exceeds/i);
  assert.equal(parseSupplementTimetable('\uFEFF' + JSON.stringify(input), value, items).rows.length, 2);
});

test('SSR import preview reads names and timings, explains retained doses and disables confirmation when stale', () => {
  const { value, items, input } = importFixture(), preview = parseSupplementTimetable(JSON.stringify(input), value, items);
  const html = renderToStaticMarkup(React.createElement(TimetableImportDialog, { preview, stale: true, busy: false, error: '', close() {}, confirm() { throw new Error('SSR cannot import'); } }));
  assert.match(html, /补给名称 one/);
  assert.match(html, /午餐后/);
  assert.match(html, /Amount unreported/);
  assert.match(html, /retain 1 unlisted existing doses/);
  assert.match(html, /Meals stay unchanged and doses are not marked taken/);
  assert.match(html, /The menu or inventory version changed/);
  const confirmButton = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0]).find(button => button.replace(/<[^>]*>/g, '').includes("Merge schedule"));
  assert.ok(confirmButton);
  assert.match(confirmButton, /disabled=""/);
  assert.doesNotMatch(html, /supplement-one|plannedQuantity|actualEntries/);
});
