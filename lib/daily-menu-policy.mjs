const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status, code: 'INVALID_DAILY_MENU_POLICY' }); };
export function readDailyMenuSettlementPolicy(state) {
  const p = state.dailyMenuSettlementPolicy;
  if (p === undefined) return null;
  if (!p || p.version !== 1 || typeof p.enabled !== 'boolean' || p.timeZone !== 'America/Toronto' || !validDate(p.startsOn)
    || typeof p.sourceText !== 'string' || !p.sourceText.trim() || p.sourceText.length > 1000 || typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt))) fail('日终结算设置无法读取，原数据已保留。', 503);
  return structuredClone(p);
}
export function normalizeDailyMenuSettlementPolicy(payload, previous, at) {
  const keys = ['action', 'operationId', 'expectedRevision', 'enabled', 'timeZone', 'startsOn', 'confirmed', 'sourceText'];
  if (!payload || Object.keys(payload).some(key => !keys.includes(key)) || payload.confirmed !== true || typeof payload.enabled !== 'boolean'
    || payload.timeZone !== 'America/Toronto' || !validDate(payload.startsOn) || typeof payload.sourceText !== 'string' || !payload.sourceText.trim() || payload.sourceText.length > 1000) fail('请明确设置个人勾选、午夜结算规则及生效日期。');
  if (!Number.isFinite(Date.parse(at))) fail('设置时间无效。');
  const startsOn = previous?.enabled && payload.enabled ? previous.startsOn : payload.startsOn;
  if (previous && payload.startsOn < previous.startsOn) fail('不能把自动结算设置追溯到最初授权日期之前。');
  return { version: 1, enabled: payload.enabled, timeZone: 'America/Toronto', startsOn, updatedAt: at, sourceText: payload.sourceText };
}
