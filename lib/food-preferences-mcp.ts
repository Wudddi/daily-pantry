/** Durable preferences are separate from a single day's menu and actual intake. */
import { preferenceWorkflowInstructions } from './food-preferences-context.mjs';
export { preferenceWorkflowInstructions };

const text = { type: 'string', minLength: 1, maxLength: 500 };
export const patchFoodPreferencesTool = {
  name: 'patch_food_preferences',
  title: '增量保存用户明确的长期排餐习惯',
  description: preferenceWorkflowInstructions + '只改变习惯，不更改已有菜单、食物余量、进食或补给实际。完整旧版及用户原话保留历史，可追溯。replace/remove的旧文本必须与当前preferences精确一致，409后重读核对，不用全量覆盖绕过。网络重试沿用原operationId和原参数。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: { type: 'string', minLength: 1, maxLength: 100, description: '这次习惯修订的稳定操作ID，重试沿用原ID和参数。' },
    expectedRevision: { type: 'integer', minimum: 0, description: '刚读到的库存revision。' },
    confirmed: { type: 'boolean', const: true, description: '当前人类用户已明确表达要长期遵守的要求；不要求用户重复说确认。' },
    add: { type: 'array', maxItems: 60, items: text, description: '新增长期习惯，重复原文不重复添加。' },
    replace: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: { previous: text, next: text }, required: ['previous', 'next'] }, description: '明确更正或合并旧规则时，精确指定旧原文与新全文。' },
    remove: { type: 'array', maxItems: 60, items: text, description: '用户明确撤销的旧规则原文；旧版仍保留历史。' },
    sourceText: { type: 'string', minLength: 1, maxLength: 1000, description: '人类明确长期要求的原话，不能填写助手承诺或推测。' },
    sourceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '这次用户要求的当地日期。' },
    reason: { type: 'string', maxLength: 1000, description: '本次修订的简短说明。' },
  }, required: ['operationId', 'expectedRevision', 'confirmed', 'sourceText', 'sourceDate'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
