// Real shared UI/service and hardware-free simulator. All OAuth/model data is synthetic.
import {chromium} from 'playwright';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {startDevServer} from './dev-server.mjs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const out=resolve(process.env.ROASTER_QA_DIR||'build/qa/mhub-v3.30/browser');
const data=await mkdtemp(join(tmpdir(),'roaster-instrument-'));await mkdir(out,{recursive:true});
const checks=[],errors=[],layouts=[];let service,host,browser,origin,loginCalls=0,opened=0;
const faux=fauxProvider({provider:'openai',tokensPerSecond:800});
faux.setResponses(Array.from({length:8},()=>fauxAssistantMessage('可以先对照当前记录。\n**从温度曲线开始**\n- 转黄已记录，先保留前段参数。\n- 比较一爆前后的升温率，再决定下一锅的调整。\n\n这次分析只提出建议，采用和保存由你确认。')));
const oauth={name:'instrument fixture',isSubscription:true,
  async login(interaction){loginCalls++;interaction.notify({type:'auth_url',url:origin+'/fixture-login'});interaction.notify({type:'auth_url',url:origin+'/fixture-login'});await interaction.prompt({type:'text',message:'完成测试授权'});return {type:'oauth',access:'instrument-fixture',refresh:'instrument-fixture',expires:Date.now()+3600000};},
  async refresh(value){return {...value,expires:Date.now()+3600000};},async toAuth(value){return {apiKey:value.access};}};
const factory=options=>(service=new AIService({...options,providerFactories:{openai:()=>({...faux.provider,auth:{...faux.provider.auth,oauth}})}}));
const legacy=()=>{service.emit({id:'historical-login',type:'auth_notify',data:{url:origin+'/fixture-login'}});service.emit({id:'historical-login',type:'auth_done',data:{can_chat:true}});};
async function ready(page){await page.waitForFunction(()=>window.RoasterChat&&document.querySelector('#ai-chat-profile')?.options.length>0);}
async function choose(page,id){await page.getByRole('button',{name:'选择模型与账户',exact:true}).click();await page.locator('#ai-chat-profile').selectOption(id);await page.keyboard.press('Escape');}
async function capture(page,name){
  if(name.startsWith('roast-'))await page.waitForFunction(()=>document.querySelector('#quick-profile-select')?.value&&document.querySelector('#delta-val')?.textContent!=='--'&&document.querySelector('#rpb-phase-label')?.textContent!=='待机');
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:join(out,name+'.png')});
}
async function bounds(page,label){const result=await page.evaluate(()=>{
  const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
  const stop=document.querySelector('#btn-e-stop'),r=stop.getBoundingClientRect();
  const stage=[...document.querySelectorAll('.segment.active')].filter(visible).map(n=>({label:rect(n.firstElementChild),value:rect(n.lastElementChild)}));
  const chat=document.querySelector('#ai-chat');
  const chart=document.querySelector('#charts-panel'),timeline=document.querySelector('#event-actions-bar');
  return {viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth+1,
    stopVisible:stop.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),stage,
    chat:chat.hidden?null:rect(chat),prompt:chat.hidden?null:rect(document.querySelector('#ai-prompt')),
    send:chat.hidden?null:rect(document.querySelector('#ai-send')),
    chart:visible(chart)?rect(chart):null,timeline:visible(timeline)?rect(timeline):null,
    truncation:[...document.querySelectorAll('.seg-name,.seg-val,.event-temp-val')].filter(visible).filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.textContent)};
  });layouts.push({label,...result});assert.equal(result.overflow,false,label+' horizontal overflow');assert.equal(result.stopVisible,true,label+' emergency access');assert.deepEqual(result.truncation,[],label+' measurement clipping');
  for(const row of result.stage)assert.ok(row.label.right<=row.value.x+1,label+' overlapping phase text');
  if(result.chart&&result.timeline)assert.ok(result.timeline.bottom<=result.chart.bottom+1,label+' event timeline clipped by chart');
  if(result.chat){assert.ok(result.prompt.height>=44,label+' composer target');assert.ok(result.send.bottom<=result.chat.bottom+1,label+' send outside chat');assert.ok(result.prompt.width>=120,label+' composer usable width');}
}
try {
  host=await startDevServer({port:0,scenario:'roasting',freeze:true,dataDir:data,serviceFactory:factory});origin=host.origin;
  const saved=await service.dispatch('profiles.save',{profile:{name:'已保存的 ChatGPT 账户',provider:'openai',mode:'subscription',model:'faux-1'}});
  await service.vault.store(saved.id).modify('openai',async()=>({type:'oauth',access:'saved-instrument-fixture',refresh:'saved-instrument-fixture',expires:Date.now()-1000}));await service.dispatch('models',{profile_id:saved.id,refresh:true});legacy();
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1366,height:800},reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('recordFixtureBrowserOpen',()=>{opened++;});await page.addInitScript(()=>{window.open=()=>{void window.recordFixtureBrowserOpen();return {opener:null,location:{replace(){}}};};});
  await page.goto(origin);await ready(page);await page.waitForFunction(()=>document.querySelector('#pv-val').textContent!=='--');
  assert.equal(loginCalls,0);assert.equal(opened,0);assert.equal((await page.evaluate(()=>window.RoasterChat.request('profiles.list')))[0].can_chat,true);checks.push('expired saved OAuth refresh restores silently; retained auth events do not open a browser');
  await page.getByRole('button',{name:'AI 对话',exact:true}).click();await page.locator('#ai-prompt').fill('分析这锅的转黄与升温率');await page.locator('#ai-send').click();await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  const conversation=await page.evaluate(()=>window.RoasterChat.current.id);
  for(let i=0;i<2;i++){await page.reload();await ready(page);await page.waitForFunction(id=>window.RoasterChat.current?.id===id,conversation);}
  assert.equal(opened,0);assert.equal(loginCalls,0);checks.push('two page reloads replay old authorization but keep the account, model and transcript without login');
  await page.goto(origin+'/?settings=ai');await ready(page);await page.getByRole('button',{name:'添加账户',exact:true}).click();await page.getByRole('button',{name:'使用 ChatGPT 登录',exact:true}).click();await page.locator('input[aria-label="完成测试授权"]').waitFor();
  assert.equal(loginCalls,1);assert.equal(opened,1);await page.locator('input[aria-label="完成测试授权"]').fill('fixture-only');await page.getByRole('button',{name:'提交授权信息',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ai-account-state')?.textContent==='可以开始对话');
  await page.reload();await ready(page);await page.waitForFunction(()=>document.querySelector('.ai-account-state')?.textContent==='可以开始对话');assert.equal(opened,1);assert.equal(loginCalls,1);checks.push('explicit login opens once despite duplicate notifications; completed login never reopens on startup');
  const port=Number(new URL(origin).port);await host.close();host=await startDevServer({port,scenario:'roasting',freeze:true,dataDir:data,serviceFactory:factory});legacy();await page.reload();await ready(page);await page.waitForFunction(()=>document.querySelector('.ai-account-state')?.textContent==='可以开始对话');assert.equal(opened,1);assert.equal(loginCalls,1);checks.push('actual service restart restores encrypted account state with no new login or browser opening');
  await page.goto(origin);await ready(page);await page.evaluate(()=>{window.RoasterTheme.setPalette('graphite');window.RoasterTheme.setMode('light');});
  for(const [width,height] of [[2048,1200],[1366,800],[1024,640],[375,812]]){
    await page.setViewportSize({width,height});await page.locator('[data-tab=roast]').click();await bounds(page,'roast-'+width);await capture(page,'roast-'+width);
    await page.locator('.event-details summary').click();await page.locator('.event-details').scrollIntoViewIfNeeded();await bounds(page,'event-details-'+width);await page.locator('.event-details summary').click();
    await page.getByRole('button',{name:'AI 对话',exact:true}).click();await choose(page,saved.id);await bounds(page,'chat-'+width);await capture(page,'chat-'+width);
    await page.getByRole('button',{name:'选择模型与账户',exact:true}).click();await capture(page,'models-'+width);await bounds(page,'models-'+width);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'更多对话选项',exact:true}).click();await capture(page,'options-'+width);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'会话',exact:true}).click();await page.locator('#ai-history-search').fill('分析');assert.ok(await page.locator('.ai-history-item').count()>0);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  }
  checks.push('2048/1366/1024/375: curve, phase rows, full event values, chat, model/options/history menus and E-STOP remain usable');
  await page.setViewportSize({width:1366,height:800});await page.evaluate(()=>window.RoasterTheme.setMode('dark'));await capture(page,'roast-dark');await page.getByRole('button',{name:'AI 对话',exact:true}).click();await capture(page,'chat-dark');
  await page.getByRole('button',{name:'新对话',exact:true}).click();await page.locator('.ai-chat-welcome').waitFor();await capture(page,'chat-empty-dark');
  await page.setViewportSize({width:844,height:390});await bounds(page,'landscape');await capture(page,'chat-landscape');
  await page.setViewportSize({width:1366,height:800});await page.getByRole('button',{name:'更多对话选项',exact:true}).click();await page.getByRole('button',{name:'放大对话',exact:true}).click();await bounds(page,'expanded');await capture(page,'chat-expanded');
  await page.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>{document.body.style.zoom='1.3';window.dispatchEvent(new Event('resize'));});await bounds(page,'roast-130-percent');await capture(page,'roast-130-percent');checks.push('dark, expanded, short landscape and 130% UI scaling checked with real rendering');
  assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,layouts,scope:'real Edge rendering, actual local AI persistence and deterministic OAuth/stream; safe simulated roast, no physical device or real subscription login'},null,2));console.log(JSON.stringify({checks:checks.length,errors,output:out},null,2));
} finally {await browser?.close();await host?.close();assert.ok(resolve(data).startsWith(resolve(tmpdir())+sep));await rm(data,{recursive:true,force:true});}
