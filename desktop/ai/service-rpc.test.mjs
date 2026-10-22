import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import http from 'node:http';

test('real stdio service streams through a keyless local endpoint and replays the same request',async()=>{
  let calls=0;
  const server=http.createServer((request,response)=>{calls++;assert.equal(request.headers.authorization,undefined);response.writeHead(200,{'Content-Type':'text/event-stream'});const chunk=(delta,finish_reason=null)=>({id:'local-rpc',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,delta,finish_reason}]});response.write('data: '+JSON.stringify(chunk({role:'assistant',content:'本地完整对话'}))+'\n\n');response.write('data: '+JSON.stringify({...chunk({},'stop'),usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}})+'\n\n');response.end('data: [DONE]\n\n');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=await mkdtemp(join(tmpdir(),'roaster-ai-rpc-'));const child=spawn(process.execPath,[resolve(dirname(fileURLToPath(import.meta.url)),'service.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);const pending=new Map(),events=[];
  const lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{const event=JSON.parse(line);if((event.type==='result'||event.type==='error')&&pending.has(event.id)){const {resolve,reject,timer}=pending.get(event.id);pending.delete(event.id);clearTimeout(timer);if(event.type==='error')reject(Error(event.data.message));else resolve(event.data);}else events.push(event);});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>reject(Error('RPC timeout '+method)),10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  try{
    assert.equal((await rpc('initialize',{data_dir:dir,master_key:randomBytes(32).toString('base64')})).ready,true);
    assert.equal((await rpc('providers')).filter(p=>p.subscription).length,5);
    const profile=await rpc('profiles.save',{profile:{name:'本地测试',mode:'custom',provider:'custom',model:'local',protocol:'openai-completions',base_url:`http://127.0.0.1:${server.address().port}/v1`}}),conversation=await rpc('conversations.create',{profile_id:profile.id});
    const params={id:'one-paid-request',conversation_id:conversation.id,revision:conversation.revision,profile_id:profile.id,prompt:'你好'};const job=await rpc('runs.start',params);
    const end=Date.now()+8000;while(!events.some(event=>event.id===job.id&&event.type==='done')){if(Date.now()>end)throw Error('stream timeout '+JSON.stringify(events));await new Promise(resolve=>setTimeout(resolve,10));}
    const history=await rpc('conversations.get',{id:conversation.id});assert.equal(history.messages.at(-1).content,'本地完整对话');assert.equal((await rpc('runs.start',params)).replayed,true);assert.equal(calls,1);assert.ok((await rpc('runs.events',{id:job.id})).some(event=>event.type==='usage'));
    child.stdin.end();const exit=await new Promise(resolve=>child.once('exit',resolve));assert.equal(exit,0,stderr);
  }finally{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('test cleanup'));}child.kill();lines.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
