// Real Edge, normal motion, real shared controllers and a hardware-free simulator.
import {chromium} from 'playwright';
import {startDevServer} from './dev-server.mjs';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'roaster-mhub-motion-'));
const out=resolve(process.env.ROASTER_QA_DIR||'build/qa/mhub-v3.30/motion');
await mkdir(out,{recursive:true});
let host,browser;const checks=[],errors=[];
async function settled(page){await page.waitForFunction(()=>window.RoasterMotion.state.active===0&&window.RoasterMotion.state.queued===0);}
try {
  host=await startDevServer({port:0,scenario:'roasting',freeze:false,dataDir:dir});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1366,height:800},reducedMotion:'no-preference',colorScheme:'dark'});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.origin);await page.waitForFunction(()=>window.RoasterChat&&document.querySelector('#pv-val').textContent!=='--');await settled(page);
  assert.deepEqual(await page.evaluate(()=>[RoasterTheme.getMode(),RoasterTheme.getTheme(),RoasterTheme.getPalette()]),['auto','dark','mhub']);
  for(const old of ['classic','sage','sand','ocean','plum','graphite']) {
    await page.evaluate(value=>{localStorage.setItem('roaster.palette',value);localStorage.setItem('roaster.theme','light');},old);
    await page.reload();
    assert.deepEqual(await page.evaluate(()=>[RoasterTheme.getMode(),RoasterTheme.getPalette(),document.documentElement.dataset.theme,localStorage.getItem('roaster.palette')]),['light','mhub','light','mhub']);
  }
  checks.push('first paint defaults to system; all six legacy palettes migrate without changing saved mode');
  await page.locator('[data-tab=profile]').click();
  await page.waitForFunction(()=>document.querySelector('#tab-profile').getAnimations().length>0);
  const initial=await page.evaluate(()=>{const a=document.querySelector('#tab-profile').getAnimations()[0];return {duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing,frames:a.effect.getKeyframes().map(k=>k.transform)};});
  assert.equal(initial.duration,200);assert.ok(initial.frames.includes('scale(1.25)'));
  await page.evaluate(()=>{for(let i=0;i<25;i++)document.querySelector('[data-tab='+['settings','records','profile','workbench','roast'][i%5]+']').click();});
  await settled(page);
  assert.equal(await page.locator('.tab-content.active').count(),1);assert.equal(await page.locator('#tab-roast').evaluate(n=>n.classList.contains('active')),true);
  assert.equal(await page.locator('#roast-chart').evaluate(n=>getComputedStyle(n).transform),'none');
  assert.equal(await page.locator('#footer').evaluate(n=>getComputedStyle(n).transform),'none');
  checks.push('real task transition uses 200ms/1.25 scale; 25 interrupted task changes leave only the latest view and stable telemetry');
  const cycles=await page.evaluate(async()=>{
    const launch=document.getElementById('ai-launcher');
    for(let i=0;i<10;i++){
      launch.click();
      document.querySelector('#ai-chat button[aria-label="关闭"]').click();
      launch.click();
    }
    await new Promise(ok=>setTimeout(ok,350));
    return {hidden:document.getElementById('ai-chat').hidden,expanded:launch.getAttribute('aria-expanded'),state:RoasterMotion.state};
  });
  assert.equal(cycles.hidden,false);assert.equal(cycles.expanded,'true');assert.equal(cycles.state.active,0);
  await page.locator('#ai-prompt').fill('快速切换后仍能编辑');
  await page.locator('#ai-chat button[aria-label="关闭"]').click();await page.waitForFunction(()=>document.getElementById('ai-chat').hidden);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'ai-launcher');
  checks.push('ten close/reopen interruptions keep the latest chat state, editable composer and launcher focus restoration');
  const flow=await page.evaluate(async()=>{
    const host=document.createElement('div');host.className='motion-test-host';document.body.append(host);
    const nodes=Array.from({length:16},()=>{const node=document.createElement('div');node.textContent='区域过渡';host.append(node);return node;});
    const promises=nodes.map((n,i)=>RoasterMotion.enter(n,RoasterMotion.types[i%7]));
    RoasterMotion.pause();const paused=RoasterMotion.state.paused;RoasterMotion.resume();await Promise.all(promises);
    const clean=nodes.every(n=>n.getAnimations().length===0&&n.style.transform==='');host.remove();return {paused,clean,state:RoasterMotion.state};
  });
  assert.equal(flow.paused,true);assert.equal(flow.clean,true);assert.equal(flow.state.active,0);checks.push('seven region types, queued batches, pause/resume and completed style cleanup work on real DOM');
  await page.evaluate(()=>{document.querySelector('[data-tab=settings]').click();RoasterTheme.setMode('dark');});
  await page.setViewportSize({width:1024,height:640});await settled(page);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('[data-tab=profile]').click();await settled(page);
  assert.equal(await page.locator('#tab-profile').evaluate(n=>n.getAnimations().length),0);
  await page.locator('[data-tab=roast]').click();
  const safety=await page.evaluate(()=>{const n=document.querySelector('#btn-e-stop'),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});assert.equal(safety,true);
  checks.push('mid-transition theme/viewport changes and reduced-motion leave content usable and emergency access unobstructed');
  await page.evaluate(()=>{document.body.style.zoom='1.3';});
  const zoom=await page.locator('#btn-e-stop').boundingBox();assert.ok(zoom.y+zoom.height<=640);checks.push('130 percent zoom retains the complete safety button');
  assert.deepEqual(errors,[]);await writeFile(join(out,'report.json'),JSON.stringify({checks,errors,scope:'normal and reduced motion in actual Edge; safe simulator only'},null,2));console.log(JSON.stringify({checks:checks.length,errors,output:out}));
} finally {
  await browser?.close();await host?.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
