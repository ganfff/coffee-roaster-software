import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('isolated packaged service loads OAuth modules and all custom protocols without development paths or cloud',{skip:process.platform!=='win32'},async()=>{
  assert.ok(existsSync(resolve(root,'runtime/ai/service.mjs')),'run prepare:ai first');
  const dir=await mkdtemp(join(tmpdir(),'roaster-packaged-ai-'));
  try{
    await cp(resolve(root,'runtime/ai'),join(dir,'ai'),{recursive:true});
    await cp(resolve(root,'runtime/ai-node-x86_64-pc-windows-msvc.exe'),join(dir,'node.exe'));
    await writeFile(join(dir,'probe.mjs'),String.raw`
      import {AIService} from './ai/service.mjs';
      import {randomBytes} from 'node:crypto';
      import {resolve} from 'node:path';
      const events=[];
      const oauth={name:'packaged mock',isSubscription:true,async login(i){i.notify({type:'auth_url',url:'https://example.invalid/no-network'});await i.prompt({type:'manual_code',message:'mock authorization'});return {type:'oauth',access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000};},async refresh(c){return c;},async toAuth(c){return {apiKey:c.access};}};
      const factory=()=>({id:'openai',name:'Packaged mock',auth:{oauth},getModels:()=>[],getModel:()=>undefined});
      const service=new AIService({emit:event=>events.push(event),providerFactories:{openai:factory},fetcher:async()=>new Response(JSON.stringify({data:[{id:'local'}]}))});
      await service.initialize({data_dir:resolve('data'),master_key:randomBytes(32).toString('base64')});
      const providers=await service.dispatch('providers');
      for(const protocol of ['openai-completions','openai-responses','anthropic-messages']){
        const p=await service.dispatch('profiles.save',{profile:{mode:'custom',provider:'custom',model:'local',base_url:'http://127.0.0.1:1/v1',protocol}});
        if((await service.dispatch('models',{profile_id:p.id}))[0].id!=='local')throw Error('model catalog');
      }
      const p=await service.dispatch('profiles.save',{profile:{mode:'subscription',provider:'openai'}});
      const login=await service.dispatch('auth.login',{profile_id:p.id});
      const until=async fn=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('OAuth fixture timeout');await new Promise(r=>setTimeout(r,10));}};
      await until(()=>events.some(e=>e.type==='auth_prompt'));
      await service.dispatch('auth.respond',{prompt_id:events.find(e=>e.type==='auth_prompt').data.prompt_id,value:'mock-only'});
      await until(()=>events.some(e=>e.id===login.id&&e.type==='auth_done'));
      if(!(await service.dispatch('profiles.list')).find(v=>v.id===p.id).authenticated)throw Error('OAuth storage');
      await service.shutdown();
      console.log(JSON.stringify({subscription_providers:providers.filter(p=>p.subscription).length,custom_protocols:3,oauth_mock:true,isolated:true}));
    `);
    const child=spawn(join(dir,'node.exe'),[join(dir,'probe.mjs')],{cwd:dir,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,PATH:join(process.env.SystemRoot,'System32')},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const timer=setTimeout(()=>child.kill(),20000);const code=await new Promise(ok=>child.on('exit',ok));clearTimeout(timer);
    assert.equal(code,0,err);assert.deepEqual(JSON.parse(out),{subscription_providers:5,custom_protocols:3,oauth_mock:true,isolated:true});
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+String.fromCharCode(92)));await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:200});}
});
