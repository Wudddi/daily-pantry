# Daily Pantry maintenance

The owner uses the Chinese interface in the private Sites instance. The public GitHub edition defaults to English. Both editions share the same domain and accounting code. Author new interface and accessibility text as English source keys and provide its Chinese translation in `lib/ui-zh-CN.json`; keep MCP titles/descriptions, public documentation and development notes in English. The private `lib/ui-language-config.json` selects `zh-CN`; `export:public` always writes `{ "language": "en" }` into the public checkout. Do not copy the private language default unchanged to GitHub.

Preserve user-authored records in their original language. Persisted legacy unit/storage keys and compatibility recognition fixtures may contain Chinese; localize their display labels, never rewrite stored facts to change interface language. Unit/storage labels follow the selected interface, while nutrition and accounting use the original saved identifiers. `scripts/test.mjs` pins the shared regression suite to English; locale-specific tests independently verify both interfaces.

## Required release workflow

For every authorized functional change, complete the relevant tests and typecheck, then publish the owner-private Sites instance using the Sites workflow. Preserve its existing access policy and automatic-settlement setting. Never use production intake or stock changes as test fixtures.

Also sync the reviewed source to the owner's public GitHub repository, `Wudddi/daily-pantry`, during the same task unless the user explicitly requests local-only work or no publication. This is a standing user request. A successful private deployment alone does not complete a release.

1. Update `CHANGELOG.md` with concrete, real behavior changes in English. Do not create empty/cosmetic commits to simulate activity or invent historical commits.
2. Run `npm test`, `npm run typecheck` and `npm run verify:english` after material code changes. Build through the Sites packaging workflow.
3. Run `npm run export:public -- --out <absolute-public-checkout>` to export only allowed source, synthetic seed data, identity-free hosting configuration and the public English language default. Run its privacy verification and review the diff. Keep the private UI set to Chinese. Never copy `.git`, real runtime records, private logs, credentials or private Site identity to GitHub.
4. Read GitHub's current `main` head. Use the connected GitHub tools to commit changed export files with that existing head as parent, and update the branch with an expected-head check and no force. Preserve the current public history. Do not push the private repository's Git history.
5. Verify the resulting public commit and CI status. Report the private deployment, public commit and any incomplete external submission separately. An unavailable external form must not be described as submitted.

The export script is the repeatable preparation step; the connected GitHub operation performs the authenticated upload. It does not require storing a GitHub token in this checkout or leaving a background scheduler running. Sync code changes, not every personal inventory edit.
