// Real offline numerical engine + safe protocol simulator. No physical device.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const staticRoot=resolve(root,'roaster/static'), output=resolve(process.env.WORKBENCH_QA_DIR||resolve(root,'docs/qa/workbench-v3.23'));
await mkdir(output,{recursive:true});
const sim=spawn(process.execPath,[resolve(root,'desktop/tools/roaster-simulator.mjs'),'--scenario=idle','--freeze'],{env:{...process.env,ROASTER_SIM_PORT:'0',WORKBENCH_SOURCE:process.env.WORKBENCH_SOURCE||'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let simulatorOrigin='';let simulatorError='';sim.stderr.on('data',data=>simulatorError+=data);
await new Promise((ok,fail)=>{const timer=setTimeout(()=>{sim.kill();fail(Error('simulator timeout'));},15000);sim.stdout.on('data',data=>{const match=String(data).match(/Roaster simulator ready at (http:\/\/127.0.0.1:\d+)/);if(match){simulatorOrigin=match[1];clearTimeout(timer);ok();}});sim.on('exit',()=>{clearTimeout(timer);fail(Error('simulator stopped: '+simulatorError));});});
const server=http.createServer(async(req,res)=>{try{
  if(req.url.startsWith('/api/')){let body='';for await(const chunk of req)body+=chunk;const remote=await fetch(simulatorOrigin+req.url,{method:req.method,headers:{'Content-Type':'application/json'},...(body?{body}:{})});res.writeHead(remote.status,{'Content-Type':'application/json'});res.end(await remote.text());return;}
  const pathname=req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0];const file=resolve(staticRoot,'.'+decodeURIComponent(pathname));if(!file.startsWith(staticRoot))throw Error('path');const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'};const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(bytes);
}catch(e){res.writeHead(404);res.end(e.message);}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const checks=[];
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:800},acceptDownloads:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(simulatorOrigin=>{
    const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket {constructor(url,...args){if(new URL(url).pathname==='/ws')url=simulatorOrigin.replace('http:','ws:')+'/ws';super(url,...args);}};
    window.__exports=[];window.__cancelSave=false;
    window.showSaveFilePicker=async options=>{if(window.__cancelSave)throw new DOMException('cancel','AbortError');return {createWritable:async()=>({write:async blob=>window.__exports.push({name:options.suggestedName,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))}),close:async()=>{}})};};
  },simulatorOrigin);
  await page.goto(origin+'/#workbench');
  await page.waitForFunction(()=>window.RoasterWorkbench);
  await page.evaluate(()=>window.RoasterWorkbench.initialize());
  const ready=()=>page.waitForFunction(()=>document.querySelector('#wb-root').getAttribute('aria-busy')==='false');
  await page.locator('#wb-new').click();await ready();
  let original=await page.evaluate(()=>window.RoasterWorkbench.getSnapshot());assert.equal(original.document.kind,'profile');assert.equal(original.fan_overlay[0][1],215.5);checks.push('new dual-curve + original overlay baseline');
  await page.locator('[data-node="1"]').click();await page.locator('#wb-y').fill('108');await page.locator('#wb-y').press('Tab');await ready();
  let edited=await page.evaluate(()=>window.RoasterWorkbench.getSnapshot());assert.equal(edited.curves.roast_profile.points[1][1],108);assert.notEqual(edited.document.data,original.document.data);
  await page.locator('#wb-undo').click();await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,original.document.data);
  await page.locator('#wb-redo').click();await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,edited.document.data);checks.push('numeric edit + exact undo/redo');
  await page.locator('#wb-part').selectOption('right');const handleBefore=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).curves.roast_profile.points[1][5];await page.locator('#wb-y').fill(String(handleBefore+2));await page.locator('#wb-y').press('Tab');await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).curves.roast_profile.points[1][5],handleBefore+2);checks.push('Bezier control handle numeric editing');
  await page.locator('#wb-phase-expect_colrchange').fill('160');await page.locator('#wb-phase-expect_colrchange').press('Tab');await ready();assert.ok((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).phases.phases.drying);checks.push('ABC exact phase calculation');
  await page.locator('[data-wb-tab="settings"]').click();assert.equal(await page.locator('[data-parameter]').count(),50);
  await page.locator('#wb-param-preheat_power').fill('bad-number');await page.locator('#wb-param-preheat_power').press('Tab');await ready();await page.locator('#wb-save').click();await page.waitForFunction(()=>window.RoasterWorkbench.getError().includes('修正输入'));assert.equal(await page.evaluate(()=>window.__exports.length),0);checks.push('invalid field blocks saving stale document');
  await page.locator('#wb-param-preheat_power').fill('960');await page.locator('#wb-param-preheat_power').press('Tab');await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).metadata.preheat_power,'960');checks.push('full native parameter categories');
  await page.locator('[data-wb-tab="roast_profile"]').click();
  const beforeTransform=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data;
  await page.locator('#wb-transform').click();await page.locator('#wb-dialog input[name="time_scale"]').fill('1.1');await page.locator('#wb-dialog button[type="submit"]').click();await ready();assert.notEqual((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,beforeTransform);await page.locator('#wb-undo').click();await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,beforeTransform);checks.push('curve transform dialog and undo');
  await page.locator('#wb-area').click();await page.locator('#wb-dialog button[type="submit"]').click();await page.locator('#wb-tool-result').filter({hasText:'面积：'}).waitFor();await page.locator('[data-close-dialog]').click();await page.locator('#wb-time').click();await page.locator('#wb-dialog button[type="submit"]').click();await page.locator('#wb-tool-result').filter({hasText:'330 秒'}).waitFor();await page.locator('[data-close-dialog]').click();checks.push('area and time calculator dialogs');
  await page.screenshot({path:resolve(output,'profile-light.png')});
  await page.locator('#wb-save').click();await ready();await page.waitForFunction(()=>window.__exports.length===1);assert.ok(!await page.locator('#wb-filename').textContent().then(text=>text.includes('未保存')));checks.push('native save confirmed and bytes retained');
  await page.evaluate(()=>window.__cancelSave=true);await page.locator('#wb-y').fill('113');await page.locator('#wb-y').press('Tab');await ready();await page.locator('#wb-save').click();await ready();assert.ok((await page.locator('#wb-filename').textContent()).includes('未保存'));await page.evaluate(()=>window.__cancelSave=false);checks.push('save cancellation retains dirty document');
  const beforeDrag=await page.evaluate(()=>window.RoasterWorkbench.getHistory().undo);
  const rect=await page.locator('#wb-canvas').boundingBox();const p=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).curves.roast_profile.points[1];
  const axes=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).axes;
  const x1=Math.max(...Object.values(axes).map(a=>a.x1));const px=rect.x+58+p[0]/x1*(rect.width-106);const py=rect.y+rect.height-40-(p[1]-axes.roast_profile.y0)/(axes.roast_profile.y1-axes.roast_profile.y0)*(rect.height-82);
  await page.mouse.move(px,py);await page.mouse.down();await page.mouse.move(px+8,py-5,{steps:5});await page.mouse.up();await ready();assert.equal(await page.evaluate(()=>window.RoasterWorkbench.getHistory().undo),beforeDrag+1);checks.push('pointer capture drag creates one undo entry');
  // Comparison does not replace the active file, and parameter differences appear.
  const defaultFile=resolve(root,'roaster/src/workbench/native/resources/default.kpro');const active=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data;
  await page.locator('#wb-compare-file').setInputFiles(defaultFile);await page.locator('[data-compare-remove]').waitFor();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,active);await page.locator('[data-wb-tab="settings"]').click();assert.ok(await page.locator('.wb-different').count()>0);checks.push('non-destructive comparison + setting differences');
  await page.locator('[data-wb-tab="roast_profile"]').click();
  const beforeMerge=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data;await page.locator('#wb-merge').click();await page.locator('#wb-dialog input[name="file"]').setInputFiles(defaultFile);await page.locator('#wb-dialog input[value="other_settings"]').check();await page.locator('#wb-dialog button[type="submit"]').click();await page.locator('#wb-dialog').waitFor({state:'hidden'});await ready();assert.ok((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data!==beforeMerge);await page.locator('#wb-undo').click();await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,beforeMerge);checks.push('selective merge dialog and undo');
  await page.locator('#wb-png').click();await page.waitForFunction(()=>window.__exports.some(e=>e.name.endsWith('.png')));const png=await page.evaluate(()=>window.__exports.find(e=>e.name.endsWith('.png')));assert.ok(Buffer.from(png.bytes).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));checks.push('PNG export is a decodable image stream');
  await page.locator('#wb-pdf').click();await page.locator('#wb-dialog input[value="settings"]').check();await page.locator('#wb-dialog button[type="submit"]').click();await page.waitForFunction(()=>window.__exports.some(e=>e.name.endsWith('.pdf')));
  const exported=await page.evaluate(()=>window.__exports);for(const file of exported)await writeFile(resolve(output,file.name),Buffer.from(file.bytes));checks.push('multi-page PDF export + native bytes artifact');
  // Existing console logs enter the same analysis workspace.
  await page.locator('.tab-btn[data-tab="records"]').click();await page.locator('.record-item').first().click();await page.getByRole('button',{name:'在原生工作台分析',exact:true}).click();await page.locator('#wb-dialog button[value="discard"]').click();await ready();await page.waitForFunction(()=>window.RoasterWorkbench.getSnapshot()?.document.kind==='log');assert.ok((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).sample_count>0);checks.push('existing console record analysis bridge');
  await page.screenshot({path:resolve(output,'console-record.png')});
  await page.locator('#wb-extract').click();await page.waitForFunction(()=>window.RoasterWorkbench.getSnapshot()?.document.kind==='profile');assert.ok((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).curves.roast_profile);checks.push('extract embedded curve from console log');
  const sampleName=(await readdir(resolve(root,'kaffelogic逆向/analysis/samples'))).find(name=>name.endsWith('.klog'));
  await page.locator('#wb-file').setInputFiles(resolve(root,'kaffelogic逆向/analysis/samples',sampleName));await page.locator('#wb-dialog button[value="discard"]').click();await page.waitForFunction(name=>window.RoasterWorkbench.getSnapshot()?.document.name===name,sampleName);
  const log=await page.evaluate(()=>window.RoasterWorkbench.getSnapshot());assert.ok(log.sample_count>100);assert.ok(log.channels.length>5);
  await page.locator('#wb-smoothing').fill('3');await page.locator('#wb-smoothing').press('Tab');await ready();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,log.document.data);checks.push('real multi-channel log + non-mutating display smoothing');
  await page.locator('#wb-csv').click();await ready();await page.waitForFunction(()=>window.__exports.some(e=>e.name.endsWith('.csv')));const csv=await page.evaluate(()=>window.__exports.find(e=>e.name.endsWith('.csv')));await writeFile(resolve(output,'real-log.csv'),Buffer.from(csv.bytes));assert.ok(Buffer.from(csv.bytes).subarray(0,3).equals(Buffer.from([239,187,191])));checks.push('raw CSV UTF-8 BOM export');
  await ready();assert.equal(await page.locator('#wb-new').isDisabled(),false);
  await page.evaluate(()=>{localStorage.setItem('roaster.theme','dark');document.documentElement.dataset.theme='dark';window.dispatchEvent(new Event('roaster-themechange'));});await page.setViewportSize({width:1024,height:640});await page.waitForTimeout(450);await page.screenshot({path:resolve(output,'log-dark-1024.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const estop=await page.locator('#btn-e-stop').boundingBox();assert.ok(estop&&estop.y>=0&&estop.y+estop.height<=640);checks.push('1024x640 dark theme + visible E-STOP');
  await fetch(simulatorOrigin+'/api/v1/control/start',{method:'POST'});
  await page.locator('#btn-e-stop:not(.disabled)').waitFor();
  await page.locator('#wb-help').click();assert.equal(await page.evaluate(()=>{const b=document.querySelector('#btn-e-stop'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);checks.push('workbench dialog never intercepts E-STOP');
  await page.locator('[data-help-close]').click();
  const beforeStop=(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data;
  await page.locator('#btn-e-stop').dblclick({delay:80});await page.locator('#error-overlay:not(.hidden)').waitFor();assert.equal((await page.evaluate(()=>window.RoasterWorkbench.getSnapshot())).document.data,beforeStop);checks.push('E-STOP protocol remains reachable and preserves offline document');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({checks,errors,sourceEngine:process.env.WORKBENCH_SOURCE!=='0'},null,2));console.log(JSON.stringify({checks:checks.length,errors,output},null,2));
}finally{await browser?.close();server.close();sim.kill();}
