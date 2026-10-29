/** Complete current habits shared by first planning reads, focused edits and write receipts. */
export const preferenceWorkflowInstructions = '长期习惯以应用当前preferences为准，不能用聊天里“记住了”代替保存。人类明确说“以后、平时、除非我说、不要再”等长期要求时，先从read_food_inventory第一页或read_food_plan_edit_context取得完整习惯及revision，再patch_food_preferences增量保存；逐条比较现有习惯，重复规则不再添加，明确更正旧规则用replace精确旧文本，未涉及习惯保留。不能把助手建议、食谱示例、某一天的安排或一次换餐推断为长期习惯；适用范围不清再问。成功回执确认preferencesComplete和本次操作后才能说已保存，失败如实说明。排餐前逐条核对全部有效习惯及本次日期、餐次数和带饭要求；用户限制优先于库存轮换和营养凑数，不因库存有货就安排明确不想吃的东西。临时允许一次不删除长期习惯。只改目标餐，其他餐与补给保留；改完按回执核对全天营养。';

function unavailable() {
  throw Object.assign(new Error('当前排餐习惯无法完整读取，请核对后重试；不能将读取异常当作没有习惯。'), { status: 503, code: 'PREFERENCES_UNAVAILABLE' });
}

function historyOf(state) {
  if (state.preferenceHistory === undefined) return [];
  if (!Array.isArray(state.preferenceHistory)) unavailable();
  return state.preferenceHistory;
}

/** Never shorten, normalize or infer a preference from another record. */
export function foodPreferencesContext(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.preferences) || state.preferences.length > 60
    || state.preferences.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) unavailable();
  const last = historyOf(state).at(-1);
  if (last && (typeof last.at !== 'string' || !Number.isSafeInteger(last.revisionAfter)
    || last.revisionAfter < 1 || last.revisionAfter > state.revision)) unavailable();
  return {
    preferences: state.preferences.slice(), preferencesComplete: true, preferencesCount: state.preferences.length,
    preferencesRevision: state.revision, preferencesLastChangedAt: last?.at ?? null,
    preferencesLastChangedRevision: last?.revisionAfter ?? null, preferenceWorkflow: preferenceWorkflowInstructions,
  };
}

/** A history hit proves a habit change persisted once, including on a retry.
 * No-op receipts prove an already-current save without inventing a change. */
export function foodPreferenceMutationReceipt(state, operationId) {
  const context = foodPreferencesContext(state);
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 100)) {
    throw Object.assign(new Error('习惯操作ID必须为1至100字符。'), { status: 400, code: 'INVALID_INPUT' });
  }
  const entry = operationId === undefined ? null : historyOf(state).findLast(row => row.operationId === operationId) ?? null;
  if (state.preferenceOperationReceipts !== undefined && !Array.isArray(state.preferenceOperationReceipts)) unavailable();
  const noOp = operationId === undefined ? null
    : (state.preferenceOperationReceipts ?? []).findLast(row => row.operationId === operationId) ?? null;
  const operation = entry ?? noOp;
  return {
    ...context, operation: 'preferences_saved_or_already_current', operationId: operationId ?? null,
    operationFound: operation !== null, preferenceChangeApplied: entry !== null, noChange: entry === null,
    inventoryEffect: 'none',
    preferenceOperation: operation === null ? null : {
      operationId: operation.operationId, action: operation.action, at: operation.at,
      sourceDate: operation.sourceDate, reason: operation.reason,
      ...(operation.sourceText === undefined ? {} : { sourceText: operation.sourceText }),
      revisionBefore: operation.revisionBefore, revisionAfter: operation.revisionAfter, noChange: entry === null,
    },
    preferenceChange: entry === null ? null : {
      operationId: entry.operationId, action: entry.action, at: entry.at,
      sourceDate: entry.sourceDate, reason: entry.reason,
      ...(entry.sourceText === undefined ? {} : { sourceText: entry.sourceText }),
      revisionBefore: entry.revisionBefore, revisionAfter: entry.revisionAfter,
      previous: entry.previous.slice(), next: entry.next.slice(),
    },
  };
}
