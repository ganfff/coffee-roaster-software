// Actual packaged release EXE/WebView/Rust and bundled Python; no development server.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'roaster-device-native-')),out=resolve('../.impeccable/review/device-v3.31/native');
await mkdir(out,{recursive:true});let child,browser,backend;const errors=[],checks=[];
try {
  const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  const executable=resolve('src-tauri/target/release/roaster-desktop.exe');
  child=spawn(executable,[],{cwd:resolve('src-tauri/target/release'),windowsHide:true,stdio:'ignore',env:{...process.env,ROASTER_DISABLE_AUTO_CONNECT:'1',ROASTER_APP_DATA_DIR:join(dir,'app'),WEBVIEW2_USER_DATA_FOLDER:join(dir,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  const endpoint='http://127.0.0.1:'+port,deadline=Date.now()+60000;
  for(;;){try{if((await fetch(endpoint+'/json/version')).ok)break;}catch{}if(child.exitCode!==null||Date.now()>deadline)throw Error('Packaged native window did not start');await new Promise(ok=>setTimeout(ok,200));}
  browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__&&!window.ROASTER_DEBUG&&document.documentElement.dataset.connectionMode==='device'&&document.querySelector('#quick-profile-select')?.value);
  backend=await page.evaluate(()=>window.RoasterBackend.url);assert.match(backend,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(backend+'/api/v1/runtime/health').then(r=>r.json())).mode,'device');
  assert.equal(await page.locator('#btn-start').isDisabled(),true);
  assert.deepEqual(await page.locator('#event-actions-bar .event-name').allTextContents(),['CC','FC','SC','End']);
  const ports=await page.evaluate(()=>fetch('/api/v1/connection').then(r=>r.json()));assert.equal(ports.settings.mode,'device');
  assert.equal(await page.evaluate(()=>window.RoasterAITransport.host.kind),'local');
  checks.push('release EXE starts its bundled Python controller on a private dynamic port, defaults to real device, keeps native local AI and never fabricates telemetry');
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>window.RoasterTheme.setMode('dark'));await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:join(out,'native-home.png')});
  await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'设备连接',exact:true}).click();
  assert.ok(await page.locator('#device-port option').count()>=1);await page.screenshot({path:join(out,'native-device-settings.png')});
  await page.locator('.device-backend summary').click();await page.locator('#backend-custom').scrollIntoViewIfNeeded();await page.screenshot({path:join(out,'native-service-settings.png')});
  assert.equal(await page.locator('#backend-custom').getAttribute('placeholder'),'http://127.0.0.1:18000');
  await page.locator('#backend-custom').fill(backend);let targetNavigation=page.waitForNavigation();await page.locator('#backend-apply').click();await targetNavigation;
  await page.waitForFunction(()=>document.documentElement.dataset.connectionMode==='device');assert.equal(await page.evaluate(()=>window.RoasterBackend.url),backend);
  assert.equal(await page.evaluate(()=>window.RoasterAITransport.host.kind),'local');
  await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'设备连接',exact:true}).click();await page.locator('.device-backend summary').click();
  targetNavigation=page.waitForNavigation();await page.locator('#backend-preset-local').click();await targetNavigation;await page.waitForFunction(()=>document.documentElement.dataset.connectionMode==='device');
  checks.push('native service address selection and return to local runtime work through the real HTTP transport while AI stays local');
  await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'设备连接',exact:true}).click();
  await page.locator('#device-mode').selectOption('simulator');const navigation=page.waitForNavigation();await page.locator('#device-apply').click();await navigation;
  await page.waitForFunction(()=>document.documentElement.dataset.connectionMode==='simulator'&&document.querySelector('#quick-profile-select')?.value);
  await page.locator('[data-tab=roast]').click();await page.waitForFunction(()=>!document.querySelector('#btn-start').disabled);
  await page.evaluate(()=>{window.RoasterUI.confirm=async()=>false;});await page.locator('#btn-start').click();
  await page.waitForFunction(()=>document.querySelector('#state-badge').textContent==='烘焙中');
  await page.locator('[data-event=yellowing]').click();await page.locator('[data-event=yellowing].active').waitFor();
  await page.screenshot({path:join(out,'native-simulation-roast.png')});
  const settings={mode:'device',port:'',baudrate:9600,slave_id:1};
  assert.equal((await fetch(backend+'/api/v1/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).status,409);
  // The owned shutdown token is known only to Rust; unauthenticated callers cannot stop it.
  assert.equal((await fetch(backend+'/api/v1/runtime/shutdown',{method:'POST'})).status,403);
  await page.locator('[data-event=drop]').click();await page.waitForFunction(()=>document.querySelector('#state-badge').textContent==='待机');
  checks.push('actual packaged UI enumerates ports, switches transport only in settings, runs CC/End through the real controller in simulation, rejects active switching and unauthenticated shutdown');
  await page.locator('[data-tab=workbench]').click();await page.locator('#wb-new').click();await page.waitForFunction(()=>window.RoasterWorkbench.getSnapshot()?.document?.kind==='profile');
  checks.push('bundled Rust offline workbench remains available alongside the real device runtime');
  assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,backend,scope:'actual packaged Windows release EXE/WebView/Rust and bundled Python; physical serial auto-connect disabled, simulated heating only'},null,2));
  console.log(JSON.stringify({checks:checks.length,errors,output:out}));
} finally {
  if(backend)try{await fetch(backend+'/api/v1/control/discard_and_clear',{method:'POST'});}catch{}
  // Only the isolated test process is terminated; no user window or physical session is used.
  await browser?.close();if(child&&child.exitCode===null)child.kill();
  if(backend){const log=await readFile(join(dir,'app/device/service.log'),'utf8').catch(()=> '');await writeFile(join(out,'service.log'),log);}
  // A forced test teardown may leave an owned idle service; stop only its exact recorded PID.
  const state=await readFile(join(dir,'app/device/service.log'),'utf8').catch(()=> '');
  const pid=/Started server process \[(\d+)\]/.exec(state)?.[1];if(pid){try{process.kill(Number(pid));}catch{}}
  await new Promise(ok=>setTimeout(ok,500));assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
