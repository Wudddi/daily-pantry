import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/export-public.mjs',import.meta.url));
function fixture(t) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pantry-export-')), source=path.join(temp,'source'), output=path.join(temp,'public');
  fs.mkdirSync(source);fs.mkdirSync(output);
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  execFileSync('git',['init','--quiet'],{cwd:source});
  execFileSync('git',['init','--quiet'],{cwd:output});
  function write(name,text){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
  write('.openai/hosting.json',JSON.stringify({project_id:'private-project-fixture',r2:'BUCKET',capabilities:['mcp']}));
  write('app/page.tsx','export default function Page(){return "Daily Pantry";}');
  write('lib/seed-inventory.json','{"demoNotice":"Synthetic fictional example","items":[]}');
  write('work/private-record.json','{"actualIntake":"private"}');
  write('.env.local','DO_NOT_EXPORT=private');
  return {source,output,write,run:()=>spawnSync(process.execPath,[script,'--out',output],{cwd:source,encoding:'utf8'})};
}
test('public export removes hosting identity and excludes records/credentials while retaining Git metadata',t=>{
 const f=fixture(t), result=f.run();assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output,'.openai/hosting.json'),'utf8')),{d1:null,r2:'BUCKET',capabilities:['mcp']});
 assert.equal(fs.existsSync(path.join(f.output,'work/private-record.json')),false);
 assert.equal(fs.existsSync(path.join(f.output,'.env.local')),false);
 assert.ok(fs.existsSync(path.join(f.output,'.git/HEAD')));
 assert.ok(fs.existsSync(path.join(f.output,'app/page.tsx')));
});
test('public export rejects private identity in selected source before copying files',t=>{
 const f=fixture(t);f.write('README.md','private-project-fixture');const result=f.run();
 assert.notEqual(result.status,0);assert.match(result.stderr,/Private identifier/);
 assert.equal(fs.existsSync(path.join(f.output,'app/page.tsx')),false);
});
test('public export rejects seeds lacking synthetic provenance',t=>{
 const f=fixture(t);f.write('lib/seed-inventory.json','{"items":[{"name":"Unverified data"}]}');
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/synthetic-data notice/);
});
