import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
// OAuth flows use opaque lazy imports; static registration makes packaged ESM self-contained.
import {registerBunOAuthFlows} from '@earendil-works/pi-ai/bun-oauth';
import {AIService,safeError} from './service-core.mjs';
registerBunOAuthFlows();
export {AIService} from './service-core.mjs';

export async function serve(input=process.stdin,output=process.stdout){
  const write=value=>output.write(JSON.stringify(value)+'\n');
  const service=new AIService({emit:write});
  const reader=readline.createInterface({input,crlfDelay:Infinity});
  const calls=new Set();
  reader.on('line',line=>{let request;try{if(line.length>48*1024*1024)throw Error('AI 消息过大');request=JSON.parse(line);if(typeof request.id!=='string'||typeof request.method!=='string')throw Error('AI 请求格式无效');}catch(error){write({id:request?.id||'',type:'error',data:safeError(error)});return;}
    const call=service.dispatch(request.method,request.params||{}).then(data=>write({id:request.id,type:'result',data})).catch(error=>write({id:request.id,type:'error',data:service.error(error)})).finally(()=>calls.delete(call));calls.add(call);
  });
  await new Promise(resolve=>reader.once('close',resolve));await Promise.allSettled(calls);await service.shutdown();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const stop=()=>{process.stdin.destroy();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  await serve();
}
