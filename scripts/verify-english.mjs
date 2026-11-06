import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// English source keys/tool copy are shared by both editions. Chinese translations
// live only in the explicit locale dictionary; private data is not part of this check.
const legacy = new Set(['袋', '个', '片', '份', '包', '罐', '条', '粒', '滴', '冷冻', '冷藏', '常温']);
const languageConfig = JSON.parse(fs.readFileSync('lib/ui-language-config.json', 'utf8'));
if (!languageConfig || typeof languageConfig !== 'object' || Array.isArray(languageConfig)
  || Object.keys(languageConfig).some(key => key !== 'language') || !['en', 'zh-CN'].includes(languageConfig.language)) {
  throw new Error('Invalid UI language configuration; expected en or zh-CN.');
}
const dictionary = JSON.parse(fs.readFileSync('lib/ui-zh-CN.json', 'utf8'));
if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)
  || Object.entries(dictionary).some(([key, value]) => typeof value !== 'string' || /\p{Script=Han}/u.test(key) && !legacy.has(key.trim()))) {
  throw new Error('The Chinese locale dictionary must map English source keys to text.');
}
const files = [];
function walk(dir) {
  for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, file.name);
    if (file.isDirectory()) walk(name);
    else if (/\.(?:tsx|ts)$/.test(name) && (dir.startsWith('app') || /-mcp\.ts$/.test(name))) files.push(name);
  }
}
walk('app'); walk('lib');
const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if ((ts.isStringLiteralLike(node) || ts.isJsxText(node) || [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) && /\p{Script=Han}/u.test(node.text) && !legacy.has(node.text.trim())) {
      const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      failures.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
if (failures.length) throw new Error('Non-English authored UI/tool copy at:\n' + failures.join('\n'));
console.log(`English source/tool copy verified in ${files.length} files; configured UI: ${languageConfig.language}. Locale dictionaries and legacy wire keys are retained.`);
