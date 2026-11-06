# Changelog

This log records application changes. Private inventory, health records and audit events are not release notes and are not published here.

## 2026-11-06

- Added whole-recipe half, whole and custom portions with an absolute ingredient basis.
- Added transfers of a fraction of a recipe's remaining ingredients between meals, preserving daily totals and dish grouping.
- Added a searchable inventory picker to each meal, with quantity entry and nutrition preview.
- Preserved saved intake drafts when adding food; planning actions remain stock-neutral.
- Added English source copy, project documentation and demo materials, plus a Chinese UI for the owner's private instance. Public exports default to English; both interfaces use the same calculations and accounting. Existing stored units and original user records remain backward compatible.
- Localized displayed units and storage labels without changing saved identifiers. Public export enforces its English default while preserving the private Chinese configuration.
- Added a repeatable checked public-source export, an English copy check, GitHub CI and a standing release process that preserves public commit history.
- Kept canonical calendar keys independent of display language so Chinese meal and training views always receive valid YYYY-MM-DD dates.
- Clarified that checklist calories describe planned food only, while daily nutrition uses reported intake, retained menu portions and counted supplements. Added a read-only comparison for actual-food adjustments, supplement calories and incomplete or historical evidence; personal checks and stock accounting are unchanged.
- Added preview-and-apply food-plan sync. Supported completed meals align to existing actual food, amounts and frozen nutrition; partial meals retain unreported planned food. Unreported meals, actual history, personal checks, supplements, stock and prior accounting remain unchanged.
- Sync previews retain reliable recipe links and warn before removing ambiguous groups. Unsupported meals are left unchanged while independent supported changes can proceed. A pending intake draft requires review, and revision/fingerprint checks plus stable retries prevent stale or duplicate updates.
- Removed the redundant daily-nutrition comparison panel from the checklist. Planned-food labels, checked and unchecked plan totals, and explicit plan sync remain; nutrition calculations and inventory accounting are unchanged.
- Added actual-recipe groups tied to exact reported entry IDs, independent of planned recipes. Two dishes can share an ingredient without moving that ingredient into the wrong dish; unanchored reports stay separate instead of inheriting a recipe from a matching food name or SKU.
- Actual recipes retain their own portion labels and collapsed ingredient lists. Metadata-only grouping preserves original intake, frozen nutrition, personal checks, supplements and stock accounting; plan sync carries proven actual membership into the corresponding planned rows.
- Added a reserved actual-recipe metadata adapter to the existing menu-patch tool for clients with cached tool catalogs. It accepts one isolated grouping patch, validates exact actual-entry membership and retains planned recipes, intake, pending drafts and stock accounting.
- Added saved meal arrangement for individual foods and whole recipes, including checked reminders and already reported food. Arrangement preserves the original food rows, quantities, reports, sources, nutrition snapshots and stock accounting, and keeps pending intake drafts unsubmitted.
- Arranged meal views place each original nutrition contribution exactly once. Proven actual links follow a moved planned row; unrelated reports never move merely because they share a product. Split recipe fragments do not claim the whole recipe's portion, and personal checks keep their original source identities.

## 2026-11-02

- Added named, expandable recipe groups to meal overviews, checklists and nutrition details.
- Preserved ingredient-level quantities, snapshots, actual records and independent side foods.

## 2026-11-01

- Protected later physical inventory counts from historical automatic settlement.
- Kept accounting issues isolated by ingredient and retained differential settlement and retry safety.

## 2026-10-22

- Separated saving and adopting menus from reporting actual intake and stock consumption.
- Preserved food menus when supplements are checked or reported.
- Added shared projection of legacy nested drafts without rewriting original intake or accounting history.
