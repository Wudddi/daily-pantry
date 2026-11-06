# Daily menus, actual intake and stock accounting

## Original coupling and the current contract

The former `set_daily_supplement_check` action converted an existing food draft to `reserved + supplementOnly`, cleared its top-level `meals`, and kept the four meals under `.draft.meals`. The daily summary then filtered out `supplementOnly`, hiding a menu that still existed. The former `commit_meal_plan` also combined adopting a menu with reserving stock. The current contract separates menus, reported facts and accounting.

| Operation | Current menu | Actual facts | Inventory |
| --- | --- | --- | --- |
| `save_food_plan_draft` | Save and display immediately; include in planned nutrition | Preserve | Unchanged |
| `patch_food_plan` / `revise_food_plan` | Merge only explicitly supplied planned fields at stable IDs | Preserve | Unchanged |
| `confirm_daily_food_plan` | Compatibility action meaning adoption only | Does not imply eating | Unchanged |
| `record_meal_intake` | Preserve the menu for comparison | Save reported foods, completion and quantities | Difference between actual target and existing settled credit |
| Actual `correct` | Preserve | Reuse entry ID and retain the prior audit snapshot | Difference only |
| Supplement check or intake report | Preserve meals, dates, food accounting and pending issues | Save that dose independently | Supplement difference only |
| Read, date change or refresh | Read only | Do not create facts | Unchanged |

Single-meal reports continue to use `mealId`. A whole-day report can use `record_meal_intake.meals[]`, with at most 16 meals. Each member supplies its own `mealId`, actual contents or `matchesPlannedFood`, completion and reported time. A batch cannot mix in top-level single-meal fields. Completing food never implies taking supplements.

## Storage and compatibility

Runtime records are **user-isolated JSON objects in R2**, not SQL rows. The D1 binding in `.openai/hosting.json` remains `null`; `db/schema.ts` is unchanged. Top-level `schemaVersion: 1` is retained. There is no D1 migration, whole-store backfill or automatic stock recalculation.

New structured menus receive server-owned `foodAccounting: "actual_only"` and `supplementAccounting: "actual_only"`. Clients cannot submit these fields to bypass settlement. Legacy `status: "reserved"` remains readable and does not establish that a meal was eaten.

For legacy `supplementOnly + .draft.meals` records, shared read-only `projectCurrentDietPlan` projects the current view. Only planned fields come from the draft; actual entries, completion, times, report history and accounting come from the canonical record. The website, daily summary and edit context share this rule. Reads do not persist a migration. The next explicit edit saves current planned fields under the original ID and preserves actual facts.

Existing `accountedDebits` are not automatically refunded, zeroed or charged again. The first plan edit freezes prior reservation semantics in `legacyReservations`; later actual intake uses those original credits. Legacy flat records remain readable and support same-ID retries and explicit cancellation. New legacy-style `commit_plan` calls are rejected so old clients cannot create new advance debits.

Legacy Chinese unit and storage enum values remain accepted for stored-record compatibility. English labels are a presentation concern; they do not rewrite the inventory's physical units or the user's original records.

## Idempotency and concurrency

- Reuse the canonical `planId` for a date, including after closing or cancelling. Do not create a new accounting identity for the same day. Keep meal, food-line, dose and actual-entry IDs stable.
- Retain operation-ID idempotency, stable actual-ID conflict checks and deterministic IDs for `matchesPlannedFood`.
- Actual corrections reuse an existing entry ID, retain history and settle the cumulative actual target against `accountedDebits`.
- R2 writes use `expectedRevision` and ETag conditional writes. A conflicting submission is rejected as a whole, without partial debits.
- Supplement accounting has its own scope. A supplement check does not resettle food or retry unresolved food accounting.

## Display and migration boundaries

Current menus, completed and incomplete meals, actual supplements and daily nutrition can be viewed together. Completed meals use actual nutrition snapshots; incomplete meals use the current planned menu. Incomplete does not mean uneaten. Planned supplement nutrition and reported use are separate.

When a reliable frozen grams-per-unit value exists, package units can be presented in grams. Drink volumes are displayed in mL. Presentation conversion does not change the underlying stock unit. Without a known package weight or density, retain the original unit rather than inventing a g/mL conversion.

Old balances may include historical reservations, so deployment does not trigger batch refunds. If a later physical count changes a credit's quantity baseline or unit, preserve the actual report and mark the affected accounting for review. Do not refund automatically or report success without evidence. Rolling back only the frontend could reintroduce advance-debit semantics; retain the server contract.

## Verification

Synthetic regression fixtures cover immediate four-meal draft display; menu and ID preservation after supplement checks; stock-neutral saves, adoption and edits; single-meal and whole-day actual reports; retry safety; differential corrections; independent supplements; nested legacy drafts; old credits; recount conflicts; dates and reads; frontend meal states; and g/mL display. Legacy fixtures explicitly exercise their historical contract rather than pretending to be newly created menus.

Production records may be read for verification. Tests do not insert fabricated production meals or replay historical consumption. An application release changes code, not recorded intake.

## Day-end differences after a physical count (2026-11-01)

Day-end settlement retains stable date and meal IDs. It reads the latest saved menu before first settlement, gives explicit actual reports priority, and credits existing `accountedDebits`. If 60 g of actual intake is already settled and the final target is 100 g, only the remaining 40 g is charged. Editing the menu itself is stock-neutral; repeating day-end settlement does not debit again. Personal checkmarks and supplement intake remain independent.

`quantityBaselineAt` and `quantityBaselineSource` record physical counts, restocking or explicit balance calibration separately. Ordinary intake, nutrition-label and note edits do not advance that boundary. Historical records resolve a baseline only when `quantityBaselineToken` exactly matches its inventory event or calibration audit; do not infer counts from `confirmedAt`, planned times or later entry times. There is no global backfill or historical re-debit.

Historical automatic assumed consumption cannot cross a later confirmed physical balance. If same-day automatic consumption cannot be ordered against the count, only that ingredient waits for review. It is not charged to new stock and does not generate a fabricated shortage. Existing zero-difference credit remains intact. Ordinary same-day actual reports, actual corrections on a matching baseline and established rules after an explicit calibration continue to work. An unknown coverage issue affects only its ingredient; independent settleable ingredients proceed.

This repair does not change `dailyMenuSettlementPolicy.enabled`. A user-disabled policy remains disabled after deployment.

## Named dishes and expandable recipes (2026-11-02)

A meal can save `recipeGroups: [{ id, name, lineIds }]`, for example banana chocolate brownies or Basque cheesecake. `lineIds` reference only that meal's `plannedItems.id`. Ingredient lines, quantities, physical units and nutrition snapshots remain independent; a group is not another inventory or actual-intake item. Ungrouped fruit and drinks remain separate. Grouped and ungrouped portions of the same SKU are not merged for display.

Chat can supply meal `recipeGroups` when creating a menu. A targeted `patch_food_plan.mealPatches[].recipeGroups` replaces the meal's small group array. Omission preserves groups; `[]` clears them. Group IDs remain stable, and each ingredient line belongs to at most one group. Removing an ingredient prunes inherited references and removes empty groups. Explicit references to missing or other-meal lines reject the entire edit.

The checklist, overview and nutrition details show expandable recipe groups. Checking a dish only marks its ingredient reminders; it does not report eating or debit stock. Completed meals group actual foods only through reliable original-line associations. Ambiguous actual foods remain separate. Group metadata edits preserve actuals, nutrition, stock, settled credits, intake-draft fingerprints and automatic-settlement settings.

## Whole-recipe portions, remaining-food transfers and inventory additions (2026-11-06)

`scale_recipe_group` updates all group ingredients using an absolute `targetPortion`. Public `portion` is the current number of portions; server-owned `baseQuantities` stores the one-portion basis and cannot be supplied by clients. Returning from half a portion to a whole portion restores that basis. A manual ingredient edit rebuilds its basis instead of repeatedly multiplying already-halved quantities. Legacy groups treat their saved recipe as one portion. When a saved recipe is explicitly known to already be a half portion, setting only `portion: 0.5` calibrates its basis without changing quantities.

`move_recipe_group` applies one fraction to each ingredient's uneaten remainder. It preserves eaten source lines and creates an independent same-named group with stable ingredient lines in the destination meal. It does not merge same-SKU single items. Daily ingredient totals and nutrition snapshots are conserved. Scaling and transfers edit only plans, retaining actuals, credits, personal checkmarks and stock. Unclear actual associations affect only the relevant group. An existing intake draft is retained and may require review after a recipe change.

Each meal's **Add from inventory** picker uses `add_food_to_meal` to append an available planned food line. It uses the selected food's inventory unit and nutrition snapshot. With a verified grams-per-unit value the UI accepts grams; mL is never treated as g. A valid saved intake draft is version-checked and only its menu baseline is rebased. Its entered consumption, transfers and completion checkmarks are retained, not submitted. A draft that was already stale remains stale. The advanced editor saves local inputs before opening the picker. Additions to completed meals serve as planned comparison; actual nutrition still uses actual entries.

All three actions reuse operation-ID idempotency and revision-checked writes. Recipe transfers retain stable destination IDs; additions retain a stable new line ID. None of these operations changes the automatic-settlement switch.
