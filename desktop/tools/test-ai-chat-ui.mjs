// Real shared AI core + deterministic faux model + hardware-free simulator.
import {chromium} from 'playwright';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {WebSocketServer,WebSocket} from 'ws';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,dirname,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
async function chooseChatAccount(page,id){await page.getByRole('button',{name:'选择模型与账户',exact:true}).click();await page.locator('#ai-chat-profile').selectOption(id);await page.keyboard.press('Escape');}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),output=resolve(process.env.ROASTER_QA_DIR||resolve(root,'docs/qa/workspace-v3.26'));
const nativeSmoke=process.argv.includes('--native');
await mkdir(output,{recursive:true});
const dir=await mkdtemp(join(tmpdir(),'roaster-chat-ui-'));
const faux=fauxProvider({provider:'openai',tokensPerSecond:250});
faux.setResponses(Array.from({length:40},(_,i)=>fauxAssistantMessage('第 '+(i+1)+' 次回复：根据真实快照分析，保留手动采用与保存。\n**过程依据**\n- 不编造缺失事件。')));
const clients=new Set(),events=[];
const fixtureOAuth={name:'UI fixture',isSubscription:true,async login(interaction){interaction.notify({type:'message',message:'本机测试授权，无云端调用'});return {type:'oauth',access:'ui-fixture-oauth',refresh:'ui-fixture-refresh',expires:Date.now()+3600000};},async refresh(value){return value;},async toAuth(value){return {apiKey:value.access};}};
const service=new AIService({providerFactories:{openai:()=>({...faux.provider,auth:{...faux.provider.auth,oauth:fixtureOAuth}})},emit:event=>{events.push(event);for(const client of clients)if(client.readyState===1)client.send(JSON.stringify({cursor:events.length,events:[event]}));}});
await service.initialize({data_dir:dir,master_key:randomBytes(32).toString('base64')});
const p1=await service.dispatch('profiles.save',{profile:{name:'测试渠道一',mode:'api_key',provider:'openai',model:'faux-1'},api_key:'local-fixture-secret'});
const p2=await service.dispatch('profiles.save',{profile:{name:'测试渠道二',mode:'api_key',provider:'openai',model:'faux-1'},api_key:'local-fixture-secret-2'});
const sim=spawn(process.execPath,[resolve(root,'desktop/tools/roaster-simulator.mjs'),'--scenario=idle','--freeze'],{env:{...process.env,ROASTER_SIM_PORT:'0',WORKBENCH_SOURCE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,simOrigin,nativeChild,bootstrap;
await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('simulator startup timeout')),15000);sim.stdout.on('data',chunk=>{const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk));if(m){simOrigin=m[1];clearTimeout(timer);ok();}});sim.once('exit',()=>no(Error('simulator exit')));});
let paired=false,localModelCalls=0,browserOpenHits=0;
async function body(req){let text='';for await(const chunk of req)text+=chunk;return text?JSON.parse(text):{};}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
const handler=async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  try{
    if(path==='/fixture-browser-open'){browserOpenHits++;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><title>浏览器打开验证完成</title><main><h1>默认浏览器已成功打开</h1><p>此页面仅验证咖啡烘焙机控制台的浏览器入口，无需登录。</p></main>');return;}
    if(path==='/fixture-llm/v1/models')return json(res,200,{data:[{id:'native-local',display_name:'本地协议测试模型'}]});
    if(path==='/fixture-llm/v1/chat/completions'){
      const input=await body(req);assert.equal(req.headers.authorization,undefined);localModelCalls++;
      assert.ok(input.messages.some(m=>m.role==='user'));
      const chunk=(delta,finish_reason=null)=>({id:'native-local-'+localModelCalls,object:'chat.completion.chunk',created:1,model:'native-local',choices:[{index:0,delta,finish_reason}]});
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk({role:'assistant',content:'本机离线链路第 '+localModelCalls+' 轮回复'}))+'\n\n');res.write('data: '+JSON.stringify({...chunk({},'stop'),usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\n');res.end('data: [DONE]\n\n');return;
    }
    if(!path.startsWith('/api/v1/ai')){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}}
  if(path==='/api/v1/ai/status')return json(res,200,{ready:true,paired:!nativeSmoke||paired});
    if(path==='/api/v1/ai/pair'){const input=await body(req);if(input.code!=='12345678')return json(res,403,{detail:'配对码无效'});paired=true;res.setHeader('Set-Cookie','fixture=paired; HttpOnly; SameSite=Strict');return json(res,200,{id:'fixture-client',...(input.native?{token:'native-qa-token-only'}:{})});}
    if(path==='/api/v1/ai/events'){await new Promise(ok=>setTimeout(ok,150));const after=Number(new URL(req.url,'http://localhost').searchParams.get('after')||0);return json(res,200,{cursor:events.length,events:events.slice(after)});}
  if(path==='/api/v1/ai/rpc'){if(nativeSmoke&&!paired)return json(res,401,{detail:'未启用设备共享'});const input=await body(req);return json(res,200,await service.dispatch(input.method,input.params||{}));}
    if(path.startsWith('/api/')){const data=req.method==='POST'||req.method==='PATCH'?JSON.stringify(await body(req)):undefined;const result=await fetch(simOrigin+req.url,{method:req.method,headers:data?{'Content-Type':'application/json'}:undefined,body:data});res.writeHead(result.status,{'Content-Type':result.headers.get('Content-Type')||'application/json'});res.end(Buffer.from(await result.arrayBuffer()));return;}
    const file=resolve(root,'roaster/static','.'+(path==='/'?'/index.html':decodeURIComponent(path)));if(!file.startsWith(resolve(root,'roaster/static')+String.fromCharCode(92))&&!file.startsWith(resolve(root,'roaster/static')+'/'))throw Error('path');
    const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2'};
    const bytes=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(bytes);
  }catch(error){json(res,error.code==='CONFLICT'?409:422,{detail:error.message});}
};
const server=createServer(handler);
const chatWs=new WebSocketServer({noServer:true}),controlWs=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.url.startsWith('/api/v1/ai/ws'))chatWs.handleUpgrade(req,socket,head,ws=>{clients.add(ws);ws.on('close',()=>clients.delete(ws));});else controlWs.handleUpgrade(req,socket,head,ws=>{const upstream=new WebSocket(simOrigin.replace('http','ws')+'/ws');upstream.on('message',bytes=>{if(ws.readyState===1)ws.send(bytes.toString());});ws.on('message',bytes=>{if(upstream.readyState===1)upstream.send(bytes.toString());});ws.on('close',()=>upstream.close());upstream.on('error',()=>ws.close());});});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const checks=[],errors=[];
try{
  if(nativeSmoke){
    // Guard default startup URL with a hardware-free fixture before starting Tauri.
    bootstrap=createServer(handler);bootstrap.on('upgrade',(req,socket,head)=>controlWs.handleUpgrade(req,socket,head,ws=>{const upstream=new WebSocket(simOrigin.replace('http','ws')+'/ws');upstream.on('message',bytes=>{if(ws.readyState===1)ws.send(bytes.toString());});ws.on('close',()=>upstream.close());upstream.on('error',()=>ws.close());}));
    await new Promise((ok,no)=>{bootstrap.once('error',no);bootstrap.listen(8000,'127.0.0.1',ok);});
    const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const debugPort=reservation.address().port;await new Promise(ok=>reservation.close(ok));
    nativeChild=spawn(resolve(root,'desktop/src-tauri/target/release/roaster-desktop.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(dir,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+debugPort}});
    const debugging='http://127.0.0.1:'+debugPort;const end=Date.now()+25000;
    for(;;){try{const response=await fetch(debugging+'/json/version');if(response.ok)break;}catch{}if(Date.now()>end)throw Error('native WebView CDP unavailable');await new Promise(ok=>setTimeout(ok,200));}
    browser=await chromium.connectOverCDP(debugging);
    const context=browser.contexts()[0];let page=context.pages()[0];if(!page)page=await context.waitForEvent('page');
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>window.__TAURI_INTERNALS__&&window.RoasterChat);
    await page.evaluate(url=>window.RoasterNativeAI.invoke('ai_open_external',{url}),origin+'/fixture-browser-open');
    const browserDeadline=Date.now()+15000;while(!browserOpenHits){if(Date.now()>browserDeadline)throw Error('OS browser did not request the local verification page');await new Promise(ok=>setTimeout(ok,100));}
    checks.push('actual release WebView → Rust → Windows default browser → local verification HTTP request');
    assert.equal(await page.evaluate(()=>window.RoasterChat.host),'local');
    await page.evaluate(()=>localStorage.setItem('roaster.backendUrl','http://127.0.0.1:9'));await page.reload();
    await page.waitForFunction(()=>window.RoasterChat?.host==='local');
    await page.locator('#backend-connection-notice').waitFor();
    const localProfile=await page.evaluate(async url=>{const p=await window.RoasterChat.request('profiles.save',{profile:{name:'本机离线链路验收',mode:'custom',provider:'custom',base_url:url+'/fixture-llm/v1',protocol:'openai-completions'}});await window.RoasterChat.request('models',{profile_id:p.id,refresh:true});await window.RoasterChat.refresh();return p;},origin);
    let localConversation;
    try {
      await page.getByRole('button',{name:'AI 对话',exact:true}).click();await chooseChatAccount(page,localProfile.id);
      await page.getByRole('button',{name:'新对话',exact:true}).click();await page.waitForFunction(id=>window.RoasterChat.current?.profile_id===id,localProfile.id);localConversation=await page.evaluate(()=>window.RoasterChat.current.id);
      await page.locator('#ai-prompt').fill('本机第一轮离线链路检查');await page.locator('#ai-send').click();await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.content?.includes('第 1 轮回复')&&window.RoasterChat.current.messages.at(-1).status==='completed');
      await page.locator('#ai-prompt').fill('继续第二轮');await page.locator('#ai-send').click();await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.content?.includes('第 2 轮回复')&&window.RoasterChat.current.messages.at(-1).status==='completed');
      localConversation=await page.evaluate(()=>window.RoasterChat.current.id);assert.equal(localModelCalls,2);assert.equal(paired,false);
      await page.screenshot({path:resolve(output,'native-local-chat.png')});checks.push('fresh packaged desktop defaults to local AI: catalog + two real IPC/SDK streamed turns with device backend unreachable and no shared AI pairing');
    } finally {
      if(localConversation)await page.evaluate(id=>window.RoasterChat.request('conversations.delete',{id}),localConversation);
      await page.evaluate(id=>window.RoasterChat.request('profiles.delete',{id}),localProfile.id);
    }
    await page.evaluate(url=>{localStorage.setItem('roaster.backendUrl',url);localStorage.setItem('roaster.ai.host','backend');},origin);await page.reload();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>window.RoasterChat?.host==='local');
    assert.equal(await page.evaluate(()=>window.RoasterAITransport.host.kind),'local');assert.equal(paired,false);
    checks.push('legacy remote selection is ignored; desktop keeps local accounts after backend changes');
    assert.equal(await page.evaluate(()=>!!window.__TAURI_INTERNALS__),true);
    for(const resource of ['css/atlas.css','css/theme.css','js/atlas.js','js/app.js','js/ai-chat.js','js/ai-bridge.js','js/workspace-settings.js','index.html']) {
      const embedded=await page.evaluate(async resource=>{const response=await fetch(new URL(resource,location.href));return response.text();},resource);
      let source=await readFile(resolve(root,'roaster/static',resource),'utf8'),packaged=embedded;
      // Tauri parses HTML and injects its IPC bootstrap/CSP into <head>.
      // Compare the parsed app-owned body, while other resources remain byte exact.
      if(resource==='index.html')[packaged,source]=await page.evaluate(values=>values.map(value=>new DOMParser().parseFromString(value,'text/html').body.outerHTML),[embedded,source]);
      const digest=value=>createHash('sha256').update(value.replace(/^\uFEFF/,'')).digest('hex');
      assert.equal(digest(packaged),digest(source),'packaged resource must match current source: '+resource);
    }
    await page.locator('[data-tab="settings"]').click();await page.getByRole('tab',{name:'AI 账户',exact:true}).click();await page.waitForTimeout(450);assert.equal(await page.getByText('高级与设备共享',{exact:true}).count(),0);await page.screenshot({path:resolve(output,'native-tauri-settings.png')});checks.push('packaged resources match current source and local-only settings have no device sharing');
    await page.locator('[data-tab="workbench"]').click();await page.locator('#wb-new').click();await page.waitForFunction(()=>document.querySelector('#wb-root').getAttribute('aria-busy')==='false');
    await page.locator('#wb-help').click();await page.locator('[data-help-category="parameters"]').click();assert.equal(await page.locator('.wb-help-article').count(),144);
    assert.equal(await page.evaluate(()=>{const b=document.querySelector('#btn-e-stop'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
    await page.screenshot({path:resolve(output,'native-tauri-workbench-help.png')});checks.push('packaged numerical engine, 144-field offline help and unobstructed E-STOP');
    assert.deepEqual(errors,[]);await writeFile(resolve(output,'native-ui-report.json'),JSON.stringify({checks,errors,evidence:'actual Tauri release WebView/Rust + packaged native engine; deterministic AI fixture, no cloud/hardware'},null,2));
    console.log(JSON.stringify({checks:checks.length,output,errors,native:true},null,2));
  }else{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:800}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.getByRole('button',{name:'AI 对话',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-chat-profile')?.options.length===2);
  await page.locator('#ai-prompt').fill('先讨论烘焙曲线');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  await page.locator('#ai-prompt').fill('继续上一条');await chooseChatAccount(page,p2.id);await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.length===4&&window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  assert.equal((await page.evaluate(()=>window.RoasterChat.current)).profile_id,p2.id);
  assert.equal(await page.locator('.ai-message-user').count(),2);checks.push('local service, full multi-turn transcript and manual channel handoff');
  const id=await page.evaluate(()=>window.RoasterChat.current.id);
  await page.reload();await page.getByRole('button',{name:'AI 对话',exact:true}).click();await page.waitForFunction(id=>window.RoasterChat.current?.id===id,id);
  assert.equal(await page.locator('.ai-message-user').count(),2);checks.push('history restored after page reload');
  await page.getByRole('button',{name:'会话',exact:true}).click();
  await page.locator('#ai-history-search').fill('先讨论');assert.ok(await page.locator('.ai-history-item').count()>=1);
  await page.locator('#ai-history-search').fill('无匹配内容');assert.equal(await page.locator('.ai-history-item').count(),0);
  await page.locator('#ai-history-search').fill('');await page.getByRole('button',{name:'会话',exact:true}).click();checks.push('history filtering');
  await page.getByRole('button',{name:'编辑后重发',exact:true}).first().click();
  await page.locator('#ai-prompt').fill('编辑后的问题');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed'&&window.RoasterChat.current.messages[0].content==='编辑后的问题');
  assert.ok((await service.dispatch('conversations.list')).some(c=>c.archived_branch));checks.push('edit and resend preserves archived original');
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('[data-tab="settings"]').click();await page.getByRole('tab',{name:'AI 账户',exact:true}).click();await page.locator('#ai-config-list button').first().waitFor();
  await page.waitForTimeout(450);await page.screenshot({path:resolve(output,'settings-light-1366.png')});
  const layout=await page.evaluate(()=>[...document.querySelectorAll('.settings-grid > .settings-card')].filter(n=>getComputedStyle(n).display!=='none').map(n=>({text:n.querySelector('h3')?.textContent,...Object.fromEntries(['x','y','width','height'].map(k=>[k,n.getBoundingClientRect()[k]]))})));
  assert.equal(layout.length,1);assert.equal(layout[0].text,'本机 AI');assert.equal(await page.locator('input[name=name],input[name=model]').count(),0);checks.push('task-based settings group and account details without manual names/model IDs');
  await page.getByRole('button',{name:'添加账户',exact:true}).click();
  await page.getByRole('button',{name:'使用 ChatGPT 登录',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.ai-config-form .ai-account-state')?.textContent==='可以开始对话');
  const added=(await service.dispatch('profiles.list')).find(p=>p.mode==='subscription');assert.equal(added.model,'faux-1');assert.equal(added.can_chat,true);assert.equal((await service.dispatch('profiles.list')).length,3);
  await page.getByLabel('默认模型',{exact:true}).selectOption('faux-1');await page.getByRole('button',{name:'开始对话',exact:true}).waitFor();checks.push('from add account through login, automatic catalog/default model and automatic persistence');
  for(const theme of ['light','dark'])for(const width of [1366,1024,375]){
    await page.setViewportSize({width,height:width===375?812:640});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('roaster.theme',theme);window.dispatchEvent(new Event('roaster-themechange'));},theme);
    await page.getByRole('button',{name:'AI 对话',exact:true}).click();
    await page.waitForTimeout(50);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,'overflow '+theme+' '+width);
    const footer=await page.locator('#btn-e-stop').boundingBox();assert.ok(footer&&footer.y+footer.height<=(width===375?812:640));
    assert.equal(await page.evaluate(()=>{const b=document.querySelector('#btn-e-stop'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
    await page.screenshot({path:resolve(output,'chat-'+theme+'-'+width+'.png')});
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  }checks.push('light/dark desktop/mobile layout and reachable E-STOP');
  await page.setViewportSize({width:812,height:375});await page.getByRole('button',{name:'AI 对话',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const landscapeSend=await page.locator('#ai-send').boundingBox();assert.ok(landscapeSend&&landscapeSend.y+landscapeSend.height<=309);
  const reading=await page.locator('#ai-messages').boundingBox();assert.ok(reading.height>=110,'landscape must retain readable message height: '+JSON.stringify(reading));
  const contextChip=await page.locator('.ai-queued button').first().boundingBox();assert.ok(contextChip&&contextChip.height>=44&&contextChip.y+contextChip.height<=309,'selected context stays visible and removable');
  await page.screenshot({path:resolve(output,'chat-dark-landscape-812.png')});await page.getByRole('button',{name:'关闭',exact:true}).click();checks.push('landscape input and send controls remain visible above emergency footer');
  await page.setViewportSize({width:1024,height:640});
  for(const zoom of [1,1.15,1.3]){
    await page.evaluate(value=>{document.body.style.zoom=String(value);},zoom);
    await page.getByRole('button',{name:'AI 对话',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'zoom overflow '+zoom);
    const bounds=await page.locator('#ai-chat').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=1025);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  }checks.push('100/115/130 percent scaling keeps chat inside viewport');
  await page.evaluate(()=>{document.body.style.zoom='1';});
  await page.getByRole('button',{name:'AI 对话',exact:true}).click();await chooseChatAccount(page,p1.id);
  faux.setResponses([fauxAssistantMessage('可停止的流式回答'.repeat(1000))]);
  await page.locator('#ai-prompt').fill('验证刷新后继续管理正在生成的回复');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='streaming');
  await page.reload();await page.getByRole('button',{name:'AI 对话',exact:true}).click();await page.locator('#ai-stop:not(:disabled)').waitFor();await page.locator('#ai-stop').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='cancelled');checks.push('reload reconnects a running request and can stop it without resending');
  await page.goto(origin+'/editor.html?ai=1');await page.evaluate(()=>window.RoasterEditor.ready);
  await page.waitForFunction(()=>window.RoasterChat.current);
  const source=await page.evaluate(()=>window.RoasterEditor.getSource());
  const candidate={...source,name:'AI 可撤销候选',rationale:'验证原始曲线与候选分离',nodes:source.nodes.map((n,i)=>({...n,temperature:n.temperature+(i?0.5:0)}))};delete candidate.id;
  faux.setResponses([fauxAssistantMessage([fauxToolCall('propose_profile',candidate)]),fauxAssistantMessage('继续讨论')]);
  await page.locator('.ai-panel-body textarea').first().fill('请基于当前曲线提出候选');
  await page.getByRole('button',{name:'生成／调整曲线',exact:true}).click();
  await page.getByRole('button',{name:'确认采用到草稿',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.RoasterEditor.getDraft())).name,source.name);
  await page.getByRole('button',{name:'比较候选',exact:true}).click();
  await page.waitForFunction(()=>Chart.getChart(document.querySelector('#editor-chart')).data.datasets.some(d=>d.aiCandidate));
  await page.getByRole('button',{name:'确认采用到草稿',exact:true}).click();
  await page.waitForFunction(name=>window.RoasterEditor.getDraft().name===name,candidate.name);
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.RoasterEditor.getDraft())).name,source.name);
  await page.getByRole('button',{name:'AI 对话',exact:true}).click();
  await page.locator('#ai-prompt').fill('文字输入回退');await page.locator('#ai-prompt').press('Backspace');
  assert.equal((await page.evaluate(()=>window.RoasterEditor.getDraft())).nodes.length,source.nodes.length);
  checks.push('regular curve comparison, validated explicit adoption, undo and text keyboard isolation');
  let sawAttachmentSamples=false;
  faux.setResponses([fauxAssistantMessage([fauxToolCall('get_native_samples',{channel:'#=mean_temp',from:2,to:3,limit:10})]),ctx=>{
    sawAttachmentSamples=JSON.stringify(JSON.parse(ctx.messages.at(-1).content[0].text).samples)==='[[2,20],[3,22]]';return fauxAssistantMessage('已核对附件原始偏移采样');
  }]);
  await page.evaluate(async()=>window.RoasterChat.attach([new File(['profile_schema_version:1.8\nnative_schema_version:1.8\noffsets\t2\ntime\t#=mean_temp\n0\t20\t\n1\t22\t\n2\t24\t\n'],'attached.klog')]));
  await page.locator('#ai-prompt').fill('读取附件的原始偏移采样');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.content?.includes('已核对附件原始偏移采样'));
  assert.equal(sawAttachmentSamples,true);checks.push('uploaded klog raw channel tool uses immutable attachment and its real offsets');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'ui-report.json'),JSON.stringify({checks,errors,evidence:'shared AI core + faux provider + browser + safe simulator'},null,2));
  console.log(JSON.stringify({checks:checks.length,output,errors},null,2));
  }
}finally{for(const ws of clients)ws.terminate();for(const ws of controlWs.clients)ws.terminate();await browser?.close();nativeChild?.kill();chatWs.close();controlWs.close();bootstrap?.closeAllConnections();bootstrap?.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));sim.kill();await service.shutdown();if(nativeSmoke)await new Promise(ok=>setTimeout(ok,1200));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:400});}
