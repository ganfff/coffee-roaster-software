// Real local service + deterministic OAuth; no real login, paid model or hardware.
import {chromium} from 'playwright';
import {fauxProvider} from '@earendil-works/pi-ai/providers/faux';
import {AIService} from '../ai/service-core.mjs';
import {startDevServer} from './dev-server.mjs';
import {palettes} from './theme-palettes.mjs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';

const out=resolve(process.env.ROASTER_QA_DIR||'build/qa/mhub-v3.30/themes');await mkdir(out,{recursive:true});
const data=await mkdtemp(join(tmpdir(),'roaster-local-ui-'));
const checks=[],errors=[],ratios=[];let host,browser,origin;
const localModels=http.createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'local-ui-model',name:'本地测试模型'}]}));});
await new Promise(ok=>localModels.listen(0,'127.0.0.1',ok));
const faux=fauxProvider({provider:'openai'});
const oauth={name:'Local UI fixture',isSubscription:true,async login(interaction){
  interaction.notify({type:'auth_url',url:origin+'/login-check?state=fixture'});
  interaction.notify({type:'device_code',verificationUriComplete:origin+'/login-check?state=fixture',userCode:'TEST-1234'});
  await interaction.prompt({type:'text',message:'测试授权确认'});
  return {type:'oauth',access:'local-ui-fixture',refresh:'local-ui-fixture',expires:Date.now()+3600000};
},async refresh(value){return value;},async toAuth(value){return {apiKey:value.access};}};
function luminance(rgb){const v=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return .2126*v[0]+.7152*v[1]+.0722*v[2];}
function contrast(a,b){const [hi,lo]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (hi+.05)/(lo+.05);}
try {
  host=await startDevServer({port:0,freeze:true,dataDir:data,serviceFactory:options=>new AIService({...options,providerFactories:{openai:()=>({...faux.provider,auth:{...faux.provider.auth,oauth}})}})});origin=host.origin;
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1366,height:800}});
  await context.route('**/login-check?**',route=>route.fulfill({contentType:'text/html',body:'<title>本机浏览器打开验证</title><p>本机授权夹具，无真实登录。</p>'}));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/?settings=ai');await page.locator('.ai-config-form h4').waitFor();
  assert.equal(await page.getByText('高级与设备共享',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'配对客户端',exact:true}).count(),0);
  assert.equal(await page.locator('[name=local_url]').inputValue(),'http://127.0.0.1:1234/v1');checks.push('local model connection is primary; no host selector, pairing or sharing controls');
  await page.screenshot({path:join(out,'ai-add-desktop.png')});
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'使用 ChatGPT 登录',exact:true}).click();const popup=await popupPromise;
  await popup.waitForURL('**/login-check?**');await popup.close();
  await page.locator('.ai-device-code code').filter({hasText:'TEST-1234'}).waitFor();assert.equal(await page.locator('[data-auth-url]').count(),1);checks.push('auth event automatically opens the browser once; complete device URL and visible device code are supported');
  const savedOpen=await page.evaluate(()=>{window.__localOriginalOpen=window.open;window.open=()=>null;return true;});assert.ok(savedOpen);
  await page.getByRole('button',{name:'打开官方授权页面',exact:true}).click();await page.getByText('浏览器拦截了自动打开，请点击“打开官方授权页面”或复制地址',{exact:true}).waitFor();
  await page.evaluate(()=>{window.open=window.__localOriginalOpen;});const retry=page.waitForEvent('popup');await page.getByRole('button',{name:'打开官方授权页面',exact:true}).click();await (await retry).close();checks.push('blocked popup gives visible recovery; retry retains direct user activation');
  await page.getByRole('button',{name:'取消登录',exact:true}).click();await page.getByRole('button',{name:'登录账户',exact:true}).waitFor();checks.push('cancel clears authorization and leaves a working retry action');
  await page.getByRole('button',{name:'添加账户',exact:true}).click();await page.locator('[name=local_url]').fill('http://127.0.0.1:'+localModels.address().port+'/v1');await page.getByRole('button',{name:'连接本地模型',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[name=model]')?.value==='local-ui-model');await page.getByText('高级参数',{exact:true}).click();await page.screenshot({path:join(out,'ai-local-model-advanced.png')});checks.push('local-model button saves a keyless connection and loads its actual loopback model catalog');
  await page.getByRole('button',{name:'添加账户',exact:true}).click();await page.getByText('其他订阅与 API',{exact:true}).click();
  await page.locator('[name=provider]').selectOption('custom');await page.locator('[name=base_url]').fill('http://127.0.0.1:1234/v1');
  const controlGap=await page.locator('.ai-disclosure-body').evaluate(node=>{const grid=node.querySelector('.ai-config-grid').getBoundingClientRect(),button=node.querySelector(':scope > button').getBoundingClientRect();return button.top-grid.bottom;});assert.ok(controlGap>=15);checks.push('expanded API fields and action have an explicit 16px gap');
  await page.screenshot({path:join(out,'ai-api-desktop.png'),fullPage:true});
  for(const width of [1024,375]){await page.setViewportSize({width,height:width===1024?640:812});await page.locator('.ai-disclosure-body > button').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:join(out,'ai-api-'+width+'.png')});}checks.push('nested AI settings wrap at 1024 and 375px without horizontal overflow');
  await page.setViewportSize({width:1366,height:800});await page.getByRole('tab',{name:'外观',exact:true}).click();
  assert.equal(await page.locator('.palette-option').count(),0);assert.equal(await page.locator('#theme-seg [data-theme-mode]').count(),3);
  for(const id of Object.keys(palettes))for(const mode of ['light','dark']){
    await page.setViewportSize({width:1366,height:800});
    await page.evaluate(({id,mode})=>{window.RoasterTheme.setPalette(id);window.RoasterTheme.setMode(mode);},{id,mode});
    const pairs=await page.evaluate(()=>{
      const css=getComputedStyle(document.documentElement),read=name=>{const node=document.createElement('span');node.style.color=css.getPropertyValue('--'+name);document.body.append(node);const value=getComputedStyle(node).color;node.remove();return value;};
      return {bg:read('bg'),surface:read('surface'),'surface-2':read('surface-2'),'surface-3':read('surface-3'),rail:read('rail'),control:read('control-bg'),text:read('text'),secondary:read('text-secondary'),tertiary:read('text-tertiary'),accent:read('accent'),hover:read('accent-hover'),primary:read('primary'),primaryHover:read('primary-hover'),onPrimary:read('on-primary'),soft:read('accent-soft'),on:read('on-accent'),border:read('border')};
    });
    const result={id,mode,minText:Infinity,minControl:Infinity};
    for(const foreground of ['text','secondary','tertiary'])for(const background of ['bg','surface','surface-2','surface-3','rail','control']){const ratio=contrast(pairs[foreground],pairs[background]);result.minText=Math.min(result.minText,ratio);assert.ok(ratio>=4.5,`${id}/${mode} ${foreground} on ${background}: ${ratio}`);}
    for(const background of ['bg','surface','control','soft']){const ratio=contrast(pairs.accent,pairs[background]);result.minControl=Math.min(result.minControl,ratio);assert.ok(ratio>=3,`${id}/${mode} focus/action on ${background}: ${ratio}`);}
    assert.ok(contrast(pairs.onPrimary,pairs.primary)>=4.5,id+' primary text');assert.ok(contrast(pairs.onPrimary,pairs.primaryHover)>=4.5,id+' primary hover');assert.ok(contrast(pairs.border,pairs.control)>=3,id+' input boundary');ratios.push(result);
    await page.locator('#theme-seg').scrollIntoViewIfNeeded();await page.screenshot({path:join(out,id+'-'+mode+'.png')});
    for(const tab of ['roast','profile','records','workbench','settings'])for(const width of [1366,1024,375]){
      await page.setViewportSize({width,height:width===1024?640:800});await page.locator('[data-tab='+tab+']').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,id+'/'+mode+'/'+tab+'/'+width);
    }
  }
  checks.push('Mhub light/dark × five workspaces × three sizes: 30 overflow checks; text, actions, focus and input contrast computed');
  await page.evaluate(()=>{window.RoasterTheme.setPalette('plum');window.RoasterTheme.setMode('auto');});await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.reload();assert.equal(await page.evaluate(()=>window.RoasterTheme.getPalette()),'mhub');checks.push('legacy palette normalizes to Mhub and auto appearance responds to system changes');
  assert.deepEqual(errors,[]);await writeFile(join(out,'ui-report.json'),JSON.stringify({checks,errors,ratios,scope:'actual Edge rendering; real AI service; deterministic OAuth; no real provider login or hardware'},null,2));console.log(JSON.stringify({checks:checks.length,palettes:ratios.length,errors,output:out}));
}finally{await browser?.close();await host?.close();await new Promise(ok=>localModels.close(ok));await rm(data,{recursive:true,force:true});}
