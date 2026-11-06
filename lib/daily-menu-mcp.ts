export const settleDueDailyMenusTool = {
  name: 'settle_due_daily_menus', title: "Settle due menus under the enabled day-end policy",
  description: "For the user-enabled 00:00 America/Toronto background task. Settle only completed local dates on/after the start date, using the latest canonical saved menu. Ignore personal checks. Explicit actual changes override plans and historical credits offset only differences. Do not invent user reports, actual times or supplement use. dryRun=true is read-only; false runs only an enabled policy. Disabled/unconfigured policies write nothing. Retries do not double-deduct. Report pending issues. Old menus cannot consume later counted/restocked balances; uncertain coverage blocks only the affected item. Do not bypass by recreating menus, re-reporting the day or resetting baselines.",
  inputSchema: { type: 'object', additionalProperties: false, properties: { dryRun: { type: 'boolean', default: true, description: "True previews due status; false executes only the explicitly enabled day-end policy." } } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
