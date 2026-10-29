export const readFoodBalanceTool = {
  name: 'read_food_balance_reconciliation', title: '核对食品余量与已记录消耗',
  description: '当前余量要校准时，先按稳定itemId读取此预览，返回完整相关planIds、明确实际用量和旧信用。不能用包装标称量冒充现余量；可用明确原始量减已核实摄入计算，并保存依据。未知实际、单位冲突或未来预留会阻止自动校准。读取不扣库存。',
  inputSchema: { type: 'object', additionalProperties: false, properties: { itemId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['itemId'] },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
export const reconcileFoodBalanceTool = {
  name: 'reconcile_food_inventory', title: '校准当前余量并承认已包含的旧消耗',
  description: '用户提供当前实存余量，或明确原始量与已核实的实际消耗后，先read_food_balance_reconciliation核对全部相关planIds，再原子校准。quantity是现余量，不是新增量；本次余额已经包含旧摄入，旧实际信用同步到新基线，绝不再消费一遍。完整旧库存、原账、原话保留，其他食物、实际、补给不变。不能省略旧计划、猜未知用量或把果肉克数从带皮原重直接相减。重复操作沿用operationId。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: { type: 'string', minLength: 1, maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, itemId: { type: 'string', minLength: 1, maxLength: 100 },
    quantity: { type: 'number', minimum: 0, maximum: 1000000000 }, planIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
    confirmed: { type: 'boolean', const: true }, sourceText: { type: 'string', minLength: 1, maxLength: 1000 },
  }, required: ['operationId', 'expectedRevision', 'itemId', 'quantity', 'planIds', 'confirmed', 'sourceText'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
