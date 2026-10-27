// Source UI + actual Python controller/API, with physical auto-connect explicitly disabled.
import {chromium} from 'playwright';
import {startDevServer} from './dev-server.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import assert from 'node:assert/strict';

const data=await mkdtemp(join(tmpdir(),'roaster-device-ui-'));
const out=resolve('../.impeccable/review/device-v3.31');await mkdir(out,{recursive:true});
const previous=process.env.ROASTER_DISABLE_AUTO_CONNECT;process.env.ROASTER_DISABLE_AUTO_CONNECT='1';
const checks=[],errors=[];let host,browser;
try {
  host=await startDevServer({port:0,device:true,dataDir:data});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:800}});page.on('pageerror',error=>errors.push(error.message));
  const ready=async mode=>{await page.waitForFunction(mode=>document.documentElement.dataset.connectionMode===mode&&document.querySelector('#quick-profile-select')?.value,mode);};
  const status=()=>page.evaluate(()=>fetch('/api/v1/status').then(r=>r.json()));
  const settings=async()=>{await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'设备连接',exact:true}).click();};
  const change=async mode=>{await settings();await page.locator('#device-mode').selectOption(mode);const navigation=page.waitForNavigation();await page.locator('#device-apply').click();await navigation;await ready(mode);await page.locator('[data-tab=roast]').click();};
  await page.goto(host.origin);await page.emulateMedia({reducedMotion:'reduce'});await ready('device');
  assert.equal((await status()).connection.mode,'device');assert.equal((await status()).pv,null);
  assert.equal(await page.locator('#btn-start').isDisabled(),true);
  assert.deepEqual(await page.locator('#event-actions-bar .event-name').allTextContents(),['CC','FC','SC','End']);
  assert.equal(await page.locator('#event-actions-bar').evaluate(n=>!!n.closest('#controls-panel')&&!n.closest('#charts-panel')),true);
  assert.equal(await page.locator('[data-event=first_crack_end],[data-event=second_crack_end]').count(),0);
  assert.equal(await page.locator('body').innerText().then(v=>/安全模拟器|样例数据/.test(v)),false);
  checks.push('normal source entry uses real Python device mode, blank telemetry, four KL controls in console and no sample annotations');
  for(const [width,height] of [[2048,1200],[1366,800],[1024,640],[375,812]]) {
    await page.setViewportSize({width,height});await page.locator('[data-tab=roast]').click();
    for(const mode of ['light','dark']){
      await page.evaluate(mode=>window.RoasterTheme.setMode(mode),mode);await page.evaluate(()=>document.fonts.ready);
      await page.evaluate(()=>{document.scrollingElement.scrollTop=0;for(const node of document.querySelectorAll('#workspace,.workspace-view,.command-scroll'))node.scrollTop=0;});
      const bounds=await page.evaluate(()=>{const bar=document.querySelector('#event-actions-bar'),r=bar.getBoundingClientRect(),stop=document.querySelector('#btn-e-stop'),s=stop.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth+1,barHeight:r.height,labels:[...bar.querySelectorAll('button')].map(n=>n.getBoundingClientRect().width),stop:stop.contains(document.elementFromPoint(s.x+s.width/2,s.y+s.height/2))};});
      assert.equal(bounds.overflow,false);assert.ok(bounds.barHeight<=45);assert.ok(bounds.labels.every(width=>width>=44));assert.equal(bounds.stop,true);
      await page.screenshot({path:join(out,`home-${width}-${mode}.png`)});
      if(width===375){await page.locator('#event-actions-bar').scrollIntoViewIfNeeded();await page.screenshot({path:join(out,`console-${width}-${mode}.png`)});}
    }
    await settings();assert.equal(await page.locator('#device-mode').inputValue(),'device');
    assert.ok(await page.locator('#device-port option').count()>=1);
    await page.screenshot({path:join(out,`settings-${width}.png`)});
  }
  checks.push('2048/1366/1024/375 layouts: four compact controls, readable connection settings/ports, both themes and E-STOP access');
  await page.setViewportSize({width:1366,height:800});await settings();await page.locator('#device-baudrate').selectOption('19200');
  await page.route('**/api/v1/connection',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch(),value=await response.json();value.ports.push({device:'COM99',description:'port-refresh test fixture',usb:true});await route.fulfill({response,json:value});});
  await page.locator('#device-refresh').click();await page.locator('#device-port option[value=COM99]').waitFor({state:'attached'});
  assert.equal(await page.locator('#device-baudrate').inputValue(),'19200');
  await page.unroute('**/api/v1/connection');await page.locator('#device-refresh').click();await page.waitForFunction(()=>!document.querySelector('#device-port option[value=COM99]'));
  await page.locator('#device-baudrate').selectOption('9600');checks.push('port refresh updates available devices without overwriting unsaved serial parameter edits');
  await page.setViewportSize({width:1366,height:800});await change('simulator');
  await page.waitForFunction(()=>!document.querySelector('#btn-start').disabled);
  assert.match(await page.locator('.connection-copy').innerText(),/模拟器/);
  await page.evaluate(()=>{window.RoasterUI.confirm=async()=>false;});
  await page.locator('#btn-start').click();await page.waitForFunction(()=>document.querySelector('#state-badge').textContent==='烘焙中');
  for(const type of ['yellowing','first_crack','second_crack']){await page.locator(`[data-event=${type}]`).click();await page.locator(`[data-event=${type}].active`).waitFor();}
  assert.deepEqual((await status()).events.map(e=>e.type),['charge','yellowing','first_crack','second_crack']);
  const denied=await page.evaluate(()=>fetch('/api/v1/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'device',port:'',baudrate:9600,slave_id:1})}).then(r=>r.status));assert.equal(denied,409);
  await page.screenshot({path:join(out,'simulation-roast.png')});
  await page.locator('[data-event=drop]').click();await page.waitForFunction(()=>document.querySelector('#state-badge').textContent==='待机');
  await change('device');assert.equal((await status()).pv,null);assert.deepEqual((await status()).events,[]);
  assert.equal(await page.locator('#btn-start').isDisabled(),true);
  checks.push('settings-only simulator runs the actual controller; CC/FC/SC/End work; active mode switch rejected; returning to real mode clears simulated live data');
  await change('simulator');const port=Number(new URL(host.origin).port);await host.close();
  host=await startDevServer({port,device:true,dataDir:data});await page.reload();await ready('device');
  assert.equal((await status()).connection.mode,'device');checks.push('restarting after simulation defaults to a real device again with saved serial parameters');
  assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,scope:'actual Python controller and shared UI; serial opening disabled; no physical device or heater commands'},null,2));
  console.log(JSON.stringify({checks:checks.length,errors,output:out}));
} finally {
  await browser?.close();await host?.close();if(previous===undefined)delete process.env.ROASTER_DISABLE_AUTO_CONNECT;else process.env.ROASTER_DISABLE_AUTO_CONNECT=previous;
  assert.ok(resolve(data).startsWith(resolve(tmpdir())+sep));await rm(data,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
