import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {AIService} from './service-core.mjs';

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'roaster-session-')),key=randomBytes(32).toString('base64');
  let refreshes=0,failRefresh=null,service;
  const oauth={name:'session fixture',isSubscription:true,
    async login(){throw Error('A saved session must never start an interactive login');},
    async refresh(current){refreshes++;if(failRefresh)throw failRefresh;return {...current,access:'rotated-session-access',refresh:'rotated-session-refresh',expires:Date.now()+3600000};},
    async toAuth(value){return {apiKey:value.access};}};
  const reopen=async()=>{
    await service?.shutdown();
    service=new AIService({providerFactories:{openai:()=>{const provider=openaiProvider();provider.auth={...provider.auth,oauth};return provider;}},
      fetcher:async()=>Response.json({models:[{slug:'first-model',visibility:'list'},{slug:'saved-model',visibility:'list'}]})});
    service.injectedProviders.delete('openai');
    await service.initialize({data_dir:dir,master_key:key});return service;
  };
  await reopen();
  const p=await service.dispatch('profiles.save',{profile:{provider:'openai',mode:'subscription'}});
  await service.vault.store(p.id).modify('openai',async()=>({type:'oauth',access:'original-session-access',refresh:'original-session-refresh',expires:Date.now()+3600000}));
  await service.dispatch('models',{profile_id:p.id,refresh:true});
  await service.dispatch('profiles.save',{profile:{id:p.id,model:'saved-model'}});
  return {get service(){return service;},id:p.id,dir,reopen,get refreshes(){return refreshes;},set fail(value){failRefresh=value;},
    async expire(){await service.vault.store(p.id).modify('openai',async value=>({...value,expires:Date.now()-1}));},
    async close(){await service.shutdown();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}};
}

test('saved OAuth, selected model and history survive restart and persist silent token rotation',async()=>{
  const f=await fixture();
  try {
    const conversation=await f.service.dispatch('conversations.create',{profile_id:f.id,title:'恢复对话'});
    // A process can close while a catalog refresh is marked loading.
    f.service.profile(f.id).catalog_status='loading';await f.service.save();await f.reopen();
    const [restored]=await f.service.dispatch('profiles.list');
    assert.equal(restored.authenticated,true);assert.equal(restored.can_chat,true);assert.equal(restored.model,'saved-model');
    assert.equal((await f.service.dispatch('conversations.get',{id:conversation.id})).title,'恢复对话');
    await f.expire();
    await Promise.all([f.service.dispatch('models',{profile_id:f.id,refresh:true}),f.service.collection(f.service.profile(f.id)).getAuth('openai')]);
    assert.equal(f.refreshes,1);assert.equal(f.service.vault.data[f.id].refresh,'rotated-session-refresh');
    await f.reopen();await f.service.collection(f.service.profile(f.id)).getAuth('openai');assert.equal(f.refreshes,1);
    const [profile]=await f.service.dispatch('profiles.list');assert.equal(profile.can_chat,true);assert.equal(profile.model,'saved-model');
    for(const file of ['state.json','credentials.enc']){
      const contents=await readFile(join(f.dir,file),'utf8');
      for(const secret of ['original-session-access','original-session-refresh','rotated-session-access','rotated-session-refresh'])assert.ok(!contents.includes(secret));
    }
  }finally{await f.close();}
});

test('offline token refresh keeps the saved login and a retry restores it without OAuth',async()=>{
  const f=await fixture();
  try {
    await f.expire();f.fail=new TypeError('fetch failed',{cause:Object.assign(Error('connection reset'),{code:'ECONNRESET'})});
    await assert.rejects(f.service.dispatch('models',{profile_id:f.id,refresh:true}),error=>error.code!=='AUTH');
    const [offline]=await f.service.dispatch('profiles.list');assert.equal(offline.authenticated,true);assert.equal(offline.catalog_status,'error');
    assert.match(offline.catalog_error,/登录信息已保留/);assert.equal(f.service.vault.data[f.id].refresh,'original-session-refresh');
    await f.reopen();f.fail=null;await f.service.dispatch('models',{profile_id:f.id,refresh:true});
    const [restored]=await f.service.dispatch('profiles.list');assert.equal(restored.can_chat,true);assert.equal(restored.model,'saved-model');
  }finally{await f.close();}
});

test('an explicit revoked grant requires login; explicit logout remains logged out after restart',async()=>{
  const f=await fixture();
  try {
    await f.expire();f.fail=Error('invalid_grant: refresh token revoked');
    await assert.rejects(f.service.dispatch('models',{profile_id:f.id,refresh:true}),error=>error.code==='AUTH');
    assert.equal(f.service.profile(f.id).catalog_status,'auth_required');
    await f.service.dispatch('auth.logout',{profile_id:f.id});await f.reopen();
    const [profile]=await f.service.dispatch('profiles.list');assert.equal(profile.authenticated,false);assert.equal(profile.can_chat,false);
    assert.equal(f.service.vault.data[f.id],undefined);
  }finally{await f.close();}
});
