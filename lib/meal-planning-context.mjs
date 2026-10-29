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
  if (!state || !Number.isSafeInteger(state.revision) || !Array.isArray(state.measurements) || !Array.isArray(state.sessions)) throw new Error('健康记录格式不完整');
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
    instructions: '这是饮食规划用的实测趋势与近期训练量概况；缺测不补值，RPE/RIR只汇总已提供数值。逐组重量、次数、感受和原话完整保存在健康记录。制定训练、处理疼痛或恢复细节时按detailRecordId读取原记录，不据此摘要猜测感受或把planned当completed；普通排餐无需重读逐组全文。',
  };
  while (size(result) > HEALTH_BUDGET) {
    const row = result.recentCompletedSessions.toReversed().find(session => session.exercises.length);
    if (!row) throw new Error('饮食规划健康概况超出预算');
    row.exercises.pop(); row.omittedExerciseCount++; result.truncated = true;
  }
  return result;
}

/** Dates and IDs are enough to route an existing menu to the targeted edit reader. */
export function mealPlanningDietContext(state, date) {
  if (!dayPattern.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw new Error('饮食规划日期无效');
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
    instructions: '这里只返回当天菜单身份和营养概况，不含食物全文、标签、原话或历史更正。已有计划或supplementOnly日必须沿用canonical planId；改餐先read_food_plan_edit_context按日期/planId和目标餐读取，已含最新完整习惯，不从此概况重建全天或复制旧actual。历史记录inventoryEffect=none，历史recordId不是普通planId，不据此补扣库存或退款。历史原文继续保留，仅核对历史/来源时用read_diet_records限定date或recordId；不要无日期地批量读取旧记录。查看与读取都不扣库存。',
  };
  // Never hide an ambiguous duplicate native plan by dropping its identity.
  if (size(result) > DIET_BUDGET) {
    result.records = result.records.map(({ title, meals, ...record }) => ({ ...record, omittedMealCount: meals.length }));
    result.truncated = true;
  }
  if (size(result) > DIET_BUDGET) throw new Error('当天菜单身份过多，请按日期读取原记录核对');
  return result;
}
