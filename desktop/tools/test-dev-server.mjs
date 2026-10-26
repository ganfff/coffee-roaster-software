import {startDevServer} from './dev-server.mjs';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const dir=await mkdtemp(join(tmpdir(),'roaster-debug-test-')),out=resolve(process.env.ROASTER_QA_DIR||'build/qa/mhub-v3.30/dev-host');
await mkdir(out,{recursive:true});let host,browser;const checks=[],errors=[];
try {
  host=await startDevServer({port:0,freeze:true,dataDir:dir});
  const {origin}=host;
  assert.equal((await fetch(origin+'/__debug__/health').then(r=>r.json())).mode,'safe-simulator');checks.push('standalone loopback development host starts without installation');
  assert.equal((await fetch(origin+'/api/v1/ai/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'providers'})})).status,401);
  assert.equal((await fetch(origin+'/api/v1/ai/rpc',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/%5c..%5c..%5cPRODUCT.md')).status,403);checks.push('AI authentication, cross-origin rejection and static path boundary');
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1366,height:800}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.locator('.connection-copy').filter({hasText:'安全模拟器'}).waitFor();assert.equal(await page.locator('#quick-profile-select option').count(),3);checks.push('real entry serves current HTML/CSS/JS and simulator WS with 3 profiles');
  const offline=await browser.newPage();
  await offline.route('**/adapter-test',route=>route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/mhub.css"></head><body><button data-tab="workbench" onclick="window.chosen=true">工作台</button><script>window.__TAURI_INTERNALS__={};localStorage.setItem("roaster.backendUrl","http://127.0.0.1:9");</script><script src="/js/tauri-adapter.js"></script></body></html>'}));
  await offline.goto(origin+'/adapter-test');await offline.locator('#backend-connection-notice').filter({hasText:'桌面安装包不包含控机 HTTP 服务'}).waitFor();await offline.locator('#backend-connection-notice button').filter({hasText:'打开离线工作台'}).click();assert.equal(await offline.evaluate(()=>window.chosen),true);await offline.close();checks.push('first-launch missing-backend explanation and offline workspace navigation');
  await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'AI 账户',exact:true}).click();await page.locator('.ai-config-form').waitFor();await page.waitForFunction(()=>document.querySelector('.ai-config-form h4'));assert.equal(await page.locator('.ai-status').filter({hasText:'not found'}).count(),0);
  const state=await page.evaluate(()=>window.RoasterChat.request('profiles.list'));assert.equal(state.length,0);const providers=await page.evaluate(()=>window.RoasterChat.request('providers'));assert.ok(providers.length>0);checks.push('real local AI service, providers/settings work without a key or fake preconfigured profile');
  await page.screenshot({path:join(out,'settings.png')});
  await page.locator('[data-tab=records]').click();await page.locator('.record-item').first().waitFor();checks.push('sample records available through the same server');
  await page.locator('[data-tab=workbench]').click();await page.locator('#wb-new').click();await page.waitForFunction(()=>window.RoasterWorkbench.getSnapshot());assert.equal(await page.evaluate(()=>window.RoasterWorkbench.getSnapshot().document.kind),'profile');checks.push('packaged offline numerical engine creates a native document');
  await page.screenshot({path:join(out,'workbench.png')});
  await page.goto(origin+'/editor.html');await page.locator('#editor-chart').waitFor();await page.waitForFunction(()=>!document.querySelector('#btn-save').disabled);checks.push('editor opens in idle and can save without installing');
  await page.goto(origin);const conversation=await page.evaluate(()=>window.RoasterChat.request('conversations.create',{title:'debug-restart-proof'}));assert.ok(conversation.id);await browser.close();browser=null;await host.close();host=null;
  host=await startDevServer({port:0,freeze:true,dataDir:dir});browser=await chromium.launch({channel:'msedge',headless:true});const restored=await browser.newPage();await restored.goto(host.origin);await restored.waitForFunction(()=>window.RoasterChat);await restored.waitForFunction(async()=>{try{return (await window.RoasterChat.request('conversations.list')).length>0;}catch{return false;}});checks.push('AI history survives a server restart using the same OS-protected installation key');
  await restored.locator('[data-tab=roast]').click();await restored.screenshot({path:join(out,'debug-page.png')});
  assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,scope:'live source, hardware-free simulator and real AI service; no paid inference or hardware'},null,2));console.log(JSON.stringify({checks:checks.length,errors,output:out},null,2));
}finally{await browser?.close();await host?.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}

