// Actual Windows dev EXE/WebView/Rust, isolated AI fixture, safe simulator only.
import {chromium} from 'playwright';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {startDevServer} from './dev-server.mjs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'roaster-instrument-native-')),out=resolve(process.env.ROASTER_QA_DIR||'build/qa/instrument-v3.29/native');await mkdir(out,{recursive:true});
const faux=fauxProvider({provider:'openai',tokensPerSecond:800});faux.setResponses([fauxAssistantMessage('转黄已记录，可以先比较一爆前后的升温率。\n\n**下一锅的对照**\n- 保留前段曲线。\n- 结合杯测再决定发展期。\n\n调整先进入草稿，由你确认后保存。')]);
let host,service,browser,child;const errors=[],checks=[];
try {
  host=await startDevServer({port:18180,scenario:'roasting',freeze:true,dataDir:join(dir,'host'),serviceFactory:options=>(service=new AIService({...options,providerFactories:{openai:()=>faux.provider}}))});
  await service.dispatch('profiles.save',{profile:{name:'本机界面验收 · 合成账户',provider:'openai',mode:'api_key',model:'faux-1'},api_key:'native-fixture-only'});
  service.emit({id:'old-completed-login',type:'auth_notify',data:{url:host.origin+'/old-login'}});service.emit({id:'old-completed-login',type:'auth_done',data:{can_chat:true}});
  const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  child=spawn(resolve('src-tauri/target/debug/roaster-desktop.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(dir,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  const endpoint='http://127.0.0.1:'+port,deadline=Date.now()+25000;
  for(;;){try{if((await fetch(endpoint+'/json/version')).ok)break;}catch{}if(Date.now()>deadline)throw Error('native WebView did not start');await new Promise(ok=>setTimeout(ok,150));}
  browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__&&window.ROASTER_DEBUG&&document.querySelector('#ai-chat-profile')?.options.length===1);
  await page.locator('.connection-copy').filter({hasText:'安全模拟器'}).waitFor();
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('#rpb-phase-label').textContent!=='待机'&&document.querySelector('#delta-val').textContent!=='--');
  assert.equal(await page.evaluate(()=>window.RoasterAITransport.host.kind),'backend');
  assert.equal(await page.evaluate(async()=>await fetch('/css/instrument.css').then(r=>r.text())),await readFile(resolve('../roaster/static/css/instrument.css'),'utf8'));checks.push('actual dev WebView loads current instrument styles, safe simulator and isolated local AI account');
  await page.evaluate(()=>{window.RoasterTheme.setPalette('graphite');window.RoasterTheme.setMode('light');});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,'native-roast.png')});
  await page.getByRole('button',{name:'AI 对话',exact:true}).click();await page.locator('#ai-prompt').fill('如何对照这锅的曲线？');await page.locator('#ai-send').click();await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');await page.screenshot({path:join(out,'native-chat.png')});
  await page.evaluate(()=>window.RoasterTheme.setMode('dark'));await page.screenshot({path:join(out,'native-chat-dark.png')});
  await page.getByRole('button',{name:'更多对话选项',exact:true}).click();await page.getByRole('button',{name:'放大对话',exact:true}).click();await page.screenshot({path:join(out,'native-expanded.png')});
  assert.equal(await page.evaluate(()=>{const b=document.querySelector('#btn-e-stop'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);checks.push('native light/dark streamed conversation, expanded view and unobstructed emergency button');
  await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('[data-tab=workbench]').click();await page.locator('#wb-new').click();await page.waitForFunction(()=>window.RoasterWorkbench.getSnapshot()?.document?.kind==='profile');checks.push('actual Rust offline worker still creates a native document after shared control changes');
  assert.equal(service.logins.size,0);assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),scope:'actual Windows dev EXE/WebView/Rust with live source and isolated synthetic AI; no installation, real provider login or physical device'},null,2));console.log(JSON.stringify({checks:checks.length,errors,output:out}));
} finally {await browser?.close();child?.kill();await host?.close();await new Promise(ok=>setTimeout(ok,500));assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
