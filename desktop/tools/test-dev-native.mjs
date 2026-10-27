// Exercise the real dev EXE against the already-running live-source debug host.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'roaster-dev-native-')),out=resolve(process.env.ROASTER_QA_DIR||'../docs/qa/workspace-v3.26/native-dev');await mkdir(out,{recursive:true});
const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
const child=spawn(resolve('src-tauri/target/debug/roaster-desktop.exe'),[],{windowsHide:true,env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:dir,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:'ignore'});
let browser;const checks=[],errors=[];
try {
  const endpoint='http://127.0.0.1:'+port,end=Date.now()+20000;
  for(;;){try{if((await fetch(endpoint+'/json/version')).ok)break;}catch{}if(Date.now()>end)throw Error('native CDP timeout');await new Promise(ok=>setTimeout(ok,150));}
  browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__&&window.ROASTER_DEBUG&&window.RoasterChat);
  assert.equal(new URL(page.url()).hostname,'127.0.0.1');await page.locator('.connection-copy').filter({hasText:'模拟器'}).waitFor();checks.push('actual dev WebView loads live source via HTTP and safe simulator WS');
  await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'AI 账户',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ai-config-form h4'));checks.push('real Rust AI pairing/RPC loads the real debug AI providers');
  await page.screenshot({path:join(out,'native-settings.png')});
  await page.locator('[data-tab=workbench]').click();await page.locator('#wb-new').click();await page.waitForFunction(()=>window.RoasterWorkbench.getSnapshot()?.document?.kind==='profile');checks.push('actual Rust offline worker creates native profile in dev mode');
  await page.screenshot({path:join(out,'native-workbench.png')});assert.deepEqual(errors,[]);await writeFile(join(out,'native-report.json'),JSON.stringify({checks,errors,url:page.url(),evidence:'actual dev EXE/WebView/Rust against live debug host; no installation, fake AI provider or hardware'},null,2));console.log(JSON.stringify({checks:checks.length,errors},null,2));
}finally{if(browser)await browser.close();child.kill();await new Promise(ok=>setTimeout(ok,300));assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
