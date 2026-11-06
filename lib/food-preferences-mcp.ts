/** Durable preferences are separate from a single day's menu and actual intake. */
import { preferenceWorkflowInstructions } from './food-preferences-context.mjs';
export { preferenceWorkflowInstructions };

const text = { type: 'string', minLength: 1, maxLength: 500 };
export const patchFoodPreferencesTool = {
  name: 'patch_food_preferences',
  title: "Incrementally save explicit lasting preferences",
  description: preferenceWorkflowInstructions + "Change preferences only, preserving menus, stock and actual food/supplements. Retain full previous versions and source reports in history. replace/remove previous text must exactly match current preferences. After 409 reread and reconcile; never bypass with full replacement. Network retries reuse operationId and all parameters.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: { type: 'string', minLength: 1, maxLength: 100, description: "Stable ID for this preference revision; reuse the exact ID and parameters on retries." },
    expectedRevision: { type: 'integer', minimum: 0, description: "Latest read inventory revision." },
    confirmed: { type: 'boolean', const: true, description: "The current user explicitly requested a lasting rule. Do not require redundant confirmation." },
    add: { type: 'array', maxItems: 60, items: text, description: "Add lasting rules, without duplicating identical existing text." },
    replace: { type: 'array', maxItems: 60, items: { type: 'object', additionalProperties: false, properties: { previous: text, next: text }, required: ['previous', 'next'] }, description: "For explicit correction/consolidation, specify the exact previous text and complete replacement." },
    remove: { type: 'array', maxItems: 60, items: text, description: "Exact previous rule explicitly withdrawn by the user; retain its history." },
    sourceText: { type: 'string', minLength: 1, maxLength: 1000, description: "The user's original lasting requirement, never an assistant promise or inference." },
    sourceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "Local date of this user request." },
    reason: { type: 'string', maxLength: 1000, description: "Brief explanation of this revision." },
  }, required: ['operationId', 'expectedRevision', 'confirmed', 'sourceText', 'sourceDate'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
