import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { intakeDraftVersion, intakePlanFingerprint } from '../lib/intake-draft.mjs';

// A small hook host exercises component callbacks and refreshes without a DOM or
// additional test dependencies. JSX remains a React element tree for inspection.
const hooksUrl = 'data:text/javascript;base64,' + Buffer.from(`
let active;
export const createHost=()=>({cells:[],cursor:0,effects:[],changed:false});
export function begin(host){active=host;host.cursor=0;host.effects=[];host.changed=false;}
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
export function useState(initial){const h=active,i=h.cursor++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return[h.cells[i],next=>{const value=typeof next==='function'?next(h.cells[i]):next;if(!Object.is(value,h.cells[i])){h.cells[i]=value;h.changed=true;}}];}
export function useRef(initial){const h=active,i=h.cursor++;return h.cells[i]??=( {current:initial} );}
export function useMemo(fn,deps){const h=active,i=h.cursor++;if(!h.cells[i]||!same(h.cells[i].deps,deps))h.cells[i]={value:fn(),deps};return h.cells[i].value;}
export function useEffect(fn,deps){const h=active,i=h.cursor++,old=h.cells[i];if(!old||!same(old.deps,deps)){h.effects.push(()=>{old?.cleanup?.();h.cells[i]={deps,cleanup:fn()};});}}
export function useId(){const h=active,i=h.cursor++;return ':test-'+i+':';}
export function effects(host){for(const effect of host.effects)effect();}
`).toString('base64');
const hooks = await import(hooksUrl);
let compiled = ts.transpileModule(await readFile(new URL('../app/intake-draft-editor.tsx', import.meta.url), 'utf8'), {
  fileName: 'intake-draft-editor.tsx',
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/import\s+["']\.\/intake-draft-editor\.css["'];?/g, '');
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(
  specifier === 'react' ? hooksUrl : specifier.startsWith('@/') ? new URL('../' + specifier.slice(2), import.meta.url).href : import.meta.resolve(specifier),
));
const { default: IntakeDraftEditor } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const food = { id: 'rice', itemId: 'rice', name: '米饭', quantity: 200, unit: 'g',
  nutritionSnapshot: { name: '米饭', unit: 'g', gramsPerUnit: null,
    nutrition: { basisAmount: 100, basisUnit: 'g', kcal: 100, protein: 2, carbs: 20, fat: 1, source: 'label' } } };
function plan(withDraft = true) {
  const p = { id: 'concurrent-day', format: 'meals_v1', date: '2048-01-02', status: 'draft', title: '并发测试',
    meals: [{ id: 'lunch', slot: 'lunch', title: '午餐', state: 'reserved', plannedItems: [structuredClone(food)],
      actualEntries: [], actualTime: null, actualTimeText: '', reportHistory: [], completionReportedAt: null }],
    supplementDoses: [], inventoryAccounting: 'settled', accountingIssues: [] };
  if (withDraft) p.intakeDraft = { id: 'same-draft-id', baseFingerprint: intakePlanFingerprint(p),
    consumed: [{ mealId: 'lunch', lineId: 'rice', quantity: 10, unit: 'g' }], transfers: [], completedMealIds: [] };
  return p;
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text(node.props?.children) : '';
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && predicate(node)) return node;
  const children = Array.isArray(node) ? node : [node.props?.children];
  for (const child of children) { const found = find(child, predicate); if (found) return found; }
  return null;
}
function mount(initial, stored, mutateResult) {
  const storage = new Map(stored ? [['daily-pantry:intake-draft:' + initial.id + ':' + initial.date, JSON.stringify(stored)]] : []);
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const host = hooks.createHost(), calls = [];
  let props = { plan: initial, items: [], revision: 4, busy: false, error: '', refresh: async () => {},
    mutate: async (action, payload, success) => { calls.push({ action, payload: structuredClone(payload), success }); return mutateResult ? mutateResult(action, payload) : true; } };
  let tree;
  function render(patch = {}) {
    props = { ...props, ...patch };
    for (let count = 0; count < 20; count++) {
      hooks.begin(host); tree = IntakeDraftEditor(props); hooks.effects(host);
      if (!host.changed) return tree;
    }
    throw new Error('hook host did not settle');
  }
  function button(label) { return find(tree, node => node.type === 'button' && text(node).trim() === label); }
  function input() { return find(tree, node => node.type === 'input' && node.props.type === 'number'); }
  render();
  return { render, calls, storage, get tree() { return tree; }, button, input,
    edit(value) { input().props.onChange({ target: { value } }); render(); },
    async click(label) { const target = button(label); assert.ok(target, 'missing ' + label); assert.ok(!target.props.disabled, label + ' is disabled'); target.props.onClick(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('save uses the edit-start cloud content token after an unrelated refresh, not only the shared draft ID', async () => {
  const p = plan(), initialVersion = intakeDraftVersion(p.intakeDraft), editor = mount(p);
  editor.edit('45');
  const refreshed = structuredClone(p); refreshed.supplementDoses = [{ id: 'creatine', status: 'taken' }];
  editor.render({ plan: refreshed, revision: 8 });
  assert.equal(editor.input().props.value, '45');
  const stored = JSON.parse([...editor.storage.values()][0]);
  assert.equal(stored.expectedDraftVersion, initialVersion);
  await editor.click('保存草稿');
  assert.equal(editor.calls.length, 1);
  assert.equal(editor.calls[0].payload.expectedDraftVersion, initialVersion);
  assert.equal(editor.calls[0].payload.draft.consumed[0].quantity, 45);
});

test('a same-ID remote edit blocks save and submit, preserves local input, and local discard never deletes the remote draft', async () => {
  const p = plan(), editor = mount(p); editor.edit('45');
  const changed = structuredClone(p); changed.intakeDraft.consumed[0].quantity = 60;
  editor.render({ plan: changed, revision: 9 });
  assert.equal(editor.input().props.value, '45');
  assert.match(text(editor.tree), /进食草稿已在别处更新/);
  assert.equal(editor.button('保存草稿').props.disabled, true);
  assert.equal(editor.button('记录这些已吃').props.disabled, true);
  editor.render({ plan: structuredClone(changed), revision: 10 });
  assert.equal(editor.input().props.value, '45');
  await editor.click('放弃本机修改'); editor.render();
  assert.equal(editor.calls.length, 0);
  assert.equal(editor.input().props.value, '60');
  assert.match(text(editor.tree), /云端草稿和实际记录均未删除/);
});

test('session-restored edits retain their old token and legacy local copies without a token cannot overwrite cloud data', () => {
  const p = plan(), local = structuredClone(p.intakeDraft), initialVersion = intakeDraftVersion(p.intakeDraft);
  local.consumed[0].quantity = 45;
  p.intakeDraft.consumed[0].quantity = 60;
  const restored = mount(p, { draft: local, inputs: {}, invalidInputs: {}, expectedDraftVersion: initialVersion });
  assert.equal(restored.input().props.value, '45');
  assert.match(text(restored.tree), /进食草稿已在别处更新/);
  assert.equal(restored.button('保存草稿').props.disabled, true);
  const legacy = mount(p, { draft: local, inputs: {}, invalidInputs: {} });
  assert.match(text(legacy.tree), /这份本机输入缺少云端版本依据/);
  assert.equal(legacy.button('保存草稿').props.disabled, true);
  assert.equal(legacy.button('记录这些已吃').props.disabled, true);
});

test('new drafts save with a null token, and submit compares the just-saved content version', async () => {
  const p = plan(false), editor = mount(p); editor.edit('45');
  await editor.click('记录这些已吃');
  assert.equal(editor.calls.length, 2);
  const [saved, submitted] = editor.calls;
  assert.equal(saved.action, 'save_intake_draft');
  assert.equal(saved.payload.expectedDraftVersion, null);
  assert.equal(submitted.action, 'submit_intake_draft');
  assert.equal(submitted.payload.expectedDraftVersion, intakeDraftVersion(saved.payload.draft));
  assert.equal(submitted.payload.draftId, saved.payload.draft.id);
  assert.notEqual(saved.payload.operationId, submitted.payload.operationId);
});

test('discard compares the loaded cloud content version before removing a saved draft', async () => {
  const p = plan(), editor = mount(p);
  await editor.click('放弃草稿');
  assert.equal(editor.calls.length, 1);
  assert.equal(editor.calls[0].action, 'discard_intake_draft');
  assert.equal(editor.calls[0].payload.expectedDraftVersion, intakeDraftVersion(p.intakeDraft));
  assert.equal(editor.calls[0].payload.draftId, p.intakeDraft.id);
});

test('an uncertain two-step submit retry keeps the submit operation ID while preserving its draft content token', async () => {
  const p = plan(), editor = mount(p, undefined, action => action !== 'submit_intake_draft');
  editor.edit('45'); await editor.click('记录这些已吃');
  const firstSubmit = editor.calls[1];
  const savedPlan = structuredClone(p); savedPlan.intakeDraft = structuredClone(editor.calls[0].payload.draft);
  editor.render({ plan: savedPlan, revision: 5 });
  await editor.click('记录这些已吃');
  assert.equal(editor.calls.length, 4);
  assert.equal(editor.calls[3].payload.operationId, firstSubmit.payload.operationId);
  assert.equal(editor.calls[3].payload.expectedDraftVersion, firstSubmit.payload.expectedDraftVersion);
});
