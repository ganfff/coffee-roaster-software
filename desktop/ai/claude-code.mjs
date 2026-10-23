// Run the unmodified official client. Never read or forward its credential files.
import {spawn} from 'node:child_process';
import {access,mkdir,readFile} from 'node:fs/promises';
import {join,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';

export const MIN_CLAUDE_VERSION = '2.1.248';
export function supportedVersion(version) {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const actual = match.slice(1).map(Number), minimum = MIN_CLAUDE_VERSION.split('.').map(Number);
  for (let i=0;i<3;i++) if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  return true;
}
export function subscriptionEnvironment(source=process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_|API_|CUSTOM|EXPERIMENTAL_AGENT_TEAMS)|CLAUDE_CONFIG_DIR|CLAUDE_SESSION_ID|CLAUDECODE|AWS_|GOOGLE_|GCLOUD_|VERTEX_|AZURE_)/i.test(key)));
}
export function cliArguments({model, schema}={}) {
  const args = ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--safe-mode','--tools','','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--no-session-persistence','--permission-mode','dontAsk'];
  if (model) args.push('--model',model);
  if (schema) args.push('--json-schema',JSON.stringify(schema));
  return args;
}
export class ClaudeCode {
  constructor({spawnProcess=spawn,executable,timeout=30000}={}) {this.spawnProcess=spawnProcess;this.executable=executable;this.timeout=timeout;}
  async locate() {
    if (this.executable) return this.executable;
    const name = process.platform === 'win32' ? 'claude.exe':'claude';
    const candidates = [join(homedir(),'.local','bin',name)];
    if (process.platform === 'win32') {
      const packageDir=join(process.env.APPDATA || join(homedir(),'AppData','Roaming'),'npm','node_modules','@anthropic-ai','claude-code');
      try {const metadata=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));if(metadata.name === '@anthropic-ai/claude-code')candidates.push(join(packageDir,'bin','claude.exe'));} catch {}
    }
    for (const folder of (process.env.PATH || '').split(delimiter).filter(Boolean)) candidates.push(join(folder.replace(/^"|"$/g,''),name));
    for (const file of candidates) try {await access(file);return file;} catch {}
    throw Object.assign(Error('未安装 Claude Code，请从官方安装入口安装后重试'),{code:'CLAUDE_INSTALL'});
  }
  async command(args,{cwd,signal,onText,timeout=this.timeout}={}) {
    const executable=await this.locate();
    return new Promise((resolve,reject)=>{
      const child=this.spawnProcess(executable,args,{cwd,env:subscriptionEnvironment(),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='',size=0;let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
      const cancel=()=>{child.kill();finish(signal?.reason || Error('操作已取消'));};
      const timer=setTimeout(()=>{child.kill();finish(Error('Claude Code 操作超时，请重试'));},timeout);
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
      child.stdout.on('data',bytes=>{size+=bytes.length;if(size>1024*1024){child.kill();finish(Error('Claude Code 输出过大'));return;}const part=String(bytes);output+=part;onText?.(part);});
      // Do not expose stderr, which can contain account or environment information.
      child.stderr.resume();
      child.on('error',()=>finish(Error('无法启动官方 Claude Code，请检查安装')));
      child.on('close',code=>finish(code===0?null:Error('Claude Code 未完成操作，请在官方客户端检查登录状态'),output));
    });
  }
  async check(options={}) {
    const version=await this.command(['--version'],options);
    if (!supportedVersion(version)) throw Object.assign(Error(`请将官方 Claude Code 升级到 ${MIN_CLAUDE_VERSION} 或更新版本后重试`),{code:'CLAUDE_UPDATE'});
    return version.trim();
  }
  async assertSubscription(options={}) {
    let status;try{status=JSON.parse(await this.command(['auth','status','--json'],options));}catch{throw Object.assign(Error('请先在官方 Claude Code 中完成订阅登录'),{code:'AUTH'});}
    if(!status.loggedIn || !/claude.?ai|oauth|subscription/i.test(String(status.authMethod || '')))throw Object.assign(Error('官方 Claude Code 当前未使用 Claude 订阅，请在官方客户端切换登录方式'),{code:'AUTH'});
  }
  async login({cwd,signal,notify}={}) {
    await this.check({cwd,signal});
    notify?.({type:'message',message:'正在打开官方 Claude Code 登录。授权由官方客户端完成。'});
    await this.command(['auth','login'],{cwd,signal,timeout:300000,onText:text=>{
      // Only official HTTPS authorization links are shown, never arbitrary CLI output.
      const url=text.match(/https:\/\/(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/[^\s\u001b]+/)?.[0];
      if(url)notify?.({type:'auth_url',url});
    }});
  }
  async session({cwd,signal,model,schema,onEvent,request}={}) {
    await mkdir(cwd,{recursive:true,mode:0o700});
    await this.check({cwd,signal});
    await this.assertSubscription({cwd,signal});
    const executable=await this.locate();
    return new Promise((resolve,reject)=>{
      const child=this.spawnProcess(executable,cliArguments({model,schema}),{cwd,env:subscriptionEnvironment(),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      const reader=createInterface({input:child.stdout,crlfDelay:Infinity});
      const requestId=randomUUID();let settled=false,initialized=false,total=0;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);reader.close();child.stdin.end();child.kill();error?reject(error):resolve(value);};
      const cancel=()=>finish(signal?.reason || Error('已停止 Claude 回复'));
      const timer=setTimeout(()=>finish(Error('Claude Code 响应超时，请重试')),request?180000:this.timeout);
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
      child.stderr.resume();child.on('error',()=>finish(Error('无法启动 Claude Code')));
      child.stdin.on('error',()=>finish(Error('Claude Code 输入连接已关闭')));
      child.on('close',()=>{if(!settled)finish(Error('Claude Code 提前退出，请检查官方登录或重试'));});
      reader.on('line',line=>{
        total+=line.length;if(line.length>8*1024*1024 || total>24*1024*1024){finish(Error('Claude Code 响应超过限制'));return;}
        let event;try{event=JSON.parse(line);}catch{finish(Error('Claude Code 返回了无法识别的消息'));return;}
        if(event.type==='control_response' && event.response?.request_id===requestId){
          if(event.response.subtype!=='success'){finish(Error('Claude Code 初始化失败，请检查官方登录'));return;}
          const data=event.response.response;
          // A subscription connection must never silently use an API key or cloud account.
          const source=String(data?.account?.apiKeySource || '').toLowerCase();
          if(source && source!=='none' && !/oauth|claude.?ai|subscription/.test(source)){finish(Error('官方客户端当前使用 API 或云服务凭据，请先切换到 Claude 订阅登录'));return;}
          if(!request){finish(null,data);return;}
          if(initialized)return;initialized=true;
          child.stdin.write(JSON.stringify({type:'user',session_id:'',message:{role:'user',content:request},parent_tool_use_id:null,client_composed:true})+'\n');
        }else if(event.type==='result'){
          if(event.is_error || event.subtype!=='success'){finish(Error('Claude 回复未完成，请检查订阅额度或重试'));return;}
          finish(null,event);
        }else onEvent?.(event);
      });
      child.stdin.write(JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'initialize',hooks:null}})+'\n');
    });
  }
  async models(options) {
    const result=await this.session(options);
    if(!Array.isArray(result?.models))throw Error('Claude Code 未返回模型目录，请重新登录或更新客户端');
    return result.models.filter(m=>typeof m.value==='string'&&m.value.length<=200).map(m=>({id:m.value,name:m.displayName||m.value,provider:'anthropic',api:'claude-code',baseUrl:'',input:['text','image'],reasoning:false,contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}));
  }
  stream(model,context,options={}) {
    const stream=createAssistantMessageEventStream();
    const response={role:'assistant',content:[],api:'claude-code',provider:'anthropic',model:model.id,timestamp:Date.now(),stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const tools=context.tools || [];
    const schema={type:'object',properties:{reply:{type:'string'},calls:{type:'array',maxItems:8,items:{oneOf:tools.map(tool=>({type:'object',properties:{name:{const:tool.name},arguments:tool.parameters},required:['name','arguments'],additionalProperties:false}))}}},required:['reply','calls'],additionalProperties:false};
    if(!tools.length)delete schema.properties.calls.items.oneOf;
    const textBlock={type:'text',text:''};response.content.push(textBlock);
    const emitText=text=>{textBlock.text+=text;stream.push({type:'text_delta',contentIndex:0,delta:text,partial:response});};
    // Rebuild history as data. Tool transcripts cannot become instructions or local commands.
    const request=[{type:'text',text:context.systemPrompt+'\n返回 reply 和 calls；calls 只能使用给定的只读/提案接口，工具结果不代表用户已采用。\n对话与工具结果：\n'+JSON.stringify(context.messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.filter(b=>b.type!=='image'):m.content})))}];
    for(const message of context.messages)for(const block of Array.isArray(message.content)?message.content:[])if(block.type==='image')request.push({type:'image',source:{type:'base64',media_type:block.mimeType,data:block.data}});
    void this.session({cwd:options.claudeCwd,signal:options.signal,model:model.id,schema,request,onEvent:event=>{
      const delta=event.type==='stream_event'?event.event?.delta:null;
      if(delta?.type==='text_delta')emitText(delta.text || '');
    }}).then(result=>{
      const data=result.structured_output;
      if(!data || typeof data.reply!=='string' || !Array.isArray(data.calls) || data.calls.length>8)throw Error('Claude 未返回完整的结构化回复，请重试');
      if(!textBlock.text)emitText(data.reply);
      for(const call of data.calls){if(!tools.some(tool=>tool.name===call.name)||!call.arguments||typeof call.arguments!=='object')throw Error('Claude 返回了未授权的工具请求');response.content.push({type:'toolCall',id:randomUUID(),name:call.name,arguments:call.arguments});}
      if(data.calls.length)response.stopReason='toolUse';
      const usage=result.usage || {};response.usage.input=usage.input_tokens||0;response.usage.output=usage.output_tokens||0;response.usage.totalTokens=response.usage.input+response.usage.output;
      stream.push({type:'done',reason:response.stopReason,message:response});stream.end(response);
    }).catch(error=>{response.stopReason=options.signal?.aborted?'aborted':'error';response.errorMessage=error.message;stream.push({type:'error',reason:response.stopReason,error:response});stream.end(response);});
    return stream;
  }
}
