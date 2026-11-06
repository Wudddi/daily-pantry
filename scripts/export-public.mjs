import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const arg = process.argv.indexOf('--out');
if (arg < 0 || !process.argv[arg + 1]) throw new Error('Usage: npm run export:public -- --out <absolute-public-checkout>');
const output = path.resolve(process.argv[arg + 1]);
if (!path.isAbsolute(process.argv[arg + 1]) || output === root || root.startsWith(output + path.sep) || output.startsWith(root + path.sep) || output === path.parse(output).root) throw new Error('Use a separate, explicitly named absolute export directory.');
const allowed = /^(?:app|build|components|db|docs|drizzle|examples|hooks|lib|public|scripts|tests|vendor|\.github)\//;
const rootFiles = new Set(['AGENTS.md','README.md','CHANGELOG.md','.gitignore','.npmrc','cloudflare-env.d.ts','components.json','drizzle.config.ts','eslint.config.mjs','next.config.ts','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','postcss.config.mjs','tsconfig.json','vite.config.ts']);
const selected = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', cwd: root }).split('\0').filter(Boolean);
const files = [...new Set(selected)].filter(name => allowed.test(name) || rootFiles.has(name) || name === '.openai/hosting.json').sort();
const hosting = JSON.parse(fs.readFileSync(path.join(root,'.openai/hosting.json'),'utf8'));
const privateIds = [hosting.project_id, process.env.USERPROFILE, process.env.HOME].filter(value => typeof value === 'string' && value.length > 6);
const contentByPath = new Map();
for (const name of files) {
  if (/^(?:work|outputs|\.git|node_modules|dist|\.wrangler|\.sites-runtime)\//.test(name) || /(?:^|\/)(?:\.env[^/]*|.*\.(?:pem|pfx|key))$/.test(name)) throw new Error('Disallowed export path: ' + name);
  const absolute = path.resolve(root, name);
  if (!absolute.startsWith(root + path.sep) || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Unexpected source path: ' + name);
  let content = fs.readFileSync(absolute);
  if (name === '.openai/hosting.json') content = Buffer.from(JSON.stringify({ d1:null, r2:'BUCKET', capabilities:['mcp'] },null,2) + '\n');
  const text = content.toString('utf8');
  if (privateIds.some(value => text.includes(value) || text.includes(value.replaceAll('\\','/'))) || /(?:toastyacorn\d+|zhiyuan\d+)\.chatgpt\.site|(?:2332899892|zhiyuan5250)@(?:qq|gmail)\.com|C:[\\/]Users[\\/]\d{5}/i.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})/.test(text)) throw new Error('Private identifier or credential detected in ' + name);
  if (/^lib\/seed-.*\.json$/.test(name) && !/fictional|synthetic/i.test(text)) throw new Error('Seed file lacks an explicit synthetic-data notice: ' + name);
  if (!content.includes(0) && Buffer.from(text, "utf8").equals(content)) content = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
  contentByPath.set(name, content);
}
fs.mkdirSync(output, { recursive:true });
// Remove stale managed source files only inside the explicitly selected public checkout; retain its .git/history.
let previous = [];
try { previous = execFileSync('git', ['ls-files','-z'], { encoding:'utf8', cwd:output }).split('\0').filter(Boolean); } catch { /* A new export directory has no Git index. */ }
for (const name of previous) {
  if (contentByPath.has(name) || !(allowed.test(name) || rootFiles.has(name) || name === '.openai/hosting.json')) continue;
  const target = path.resolve(output,name);
  if (!target.startsWith(output + path.sep)) throw new Error('Unsafe stale export path.');
  if (fs.existsSync(target) && fs.lstatSync(target).isFile()) fs.unlinkSync(target);
}
for (const [name, content] of contentByPath) {
  const target = path.resolve(output,name);
  if (!target.startsWith(output + path.sep)) throw new Error('Unsafe export path.');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,content);
}
console.log(JSON.stringify({ files:contentByPath.size, output, privacy:'passed', productionRecords:'excluded', history:'preserved' }));
