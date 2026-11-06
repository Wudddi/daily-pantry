# Changelog

This log records application changes. Private inventory, health records and audit events are not release notes and are not published here.

## 2026-11-06

- Added whole-recipe half, whole and custom portions with an absolute ingredient basis.
- Added transfers of a fraction of a recipe's remaining ingredients between meals, preserving daily totals and dish grouping.
- Added a searchable inventory picker to each meal, with quantity entry and nutrition preview.
- Preserved saved intake drafts when adding food; planning actions remain stock-neutral.
- Converted application copy, project documentation and demo materials to English. Existing stored units and original user records remain backward compatible.
- Added a repeatable checked public-source export, an English copy check, GitHub CI and a standing release process that preserves public commit history.

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

