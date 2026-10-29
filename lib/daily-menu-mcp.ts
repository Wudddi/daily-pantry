export const settleDueDailyMenusTool = {
  name: 'settle_due_daily_menus', title: '按已授权午夜规则结算到期菜单',
  description: '用于已开启的每日00:00多伦多后台任务。只结算开启日期后、已经过完的当地日期；读取同日canonical菜单最新保存版本，个人勾选完全不参与判断。明确实际变动优先，历史已扣抵扣，只结算差量；不生成虚假的用户实际进食报告或时间，不自动服用补给。dryRun=true只查看到期状态；false执行用户已开启的规则，关闭或未开启时不写。重复运行不会重复扣减；待核账务如实返回，不能通过新建菜单或重置基线绕过。',
  inputSchema: { type: 'object', additionalProperties: false, properties: { dryRun: { type: 'boolean', default: true, description: 'true只查看到期情况；false执行用户已明确开启的日终规则。' } } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
