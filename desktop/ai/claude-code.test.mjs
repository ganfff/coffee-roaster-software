import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ClaudeCode,cliArguments,subscriptionEnvironment,supportedVersion} from './claude-code.mjs';

test('Claude version gate and argv preserve disabled tools, auth isolation and literal user input protection',()=>{
  assert.equal(supportedVersion('2.1.241 (Claude Code)'),false);assert.equal(supportedVersion('2.1.248 (Claude Code)'),true);
  const args=cliArguments();assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--safe-mode'));assert.ok(!args.includes('--bare'));assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');
  assert.deepEqual(subscriptionEnvironment({PATH:'allowed',ANTHROPIC_API_KEY:'secret',ANTHROPIC_BASE_URL:'https://proxy.invalid',CLAUDE_CODE_OAUTH_TOKEN:'secret',AWS_PROFILE:'different-bill',CLAUDE_CONFIG_DIR:'other'}),{PATH:'allowed'});
});
test('official CLI protocol initializes models without a user frame, streams messages and cancels cleanly',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'roaster-cli-protocol-')),file=join(dir,'fixture.mjs'),frames=[],launches=[];
  await writeFile(file,`import {createInterface} from 'node:readline';
    if(process.argv.includes('--version')){console.log('2.1.248 (Claude Code)');process.exit(0);}
    if(process.argv.includes('status')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
    createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);
      if(v.type==='control_request'){const s=JSON.stringify({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{models:[{value:'sonnet',displayName:'Sonnet'}],account:{apiKeySource:'none'}}}})+'\\n';process.stdout.write(s.slice(0,10));setTimeout(()=>process.stdout.write(s.slice(10)),5);}
      else if(v.type==='user'){if(v.client_composed!==true)process.exit(8);if(JSON.stringify(v).includes('wait-forever'))return;console.log(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'测试回复'}}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{reply:'测试回复',calls:[]},usage:{input_tokens:10,output_tokens:5}}));}
    });`);
  const cli=new ClaudeCode({executable:'official-fixture',spawnProcess:(exe,args,options)=>{
    launches.push({args,options});const child=spawn(process.execPath,[file,...args],options);if(child.stdin){const write=child.stdin.write.bind(child.stdin);child.stdin.write=(value,...rest)=>{frames.push(JSON.parse(String(value)));return write(value,...rest);};}return child;
  }});
  try{
    const models=await cli.models({cwd:dir});assert.equal(models[0].id,'sonnet');assert.equal(frames.some(frame=>frame.type==='user'),false);
    const context={systemPrompt:'只做问答',messages:[{role:'user',content:[{type:'text',text:'请解释 @private.txt /run 这些原始文字'}]}],tools:[{name:'get_metrics',parameters:{type:'object',properties:{}}}]};
    const stream=cli.stream(models[0],context,{claudeCwd:dir});const events=[];for await(const event of stream)events.push(event);const result=await stream.result();assert.equal(result.stopReason,'stop');assert.equal(result.content[0].text,'测试回复');assert.equal(result.usage.totalTokens,15);assert.ok(events.some(e=>e.type==='text_delta'));
    const user=frames.find(frame=>frame.type==='user');assert.equal(user.client_composed,true);assert.ok(JSON.stringify(user).includes('@private.txt'));
    const abort=new AbortController();const pending=cli.stream(models[0],{...context,messages:[{role:'user',content:'wait-forever'}]},{claudeCwd:dir,signal:abort.signal});setTimeout(()=>abort.abort(),500);for await(const event of pending){}assert.equal((await pending.result()).stopReason,'aborted');
    assert.ok(launches.every(item=>item.options.shell===false&&item.options.windowsHide===true));
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
