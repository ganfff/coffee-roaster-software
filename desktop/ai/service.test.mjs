import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {AIService,Vault} from './service-core.mjs';

async function setup(options={}){const dir=await mkdtemp(join(tmpdir(),'roaster-ai-core-')),key=randomBytes(32).toString('base64'),events=[];const service=new AIService({emit:event=>events.push(event),...options});await service.dispatch('initialize',{data_dir:dir,master_key:key});return {service,dir,key,events,async close(){await service.shutdown();await rm(dir,{recursive:true,force:true});}};}
async function until(predicate){const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw Error('timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
async function profile(service,extra={}){return service.dispatch('profiles.save',{profile:{mode:'api_key',provider:'openai',model:'faux-1',...extra},api_key:'private-test-key'});}
async function run(service,conversation,profile,extra={}){return service.dispatch('runs.start',{conversation_id:conversation.id,revision:conversation.revision,profile_id:profile.id,prompt:'分析这条曲线',...extra});}

test('credentials and all custom headers are encrypted, masked, and isolated by profile',async()=>{
  const fixture=await setup();const {service,dir,key}=fixture;
  try{const first=await profile(service,{headers:{'X-Private-Header':'sensitive-header-value'}});const second=await profile(service);assert.notEqual(first.id,second.id);assert.equal(first.headers['X-Private-Header'],'••••••');assert.equal(first.api_key,undefined);
    const state=await readFile(join(dir,'state.json'),'utf8'),vault=await readFile(join(dir,'credentials.enc'),'utf8');for(const secret of ['private-test-key','sensitive-header-value']){assert.ok(!state.includes(secret));assert.ok(!vault.includes(secret));}
    await service.dispatch('auth.logout',{profile_id:first.id});assert.equal((await service.dispatch('profiles.list')).find(p=>p.id===second.id).configured,true);
    const duplicate=new AIService();await assert.rejects(duplicate.initialize({data_dir:dir,master_key:key}),error=>error.code==='BUSY');await service.shutdown();
    const reopened=new AIService();await reopened.initialize({data_dir:dir,master_key:key});assert.equal(reopened.vault.data[second.id].key,'private-test-key');await reopened.shutdown();
    const wrong=new AIService();await assert.rejects(wrong.initialize({data_dir:dir,master_key:randomBytes(32).toString('base64')}),/无法解密/);
  }finally{await fixture.close();}
});

test('complete chat stores transcript, events, cumulative usage and cross-turn model history',async()=>{
  const faux=fauxProvider({provider:'openai'});let sawHistory=false;faux.setResponses([fauxAssistantMessage('第一轮回答'),ctx=>{sawHistory=ctx.messages.some(m=>m.role==='assistant'&&m.content.some(c=>c.text==='第一轮回答'));return fauxAssistantMessage('第二轮回答');}]);
  const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service}=fixture;
  try{const p=await profile(service),c=await service.dispatch('conversations.create',{profile_id:p.id});const first=await run(service,c,p);await until(()=>!service.runs.has(first.id));let saved=await service.dispatch('conversations.get',{id:c.id});assert.equal(saved.messages.length,2);assert.equal(saved.messages[1].content,'第一轮回答');assert.equal(saved.messages[1].status,'completed');
    const second=await run(service,saved,p,{prompt:'继续讨论'});await until(()=>!service.runs.has(second.id));assert.equal(sawHistory,true);saved=await service.dispatch('conversations.get',{id:c.id});assert.equal(saved.messages.length,4);const events=await service.dispatch('runs.events',{id:first.id});assert.equal(events.at(-1).type,'done');assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));assert.ok(events.some(e=>e.type==='usage'));
    await assert.rejects(run(service,c,p),error=>error.code==='CONFLICT');
  }finally{await fixture.close();}
});

test('native proposals are complete six-value arrays and readonly snapshots cannot propose',async()=>{
  const candidate={temperature:[[0,30,0,30,10,40],[30,120,20,110,40,130],[60,200,50,190,60,200]],fan:[[0,1200,0,1200,10,1200],[30,1250,20,1250,40,1250],[60,1300,50,1300,60,1300]],rationale:'降低后段温升'};
  const faux=fauxProvider({provider:'openai'});let readonlyRejected=false;faux.setResponses([fauxAssistantMessage([fauxToolCall('propose_native_profile',candidate)]),fauxAssistantMessage([fauxToolCall('propose_native_profile',candidate)]),ctx=>{readonlyRejected=ctx.messages.at(-1).isError;return fauxAssistantMessage('只读文件仅供分析');}]);
  const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service,events}=fixture;
  try{const p=await profile(service),c=await service.dispatch('conversations.create',{profile_id:p.id}),job=await run(service,c,p,{kind:'native',context:{native:{readonly:false}}});await until(()=>!service.runs.has(job.id));const artifact=events.find(e=>e.id===job.id&&e.type==='artifact').data;assert.equal(artifact.type,'native_profile');assert.deepEqual(artifact.value.fan,candidate.fan);assert.equal(artifact.requires_validation,true);
    const saved=await service.dispatch('conversations.get',{id:c.id}),readOnly=await run(service,saved,p,{kind:'native',context:{native:{readonly:true}}});await until(()=>!service.runs.has(readOnly.id));assert.equal(readonlyRejected,true);assert.equal(events.filter(e=>e.id===readOnly.id&&e.type==='artifact').length,0);
  }finally{await fixture.close();}
});

test('unknown control tools are refused and ordinary proposals retain interpolation validation',async()=>{
  const faux=fauxProvider({provider:'openai'});let denied=false;faux.setResponses([fauxAssistantMessage([fauxToolCall('start_roast',{})]),ctx=>{denied=ctx.messages.at(-1).isError;return fauxAssistantMessage([fauxToolCall('propose_profile',{name:'unsafe',description:'',nodes:[{time:0,temperature:30},{time:60,temperature:260}],end_temp:260,rationale:'test'})]);},fauxAssistantMessage('无法提交超限曲线')]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});
  try{const p=await profile(fixture.service),c=await fixture.service.dispatch('conversations.create',{profile_id:p.id}),job=await run(fixture.service,c,p,{kind:'design',context:{limits:{max_safe_temperature_c:250}}});await until(()=>!fixture.service.runs.has(job.id));assert.equal(denied,true);assert.equal(fixture.events.filter(e=>e.type==='artifact').length,0);assert.equal((await fixture.service.dispatch('conversations.get',{id:c.id})).messages.at(-1).status,'completed');}finally{await fixture.close();}
});

test('subscription login bridges prompts, cancels cleanly and serializes rotated credential refresh',async()=>{
  const faux=fauxProvider({provider:'openai'});let refreshes=0;const oauth={name:'fake subscription',isSubscription:true,async login(interaction){interaction.notify({type:'auth_url',url:'https://example.invalid/authorize'});const value=await interaction.prompt({type:'manual_code',message:'code'});assert.equal(value,'accepted');return {type:'oauth',access:'oauth-private-access',refresh:'oauth-private-refresh',expires:Date.now()-1};},async refresh(current){refreshes++;await new Promise(resolve=>setTimeout(resolve,15));return {...current,access:'rotated-private-access',expires:Date.now()+3600000};},async toAuth(credential){return {apiKey:credential.access};}};
  const fixture=await setup({providerFactories:{openai:()=>({...faux.provider,auth:{...faux.provider.auth,oauth}})}});const {service,events}=fixture;
  try{const p=await service.dispatch('profiles.save',{profile:{mode:'subscription',provider:'openai',model:'faux-1'}}),login=await service.dispatch('auth.login',{profile_id:p.id});await until(()=>events.some(e=>e.id===login.id&&e.type==='auth_prompt'));const prompt=events.find(e=>e.id===login.id&&e.type==='auth_prompt');await service.dispatch('auth.respond',{prompt_id:prompt.data.prompt_id,value:'accepted'});await until(()=>events.some(e=>e.id===login.id&&e.type==='auth_done'));
    const models=service.collection(service.profile(p.id));await Promise.all([models.getAuth('openai'),models.getAuth('openai')]);assert.equal(refreshes,1);assert.equal(service.vault.data[p.id].access,'rotated-private-access');assert.ok(!JSON.stringify(events).includes('oauth-private-access'));
    const pending=await service.dispatch('auth.login',{profile_id:p.id});await until(()=>events.some(e=>e.id===pending.id&&e.type==='auth_prompt'));await service.dispatch('auth.cancel',{id:pending.id});await until(()=>!service.logins.has(pending.id));assert.equal(service.prompts.size,0);
    await service.dispatch('auth.logout',{profile_id:p.id});assert.equal(service.vault.data[p.id],undefined);
  }finally{await fixture.close();}
});

test('stop preserves partial output and retry creates an untouched archived original',async()=>{
  const faux=fauxProvider({provider:'openai',tokensPerSecond:30});faux.setResponses([fauxAssistantMessage('逐步回复'.repeat(40)),fauxAssistantMessage('重新回答')]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service,events}=fixture;
  try{const p=await profile(service),c=await service.dispatch('conversations.create',{profile_id:p.id}),job=await run(service,c,p);await until(()=>events.some(e=>e.id===job.id&&e.type==='text'));await service.dispatch('runs.cancel',{id:job.id});await until(()=>!service.runs.has(job.id));const stopped=await service.dispatch('conversations.get',{id:c.id});assert.equal(stopped.messages.at(-1).status,'cancelled');assert.ok(stopped.messages.at(-1).content.length>0);
    const retried=await run(service,stopped,p,{retry_from:stopped.messages[0].id,prompt:'请重新回答'});await until(()=>!service.runs.has(retried.id));const conversations=await service.dispatch('conversations.list');const original=conversations.find(item=>item.archived_branch);assert.ok(original);assert.equal((await service.dispatch('conversations.get',{id:original.id})).messages.at(-1).status,'cancelled');
  }finally{await fixture.close();}
});

test('attachment MIME validation, vision checks and raw native prompt exclusion',async()=>{
  const faux=fauxProvider({provider:'openai'});let clean=false;faux.setResponses([ctx=>{clean=!JSON.stringify(ctx).includes('raw-private-native-bytes');return fauxAssistantMessage('已读取解析数据');}]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service}=fixture;
  try{await assert.rejects(service.dispatch('attachments.add',{name:'bad.png',mime_type:'image/png',data:Buffer.from('not a PNG').toString('base64')}),/不符/);
    const attachment=await service.dispatch('attachments.add',{name:'sample.kpro',mime_type:'application/octet-stream',data:Buffer.from('raw-private-native-bytes').toString('base64')});const p=await profile(service),c=await service.dispatch('conversations.create',{profile_id:p.id}),job=await run(service,c,p,{attachments:[attachment.id],context:{native:{readonly:true},active_profile:{native_source:'raw-private-native-bytes'}}});await until(()=>!service.runs.has(job.id));assert.equal(clean,true);await assert.rejects(service.dispatch('attachments.delete',{id:attachment.id}),error=>error.code==='CONFLICT');
  }finally{await fixture.close();}
});

test('provider metadata includes all five real subscription providers and three custom protocols',async()=>{
  const fixture=await setup();try{const providers=await fixture.service.dispatch('providers');assert.deepEqual(providers.filter(p=>p.subscription).map(p=>p.id).sort(),['anthropic','github-copilot','kimi-coding','openai','xai']);assert.equal(providers.find(p=>p.id==='openrouter').subscription,false);for(const protocol of ['openai-completions','openai-responses','anthropic-messages']){const p=await fixture.service.dispatch('profiles.save',{profile:{mode:'custom',provider:'custom',model:'local',base_url:'http://127.0.0.1:9999/v1',protocol}});assert.equal(fixture.service.collection(fixture.service.profile(p.id)).getModel('custom','local').api,protocol);}}finally{await fixture.close();}
});

test('request IDs are idempotent and conflicting reuse cannot trigger another paid call',async()=>{
  const faux=fauxProvider({provider:'openai'});faux.setResponses([fauxAssistantMessage('只回复一次')]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service}=fixture;
  try{const p=await profile(service),c=await service.dispatch('conversations.create',{profile_id:p.id}),params={id:'idempotent-request',conversation_id:c.id,revision:0,profile_id:p.id,prompt:'一次消息'};const first=await service.dispatch('runs.start',params),second=await service.dispatch('runs.start',params);assert.equal(second.id,first.id);assert.equal(second.replayed,true);await until(()=>!service.runs.has(first.id));const third=await service.dispatch('runs.start',params);assert.equal(third.status,'completed');assert.equal(faux.state.callCount,1);assert.equal((await service.dispatch('conversations.get',{id:c.id})).messages.length,2);await assert.rejects(service.dispatch('runs.start',{...params,prompt:'另一条消息'}),error=>error.code==='CONFLICT');}finally{await fixture.close();}
});

test('connection test uses provider auth without adding a conversation and masks echoed secrets',async()=>{
  const faux=fauxProvider({provider:'openai'});faux.setResponses([fauxAssistantMessage('OK'),fauxAssistantMessage('',{stopReason:'error',errorMessage:'private-test-key denied sensitive-header-value'})]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service}=fixture;
  try{const p=await profile(service,{headers:{'X-Test':'sensitive-header-value'}});assert.equal((await service.dispatch('test',{profile_id:p.id})).text,'连接成功');assert.equal((await service.dispatch('conversations.list')).length,0);await assert.rejects(service.dispatch('test',{profile_id:p.id}),error=>!error.message.includes('private-test-key')&&!error.message.includes('sensitive-header-value'));}finally{await fixture.close();}
});

test('whole older turns are compacted with visible summary while complete originals remain persisted',async()=>{
  const faux=fauxProvider({provider:'openai',models:[{id:'faux-1',contextWindow:2048,maxTokens:256}]});let summarized=false;faux.setResponses([fauxAssistantMessage('早期回答'.repeat(1600)),ctx=>{summarized=JSON.stringify(ctx).includes('较早对话的确定性摘录');return fauxAssistantMessage('根据摘录继续');}]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service,events}=fixture;
  try{const p=await profile(service,{max_tokens:256}),c=await service.dispatch('conversations.create',{profile_id:p.id});const first=await run(service,c,p,{prompt:'早期问题'.repeat(1500)});await until(()=>!service.runs.has(first.id));const saved=await service.dispatch('conversations.get',{id:c.id}),second=await run(service,saved,p,{prompt:'继续'});await until(()=>!service.runs.has(second.id));assert.equal(summarized,true);assert.ok(events.some(e=>e.id===second.id&&e.type==='context_compacted'));const complete=await service.dispatch('conversations.get',{id:c.id});assert.equal(complete.messages[0].content.length,6000);assert.equal(complete.messages[1].content.length,6400);assert.equal(complete.messages[3].compaction.originals_retained,true);}finally{await fixture.close();}
});

test('native sample tool accepts only the bound document response and cleans up cancellation',async()=>{
  const faux=fauxProvider({provider:'openai'});let sawSamples=false;faux.setResponses([fauxAssistantMessage([fauxToolCall('get_native_samples',{channel:'temperature',from:0,to:60,limit:3})]),ctx=>{sawSamples=JSON.stringify(ctx.messages.at(-1)).includes('199');return fauxAssistantMessage('根据真实采样分析');},fauxAssistantMessage([fauxToolCall('get_native_samples',{channel:'temperature',from:0,to:60,limit:3})])]);const fixture=await setup({providerFactories:{openai:()=>faux.provider}});const {service,events}=fixture;
  try{const p=await profile(service),c=await service.dispatch('conversations.create',{profile_id:p.id}),identity={document_session_id:'native-session',revision:2,sha256:'source-sha'},context={native:{kind:'log',readonly:true,can_propose:true,identity,channels:[{id:'temperature'}]}},job=await run(service,c,p,{kind:'native',context});await until(()=>events.some(e=>e.id===job.id&&e.type==='tool_request'));const request=events.find(e=>e.id===job.id&&e.type==='tool_request');await service.dispatch('tools.respond',{tool_request_id:request.data.tool_request_id,value:{identity,channel:'temperature',unit:'C',samples:[[0,30],[60,199]]}});await until(()=>!service.runs.has(job.id));assert.equal(sawSamples,true);assert.equal(service.toolRequests.size,0);
    const current=await service.dispatch('conversations.get',{id:c.id}),second=await run(service,current,p,{kind:'native',context});await until(()=>events.some(e=>e.id===second.id&&e.type==='tool_request'));await service.dispatch('runs.cancel',{id:second.id});await until(()=>!service.runs.has(second.id));assert.equal(service.toolRequests.size,0);
  }finally{await fixture.close();}
});

test('restart preserves partial messages and gives event replay a terminal interruption without retrying',async()=>{
  const fixture=await setup();let restored;
  try{
    const conversation=await fixture.service.dispatch('conversations.create');
    fixture.service.conversation(conversation.id).messages.push({id:'partial',role:'assistant',run_id:'interrupted-run',status:'streaming',content:'保留的部分回答'});
    fixture.service.state.runs.push({id:'interrupted-run',conversation_id:conversation.id,status:'running',events:[{id:'interrupted-run',conversation_id:conversation.id,sequence:1,type:'text',data:'保留的部分回答'}]});
    await fixture.service.shutdown();
    restored=new AIService();await restored.initialize({data_dir:fixture.dir,master_key:fixture.key});
    const saved=await restored.dispatch('conversations.get',{id:conversation.id});
    assert.equal(saved.messages[0].status,'interrupted');assert.equal(saved.messages[0].content,'保留的部分回答');
    const events=await restored.dispatch('runs.events',{id:'interrupted-run',after_sequence:1});
    assert.equal(events.length,1);assert.equal(events[0].type,'error');assert.equal(events[0].data.code,'INTERRUPTED');
    assert.equal(restored.runs.size,0);
  }finally{await restored?.shutdown();await fixture.close();}
});

test('vision attachment is delivered, restored with metadata and removed only after its last conversation',async()=>{
  const faux=fauxProvider({provider:'openai'});let received=false;faux.setResponses([ctx=>{received=ctx.messages.some(m=>m.content.some?.(block=>block.type==='image'&&block.mimeType==='image/png'));return fauxAssistantMessage('已看到图片');}]);
  const fixture=await setup({providerFactories:{openai:()=>faux.provider}});
  try{
    const attachment=await fixture.service.dispatch('attachments.add',{name:'pixel.png',mime_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i4ZkAAAAASUVORK5CYII='});
    const p=await profile(fixture.service),c=await fixture.service.dispatch('conversations.create',{profile_id:p.id});
    const job=await run(fixture.service,c,p,{attachments:[attachment.id]});await until(()=>!fixture.service.runs.has(job.id));
    const saved=await fixture.service.dispatch('conversations.get',{id:c.id});assert.equal(received,true);assert.equal(saved.messages[0].attachment_info[0].name,'pixel.png');
    await fixture.service.dispatch('conversations.delete',{id:c.id});
    await assert.rejects(fixture.service.dispatch('attachments.get',{id:attachment.id}),error=>error.code==='NOT_FOUND');
  }finally{await fixture.close();}
});

for(const providerId of ['openai','anthropic','github-copilot','kimi-coding','xai'])test('subscription interaction contract: '+providerId,async()=>{
  const faux=fauxProvider({provider:providerId});
  const oauth={name:'fixture subscription',isSubscription:true,async login(interaction){
    if(['github-copilot','kimi-coding','xai'].includes(providerId))interaction.notify({type:'device_code',userCode:'TEST-CODE',verificationUri:'https://example.invalid/device'});
    else interaction.notify({type:'auth_url',url:'https://example.invalid/authorize',instructions:'测试授权回填'});
    if(providerId==='anthropic')assert.equal(await interaction.prompt({type:'select',message:'登录方式',options:[{id:'browser',label:'浏览器'},{id:'copy_code',label:'复制代码'}]}),'copy_code');
    assert.equal(await interaction.prompt({type:'manual_code',message:'测试授权结果'}),'test-approved');
    return {type:'oauth',access:'fixture-oauth-secret-'+providerId,refresh:'fixture-refresh-'+providerId,expires:Date.now()+3600000};
  },async refresh(value){return value;},async toAuth(value){return {apiKey:value.access};}};
  const fixture=await setup({providerFactories:{[providerId]:()=>({...faux.provider,auth:{...faux.provider.auth,oauth}})}});
  try{
    const p=await fixture.service.dispatch('profiles.save',{profile:{mode:'subscription',provider:providerId,model:'faux-1'}});
    const login=await fixture.service.dispatch('auth.login',{profile_id:p.id,login_method:'copy_code'});
    await until(()=>fixture.events.some(e=>e.id===login.id&&e.type==='auth_prompt'));
    assert.equal((await fixture.service.dispatch('profiles.list'))[0].login_id,login.id);
    await assert.rejects(fixture.service.dispatch('auth.login',{profile_id:p.id}),e=>e.code==='CONFLICT');
    const prompt=fixture.events.find(e=>e.id===login.id&&e.type==='auth_prompt');
    await fixture.service.dispatch('auth.respond',{prompt_id:prompt.data.prompt_id,value:'test-approved'});
    await until(()=>fixture.events.some(e=>e.id===login.id&&e.type==='auth_done'));
    assert.equal((await fixture.service.dispatch('profiles.list'))[0].authenticated,true);
    assert.equal(JSON.stringify(fixture.events).includes('fixture-oauth-secret'),false);
    await fixture.service.dispatch('auth.logout',{profile_id:p.id});assert.equal((await fixture.service.dispatch('profiles.list'))[0].authenticated,false);
  }finally{await fixture.close();}
});
