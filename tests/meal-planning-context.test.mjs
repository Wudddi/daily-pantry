import test from 'node:test';
import assert from 'node:assert/strict';
import { mealPlanningDietContext, mealPlanningHealthContext } from '../lib/meal-planning-context.mjs';
import { healthContext } from '../lib/health.mjs';
import { dietContext } from '../lib/diet.mjs';

const date = '2026-10-21', at = date + 'T10:00:00Z';
const weight = (day, kg) => ({ id: 'weight-' + day, date: day, weightKg: kg, archived: false, waistCm: null, bodyFatPct: null, condition: '', notes: '', sourceText: 'WEIGHT_SOURCE', source: 'manual', createdAt: at, updatedAt: at });
const session = (patch = {}) => ({ id: 'session', date, title: '胸和三头', status: 'completed', archived: false, durationMinutes: 55,
  notes: 'SESSION_NOTES_SECRET'.repeat(200), sourceText: 'SESSION_SOURCE_SECRET'.repeat(300),
  exercises: [{ name: '卧推', equipment: '杠铃', notes: 'EXERCISE_NOTES_SECRET', sets: [{ setId: 'one', weight: 55, unit: 'kg', reps: 8, rpe: 8.5, rir: 2, notes: 'SET_FEELING_SECRET', sourceText: 'SET_SOURCE_SECRET' }] }],
  source: 'manual', createdAt: at, updatedAt: at, ...patch });
function health(extra = {}) { return { schemaVersion: 1, revision: 8, updatedAt: at, measurements: [weight('2026-10-14', 74), weight('2026-10-20', 73), weight(date, 72.8)], sessions: [session()], events: [], operationIds: [], ...extra }; }
const nutrition = { basisAmount: 100, basisUnit: 'g', kcal: 120, protein: 10, carbs: null, fat: 3, source: 'estimate', sourceText: 'LABEL_SECRET'.repeat(500) };
function plan(patch = {}) { return { id: 'today', date, format: 'meals_v1', title: '当天菜单', status: 'reserved', intakeBasis: 'confirmed_daily_plan', inventoryAccounting: 'settled',
  notes: 'PLAN_NOTES_SECRET'.repeat(500), createdAt: at, updatedAt: at,
  meals: [{ id: 'lunch', slot: 'lunch', title: '午餐', state: 'reserved', sourceText: 'MEAL_SOURCE_SECRET', reportHistory: [], actualEntries: [], plannedItems: [{ id: 'food', itemId: null, name: '食物', quantity: 100, unit: 'g', nutritionSnapshot: { name: '食物', unit: 'g', gramsPerUnit: null, nutrition } }] }],
  supplementDoses: [], ...patch }; }
const inventory = (plans = [plan()], extra = {}) => ({ schemaVersion: 1, revision: 21, items: [], preferences: ['习惯完整'], events: [], plans, ...extra });

test('meal health brief keeps numeric trends, latest real date and reported workload without training transcripts', () => {
  const original = health({ sessions: [session(), session({ id: 'future-plan', date: '2026-10-22', status: 'planned' }), session({ id: 'archived', archived: true })] }), before = structuredClone(original);
  const result = mealPlanningHealthContext(original), row = result.recentCompletedSessions[0];
  assert.equal(result.summary.latest.weightKg, 72.8); assert.equal(result.summary.latest.date, date);
  assert.equal(result.summary.latest7Days.coverageDays, 2); assert.equal(result.summary.latest7Days.averageKg, 72.9);
  assert.equal(result.summary.plannedSessionCount, 1); assert.equal(result.summary.completedSessionCount, 1);
  assert.equal(row.setCount, 1); assert.equal(row.knownRpeMax, 8.5); assert.equal(row.knownRirMin, 2); assert.equal(row.notesAvailable, true);
  assert.equal(row.exercises[0].name, '卧推'); assert.equal(row.detailRecordId, 'session');
  assert.doesNotMatch(JSON.stringify(result), /SESSION_NOTES_SECRET|SESSION_SOURCE_SECRET|SET_SOURCE_SECRET|SET_FEELING_SECRET|EXERCISE_NOTES_SECRET|WEIGHT_SOURCE|"weight":55/);
  assert.deepEqual(original, before);
  assert.ok(JSON.stringify(result).length < JSON.stringify(healthContext(original)).length);
});

test('missing body weights and optional effort scores remain unknown rather than zero', () => {
  const result = mealPlanningHealthContext(health({ measurements: [], sessions: [session({ exercises: [{ name: '动作', sets: [{ weight: 10, reps: 8, notes: '' }] }] })] }));
  assert.equal(result.summary.latest, null); assert.equal(result.summary.latest7Days.averageKg, null);
  assert.equal(result.recentCompletedSessions[0].knownRpeMax, null); assert.equal(result.recentCompletedSessions[0].knownRirMin, null);
  assert.throws(() => mealPlanningHealthContext({ revision: 2, measurements: [] }));
});

test('large training names respect the encoded budget with explicit omission counts and stable record pointers', () => {
  const original = health({ sessions: [session({ exercises: Array.from({ length: 100 }, (_, i) => ({ name: i + '\u0000'.repeat(150), sets: [] })) })] });
  const result = mealPlanningHealthContext(original), row = result.recentCompletedSessions[0];
  assert.ok(JSON.stringify(result).length <= result.charBudget); assert.equal(result.truncated, true);
  assert.equal(row.exerciseCount, 100); assert.equal(row.exercises.length + row.omittedExerciseCount, 100); assert.equal(row.detailRecordId, 'session');
});

test('meal context routes by same-day IDs and preserves nutrition coverage without full food, notes or history text', () => {
  const original = inventory([plan(), plan({ id: 'tomorrow', date: '2026-10-22' })]), before = structuredClone(original);
  const result = mealPlanningDietContext(original, date);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].id, 'today');
  assert.equal(result.records[0].meals[0].id, 'lunch'); assert.equal(result.records[0].detailRequiredForEdit, true);
  const carbs = result.dailyNutritionSummaries[0].totals.find(total => total.key === 'carbs');
  assert.equal(carbs.value, null); assert.equal(carbs.partial, true);
  assert.equal(result.summaryOnly, true); assert.doesNotMatch(JSON.stringify(result), /PLAN_NOTES_SECRET|LABEL_SECRET|MEAL_SOURCE_SECRET|"plannedItems"|tomorrow/);
  assert.deepEqual(original, before); assert.ok(JSON.stringify(result).length < JSON.stringify(dietContext(original, date)).length);
});

test('supplement-only days are identified without turning them into a complete zero-calorie menu', () => {
  const result = mealPlanningDietContext(inventory([plan({ supplementOnly: true, meals: [] })]), date);
  assert.equal(result.records[0].supplementOnly, true); assert.deepEqual(result.dailyNutritionSummaries, []);
});

test('history-only nutrition carries its non-inventory identity and cannot become a native plan', () => {
  const result = mealPlanningDietContext(inventory([], { dietHistory: [{ id: 'history-only', date, title: '旧聊天菜单', confirmation: 'final_plan', meals: [], supplements: [], nutrition: { kcal: 1800, protein: 140, carbs: 200, fat: 50, source: 'estimate' }, createdAt: at, updatedAt: at }] }), date);
  assert.deepEqual(result.records, []);
  assert.equal(result.dailyNutritionSummaries[0].recordType, 'diet_history');
  assert.equal(result.dailyNutritionSummaries[0].planId, null);
  assert.equal(result.dailyNutritionSummaries[0].inventoryEffect, 'none');
});

test('a large ambiguous day keeps all native IDs or fails explicitly, never silently chooses one', () => {
  const records = Array.from({ length: 120 }, (_, index) => plan({ id: 'duplicate-' + index }));
  assert.throws(() => mealPlanningDietContext(inventory(records), date), /身份过多/);
});
