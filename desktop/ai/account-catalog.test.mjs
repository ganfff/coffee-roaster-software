import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {discoverAccountModels,chatGPTPayload} from './account-catalog.mjs';
import {AIService} from './service-core.mjs';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {openAIResponsesApi} from '@earendil-works/pi-ai/api/openai-responses.lazy';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';

test('ChatGPT uses the authenticated catalog, server order and display names without a static fallback',async()=>{
  const result=await discoverAccountModels('openai',{apiKey:'fixture-secret'},{fetcher:async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/models');assert.equal(options.headers.get('Authorization'),'Bearer fixture-secret');
    return Response.json({models:[{slug:'new-unknown-model',display_name:'账户模型',visibility:'list'},{slug:'hidden',visibility:'hide'},{slug:'second',display_name:'第二个',visibility:'list'},{slug:'second',visibility:'list'}]});
  }});
  assert.deepEqual(result.map(m=>m.id),['new-unknown-model','second']);assert.equal(result[0].name,'账户模型');assert.equal(result[0].api,'openai-responses');assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
test('Kimi account catalog carries advertised capabilities and never synthesizes inaccessible models',async()=>{
  const result=await discoverAccountModels('kimi-coding',{apiKey:'fixture'},{fetcher:async url=>{assert.equal(url,'https://api.kimi.com/coding/v1/models');return Response.json({data:[{id:'kimi-live',display_name:'Kimi 账户模型',context_length:100000,supports_image_in:true,supports_reasoning:true}]});}});
  assert.equal(result[0].contextWindow,100000);assert.deepEqual(result[0].input,['text','image']);assert.equal(result[0].reasoning,true);
  await assert.rejects(discoverAccountModels('openai',{apiKey:'fixture'},{fetcher:async()=>new Response('',{status:401})}),e=>e.code==='AUTH');
  await assert.rejects(discoverAccountModels('openai',{apiKey:'fixture'},{fetcher:async()=>{throw new TypeError('fetch failed');}}),e=>e.code==='CATALOG'&&e.message.includes('检查网络'));
  assert.deepEqual(await discoverAccountModels('openai',{apiKey:'fixture'},{fetcher:async()=>Response.json({models:[]})}),[]);
});
test('subscription payload uses developer instructions, namespaced functions and allowed stream fields',()=>{
  const original={input:[{type:'message',role:'system',content:'policy'},{role:'user',content:'hi'}],tools:[{type:'function',name:'get_metrics',parameters:{type:'object'}},{type:'function',name:'propose_profile',parameters:{type:'object'}}],max_output_tokens:4096,temperature:.5,previous_response_id:'old',store:true,stream:false};
  const result=chatGPTPayload(original);assert.equal(result.input[0].role,'developer');assert.equal(original.input[0].role,'system');assert.equal(result.store,false);assert.equal(result.stream,true);assert.equal(result.max_output_tokens,undefined);assert.equal(result.previous_response_id,undefined);assert.equal(result.tools[0].type,'namespace');assert.deepEqual(result.tools[0].tools.map(t=>t.name),['get_metrics','propose_profile']);
});
test('the real Responses SDK sends the corrected subscription wire payload before any network access',async()=>{
  let captured;
  const model={id:'account-new-nonreasoning',provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const context=normalizeContext({systemPrompt:'只做分析',messages:[{role:'user',content:[{type:'text',text:'hello'}],timestamp:Date.now()}],tools:[{name:'get_metrics',description:'readonly',parameters:{type:'object',properties:{}}}]});
  const stream=openAIResponsesApi().streamSimple(model,context,{apiKey:'oauth-wire-fixture',maxTokens:4096,onPayload:chatGPTPayload,fetch:async(url,options)=>{captured=JSON.parse(options.body);return Response.json({error:{message:'offline transport fixture',type:'authentication_error'}},{status:401});}});
  for await(const event of stream){}await stream.result();
  assert.ok(captured);assert.equal(captured.input.some(item=>item.role==='system'),false);assert.ok(captured.input.some(item=>item.role==='developer'));assert.equal(captured.tools[0].type,'namespace');assert.equal(captured.tools[0].tools[0].name,'get_metrics');assert.equal(captured.max_output_tokens,undefined);assert.equal(captured.store,false);assert.equal(captured.stream,true);
});
test('legacy custom connections retain a usable saved model without requiring a new catalog endpoint',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'roaster-legacy-connection-')),service=new AIService();
  try{await service.initialize({data_dir:dir,master_key:randomBytes(32).toString('base64')});const p=await service.dispatch('profiles.save',{profile:{mode:'custom',provider:'custom',model:'legacy-local',base_url:'http://127.0.0.1:9999/v1',protocol:'openai-completions'}});assert.equal(p.can_chat,true);assert.equal(service.collection(service.profile(p.id)).getModel('custom','legacy-local').id,'legacy-local');assert.equal((await service.dispatch('providers')).find(p=>p.id==='anthropic').login_methods[0].id,'official_cli');}
  finally{await service.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('login discovers and persists a default, new models enter inference registry, removal/error requires recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'roaster-account-test-'));let rows=[{slug:'account-only-new',display_name:'新模型',visibility:'list'}],status=200;
  const oauth={name:'fixture',isSubscription:true,async login(){return {type:'oauth',access:'fixture-account-access',refresh:'fixture-refresh',expires:Date.now()+3600000};},async refresh(c){return c;},async toAuth(c){return {apiKey:c.access};}};
  const service=new AIService({providerFactories:{openai:()=>{const provider=openaiProvider();provider.auth={...provider.auth,oauth};return provider;}},fetcher:async()=>status===200?Response.json({models:rows}):new Response('',{status})});
  // Exercise the production account-discovery path with a deterministic OAuth boundary.
  service.injectedProviders.delete('openai');
  try{
    await service.initialize({data_dir:dir,master_key:randomBytes(32).toString('base64')});
    const p=await service.dispatch('profiles.save',{profile:{provider:'openai',mode:'subscription'}});
    await service.dispatch('auth.login',{profile_id:p.id});
    for(let i=0;i<200&&service.logins.size;i++)await new Promise(ok=>setTimeout(ok,10));
    const saved=service.profile(p.id);assert.equal(saved.model,'account-only-new');assert.equal(service.publicProfile(saved).can_chat,true);
    assert.equal(service.collection(saved).getModel('openai','account-only-new').name,'新模型');
    rows=[{slug:'replacement',visibility:'list'}];await service.dispatch('models',{profile_id:p.id,refresh:true});
    assert.equal(saved.model,'');assert.equal(saved.needs_model_choice,true);assert.equal(service.publicProfile(saved).can_chat,false);
    await assert.rejects(service.dispatch('profiles.save',{profile:{id:p.id,model:'invented'}}),/账户目录/);
    await service.dispatch('profiles.save',{profile:{id:p.id,model:'replacement'}});assert.equal(service.publicProfile(saved).can_chat,true);
    status=401;await assert.rejects(service.dispatch('models',{profile_id:p.id,refresh:true}),e=>e.code==='AUTH');assert.equal(service.publicProfile(saved).can_chat,false);assert.equal(saved.catalog_status,'auth_required');
    status=200;rows=[];await service.dispatch('models',{profile_id:p.id,refresh:true});assert.equal(saved.catalog_status,'empty');assert.equal(service.publicProfile(saved).authenticated,true);assert.equal(service.publicProfile(saved).can_chat,false);
    oauth.refresh=async()=>{throw Error('fixture expired authorization');};service.vault.data[p.id].expires=Date.now()-1;
    await assert.rejects(service.dispatch('models',{profile_id:p.id,refresh:true}),e=>e.code==='AUTH');assert.equal(saved.catalog_status,'auth_required');
    const conversation=await service.dispatch('conversations.create',{profile_id:p.id});await service.dispatch('profiles.delete',{id:p.id});assert.equal((await service.dispatch('conversations.get',{id:conversation.id})).id,conversation.id);
  }finally{await service.shutdown();await rm(dir,{recursive:true,force:true});}
});
