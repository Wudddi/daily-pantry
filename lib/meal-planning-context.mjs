import { weightStats } from './weight-stats.mjs';
import { resolveDietDays } from './diet-day-summary.mjs';
import { projectCurrentDietPlan } from './diet-current-plan.mjs';

const list = value => Array.isArray(value) ? value : [];
const size = value => JSON.stringify(value).length;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const HEALTH_BUDGET = 8_000;
const DIET_BUDGET = 8_000;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const observation = row => row ? { id: row.id, date: row.date, weightKg: row.weightKg } : null;

/** Meal planning needs trends and recent workload, not every training set's transcript. */
export function mealPlanningHealthContext(state) {
  if (!state || !Number.isSafeInteger(state.revision) || !Array.isArray(state.measurements) || !Array.isArray(state.sessions)) throw new Error("Health record format is incomplete.");
  const weights = weightStats(state.measurements);
  const completed = state.sessions.filter(session => !session.archived && session.status === 'completed');
  const recent = completed.toSorted((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.id.localeCompare(b.id)).slice(0, 3);
  const result = {
    available: true, revision: state.revision, format: 'meal_planning_health_brief_v1',
    summary: {
      weightCount: weights.dayCount, first: observation(weights.points[0]), latest: observation(weights.points.at(-1)),
      changeKg: weights.dayCount ? Math.round((weights.points.at(-1).weightKg - weights.points[0].weightKg) * 1e6) / 1e6 : null,
      latest7Days: { ...weights.weeks.current, count: weights.weeks.current.coverageDays }, previous7Days: { ...weights.weeks.previous, count: weights.weeks.previous.coverageDays },
      averageChangeKg: weights.weeks.averageChangeKg,
      latest30Days: weights.months.current, previous30Days: weights.months.previous,
      average30DayChangeKg: weights.months.averageChangeKg,
      completedSessionCount: completed.length,
      plannedSessionCount: state.sessions.filter(session => !session.archived && session.status === 'planned').length,
    },
    recentCompletedSessions: recent.map(session => {
      const exercises = list(session.exercises), sets = exercises.flatMap(exercise => list(exercise.sets));
      const rpe = sets.map(set => numeric(set.rpe)).filter(value => value !== null);
      const rir = sets.map(set => numeric(set.rir)).filter(value => value !== null);
      return {
        id: session.id, date: session.date, title: session.title, status: session.status,
        durationMinutes: numeric(session.durationMinutes), exerciseCount: exercises.length, setCount: sets.length,
        knownRpeMax: rpe.length ? Math.max(...rpe) : null, knownRirMin: rir.length ? Math.min(...rir) : null,
        notesAvailable: !!session.notes || !!session.sourceText || exercises.some(exercise => !!exercise.notes || list(exercise.sets).some(set => !!set.notes || !!set.sourceText)),
        exercises: exercises.map(exercise => ({ name: exercise.name, setCount: list(exercise.sets).length })),
        omittedExerciseCount: 0, detailRecordId: session.id,
      };
    }),
    omittedSessionCount: Math.max(0, completed.length - recent.length), truncated: false, charBudget: HEALTH_BUDGET,
    detailsTool: 'read_health_records',
    instructions: "This is a measured trend and recent training-volume overview for meal planning. Missing measurements are not filled in; RPE/RIR summaries use provided values only. Per-set load, repetitions, effort, and source text remain fully saved in health records. Read original detailRecordId records for training plans, pain, or recovery details; do not infer feelings or treat planned as completed from this summary. Ordinary meal planning need not reread all set details.",
  };
  while (size(result) > HEALTH_BUDGET) {
    const row = result.recentCompletedSessions.toReversed().find(session => session.exercises.length);
    if (!row) throw new Error("The meal-planning health context exceeds the read budget.");
    row.exercises.pop(); row.omittedExerciseCount++; result.truncated = true;
  }
  return result;
}

/** Dates and IDs are enough to route an existing menu to the targeted edit reader. */
export function mealPlanningDietContext(state, date) {
  if (!dayPattern.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw new Error("Invalid meal-planning date.");
  const plans = list(state.plans).filter(plan => plan.format === 'meals_v1' && plan.date === date)
    .map(plan => projectCurrentDietPlan(plan, list(state.items)));
  const history = list(state.dietHistory).filter(record => record.date === date);
  const selected = resolveDietDays(plans, history, list(state.items))[0];
  const result = {
    date, revision: state.revision, format: 'meal_planning_diet_brief_v1', summaryOnly: true,
    total: plans.length + history.length, nativePlanCount: plans.length, historyCount: history.length,
    records: plans.map(plan => ({
      id: plan.id, recordId: plan.id, date: plan.date, title: String(plan.title ?? '').slice(0, 100),
      status: plan.status, hasDraft: !!plan.draft, supplementOnly: plan.supplementOnly === true,
      inventoryAccounting: plan.inventoryAccounting, detailRequiredForEdit: true,
      meals: list(plan.meals).map(meal => ({ id: meal.id, slot: meal.slot, state: meal.state })),
      detail: { tool: 'read_food_plan_edit_context', planId: plan.id },
    })),
    dailyNutritionSummaries: selected ? [{
      date, recordId: selected.id, planId: selected.plan?.id ?? null, recordType: selected.recordType,
      ...(selected.recordType === 'diet_history' ? { inventoryEffect: 'none' } : {}),
      basis: selected.basis, partial: selected.partial, supplementPartial: selected.supplementPartial,
      totals: selected.totals.map(total => ({ key: total.key, value: total.value, estimated: total.estimated, partial: total.partial, supplementPartial: total.supplementPartial, source: total.source })),
      issueCount: selected.issues.length,
    }] : [],
    truncated: false, charBudget: DIET_BUDGET,
    instructions: "This returns only the day's menu identity and nutrition overview, excluding full food text, labels, original statements, and historical corrections. Existing plans and supplementOnly days must retain their canonical planId. For meal edits, first read_food_plan_edit_context by date/planId and target meal, which includes complete current preferences. Do not reconstruct the day or copy old actuals from this overview. History has inventoryEffect=none; a historical recordId is not an ordinary planId and cannot justify stock deductions or refunds. Original historical text remains preserved. Use read_diet_records with a specific date or recordId only to check history or evidence; do not bulk-read undated old records. Viewing and reading never deduct inventory.",
  };
  // Never hide an ambiguous duplicate native plan by dropping its identity.
  if (size(result) > DIET_BUDGET) {
    result.records = result.records.map(({ title, meals, ...record }) => ({ ...record, omittedMealCount: meals.length }));
    result.truncated = true;
  }
  if (size(result) > DIET_BUDGET) throw new Error("Too many menu identities exist for this day. Read the original records by date to review them.");
  return result;
}
