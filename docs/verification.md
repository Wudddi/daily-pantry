# Verification

The English release was checked on 2026-11-06 using Node.js 24.

- All 880 regression tests passed, without failures or skips.
- TypeScript checks passed.
- Authored English interface and MCP copy passed the automated check; legacy data-protocol keys are exempt and documented.
- Public export checks passed with synthetic demo seeds and no private hosting identity or runtime data.
- Existing accounting, actual-intake, draft preservation, recipe portion and concurrency tests remain active.
- Normal 17-food preparation details fit the existing transport budget. The 77-item inventory fixture fits the existing 96,000-character budget; full original text remains available through item detail reads.

The desktop browser controller could not reliably identify the current Windows browser URL, so it stopped before interactive English-release QA. This release therefore relies on component interaction tests, static rendering checks, type checking and the production build; no new browser screenshot is claimed. The external Alignerr form was not edited or resubmitted through that stopped controller.

The GitHub Checks workflow reruns the English-copy check, tests, type checking and build on pushes and pull requests. Check the specific commit's status for its remote result.
