// Actual Edge rendering, local simulator and deterministic saved OAuth sessions.
import {chromium} from 'playwright';
import {fauxProvider} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {startDevServer} from './dev-server.mjs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
async function chooseChatAccount(page,id){await page.getByRole('button',{name:'选择模型与账户',exact:true}).click();await page.locator('#ai-chat-profile').selectOption(id);await page.keyboard.press('Escape');}

const out=resolve(process.env.ROASTER_QA_DIR||'build/qa/editor-session');await mkdir(out,{recursive:true});
const data=await mkdtemp(join(tmpdir(),'roaster-editor-session-'));
const checks=[],errors=[],metrics=[];let service,host,browser,logins=0;
const faux=fauxProvider({provider:'openai'});
const oauth={name:'saved session fixture',isSubscription:true,
  async login(){logins++;throw Error('Restoring a session must not open OAuth');},
  async refresh(value){return {...value,expires:Date.now()+3600000};},async toAuth(value){return {apiKey:value.access};}};
const serviceFactory=options=>(service=new AIService({...options,providerFactories:{openai:()=>({...faux.provider,auth:{...faux.provider.auth,oauth}})}}));
async function account(name){
  const p=await service.dispatch('profiles.save',{profile:{name,provider:'openai',mode:'subscription',model:'faux-1'}});
  await service.vault.store(p.id).modify('openai',async()=>({type:'oauth',access:'editor-session-fixture',refresh:'editor-session-refresh',expires:Date.now()+3600000}));
  await service.dispatch('models',{profile_id:p.id,refresh:true});return p;
}
try {
  host=await startDevServer({port:0,freeze:true,dataDir:data,serviceFactory});
  const origin=host.origin,port=Number(new URL(origin).port),first=await account('账户一'),second=await account('账户二');
  const conversation=await service.dispatch('conversations.create',{profile_id:first.id,title:'保留的会话'});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1536,height:864}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.waitForFunction(()=>window.RoasterChat);
  await page.waitForFunction(()=>document.querySelector('#ai-chat-profile')?.options.length===2);
  await page.locator('#ai-launcher').click();await chooseChatAccount(page,second.id);
  await page.evaluate(id=>{const key=Object.keys(localStorage).find(k=>k.endsWith('.profile'));localStorage.setItem(key.replace(/profile$/,'conversation'),id);},conversation.id);
  await page.reload();await page.waitForFunction(id=>document.querySelector('#ai-chat-profile')?.value===id,second.id);
  assert.equal(logins,0);checks.push('reload restores the saved account even when the previous conversation used a different account');
  await host.close();host=await startDevServer({port,freeze:true,dataDir:data,serviceFactory});
  await page.reload();await page.waitForFunction(id=>document.querySelector('#ai-chat-profile')?.value===id,second.id);
  assert.equal((await page.evaluate(()=>window.RoasterChat.request('profiles.list'))).find(p=>p.id===second.id).can_chat,true);
  assert.equal(logins,0);checks.push('server restart restores encrypted login, selected account/model and history without opening OAuth');

  // A native debug WebView must use the same host instead of creating a new vault.
  const nativePage=await context.newPage();
  await nativePage.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:()=>Promise.reject(Error('Unexpected native AI vault')),transformCallback:()=>1};});
  await nativePage.goto(origin);await nativePage.waitForFunction(()=>document.querySelector('#ai-chat-profile')?.options.length===2);
  assert.equal(await nativePage.evaluate(()=>window.RoasterAITransport.host.kind),'backend');
  assert.equal((await nativePage.evaluate(()=>window.RoasterChat.request('profiles.list'))).length,2);await nativePage.close();
  checks.push('debug desktop transport reads the same saved accounts as the browser; packaged native routing is kept separate');

  for(const [width,height] of [[1848,1060],[1366,800],[1280,720],[1024,640],[820,800],[768,800],[375,812]]){
    await page.setViewportSize({width,height});
    await page.goto(origin+'/editor.html?ai=1&record_id=sim-record-0');
    await page.waitForFunction(()=>window.RoasterEditor&&document.querySelectorAll('.node-item').length>1);
    await page.evaluate(()=>{window.RoasterTheme.setPalette('sage');window.RoasterTheme.setMode('light');});
    await page.locator('.props-panel textarea').first().fill('保持前中段曲线，减少苦感，并逐次对照杯测。'.repeat(30));
    await page.evaluate(()=>document.fonts.ready);
    const layout=await page.evaluate(()=>{
      const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const main=rect('.editor-main'),meta=rect('.profile-meta-bar');
      return {width:innerWidth,main,meta,inputs:['#profile-name','#profile-desc','#profile-end-temp'].map(rect),
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        sidebar:rect('.props-panel'),nodeOverflow:getComputedStyle(document.querySelector('.nodes-list')).overflowY,
        canvas:rect('#editor-chart'),launch:rect('#ai-launcher')};
    });
    metrics.push(layout);assert.equal(layout.overflow,false,'horizontal overflow at '+width);
    for(const input of layout.inputs){assert.ok(input.bottom<=layout.main.y+1,'metadata covered at '+width);assert.ok(input.height>=44,'input target at '+width);}
    assert.ok(!['auto','scroll'].includes(layout.nodeOverflow),'nested node scrollbar at '+width);
    assert.equal(await page.locator('.editor-header #ai-launcher').count(),1);
    await page.evaluate(()=>{document.activeElement.blur();window.scrollTo(0,0);});
    if(width<=820){
      assert.equal(await page.evaluate(()=>getComputedStyle(document.body).overflowY),'visible');
      await page.locator('#sel-temp').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(()=>document.scrollingElement.scrollTop>0));await page.evaluate(()=>window.scrollTo(0,0));
    }
    await page.screenshot({path:join(out,'editor-'+width+'.png'),fullPage:width<821});
    await page.locator('#ai-launcher').click();await page.locator('#ai-chat:not([hidden])').waitFor();
    await chooseChatAccount(page,second.id);
    if(width>=1600){
      assert.equal(await page.locator('.editor-app').evaluate(n=>n.inert),false);
      const dock=await page.evaluate(()=>({chart:document.querySelector('#editor-chart').getBoundingClientRect().right,chat:document.querySelector('#ai-chat').getBoundingClientRect().left}));
      assert.ok(dock.chart<=dock.chat,'chat covers chart at '+width);
    }else if(width<1280){
      assert.equal(await page.locator('.editor-app').evaluate(n=>n.inert),true);
      assert.equal(await page.locator('#ai-chat').getAttribute('aria-modal'),'true');
    }
    await page.screenshot({path:join(out,'conversation-'+width+'.png')});
    if(width>=1280){await page.getByRole('button',{name:'更多对话选项',exact:true}).click();await page.getByRole('button',{name:'放大对话',exact:true}).click();}
    assert.equal(await page.locator('.editor-app').evaluate(n=>n.inert),true);
    const expanded=await page.locator('#ai-chat').boundingBox();assert.ok(expanded.width>=width-30);
    await page.locator('#ai-chat').getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(await page.locator('.editor-app').evaluate(n=>n.inert),false);
    assert.equal(await page.locator('#ai-launcher').evaluate(n=>n===document.activeElement),true);
  }
  checks.push('seven desktop/tablet/mobile sizes: metadata bounds, one sidebar scroll, toolbar AI entry, dock/expanded dialog and focus recovery');
  await page.setViewportSize({width:1366,height:800});await page.goto(origin+'/editor.html?ai=1&record_id=sim-record-0');
  await page.locator('.node-item').first().waitFor();await page.locator('.node-item').nth(1).click();
  const before=await page.evaluate(()=>window.RoasterEditor.getDraft().nodes[1].temperature);
  await page.locator('#sel-temp').fill(String(before+1));await page.locator('#sel-temp').dispatchEvent('change');
  assert.equal(await page.evaluate(()=>window.RoasterEditor.getDraft().nodes[1].temperature),before+1);
  await page.locator('#btn-undo').click();assert.equal(await page.evaluate(()=>window.RoasterEditor.getDraft().nodes[1].temperature),before);
  await page.evaluate(()=>window.RoasterTheme.setMode('dark'));await page.screenshot({path:join(out,'editor-dark.png')});
  checks.push('node editing and undo still work; light/dark renders inspected');
  assert.equal(logins,0);assert.deepEqual(errors,[]);
  await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,metrics,scope:'actual Edge renderer, safe simulator, deterministic OAuth; no real provider requests or hardware'},null,2));
  console.log(JSON.stringify({checks:checks.length,viewports:metrics.length,errors,output:out}));
}finally{
  await browser?.close();await host?.close();assert.ok(resolve(data).startsWith(resolve(tmpdir())+sep));await rm(data,{recursive:true,force:true});
}
