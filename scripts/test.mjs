import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
// Public-English behavior is the suite baseline even when this checkout's UI is Chinese.
// Locale-specific tests use their own child processes to verify both presentations.
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, PANTRY_UI_LANGUAGE: 'en' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
