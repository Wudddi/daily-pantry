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
