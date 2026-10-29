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

Production identity and data are absent. There is no SQL migration requirement; demo seeds initialize only a new user's empty storage. Hosting-specific authentication and unattended scheduling require their own trusted integration. History partitioning is planned, not yet implemented.
