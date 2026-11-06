# Verification

The deployment-language update was checked on 2026-11-06 using Node.js 24.

- All 885 regression tests passed, without failures or skips.
- TypeScript checks passed.
- The test runner pins English for existing interface regressions. Fresh-process Chinese and English rendering tests verify navigation, recipe portion controls, the inventory picker, calendar dates, units and storage labels. The private default is Chinese; the public export explicitly sets English.
- Authored English interface and MCP copy passed the automated check; the Chinese localization dictionary and legacy data-protocol keys are documented exceptions.
- Public export checks passed with synthetic demo seeds and no private hosting identity or runtime data.
- Existing accounting, actual-intake, draft preservation, recipe portion and concurrency tests remain active.
- Normal 17-food preparation details fit the existing transport budget. The 77-item inventory fixture fits the existing 96,000-character budget; full original text remains available through item detail reads.

The language tests use synthetic in-memory menus and check that rendering preserves every inventory field, original source text and actual-intake record. No production food, stock or health record is inserted or changed by these tests. Browser checks, deployment and the external project submission are separate release steps; this document does not claim their completion.

The GitHub Checks workflow reruns the English-copy check, tests, type checking and build on pushes and pull requests. Check the specific commit's status for its remote result.
