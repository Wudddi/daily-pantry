# Daily Pantry maintenance

The owner uses the English edition of this app. Keep new interface copy, accessibility labels, MCP titles/descriptions, documentation and development notes in English. Preserve user-authored records in their original language. Persisted legacy unit/storage keys and compatibility recognition fixtures may contain Chinese; translate their display labels, never rewrite stored facts to translate the interface.

## Required release workflow

For every authorized functional change, complete the relevant tests and typecheck, then publish the owner-private Sites instance using the Sites workflow. Preserve its existing access policy and automatic-settlement setting. Never use production intake or stock changes as test fixtures.

Also sync the reviewed source to the owner's public GitHub repository, `Wudddi/daily-pantry`, during the same task unless the user explicitly requests local-only work or no publication. This is a standing user request. A successful private deployment alone does not complete a release.

1. Update `CHANGELOG.md` with concrete, real behavior changes in English. Do not create empty/cosmetic commits to simulate activity or invent historical commits.
2. Run `npm test`, `npm run typecheck` and `npm run verify:english` after material code changes. Build through the Sites packaging workflow.
3. Run `npm run export:public -- --out <absolute-public-checkout>` to export only allowed source, synthetic seed data and identity-free hosting configuration. Run its privacy verification and review the diff. Never copy `.git`, real runtime records, private logs, credentials or private Site identity to GitHub.
4. Read GitHub's current `main` head. Use the connected GitHub tools to commit changed export files with that existing head as parent, and update the branch with an expected-head check and no force. Preserve the current public history. Do not push the private repository's Git history.
5. Verify the resulting public commit and CI status. Report the private deployment, public commit and any incomplete external submission separately. An unavailable external form must not be described as submitted.

The export script is the repeatable preparation step; the connected GitHub operation performs the authenticated upload. It does not require storing a GitHub token in this checkout or leaving a background scheduler running. Sync code changes, not every personal inventory edit.
