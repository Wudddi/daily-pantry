import { actorFrom, readInventory, mutateInventory, boundedJson } from '@/lib/inventory-store';
import { readPlanningInventory } from '@/lib/inventory-planning-read.mjs';
import { readHealth, mutateHealth } from '@/lib/health-store';
import { healthContext, readHealthRecords } from '@/lib/health.mjs';
import { readDietRecords, readDailyFoodSummary, readIntakeDraft, materializeDietPlanForEdit } from '@/lib/diet.mjs';
import { previewFoodPlanSync } from '@/lib/sync-food-plan.mjs';
import type { FoodItem } from '@/lib/inventory-types';
import { mealPlanningHealthContext, mealPlanningDietContext } from '@/lib/meal-planning-context.mjs';
import { dietToolActions, dietTools } from '@/lib/diet-mcp';
import { readFoodPlanEditContext, foodPlanNutritionSummary } from '@/lib/diet-edit-read.mjs';
import { patchFoodPreferencesTool, preferenceWorkflowInstructions } from '@/lib/food-preferences-mcp';
import { foodPreferenceMutationReceipt } from '@/lib/food-preferences-context.mjs';
import { aiFoodReadState } from '@/lib/ai-food-read-state.mjs';
import { settleDueDailyMenusTool } from '@/lib/daily-menu-mcp';
import { settleDueDailyMenus } from '@/lib/daily-menu-store';
import { readFoodBalanceTool, reconcileFoodBalanceTool } from '@/lib/food-balance-mcp';
import { previewFoodBalanceReconciliation } from '@/lib/food-balance-reconciliation.mjs';
import { hasActualRecipeGroupResources, actualRecipeGroupResourcePatch } from '@/lib/actual-recipe-groups.mjs';
export const dynamic = 'force-dynamic';

const recipeGroupWorkflowInstructions = "Planned dishes use meal.recipeGroups=[{id,name,lineIds,portion?}] over existing plannedItems.id. Actual dishes separately use meal.actualRecipeGroups=[{id,name,actualEntryIds,portion?}] over this meal's actualEntries.id. Shared yogurt/eggs or inventory SKUs do not prove dish membership. Include actualRecipeGroups with an actual meal report, or use set_actual_recipe_groups to organize existing actual entries without reporting intake again. Preserve omitted groups; [] explicitly clears the applicable groups. Fruit/drinks outside groups remain separate. An explicit half serving is portion=0.5; actual portion labels do not scale actual ingredients. Planned scaling/moving uses scale_recipe_group/move_recipe_group. Never create finished-dish inventory, duplicate nutrition, or guess actual membership from planned recipes. baseQuantities is server-owned. Cached clients may organize existing actual dishes via patch_food_plan: exactly one mealPatches entry containing only id and nonempty recipeGroups; each group id is actual-recipe:<groupId>, and every lineId is actual-entry:<actualEntryId>. This reserved metadata-only form cannot mix planned fields, item patches, notes, supplements or allocationOnly. Ordinary recipeGroups=[] still clears planned groups only.";
const inventoryWorkflowInstructions = recipeGroupWorkflowInstructions + "Settle per ingredient independently. Explicit actual use exceeding the same stock baseline floors quantity at0 and records accountingWarnings shortfall, without reducing actual intake. shortfallQuantity is the amount not deducted from recorded stock; corrections offset shortfall before refunding. Real unit/recount conflicts affect only that item; nonempty accountingIssues does not mean all other items failed. Inspect receipts and credits, never re-report the day or erase historical reservations. Old plans cannot consume later counted/restocked balances. BALANCE_COVERAGE_REQUIRES_REVIEW cannot be bypassed by resetting baselines." + "Food checkboxes are personal reminders available as personalCheckContext in targeted reads. Read the latest saved selection and use canonical sourceMealId/lineId, displayMealId and checked state as advisory context alongside the user message, submitted actuals and prior accounting credits. An explicit user request to settle checked foods authorizes recording those selected foods as eaten and settling only the unaccounted difference; do not ask again merely because selection came from checkmarks. Use selected current row quantities as cumulative intake targets, honoring explicit actual corrections and recording only unreported amounts, never appending the full plan atop existing actuals or marking an entire meal complete from a partial selection. A check alone does not authorize intake or stock changes, and unchecked never means uneaten. Do not infer actual meal times or completion of unselected foods. Reuse original actual IDs and credits rather than lowering stock directly or copying the full day. Moved selections may reference source meals omitted by a display-meal filter; fetch those sourceMealIds for current quantities and actual entries before recording intake. Truncated context is incomplete: narrow the meal selection before acting. If dailyMenuSettlementPolicy is enabled, settle_due_daily_menus runs at 00:00 America/Toronto using the previous date latest menu. Unchecked does not mean uneaten. Explicit actual corrections and old credits settle differences only. Automatic entries have source=automatic_menu/basis=auto_planned, not user-reported actual facts or times. The task never invents supplement use." + "Honor current requests and all preferences first, then use genuine completed-day mealPatternReferences for familiar combinations and comparable quantity changes. Actual records remain valid references even with top-level draft status; unexecuted suggestions are not preferences. Recalculate nutrition from current labels/amounts instead of copying old totals or creating unfamiliar pairings to hit calories. freshnessHint distinguishes fresh-first from frozen-flexible storage; frozen tail bags or old update dates do not imply urgency. Store opened/quality dates only from explicit evidence in item.freshness. Do not infer current state from historical notes. Best Before is a quality date, not a safety deadline." + "Separate daily food, supplements, condiments and depleted/archive inventory. Zero stock retains IDs/labels. Restocking matches existing names/aliases, brand and size, then reuses itemId with restock_food_inventory and the reported current total. Different recipes/batches remain separate. Inspect DUPLICATE_PRODUCT candidates, never evade with a new ID/name. Cover all available candidates before choosing by preferences, nutrition goals and soft selectionRules/planningHints. Prioritize appropriate fresh/priority items, then less recently planned choices. Recent plans are not actual-use evidence; do not force rotation, equal distribution, excess food or every item in one day. Supplements/condiments follow their own routines and dishes. User-authorized working estimates need estimate/provenance. Ask about unknown fillings/net mass only when that food is selected; do not discard other usable stock or mark guessed gramsPerUnit as measured.";

const readTool = {
  name: 'read_food_inventory',
  title: "Read inventory, all preferences and meal context",
  description: "Save explicit lasting preferences with patch_food_preferences, rather than saying they are remembered. Check every preference before inventory rotation. Read all candidateCoverage pages and apply selectionRules/planningHints without forcing equal use or clearing stock by overeating. Separate supplements/condiments. For first-day planning read complete current inventory: first page includes all preferences, rules, actual familiar mealPatternReferences, routine, weight trends, recent 3 training summaries and canonical date plan identity. It omits per-set text, logs and full multi-day menus. items retains amounts/status/package mass/nutrition/provenance. Continue hasMore with nextCursor and first revision; 409 restarts at page 1. Missing pages do not mean missing food. For a local edit, read_food_plan_edit_context already includes all preferences and candidates, then patch only changes; do not reread everything. Use itemId/offset only to verify full label/recipe sources. Save/adopt/edit menus without reserving stock. Actual reports reuse original planId; interrupted requests require verification and stable operationId retries, never another plan. Unknown is not0; unavailable foods cannot be planned. Active mg/IU is not stock or a macronutrient. healthContext.available=false means a read failure.",
  inputSchema: { type: 'object', properties: {
    cursor: { type: ['integer', 'string'], minimum: 0, pattern: '^(0|[1-9]\\d*)$', description: "Previous page nextCursor; omit on the first page." },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
    expectedRevision: { type: 'integer', minimum: 0, description: "First-page revision for pagination/details. After 409 restart at page 1 to avoid mixing inventory versions." },
    itemId: { type: 'string', minLength: 1, maxLength: 100, description: "Read a lossless JSON chunk of one food/supplement record." },
    offset: { type: 'integer', minimum: 0, description: "Item-detail nextOffset, omitted initially; not an inventory-list cursor." },
  }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const shared = {
  operationId: { type: 'string', minLength: 1, maxLength: 100, description: "Unique ID of this explicitly authorized operation; reuse on retries to avoid duplicate deduction." },
  expectedRevision: { type: 'integer', minimum: 0, description: "Latest read_food_inventory revision. Reread and review the menu after inventory changes." },
  confirmed: { type: 'boolean', const: true, description: "True only for explicit user adoption of the final plan or explicit cancellation, not suggestions or discussion." },
};
const finalizeTool = {
  name: 'finalize_food_plan',
  title: "Legacy flat-menu compatibility check",
  description: "New flat-menu pre-deduction is disabled. Save structured meals with save_food_plan_draft for immediate display and zero stock change. Adoption also leaves stock unchanged; only explicit actual food uses record_meal_intake. This endpoint only recognizes same-ID identical retries of existing legacy flat menus, without deducting again. Do not evade with another ID.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...shared,
    plan: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', minLength: 1, maxLength: 100, description: "Stable final menu ID; reuse on retry." },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "User-local date YYYY-MM-DD." },
      items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
        itemId: { type: 'string', minLength: 1, maxLength: 100 }, quantity: { type: 'number', exclusiveMinimum: 0 },
      }, required: ['itemId', 'quantity'] } },
      notes: { type: 'string', maxLength: 1000, description: "Optional final menu/meal quantities, without claiming actual completion." },
    }, required: ['id', 'title', 'date', 'items'] },
  }, required: ['operationId', 'expectedRevision', 'confirmed', 'plan'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const cancelTool = {
  name: 'cancel_food_plan',
  title: "Cancel a legacy reserved menu",
  description: "Only when the user explicitly cancels a previously confirmed menu. Read latest stock and original planId. Release known legacy reservations once and retain cancellation history; repeated cancellation does not refund twice. Do not cancel/refund eaten food. Structured meals use revise_food_plan for remaining differences, allocationOnly for unchanged daily totals and cancel_remaining_food_plan when actuals exist. Legacy flat-menu changes require presenting the revision and explicit adoption.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...shared, planId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['operationId', 'expectedRevision', 'confirmed', 'planId'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const healthRevision = {
  operationId: { type: 'string', minLength: 1, maxLength: 100, description: "Stable operation ID; reuse on network retries." },
  expectedRevision: { type: 'integer', minimum: 0, description: "Latest health revision, separate from food revision. Read read_health_records or read_food_inventory.healthContext.revision before writing." },
};
const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "Explicitly reported date YYYY-MM-DD. Clarify an ambiguous date instead of guessing history." };
const nullableNumber = { type: ['number', 'null'], minimum: 0 };
const inventoryUnitSchema = { type: 'string', description: 'Physical unit using legacy wire keys. Enum order: grams, millilitres, bags, items, pieces, servings, packs, cans, pieces, discrete units, drops. Retain the exact stored key.', enum: ['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴'] };
const nutritionSourceSchema = { type: 'string', enum: ['label', 'recipe', 'estimate', 'unknown'] };
const upsertFoodTool = {
  name: 'upsert_food_inventory', title: "Save food, supplement and nutrition-label facts",
  description: "Write freshness only from explicit user/label evidence. Do not guess opening dates; Best Before is quality-only. location is current storage. Partial updates retain omitted facts; recheck opened/old-batch dates on restock. Match existing names/aliases/brand/size and reuse itemId with restock_food_inventory for current total; inspect DUPLICATE_PRODUCT candidates instead of evading with another ID/name. Separate different recipes/batches. When asked to record packaging/nutrition/ingredient photos, recognize them and call this tool directly. Read latest revision/IDs first; reuse original ID for the same product/batch and stable new IDs for genuine new batches. item is a partial update: omitted fields/nutrients remain, explicit null means unknown and empty text clears source text. Label edits do not recount stock. Creation requires name/category/unit/quantity; package net weight does not prove current opened balance, so unknown=null. Label-only edits must not silently change depleted/pending to available. Preserve sourceText, ingredients and supplementFacts; illegible values remain null. Verified labels use label; authorized estimates use estimate. Each corrected nutrient has accurate nutrientSources; unreported estimates are not upgraded to label. Active mg/IU stays in supplementFacts, not inventory mass/volume/macros. Retry with the same operationId/item.id. Persisted unit and storage values include legacy Chinese keys; use schema enums unchanged.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: shared.operationId, expectedRevision: shared.expectedRevision,
    item: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', minLength: 1, maxLength: 100 }, name: { type: 'string', minLength: 1, maxLength: 120 }, brand: { type: 'string', maxLength: 120 },
      aliases: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 120 }, description: "User-confirmed aliases for the same product. Reuse the matched ID on restock; never merge different brands, sizes or prepared batches." },
      category: { type: 'string', enum: ['prepared', 'vegetable', 'fruit', 'nuts', 'bread', 'dessert', 'condiment', 'protein', 'staple', 'supplement', 'other'], description: "Use fruit for fruit/fresh or frozen berries, nuts for nuts/seeds. Compound bread/dessert/cereal remains categorized by the main food, not one ingredient." },
      quantity: { ...nullableNumber, maximum: 1000000000, description: "User-confirmed current stock, or null if unknown. Package net contents/count is not automatically remaining stock." }, unit: inventoryUnitSchema,
      status: { type: 'string', enum: ['available', 'depleted', 'archived', 'pending'], description: "Supply only for an explicit real stock-status change; omit for label recognition alone." },
      priority: { type: 'boolean' }, location: { type: 'string', enum: ['冷冻', '冷藏', '常温', ''] },
      freshness: { type: 'object', additionalProperties: false, properties: {
        opened: { type: ['boolean', 'null'], description: "Explicitly reported current opened status, or null if unknown." },
        openedOn: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "Explicit opening date, never substituted with purchase/update/preparation date." },
        bestBeforeDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "Label Best Before quality date, not a safety deadline. Do not declare unsafe or force consumption just because it passed." },
        userConsumeByDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: "User-requested use-by preference, a soft planning priority rather than a food-safety deadline." },
        sourceText: { type: 'string', minLength: 1, maxLength: 1000, description: "Current user statement or actual package label. Do not infer missing facts from notes mixing historical states." },
      }, required: ['sourceText'], description: "Update freshness only with reliable sources. Partial fields retain other facts; explicit null clears the corresponding value." },
      gramsPerUnit: { ...nullableNumber, maximum: 1000000000, description: "Positive whole-unit gram mass confirmed by user/label, never inferred from active mg or liquid volume." },
      notes: { type: 'string', maxLength: 2000 }, ingredients: { type: 'string', maxLength: 12000 }, supplementFacts: { type: 'string', maxLength: 12000 },
      nutrition: { type: 'object', additionalProperties: false, properties: {
        basisAmount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 }, basisUnit: inventoryUnitSchema,
        kcal: { ...nullableNumber, maximum: 1000000000 }, protein: { ...nullableNumber, maximum: 1000000000 }, carbs: { ...nullableNumber, maximum: 1000000000 }, fat: { ...nullableNumber, maximum: 1000000000 },
        source: nutritionSourceSchema, sourceNote: { type: 'string', maxLength: 1000 }, sourceText: { type: 'string', maxLength: 16000 },
        nutrientSources: { type: 'object', additionalProperties: false, properties: { kcal: nutritionSourceSchema, protein: nutritionSourceSchema, carbs: nutritionSourceSchema, fat: nutritionSourceSchema } },
      } },
    }, required: ['id'] },
  }, required: ['operationId', 'expectedRevision', 'item'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const restockFoodTool = {
  name: 'restock_food_inventory', title: "Restock an existing product with current total",
  description: "For explicitly reported repurchase/restock, match existing name/aliases/brand/size including depleted/archive records. Reuse itemId and label/nutrition; do not create duplicates or combine different recipes/batches. quantity is the reported current available total after restock, not the amount added. Do not infer opened balance from package size. Null is allowed when the user only confirms availability and does not track an amount. Restock creates a new stock baseline; old-plan refunds cannot add to a new count. Preserve history/nutrition. Read latest revision and reuse operationId/parameters on retry. Receiving stock does not automatically schedule supplement doses.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: shared.operationId, expectedRevision: shared.expectedRevision,
    itemId: { type: 'string', minLength: 1, maxLength: 100 },
    quantity: { ...nullableNumber, maximum: 1000000000, description: "Explicit current available total, or null for confirmed availability without individual tracking. This is not a restock increment." },
  }, required: ['operationId', 'expectedRevision', 'itemId', 'quantity'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const commonRecord = {
  id: { type: 'string', minLength: 1, maxLength: 100, description: "Stable record ID. Reuse for corrections; never create a second body measurement on the same date." },
  date: dateSchema,
  notes: { type: 'string', maxLength: 6000 },
  sourceText: { type: 'string', maxLength: 12000, description: "Keep the actual user statement; never store explanations, guesses or plans as completed facts." },
  source: { type: 'string', enum: ['user_note', 'chat', 'manual'] },
};
const healthReadTool = {
  name: 'read_health_records', title: "Read weight trends and detailed training records",
  description: "Read private weight, waist, body-fat and per-exercise/per-set training with trend summary and health revision. Filter by dates/exercise; exercise filtering returns only matching sessions. Lists are bounded to 100 records / 64,000 characters; continue hasMore with nextCursor. Truncated summaries are not full source text. Read recordId lossless details; concatenate detailChunk by offset using nextOffset. Missing dates are not interpolated and planned is not completed. Read current revision before writes; reread/reconcile conflicts.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    from: dateSchema, to: dateSchema, exercise: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    cursor: { type: 'integer', minimum: 0, maximum: 40000, description: "Previous list page nextCursor." },
    recordId: { type: 'string', minLength: 1, maxLength: 100, description: "Read complete details by stable record ID, including original source report." },
    recordType: { type: 'string', enum: ['measurement', 'session'] },
    offset: { type: 'integer', minimum: 0, description: "Long record detailChunk.nextOffset; omit initially." },
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const measurementTool = {
  name: 'record_body_measurement', title: "Record or correct reported body measurements",
  description: "Save only explicitly reported/requested weight kg, waist cm and body-fat percent. Do not infer from diet, exercise or trends. Read latest health revision. Edit the original same-date ID and retain correction audit. Unknown new fields may be omitted/null; retain sourceText. On correction, omit untouched fields; null/empty text clears only on explicit request. A target weight is not a measurement.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...healthRevision,
    measurement: { type: 'object', additionalProperties: false, properties: { ...commonRecord,
      weightKg: { ...nullableNumber, maximum: 1000 }, waistCm: { ...nullableNumber, maximum: 500 }, bodyFatPct: { ...nullableNumber, maximum: 100 },
      condition: { type: 'string', maxLength: 1000 },
    }, required: ['id', 'date'] },
  }, required: ['operationId', 'expectedRevision', 'measurement'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const trainingSetSchema = {
  type: 'object', additionalProperties: false, properties: {
    setId: { type: 'string', minLength: 1, maxLength: 100, description: "Stable set ID within this session. Reuse on append/retry; corrections use correct, not a new ID." },
    weight: { ...nullableNumber, maximum: 5000 }, unit: { type: ['string', 'null'], enum: ['kg', 'lb', null] },
    reps: { type: ['integer', 'null'], minimum: 0, maximum: 2000 },
    kind: { type: 'string', enum: ['warmup', 'working', 'drop', 'unknown'] },
    loadBasis: { type: 'string', enum: ['single_hand', 'total', 'machine', 'bodyweight', 'unknown'], description: "Per-hand, total, machine-display, bodyweight or unknown load basis. Never guess an unreported basis." },
    effortFromRep: { type: ['integer', 'null'], minimum: 1, maximum: 2000 }, rir: { ...nullableNumber, maximum: 100 }, rpe: { ...nullableNumber, maximum: 10 },
    notes: { type: 'string', maxLength: 2000 }, sourceText: { type: 'string', maxLength: 6000, description: "Original set report, including difficulty, assistance and uncertainty." },
  },
};
const trainingTool = {
  name: 'record_training_session', title: "Record a training session or an adopted plan",
  description: "Create an actual training session or an explicitly adopted/requested future plan. New records must specify completed or planned; suggestions are not completion. During training record only completed sets: a completed session may start with empty exercises, then use record_training_sets to append each reported set instead of replacing earlier sets. Do not invent future actuals or store unadopted advice as plans. Replacing exercises replaces the entire list: read full session first and preserve untouched exercises/sets/setIds. Prefer per-set correct. Omit untouched top-level fields; explicit null/empty text clears. Unknown loads/reps remain unknown; preserve source text and read latest health revision.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...healthRevision,
    session: { type: 'object', additionalProperties: false, properties: { ...commonRecord,
      title: { type: 'string', minLength: 1, maxLength: 160 }, status: { type: 'string', enum: ['completed', 'planned'] }, durationMinutes: { ...nullableNumber, maximum: 1440 },
      exercises: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, equipment: { type: 'string', maxLength: 300 }, notes: { type: 'string', maxLength: 2000 },
        sets: { type: 'array', maxItems: 100, items: trainingSetSchema },
      }, required: ['name', 'sets'] } },
    }, required: ['id', 'date'] },
  }, required: ['operationId', 'expectedRevision', 'session'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const trainingSetsTool = {
  name: 'record_training_sets', title: "Append completed training sets or correct one set",
  description: "Prefer this for set-by-set actual reports, preserving all existing exercises/sets/source text. Only explicit completed work becomes actual; adopting advice remains a plan. Read latest health revision/sessionId. Match exerciseName/equipment, clarifying ambiguous equipment. append needs stable setId and sourceText; identical retries are idempotent, changed content under the same ID conflicts. correct uses sessionId+setId and changed fields only, retaining prior audit. Never record AI advice or future unperformed sets as actual. Explicit future plans use record_training_session planned. For a new actual session, create completed with empty exercises then append completed sets; never append actual sets to planned.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...healthRevision,
    mode: { type: 'string', enum: ['append', 'correct'] },
    sessionId: { type: 'string', minLength: 1, maxLength: 100 },
    exerciseName: { type: 'string', minLength: 1, maxLength: 160, description: "Existing exercise name for append; a genuinely new exercise may be added." },
    equipment: { type: 'string', maxLength: 300, description: "Equipment used to identify the exercise for append. Required to disambiguate repeated names." },
    sets: { type: 'array', minItems: 1, maxItems: 100, items: { ...trainingSetSchema, required: ['setId', 'sourceText'] } },
    setId: { type: 'string', minLength: 1, maxLength: 100, description: "Original set ID for correct mode; read first, never guess from display order." },
    set: trainingSetSchema,
  }, required: ['operationId', 'expectedRevision', 'mode', 'sessionId'], oneOf: [
    { properties: { mode: { const: 'append' } }, required: ['exerciseName', 'sets'] },
    { properties: { mode: { const: 'correct' } }, required: ['setId', 'set'] },
  ] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const tools = [readTool, patchFoodPreferencesTool, settleDueDailyMenusTool, readFoodBalanceTool, reconcileFoodBalanceTool, upsertFoodTool, restockFoodTool, finalizeTool, cancelTool, healthReadTool, measurementTool, trainingTool, trainingSetsTool, ...dietTools];

function rpc(id: unknown, value: unknown, isError = false) {
  return Response.json({ jsonrpc: '2.0', id, ...(isError ? { error: value } : { result: value }) }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request: Request) {
  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  try { message = await boundedJson(request); }
  catch { return rpc(null, { code: -32700, message: 'Invalid JSON request' }, true); }
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpc(null, { code: -32600, message: 'Invalid request' }, true);
  const id = message.id ?? null;
  if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });
  if (message.method === 'server/discover') return rpc(id, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'daily-food-inventory', version: '1.0.0' } });
  if (message.method === 'initialize') return rpc(id, { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'daily-food-inventory', version: '2.0.0' }, instructions: preferenceWorkflowInstructions + inventoryWorkflowInstructions + "intakeDraft is not an actual-intake fact. read_intake_draft reads cumulative recorded amounts and remaining food. save_intake_draft changes neither actuals, plans nor stock. Only explicit submission uses submit_intake_draft atomically. Chat edits/new actuals must preserve pending drafts even if marked stale, never auto-submit, clear or treat draft amounts as actual." + "Menu receipts dailyFoodSummary combines identical daily food quantities, meal allocation and four nutrients. Present these totals rather than manual copies or duplicate settlement. For details use read_diet_records with one date/planId and summaryOnly=daily_food, continuing hasMore/detail at the same revision; do not reread full inventory/training history." + "For a first-day menu read all inventory pages with all current preferences, routine and necessary health context. Continue the first revision; 409 restarts. For local edits use edit context then patch only target fields, preserving other meals/supplements/actuals. Write receipts already contain nutritionSummary; do not reread whole days just for totals. Read full label/history source text only when verifying it by date/ID. Reread after web edits. Saved menus are immediately visible/editable and separate from supplement actuals. Save/adopt/edit never reserves/deducts food; confirmation is legacy adoption only. Explicit actuals use record_meal_intake per meal or meals[], correction by stable entry ID and differences, with old credits retained. Unknown nutrition is not false precision. Health records use their own revision and only actual user reports. Append/correct individual sets; do not replace old sets with later reports. Adopted future plans are planned, not completed; unadopted advice is not stored. Read failures are not empty data. Existing actual nutrition/gram corrections use nutritionCorrections plus source and shared receipt; menu/label/note edits cannot substitute. Legacy clients may use patch_food_plan apply confirmed=true with one meal itemPatches actual-nutrition:<entryId>, complete nutrition/sourceText only. No planned fields, quantities, units or supplements, and no stock change. Planned changes may coexist with actuals, but completed nutrition/settlement still follows actual facts. Same-total meal allocation does not deduct again. Recognize requested label photos directly through upsert_food_inventory, mark estimates and retain unreported balances." });
  if (message.method === 'ping') return rpc(id, {});
  if (message.method === 'tools/list') return rpc(id, { tools });
  if (message.method === 'tools/call') {
    const toolName = message.params?.name;
    if (!tools.some((entry) => entry.name === toolName)) return rpc(id, { content: [{ type: 'text', text: "Unknown tool." }], isError: true });
    const args = message.params?.arguments;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return rpc(id, { content: [{ type: 'text', text: "Tool arguments must be a JSON object." }], isError: true });
    const startedAt = Date.now();
    try {
      const actor = actorFrom(request);
      let result;
      if (toolName === readFoodBalanceTool.name) {
        const { state } = await readInventory(actor);
        const input = (args ?? {}) as { itemId?: string };
        if (Object.keys(input).some(key => key !== 'itemId') || !input.itemId) throw Object.assign(new Error("Provide a unique itemId."), { status: 400 });
        result = { available: true, revision: state.revision, ...previewFoodBalanceReconciliation(state, input.itemId) };
      } else if (toolName === reconcileFoodBalanceTool.name) {
        const input = args as { itemId: string; operationId: string };
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'reconcile_food_inventory' });
        result = { available: true, revision: state.revision, item: state.items.find((item: { id: string }) => item.id === input.itemId), operation: 'inventory_balance_reconciled_or_already_reconciled', inventoryEffect: 'explicit_balance_calibration',
          note: "Calibrated the sourced current balance and recognized already-covered actual consumption without consuming it again. Previous stock/accounting snapshots were retained." };
      } else if (toolName === settleDueDailyMenusTool.name) {
        result = await settleDueDailyMenus(actor, args ?? {});
      } else if (toolName === patchFoodPreferencesTool.name) {
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'patch_preferences' });
        result = { available: true, revision: state.revision, ...foodPreferenceMutationReceipt(state, (args as { operationId?: string })?.operationId) };
      } else if (toolName === 'read_intake_draft') {
        const { state } = await readInventory(actor);
        result = readIntakeDraft(state, args ?? {});
      } else if (toolName === 'read_food_plan_sync_preview') {
        const { state } = await readInventory(actor);
        const input = (args ?? {}) as { planId?: string };
        if (Object.keys(input).some(key => key !== 'planId') || typeof input.planId !== 'string' || !input.planId.trim() || input.planId.length > 100) throw Object.assign(new Error("Provide a valid canonical planId."), { status: 400 });
        const plan = materializeDietPlanForEdit(state, input.planId);
        result = { available: true, revision: state.revision, planId: plan.id, inventoryEffect: 'none', ...previewFoodPlanSync(plan, state.items as unknown as FoodItem[]) };
      } else if (toolName === 'read_food_plan_edit_context') {
        const { state } = await readInventory(actor);
        result = { available: true, ...readFoodPlanEditContext(state, args ?? {}) };
      } else if (toolName === 'read_diet_records') {
        const { state } = await readInventory(actor);
        result = { available: true, revision: state.revision, ...readDietRecords(aiFoodReadState(state), args ?? {}) };
      } else if (toolName && dietToolActions[toolName]) {
        const command = args as { mealId?: string; planId?: string; mode?: string; nutritionCorrections?: { entryId: string }[]; plan?: { id?: string }; record?: { id?: string }; records?: { id?: string }[]; mealPatches?: { id: string; itemPatches?: { id: string }[] }[]; supplementPatches?: { id: string }[] } | undefined;
        const { state } = await mutateInventory(actor, { ...(args as object), action: dietToolActions[toolName] });
        const rawPlanId = command?.planId ?? command?.plan?.id;
        const planId = typeof rawPlanId === 'string' ? rawPlanId.trim() : undefined;
        const plan = state.plans?.find((entry: { id: string }) => entry.id === planId);
        result = dietToolActions[toolName] === 'import_diet_history'
          ? { available: true, revision: state.revision, recordType: 'diet_history', recordIds: (command?.records ?? [command?.record]).filter(Boolean).map(entry => entry!.id), inventoryEffect: 'none', operation: 'diet_history_imported_or_updated', note: "Historical menus and source reports saved without changing current stock. Read details with read_diet_records." }
          : { available: true, revision: state.revision, planId, status: plan?.status, inventoryAccounting: plan?.inventoryAccounting, hasDraft: !!plan?.draft, completedMealIds: plan?.meals?.filter((meal: { state: string }) => meal.state === 'completed').map((meal: { id: string }) => meal.id) ?? [], accountingIssues: plan?.accountingIssues, ...(plan?.accountingWarnings?.length ? { accountingWarnings: plan.accountingWarnings } : {}), operation: dietToolActions[toolName], note: "Plans, actual food and supplements remain separate. Accounting is per item; accountingIssues applies only to unresolved items. Other items may already be settled, so do not retry the entire day as new intake. accountingWarnings records a known stock shortfall, not failed deduction. Use read_diet_records for full details." };
        if (toolName === 'record_meal_intake' && Array.isArray(command?.nutritionCorrections)) result = { ...result, inventoryEffect: 'none', correctedActualEntryIds: command.nutritionCorrections.map(entry => entry.entryId), note: "Corrected only the existing actual food nutrition and this entry gram conversion, preserving previous snapshots/evidence. Actual quantities, times, source reports, other meals/supplements and stock accounting are unchanged. Verify shared daily nutritionSummary rather than editing a note total." };
        if (planId && ['save_intake_draft', 'submit_intake_draft', 'discard_intake_draft'].includes(toolName)) {
          let intakeView;
          try { intakeView = readIntakeDraft(state, { planId }); }
          catch { intakeView = { available: false, planId, note: "Operation saved. Full intake preview is too large or temporarily unavailable; read_intake_draft by mealIds. Do not resubmit." }; }
          result = { ...result, intakeDraftView: intakeView,
            ...(['save_intake_draft', 'discard_intake_draft'].includes(toolName) ? { inventoryEffect: 'none' } : {}),
            note: toolName === 'save_intake_draft' ? "Saved the pending intake draft only. Menu, actuals and stock are unchanged."
              : toolName === 'discard_intake_draft' ? "Discarded the pending draft only. Actuals and stock are unchanged."
                : "Explicitly submitted draft actual amounts and meal transfers. Settled only actual differences; check accountingIssues for unresolved stock." };
        }
        if (planId && ['patch_food_plan', 'confirm_daily_food_plan', 'save_food_plan_draft', 'revise_food_plan', 'record_meal_intake', 'submit_intake_draft', 'scale_recipe_group', 'move_recipe_group', 'add_food_to_meal', 'sync_food_plan', 'set_actual_recipe_groups'].includes(toolName)) {
          let nutritionSummary;
          try { nutritionSummary = foodPlanNutritionSummary(state, planId,
            toolName === 'save_food_plan_draft' || toolName === 'patch_food_plan' && command?.mode === 'draft' ? 'draft' : 'active'); }
          catch { nutritionSummary = { available: false, note: "Changes saved. Nutrition summary is temporarily unavailable; read it separately if needed, without repeating the mutation." }; }
          let dailyFoodSummary;
          try { dailyFoodSummary = readDailyFoodSummary(state, { planId }); }
          catch { dailyFoodSummary = { available: false, note: "Menu changes saved. Daily food detail was not returned; read one date with read_diet_records instead of saving or settling again." }; }
          result = { ...result, nutritionSummary, dailyFoodSummary, ...(['save_food_plan_draft', 'confirm_daily_food_plan', 'patch_food_plan', 'revise_food_plan', 'scale_recipe_group', 'move_recipe_group', 'add_food_to_meal', 'sync_food_plan'].includes(toolName) ? { inventoryEffect: 'none' } : {}),
            ...(toolName === 'patch_food_plan' ? { mode: command?.mode, changedMealIds: Array.isArray(command?.mealPatches) ? command.mealPatches.map(entry => entry.id) : [],
              changedSupplementIds: Array.isArray(command?.supplementPatches) ? command.supplementPatches.map(entry => entry.id) : [],
              note: command?.mode === 'draft' ? "Merged only specified draft fields with no stock deduction. Omitted meals, lines and supplements are retained. nutritionSummary is a menu preview, not actual-intake confirmation."
                : "Updated only specified menu fields with zero stock change. Omitted meals, lines, supplements and actual records are retained. Retry did not deduct again." } : {}) };
        }
        if (toolName === 'set_food_layout') result = { ...result, inventoryEffect: 'none', foodLayoutOverrides: state.plans?.find((plan: { id: string }) => plan.id === planId)?.foodLayoutOverrides ?? [], note: 'Only saved food display placement and its audit changed. Canonical meal sources, quantities, actuals, nutrition, personal checks, supplements, pending drafts, stock and accounting are unchanged.' };
        if (toolName === 'set_actual_recipe_groups' || toolName === 'patch_food_plan' && hasActualRecipeGroupResources(command)) {
          const mealId = toolName === 'set_actual_recipe_groups' ? command?.mealId : actualRecipeGroupResourcePatch(command).mealId;
          result = { ...result, inventoryEffect: 'none', mealId, actualRecipeGroups: state.plans?.find((plan: { id: string }) => plan.id === planId)?.meals?.find((meal: { id: string }) => meal.id === mealId)?.actualRecipeGroups ?? [], note: 'Only actual dish grouping and its audit changed. Ingredient quantities, nutrition snapshots, intake reports, planned food and planned recipe groups, supplements, checks, stock and pending accounting were preserved without settlement.' };
        }
        if (toolName === 'sync_food_plan') result = { ...result, inventoryEffect: 'none', note: "Synced supported planned food to the existing reported-intake basis. Actual records, personal checkmarks, supplements, stock and prior accounting remain unchanged. No food was reported or deducted again." };
        if (toolName === 'patch_food_plan' && command?.mealPatches?.some(meal => meal.itemPatches?.some(entry => entry.id.startsWith('actual-nutrition:')))) result = { ...result, inventoryEffect: 'none', correctedActualEntryIds: command.mealPatches.flatMap(meal => (meal.itemPatches ?? []).map(entry => entry.id.slice('actual-nutrition:'.length))), note: "Legacy compatibility corrected only actual food nutrition and retained previous snapshots/evidence. Actual amounts/times/source reports, menus, other meals/supplements and stock accounting are unchanged." };
      } else if (toolName === healthReadTool.name) {
        const { state } = await readHealth(actor);
        result = readHealthRecords(state, args ?? {});
      } else if (toolName === upsertFoodTool.name) {
        const itemArgs = args as { item?: { id?: unknown } } | undefined;
        if (typeof itemArgs?.item?.id !== 'string' || !itemArgs.item.id.trim() || itemArgs.item.id.length > 100) throw Object.assign(new Error("Food or supplement updates require stable item.id."), { status: 400 });
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'upsert' });
        result = { revision: state.revision, item: state.items.find((entry: { id: string }) => entry.id === (itemArgs.item?.id as string).trim()) ?? null, operation: 'inventory_item_saved_or_updated', note: "Label updates do not recount stock. Omitted fields retain their original values." };
      } else if (toolName === restockFoodTool.name) {
        const itemArgs = args as { itemId?: string };
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'restock' });
        result = { available: true, revision: state.revision, item: state.items.find((entry: { id: string }) => entry.id === itemArgs.itemId?.trim()) ?? null, operation: 'existing_product_restocked', note: "Reused the original product/label and saved the explicitly reported current total. Plans/history are retained; retries do not restock twice." };
      } else if (toolName === trainingSetsTool.name) {
        const setArgs = args as { mode?: string; sessionId?: string } | undefined;
        if (setArgs?.mode !== 'append' && setArgs?.mode !== 'correct') throw Object.assign(new Error("Training set mode must be append or correct."), { status: 400 });
        const { state } = await mutateHealth(actor, { ...(args as object), action: setArgs.mode === 'append' ? 'append_training_sets' : 'correct_training_set' });
        result = { available: true, revision: state.revision, summary: healthContext(state).summary, sessionId: setArgs.sessionId, operation: setArgs.mode === 'append' ? 'training_sets_appended_or_already_recorded' : 'training_set_corrected_or_already_correct' };
      } else if (toolName === measurementTool.name || toolName === trainingTool.name) {
        const { state } = await mutateHealth(actor, { ...(args as object), action: toolName === measurementTool.name ? 'upsert_measurement' : 'upsert_session' });
        result = { available: true, revision: state.revision, summary: healthContext(state).summary, operation: toolName === measurementTool.name ? 'body_measurement_recorded_or_updated' : 'training_session_recorded_or_updated' };
      } else if (toolName === readTool.name) {
        const filters = (args ?? {}) as { cursor?: number | string; itemId?: string };
        const includeContext = filters.itemId === undefined && Number(filters.cursor ?? 0) === 0;
        const [inventory, health] = await Promise.allSettled([
          readInventory(actor),
          includeContext ? readHealth(actor) : Promise.resolve(null),
        ]);
        if (inventory.status === 'rejected') throw inventory.reason;
        const { state } = inventory.value;
        const now = new Date();
        const currentDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        let context: ReturnType<typeof mealPlanningHealthContext> | { available: boolean; error: string } = { available: false, error: "Weight/training records could not be read. Do not treat failure as no records or claim to have reviewed that health context." };
        if (health.status === 'fulfilled' && health.value) {
          try { context = mealPlanningHealthContext(health.value.state); }
          catch { /* A failed health summary must not hide an otherwise valid inventory. */ }
        }
        result = { ...readPlanningInventory(state, filters, now.toISOString()), contextIncluded: includeContext,
          ...(includeContext ? { healthContext: context, dietContext: mealPlanningDietContext(state, currentDay) } : {}), operation: 'read' };
      } else {
        const command = args as { planId?: string; plan?: { id?: string } };
        const { state } = await mutateInventory(actor, { ...(args as object), action: toolName === finalizeTool.name ? 'commit_plan' : 'cancel_plan' });
        const rawPlanId = command?.planId ?? command?.plan?.id;
        const planId = typeof rawPlanId === 'string' ? rawPlanId.trim() : undefined;
        const plan = state.plans?.find((entry: { id: string }) => entry.id === planId);
        result = { available: true, revision: state.revision, planId, status: plan?.status,
          operation: toolName === finalizeTool.name ? 'finalized_or_already_finalized' : 'cancelled_or_already_cancelled',
          note: "Operation saved or previously completed, without duplicate deduction/refund. Verify the original planId if needed; do not create another menu after an interrupted response." };
      }
      const encoded = JSON.stringify(result);
      console.info(JSON.stringify({ event: 'mcp_tool_result', tool: toolName, outcome: 'success', responseCharacters: encoded.length, durationMs: Date.now() - startedAt }));
      return rpc(id, { content: [{ type: 'text', text: encoded }], structuredContent: result, isError: false });
    } catch (error) {
      const value = error as { status?: number; message?: string; code?: string; candidates?: { id: string; name: string; status: string; quantity: number | null; unit: string }[] };
      console.info(JSON.stringify({ event: 'mcp_tool_result', tool: toolName, outcome: 'error', status: value.status ?? 503, durationMs: Date.now() - startedAt }));
      const isHealth = [healthReadTool.name, measurementTool.name, trainingTool.name, trainingSetsTool.name].includes(toolName ?? '');
      const text = value.status === 401 ? "Connect Daily Pantry and sign in before accessing private records." : value.status && value.status < 500 ? value.message || "The operation did not complete." : isHealth ? "Health records are temporarily unavailable. Do not treat read failure as no measurements/training or claim a successful read/write." : "Inventory is temporarily unavailable. Do not treat read failure as empty stock or claim a successful read.";
      return rpc(id, { content: [{ type: 'text', text }], structuredContent: { available: false, status: value.status ?? 503, code: value.code ?? 'SERVICE_ERROR', ...(value.code === 'DUPLICATE_PRODUCT' && Array.isArray(value.candidates) ? { candidates: value.candidates } : {}) }, isError: true });
    }
  }
  return rpc(id, { code: -32601, message: 'Method not found' }, true);
}
