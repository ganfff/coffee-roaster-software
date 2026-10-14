import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createModels} from '@earendil-works/pi-ai';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import http from 'node:http';
process.env.ROASTER_AI_IMPORT_ONLY='1';
const {handle,resolveModels}=await import('./worker.mjs');
function harness(responses) {const faux=fauxProvider();faux.setResponses(responses);const models=createModels();models.setProvider(faux.provider);return {models,faux};}
const base={id:'test',apiKey:'dummy',kind:'review',config:{provider:'faux',model:'faux-1'},context:{},prompt:'复盘'};
test('review artifact streams using faux provider, no cloud',async()=>{const {models}=harness([fauxAssistantMessage([fauxToolCall('submit_review',{summary:'数据不足',observations:[],recommendations:['补充事件'],assumptions:['无杯测']})])]);const events=[];await handle(base,(type,data)=>events.push({type,data}),models);assert.equal(events.find(e=>e.type==='artifact').data.type,'review');assert.ok(events.some(e=>e.type==='history'));});
test('unknown control tool gets an error result; no execution',async()=>{let rejected=false;const {models}=harness([fauxAssistantMessage([fauxToolCall('set_sv',{temperature:250})]),ctx=>{rejected=ctx.messages.at(-1).isError;return fauxAssistantMessage('无控制权限');}]);await handle(base,()=>{},models);assert.equal(rejected,true);});
test('invalid candidate can be corrected but no partial artifact escapes',async()=>{const p={name:'测试',description:'',nodes:[{time:0,temperature:30},{time:60,temperature:260}],end_temp:210,rationale:'测试'};const fixed={...p,nodes:[{time:0,temperature:30},{time:60,temperature:210}]};const {models}=harness([fauxAssistantMessage([fauxToolCall('propose_profile',p)]),fauxAssistantMessage([fauxToolCall('propose_profile',fixed)])]);const artifacts=[];await handle({...base,kind:'design',context:{limits:{max_safe_temperature_c:250}}},(t,d)=>{if(t==='artifact')artifacts.push(d);},models);assert.equal(artifacts.length,1);assert.equal(artifacts[0].value.nodes[1].temperature,210);});
test('live requests reject profile proposals',async()=>{let rejected=false;const {models}=harness([fauxAssistantMessage([fauxToolCall('propose_profile',{name:'t',description:'',nodes:[{time:0,temperature:30},{time:60,temperature:200}],end_temp:200,rationale:'t'})]),ctx=>{rejected=ctx.messages.at(-1).isError;return fauxAssistantMessage('请待机后编辑');}]);await handle({...base,kind:'live'},()=>{},models);assert.equal(rejected,true);});
test('all configured factory catalogs load and custom local models need no key',()=>{for(const provider of ['openai','anthropic','google','deepseek','moonshotai-cn','openrouter'])assert.ok(resolveModels({provider}).getModels(provider).length>0);assert.equal(resolveModels({provider:'custom',model:'local',base_url:'http://127.0.0.1:1234/v1'}).getModel('custom','local').id,'local');assert.throws(()=>resolveModels({provider:'custom',model:'local',base_url:'file:///secret'}));});
test('keyless local compatible endpoint actually streams through SDK',async()=>{
  let requests=0;
  const server=http.createServer((request,response)=>{requests++;assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,undefined);response.writeHead(200,{'Content-Type':'text/event-stream'});const event=(delta,finish_reason=null)=>({id:'local-qa',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,delta,finish_reason}]});response.write('data: '+JSON.stringify(event({role:'assistant',content:'OK'}))+'\n\n');response.write('data: '+JSON.stringify({...event({},'stop'),usage:{prompt_tokens:4,completion_tokens:1,total_tokens:5}})+'\n\n');response.end('data: [DONE]\n\n');});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{const events=[];await handle({id:'keyless',kind:'test',config:{provider:'custom',model:'local',base_url:`http://127.0.0.1:${server.address().port}/v1`},apiKey:null},(type,data)=>events.push({type,data}));assert.equal(requests,1);assert.ok(events.some(e=>e.type==='text'&&e.data==='连接成功'));}finally{await new Promise(ok=>server.close(ok));}
});
test('deadline aborts streaming and yields no completed artifact',async()=>{
  const faux=fauxProvider({tokensPerSecond:100});faux.setResponses([fauxAssistantMessage('分析'.repeat(2000))]);const models=createModels();models.setProvider(faux.provider);const events=[];
  await assert.rejects(handle(base,(type,data)=>events.push({type,data}),models,10),/abort|cancel|取消/i);
  assert.ok(!events.some(e=>e.type==='artifact'||e.type==='history'));
});
