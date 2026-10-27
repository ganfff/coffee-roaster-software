// Loopback-only development host: current source + simulator + real local AI core.
// Never imports a controller or opens a serial port.
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {readFile, writeFile, mkdir, unlink} from 'node:fs/promises';
import {randomBytes, randomInt} from 'node:crypto';
import {resolve, dirname, extname, sep, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {AIService} from '../ai/service-core.mjs';
import {workbenchPython} from './python-runtime.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const defaultDataDir=resolve(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || join(process.env.HOME || root,'.local/state'),'RoasterDesktop/dev-web');
async function masterKey(dir) {
  const windows=process.platform==='win32', file=join(dir,windows?'master.dpapi':'master.key');
  let stored;try{stored=await readFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!windows){if(stored)return stored.toString('utf8');const value=randomBytes(32).toString('base64');await writeFile(file,value,{mode:0o600,flag:'wx'});return value;}
  // DPAPI CurrentUser, plaintext travels only through this child process's pipes.
  const script=`Add-Type -AssemblyName System.Security; $value=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${stored?'Unprotect':'Protect'}($value,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const value=stored?stored.toString('utf8'):randomBytes(32).toString('base64');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:value,encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error('无法访问当前 Windows 用户的调试 AI 加密密钥');
  if(stored)return result.stdout.trim();
  await writeFile(file,result.stdout.trim(),{mode:0o600,flag:'wx'});return value;
}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req) {let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)throw Error('请求不能超过24MiB');chunks.push(chunk);}return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}

export async function startDevServer({port=18180,scenario='idle',freeze=false,device=false,dataDir=defaultDataDir,serviceFactory=options=>new AIService(options)}={}) {
  const aiSockets=new Set(),controlSockets=new Set(),events=[],token=randomBytes(32).toString('base64url'),shutdownToken=randomBytes(32).toString('base64url'),deviceToken=randomBytes(32).toString('base64url'),code=String(randomInt(10000000,100000000));
  let cursor=0,origin,simOrigin,closed=false,deviceStopping=false,server,service;
  const simulator=device
    ?spawn(workbenchPython(),[resolve(root,'roaster/device_main.py'),'--port','0','--data-dir',resolve(dataDir,'device'),'--shutdown-token',deviceToken],{cwd:resolve(root,'roaster'),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    :spawn(process.execPath,[resolve(root,'desktop/tools/roaster-simulator.mjs'),'--scenario='+scenario,...(freeze?['--freeze']:[])],{cwd:resolve(root,'desktop'),env:{...process.env,ROASTER_SIM_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const stopDevice=async()=>{
    if(!device||!simOrigin||deviceStopping||simulator.exitCode!==null)return;
    const response=await fetch(simOrigin+'/api/v1/runtime/shutdown',{method:'POST',headers:{'x-roaster-runtime':deviceToken},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error((await response.json()).detail||'请先结束本锅再关闭调试服务');
    deviceStopping=true;
  };
  const close=async()=>{if(closed)return;await stopDevice();closed=true;for(const socket of [...aiSockets,...controlSockets])socket.terminate();server?.close();server?.closeAllConnections();if(!device)simulator.kill();await service?.shutdown();};
  try {
    simOrigin=await new Promise((ok,no)=>{let logs='';const timer=setTimeout(()=>no(Error('控制服务启动超时：'+logs.slice(-1200))),20000);for(const stream of [simulator.stdout,simulator.stderr])stream.on('data',chunk=>{logs+=String(chunk);const match=/(?:ready at|Uvicorn running on) (http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk));if(match){clearTimeout(timer);ok(match[1]);}});simulator.once('error',error=>{clearTimeout(timer);no(error);});simulator.once('exit',()=>{clearTimeout(timer);no(Error('控制服务启动失败：'+logs.slice(-1200)));});});
    await mkdir(dataDir,{recursive:true});
    service=serviceFactory({emit:event=>{const item={cursor:++cursor,event};events.push(item);if(events.length>2000)events.shift();for(const ws of aiSockets)if(ws.readyState===1)ws.send(JSON.stringify({cursor,events:[event]}));}});
    await service.initialize({data_dir:resolve(dataDir,'ai'),master_key:await masterKey(dataDir)});
    const authorized=req=>req.headers.authorization==='Bearer '+token || (req.headers.cookie||'').split(';').some(item=>item.trim()==='roaster_dev='+token);
    const sameOrigin=req=>req.headers.host===new URL(origin).host&&(!req.headers.origin||req.headers.origin===origin);
    const handler=async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(!sameOrigin(req))return json(res,403,{detail:'调试服务只接受当前本机地址的同源请求'});
      const url=new URL(req.url,origin),path=url.pathname;
      try {
        if(path==='/__debug__/health')return json(res,200,{mode:device?'device':'safe-simulator',origin,project:root,pid:process.pid,ai:true,scenario});
        if(path==='/__debug__/shutdown'&&req.method==='POST') {if(req.headers['x-roaster-debug']!==shutdownToken)return json(res,403,{detail:'无效调试会话'});await stopDevice();json(res,200,{stopped:true});setTimeout(()=>void close().catch(error=>console.error(error.message)),50);return;}
        if(path==='/__debug__/context.js') {res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end('window.ROASTER_DEBUG='+JSON.stringify({backend:origin,pairingCode:code,mode:device?'device':'safe-simulator'})+';');}
        if(path==='/api/v1/ai/status')return json(res,200,{ready:true,paired:authorized(req),debug:true});
        if(path==='/api/v1/ai/pair'&&req.method==='POST') {const input=await body(req);if(input.code!==code)return json(res,403,{detail:'调试会话配对码无效，请刷新当前调试页面'});res.setHeader('Set-Cookie',`roaster_dev=${token}; HttpOnly; SameSite=Strict; Path=/`);return json(res,200,{id:'local-debug',...(input.native?{token}:{})});}
        if(path.startsWith('/api/v1/ai/')) {
          if(!authorized(req))return json(res,401,{detail:'请在调试页面配对本机 AI'});
          if(path==='/api/v1/ai/rpc'&&req.method==='POST'){const input=await body(req);return json(res,200,await service.dispatch(input.method,input.params||{}));}
          if(path==='/api/v1/ai/events'){const after=Number(url.searchParams.get('after')||0);if(after>=cursor)await new Promise(ok=>setTimeout(ok,200));return json(res,200,{cursor,events:events.filter(item=>item.cursor>after).map(item=>item.event),replay_required:events.length>0&&after<events[0].cursor-1});}
          if(path==='/api/v1/ai/clients')return json(res,200,[{id:'local-debug',name:'本机调试'}]);
          return json(res,404,{detail:'此调试 AI 接口不存在'});
        }
        if(path.startsWith('/api/')) {
          const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)throw Error('请求过大');chunks.push(chunk);}const bytes=Buffer.concat(chunks);
          const upstream=await fetch(simOrigin+url.pathname+url.search,{method:req.method,headers:{'Content-Type':req.headers['content-type']||'application/json'},body:bytes.length?bytes:undefined,signal:AbortSignal.timeout(45000)});
          res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('Content-Type')||'application/json'});res.end(Buffer.from(await upstream.arrayBuffer()));return;
        }
        if(!['GET','HEAD'].includes(req.method))return json(res,405,{detail:'不支持此请求方法'});
        const staticRoot=resolve(root,'roaster/static'),file=resolve(staticRoot,'.'+decodeURIComponent(path==='/'?'/index.html':path));
        if(!file.startsWith(staticRoot+sep))return json(res,403,{detail:'资源路径不可用'});
        let bytes=await readFile(file);const ext=extname(file);
        if(ext==='.html'){bytes=Buffer.from(bytes.toString('utf8').replace('</head>','<script src="/__debug__/context.js"></script></head>'));res.setHeader('Set-Cookie',`roaster_dev=${token}; HttpOnly; SameSite=Strict; Path=/`);}
        res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.png':'image/png','.ico':'image/x-icon'})[ext]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:bytes);
      }catch(error){json(res,error.code==='ENOENT'?404:422,{detail:error.code==='ENOENT'?'资源不存在':service.error(error).message});}
    };
    server=http.createServer(handler);
    const aiWs=new WebSocketServer({noServer:true}),controlWs=new WebSocketServer({noServer:true});
    server.on('upgrade',(req,socket,head)=>{
      if(!sameOrigin(req)){socket.destroy();return;}
      if(new URL(req.url,origin).pathname==='/api/v1/ai/ws'){
        if(!authorized(req)){socket.destroy();return;}
        aiWs.handleUpgrade(req,socket,head,ws=>{aiSockets.add(ws);const after=Number(new URL(req.url,origin).searchParams.get('after')||0);ws.send(JSON.stringify({cursor,events:events.filter(item=>item.cursor>after).map(item=>item.event)}));ws.on('close',()=>aiSockets.delete(ws));});
      }else if(new URL(req.url,origin).pathname==='/ws')controlWs.handleUpgrade(req,socket,head,ws=>{
        controlSockets.add(ws);const upstream=new WebSocket(simOrigin.replace('http:','ws:')+'/ws');const queue=[];
        upstream.on('open',()=>{for(const bytes of queue)upstream.send(bytes);});upstream.on('message',bytes=>{if(ws.readyState===1)ws.send(bytes.toString());});
        ws.on('message',bytes=>{const message=bytes.toString();if(upstream.readyState===1)upstream.send(message);else if(upstream.readyState===0&&queue.length<32)queue.push(message);});
        ws.on('close',()=>{controlSockets.delete(ws);upstream.close();});ws.on('error',()=>upstream.close());upstream.on('error',()=>ws.close());upstream.on('close',()=>ws.close());
      });else socket.destroy();
    });
    await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});origin='http://127.0.0.1:'+server.address().port;
    simulator.once('exit',()=>{if(!closed){console.error('安全模拟器已退出，停止调试服务');void close();}});
    return {origin,close,server,dataDir,shutdownToken};
  }catch(error){await close();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),value=(key,fallback)=>args.find(arg=>arg.startsWith(key+'='))?.slice(key.length+1)??fallback;
  try{const host=await startDevServer({port:Number(value('--port',process.env.ROASTER_DEV_PORT||18180)),scenario:value('--scenario','idle'),freeze:args.includes('--freeze'),device:!args.includes('--simulator')});
    const meta=join(host.dataDir,'server.json');await writeFile(meta,JSON.stringify({origin:host.origin,pid:process.pid,shutdownToken:host.shutdownToken,project:root}));
    console.log('Roaster debug ready at '+host.origin);
    let closing=false;const stop=async()=>{if(closing)return;closing=true;try{await host.close();await unlink(meta).catch(()=>{});}catch(error){closing=false;console.error(error.message);}};process.once('SIGINT',stop);process.once('SIGTERM',stop);host.server.on('close',()=>void unlink(meta).catch(()=>{}));
  }catch(error){console.error(error.code==='EADDRINUSE'?'调试端口已被占用；请关闭旧调试服务或使用 --port=其他端口。':error.message);process.exitCode=1;}
}
