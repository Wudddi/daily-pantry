import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Legacy wire values remain stable; this verifies authored UI and tool copy rather than personal records.
const legacy = new Set(['袋', '个', '片', '份', '包', '罐', '条', '粒', '滴', '冷冻', '冷藏', '常温']);
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
console.log(`English UI/tool copy verified in ${files.length} files. Legacy wire keys are retained.`);
