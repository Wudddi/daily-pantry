import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryPlanningPriorities, inventoryPlanningRole, PLANNING_PRIORITY_RULES } from '../lib/inventory-planning-priority.mjs';
import { readPlanningInventory } from '../lib/inventory-planning-read.mjs';
import { validateItem } from '../lib/inventory.mjs';

const AT = '2026-10-20T12:00:00.000Z', TARGET = '2026-10-21';
const item = (id, extra = {}) => validateItem({ id, name: id, category: 'prepared', quantity: 5, unit: '袋', location: '冷冻',
  nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 200, protein: 30, carbs: 1, fat: 8, source: 'estimate' }, ...extra }, AT);
const menu = (date, ids, extra = {}) => ({ id: `menu-${date}`, format: 'meals_v1', date, status: 'reserved',
  meals: [{ id: 'lunch', state: 'reserved', plannedItems: ids.map((itemId, index) => ({ id: `line-${index}`, itemId, quantity: 1 })) }], ...extra });
const state = (items, plans = []) => ({ schemaVersion: 1, revision: 8, updatedAt: AT, items, plans, events: [], operationIds: [], preferences: ['合成示例：每份示例午餐使用一个示例主菜。'] });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) freeze(v); } return value; };

test('attention uses only explicit current facts and keeps supplements and condiments outside meal rotation', () => {
  const items = [item('ordinary'), item('priority', { priority: true }), item('tail', { name: '示例备餐145g尾袋' }),
    item('last', { quantity: 1 }), item('fresh', { category: 'vegetable', unit: 'g', quantity: 300, location: '冷藏' }),
    item('frozen', { category: 'vegetable', unit: 'g', quantity: 300, location: '冷冻' }),
    item('negative', { name: '非尾袋', notes: '旧尾袋已吃完，新批次尚未开封' }),
    item('fish-oil', { category: 'supplement', priority: true }), item('mustard', { category: 'condiment', priority: true }),
    item('empty-tail', { name: '已用完尾袋', quantity: 0 }), item('pending-tail', { name: '待称尾袋', status: 'pending' })];
  const priorities = inventoryPlanningPriorities({ items }, TARGET), sorted = items.slice().sort(priorities.compare);
  assert.equal(sorted[0].id, 'priority');
  assert.ok(sorted.findIndex(v => v.id === 'fresh') < sorted.findIndex(v => v.id === 'tail'));
  assert.ok(sorted.findIndex(v => v.id === 'fresh') < sorted.findIndex(v => v.id === 'last'));
  assert.ok(sorted.findIndex(v => v.id === 'ordinary') < sorted.findIndex(v => v.id === 'fish-oil'));
  assert.deepEqual(priorities.metadata(items.find(v => v.id === 'tail')).planningHints, ['named_tail_bag']);
  assert.equal(priorities.metadata(items.find(v => v.id === 'tail')).freshnessHint.group, 'frozen_flexible');
  assert.deepEqual(priorities.metadata(items.find(v => v.id === 'fresh')).planningHints, ['refrigerated_vegetable']);
  assert.equal(priorities.metadata(items.find(v => v.id === 'fresh')).freshnessHint.group, 'fresh_first');
  for (const id of ['fish-oil', 'mustard', 'empty-tail', 'pending-tail']) assert.deepEqual(priorities.metadata(items.find(v => v.id === id)), {});
  for (const id of ['negative', 'frozen']) assert.equal(priorities.metadata(items.find(v => v.id === id)).freshnessHint.group, 'frozen_flexible');
  assert.deepEqual(priorities.coverage.availableRoleTotals, { food: 7, condiment: 1, supplement: 1 });
  assert.equal(inventoryPlanningRole(items.find(v => v.id === 'fish-oil')), 'supplement');
  assert.match(PLANNING_PRIORITY_RULES.join(''), /不是强制菜单或平均分配配额/);
});

test('rotation counts distinct confirmed-menu days and remains weaker than explicit priorities without claiming actual intake', () => {
  const items = [item('frequent'), item('not-recent'), item('chosen', { priority: true })];
  const plans = [menu('2026-10-20', ['frequent', 'chosen', 'frequent']), menu('2026-10-20', ['frequent'], { id: 'same-day-second-menu' }),
    menu('2026-10-19', ['frequent']), menu('2026-10-18', ['not-recent'], { status: 'draft' }),
    menu('2026-10-17', ['not-recent'], { status: 'cancelled' }), menu(TARGET, ['not-recent']), menu('2026-10-22', ['not-recent']),
    menu('2026-10-06', ['not-recent']), menu('2026-10-16', ['not-recent'], { supplementOnly: true })];
  const priorities = inventoryPlanningPriorities({ items, plans }, TARGET);
  assert.deepEqual(items.slice().sort(priorities.compare).map(v => v.id), ['chosen', 'not-recent', 'frequent']);
  assert.equal(priorities.metadata(items[0]).recentAcceptedMenuDays, 2);
  assert.equal(priorities.metadata(items[0]).lastAcceptedMenuDate, '2026-10-20');
  assert.equal(priorities.metadata(items[1]).recentAcceptedMenuDays, 0);
  assert.deepEqual(priorities.recentMenuCoverage.observedConfirmedMenuDates, ['2026-10-19', '2026-10-20']);
  assert.equal(priorities.recentMenuCoverage.actualIntakeProven, false);
  assert.equal(priorities.recentMenuCoverage.completeEatingHistory, false);
});

test('no recorded menus means no invented non-use signal and timestamps never invent food age', () => {
  const old = item('same', { updatedAt: '2024-01-01', confirmedAt: '2024-01-01' });
  const current = { ...old, updatedAt: AT, confirmedAt: AT };
  const a = inventoryPlanningPriorities({ items: [old] }, TARGET), b = inventoryPlanningPriorities({ items: [current] }, TARGET);
  assert.deepEqual(a.metadata(old), { freshnessHint: { group: 'frozen_flexible', basis: ['confirmed_frozen_storage'] } });
  assert.deepEqual(a.metadata(old), b.metadata(current));
  assert.equal(a.recentMenuCoverage.observedDayCount, 0);
});

test('read stays bounded to recent accepted food IDs and never accesses full history, notes, labels or irrelevant meals', () => {
  const food = item('food');
  Object.defineProperty(food, 'notes', { enumerable: true, get() { throw new Error('notes read'); } });
  const legacy = { id: 'legacy', date: '2026-10-20', status: 'reserved' };
  Object.defineProperty(legacy, 'items', { get() { throw new Error('legacy rows read'); } });
  const future = menu('2026-10-22', []), old = menu('2024-01-01', []);
  Object.defineProperty(future, 'meals', { get() { throw new Error('future meals read'); } });
  Object.defineProperty(old, 'meals', { get() { throw new Error('old meals read'); } });
  const source = { items: [food], plans: [legacy, future, old, menu('2026-10-20', ['food', 'not-current-food'])] };
  Object.defineProperty(source, 'dietHistory', { get() { throw new Error('history read'); } });
  const priorities = inventoryPlanningPriorities(source, TARGET);
  assert.equal(priorities.metadata(food).recentAcceptedMenuDays, 1);
  assert.equal(priorities.recentMenuCoverage.observedDayCount, 1);
});

test('unknown optional dessert nutrients remain usable candidates without obstructing other foods or fabricating zeros', () => {
  const source = state([item('protein'), item('pastry', { category: 'dessert', unit: '个', quantity: 1,
    nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 420, protein: null, carbs: null, fat: null, source: 'estimate' } })]);
  const before = JSON.stringify(source), result = readPlanningInventory(freeze(source), {}, AT);
  const pastry = result.items.find(v => v.id === 'pastry');
  assert.equal(pastry.status, 'available');
  assert.equal(pastry.nutrition.kcal, 420);
  assert.equal(pastry.nutrition.carbs, null);
  assert.equal(result.candidateCoverage.availableFoodCategoryTotals.dessert, 1);
  assert.match(result.selectionRules.join(''), /营养待补不阻碍/);
  assert.equal(JSON.stringify(source), before);
});

test('full stock coverage survives all priority pages with category totals and no repeated first-page guide', () => {
  const source = state(Array.from({ length: 140 }, (_, i) => item(`food-${String(i).padStart(3, '0')}`, {
    category: ['prepared', 'protein', 'bread', 'vegetable', 'dessert', 'condiment', 'supplement'][i % 7],
    status: i % 19 === 0 ? 'pending' : i % 17 === 0 ? 'archived' : 'available', quantity: i % 23 === 0 ? 0 : 2,
    priority: i % 13 === 0, notes: '现有食材详情。'.repeat(20),
  })), [menu('2026-10-19', ['food-001', 'food-002'])]);
  const before = JSON.stringify(source); freeze(source);
  const all = []; let cursor, first;
  do {
    const page = readPlanningInventory(source, { limit: 13, ...(cursor ? { cursor, expectedRevision: 8 } : {}) }, AT);
    if (!first) first = page;
    else for (const key of ['candidateCoverage', 'recentMenuCoverage', 'selectionRules']) assert.ok(!(key in page));
    assert.ok(JSON.stringify(page).length <= page.charBudget);
    all.push(...page.items); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(all.length, 140);
  assert.deepEqual(new Set(all.map(v => v.id)), new Set(source.items.map(v => v.id)));
  for (const role of ['food', 'condiment', 'supplement']) assert.equal(first.candidateCoverage.availableRoleTotals[role],
    all.filter(v => v.status === 'available' && v.quantity !== 0 && inventoryPlanningRole(v) === role).length);
  assert.equal(Object.values(first.candidateCoverage.availableFoodCategoryTotals).reduce((a, b) => a + b, 0), first.candidateCoverage.availableRoleTotals.food);
  assert.equal(JSON.stringify(source), before);
});

test('list uses Toronto day at midnight UTC and refuses invalid priority reference dates', () => {
  const source = state([item('food')], [menu('2026-10-19', ['food']), menu('2026-10-20', ['food'])]);
  const result = readPlanningInventory(source, {}, '2026-10-21T00:30:00Z');
  assert.equal(result.recentMenuCoverage.toExclusive, '2026-10-20');
  assert.deepEqual(result.recentMenuCoverage.observedConfirmedMenuDates, ['2026-10-19']);
  for (const bad of ['bad', '2026-13-01', '2026-02-30', '', null]) assert.throws(() => inventoryPlanningPriorities(source, bad), /有效的/);
});

test('compact inventory preserves verified product aliases without changing IDs, nutrition or historical references', () => {
  const source = state([item('canonical-yogurt', { name: 'PC 0% Greek Yogurt 1kg', category: 'protein', unit: 'g', quantity: 1000, aliases: ['0%希腊酸奶'] }),
    item('old-yogurt', { name: '0%希腊酸奶', category: 'protein', unit: 'g', quantity: 0, status: 'archived' })],
  [menu('2026-10-19', ['old-yogurt'])]);
  const before = JSON.stringify(source); freeze(source);
  const result = readPlanningInventory(source, {}, AT);
  const canonical = result.items.find(item => item.id === 'canonical-yogurt');
  assert.deepEqual(canonical.aliases, ['0%希腊酸奶']);
  assert.equal(canonical.recentAcceptedMenuDays, 0, 'aliases do not rewrite history or transfer other item IDs');
  assert.ok(result.items.some(item => item.id === 'old-yogurt' && item.status === 'archived'));
  canonical.aliases.push('响应副本');
  assert.equal(JSON.stringify(source), before);
});

test('confirmed fresh and opened non-frozen foods precede frozen tail bags while explicit choices remain strongest', () => {
  const items = [item('frozen-tail', { name: '冻牛肉尾袋', quantity: 1 }),
    item('fresh-mushroom', { category: 'vegetable', unit: 'g', quantity: 400, location: '冷藏' }),
    item('opened-oats', { category: 'staple', unit: 'g', quantity: 500, location: '常温', freshness: { opened: true, sourceText: '用户确认这袋已经开封。' } }),
    item('due-soon', { userChoice: 'not-read', location: '冷冻', freshness: { userConsumeByDate: '2026-10-23', sourceText: '用户说希望23号用完这一包。' } }),
    item('manual', { priority: true }),
    item('later-target', { freshness: { userConsumeByDate: '2026-10-24', sourceText: '用户说希望24号用完。' } })];
  const before = JSON.stringify(items), p = inventoryPlanningPriorities({ items }, TARGET), ids = items.slice().sort(p.compare).map(v => v.id);
  assert.equal(ids[0], 'manual');
  assert.ok(ids.indexOf('due-soon') < ids.indexOf('fresh-mushroom'));
  assert.ok(ids.indexOf('fresh-mushroom') < ids.indexOf('frozen-tail'));
  assert.ok(ids.indexOf('opened-oats') < ids.indexOf('frozen-tail'));
  assert.equal(p.metadata(items[0]).freshnessHint.group, 'frozen_flexible');
  assert.equal(p.metadata(items[3]).freshnessHint.group, 'use_soon');
  assert.ok(p.metadata(items[3]).freshnessHint.basis.includes('user_consume_by_near'));
  assert.equal(p.metadata(items[5]).freshnessHint.group, 'frozen_flexible', 'a target farther than two days does not become urgent');
  assert.equal(JSON.stringify(items), before);
});

test('unknown storage stays unknown and product names prevent frozen or dried produce becoming assumed fresh', () => {
  const items = [item('fresh-unknown', { category: 'vegetable', location: '', unit: 'g' }),
    item('frozen-name', { name: 'Frozen Blueberries 冷冻蓝莓', category: 'fruit', location: '', unit: 'g' }),
    item('dried-name', { name: 'Dried Raisins 葡萄干', category: 'fruit', location: '', unit: 'g' }),
    item('thawed-location', { name: 'Frozen Broccoli', category: 'vegetable', location: '冷藏', unit: 'g' }),
    item('mismatch-location', { name: 'Frozen Broccoli', category: 'vegetable', location: '常温', unit: 'g' })];
  const p = inventoryPlanningPriorities({ items }, TARGET), hint = id => p.metadata(items.find(v => v.id === id)).freshnessHint;
  assert.deepEqual(hint('fresh-unknown'), { group: 'storage_unknown', basis: ['storage_unreported', 'fresh_produce_kind'] });
  assert.deepEqual(hint('frozen-name'), { group: 'frozen_flexible', basis: ['named_frozen_product'] });
  assert.equal(hint('dried-name').group, 'storage_unknown');
  assert.equal(hint('dried-name').basis.includes('fresh_produce_kind'), false);
  assert.equal(hint('thawed-location').group, 'fresh_first', 'explicit current fridge location wins over product type');
  assert.ok(hint('thawed-location').basis.includes('confirmed_refrigerated_storage'));
  assert.equal(hint('mismatch-location').group, 'storage_unknown');
  assert.equal(hint('mismatch-location').basis.includes('fresh_produce_kind'), false);
});

test('best-before and opening facts never invent a safety deadline or make old frozen foods urgent', () => {
  const frozen = item('frozen', { quantity: 1, name: '奶酪尾袋', freshness: { opened: true, openedOn: '2026-01-01', bestBeforeDate: '2026-01-02', sourceText: '标签Best Before1月2号；用户1号打开后冷冻。' } });
  const same = { ...frozen, freshness: { ...frozen.freshness, openedOn: '2026-10-20', bestBeforeDate: '2026-10-22' } };
  const a = inventoryPlanningPriorities({ items: [frozen] }, TARGET), b = inventoryPlanningPriorities({ items: [same] }, TARGET);
  assert.deepEqual(a.metadata(frozen), b.metadata(same), 'age and past quality dates add no frozen urgency');
  assert.equal(a.metadata(frozen).freshnessHint.group, 'frozen_flexible');
  assert.ok(a.metadata(frozen).freshnessHint.basis.includes('best_before_quality_date_recorded'));
  const dry = item('dry', { category: 'staple', location: '常温', freshness: { bestBeforeDate: '2026-10-20', sourceText: '实物Best Before10月20号，未提供安全到期日期。' } });
  const hint = inventoryPlanningPriorities({ items: [dry] }, TARGET).metadata(dry).freshnessHint;
  assert.equal(hint.group, 'shelf_stable');
  assert.ok(hint.basis.includes('best_before_quality_date_passed'));
  assert.equal(Object.hasOwn(hint, 'safeUntil'), false);
  assert.equal(dry.status, 'available', 'quality hints never rewrite stock safety/status');
  assert.match(PLANNING_PRIORITY_RULES.join(''), /均不是食物安全保证/);
});

test('freshness coverage uses the exact available food classification and excludes supplement, condiments and unavailable stock', () => {
  const items = [item('due', { freshness: { userConsumeByDate: TARGET, sourceText: '用户想今天用完。' } }),
    item('fresh', { category: 'protein', location: '冷藏' }), item('frozen'),
    item('dry', { category: 'staple', location: '常温' }), item('unknown', { location: '' }),
    item('supplement', { category: 'supplement', location: '常温' }), item('condiment', { category: 'condiment' }),
    item('pending', { status: 'pending' }), item('empty', { quantity: 0 })];
  const p = inventoryPlanningPriorities({ items }, TARGET);
  assert.deepEqual(p.coverage.freshnessGroupTotals, { use_soon: 1, fresh_first: 1, frozen_flexible: 1, shelf_stable: 1, storage_unknown: 1 });
  assert.equal(Object.values(p.coverage.freshnessGroupTotals).reduce((a, b) => a + b, 0), p.coverage.availableRoleTotals.food);
  for (const value of Object.values(p.coverage.freshnessGroupTotals)) assert.equal(typeof value, 'number');
  for (const id of ['supplement', 'condiment', 'pending', 'empty']) assert.equal(p.metadata(items.find(v => v.id === id)).freshnessHint, undefined);
});

test('malformed raw freshness fails visibly while ordinary legacy raw items need no migration or evidence guessing', () => {
  const ordinary = item('legacy');
  assert.equal(inventoryPlanningPriorities({ items: [ordinary] }, TARGET).metadata(ordinary).freshnessHint.group, 'frozen_flexible');
  for (const freshness of [null, {}, { sourceText: '' }, { opened: 'yes', sourceText: '用户原话' }, { bestBeforeDate: '2026-02-30', sourceText: '标签原话' }, { safeUntil: TARGET, sourceText: '无支持的额外字段' }]) {
    assert.throws(() => inventoryPlanningPriorities({ items: [{ ...ordinary, freshness }] }, TARGET), error => error.status === 503 && error.code === 'INVALID_FRESHNESS_FACTS');
  }
});
