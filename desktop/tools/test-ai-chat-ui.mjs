// Real shared AI core + deterministic faux model + hardware-free simulator.
import {chromium} from 'playwright';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {WebSocketServer,WebSocket} from 'ws';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,dirname,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),output=resolve(root,'docs/qa/ai-workspace-v3.24');
const nativeSmoke=process.argv.includes('--native');
await mkdir(output,{recursive:true});
const dir=await mkdtemp(join(tmpdir(),'roaster-chat-ui-'));
const faux=fauxProvider({provider:'openai',tokensPerSecond:250});
faux.setResponses(Array.from({length:40},(_,i)=>fauxAssistantMessage('第 '+(i+1)+' 次回复：根据真实快照分析，保留手动采用与保存。\n**过程依据**\n- 不编造缺失事件。')));
const clients=new Set(),events=[];
const service=new AIService({providerFactories:{openai:()=>faux.provider},emit:event=>{events.push(event);for(const client of clients)if(client.readyState===1)client.send(JSON.stringify({cursor:events.length,events:[event]}));}});
await service.initialize({data_dir:dir,master_key:randomBytes(32).toString('base64')});
const p1=await service.dispatch('profiles.save',{profile:{name:'测试渠道一',mode:'api_key',provider:'openai',model:'faux-1'},api_key:'local-fixture-secret'});
const p2=await service.dispatch('profiles.save',{profile:{name:'测试渠道二',mode:'api_key',provider:'openai',model:'faux-1'},api_key:'local-fixture-secret-2'});
const sim=spawn(process.execPath,[resolve(root,'desktop/tools/roaster-simulator.mjs'),'--scenario=idle','--freeze'],{env:{...process.env,ROASTER_SIM_PORT:'0',WORKBENCH_SOURCE:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser,simOrigin,nativeChild,bootstrap;
await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('simulator startup timeout')),15000);sim.stdout.on('data',chunk=>{const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk));if(m){simOrigin=m[1];clearTimeout(timer);ok();}});sim.once('exit',()=>no(Error('simulator exit')));});
let paired=false;
async function body(req){let text='';for await(const chunk of req)text+=chunk;return text?JSON.parse(text):{};}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
const handler=async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  try{
    if(!path.startsWith('/api/v1/ai')){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}}
    if(path==='/api/v1/ai/status')return json(res,200,{ready:true,paired});
    if(path==='/api/v1/ai/pair'){const input=await body(req);if(input.code!=='12345678')return json(res,403,{detail:'配对码无效'});paired=true;res.setHeader('Set-Cookie','fixture=paired; HttpOnly; SameSite=Strict');return json(res,200,{id:'fixture-client',...(input.native?{token:'native-qa-token-only'}:{})});}
    if(path==='/api/v1/ai/events'){await new Promise(ok=>setTimeout(ok,150));const after=Number(new URL(req.url,'http://localhost').searchParams.get('after')||0);return json(res,200,{cursor:events.length,events:events.slice(after)});}
    if(path==='/api/v1/ai/rpc'){if(!paired)return json(res,401,{detail:'请先配对 AI 服务'});const input=await body(req);return json(res,200,await service.dispatch(input.method,input.params||{}));}
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
    await page.waitForFunction(()=>window.__TAURI_INTERNALS__&&window.RoasterChat);
    await page.evaluate(url=>{localStorage.setItem('roaster.backendUrl',url);localStorage.setItem('roaster.ai.host','backend');},origin);await page.reload();
    page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#ai-launcher').click();await page.locator('.ai-chat-access input').fill('12345678');await page.locator('.ai-chat-access button').filter({hasText:'配对并连接'}).click();
    await page.waitForFunction(()=>document.querySelector('#ai-chat-profile')?.options.length===2);
    await page.locator('#ai-prompt').fill('验证原生跨端完整对话');await page.locator('#ai-send').click();
    await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');
    assert.equal(await page.evaluate(()=>!!window.__TAURI_INTERNALS__),true);
    await page.screenshot({path:resolve(output,'native-tauri-chat.png')});checks.push('packaged Tauri WebView, real Rust pairing/proxy/events and shared full chat');
    await page.locator('.ai-chat-header button').filter({hasText:'关闭'}).click();await page.locator('[data-tab="settings"]').click();await page.waitForTimeout(450);await page.screenshot({path:resolve(output,'native-tauri-settings.png')});
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
  await page.goto(origin);await page.locator('#ai-launcher').click();
  await page.locator('.ai-chat-access input').fill('12345678');await page.locator('.ai-chat-access button').filter({hasText:'配对并连接'}).click();
  await page.waitForFunction(()=>document.querySelector('#ai-chat-profile')?.options.length===2);
  await page.locator('#ai-prompt').fill('先讨论烘焙曲线');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  await page.locator('#ai-prompt').fill('继续上一条');await page.locator('#ai-chat-profile').selectOption(p2.id);await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.length===4&&window.RoasterChat.current?.messages.at(-1)?.status==='completed');
  assert.equal((await page.evaluate(()=>window.RoasterChat.current)).profile_id,p2.id);
  assert.equal(await page.locator('.ai-message-user').count(),2);checks.push('pairing, full multi-turn transcript and manual channel handoff');
  const id=await page.evaluate(()=>window.RoasterChat.current.id);
  await page.reload();await page.locator('#ai-launcher').click();await page.waitForFunction(id=>window.RoasterChat.current?.id===id,id);
  assert.equal(await page.locator('.ai-message-user').count(),2);checks.push('history restored after page reload');
  await page.locator('.ai-chat-header button').filter({hasText:'会话'}).click();
  await page.locator('#ai-history-search').fill('先讨论');assert.ok(await page.locator('.ai-history-item').count()>=1);
  await page.locator('#ai-history-search').fill('无匹配内容');assert.equal(await page.locator('.ai-history-item').count(),0);
  await page.locator('#ai-history-search').fill('');await page.locator('.ai-chat-header button').filter({hasText:'会话'}).click();checks.push('history filtering');
  await page.locator('.ai-message-user .ai-actions button').filter({hasText:'编辑后重发'}).first().click();
  await page.locator('#ai-prompt').fill('编辑后的问题');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='completed'&&window.RoasterChat.current.messages[0].content==='编辑后的问题');
  assert.ok((await service.dispatch('conversations.list')).some(c=>c.archived_branch));checks.push('edit and resend preserves archived original');
  await page.locator('.ai-chat-header button').filter({hasText:'关闭'}).click();
  await page.locator('[data-tab="settings"]').click();await page.locator('#ai-config-list button').first().waitFor();
  await page.waitForTimeout(450);await page.screenshot({path:resolve(output,'settings-light-1366.png')});
  const layout=await page.evaluate(()=>[...document.querySelectorAll('.settings-grid > .settings-card')].filter(n=>getComputedStyle(n).display!=='none').map(n=>({text:n.querySelector('h3')?.textContent,...Object.fromEntries(['x','y','width','height'].map(k=>[k,n.getBoundingClientRect()[k]]))})));
  assert.equal(layout[0].text,'AI 服务');assert.ok(layout[0].width>layout.find(c=>c.text==='外观').width*1.8);
  for(const name of ['外观','界面','提醒','自动标记'])assert.ok(layout.find(c=>c.text===name));checks.push('full-row AI config and ordinary settings card grid');
  await page.getByRole('button',{name:'新增配置',exact:true}).click();
  await page.getByRole('button',{name:'自定义配置',exact:true}).click();await page.getByLabel('API 根地址',{exact:true}).fill('http://127.0.0.1:9999/v1');
  await page.getByLabel('模型 ID',{exact:true}).fill('本地-长模型名称-用于验证字段重排');
  await page.getByRole('button',{name:'保存配置',exact:true}).click();
  await page.getByText('配置已保存',{exact:true}).waitFor();assert.equal((await service.dispatch('profiles.list')).length,3);
  await page.getByRole('button',{name:'订阅登录',exact:true}).click();await page.waitForFunction(()=>document.querySelector('select[name="provider"]')?.options.length===5);assert.equal(await page.locator('select[name="provider"] option').count(),5);checks.push('three configuration modes and capability-filtered subscription providers');
  for(const theme of ['light','dark'])for(const width of [1366,1024,375]){
    await page.setViewportSize({width,height:width===375?812:640});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem('roaster.theme',theme);window.dispatchEvent(new Event('roaster-themechange'));},theme);
    await page.locator('#ai-launcher').click();
    await page.waitForTimeout(50);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false,'overflow '+theme+' '+width);
    const footer=await page.locator('#btn-e-stop').boundingBox();assert.ok(footer&&footer.y+footer.height<=(width===375?812:640));
    assert.equal(await page.evaluate(()=>{const b=document.querySelector('#btn-e-stop'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
    await page.screenshot({path:resolve(output,'chat-'+theme+'-'+width+'.png')});
    await page.locator('.ai-chat-header button').filter({hasText:'关闭'}).click();
  }checks.push('light/dark desktop/mobile layout and reachable E-STOP');
  await page.setViewportSize({width:812,height:375});await page.locator('#ai-launcher').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const landscapeSend=await page.locator('#ai-send').boundingBox();assert.ok(landscapeSend&&landscapeSend.y+landscapeSend.height<=309);
  await page.screenshot({path:resolve(output,'chat-dark-landscape-812.png')});await page.locator('.ai-chat-header button').filter({hasText:'关闭'}).click();checks.push('landscape input and send controls remain visible above emergency footer');
  await page.setViewportSize({width:1024,height:640});
  for(const zoom of [1,1.15,1.3]){
    await page.evaluate(value=>{document.body.style.zoom=String(value);},zoom);
    await page.locator('#ai-launcher').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'zoom overflow '+zoom);
    const bounds=await page.locator('#ai-chat').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=1025);
    await page.locator('.ai-chat-header button').filter({hasText:'关闭'}).click();
  }checks.push('100/115/130 percent scaling keeps chat inside viewport');
  await page.evaluate(()=>{document.body.style.zoom='1';});
  await page.locator('#ai-launcher').click();await page.locator('#ai-chat-profile').selectOption(p1.id);
  faux.setResponses([fauxAssistantMessage('可停止的流式回答'.repeat(1000))]);
  await page.locator('#ai-prompt').fill('验证刷新后继续管理正在生成的回复');await page.locator('#ai-send').click();
  await page.waitForFunction(()=>window.RoasterChat.current?.messages.at(-1)?.status==='streaming');
  await page.reload();await page.locator('#ai-launcher').click();await page.locator('#ai-stop:not(:disabled)').waitFor();await page.locator('#ai-stop').click();
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
  await page.locator('.ai-chat-header button').filter({hasText:'关闭'}).click();
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.RoasterEditor.getDraft())).name,source.name);
  await page.locator('#ai-launcher').click();
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
