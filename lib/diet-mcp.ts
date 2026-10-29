const identifier = { type: 'string', minLength: 1, maxLength: 100 };
const time = { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: '当地HH:mm；用户未报告则留空，不把计划时间当实际时间。' };
const unit = { type: 'string', enum: ['g', 'ml', '袋', '个', '片', '份', '包', '罐', '条', '粒', '滴'] };
const text = { type: 'string', maxLength: 6000 };
const revision = {
  operationId: { ...identifier, description: '稳定操作ID，重试沿用；餐次、食物条目及补给剂次的ID也保持稳定。' },
  expectedRevision: { type: 'integer', minimum: 0, description: '刚读取的库存revision，饮食与库存共享同一个版本。' },
};
const dailySupplementInstructions = '补给使用每天通用时间表，按日期独立记录实际勾选，无需先有菜单。先读当天canonical planId，补给和食物复用该ID及稳定dose/meal/item ID；已有菜单保存后立即显示，补给操作保留它及全部实际事实。无菜单时才建立纯补给记录；以后同ID补充菜单，不新建第二份账。结合trainingDayOnly适配训练/休息，不复制旧日actual、勾选或时间。保存、采用和修改菜单都不预留或扣食物库存，仅明确实际摄入才结算。';
const dailyFoodRollupInstructions = '每次保存或局部修改菜单后，服务端回执dailyFoodSummary自动给出全天合并食物总量、各餐分配、食物与补给分项及总kcal/P/C/F；以保存的各餐快照计算，不另写手工总数或重建菜单。向用户说明当天总量并可按汇总备餐。同食材分餐只加总一次，不重复扣库存。缺项保持未知；hasMore按detail同revision续页。只需全天汇总时read_diet_records传单日date/planId与summaryOnly=daily_food，不重读整天原话；普通多日及局部改餐上下文不携长表。';
const nutritionSource = { type: 'string', enum: ['label', 'recipe', 'estimate', 'unknown'] };
const nullableNutrient = { type: ['number', 'null'], minimum: 0 };
const foodNutrition = { type: 'object', additionalProperties: false, properties: {
  basisAmount: { type: 'number', exclusiveMinimum: 0 }, basisUnit: unit, kcal: nullableNutrient, protein: nullableNutrient, carbs: nullableNutrient, fat: nullableNutrient,
  source: nutritionSource, sourceNote: { type: 'string', maxLength: 1000 }, sourceText: { type: 'string', maxLength: 16000 },
  nutrientSources: { type: 'object', additionalProperties: false, properties: { kcal: nutritionSource, protein: nutritionSource, carbs: nutritionSource, fat: nutritionSource } },
}, required: ['basisAmount', 'basisUnit'] };
const plannedLine = { type: 'object', additionalProperties: false, properties: {
  id: identifier, itemId: { type: ['string', 'null'], minLength: 1, maxLength: 100, description: '已跟踪库存必须引用ID。仅用户明确不逐项跟踪的常备食品可为null，并明确name和unit，跳过库存结算；不盘点仍须计算营养，不得改名绕过缺货。' }, name: { type: 'string', maxLength: 200 }, quantity: { type: 'number', exclusiveMinimum: 0 }, unit, sourceText: text, nutrition: { ...foodNutrition, description: '常备食品不盘点也应保存明确basisAmount/basisUnit的kcal/P/C/F，估算标estimate、真实标签才标label。带库存ID的行可提供仅本计划的份量估算：只允许source=estimate，known字段的nutrientSources也为estimate，正basisAmount且basisUnit同本行unit，至少一项known，sourceText/sourceNote至少一项非空；不改库存标签或通用罐克重。未知字段null并列缺项，不填零、不默默改变实际单位/批次。' },
}, required: ['id', 'itemId', 'quantity'] };
const meal = { type: 'object', additionalProperties: false, properties: {
  id: identifier, slot: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'other'] }, title: { type: 'string', minLength: 1, maxLength: 160 },
  plannedTime: time, plannedTimeText: { type: 'string', maxLength: 300 }, plannedItems: { type: 'array', maxItems: 100, items: plannedLine },
}, required: ['id', 'slot', 'title', 'plannedItems'] };
const dose = { type: 'object', additionalProperties: false, properties: {
  id: identifier, itemId: identifier, plannedQuantity: { type: ['number', 'null'], exclusiveMinimum: 0, description: '明确的物理单位计划用量；用量未核对用null，不猜成1，也不把活性成分mg当库存剂量。已确认1粒而IU/成分待核时仍保留1粒，不能清空已知粒数。' }, unit,
  plannedMealId: { type: ['string', 'null'], maxLength: 100 }, plannedTime: time, plannedTimeText: { type: 'string', maxLength: 300 }, sourceText: text,
  timingSlot: { type: 'string', enum: ['breakfast', 'lunch', 'pre_workout', 'post_workout', 'dinner', 'bedtime', 'other'] },
  requirement: { type: 'string', enum: ['daily', 'optional', 'as_needed', 'label_pending'], description: '每日安排、用户可选、按需或标签待核；可选清单保留而非每天强制服用，不能因库存有货就全排。' },
  scheduled: { type: 'boolean', description: '是否实际列入当天计划，所有requirement均遵守显式值。旧剂次/daily默认true，其余默认false；未安排或用量未知不计计划营养；仅明确实际服用才结算库存。label_pending显式true且物理单位量已知时照常安排，标签未知字段仍null。' },
  instruction: { type: 'string', maxLength: 1000, description: '保留随餐、冲饮、可选条件及用户截图用法；标签说明不代表用户已实际服用。' },
  trainingDayOnly: { type: 'boolean', description: '仅训练日的安排标记；排下一天须结合当天训练/休息重新安排，不能机械复制。' },
}, required: ['id', 'itemId', 'plannedQuantity'] };
const actualLine = { type: 'object', additionalProperties: false, properties: {
  id: identifier, itemId: { type: ['string', 'null'], maxLength: 100 }, name: { type: 'string', maxLength: 160 },
  quantity: { type: ['number', 'null'], minimum: 0 }, unit: { type: 'string', maxLength: 30 }, sourceText: text,
}, required: ['id', 'itemId', 'quantity', 'sourceText'] };
const actualNutritionCorrection = { type: 'object', additionalProperties: false, properties: {
  entryId: identifier,
  nutrition: { ...foodNutrition, required: ['basisAmount', 'basisUnit', 'kcal', 'protein', 'carbs', 'fat', 'source'], description: '仅此实际条目的完整营养口径；提供时完整替换，必须列全basisAmount/basisUnit/kcal/protein/carbs/fat与来源，未知填null。来源/换算依据必填，不从全天总数反推分摊。标签仍label，沿用计划或历史估值标estimate；不改库存标签。' },
  fromPlannedLineId: { ...identifier, description: '显式沿用本餐已确认同食品同单位的计划行营养估算，仅复制营养，不复制计划数量或已吃状态，不读取未确认草稿。与nutrition二选一。' },
  gramsPerUnit: { type: ['number', 'null'], exclusiveMinimum: 0, description: '仅本实际条目每一个/罐/袋等物理单位对应的克重；如本个贝果实称86g填86，不改库存平均85g、不改实际1个。未知填null，不把mL或补剂活性mg当g。同单位营养已按每个给出时，改克重本身不会重算该每个营养，应明确g标签口径。' },
  sourceText: { type: 'string', minLength: 1, maxLength: 10000, description: '非空更正依据，保留包装来源、实称原话或沿用本餐工作估值的理由。' },
}, required: ['entryId', 'sourceText'], anyOf: [{ required: ['nutrition'] }, { required: ['fromPlannedLineId'] }, { required: ['gramsPerUnit'] }], not: { required: ['nutrition', 'fromPlannedLineId'] } };
const report = {
  mode: { type: 'string', enum: ['append', 'correct', 'complete'], description: '追加实际食物、更正指定条目或明确完成这一餐；更正保留原值审计。' },
  entries: { type: 'array', maxItems: 100, items: actualLine }, actualTime: time,
  actualTimeText: { type: 'string', maxLength: 300 }, sourceText: text,
};
const mealReport = { type: 'object', additionalProperties: false, properties: {
  ...report, mealId: identifier, matchesPlannedFood: { type: 'boolean', description: '只有用户明确已按当前菜单吃完才为true；未来会执行不算实际。纯网页partial会沿稳定ID补足差量。若已有不同Chat实际或Chat与网页混合实际，不能再次复制整餐；改用read_intake_draft取得累计量，按用户报告save_intake_draft/submit_intake_draft或明确correct既有entry，保留外部事实。' },
}, required: ['mealId'] };
const doseReport = { type: 'object', additionalProperties: false, properties: {
  ...report, doseId: identifier, matchesPlannedDose: { type: 'boolean', description: '用户明确确认按此计划剂量实际服用，不能从吃完饭推断。' },
  actualMealId: { type: ['string', 'null'], maxLength: 100, description: '实际随哪一餐服用；换餐仍沿用原doseId。' },
}, required: ['doseId'] };
const mutationAnnotation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const itemPatch = { type: 'object', additionalProperties: false, properties: {
  ...plannedLine.properties, id: { ...identifier, description: '普通修改使用计划食物行ID。兼容旧聊天补实际营养时用actual-nutrition:加原actual entryId，且只传id/nutrition/sourceText，不传数量/单位/食材或remove。' }, remove: { type: 'boolean', const: true, description: '明确删除此行，仅提供id和remove；遗漏行一律保留，不用quantity=0删除。' },
  nutrition: { ...plannedLine.properties.nutrition, description: '省略nutrition保留该食品已有营养。提供时整体替换这份计划级营养估算，须列全要保留的basisAmount/basisUnit/kcal/protein/carbs/fat及真实来源；未知null，不只传一个宏量而遗漏其他已知值。更换库存食品通常省略，应用使用新食品标签。' },
}, required: ['id'] };
const mealPatch = { type: 'object', additionalProperties: false, properties: {
  id: identifier, remove: { type: 'boolean', const: true }, slot: meal.properties.slot, title: meal.properties.title,
  plannedTime: time, plannedTimeText: meal.properties.plannedTimeText,
  itemPatches: { type: 'array', minItems: 1, maxItems: 100, items: itemPatch },
}, required: ['id'] };
const dosePatch = { type: 'object', additionalProperties: false, properties: {
  ...dose.properties, remove: { type: 'boolean', const: true },
}, required: ['id'] };
const historyNumber = { type: ['number', 'null'], minimum: 0 };
const historyNutrition = { type: 'object', additionalProperties: false, properties: {
  kcal: historyNumber, protein: historyNumber, carbs: historyNumber, fat: historyNumber, fiber: historyNumber, sugar: historyNumber, sodiumMg: historyNumber,
  source: { type: 'string', enum: ['label', 'recipe', 'estimate', 'unknown'] }, sourceText: { type: 'string', maxLength: 16000 },
} };
const historyTimes = { plannedTime: time, plannedTimeText: { type: 'string', maxLength: 500 }, actualTime: time, actualTimeText: { type: 'string', maxLength: 500 } };
const historyStatus = { type: 'string', enum: ['planned', 'reported_completed', 'partial_report', 'unknown'] };
const historyEntry = { type: 'object', additionalProperties: false, properties: { id: identifier, name: { type: 'string', maxLength: 200 }, quantity: historyNumber, plannedQuantity: historyNumber, actualQuantity: historyNumber, quantitySource: { type: 'string', enum: ['reported', 'confirmed_plan_portion', 'unknown'] }, unit: { type: 'string', maxLength: 40 }, inventoryItemId: identifier, nutrition: historyNutrition, sourceText: { type: 'string', maxLength: 10000 } }, required: ['id', 'name', 'quantity', 'unit'] };
const historyRecord = { type: 'object', additionalProperties: false, properties: {
  id: identifier, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, title: { type: 'string', maxLength: 200 }, timeZone: { type: 'string', maxLength: 100 }, confirmation: { type: 'string', enum: ['final_plan', 'reported_completed', 'partial_report'] },
  meals: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, properties: { id: identifier, name: { type: 'string', maxLength: 200 }, status: historyStatus, items: { type: 'array', maxItems: 100, items: historyEntry }, ...historyTimes, nutrition: historyNutrition, sourceText: { type: 'string', maxLength: 10000 } }, required: ['id', 'name', 'status', 'items'] } },
  supplements: { type: 'array', maxItems: 100, items: { ...historyEntry, properties: { ...historyEntry.properties, ...historyTimes, status: historyStatus }, required: [...historyEntry.required, 'status'] } },
  nutrition: historyNutrition, planSourceText: { type: 'string', maxLength: 100000 }, executionSourceText: { type: 'string', maxLength: 100000 }, notes: { type: 'string', maxLength: 10000 },
  sourceRefs: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { conversationId: { type: 'string', maxLength: 200 }, messageKey: { type: 'string', maxLength: 200 }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, kind: { type: 'string', enum: ['user', 'assistant', 'document'] }, text: { type: 'string', maxLength: 16000 } }, required: ['conversationId', 'messageKey', 'kind'] } },
}, required: ['id'] };

export const dietToolActions: Record<string, string> = {
  save_intake_draft: 'save_intake_draft', submit_intake_draft: 'submit_intake_draft', discard_intake_draft: 'discard_intake_draft',
  save_food_plan_draft: 'save_meal_plan_draft', confirm_daily_food_plan: 'commit_meal_plan',
  patch_food_plan: 'patch_meal_plan',
  revise_food_plan: 'revise_unconsumed_meals', record_meal_intake: 'record_meal_intake',
  record_supplement_intake: 'record_supplement_intake', cancel_daily_food_plan: 'cancel_meal_plan',
  set_supplement_check: 'set_supplement_check',
  set_daily_supplement_check: 'set_daily_supplement_check',
  save_supplement_routine: 'save_supplement_routine',
  cancel_remaining_food_plan: 'cancel_remaining_meals',
  import_diet_history: 'import_diet_history',
};
export const dietTools = [
  { name: 'read_intake_draft', title: '读取手动进食草稿和各餐剩余',
    description: '只读当前日期canonical菜单的手动进食草稿、已提交量和每餐/全天剩余。草稿不是已吃，保存不会改菜单或库存；不要将draft预览冒充actual。stale时先刷新核对，不能覆盖Chat或网页的新记录。没有草稿也返回当前余额；mealIds可缩小预览，原数据完整保留。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { planId: identifier, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, mealIds: { type: 'array', maxItems: 16, items: identifier } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'save_intake_draft', title: '保存尚未结算的手动进食草稿',
    description: '保存累计已吃量和跨餐分配的待提交草稿，不改真实planned/actual、餐次完成状态、补给或库存。先read_intake_draft取baseFingerprint和draftVersion；expectedDraftVersion必须沿用本次编辑起点的云版本（无草稿null），另一设备改草稿后拒绝覆盖。同一天沿原planId。consumed是累计量，不是本次增量；correctExistingActuals仅当前用户明确勾选更正既有actual时为true，仍保留原ID及审计。只转未吃余量，目的行ID由预览返回。草稿不得当实际食用事实。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, expectedDraftVersion: { type: ['string', 'null'], maxLength: 100 }, draft: {
      type: 'object', additionalProperties: false, properties: { id: identifier, baseFingerprint: identifier, updatedAt: { type: 'string' },
        consumed: { type: 'array', maxItems: 1200, items: { type: 'object', additionalProperties: false, properties: { mealId: identifier, lineId: identifier, quantity: { type: ['number', 'null'], minimum: 0, maximum: 1000000000 }, unit: { type: 'string', maxLength: 20 }, correctExistingActuals: { type: 'boolean' } }, required: ['mealId', 'lineId', 'quantity'] } },
        transfers: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { id: identifier, fromMealId: identifier, lineId: identifier, toMealId: identifier, quantity: { type: 'number', exclusiveMinimum: 0 }, unit: { type: 'string', maxLength: 20 } }, required: ['id', 'fromMealId', 'lineId', 'toMealId', 'quantity'] } },
        completedMealIds: { type: 'array', maxItems: 16, items: identifier },
      }, required: ['id', 'baseFingerprint', 'consumed', 'transfers', 'completedMealIds'] },
    }, required: ['operationId', 'expectedRevision', 'planId', 'draft', 'expectedDraftVersion'] }, annotations: mutationAnnotation },
  { name: 'submit_intake_draft', title: '明确提交进食草稿并仅结算实际差量',
    description: '只有当前用户明确提交实际已吃时调用，不能因保存草稿或认可计划自动提交。沿已保存draftId/baseFingerprint及operationId重试，先原子同步未吃部分的跨餐分配，再记录/更正稳定actual ID，仅settle一次。不同的外部实际不可静默改写；明确更正保留原值审计。库存待核时保留事实且不部分加减，不声称已正确扣账。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, draftId: identifier, baseFingerprint: identifier, expectedDraftVersion: identifier }, required: ['operationId', 'expectedRevision', 'planId', 'draftId', 'baseFingerprint', 'expectedDraftVersion'] }, annotations: mutationAnnotation },
  { name: 'discard_intake_draft', title: '丢弃尚未提交的进食草稿',
    description: '只清除当前手动草稿，原菜单、actual、补给与库存保持不变，不退款、不抹掉已吃事实。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, draftId: identifier, expectedDraftVersion: { type: ['string', 'null'], maxLength: 100 } }, required: ['operationId', 'expectedRevision', 'planId', 'expectedDraftVersion'] }, annotations: mutationAnnotation },
  { name: 'read_food_plan_edit_context', title: '快速读取要改的餐次与替换库存',
    description: "局部改餐优先使用本工具，不拉整天原话、全库存和逐组训练。一次返回最新revision、全部有效preferences、目标稳定meal/line/actual ID、当前菜单和实际份量、少量替换候选及全天营养。默认view=draft读取最新当前菜单（包含兼容的旧嵌套草稿）；view=active核对原存储菜单。用mealIds/mealSlots限定改动，candidateItemIds/foodQuery找替换。未返回的其他餐和补给必须保留，不能据摘要重建。保存或修改当前菜单均不预留扣库存，完成餐按实际快照统计，未完成餐按当前菜单估算；未知/partial不当0。已有实际可改同meal ID的planned字段，但实际种类、数量、时间、原话和完成状态不可覆盖；更正实际用record_meal_intake correct并复用actual ID。全部preferences始终有效，不为提速漏掉库存或习惯。",
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      planId: identifier, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      mealIds: { type: 'array', minItems: 1, maxItems: 16, items: identifier },
      mealSlots: { type: 'array', minItems: 1, maxItems: 5, items: meal.properties.slot },
      candidateItemIds: { type: 'array', maxItems: 12, items: identifier }, foodQuery: { type: 'string', minLength: 1, maxLength: 160 },
      view: { type: 'string', enum: ['draft', 'active'], default: 'draft' }, expectedRevision: revision.expectedRevision,
    }, anyOf: [{ required: ['planId'] }, { required: ['date'] }] }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'patch_food_plan', title: '只修改指定食材餐次，保留其他餐和补给',
    description: dailyFoodRollupInstructions + "局部改餐仅按稳定meal/line/dose ID合并显式字段，其他餐、补给和实际事实完整保留。先read_food_plan_edit_context；改数量只传id/quantity，换食品沿用行ID传itemId/quantity，新增行用新行ID和已知库存ID，删除仅id/remove=true。有实际事实的餐/剂次不能删除。mode=draft和mode=apply均立即保存当前菜单且库存变化为0；apply沿用旧参数confirmed=true，只表示采用计划，绝不表示吃完。已有旧嵌套草稿继续合并，不因旧待确认状态阻塞。已吃的实际更正必须record_meal_intake correct复用actual entry ID，不以计划覆盖。全天同量分餐可allocationOnly=true，不动实际。相同请求重试沿用operationId。兼容实际营养更正：只用mode=apply confirmed=true、一个mealPatches，itemPatches的id为actual-nutrition:加原actual entryId，仅传id/nutrition/sourceText，提供完整有来源四项，禁止混入普通计划、数量、单位或补给；此路径不动库存，旧快照留审计。优先新接口nutritionCorrections。",
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      ...revision, planId: identifier, mode: { type: 'string', enum: ['draft', 'apply'] }, confirmed: { type: 'boolean', const: true },
      title: { type: 'string', minLength: 1, maxLength: 160 }, notes: text,
      mealPatches: { type: 'array', minItems: 1, maxItems: 16, items: mealPatch },
      supplementPatches: { type: 'array', minItems: 1, maxItems: 32, items: dosePatch }, allocationOnly: { type: 'boolean' },
    }, required: ['operationId', 'expectedRevision', 'planId', 'mode'] }, annotations: mutationAnnotation },
  { name: 'import_diet_history', title: '导入或更正历史菜单与执行原话，库存不变',
    description: '只用于迁移已存在的历史饮食资料，存独立dietHistory并始终inventoryEffect=none。导入、重试、补时间、更正均不扣库存、不退款，也不能把历史记录转为普通预留菜单。先read_diet_records取最新库存revision与已有recordId；同一来源/日期沿用稳定record.id，重试沿用operationId。新记录需date/title/confirmation/meals，更正可省略未改顶层字段；提供meals或supplements数组会替换该数组，先读完整原文再更正。final_plan只表示敲定菜单，不代表已吃；reported_completed仅用户明确报告完成，partial_report保留部分事实。quantity可显示计划份量，但actualQuantity只存明确实际量，未报告用null；明确按原计划执行的实际量可用confirmed_plan_portion。补给只说吃了没报剂量，不能把plannedQuantity抄入actualQuantity。计划/实际时间分别保存，缺失null；历史不存在库存的食物照名保存。旧Chat营养估算source=estimate，截图document只能证明终稿，不能证明实际吃过。保存完整原文、来源引用、缺失宏微营养null。单record或records最多31条原子导入，失败整批不保存。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, record: historyRecord, records: { type: 'array', minItems: 1, maxItems: 31, items: historyRecord } }, required: ['operationId', 'expectedRevision'], oneOf: [{ required: ['record'] }, { required: ['records'] }] }, annotations: mutationAnnotation },
  { name: 'read_diet_records', title: '读取每日菜单、实际三餐和补给',
    description: dailySupplementInstructions + dailyFoodRollupInstructions + '读取完整菜单、实际原话或审计时使用；已有菜单局部修改优先read_food_plan_edit_context与patch_food_plan，不必读取整天原文。首次整天排餐先读read_food_inventory的最新完整库存、习惯及通用补给安排；有现有菜单需要修改时read_food_plan_edit_context已返回目标事实和全部习惯，不为小改读取本工具的整天全文。只有核对完整剂次、原话、审计或历史才按date/recordId定向读本工具，不无日期批量拉多天记录。补给daily/optional/as_needed/label_pending区分每日、可选、按需、标签待核；scheduled不是已服，旧日勾选不复制到今天。未安排可选项不计计划营养，明确实际服用才计入。顶层dailyNutritionSummaries与网页共用每日汇总：basis区分最终计划/草稿/实际依据，totals的value在partial=true时只是已知部分，不能冒充全天总量；estimated/source保留估算来源，supplementPartial单独说明补给缺项。默认最新保存的全天菜单作为未完成餐营养汇总依据，不要求逐餐打卡；有变化再更正，不伪造实际吃完、服用或时间。已完成餐采用实际营养快照；改计划、库存标签或备注总数不会自动改旧actual，缺项用record_meal_intake.nutritionCorrections明确修正，再核回执nutritionSummary，不将备注冒充首页已修复。每日汇总按本页记录日期返回，dailyNutritionSummariesTruncated时缩小日期范围；issues截断时查看原记录。列表有分页，truncated不是完整原文；大记录使用recordId读取text，按nextOffset继续并依offset拼接JSON文本，顶层汇总不属于被拼接的text。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      planId: identifier, recordId: identifier, cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 },
      summaryOnly: { type: 'string', enum: ['daily_food'], description: '仅需全天合并食物、总用量和四项营养时使用；需单日date或planId/recordId，cursor/limit分页食物行。避免重读各餐、补给及历史长原文。' },
      expectedRevision: { type: 'integer', minimum: 0, description: '全天明细续页沿用第一页revision，避免混合改餐前后份量。' },
    } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'save_food_plan_draft', title: '保存Chat制定的三餐与补给草稿',
    description: dailySupplementInstructions + dailyFoodRollupInstructions + "首次建立一天或用户明确整天重排使用；已有小改优先patch_food_plan。保存后当天立即可见且可编辑，不需要确认才能查看、改餐、记实际或打卡补给。菜单保存、采用、修改均不预留或扣库存。复用同日期canonical planId及meal/line/dose ID，不抄写或清空已有actual，服务端保留事实。Chat依据最新完整库存及全部有效习惯排餐，计划时间可空，午晚餐混合备餐再分配不多扣。每餐食物与补给独立；有库存ID用原ID，只有不逐项盘点的常备品可itemId=null且name/unit/nutrition明确，不以改名绕过缺货。kcal/P/C/F要有明确basisAmount/basisUnit，标签才label，工作估值estimate并写依据，未知null不填0。补给须已有ID并参考通用时间表，daily/optional/as_needed/label_pending及scheduled保留，可选按需由用户决定，不因有货全部强制吃。物理剂量未知null，已知1粒但IU待核仍留1粒，不把成分mg当余量。不能复制旧日已服状态或时间。用户明确吃完后才record_meal_intake：可逐餐，或meals[]原子记录全天。",
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision,
      plan: { type: 'object', additionalProperties: false, properties: {
        id: identifier, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, title: { type: 'string', minLength: 1, maxLength: 160 },
        timeZone: { type: 'string', maxLength: 100 }, notes: text, meals: { type: 'array', minItems: 1, maxItems: 12, items: meal }, supplementDoses: { type: 'array', maxItems: 32, items: dose },
      }, required: ['id', 'date', 'title', 'meals'] },
    }, required: ['operationId', 'expectedRevision', 'plan'] }, annotations: mutationAnnotation },
  { name: 'confirm_daily_food_plan', title: '采用当前菜单，库存不变',
    description: "兼容旧聊天的菜单采用动作，只表示用户认可当前菜单。保存菜单已经立即可见，本操作不是查看、编辑或记录实际的前置条件；confirmed=true不代表已吃。绝不预留、扣除或退回食物库存。已有实际食物、完成状态、补给、原话和时间保留。用户报告实际吃完用record_meal_intake，不用consume重复扣；旧历史已扣账保留原credits，实际结算只调差量。",
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, confirmed: { type: 'boolean', const: true } }, required: ['operationId', 'expectedRevision', 'planId', 'confirmed'] }, annotations: mutationAnnotation },
  { name: 'revise_food_plan', title: '调整剩余餐次或重新分配午晚餐',
    description: "兼容整餐替换；小改优先read_food_plan_edit_context+patch_food_plan。只更新传入稳定meal/dose ID的planned字段，保存后立即显示；其余餐和补给、实际事实保留，库存变化为0。草稿和已采用菜单均可编辑。已有实际的餐也可改计划，但更正实际必须record_meal_intake correct，不覆盖事实。allocationOnly仅表示全天同量重新分配，不改补给；实际食物或总量变化不能谎称重分餐。",
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, confirmed: { type: 'boolean', const: true }, allocationOnly: { type: 'boolean' }, meals: { type: 'array', maxItems: 12, items: meal }, supplementDoses: { type: 'array', maxItems: 32, items: dose } }, required: ['operationId', 'expectedRevision', 'planId', 'confirmed'] }, annotations: mutationAnnotation },
  { name: 'record_meal_intake', title: '记录三餐实际食物时间和同次补给',
    description: "仅记录用户明确已吃的食物，不要求先确认菜单。单餐用mealId；全天一次汇报用meals[]逐项列稳定mealId，各项mode/entries/matchesPlannedFood/原话及实际时间独立，整批原子保存，不能同时传顶层mealId或进食字段。已按当前菜单吃完用mode=complete matchesPlannedFood=true，服务端按稳定计划行生成实际ID；未来会执行不等于吃完。与计划不同提供真实entries，已录条目省略保留；明确没吃可记0，未知数量null，不猜时间。重复提交、重复完成不重复扣；实际correct复用原entry.id，按差量结算并保留旧值审计。旧历史已有预扣credits用于抵扣，不重新扣同一量。单餐可supplements[]原子保存明确已服剂次，吃完饭不推断补给已服；全天批量不猜随哪餐。无法可靠结算保留原话及pending提示，不声称成功扣账。实际营养缺项用nutritionCorrections按既存entryId+来源独立更正（不与meals/entries/supplements/actualTime等混用，mode省略或correct），只改营养快照不改实际数量或库存；fromPlannedLineId/完整nutrition/本actual的gramsPerUnit可核算标签或实称，不能把全天总数反推单项。回执nutritionSummary与网页共用。",
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, mealId: identifier, meals: { type: 'array', minItems: 1, maxItems: 16, items: mealReport }, ...report, nutritionCorrections: { type: 'array', minItems: 1, maxItems: 100, items: actualNutritionCorrection }, matchesPlannedFood: { type: 'boolean' }, supplements: { type: 'array', maxItems: 100, items: doseReport } }, required: ['operationId', 'expectedRevision', 'planId'], oneOf: [{ required: ['mealId'], not: { required: ['meals'] } }, { required: ['meals'], not: { required: ['mealId'] } }] }, annotations: mutationAnnotation },
  { name: 'record_supplement_intake', title: '记录实际服用的补给剂次与时间',
    description: '按稳定doseId记录用户明确服用的补给，保留实际时间与原话，先读当天记录。页面勾选与Chat共用actualEntries：已有服用记录时，补报时间或原话只传actualTime/actualTimeText/sourceText，不新增entries、不再次matchesPlannedDose；更正用量需复用既有实际entry.id及mode=correct，只有用户明确另外服用一剂才append新entry。简单确认已服可调用set_supplement_check幂等设置。换到午饭后服用仍沿用同一剂次；不能因为移动时间多记一剂。用户未明确服用不默认已服；厂家标签用法不是用户实际用量。只有尚无实际条目且明确按计划剂量服用才matchesPlannedDose=true。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, ...doseReport.properties }, required: ['operationId', 'expectedRevision', 'planId', 'doseId'] }, annotations: mutationAnnotation },
  { name: 'set_supplement_check', title: '勾选或撤销当天补给实际服用',
    description: '仅当前用户明确已服或撤销该剂次服用报告时调用，先读当天当前菜单与revision，按稳定planId/doseId设置checked。checked=true属于实际服用报告：已记录服用则不重复；有明确计划剂量按该份量记录，plannedQuantity=null仍保存实际量未知，不猜剂量或服用时间。checked=false明确撤销该剂次全部实际用量为0，保留原条目更正历史并按差量结算；不能从未打卡推断未服。只改该剂次，不影响其它补给/餐次；需具体实际量或时间改用record_supplement_intake。可选/按需项由用户决定，不能当每日必服。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, doseId: identifier, checked: { type: 'boolean' } }, required: ['operationId', 'expectedRevision', 'planId', 'doseId', 'checked'] }, annotations: mutationAnnotation },
  { name: 'set_daily_supplement_check', title: '按日期勾选或撤销补给，无需三餐菜单',
    description: dailySupplementInstructions + '只在当前用户明确已服或撤销该日该剂次报告时设置checked。date必须用户明确的YYYY-MM-DD，doseId用通用时间表或当天记录的稳定ID；已有当天剂次沿用，不创建重复账。无菜单时仅首次明确勾选才保存当日纯补给记录，库存只按本次实际剂次结算，不预留整张通用时间表。checked=true幂等，已知物理份量沿用，未知量保持null；checked=false保留更正审计，不因空白勾选推断未服。实际时间未报不猜，补报量/时间用原canonical planId和record_supplement_intake，不复制actual另建。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, doseId: identifier, checked: { type: 'boolean' } }, required: ['operationId', 'expectedRevision', 'date', 'doseId', 'checked'] }, annotations: mutationAnnotation },
  { name: 'save_supplement_routine', title: '将认可的补给安排保存为每天通用时间表',
    description: '用户明确认可固定通用安排后confirmed=true，从sourcePlanId对应的已确认且含补给的计划保存通用时间表。只保存安排字段，不复制actual、勾选、实际时间或审计，不扣库存，也不改其它日期事实。之后任意日期可按这张时间表查看、独立勾选，不需要先让Chat生成三餐；新日期不沿用旧日服用状态。要修改通用安排，先在来源当天按稳定doseId调整并获得用户认可，再调用本工具；可选/按需项目不能变成每日必服。仍须结合训练/休息标记与当日要求。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, sourcePlanId: identifier, confirmed: { type: 'boolean', const: true } }, required: ['operationId', 'expectedRevision', 'sourcePlanId', 'confirmed'] }, annotations: mutationAnnotation },
  ...[
    ['cancel_daily_food_plan', '取消尚未执行的整天菜单', '仅当前用户明确取消且没有任何实际进食/服用记录时退回整天未用预留。有实际记录时会拒绝，改用cancel_remaining_food_plan。'],
    ['cancel_remaining_food_plan', '取消未吃的剩余餐次与未服补给', '当前用户明确停止剩余计划后，只退尚未使用的预留，保留已吃食物与已服补给，不把整天退款。'],
  ].map(([name, title, description]) => ({ name, title, description,
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...revision, planId: identifier, confirmed: { type: 'boolean', const: true } }, required: ['operationId', 'expectedRevision', 'planId', 'confirmed'] }, annotations: mutationAnnotation })),
];
