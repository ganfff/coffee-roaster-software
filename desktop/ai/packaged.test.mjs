import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const node=resolve(root,'runtime/ai-node-x86_64-pc-windows-msvc.exe');
const worker=resolve(root,'runtime/ai/worker.mjs');
test('bundled Node + split ESM resources execute without system Node/cloud', {skip:process.platform!=='win32'||!existsSync(node)},async()=>{
  const child=spawn(node,[worker],{windowsHide:true,env:{...process.env,ROASTER_AI_IMPORT_ONLY:''},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.stdin.end(JSON.stringify({id:'packaged',kind:'models',config:{provider:'deepseek'},apiKey:null})+'\n');
  const code=await new Promise(ok=>child.on('exit',ok));assert.equal(code,0,err);
  const events=out.trim().split('\n').map(line=>JSON.parse(line));assert.ok(events.find(e=>e.type==='models').data.length>0);assert.equal(events.at(-1).type,'done');assert.ok(!events.some(e=>e.type==='error'));
});
