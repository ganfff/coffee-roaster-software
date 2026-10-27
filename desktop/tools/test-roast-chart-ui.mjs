// Current shared UI, real local AI service, synthetic provider and hardware-free simulator.
import {chromium} from 'playwright';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {startDevServer} from './dev-server.mjs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import assert from 'node:assert/strict';

const data=await mkdtemp(join(tmpdir(),'roaster-chart-'));
const out=resolve(process.env.ROASTER_QA_DIR||'../.impeccable/review/kl-chart');
await mkdir(out,{recursive:true});
let host,browser,service;
const errors=[],checks=[],layouts=[],requests=[];
const faux=fauxProvider({provider:'openai',tokensPerSecond:800});
faux.setResponses([fauxAssistantMessage('这是一条保留在历史里的测试回复。'),fauxAssistantMessage('正在生成曲线分析。'.repeat(1500)),...Array.from({length:6},()=>fauxAssistantMessage('保留选入的参考记录和锁定范围，供后续讨论。'))]);
try {
  host=await startDevServer({port:0,scenario:'idle',freeze:true,dataDir:data,serviceFactory:options=>{service=new AIService({...options,providerFactories:{openai:()=>faux.provider}});const dispatch=service.dispatch.bind(service);service.dispatch=(method,params)=>{if(method==='runs.start')requests.push(structuredClone(params));return dispatch(method,params);};return service;}});
  const account=await service.dispatch('profiles.save',{profile:{name:'图表验收合成账户',provider:'openai',mode:'api_key',model:'faux-1'},api_key:'fixture-only'});
  await service.dispatch('models',{profile_id:account.id,refresh:true});
  const status=()=>fetch(host.origin+'/api/v1/status').then(r=>r.json());
  assert.deepEqual((await status()).events,[]);
  assert.deepEqual((await status()).event_stats,{segment_times:{},segment_ratios:{}});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:800}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.origin);await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('#quick-profile-select')?.options.length===3&&document.querySelector('#ai-chat-profile')?.options.length===1);
  await page.waitForFunction(()=>Chart.getChart(document.querySelector('#roast-chart'))?.data.datasets[2].data.length>0);
  assert.equal(await page.locator('#event-actions-bar .active').count(),0);
  assert.equal(await page.locator('#event-actions-bar .event-badge').allTextContents().then(v=>v.join('')),'');
  const chart=await page.evaluate(()=>{const c=Chart.getChart(document.querySelector('#roast-chart'));return {markers:c.options.plugins.eventLines.compactMarkers,ticks:c.options.scales.x.ticks.stepSize,end:c.scales.x.max,series:c.data.datasets.map(d=>({width:d.borderWidth,fill:d.fill,tension:d.tension,dash:d.borderDash||[],points:d.data.length}))};});
  assert.equal(chart.markers,true);assert.equal(chart.ticks,60);assert.equal(chart.end,660);
  assert.deepEqual(chart.series[2].dash,[]);assert.equal(chart.series[3].fill,false);
  assert.ok(chart.series.slice(0,5).every(d=>d.width<=1.5&&d.tension===0));
  assert.equal(chart.series[0].points,0);assert.equal(chart.series[3].points,0);
  checks.push('idle backend/UI contain no sample events or phase stats; thin unfilled curves, minute axis and compact markers');
  for(const [width,height] of [[2048,1200],[1366,800],[1024,640],[375,812]]) {
    await page.setViewportSize({width,height});
    for(const mode of ['light','dark']) {
      await page.evaluate(mode=>window.RoasterTheme.setMode(mode),mode);
      await page.evaluate(()=>document.fonts.ready);
      const layout=await page.evaluate(()=>{
        const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const b=document.querySelector('#btn-e-stop'),r=b.getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth+1,bar:box('#event-actions-bar'),chart:box('#charts-panel'),buttons:[...document.querySelectorAll('.event-action-btn')].map(b=>({height:b.getBoundingClientRect().height,clipped:b.querySelector('.event-name').scrollWidth>b.querySelector('.event-name').clientWidth+1})),stop:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
      });
      assert.equal(layout.overflow,false);assert.equal(layout.stop,true);
      assert.ok(layout.bar.bottom<=layout.chart.bottom+1);
      assert.ok(layout.buttons.every(b=>b.height>=44&&b.height<=45&&!b.clipped));
      assert.ok(layout.bar.height<=(width===375?100:54));
      layouts.push({width,height,mode,...layout});
      await page.screenshot({path:join(out,`idle-${width}-${mode}.png`)});
      if(width===375){await page.locator('#event-actions-bar').scrollIntoViewIfNeeded();await page.screenshot({path:join(out,`events-${width}-${mode}.png`)});}
    }
  }
  checks.push('2048/1366/1024/375 light/dark: compact event bar, readable labels, no overflow, accessible emergency button');
  await page.setViewportSize({width:1366,height:800});
  await page.locator('#btn-start').click();await page.waitForFunction(()=>document.querySelector('#state-badge').textContent==='烘焙中');
  assert.equal((await status()).events.some(e=>e.type==='yellowing'),false);
  await page.locator('#event-actions-bar [data-event=yellowing]').click();
  await page.locator('#event-actions-bar [data-event=yellowing].active').waitFor();
  const marked=await status();
  assert.equal(marked.events.filter(e=>e.type==='yellowing').length,1);
  assert.equal(marked.event_stats.segment_times['脱水期'],0);
  assert.equal(marked.current_phase,'maillard');
  assert.equal(marked.events.find(e=>e.type==='charge').temperature,marked.pv);
  assert.match(await page.locator('#event-actions-bar [data-event=yellowing]').getAttribute('title'),/转黄.*0:00/);
  await page.screenshot({path:join(out,'manual-event.png')});
  await page.evaluate(()=>fetch('/api/v1/control/discard_and_clear',{method:'POST'}));
  await page.waitForFunction(()=>document.querySelector('#state-badge').textContent==='待机');
  assert.equal(await page.locator('#event-actions-bar .active').count(),0);
  assert.deepEqual((await status()).events,[]);
  checks.push('start adds no yellowing; explicit click writes one event; clearing the pot removes event state');

  const open=async()=>{await page.locator('#ai-launcher').click();await page.locator('#ai-chat:not([hidden])').waitFor();return page.evaluate(()=>window.RoasterChat.current.id);};
  const close=async()=>{await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('#ai-chat[hidden]').waitFor({state:'attached'});};
  const first=await open();
  await page.locator('#ai-prompt').fill('历史测试消息');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  await page.locator('#ai-prompt').fill('不要带到新窗口的草稿');await close();
  const second=await open();assert.notEqual(second,first);
  assert.equal(await page.locator('#ai-prompt').inputValue(),'');assert.equal(await page.locator('.ai-message').count(),0);
  assert.equal(await page.evaluate(()=>window.RoasterChat.current.messages.length),0);
  await page.getByRole('button',{name:'会话',exact:true}).click();
  await page.locator('.ai-history-item').filter({hasText:'历史测试消息'}).click();
  await page.waitForFunction(id=>window.RoasterChat.current?.id===id,first);
  assert.equal(await page.evaluate(()=>window.RoasterChat.current.id),first);
  assert.ok(await page.locator('.ai-message').count()>=2);await close();
  await page.reload();await page.waitForFunction(()=>document.querySelector('#ai-chat-profile')?.value);
  assert.equal(await page.evaluate(()=>window.RoasterChat.current),null);
  const third=await open();assert.notEqual(third,first);assert.notEqual(third,second);
  assert.equal(await page.evaluate(()=>window.RoasterChat.current.profile_id),account.id);
  await page.locator('#ai-prompt').fill('这条长回复将被停止');await page.locator('#ai-send').click();
  await page.locator('#ai-stop:not([hidden])').waitFor();await close();
  const fourth=await open();assert.notEqual(fourth,third);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>window.RoasterChat.current.id),fourth);
  assert.equal(await page.locator('.ai-message').count(),0);
  assert.equal((await service.dispatch('conversations.get',{id:third})).messages.at(-1).status,'cancelled');
  await page.screenshot({path:join(out,'new-chat.png')});await close();
  await page.evaluate(()=>{window.dispatchEvent(new Event('roaster-ai-open'));});
  await page.locator('#ai-chat:not([hidden])').waitFor();
  const fifth=await page.evaluate(()=>window.RoasterChat.current.id);assert.notEqual(fifth,fourth);await close();
  await page.locator('[data-tab=settings]').click();await page.getByRole('tab',{name:'AI 账户',exact:true}).click();
  await page.locator('.ai-settings-chat').click();await page.locator('#ai-chat:not([hidden])').waitFor();
  assert.notEqual(await page.evaluate(()=>window.RoasterChat.current.id),fifth);
  checks.push('launcher/reload/context/settings create fresh chats and clear drafts; history remains explicit; hidden streaming reply is cancelled without late transcript restoration');
  await close();await page.setViewportSize({width:2048,height:1200});await page.goto(host.origin+'/editor.html?ai=1');
  await page.waitForFunction(()=>window.RoasterEditor&&window.RoasterChat&&document.querySelector('#ai-chat-profile')?.value);
  await page.evaluate(()=>window.RoasterEditor.ready);
  await page.locator('[name=locked_until]').fill('60');
  await page.locator('[name=reference_record] option[value=sim-record-0]').waitFor({state:'attached'});
  await page.locator('[name=reference_record]').selectOption('sim-record-0');
  const complete=()=>page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  await page.getByRole('button',{name:'生成／调整曲线',exact:true}).click();await complete();
  const designFirst=await page.evaluate(()=>window.RoasterChat.current.id);
  assert.equal(requests.at(-1).locked_until,60);assert.equal(requests.at(-1).context.reference_record.session_id,'sim-record-0');
  await page.locator('#ai-prompt').fill('继续讨论这一方案');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.length>=4&&window.RoasterChat.current.messages.at(-1).status==='completed');
  assert.equal(requests.at(-1).conversation_id,designFirst);assert.equal(requests.at(-1).locked_until,60);assert.equal(requests.at(-1).context.reference_record.session_id,'sim-record-0');
  await page.getByRole('button',{name:'生成／调整曲线',exact:true}).click();
  await page.waitForFunction(id=>window.RoasterChat.current?.id!==id&&window.RoasterChat.current?.messages.at(-1)?.status==='completed',designFirst);
  const designSecond=await page.evaluate(()=>window.RoasterChat.current.id);
  assert.equal(requests.at(-1).locked_until,60);assert.equal(requests.at(-1).context.reference_record.session_id,'sim-record-0');
  await page.screenshot({path:join(out,'editor-context-new-chat.png')});
  // Automatic coaching uses analyze's default continuation, independently of explicit entry buttons.
  await page.evaluate(async()=>{const target=document.createElement('div');document.body.append(target);window.qaCoaching=window.RoasterChat.mountContext(target,{kind:'chat',title:'验收持续辅导',getContext:async()=>({captured_at:new Date().toISOString()})});await window.qaCoaching.analyze('自动辅导快照');});
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.length>=4&&window.RoasterChat.current.messages.at(-1).status==='completed');
  assert.equal(requests.at(-1).conversation_id,designSecond);
  checks.push('explicit editor entry starts fresh with panel hidden or docked; follow-ups retain lock/reference; automatic analysis continues the current chat');
  assert.deepEqual(errors,[]);
  await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,layouts,scope:'real shared Web UI and local service; simulated hardware and synthetic AI only'},null,2));
  console.log(JSON.stringify({checks:checks.length,errors,output:out}));
} finally {
  await browser?.close();await host?.close();
  assert.ok(resolve(data).startsWith(resolve(tmpdir())+sep));await rm(data,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
