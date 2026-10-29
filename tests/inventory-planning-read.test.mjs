import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlanningInventory } from '../lib/inventory-planning-read.mjs';
import { planningSnapshot, seedState, validateItem } from '../lib/inventory.mjs';

const NOW = '2026-10-19T14:00:00.000Z';
const AT = '2026-10-17T16:00:00.000Z';
// DEMO: all inventory, preferences, routines and source text below are synthetic.
const known = { basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 25, carbs: 5, fat: 9, source: 'label', sourceNote: '包装标签', sourceText: '原始标签：每100g热量200kcal。' };
const encodedLength = (value) => JSON.stringify(value).length;

function item(id, overrides = {}) {
  return validateItem({ id, name: `食材${id}`, brand: 'DEMO 品牌', category: 'prepared', quantity: 3, unit: '袋', gramsPerUnit: 125, nutrition: known, priority: false, location: '冷冻', notes: 'DEMO：虚构食材备注', ...overrides }, AT);
}

function state(items = [item('beef')], extra = {}) {
  return { schemaVersion: 1, revision: 7, updatedAt: AT, events: [], operationIds: [], preferences: ['DEMO：按现有库存安排示例菜单。', 'DEMO：按标签口径比较营养信息。'], items, plans: [], ...extra };
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

function assertStatus(fn, status, code) {
  assert.throws(fn, (error) => error.status === status && (!code || error.code === code));
}

function longPlan(index, overrides = {}) {
  return {
    id: `plan-${String(index).padStart(4, '0')}`, date: '2099-10-19', title: `完整菜单${index}${'\u0000'.repeat(110)}`,
    status: 'reserved', inventoryAccounting: 'pending_reconciliation', supplementOnly: index % 2 === 0,
    supplementAccounting: 'actual_only', createdAt: AT, updatedAt: AT,
    items: [], notes: 'FULL_PLAN_SECRET'.repeat(100),
    meals: [{ sourceText: 'MEAL_ORIGINAL_SECRET'.repeat(500), actualEntries: [{ sourceText: 'ACTUAL_SECRET' }], reportHistory: [{ sourceText: 'REPORT_SECRET' }] }],
    draft: { notes: 'DRAFT_SECRET' },
    ...overrides,
  };
}

test('one canonical item row retains bag weight, quantity and exact source distinctions', () => {
  const source = item('beef', { nutrition: { ...known, carbs: null, nutrientSources: { kcal: 'label', protein: 'label', fat: 'estimate' }, source: 'estimate' } });
  const result = readPlanningInventory(state([source]), {}, NOW);
  assert.equal(result.responseFormat, 'compact_inventory_v2');
  assert.equal(result.revision, 7);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.indexes, { available: ['beef'], depleted: [], pending: [], archived: [] });
  assert.equal(result.indexScope, 'page');
  assert.equal(result.items[0].quantity, 3);
  assert.equal(result.items[0].unit, '袋');
  assert.equal(result.items[0].gramsPerUnit, 125);
  assert.equal(result.items[0].nutrition.basisUnit, 'g');
  assert.equal(result.items[0].nutrition.basisAmount, 100);
  assert.deepEqual(result.items[0].nutrition.nutrientSources, { kcal: 'label', protein: 'label', carbs: 'unknown', fat: 'estimate' });
  assert.equal(result.items[0].nutrition.carbs, null);
  assert.equal(result.items[0].confirmedAt, AT);
  assert.equal(result.items[0].updatedAt, AT);
  assert.equal(result.items[0].brand, 'DEMO 品牌');
  assert.equal(result.items[0].location, '冷冻');
  assert.ok(!('perBasis' in result.items[0]));
  assert.ok(!('remainingNutrition' in result.items[0]));
  assert.ok(!('nutritionReadiness' in result.items[0]));
  assert.ok(!('detail' in result.items[0]));
  assert.ok(!('truncatedFields' in result.items[0]));
  assert.ok(!('sourceText' in result.items[0].nutrition));
  for (const legacy of ['availableItems', 'depletedItems', 'pendingItems', 'archivedItems']) assert.ok(!(legacy in result));
  assert.equal(result.items[0].textTruncated, true);
  assert.match(result.instructions, /完整nutrition.sourceText未包含/);
  assert.match(result.instructions, /itemId=该食材id/);
});

test('unknown amounts and macros remain null, while depleted and pending foods stay unavailable', () => {
  const source = state([
    item('ice-cream', { category: 'dessert', unit: 'g', quantity: null, gramsPerUnit: null, nutrition: { basisAmount: 100, basisUnit: 'g', source: 'unknown' } }),
    item('pending', { quantity: null, status: 'pending' }),
    item('zero', { quantity: 0 }),
    item('archived', { status: 'archived' }),
    item('magnesium', { category: 'supplement', quantity: null, unit: '粒', gramsPerUnit: null, nutrition: { basisAmount: 1, basisUnit: '粒' }, supplementFacts: '片数未知；成分待核，不能补猜mg。' }),
  ]);
  const result = readPlanningInventory(source, {}, NOW);
  const ice = result.items.find((entry) => entry.id === 'ice-cream');
  assert.equal(ice.quantity, null);
  for (const key of ['kcal', 'protein', 'carbs', 'fat']) assert.equal(ice.nutrition[key], null);
  assert.deepEqual(result.indexes.available, ['ice-cream', 'magnesium']);
  assert.deepEqual(result.indexes.depleted, ['zero']);
  assert.deepEqual(result.indexes.pending, ['pending']);
  assert.deepEqual(result.indexes.archived, ['archived']);
  assert.equal(result.nutritionReadiness.unknownQuantityCount, 2);
  assert.equal(result.nutritionReadiness.missingCount, 1);
  assert.equal(result.nutritionReadiness.supplementCount, 1);
});

test('ml never silently converts to g even when gramsPerUnit is present', () => {
  const result = readPlanningInventory(state([item('sauce', { category: 'condiment', unit: 'ml', quantity: 500, gramsPerUnit: 1 })]), {}, NOW);
  assert.equal(result.items[0].unit, 'ml');
  assert.equal(result.items[0].nutrition.basisUnit, 'g');
  assert.equal(result.nutritionReadiness.unconvertibleCount, 1);
});

test('stable ordering puts available foods first and priority before ordinary available items', () => {
  const source = state([
    item('z', { priority: true, status: 'pending' }), item('d'), item('c', { priority: true }), item('b', { priority: true }), item('a', { quantity: 0 }),
  ]);
  const first = readPlanningInventory(source, { limit: 2 }, NOW);
  assert.deepEqual(first.items.map((entry) => entry.id), ['b', 'c']);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, '2');
  const next = readPlanningInventory(source, { cursor: first.nextCursor, expectedRevision: first.revision, limit: 2 }, NOW);
  assert.deepEqual(next.items.map((entry) => entry.id), ['d', 'z']);
  assert.deepEqual(next.indexes, { available: ['d'], depleted: [], pending: ['z'], archived: [] });
  assert.deepEqual(readPlanningInventory(source, { cursor: next.nextCursor, expectedRevision: next.revision, limit: 2 }, NOW).items.map((entry) => entry.id), ['a']);
});

test('text summaries use explicit excerpts while all original content remains available by item detail', () => {
  const source = state([item('long', {
    notes: '备餐生净重与熟重\n'.repeat(150), ingredients: '香料用量、原配料\n'.repeat(800), supplementFacts: '维生素D3活性量待核\n'.repeat(800),
    nutrition: { ...known, sourceNote: '口径说明\n'.repeat(100) },
  })]);
  const row = readPlanningInventory(source, {}, NOW).items[0];
  assert.equal(row.notes.length, 200);
  assert.equal(row.ingredients.length, 80);
  assert.equal(row.supplementFacts.length, 400);
  assert.equal(row.nutrition.sourceNote.length, 120);
  assert.equal(row.textTruncated, true);
  const detail = readPlanningInventory(source, { itemId: 'long', offset: 0 }, NOW);
  assert.equal(detail.format, 'inventory_item_json');
  assert.ok(detail.text.startsWith('{"id":"long"'));
  assert.ok(detail.truncated);
  assert.ok(encodedLength(detail) <= 12000);
});

test('1000 plans only produce a bounded index without complete meal, draft or actual records', () => {
  const source = state(undefined, { plans: Array.from({ length: 1000 }, (_, index) => longPlan(index)) });
  const result = readPlanningInventory(source, {}, NOW);
  assert.equal(result.planSummary.total, 1000);
  assert.equal(result.planSummary.reserved, 1000);
  assert.equal(result.planSummary.included, result.plans.length);
  assert.equal(result.planSummary.omitted, 1000 - result.plans.length);
  assert.equal(result.planSummary.truncated, true);
  assert.ok(result.plans.length <= 24);
  assert.ok(encodedLength(result.plans) <= 6000);
  assert.equal(result.planSummary.detailTool, 'read_diet_records');
  assert.equal(result.plans[0].accounting, 'pending_reconciliation');
  assert.equal(result.plans[0].hasDraft, true);
  assert.equal(result.plans[0].legacyReservation, true);
  assert.equal(typeof result.plans[0].supplementOnly, 'boolean');
  const encoded = JSON.stringify(result);
  for (const secret of ['FULL_PLAN_SECRET', 'MEAL_ORIGINAL_SECRET', 'ACTUAL_SECRET', 'REPORT_SECRET', 'DRAFT_SECRET']) assert.ok(!encoded.includes(secret));
});

test('plan index prioritizes the requested Toronto date then nearest future reservations', () => {
  const source = state(undefined, { plans: [
    longPlan(1, { date: '2026-10-18' }), longPlan(2, { date: '2026-10-19' }),
    longPlan(3, { date: '2026-10-21' }), longPlan(4, { date: '2026-10-20' }),
  ] });
  for (const now of [NOW, '2026-10-19']) {
    const result = readPlanningInventory(source, {}, now);
    assert.deepEqual(result.plans.map((entry) => entry.date), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-18']);
  }
});

test('normal preferences, rules and a routine remain available without copying actual supplement facts', () => {
  const source = state([item('calcium', { category: 'supplement', unit: '片', gramsPerUnit: null, quantity: null })], {
    supplementRoutine: { sourcePlanId: null, updatedAt: AT, supplementDoses: [
      { id: 'calcium-bedtime', itemId: 'calcium', plannedQuantity: null, unit: '片', timingSlot: 'bedtime', requirement: 'optional', scheduled: false, instruction: '按当天选择；片数待标签核对。', sourceText: '用户保存的安排' },
    ] },
  });
  const result = readPlanningInventory(source, {}, NOW);
  assert.deepEqual(result.preferences, source.preferences);
  assert.ok(result.rules.some((rule) => rule.includes('null') && rule.includes('未知')));
  assert.ok(result.rules.some((rule) => rule.includes('indexes.depleted')));
  assert.equal(result.contextTruncated, false);
  assert.equal(result.supplementScheduleReference.doses[0].plannedQuantity, null);
  assert.equal(result.supplementScheduleReference.doses[0].scheduled, false);
  assert.equal(result.supplementScheduleReference.doses[0].requirement, 'optional');
  assert.equal(result.supplementScheduleReference.total, 1);
  assert.ok(!('actualEntries' in result.supplementScheduleReference.doses[0]));
});

test('full first-page habits and routine instructions are never sliced, while continuation pages reference them instead of repeating or emptying them', () => {
  const source = state(Array.from({ length: 3 }, (_, index) => item(`food-${index}`)), {
    preferences: Array.from({ length: 60 }, (_, index) => `习惯${index}：${'完整习惯原文'.repeat(60)}最后一句不可遗漏`),
    supplementRoutine: { sourcePlanId: null, updatedAt: AT, supplementDoses: [{
      id: 'bedtime', itemId: 'food-0', plannedQuantity: null, unit: '粒', timingSlot: 'bedtime',
      requirement: 'optional', scheduled: false, trainingDayOnly: true,
      plannedTimeText: '睡前时段原话'.repeat(40), instruction: '完整安排不能缩短'.repeat(80), sourceText: '原始补给依据'.repeat(120),
      actualEntries: [{ sourceText: 'NEVER_COPY_SAVED_ACTUAL' }], actualTime: '21:30',
    }] },
  });
  const first = readPlanningInventory(source, { limit: 1 }, NOW);
  assert.equal(first.contextIncluded, true);
  assert.equal(first.contextRevision, 7);
  assert.equal(first.requiresFirstPage, false);
  assert.deepEqual(first.preferences, source.preferences);
  assert.equal(first.preferencesComplete, true);
  assert.equal(first.preferencesCount, 60);
  assert.equal(first.preferencesRevision, first.revision);
  assert.equal(first.preferencesLastChangedAt, null);
  assert.equal(first.preferencesLastChangedRevision, null);
  assert.match(first.preferenceWorkflow, /patch_food_preferences/);
  assert.deepEqual(first.contextSummary, { preferencesTotal: 60, preferencesIncluded: 60, preferencesOmitted: 0, preferencesTextTruncated: false });
  assert.equal(first.contextTruncated, false);
  const dose = first.supplementScheduleReference.doses[0], original = source.supplementRoutine.supplementDoses[0];
  for (const field of ['plannedQuantity', 'unit', 'timingSlot', 'requirement', 'scheduled', 'trainingDayOnly', 'plannedTimeText', 'instruction', 'sourceText']) assert.equal(dose[field], original[field]);
  assert.equal(first.supplementScheduleReference.omitted, 0);
  assert.equal(first.supplementScheduleReference.truncated, false);
  assert.ok(!JSON.stringify(first).includes('NEVER_COPY_SAVED_ACTUAL'));
  const next = readPlanningInventory(source, { cursor: first.nextCursor, limit: 1, expectedRevision: first.revision }, NOW);
  assert.equal(next.contextIncluded, false);
  assert.equal(next.contextRevision, first.revision);
  assert.equal(next.requiresFirstPage, true);
  for (const key of ['preferences', 'preferencesComplete', 'preferencesCount', 'preferencesRevision', 'preferencesLastChangedAt', 'preferencesLastChangedRevision', 'preferenceWorkflow', 'rules', 'supplementScheduleReference', 'plans', 'planSummary', 'contextSummary', 'contextTruncated']) assert.ok(!(key in next), `${key} must be absent, not an empty list or misleading null`);
  assert.deepEqual(next.coverage, { from: 1, toExclusive: 2, allItemsIncluded: false, statusTotals: { available: 3, depleted: 0, pending: 0, archived: 0 }, revisionPinned: true });
  assert.match(next.instructions, /不代表没有这些内容/);
  assert.match(next.instructions, /revision=contextRevision/);
  assert.ok(encodedLength(next) < encodedLength(first) / 4);
});

test('derived routine fallback keeps every arrangement field and stable dose ID without source-day actual or report history', () => {
  const doses = [
    { id: 'beta-breakfast', itemId: 'beta', unit: 'g', plannedQuantity: 2, plannedMealId: 'breakfast', requirement: 'daily', scheduled: true, instruction: '早餐分次', actualEntries: [{ quantity: 2, sourceText: 'DERIVED_ACTUAL_SECRET' }], actualTime: '08:00', reportHistory: [{ sourceText: 'DERIVED_REPORT_SECRET' }] },
    { id: 'beta-dinner', itemId: 'beta', unit: 'g', plannedQuantity: null, plannedMealId: 'dinner', requirement: 'label_pending', scheduled: false, trainingDayOnly: true, instruction: '当天自行决定', sourceText: '用户原安排' },
  ];
  const source = state([item('beta', { category: 'supplement', unit: 'g' })], { plans: [{ id: 'source-plan', format: 'meals_v1', date: '2026-10-17', title: '来源', status: 'reserved', items: [], meals: [{ id: 'breakfast', slot: 'breakfast' }, { id: 'dinner', slot: 'dinner' }], supplementDoses: doses, updatedAt: AT }] });
  const result = readPlanningInventory(source, {}, NOW);
  const reference = result.supplementScheduleReference;
  assert.equal(reference.routineSource, 'derived');
  assert.equal(reference.sourcePlanId, 'source-plan');
  assert.equal(reference.total, 2);
  assert.equal(reference.included, 2);
  assert.deepEqual(reference.doses.map(dose => [dose.id, dose.timingSlot, dose.plannedMealId, dose.plannedQuantity, dose.scheduled]), [['beta-breakfast', 'breakfast', null, 2, true], ['beta-dinner', 'dinner', null, null, false]]);
  assert.equal(reference.doses[1].trainingDayOnly, true);
  assert.equal(reference.doses[1].sourceText, '用户原安排');
  const text = JSON.stringify(result);
  assert.ok(!text.includes('DERIVED_ACTUAL_SECRET'));
  assert.ok(!text.includes('DERIVED_REPORT_SECRET'));
  assert.ok(!('actualTime' in reference.doses[0]));
  assert.ok(!('actualEntries' in reference.doses[0]));
});

test('readiness and complete per-nutrient provenance equal the rich reader without materialising its repeated objects', () => {
  const source = state([
    item('unknown', { quantity: null, nutrition: { basisAmount: 100, basisUnit: 'g' } }),
    item('partial', { nutrition: { ...known, fat: null } }), item('complete'),
    item('ml', { unit: 'ml', gramsPerUnit: 10 }),
    item('zero', { quantity: 0 }), item('pending', { status: 'pending' }),
    item('supp', { category: 'supplement', quantity: null, unit: '粒', nutrition: { basisAmount: 1, basisUnit: '粒' } }),
  ]);
  const result = readPlanningInventory(source, {}, NOW), rich = planningSnapshot(source, NOW);
  assert.deepEqual(result.nutritionReadiness, rich.nutritionReadiness);
  for (const entry of result.items) assert.deepEqual(entry.nutrition.nutrientSources, rich.items.find(item => item.id === entry.id).nutrition.nutrientSources);
});

test('list, continuation and item detail avoid reading discarded rich item, full plan or historical payloads', () => {
  const beef = item('beef');
  Object.defineProperty(beef, 'unusedRichItem', { enumerable: true, get() { throw new Error('rich item was materialised'); } });
  const plan = { id: 'plan', date: '2026-10-19', title: '只读索引', status: 'reserved', updatedAt: AT };
  Object.defineProperty(plan, 'items', { enumerable: true, get() { throw new Error('full plan was materialised'); } });
  const historical = {};
  Object.defineProperty(historical, 'date', { enumerable: true, get() { throw new Error('diet history was scanned'); } });
  const source = state([beef, item('other')], { plans: [plan], dietHistory: [historical] });
  const first = readPlanningInventory(source, { limit: 1 }, NOW);
  assert.equal(first.items[0].id, 'beef');
  assert.equal(first.plans[0].id, 'plan');
  const next = readPlanningInventory(source, { cursor: first.nextCursor, expectedRevision: first.revision }, NOW);
  assert.equal(next.items[0].id, 'other');
  assert.equal(JSON.parse(readPlanningInventory(source, { itemId: 'other', expectedRevision: 7 }, NOW).text).id, 'other');
});

test('all77 foods across status groups and pages preserve every numeric amount, unit, conversion, status and source at one revision', () => {
  const source = state(Array.from({ length: 77 }, (_, index) => item(`real-size-${String(index).padStart(2, '0')}`, {
    status: ['available', 'depleted', 'pending', 'archived'][index % 4], quantity: index % 4 === 1 ? 0 : index % 5 === 0 ? null : index / 2,
    unit: index % 3 === 0 ? '罐' : '袋', gramsPerUnit: index % 3 === 0 ? 88 : 125,
    nutrition: { ...known, fat: index % 2 ? null : 9, nutrientSources: { kcal: 'label', protein: 'recipe', carbs: 'estimate' } },
  })));
  const seen = [], pages = [];
  let cursor;
  do {
    const result = readPlanningInventory(source, { limit: 11, ...(cursor ? { cursor, expectedRevision: 7 } : {}) }, NOW);
    pages.push(result);
    assert.equal(result.contextIncluded, pages.length === 1);
    assert.equal(result.contextRevision, 7);
    assert.equal(result.total, 77);
    assert.equal(Object.values(result.coverage.statusTotals).reduce((sum, value) => sum + value, 0), 77);
    assert.equal(result.coverage.from, seen.length);
    assert.equal(result.coverage.toExclusive, seen.length + result.items.length);
    for (const row of result.items) {
      const original = source.items.find(item => item.id === row.id);
      for (const field of ['id', 'name', 'brand', 'category', 'quantity', 'unit', 'status', 'priority', 'location', 'gramsPerUnit', 'confirmedAt', 'updatedAt']) assert.equal(row[field], original[field]);
      for (const key of ['basisAmount', 'basisUnit', 'kcal', 'protein', 'carbs', 'fat', 'source']) assert.equal(row.nutrition[key], original.nutrition[key]);
      assert.deepEqual(row.nutrition.nutrientSources, Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map(key => [key, original.nutrition[key] === null ? 'unknown' : original.nutrition.nutrientSources?.[key] ?? original.nutrition.source])));
    }
    seen.push(...result.items.map(item => item.id));
    cursor = result.nextCursor;
  } while (cursor !== null);
  assert.equal(pages.length, 7);
  assert.equal(seen.length, 77);
  assert.equal(new Set(seen).size, 77);
  assert.deepEqual(new Set(seen), new Set(source.items.map(item => item.id)));
});

test('400 long items paginate under the final 96000-character JSON budget without losing an item', () => {
  const source = state(Array.from({ length: 400 }, (_, index) => item(`food-${String(index).padStart(3, '0')}`, {
    priority: index % 7 === 0, notes: 'N\u0000\\\n'.repeat(400), ingredients: '\u0000\\\n'.repeat(3000), supplementFacts: '\u0000\\\n'.repeat(3000),
    nutrition: { ...known, sourceNote: 'S\u0000\\'.repeat(200), sourceText: '\u0000\\\n'.repeat(5000) },
  })), { plans: Array.from({ length: 1000 }, (_, index) => longPlan(index)) });
  const recovered = [];
  let cursor;
  let pages = 0;
  do {
    const result = readPlanningInventory(source, { ...(cursor === undefined ? {} : { cursor }), limit: 100, expectedRevision: 7 }, NOW);
    assert.ok(encodedLength(result) <= 96000, `page ${pages} has ${encodedLength(result)} characters`);
    assert.equal(result.charBudget, 96000);
    assert.equal(result.total, 400);
    assert.equal(result.included, result.items.length);
    assert.ok(result.included > 0);
    assert.ok(result.included <= 100);
    assert.equal(result.nextCursor !== null, result.hasMore);
    assert.equal(Object.values(result.indexes).flat().length, result.items.length);
    for (const id of Object.values(result.indexes).flat()) assert.ok(result.items.some((entry) => entry.id === id));
    recovered.push(...result.items.map((entry) => entry.id));
    cursor = result.nextCursor;
    pages++;
    assert.ok(pages <= 400, 'paging makes progress');
  } while (cursor !== null);
  assert.ok(pages > 1);
  assert.equal(recovered.length, 400);
  assert.equal(new Set(recovered).size, 400);
  assert.deepEqual(new Set(recovered), new Set(source.items.map((entry) => entry.id)));
});

test('incremental encoded budgeting exactly accounts for escaped IDs, per-status index commas and pagination boundary values', () => {
  const source = state(Array.from({ length: 160 }, (_, index) => item(`escaped-${String(index).padStart(3, '0')}-"\\${'\u0000'.repeat(20)}`, {
    status: ['available', 'depleted', 'pending', 'archived'][index % 4], quantity: index % 4 === 1 ? 0 : 2,
    notes: '\u0000"\\'.repeat(400), ingredients: '\u0000"\\'.repeat(1000), supplementFacts: '\u0000"\\'.repeat(2000),
    nutrition: { ...known, sourceNote: '\u0000"\\'.repeat(200) },
  })));
  let cursor, previous;
  const recovered = [];
  do {
    const current = readPlanningInventory(source, { ...(cursor ? { cursor } : {}), expectedRevision: 7 }, NOW);
    assert.ok(encodedLength(current) <= current.charBudget);
    if (previous && previous.included < previous.limit) {
      const nextRow = current.items[0], included = previous.included + 1, next = previous.offset + included;
      const indexes = structuredClone(previous.indexes);
      indexes[nextRow.status === 'available' && nextRow.quantity === 0 ? 'depleted' : nextRow.status].push(nextRow.id);
      const oneTooMany = { ...previous, items: [...previous.items, nextRow], indexes, included,
        hasMore: next < previous.total, nextCursor: next < previous.total ? String(next) : null,
        coverage: { ...previous.coverage, toExclusive: next, allItemsIncluded: previous.offset === 0 && next === previous.total } };
      assert.ok(encodedLength(oneTooMany) > previous.charBudget, 'packing stops at the exact encoded budget, not an estimated row limit');
    }
    recovered.push(...current.items.map(row => row.id));
    previous = current;
    cursor = current.nextCursor;
  } while (cursor !== null);
  assert.equal(recovered.length, 160);
  assert.equal(new Set(recovered).size, 160);
});

test('cached empty-schema calls return all 77 current-size items despite long original labels and recipes', () => {
  const items = Array.from({ length: 77 }, (_, index) => {
    const supplement = index < 13;
    return item(`cached-${String(index).padStart(3, '0')}-stable-inventory-item`, {
      name: supplement ? `已购补给${index}` : `已备餐食材${index}`,
      brand: index === 0 ? '完整已确认产品品牌'.repeat(10) : '用户已确认品牌',
      category: supplement ? 'supplement' : 'prepared',
      unit: supplement ? '粒' : '袋', gramsPerUnit: supplement ? null : 125,
      quantity: index % 7 === 0 ? null : 3,
      notes: '原始配方、生熟重量与实际用户备注。'.repeat(90),
      ingredients: '配料与整锅使用口径原文。'.repeat(800),
      supplementFacts: supplement ? '活性成分待标签核实，不把包装总粒数当剩余。'.repeat(300) : '',
      nutrition: { ...known, sourceNote: '营养口径及来源原话。'.repeat(90), sourceText: 'LABEL_OR_RECIPE_ORIGINAL\n'.repeat(600) },
    });
  });
  // Empty metadata is omitted without dropping numeric or unknown/null fields.
  items[59] = item(items[59].id, { brand: '', location: '', notes: '', ingredients: '', supplementFacts: '', nutrition: { ...known, sourceNote: '' } });
  const source = state(items, {
    plans: Array.from({ length: 24 }, (_, index) => longPlan(index)),
    supplementRoutine: { sourcePlanId: null, updatedAt: AT, supplementDoses: items.slice(0, 13).map((entry, index) => ({ id: `routine-${index}`, itemId: entry.id, plannedQuantity: null, unit: '粒', requirement: 'optional', scheduled: false, timingSlot: 'other', instruction: '用户当天决定是否安排；已知实际粒数仍未知。' })) },
  });
  const result = readPlanningInventory(source, {}, NOW);
  assert.equal(result.limit, 100);
  assert.equal(result.total, 77);
  assert.equal(result.included, 77);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.ok(encodedLength(result) <= 96000);
  assert.equal(new Set(result.items.map((entry) => entry.id)).size, 77);
  assert.equal(result.coverage.allItemsIncluded, true);
  assert.equal(result.items.find((entry) => entry.id === items[0].id).brand, items[0].brand);
  for (const row of result.items) {
    assert.ok((row.notes?.length ?? 0) <= 200);
    assert.ok((row.ingredients?.length ?? 0) <= 80);
    assert.ok((row.supplementFacts?.length ?? 0) <= 400);
    assert.ok((row.nutrition.sourceNote?.length ?? 0) <= 120);
    assert.ok(!('sourceText' in row.nutrition));
    for (const key of ['kcal', 'protein', 'carbs', 'fat']) assert.equal(row.nutrition[key], items.find((entry) => entry.id === row.id).nutrition[key]);
  }
  const empty = result.items.find((entry) => entry.id === items[59].id);
  for (const key of ['brand', 'location', 'notes', 'ingredients', 'supplementFacts']) assert.ok(!(key in empty));
  assert.ok(!('sourceNote' in empty.nutrition));
});

test('oversized escaped habits and routine reject explicitly instead of shortening or discarding any habit or dose', () => {
  const source = state([item('control', { notes: '\u0000'.repeat(1900), ingredients: '\u0000'.repeat(12000), supplementFacts: '\u0000'.repeat(12000) })], {
    preferences: Array.from({ length: 60 }, (_, index) => `${index}:${'\u0000'.repeat(490)}`),
    plans: Array.from({ length: 1000 }, (_, index) => longPlan(index)),
    supplementRoutine: { sourcePlanId: null, updatedAt: AT, supplementDoses: Array.from({ length: 32 }, (_, index) => ({ id: `dose-${index}`, itemId: 'control', plannedQuantity: null, unit: '袋', timingSlot: 'other', sourceText: '\u0000'.repeat(300), instruction: '\u0000'.repeat(300), plannedTimeText: '\u0000'.repeat(160) })) },
  });
  const before = JSON.stringify(source);
  freeze(source);
  assertStatus(() => readPlanningInventory(source, {}, NOW), 413, 'PLANNING_CONTEXT_TOO_LARGE');
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.preferences.length, 60);
  assert.equal(source.supplementRoutine.supplementDoses.length, 32);
});

test('sixty maximum escaped preferences stay complete while every inventory page still makes progress', () => {
  const source = state(Array.from({ length: 120 }, (_, index) => item(`long-${index}`, {
    notes: '\u0000'.repeat(200), supplementFacts: '\u0000'.repeat(400),
  })), { preferences: Array.from({ length: 60 }, (_, index) => `${index}:"${'\u0000'.repeat(490)}`.padEnd(500, '字')) });
  const before = structuredClone(source), recovered = [];
  let cursor;
  do {
    const page = readPlanningInventory(source, { ...(cursor ? { cursor, expectedRevision: source.revision } : {}) }, NOW);
    assert.ok(page.items.length > 0);
    assert.ok(encodedLength(page) <= page.charBudget);
    if (cursor === undefined) {
      assert.deepEqual(page.preferences, source.preferences);
      assert.equal(page.preferencesComplete, true);
      assert.equal(page.preferencesCount, 60);
      assert.ok(page.preferencesJsonCharacters > 96000);
      assert.ok(page.charBudget > 96000);
    } else assert.equal(page.charBudget, 96000);
    recovered.push(...page.items.map(row => row.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(recovered.length, 120);
  assert.deepEqual(new Set(recovered), new Set(source.items.map(row => row.id)));
  assert.deepEqual(source, before);
});

test('detail fragments reconstruct the exact original JSON including all facts and escaped characters', () => {
  const original = item('full-label', {
    notes: '生净重2334g、焯后1853g；最终熟重未知。\n'.repeat(50),
    ingredients: '原料\u0000\\\n😀'.repeat(1000),
    supplementFacts: '每袋125g；剂量不可臆造\u0000\\😀'.repeat(500),
    nutrition: { ...known, sourceText: '完整营养来源\u0000\\\n😀'.repeat(1000) },
  });
  const source = state([original]);
  let offset = 0;
  let encoded = '';
  let pieces = 0;
  do {
    const result = readPlanningInventory(source, { itemId: original.id, offset, expectedRevision: 7 }, NOW);
    assert.ok(encodedLength(result) <= 12000);
    assert.equal(result.revision, 7);
    assert.equal(result.offset, offset);
    assert.equal(result.complete, result.nextOffset === null);
    encoded += result.text;
    pieces++;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.ok(pieces > 1);
  assert.equal(encoded, JSON.stringify(original));
  assert.deepEqual(JSON.parse(encoded), original);
});

test('detail of a short item is immediately parseable and preserves unknowns', () => {
  const original = item('small', { quantity: null, gramsPerUnit: null, nutrition: { basisAmount: 1, basisUnit: '袋' } });
  const result = readPlanningInventory(state([original]), { itemId: 'small' }, NOW);
  assert.equal(result.complete, true);
  assert.equal(result.nextOffset, null);
  assert.equal(result.truncated, false);
  assert.deepEqual(JSON.parse(result.text), original);
});

test('pagination and item fragments reject a changed revision before returning mixed state', () => {
  const source = state([item('a'), item('b')]);
  const first = readPlanningInventory(source, { limit: 1 }, NOW);
  const changed = { ...source, revision: 140 };
  assertStatus(() => readPlanningInventory(changed, { cursor: first.nextCursor, expectedRevision: first.revision }, NOW), 409, 'REVISION_CONFLICT');
  assertStatus(() => readPlanningInventory(changed, { itemId: 'a', offset: 0, expectedRevision: first.revision }, NOW), 409, 'REVISION_CONFLICT');
  assert.equal(readPlanningInventory(changed, { expectedRevision: 140 }, NOW).revision, 140);
});

test('every continuation requires the first read revision, including numeric and string cursors and terminal pages', () => {
  const source = state([item('a'), item('b')]);
  const first = readPlanningInventory(source, { limit: 1 }, NOW);
  assertStatus(() => readPlanningInventory(source, { cursor: first.nextCursor }, NOW), 409, 'REVISION_REQUIRED');
  assertStatus(() => readPlanningInventory(source, { cursor: 1 }, NOW), 409, 'REVISION_REQUIRED');
  assertStatus(() => readPlanningInventory(source, { cursor: 2 }, NOW), 409, 'REVISION_REQUIRED');
  const second = readPlanningInventory(source, { cursor: first.nextCursor, expectedRevision: first.revision }, NOW);
  assert.equal(second.coverage.revisionPinned, true);
  assert.equal(second.contextRevision, first.revision);
  assert.equal(second.items[0].id, 'b');
  assert.equal(readPlanningInventory(source, { cursor: '0' }, NOW).contextIncluded, true);
});

test('the lightweight canonical-policy projection still rejects invalid original state shapes and collection bounds', () => {
  const source = state();
  const invalid = [null, [], { ...source, schemaVersion: 2 }, { ...source, revision: -1 }, { ...source, events: null },
    { ...source, operationIds: null }, { ...source, items: null }, { ...source, items: Array(401).fill(source.items[0]) },
    { ...source, plans: Array(1001).fill({}) }, { ...source, dietHistory: Array(1001).fill({}) },
    { ...source, preferences: ['a'.repeat(501)] }, { ...source, preferences: Array(61).fill('习惯') }, { ...source, preferences: [42] }];
  for (const entry of invalid) assertStatus(() => readPlanningInventory(entry, {}, NOW), 400, 'INVALID_INPUT');
});

test('unknown keys, invalid cursors, limit, detail combinations and revisions are rejected', () => {
  const source = state();
  const invalid = [
    null, [], 'text', { surprise: true }, { [Symbol('unknown')]: true },
    { cursor: null }, { cursor: '' }, { cursor: '01' }, { cursor: '-1' }, { cursor: '1.2' }, { cursor: '1e1' }, { cursor: true }, { cursor: 1.2 }, { cursor: -1 }, { cursor: 2, expectedRevision: 7 }, { cursor: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: '1' }, { limit: null },
    { expectedRevision: -1 }, { expectedRevision: '7' }, { expectedRevision: 1.5 },
    { offset: 0 }, { itemId: '' }, { itemId: 'a'.repeat(101) }, { itemId: 7 }, { itemId: 'beef', cursor: 0 }, { itemId: 'beef', limit: 1 }, { itemId: 'beef', offset: -1 }, { itemId: 'beef', offset: null }, { itemId: 'beef', offset: 1.5 }, { itemId: 'beef', offset: 999999 },
  ];
  for (const filters of invalid) assertStatus(() => readPlanningInventory(source, filters, NOW), 400);
  assertStatus(() => readPlanningInventory(source, { itemId: 'missing' }, NOW), 404, 'ITEM_NOT_FOUND');
});

test('empty and terminal pages are explicit without fabricated rows or a non-progressing cursor', () => {
  const empty = readPlanningInventory(state([]), {}, NOW);
  assert.equal(empty.total, 0);
  assert.equal(empty.included, 0);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextCursor, null);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.indexes, { available: [], depleted: [], pending: [], archived: [] });
  const terminal = readPlanningInventory(state(), { cursor: '1', expectedRevision: 7 }, NOW);
  assert.equal(terminal.total, 1);
  assert.equal(terminal.items.length, 0);
  assert.equal(terminal.hasMore, false);
  assert.equal(terminal.nextCursor, null);
});

test('all reads are pure, return detached data, and preserve existing confirmation and audit records', () => {
  const source = state(undefined, { events: [{ id: 'e', at: AT, detail: '先前更正' }], operationIds: [{ id: 'op', at: AT }] });
  const before = JSON.stringify(source);
  freeze(source);
  const result = readPlanningInventory(source, {}, NOW);
  const detail = readPlanningInventory(source, { itemId: 'beef', expectedRevision: 7 }, NOW);
  result.items[0].nutrition.nutrientSources.kcal = 'unknown';
  result.items[0].notes = '只改返回值';
  result.preferences.push('只改返回值');
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.revision, 7);
  assert.equal(source.items[0].confirmedAt, AT);
  assert.equal(JSON.parse(detail.text).confirmedAt, AT);
  assert.ok(!('events' in result));
  assert.ok(!('operationIds' in result));
});

test('DEMO seed remains usable through the compact read without silently changing its quantities', () => {
  const source = seedState();
  const result = readPlanningInventory(source, {}, NOW);
  assert.equal(result.total, source.items.length);
  assert.equal(result.hasMore, false);
  assert.ok(encodedLength(result) <= 96000);
  const mushroom = result.items.find((entry) => entry.id === 'demo-mushrooms');
  assert.equal(mushroom.quantity, 300);
  assert.equal(mushroom.nutrition.kcal, null);
  assert.equal(result.items.find((entry) => entry.id === 'demo-stew').status, 'pending');
});
