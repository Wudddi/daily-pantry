# Architecture

Each date has a canonical plan ID. Meals, planned ingredient lines, actual entries and supplement doses have stable IDs. Planned edits cannot overwrite reported actual facts. The daily projection combines the latest menu with actual records and compatible legacy nested drafts, so supplement-only records cannot hide the food menu.

## Accounting

- Menu save, adoption and editing do not reserve or consume stock.
- Personal food checks are reminders, independent of actual intake.
- Actual commands compare cumulative intake with existing `accountedDebits` and apply only the difference.
- Optional elapsed-day settlement records a menu-based assumption without inventing user-reported intake times. Explicit actual corrections take priority.
- Ordinary food shortages preserve the full intake, keep physical stock at zero, and record the shortfall. Corrections absorb shortfalls before returning genuinely withdrawn stock.
- Unit ambiguities, unavailable food and changed count baselines remain reviewable per item. Independent foods can still settle. Supplements have a separate accounting scope.

## Storage and reads

Inventory and health use separate user-isolated R2 JSON objects. Commands validate an expected revision and write conditionally with an ETag. Persistent credits, stable actual IDs and operation fingerprints prevent retries from creating duplicate consumption. They must not be deleted as disposable debug logs.

Initial assistant reads provide complete current preferences and inventory in bounded pages. Small edits use meal-scoped contexts and stable ID patches. Large original labels and historical records are read by exact ID and offset. UI and tool receipts share nutrition aggregation.

Targeted meal, intake-draft and record reads expose `personalCheckContext` as advisory selection. It keeps canonical source meal/line IDs separate from display placement and labels checkmarks as non-evidence. Chat combines the latest selection with the user's explicit report or settlement request and existing actual entries and credits; checkmarks alone never initiate settlement. Automatic settlement and familiar-meal reference selection remain independent of these reminders.

The public source export excludes production identity and data. There is no SQL migration requirement; fictional demo seeds initialize only a new user's empty storage. Existing users retain their stored records. Hosting-specific authentication and unattended scheduling require their own trusted integration. History partitioning is planned, not yet implemented.

## Recipe portions and additions

Named recipe groups reference stable planned ingredient-line IDs rather than creating another food or stock object. A server-owned one-portion basis supports absolute half, whole and custom portions. Moving a fraction of a dish uses each ingredient's remaining quantity, preserving daily totals, distinct same-SKU lines and actual-intake anchors.

The inventory picker appends a standalone planned line with a frozen nutrition snapshot. A valid saved intake draft keeps its entered quantities and transfers while its plan baseline is rebased under a version check. A stale draft remains stale. Portion changes, transfers and menu additions do not report eating or debit stock.
