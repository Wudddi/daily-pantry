# Daily Pantry · 每日库存

A personal food inventory and meal-planning app with a Model Context Protocol (MCP) interface. It helps an AI assistant plan meals from current inventory and saved preferences, while keeping menus, actual intake, supplements, and stock accounting separate. The interface is primarily in Simplified Chinese.

This is a sanitized copy of an actively used personal project. **All bundled food and body-measurement seed data is fictional.** Production records, private logs, credentials, hosting identity and the original Git history are excluded.

## Features

- Inventory categories, storage, explicit freshness facts and nutrition sources.
- Immediately visible, editable daily menus with meal nutrition and combined daily ingredient totals.
- Compact checklists and redistribution of ingredients between meals.
- Independent supplement routines and actual dose records.
- Stable IDs, revision checks, conditional writes and differential accounting to prevent duplicate consumption.
- Per-item food shortage handling, correction history and preserved unknown values.
- Bounded MCP reads and targeted edits that retain complete current preferences.
- Weight trends and training records, with missing dates left unfilled.

Saving, adopting or editing a menu does **not** consume inventory. Personal food checkmarks are reminders. Explicit actual-intake reports and an optional end-of-day policy have separate accounting semantics. Meal completion does not imply supplement use.

## Local development

Use Node.js 24 and pnpm 11.25.0. No production credentials are needed.

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Open the loopback address printed by the server (normally `http://localhost:5173`). On that origin, visit `/signin-with-chatgpt?return_to=/` to enter the starter's development-only mock identity. Local emulator records live under ignored `.wrangler/` state. Use fictional data for demonstrations and recordings.

```sh
pnpm test
pnpm typecheck
pnpm build
```

`pnpm start` previews the built Worker locally; hosted sign-in is platform-owned and is not simulated by that command. Use `pnpm dev` for the complete local demo. See [starter reference](docs/starter-reference.md) for framework details.

## Stack and structure

React 19, TypeScript, Vinext/Vite, Cloudflare Workers and R2. The `/mcp` endpoint exposes validated JSON-RPC tools. Pure JavaScript domain modules are exercised with Node's test runner.

| Path | Purpose |
| --- | --- |
| `app/` | UI, API and MCP routes |
| `lib/inventory.mjs`, `lib/diet.mjs` | Validation, commands and accounting |
| `lib/*-read.mjs`, `lib/*-context.mjs` | Bounded assistant reads |
| `lib/*-store.ts` | User-isolated storage and concurrency |
| `lib/seed-*.json` | Fictional demo data |
| `tests/` | Synthetic regression fixtures |

See [architecture](docs/architecture.md), [accounting rules](docs/daily-menu-accounting-v2.md), and [project overview](docs/project-overview.md).

## Deployment and boundaries

`.openai/hosting.json` is an identity-free template. A separate hosted instance needs its own project, `BUCKET` R2 binding and trusted authentication layer. Never reuse another instance's project identity or expose a server that trusts arbitrary client-supplied identity headers. The mock identity is only for loopback development.

Current storage reads and writes one JSON object per user with revision and ETag checks. Partitioning older history away from current state is planned work. Unattended day-end settlement needs an external trigger; the browser is not an always-running scheduler. Its default policy timezone is `America/Toronto` and must be reviewed for a new instance.

Nutrition values retain their label, recipe or estimate provenance. Unknown values are not silently zero; the app does not prescribe a supplement regimen.

## Development provenance

Developed iteratively with **Codex/ChatGPT** from the owner's requirements and feedback, on a Vinext/Cloudflare Sites starter. This repository does not claim a Claude Code development history or approval by an external program. It starts with a new sanitized history. Included third-party notices remain under `build/` and `vendor/`.

This repository is shared for project review. No open-source license for project-specific code is granted by this README; included third-party files retain their own licenses.
