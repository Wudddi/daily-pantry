import { actorFrom, readInventory, mutateInventory, boundedJson } from '@/lib/inventory-store';
import { readPlanningInventory } from '@/lib/inventory-planning-read.mjs';
import { readHealth, mutateHealth } from '@/lib/health-store';
import { healthContext, readHealthRecords } from '@/lib/health.mjs';
import { readDietRecords, readDailyFoodSummary, readIntakeDraft } from '@/lib/diet.mjs';
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
export const dynamic = 'force-dynamic';

const inventoryWorkflowInstructions = '库存结算按食材独立：明确实际食物用量超过同一盘点基线账面量时归零并记录accountingWarnings差额，实际用量不减少；shortfallQuantity是未实际从账面扣到的部分，更正时先冲差额，不能凭空退款。单位、重新盘点等真实冲突只阻塞对应item；accountingIssues非空不等于其他项目也没扣。检查本次回执和原credit，不整天重报、不转去清除所有历史预留。' + '最新个人勾选规则：网页食物checkbox只是个人提醒，不能根据是否勾选判断吃没吃，也不读取personalFoodChecks。dailyMenuSettlementPolicy启用时，每天多伦多00:00由settle_due_daily_menus按前一天保存菜单结算，未勾不代表未吃；用户明确实际变动优先，旧已扣抵扣只调差量。自动账source=automatic_menu/basis=auto_planned，不能称作用户亲口报告或伪造进食时间；补剂实际不由食品日终任务补造。' + '排餐先满足本次要求与全部习惯，再参考mealPatternReferences里的真实已执行完整主餐日，沿用熟悉组合后调整同类份量；实际记录即使顶层仍为draft也可作为参考，未执行建议不能学习为喜好。新菜单用当前库存营养按现份量重算，不照抄历史总数，不为凑热量创造陌生搭配。freshnessHint区分优先消耗和冷冻可慢慢吃，适配菜式后选；冷冻尾袋或旧更新时间不等于急需清货。开封/品质日期只存明确证据到item.freshness，不从历史备注猜当前状态；Best Before不是安全期限。' + '库存分日常食物、补给、调料与已用完/归档；归零保留原ID和标签。商品补货先匹配name/aliases与品牌规格，复用原itemId，使用restock_food_inventory保存用户报告的当前总余量，不重复新建；不同配方和制作批次分开。DUPLICATE_PRODUCT时使用返回candidates核对原商品，不换新ID绕过。排餐先覆盖全部可用食物候选，再按selectionRules与planningHints软优先级选择：用户明确偏好与营养目标优先，优先食用/尾袋/新鲜易耗食物，其次考虑近期已确认菜单较少出现的食物。最近菜单不是已吃证明；不机械均摊、不为轮换强塞食物，不要求一天用遍库存。补给与调料各自按现有安排和菜式使用，不与主餐争轮换名额。简单食品允许用户授权的工作估值并标estimate/依据，未知馅料和净重仅选中时再问，不因此放弃其他可用库存；不把未称克重写成gramsPerUnit实测。';

const readTool = {
  name: 'read_food_inventory',
  title: '读取当前库存、完整习惯、熟悉搭配及新鲜度',
  description: '人类明确长期习惯更正先patch_food_preferences保存，不把说记住当保存；preferences必须逐条核对，限制优先于库存轮换。按candidateCoverage覆盖全部可用食物、分页读齐后参考selectionRules与planningHints选择，遵守全部preferences，不平均分配、不为了清库存增加食量。补给与调料分开考虑；缺净重或馅料只在选中时核对，不忽略其他食品。首次制定整天饮食读取最新库存。第一页完整带当前习惯、规则、近期已实际执行的熟悉组合mealPatternReferences和通用补给安排，另附体重趋势、最近3次训练量及当天菜单身份概况；不读逐组原话、更新日志或多日菜单全文。items保留全部数量/状态/分袋克重/四项营养与来源；hasMore必须带nextCursor和首读revision继续，续页引用同revision首读习惯，不把未返回食材当没有。已有菜单小改直接read_food_plan_edit_context（已含最新完整习惯）再patch_food_plan，仅传改动；不另读全库存/训练/整天原文。仅核实标签/配方才用itemId+offset分段读原文，摘要不当原文。菜单保存、采用和修改都不预扣，实际吃完才沿用原planId记录结算；中断先核实原ID，重试沿用operationId，不重建菜单或重复扣。null非0，估算标来源，缺货不可安排，mg/IU不当余量或宏量；healthContext.available=false是读取失败。',
  inputSchema: { type: 'object', properties: {
    cursor: { type: ['integer', 'string'], minimum: 0, pattern: '^(0|[1-9]\\d*)$', description: '上一页nextCursor；第一页省略。' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
    expectedRevision: { type: 'integer', minimum: 0, description: '继续分页或读取详情时带首读revision，避免混用新旧库存；409后从第一页重新读取。' },
    itemId: { type: 'string', minLength: 1, maxLength: 100, description: '读取单件食品或补给完整资料的无损JSON分段。' },
    offset: { type: 'integer', minimum: 0, description: '单件详情的nextOffset，首次省略；不能用于库存列表。' },
  }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const shared = {
  operationId: { type: 'string', minLength: 1, maxLength: 100, description: '本次明确确认操作的唯一ID。重试必须沿用相同ID，避免重复扣库存。' },
  expectedRevision: { type: 'integer', minimum: 0, description: '刚刚read_food_inventory读到的revision。库存有变化时重新读取并检查菜单。' },
  confirmed: { type: 'boolean', const: true, description: '仅当当前人类用户明确敲定最终版或明确要求取消时为true。生成建议和讨论修改不算确认。' },
};
const finalizeTool = {
  name: 'finalize_food_plan',
  title: '旧平铺菜单兼容核对（新菜单请分餐保存）',
  description: "已停用新的平铺菜单预扣入口。新菜单用save_food_plan_draft保存结构化餐次，立即显示且不扣库存；采用菜单也不扣，只有明确实际进食才record_meal_intake。此兼容入口仅识别旧已存平铺菜单的同ID原参数重试，不重新扣历史库存；不要通过换ID绕过。",
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...shared,
    plan: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', minLength: 1, maxLength: 100, description: '最终菜单唯一ID；同一菜单的重试沿用此ID。' },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '用户当地日期 YYYY-MM-DD。' },
      items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: {
        itemId: { type: 'string', minLength: 1, maxLength: 100 }, quantity: { type: 'number', exclusiveMinimum: 0 },
      }, required: ['itemId', 'quantity'] } },
      notes: { type: 'string', maxLength: 1000, description: '可选：最终菜单及餐次用量说明，不写成已实际吃完。' },
    }, required: ['id', 'title', 'date', 'items'] },
  }, required: ['operationId', 'expectedRevision', 'confirmed', 'plan'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const cancelTool = {
  name: 'cancel_food_plan',
  title: '取消已确认菜单并退回可用库存',
  description: '仅在用户明确取消先前已确认的菜单时调用。先读取最新库存和计划ID。一次性退回该计划预留的已知数量，保留取消记录；重复取消不会多退。若用户已按此菜单吃完，不应取消或退款。结构化三餐请用revise_food_plan按差量改剩余餐次，同总量午晚餐重分配用allocationOnly；已有实际只能cancel_remaining_food_plan，不能整天退款。旧平铺菜单调整须先呈现修改并获得最终认可。',
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...shared, planId: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['operationId', 'expectedRevision', 'confirmed', 'planId'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const healthRevision = {
  operationId: { type: 'string', minLength: 1, maxLength: 100, description: '这次记录的唯一操作ID，网络重试沿用相同ID。' },
  expectedRevision: { type: 'integer', minimum: 0, description: '刚读取的健康revision；与食物库存revision不同。保存前先读取read_health_records或read_food_inventory中的healthContext.revision。' },
};
const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '用户明确报告的日期 YYYY-MM-DD；日期不清楚先核对，不猜历史日期。' };
const nullableNumber = { type: ['number', 'null'], minimum: 0 };
const inventoryUnitSchema = { type: 'string', enum: ['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴'] };
const nutritionSourceSchema = { type: 'string', enum: ['label', 'recipe', 'estimate', 'unknown'] };
const upsertFoodTool = {
  name: 'upsert_food_inventory', title: '直接保存或更正食物、补给与营养标签',
  description: '新鲜度仅按用户/标签明确报告写freshness，开封日期不猜，Best Before只作品质提醒；当前储存写location。部分更新保留未涉及事实，同商品补货后开封和旧批次日期重新核实。同一商品补货先匹配现有名称/aliases和品牌规格，复用原ID并用restock_food_inventory校准总余量；DUPLICATE_PRODUCT返回的candidates是原商品，不要换名或换ID绕过。不同配方及制作批次单列。用户发来包装、营养或配料表照片并要求记录时，由Chat先识别照片，再直接调用本工具入库或更正，无需让用户复制。先read_food_inventory读取最新库存revision与已有ID，同一商品或批次沿用原ID，真正新批次用新的稳定ID。item是部分更新，未提字段和营养值保留，显式null才改为未知，空文字才清空原文。只改标签不会重新盘点余量。新建需要name/category/unit/quantity，照片只写包装标称净含量不能据此猜已开封当前余量；未确认余量填null。标签更新不得擅自把depleted/pending设成available。保留营养原文sourceText、配料ingredients、补给成分剂量supplementFacts；看不清的数字null，不补零、不猜。标签确认用label，用户明确授权的估算用estimate；每个已更正宏量用nutrientSources标明来源，不能把没重报的旧估算一起升级标签。mg/IU活性成分写入supplementFacts，不当库存质量、体积或宏量。网络重试沿用operationId与item.id。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: shared.operationId, expectedRevision: shared.expectedRevision,
    item: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', minLength: 1, maxLength: 100 }, name: { type: 'string', minLength: 1, maxLength: 120 }, brand: { type: 'string', maxLength: 120 },
      aliases: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 120 }, description: '用户已确认的同一商品别名；补货先匹配名称或别名并复用原ID，不把不同品牌、规格或备餐批次合并。' },
      category: { type: 'string', enum: ['prepared', 'vegetable', 'fruit', 'nuts', 'bread', 'dessert', 'condiment', 'protein', 'staple', 'supplement', 'other'], description: '水果、鲜冻莓果使用fruit；坚果和种子使用nuts。含水果或坚果的面包、甜点或谷物复合食品仍按主要食品类别，不仅凭一个配料归类。' },
      quantity: { ...nullableNumber, maximum: 1000000000, description: '用户确认的当前可用余量；未知null，包装总粒数/净含量不自动当作剩余。' }, unit: inventoryUnitSchema,
      status: { type: 'string', enum: ['available', 'depleted', 'archived', 'pending'], description: '仅在用户明确更改真实库存状态时提供；只识别标签时省略。' },
      priority: { type: 'boolean' }, location: { type: 'string', enum: ['冷冻', '冷藏', '常温', ''] },
      freshness: { type: 'object', additionalProperties: false, properties: {
        opened: { type: ['boolean', 'null'], description: '用户明确报告的当前开封状态，未知null。' },
        openedOn: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '明确的开封日期，不能用购买、更新或备餐日期代替。' },
        bestBeforeDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '标签Best Before品质日期；不是安全截止日期，不因超过就断言不可食，也不催用户吃掉。' },
        userConsumeByDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '用户明确希望用完的日期，仅软优先级，不是食品安全期限。' },
        sourceText: { type: 'string', minLength: 1, maxLength: 1000, description: '本次用户原话或实际包装标签。未报告的信息不从混有旧状态的备注猜测。' },
      }, required: ['sourceText'], description: '仅有真实来源时更新新鲜度事实；部分更新保留其他字段，显式null清空相应未知值。' },
      gramsPerUnit: { ...nullableNumber, maximum: 1000000000, description: '仅用户或标签可靠确认的整件克重，必须正数；不由有效成分mg或体积反推。' },
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
  name: 'restock_food_inventory', title: '复用已有商品补货并校准当前余量',
  description: '用户明确报告同一商品重新购入或补货时，先按名称、别名及品牌规格匹配现有商品（含已用完和归档），复用原itemId、标签和营养，不另建重复商品。不用于新配方或不同制作批次。quantity是用户明确报告的补货后当前可用总余量，不是新增量；不从包装规格猜已开封余量，用户只确认有货且不逐项盘点时可明确用null。补货重置库存校准标记，旧菜单退款不得加到新盘点量；历史记录和营养保持。先读最新revision；重试沿用原operationId及参数。不因为确认收货就自动添加每日补给剂次。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    operationId: shared.operationId, expectedRevision: shared.expectedRevision,
    itemId: { type: 'string', minLength: 1, maxLength: 100 },
    quantity: { ...nullableNumber, maximum: 1000000000, description: '明确报告的当前可用总余量；用户仅确认现有且不逐项盘点时用null，不能把新增量当总量。' },
  }, required: ['operationId', 'expectedRevision', 'itemId', 'quantity'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const commonRecord = {
  id: { type: 'string', minLength: 1, maxLength: 100, description: '记录唯一ID。更正已有记录沿用原ID；相同日期的身体记录不可新建第二条。' },
  date: dateSchema,
  notes: { type: 'string', maxLength: 6000 },
  sourceText: { type: 'string', maxLength: 12000, description: '保留用户实际原话，不把解释、推测或计划写成已完成事实。' },
  source: { type: 'string', enum: ['user_note', 'chat', 'manual'] },
};
const healthReadTool = {
  name: 'read_health_records', title: '读取体重趋势与详细训练记录',
  description: '读取当前私人体重、腰围、体脂与逐动作逐组训练记录，含全局趋势摘要及健康revision。按日期范围或动作名称筛选，动作筛选时只返回匹配训练。列表总返回不超过100条且最多64000字符；hasMore时传nextCursor继续。truncated摘要不是完整原话；指定recordId读取无损详情，长记录detailChunk用nextOffset继续，按offset拼接JSON文本还原。缺失日期不插值，planned不算completed。保存或更正前先读取最新revision；冲突后重新读取核对。',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    from: dateSchema, to: dateSchema, exercise: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    cursor: { type: 'integer', minimum: 0, maximum: 40000, description: '列表上一页返回的nextCursor。' },
    recordId: { type: 'string', minLength: 1, maxLength: 100, description: '按唯一记录ID读取完整详情，包含保存的原始原话。' },
    recordType: { type: 'string', enum: ['measurement', 'session'] },
    offset: { type: 'integer', minimum: 0, description: '单记录长详情的detailChunk.nextOffset，首次省略。' },
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const measurementTool = {
  name: 'record_body_measurement', title: '记录或更正用户汇报的身体数据',
  description: '仅保存用户实际汇报或明确要求记录的体重kg、腰围cm、体脂百分比，不根据饮食、训练或旧趋势猜测数据。先读最新健康revision。同日已有记录时明确编辑原ID；历史更正保留审计。新建未知字段可省略或null，sourceText保留用户原话；更正时未涉及字段应省略以保留已有数据，只有用户明确要求清除才传null或空文字。不能把目标体重当实测体重。',
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
    setId: { type: 'string', minLength: 1, maxLength: 100, description: '该次训练内稳定唯一的组ID。追加或重试沿用；改正用correct，不换ID冒充新组。' },
    weight: { ...nullableNumber, maximum: 5000 }, unit: { type: ['string', 'null'], enum: ['kg', 'lb', null] },
    reps: { type: ['integer', 'null'], minimum: 0, maximum: 2000 },
    kind: { type: 'string', enum: ['warmup', 'working', 'drop', 'unknown'] },
    loadBasis: { type: 'string', enum: ['single_hand', 'total', 'machine', 'bodyweight', 'unknown'], description: '单手、总重量、器械标示、自重或未知；未明确时不能替用户猜口径。' },
    effortFromRep: { type: ['integer', 'null'], minimum: 1, maximum: 2000 }, rir: { ...nullableNumber, maximum: 100 }, rpe: { ...nullableNumber, maximum: 10 },
    notes: { type: 'string', maxLength: 2000 }, sourceText: { type: 'string', maxLength: 6000, description: '保留这一组的用户原话，包括吃力、借力和不确定说法。' },
  },
};
const trainingTool = {
  name: 'record_training_session', title: '记录逐动作逐组训练或明确训练计划',
  description: '新建一次实际训练记录，或保存用户明确采用/要求保存的训练计划。新建必须明确completed或planned，建议不能冒充已完成。训练进行中只汇报已做完的组；可先创建completed空exercises记录，然后每做完一组优先用record_training_sets追加，不能用本工具以第2组替换第1组。未做的未来组不记实际，未采用建议不写计划。整次更正exercises会完整替换动作列表，必须先读全原记录并保留未改动作、组及setId；单组更正优先record_training_sets mode=correct。未涉及顶层字段省略以保留原值，显式null/空文字才清除。未知负重/次数不补猜，保留原话。保存前先读最新健康revision。',
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
  name: 'record_training_sets', title: '训练中追加实际完成组或更正单组',
  description: '用户训练时逐组汇报，优先用此工具追加当前动作实际做完的组，完整保留已有动作、组和原话。记录只能来自用户实际完成的汇报；仅说采用某个建议仍属于计划，不能据此补写已经做过的组。先读取最新健康revision与sessionId；按已有exerciseName/equipment定位，器械有歧义先核对。mode=append每组必须稳定setId及用户原话，同ID重试不重复，同ID不同内容会冲突。mode=correct按sessionId+setId明确更正，set只传更改字段，未提字段保留，之前值可审计。不能把AI建议、用户未采用建议或未来未做组记成已完成；用户明确采用/保存的未来计划用record_training_session planned。实际训练尚无记录时可先新建completed空exercises，再追加已做完组；不可直接往planned里写实际组。',
  inputSchema: { type: 'object', additionalProperties: false, properties: { ...healthRevision,
    mode: { type: 'string', enum: ['append', 'correct'] },
    sessionId: { type: 'string', minLength: 1, maxLength: 100 },
    exerciseName: { type: 'string', minLength: 1, maxLength: 160, description: 'append使用现有动作名称；确为新动作时可新建。' },
    equipment: { type: 'string', maxLength: 300, description: 'append定位动作的器械。存在多个同名动作时必须明确。' },
    sets: { type: 'array', minItems: 1, maxItems: 100, items: { ...trainingSetSchema, required: ['setId', 'sourceText'] } },
    setId: { type: 'string', minLength: 1, maxLength: 100, description: 'correct模式定位原组的ID；先读取，不能凭序号猜。' },
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
  if (message.method === 'initialize') return rpc(id, { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'daily-food-inventory', version: '2.0.0' }, instructions: preferenceWorkflowInstructions + inventoryWorkflowInstructions + '手动进食草稿intakeDraft不是已吃事实。read_intake_draft读取累计已记量与各餐/全天余额，save_intake_draft只存草稿不动actual/计划/库存，只有用户明确提交才submit_intake_draft原子结算。Chat改菜单或新增actual必须保留未提交草稿并允许其标stale；不能自动代提交、清除或把draft数量当actual。' + '菜单保存/修改回执dailyFoodSummary自动合并全天同食材总用量、分餐分配及四项营养，向用户提供全天总量，勿另写手工总数或重复扣账。只查看全天明细用read_diet_records单日date或planId加summaryOnly=daily_food，hasMore沿detail同revision续页；不为此重读全库存或逐组历史。' + '首次制定整天饮食先read_food_inventory读齐全部库存页，首读已含全部当前习惯、通用补给和必要健康概况；续页必须携首读revision，沿用同版习惯，409从首读重来。已有菜单局部修改直接read_food_plan_edit_context（已含最新完整习惯和候选库存），随后patch_food_plan只传改动，不重写其它餐或补给；无需再读全库存、逐组训练或整天原文，写回执nutritionSummary已计算营养，无需只为核总数再读全天。历史与标签全文仅明确核对来源时按日期/ID读取。网页更新后应重新读取。最新菜单保存即显示且可修改，补给打卡独立保留；保存、采用、修改均不扣或预留食物。confirm_daily_food_plan仅为兼容采用动作，不是前置条件。用户明确已吃才record_meal_intake，单餐mealId或全天meals[]，实际correct按差量。历史预扣credits保留抵扣，不重新扣。营养未知不能生成假精确值。体重或训练数据只按用户实际汇报记录；逐组汇报优先record_training_sets追加或更正，不用整次替换抹掉旧组。未采用的AI建议不记录，明确采用/要求保存的未来计划用planned，未来未做组不冒充completed。读写健康记录使用独立的健康revision。读取失败不能当作空数据。首次整天草稿用save_food_plan_draft，局部草稿与已确认菜单用patch_food_plan；确认整份草稿用confirm_daily_food_plan，实际记录用record_meal_intake及record_supplement_intake，计划和实际分开。已保存actual的营养缺失或实称克重更正，用record_meal_intake.nutritionCorrections按existing entryId修正并读回nutritionSummary，库存不变；改计划或备注总数不能替代更正实际快照。旧聊天接口尚无nutritionCorrections时，用patch_food_plan apply confirmed=true，单mealPatches的itemPatches id=actual-nutrition:加原actual entryId，仅含完整nutrition和sourceText；不混入计划或数量字段，库存不变。临时换餐即使已有进食报告也能改同meal ID的计划，实际不变；已吃食物更正用record_meal_intake复用entry ID。completed餐统计和结算以实际为准，确认新草稿不重扣；其余未报告完成餐按最新当前菜单估算，不当作没吃或已结算。全天同量重分餐不重扣。用户发标签照片可识别后upsert_food_inventory直接补全，估算明确标记，不覆盖未报告余量。' });
  if (message.method === 'ping') return rpc(id, {});
  if (message.method === 'tools/list') return rpc(id, { tools });
  if (message.method === 'tools/call') {
    const toolName = message.params?.name;
    if (!tools.some((entry) => entry.name === toolName)) return rpc(id, { content: [{ type: 'text', text: '没有这个工具。' }], isError: true });
    const args = message.params?.arguments;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return rpc(id, { content: [{ type: 'text', text: '工具参数必须是JSON对象。' }], isError: true });
    const startedAt = Date.now();
    try {
      const actor = actorFrom(request);
      let result;
      if (toolName === readFoodBalanceTool.name) {
        const { state } = await readInventory(actor);
        const input = (args ?? {}) as { itemId?: string };
        if (Object.keys(input).some(key => key !== 'itemId') || !input.itemId) throw Object.assign(new Error('请提供唯一itemId。'), { status: 400 });
        result = { available: true, revision: state.revision, ...previewFoodBalanceReconciliation(state, input.itemId) };
      } else if (toolName === reconcileFoodBalanceTool.name) {
        const input = args as { itemId: string; operationId: string };
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'reconcile_food_inventory' });
        result = { available: true, revision: state.revision, item: state.items.find((item: { id: string }) => item.id === input.itemId), operation: 'inventory_balance_reconciled_or_already_reconciled', inventoryEffect: 'explicit_balance_calibration',
          note: '已按有来源的现余量校准并承认旧实际消耗；没有再次消费，原库存和账务快照保留。' };
      } else if (toolName === settleDueDailyMenusTool.name) {
        result = await settleDueDailyMenus(actor, args ?? {});
      } else if (toolName === patchFoodPreferencesTool.name) {
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'patch_preferences' });
        result = { available: true, revision: state.revision, ...foodPreferenceMutationReceipt(state, (args as { operationId?: string })?.operationId) };
      } else if (toolName === 'read_intake_draft') {
        const { state } = await readInventory(actor);
        result = readIntakeDraft(state, args ?? {});
      } else if (toolName === 'read_food_plan_edit_context') {
        const { state } = await readInventory(actor);
        result = { available: true, ...readFoodPlanEditContext(state, args ?? {}) };
      } else if (toolName === 'read_diet_records') {
        const { state } = await readInventory(actor);
        result = { available: true, revision: state.revision, ...readDietRecords(aiFoodReadState(state), args ?? {}) };
      } else if (toolName && dietToolActions[toolName]) {
        const command = args as { planId?: string; mode?: string; nutritionCorrections?: { entryId: string }[]; plan?: { id?: string }; record?: { id?: string }; records?: { id?: string }[]; mealPatches?: { id: string; itemPatches?: { id: string }[] }[]; supplementPatches?: { id: string }[] } | undefined;
        const { state } = await mutateInventory(actor, { ...(args as object), action: dietToolActions[toolName] });
        const rawPlanId = command?.planId ?? command?.plan?.id;
        const planId = typeof rawPlanId === 'string' ? rawPlanId.trim() : undefined;
        const plan = state.plans?.find((entry: { id: string }) => entry.id === planId);
        result = dietToolActions[toolName] === 'import_diet_history'
          ? { available: true, revision: state.revision, recordType: 'diet_history', recordIds: (command?.records ?? [command?.record]).filter(Boolean).map(entry => entry!.id), inventoryEffect: 'none', operation: 'diet_history_imported_or_updated', note: '历史计划与实际原话已保存；本次导入及历史更正都不扣当前库存。详情通过read_diet_records读取。' }
          : { available: true, revision: state.revision, planId, status: plan?.status, inventoryAccounting: plan?.inventoryAccounting, hasDraft: !!plan?.draft, completedMealIds: plan?.meals?.filter((meal: { state: string }) => meal.state === 'completed').map((meal: { id: string }) => meal.id) ?? [], accountingIssues: plan?.accountingIssues, ...(plan?.accountingWarnings?.length ? { accountingWarnings: plan.accountingWarnings } : {}), operation: dietToolActions[toolName], note: '计划、实际食物与补给分开保存；账务按食材独立处理，accountingIssues仅对应尚未结算的项目；正常项可能已经扣减，不能整批重复扣。accountingWarnings是已记下的账面不足差额，不是扣减失败。完整详情可用read_diet_records读取。' };
        if (toolName === 'record_meal_intake' && Array.isArray(command?.nutritionCorrections)) result = { ...result, inventoryEffect: 'none', correctedActualEntryIds: command.nutritionCorrections.map(entry => entry.entryId), note: '已只更正既有实际食物的营养资料与本次克重，旧快照和依据保留；已吃数量、时间、原话、其他餐补给及库存账务不变。以nutritionSummary核对新的全天营养，不能只把总数写备注。' };
        if (planId && ['save_intake_draft', 'submit_intake_draft', 'discard_intake_draft'].includes(toolName)) {
          let intakeView;
          try { intakeView = readIntakeDraft(state, { planId }); }
          catch { intakeView = { available: false, planId, note: '本次操作已经保存；完整进食预览过大或暂不可用，请read_intake_draft按mealIds分餐读取，不要重新提交。' }; }
          result = { ...result, intakeDraftView: intakeView,
            ...(['save_intake_draft', 'discard_intake_draft'].includes(toolName) ? { inventoryEffect: 'none' } : {}),
            note: toolName === 'save_intake_draft' ? '只保存尚未提交的进食草稿，菜单、actual与库存均未改变。'
              : toolName === 'discard_intake_draft' ? '只丢弃待提交草稿，actual与库存均未改变。'
                : '已明确提交草稿中的实际量与转餐；仅按实际差量结算，库存待核时以accountingIssues为准。' };
        }
        if (planId && ['patch_food_plan', 'confirm_daily_food_plan', 'save_food_plan_draft', 'revise_food_plan', 'record_meal_intake', 'submit_intake_draft'].includes(toolName)) {
          let nutritionSummary;
          try { nutritionSummary = foodPlanNutritionSummary(state, planId,
            toolName === 'save_food_plan_draft' || toolName === 'patch_food_plan' && command?.mode === 'draft' ? 'draft' : 'active'); }
          catch { nutritionSummary = { available: false, note: '修改已经保存；营养摘要暂不可用，需要时单独读取核对，不要重新执行修改。' }; }
          let dailyFoodSummary;
          try { dailyFoodSummary = readDailyFoodSummary(state, { planId }); }
          catch { dailyFoodSummary = { available: false, note: '菜单修改已保存；全天食物明细暂未返回，需要时用read_diet_records单日读取，不要重复保存或扣账。' }; }
          result = { ...result, nutritionSummary, dailyFoodSummary, ...(['save_food_plan_draft', 'confirm_daily_food_plan', 'patch_food_plan', 'revise_food_plan'].includes(toolName) ? { inventoryEffect: 'none' } : {}),
            ...(toolName === 'patch_food_plan' ? { mode: command?.mode, changedMealIds: Array.isArray(command?.mealPatches) ? command.mealPatches.map(entry => entry.id) : [],
              changedSupplementIds: Array.isArray(command?.supplementPatches) ? command.supplementPatches.map(entry => entry.id) : [],
              note: command?.mode === 'draft' ? '仅指定字段已合并进草稿，库存未扣减；未指定餐次、食物行与补给完整保留。nutritionSummary是草稿预览，尚未确认为实际。'
                : '仅指定菜单字段已更新，库存变化为0；未指定餐次、食物行、补给与实际记录完整保留。重试未重复扣减。' } : {}) };
        }
        if (toolName === 'patch_food_plan' && command?.mealPatches?.some(meal => meal.itemPatches?.some(entry => entry.id.startsWith('actual-nutrition:')))) result = { ...result, inventoryEffect: 'none', correctedActualEntryIds: command.mealPatches.flatMap(meal => (meal.itemPatches ?? []).map(entry => entry.id.slice('actual-nutrition:'.length))), note: '已通过旧聊天兼容入口只更正实际食物营养并保留旧快照与依据；实际数量、时间、进食原话、计划、其他餐补给和库存账务均不变。' };
      } else if (toolName === healthReadTool.name) {
        const { state } = await readHealth(actor);
        result = readHealthRecords(state, args ?? {});
      } else if (toolName === upsertFoodTool.name) {
        const itemArgs = args as { item?: { id?: unknown } } | undefined;
        if (typeof itemArgs?.item?.id !== 'string' || !itemArgs.item.id.trim() || itemArgs.item.id.length > 100) throw Object.assign(new Error('食物或补给更新必须提供稳定的item.id。'), { status: 400 });
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'upsert' });
        result = { revision: state.revision, item: state.items.find((entry: { id: string }) => entry.id === (itemArgs.item?.id as string).trim()) ?? null, operation: 'inventory_item_saved_or_updated', note: '标签资料更新不会自动重新盘点余量；未涉及的字段保持原值。' };
      } else if (toolName === restockFoodTool.name) {
        const itemArgs = args as { itemId?: string };
        const { state } = await mutateInventory(actor, { ...(args as object), action: 'restock' });
        result = { available: true, revision: state.revision, item: state.items.find((entry: { id: string }) => entry.id === itemArgs.itemId?.trim()) ?? null, operation: 'existing_product_restocked', note: '复用原商品与标签，已保存明确报告的当前总余量；原计划和历史保留，重试不重复补货。' };
      } else if (toolName === trainingSetsTool.name) {
        const setArgs = args as { mode?: string; sessionId?: string } | undefined;
        if (setArgs?.mode !== 'append' && setArgs?.mode !== 'correct') throw Object.assign(new Error('逐组记录mode必须是append或correct。'), { status: 400 });
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
        let context: ReturnType<typeof mealPlanningHealthContext> | { available: boolean; error: string } = { available: false, error: '体重与训练记录暂时读取失败；不能当作没有记录，也不要假装已读取这些健康背景。' };
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
          note: '操作已保存或此前已完成，未重复扣减或退款。需要核实时读取原planId；不要因回复中断另建计划。' };
      }
      const encoded = JSON.stringify(result);
      console.info(JSON.stringify({ event: 'mcp_tool_result', tool: toolName, outcome: 'success', responseCharacters: encoded.length, durationMs: Date.now() - startedAt }));
      return rpc(id, { content: [{ type: 'text', text: encoded }], structuredContent: result, isError: false });
    } catch (error) {
      const value = error as { status?: number; message?: string; code?: string; candidates?: { id: string; name: string; status: string; quantity: number | null; unit: string }[] };
      console.info(JSON.stringify({ event: 'mcp_tool_result', tool: toolName, outcome: 'error', status: value.status ?? 503, durationMs: Date.now() - startedAt }));
      const isHealth = [healthReadTool.name, measurementTool.name, trainingTool.name, trainingSetsTool.name].includes(toolName ?? '');
      const text = value.status === 401 ? '请先连接每日库存插件并登录，当前没有读取到私人记录。' : value.status && value.status < 500 ? value.message || '这次操作未完成。' : isHealth ? '健康记录服务暂不可用；不要把读取失败当作没有体重或训练，也不要假装已经读取或保存。' : '库存服务暂不可用；不要把读取失败当成空库存，也不要假装已经读取。';
      return rpc(id, { content: [{ type: 'text', text }], structuredContent: { available: false, status: value.status ?? 503, code: value.code ?? 'SERVICE_ERROR', ...(value.code === 'DUPLICATE_PRODUCT' && Array.isArray(value.candidates) ? { candidates: value.candidates } : {}) }, isError: true });
    }
  }
  return rpc(id, { code: -32601, message: 'Method not found' }, true);
}
