// Isolated shared-frontend fixture + real offline engine. Never opens hardware.
import {chromium} from '../../desktop/node_modules/playwright/index.mjs';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),staticRoot=resolve(root,'roaster/static');
const sim=spawn(process.execPath,[resolve(root,'desktop/tools/roaster-simulator.mjs'),'--scenario=idle','--freeze'],{env:{...process.env,ROASTER_SIM_PORT:'0',WORKBENCH_SOURCE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let simOrigin='',stderr='';sim.stderr.on('data',chunk=>stderr+=chunk);
await new Promise((ok,fail)=>{const timer=setTimeout(()=>{sim.kill();fail(Error('sim timeout '+stderr));},20000);sim.stdout.on('data',chunk=>{const match=String(chunk).match(/Roaster simulator ready at (http:\/\/127.0.0.1:\d+)/);if(match){simOrigin=match[1];clearTimeout(timer);ok();}});sim.on('exit',()=>{clearTimeout(timer);fail(Error(stderr));});});
const fixture='<!doctype html><html lang="zh-CN" data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="css/theme.css"><link rel="stylesheet" href="css/style.css"><link rel="stylesheet" href="css/workbench.css"><style>body{display:flex;flex-direction:column;height:100dvh;margin:0}#wb-root{flex:1;min-height:0}#footer{flex-shrink:0;height:56px;z-index:1020;position:relative}.record-actions,[data-tab]{display:none}</style><script defer src="js/workbench.js"></script></head><body data-view="workbench"><button data-tab="workbench"></button><div class="record-actions"></div><div id="wb-root"></div><footer id="footer"><button id="btn-e-stop">紧急停止</button></footer></body></html>';
const server=http.createServer(async(req,res)=>{try{
  if(req.url.startsWith('/api/')){let body='';for await(const chunk of req)body+=chunk;const remote=await fetch(simOrigin+req.url,{method:req.method,headers:{'Content-Type':'application/json'},...(body?{body}:{})});res.writeHead(remote.status,{'Content-Type':'application/json'});res.end(await remote.text());return;}
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(fixture);return;}
  const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(staticRoot))throw Error('path');const bytes=await readFile(path);res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[extname(path)]||'application/octet-stream'});res.end(bytes);
}catch(error){res.writeHead(404);res.end(error.message);}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
let browser;const checks=[];
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(()=>window.RoasterWorkbench.initialize());
  const ready=()=>page.waitForFunction(()=>document.querySelector('#wb-root').getAttribute('aria-busy')==='false');
  await page.locator('#wb-new').click();await ready();
  const original=await page.evaluate(()=>window.RoasterWorkbench.getSnapshot());
  const context=await page.evaluate(()=>window.RoasterWorkbenchAI.getContext());
  assert.equal(context.native.kind,'profile');assert.equal(context.native.can_propose,true);
  assert.equal(context.native_document.data,original.document.data);assert.equal(context.identity.sha256,original.document.sha256);
  checks.push('native context contract and local-only raw attachment');
  await page.locator('#wb-help').click();await page.locator('#wb-help-query').fill('风扇');
  assert.ok(await page.locator('.wb-help-article').count()>3);
  await page.locator('#wb-help-query').fill('preheat_power');
  assert.ok((await page.locator('#wb-help-results').textContent()).includes('预热'));
  await page.locator('[data-help-action="parameter"]').click();
  assert.equal(await page.locator('#wb-param-preheat_power').count(),1);
  await page.locator('#wb-help').click();await page.locator('[data-help-category="parameters"]').click();
  assert.equal(await page.locator('.wb-help-article').count(),144);
  await page.locator('#wb-help-query').fill('no-such-native-help');await page.locator('[data-help-reset]').click();
  await page.setViewportSize({width:1024,height:640});
  const estop=await page.locator('#btn-e-stop').boundingBox();
  assert.ok(estop&&estop.y+estop.height<=640);
  assert.equal(await page.evaluate(()=>{const el=document.querySelector('#btn-e-stop'),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('[data-help-close]').click();checks.push('offline searchable 144-field help, action jump, empty state and E-STOP visibility');
  const proposal=structuredClone(original.curves.roast_profile.points);
  for(const p of proposal){p[1]+=1;for(const i of [2,4])if(p[i]||p[i+1])p[i+1]+=1;}
  const artifact={type:'native_profile',identity:context.identity,value:{temperature:proposal,rationale:'增温一度'}};
  const cancelled=await page.evaluate(async artifact=>{const pending=window.RoasterWorkbenchAI.preview(artifact);window.RoasterWorkbenchAI.discard();try{await pending;return false;}catch(error){return error.message.includes('取消');}},artifact);
  assert.equal(cancelled,true);
  await page.evaluate(artifact=>window.RoasterWorkbenchAI.preview(artifact),artifact);
  assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,original.document.data);
  assert.equal(await page.locator('#wb-ai-preview').isVisible(),true);
  await page.evaluate(artifact=>{window.acceptPromise=window.RoasterWorkbenchAI.accept(artifact);},artifact);
  await page.locator('#wb-dialog button[value="accept"]').click();
  assert.equal((await page.evaluate(()=>window.acceptPromise)).accepted,true);
  assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getHistory())).undo,1);
  const candidate=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data;
  assert.notEqual(candidate,original.document.data);
  await page.locator('#wb-undo').click();await ready();
  assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,original.document.data);
  const stale=await page.evaluate(async artifact=>{try{await window.RoasterWorkbenchAI.preview(artifact);return '';}catch(error){return error.message;}},artifact);
  assert.ok(stale.includes('过期'));checks.push('proposal preview, confirmed atomic adoption, one-step exact undo and stale guard');
  async function openText(text,name){
    await page.evaluate(({text,name})=>{window.openPromise=window.RoasterWorkbench.openFiles([new File([text],name)]);},{text,name});
    if(await page.locator('#wb-dialog[open] button[value="discard"]').count())await page.locator('#wb-dialog button[value="discard"]').click();
    await page.evaluate(()=>window.openPromise);await ready();
  }
  const log='profile_schema_version:1.8\r\nnative_schema_version:1.9\r\nunknown:keep\r\noffsets\t2\r\ntime\t#=mean_temp\r\n0\t20\t\r\n1\t22\t\r\n2\t24\t\r\n';
  await openText(log,'source.klog');
  const logContext=await page.evaluate(()=>window.RoasterWorkbenchAI.getContext());
  assert.equal(logContext.native.readonly,true);assert.equal(logContext.native.can_propose,true);
  const logBefore=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data;
  const logArtifact={type:'native_profile',identity:logContext.identity,value:{temperature:proposal,rationale:'下一锅'}};
  await page.evaluate(artifact=>{window.acceptPromise=window.RoasterWorkbenchAI.accept(artifact);},logArtifact);
  await page.locator('#wb-dialog button[value="accept"]').click();await page.evaluate(()=>window.acceptPromise);
  assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.kind,'profile');
  await page.locator('#wb-undo').click();await ready();
  assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,logBefore);
  assert.equal((await page.evaluate(()=>window.RoasterWorkbenchAI.getIdentity())).document_session_id,logContext.identity.document_session_id);
  const samples=await page.evaluate(()=>window.RoasterWorkbenchAI.getSamples({channel:'#=mean_temp',from:2,to:3}));
  assert.deepEqual(samples.samples,[[2,20],[3,22]]);
  await page.locator('#wb-redo').click();await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.kind,'profile');
  checks.push('readonly log creates supported separate kpro, exact source undo/redo and offset samples');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,errors},null,2));
}finally{await browser?.close();server.close();sim.kill();}
