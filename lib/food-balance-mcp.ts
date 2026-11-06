export const readFoodBalanceTool = {
  name: 'read_food_balance_reconciliation', title: "Preview stock balance and recorded consumption",
  description: "Before calibration, preview the stable itemId to obtain all relevant planIds, explicit actual amounts and old credits. Package net weight is not current stock. A sourced initial amount minus verified use may establish a balance. Unknown actuals, unit conflicts or future reservations prevent automatic calibration. Read-only; no stock deduction.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { itemId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['itemId'] },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
export const reconcileFoodBalanceTool = {
  name: 'reconcile_food_inventory', title: "Calibrate stock with already-covered consumption",
  description: "When the user reports physical stock or a sourced initial amount minus verified actual consumption, read_food_balance_reconciliation for all related planIds first, then calibrate atomically. quantity is the current total, not an addition. The balance already includes old use; carry actual credits to the new baseline without consuming again. Preserve old stock/accounting/source snapshots and other food/actuals/supplements. Do not omit old plans, guess unknown amounts or subtract peeled flesh from an unpeeled gross weight. Reuse operationId.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: { type: 'string', minLength: 1, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, itemId: { type: 'string', minLength: 1, maxLength: 100 },
    quantity: { type: 'number', minimum: 0, maximum: 1000000000 }, planIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
    confirmed: { type: 'boolean', const: true }, sourceText: { type: 'string', minLength: 1, maxLength: 1000 },
  }, required: ['operationId', 'expectedRevision', 'itemId', 'quantity', 'planIds', 'confirmed', 'sourceText'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
