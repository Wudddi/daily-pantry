import { unitLabel } from './english-display.mjs';
import { dailyMenuAccountingPlan, torontoLocalDate } from './daily-menu-settlement.mjs';

const rows = value => Array.isArray(value) ? value : [];
const clone = value => structuredClone(value);
const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const MAX = 1_000_000_000;
const validAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX;
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
function fail(message, status = 400, code = 'INVALID_FOOD_BALANCE_RECONCILIATION') { throw Object.assign(new Error(message), { status, code }); }
const entries = plan => [...rows(plan.meals), ...rows(plan.supplementDoses)].flatMap(entity => rows(entity.actualEntries));
const itemLines = (lines, itemId) => rows(lines).filter(line => line.itemId === itemId);

/** Read-only preview of all existing credits and reports, never a new intake. */
export function previewFoodBalanceReconciliation(state, itemId, at = new Date().toISOString()) {
  if (!state || !Array.isArray(state.items) || (state.plans !== undefined && !Array.isArray(state.plans))) fail("Invalid inventory or menu data. Reconciliation is unavailable.", 503);
  if (!validId(itemId)) fail("Select a valid inventory ID.");
  const item = state.items.find(value => value.id === itemId);
  if (!item) fail("The food item to reconcile was not found.", 404, 'ITEM_NOT_FOUND');
  const today = torontoLocalDate(at), errors = [], issues = [], planIds = [], planDetails = [];
  const actualIds = new Set();
  const addError = (code, message, planId) => { if (!errors.some(e => e.code === code && e.planId === planId)) errors.push({ code, message, ...(planId ? { planId } : {}) }); };
  if (item.category === 'supplement') addError('FOOD_RECONCILIATION_ONLY', "This action reconciles food only. Review supplement doses separately.");
  let recordedQuantity = 0, unknownQuantity = false;
  for (const plan of state.plans ?? []) {
    const actual = entries(plan).filter(entry => entry.itemId === itemId);
    const credits = itemLines(plan.accountedDebits, itemId), savedLines = itemLines(plan.items, itemId);
    if (!actual.length && !credits.length && !savedLines.length) continue;
    if (!validId(plan.id)) { addError('PLAN_ID_INVALID', "A related menu lacks a valid ID."); continue; }
    planIds.push(plan.id);
    if (plan.format !== 'meals_v1') addError('LEGACY_PLAN_REQUIRES_REVIEW', "Legacy flat reservations cannot be automatically rewritten. Review them separately first.", plan.id);
    if (!validDate(plan.date) || plan.date > today) addError('PLAN_DATE_REQUIRES_REVIEW', "Related records must have an explicit date no later than today.", plan.id);
    if (plan.foodAccounting !== 'actual_only' && !rows(plan.meals).every(meal => ['completed', 'cancelled'].includes(meal.state))) addError('OPEN_RESERVATION_REQUIRES_REVIEW', "The historical reserved menu is not fully completed. Reservations cannot be treated as actuals.", plan.id);
    if (credits.length > 1 || savedLines.length > 1) addError('DUPLICATE_ACCOUNTING_LINE', "The same menu contains duplicate historical credit lines. Review them first.", plan.id);
    for (const line of [...credits, ...savedLines]) {
      if (!validAmount(line.quantity) || line.unit !== item.unit) addError('UNIT_CONFLICT', "The historical credit unit differs from current inventory, or its quantity is invalid. Do not convert and rewrite the account.", plan.id);
      if (line.shortfallQuantity !== undefined && (!validAmount(line.shortfallQuantity) || line.shortfallQuantity > line.quantity)) addError('INVALID_ACCOUNTING_SHORTFALL', "The original shortfall format is invalid. A stock count cannot erase its refund protection.", plan.id);
    }
    let actualQuantity = 0;
    for (const entry of actual) {
      if (!validId(entry.id) || actualIds.has(entry.id)) addError('ACTUAL_ID_CONFLICT', "Actual record IDs are missing or duplicated. The same intake cannot be counted twice in reconciliation.", plan.id);
      actualIds.add(entry.id);
      if (!validAmount(entry.quantity)) { unknownQuantity = true; addError('ACTUAL_QUANTITY_UNKNOWN', "Existing actual quantities are unknown. Do not assume zero or planned quantities.", plan.id); }
      else if (entry.unit !== item.unit) { unknownQuantity = true; addError('UNIT_CONFLICT', "Actual and current inventory units differ. Explicitly correct the original record first.", plan.id); }
      else actualQuantity = round(actualQuantity + entry.quantity);
    }
    if (actualQuantity > MAX || round(recordedQuantity + actualQuantity) > MAX) addError('QUANTITY_OVERFLOW', "Existing actual quantities exceed the supported reconciliation range.", plan.id);
    recordedQuantity = round(recordedQuantity + actualQuantity);
    if (!actual.length && credits.some(line => line.quantity > 0)) addError('ACTUAL_QUANTITY_UNKNOWN', "Historical credits lack explicit actual quantities. A missing actual report is not zero.", plan.id);
    if (plan.dailySettlement?.source === 'automatic_menu') {
      if (plan.dailySettlement.date !== plan.date || !Array.isArray(plan.dailySettlement.plannedMeals)) addError('AUTOMATIC_BASIS_REQUIRES_REVIEW', "Automatic menu settlement evidence is incomplete. Historical credits cannot be silently rewritten.", plan.id);
      const automatic = entries(dailyMenuAccountingPlan(plan)).filter(entry => entry.itemId === itemId);
      if (automatic.some(entry => !validAmount(entry.quantity) || entry.unit !== item.unit)
        || round(automatic.reduce((sum, entry) => sum + (validAmount(entry.quantity) ? entry.quantity : 0), 0)) !== actualQuantity) addError('AUTOMATIC_BASIS_REQUIRES_REVIEW', "The automatic menu still contains assumed consumption without actual reports. An actual-only subtotal cannot replace it.", plan.id);
    }
    for (const issue of rows(plan.accountingIssues).filter(issue => issue.itemId === itemId)) issues.push({ code: issue.code, message: issue.message ?? '', planId: plan.id });
    planDetails.push({ planId: plan.id, actualQuantity, actualEntryIds: actual.map(entry => entry.id) });
  }
  if (new Set(planIds).size !== planIds.length) addError('PLAN_ID_CONFLICT', "Related menu IDs are duplicated. Automatic reconciliation is unavailable.");
  return { itemId, planIds: [...new Set(planIds)].sort(), recordedQuantity: unknownQuantity ? null : recordedQuantity,
    unit: item.unit, bookQuantity: item.quantity, issues, errors, canReconcile: errors.length === 0, planDetails };
}

/** Set an explicit present balance and acknowledge already-recorded intake as
 * covered by that balance. This never performs a second inventory subtraction. */
export function reconcileFoodInventoryBalance(state, payload, at) {
  const allowed = new Set(['action', 'operationId', 'expectedRevision', 'itemId', 'quantity', 'confirmed', 'sourceText', 'planIds']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Reflect.ownKeys(payload).some(key => !allowed.has(key))) fail("Inventory reconciliation contains unsupported fields.");
  if (payload.confirmed !== true) fail("Inventory reconciliation requires the user's explicit confirmation of the current balance and the historical consumption already covered.", 403, 'RECONCILIATION_CONFIRMATION_REQUIRED');
  if (!validAmount(payload.quantity)) fail("The current balance must be an explicit number from 0 to 1000000000. Unknown and negative values are not accepted.");
  if (typeof payload.sourceText !== 'string' || !payload.sourceText.trim() || payload.sourceText.length > 1000) fail("Save the explicit stock count or calculation evidence in source text, up to 1000 characters.");
  if (!Array.isArray(payload.planIds) || payload.planIds.length > 1000 || payload.planIds.some(id => !validId(id)) || new Set(payload.planIds).size !== payload.planIds.length) fail("planIds must list all related menu IDs without duplicates.");
  const preview = previewFoodBalanceReconciliation(state, payload.itemId, at);
  if (!preview.canReconcile) fail(preview.errors[0].message, 409, preview.errors[0].code);
  if (JSON.stringify(payload.planIds.slice().sort()) !== JSON.stringify(preview.planIds)) fail("The related menu or credit scope is incomplete. Preview again; historical consumption must not be omitted.", 409, 'RECONCILIATION_PLAN_COVERAGE_CONFLICT');
  const before = state.items.find(item => item.id === payload.itemId), quantity = round(payload.quantity);
  const token = `${payload.operationId}@${at}`;
  const after = { ...clone(before), quantity, status: quantity === 0 ? 'depleted' : 'available', quantityBaselineToken: token,
    quantityBaselineAt: at, quantityBaselineSource: 'reconcile_food_inventory', confirmedAt: at, updatedAt: at };
  const selected = new Map(preview.planDetails.map(detail => [detail.planId, detail])), credits = [];
  const plans = (state.plans ?? []).map(original => {
    const detail = selected.get(original.id); if (!detail) return original;
    const plan = clone(original);
    const snapshot = value => ({ accountedDebits: clone(itemLines(value.accountedDebits, before.id)), items: clone(itemLines(value.items, before.id)),
      inventoryAccounting: value.inventoryAccounting, accountingIssues: clone(rows(value.accountingIssues)), ...(value.accountingWarnings ? { accountingWarnings: clone(value.accountingWarnings) } : {}), ...(value.dailySettlement ? { dailySettlementAccounting: value.dailySettlement.accounting } : {}) });
    const prior = snapshot(plan);
    const previousLine = itemLines(original.accountedDebits, before.id)[0];
    const shortfall = previousLine?.shortfallQuantity > 0 ? round(Math.min(detail.actualQuantity, Math.max(0, previousLine.shortfallQuantity + detail.actualQuantity - previousLine.quantity))) : 0;
    const line = detail.actualQuantity > 0 ? { itemId: before.id, name: before.name, quantity: detail.actualQuantity, unit: before.unit, unknownBalance: false, baselineToken: token, ...(shortfall > 0 ? { shortfallQuantity: shortfall } : {}) } : null;
    const align = lines => {
      const values = rows(lines), index = values.findIndex(value => value.itemId === before.id);
      const result = values.filter(value => value.itemId !== before.id);
      if (line) result.splice(index < 0 ? result.length : index, 0, clone(line));
      return result;
    };
    plan.accountedDebits = align(plan.accountedDebits); plan.items = align(plan.items);
    if (plan.accountingWarnings || shortfall > 0) plan.accountingWarnings = [...rows(plan.accountingWarnings).filter(w => w.itemId !== before.id), ...(shortfall > 0 ? [{ code: 'STOCK_SHORTFALL_RECORDED', itemId: before.id, quantity: shortfall, unit: before.unit, message: "The shortfall between actual usage and the historical book balance was preserved. Corrections offset it before any refund; no inventory is fabricated." }] : [])];
    plan.accountingIssues = rows(plan.accountingIssues).filter(issue => issue.itemId !== before.id);
    plan.inventoryAccounting = plan.accountingIssues.length ? 'pending_reconciliation' : 'settled';
    if (plan.dailySettlement?.source === 'automatic_menu') {
      const foodIds = new Set(rows(dailyMenuAccountingPlan(plan).meals).flatMap(meal => [...rows(meal.plannedItems), ...rows(meal.actualEntries)]).map(entry => entry.itemId).filter(Boolean));
      plan.dailySettlement.accounting = plan.accountingIssues.some(issue => foodIds.has(issue.itemId)) ? 'pending_reconciliation' : 'settled';
      plan.dailySettlement.lastReconciledAt = at;
      if (plan.dailySettlement.accounting === 'settled' && !plan.dailySettlement.settledAt) plan.dailySettlement.settledAt = at;
    }
    plan.updatedAt = at;
    credits.push({ planId: plan.id, date: plan.date, unit: before.unit, recordedQuantity: detail.actualQuantity, actualEntryIds: detail.actualEntryIds.slice(), before: prior, after: snapshot(plan) });
    return plan;
  });
  return { items: state.items.map(item => item.id === before.id ? after : item), plans,
    historyEntry: { operationId: payload.operationId, at, sourceText: payload.sourceText, revisionBefore: state.revision, revisionAfter: state.revision + 1,
      itemBefore: clone(before), itemAfter: clone(after), planCreditBeforeAfter: credits },
    detail: `Reconciled to the explicitly reported current balance of ${before.name}: ${quantity} ${unitLabel(before.unit, quantity)}; ${preview.planIds.length} earlier records had credits aligned to recorded consumption without another deduction.` };
}

export function checkFoodBalanceReconciliationHistory(state) {
  if (state.inventoryReconciliationHistory === undefined) return;
  const invalid = () => fail("Inventory reconciliation history has an invalid format. Original evidence was preserved; review it first.", 503, 'INVALID_INVENTORY_RECONCILIATION_HISTORY');
  if (!Array.isArray(state.inventoryReconciliationHistory)) invalid();
  const seen = new Set(); let priorRevision = 0;
  for (const entry of state.inventoryReconciliationHistory) {
    if (!entry || !validId(entry.operationId) || seen.has(entry.operationId) || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
      || typeof entry.sourceText !== 'string' || !entry.sourceText.trim() || entry.sourceText.length > 1000
      || !Number.isSafeInteger(entry.revisionBefore) || entry.revisionBefore < priorRevision || entry.revisionAfter !== entry.revisionBefore + 1 || entry.revisionAfter > state.revision
      || !entry.itemBefore || !entry.itemAfter || entry.itemBefore.id !== entry.itemAfter.id || entry.itemBefore.unit !== entry.itemAfter.unit || !validAmount(entry.itemAfter.quantity)
      || !Array.isArray(entry.planCreditBeforeAfter) || typeof entry.fingerprint !== 'string' || !/^v1:[a-f\d]{32}$/.test(entry.fingerprint)
      || !Number.isSafeInteger(entry.fingerprintLength) || entry.fingerprintLength < 0) invalid();
    seen.add(entry.operationId); priorRevision = entry.revisionAfter;
  }
}
