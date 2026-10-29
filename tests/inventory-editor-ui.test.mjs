import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Render the actual inventory editors. Other page views are outside these
// tests, so their CSS/browser-only implementations are omitted from the load.
let source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
source = source.replace('import HealthRecords, { LimitedTextarea } from "./health-records";', 'import React from "react"; const HealthRecords=()=>null; const LimitedTextarea=(props:any)=>React.createElement("textarea",props);');
source = source.replace('import DietRecords from "./diet-records";', 'const DietRecords=()=>null;');
source = source.replace(/import\s+["'][^"']+\.css["'];?/g, '');
source += '\nexport {FoodModal, RestockModal};';
let compiled = ts.transpileModule(source, { fileName:'inventory-editors.tsx', compilerOptions:{ jsx:ts.JsxEmit.ReactJSX, module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/from\s+(["'])([^"']+)\1/g, (_match,_quote,specifier) => 'from '+JSON.stringify(specifier.startsWith('@/')?new URL('../'+specifier.slice(2),import.meta.url).href:import.meta.resolve(specifier)));
const { FoodModal, RestockModal } = await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const food = patch => ({ id:'yogurt',name:'原味酸奶',category:'protein',brand:'PC',quantity:0,unit:'g',status:'depleted',priority:false,location:'冷藏',nutrition:{basisAmount:100,basisUnit:'g',kcal:60,protein:10,carbs:5,fat:0,source:'label',sourceNote:'原标签',sourceText:'原包装全文'},gramsPerUnit:null,ingredients:'牛奶',supplementFacts:'',notes:'旧记录',confirmedAt:'2026-10-20',updatedAt:'2026-10-20',...patch });
const props = item => ({ item,saving:false,blocked:false,error:'',onClose(){},async onSave(){},async onArchive(){},existingItems:[],onReuse(){} });
function input(html,label) { const element=html.match(new RegExp('<(?:input|select)(?=[^>]*aria-label="'+label+'")[^>]*>'));assert.ok(element,label+' should exist');return element[0]; }

test('editing a depleted label locks both stock amount and unit instead of offering implicit replenishment',()=>{
 const html=renderToStaticMarkup(React.createElement(FoodModal,props(food())));
 assert.match(input(html,'编辑记录的当前余量'),/disabled=""/);
 assert.match(input(html,'编辑记录的当前余量'),/value="0"/);
 assert.match(input(html,'库存计量单位'),/disabled=""/);
 assert.match(html,/更正资料不会重新启用/);
 assert.match(html,/补货复用/);
 assert.match(html,/原包装全文/);
});
test('an archived record with old positive amount remains locked while aliases and nutrition stay editable',()=>{
 const html=renderToStaticMarkup(React.createElement(FoodModal,props(food({status:'archived',quantity:250,aliases:['0%希腊酸奶']}))));
 assert.match(input(html,'编辑记录的当前余量'),/disabled=""/);
 assert.match(input(html,'编辑记录的当前余量'),/value="250"/);
 assert.match(input(html,'库存计量单位'),/disabled=""/);
 assert.match(html,/<textarea[^>]*aria-label="同款别名（每行一个，可选）"[^>]*>0%希腊酸奶<\/textarea>/);
 assert.match(html,/已归档/);
});
test('active stock remains editable and depleted recipe batches direct the user to a new batch',()=>{
 const active=renderToStaticMarkup(React.createElement(FoodModal,props(food({status:'available',quantity:350}))));
 assert.doesNotMatch(input(active,'编辑记录的当前余量'),/disabled=/);
 assert.doesNotMatch(input(active,'库存计量单位'),/disabled=/);
 const batch=renderToStaticMarkup(React.createElement(FoodModal,props(food({category:'prepared',unit:'袋',nutrition:{...food().nutrition,source:'recipe'}}))));
 assert.match(batch,/新制作的备餐请添加新批次/);
});
test('restock never pre-fills old or package quantity and cannot save until a current amount or explicit unknown choice',()=>{
 const html=renderToStaticMarkup(React.createElement(RestockModal,props(food({quantity:500,status:'archived'}))));
 assert.match(input(html,'补货后的当前总余量'),/value=""/);
 assert.match(html,/<button[^>]*type="submit"[^>]*disabled=""[^>]*>/);
 assert.match(html,/当前总余量/);
 assert.match(html,/已补货，余量不逐项盘点/);
 assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked=/);
});
