import { spawnSync } from 'node:child_process';
const cli = process.env.SITES_PNPM_BIN || process.env.npm_execpath;
if (!cli || !/pnpm/i.test(cli)) throw new Error('Run through the configured pnpm runtime.');
const result = spawnSync(process.execPath, [cli, 'install', '--frozen-lockfile'], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
