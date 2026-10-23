import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
window.RoasterNativeAI={invoke,listen};

// Desktop accounts always belong to this computer. Device connection is separate.
// Credentials never pass through this object after the initial save/pair action.
const native=!!window.__TAURI_INTERNALS__;
// The live-source desktop and browser use the same local account vault.
// Packaged/offline desktops continue to use their persistent native service.
const localDebug=native&&window.ROASTER_DEBUG?.mode==='safe-simulator'&&window.ROASTER_DEBUG.backend===location.origin&&location.hostname==='127.0.0.1';
const webHost=!native||localDebug;
let selected={kind:webHost?'backend':'local',backend:location.origin};
let socket=null, reconnect=null, disposed=false, cursor=0;
const subscribers=new Set();
const emit=event=>{for(const callback of subscribers){try{callback(event);}catch{}}};
const response=async result=>{const value=await result.json();if(!result.ok)throw Error(typeof value.detail==='string'?value.detail:value.error?.message||'AI 请求失败');return value;};
const webRequest=(path,options={})=>fetch('/api/v1/ai'+path,{credentials:'same-origin',...options}).then(response);
function connectWeb(){
  if(!webHost||disposed||!subscribers.size||socket)return;
  const url=new URL('/api/v1/ai/ws',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('after',String(cursor));
  socket=new WebSocket(url);
  socket.onopen=()=>emit({id:'host',type:'replay_required',data:{}});
  socket.onmessage=message=>{let batch;try{batch=JSON.parse(message.data);}catch{return;}cursor=batch.cursor??cursor;if(batch.replay_required)emit({id:'host',type:'replay_required',data:{}});for(const event of batch.events||[])emit(event);};
  socket.onclose=event=>{socket=null;if(event.code===4401){emit({id:'host',type:'pairing_required',data:{message:'AI 配对已失效，请重新配对'}});return;}if(!disposed&&subscribers.size)reconnect=setTimeout(connectWeb,1500);};
}
let nativeUnlisten=null;
if(!webHost)listen('roaster-ai-service',event=>{const value=event.payload;if(selected.kind==='local'&&value.host)return;if(selected.kind==='backend'&&value.host!==selected.backend)return;emit(value);}).then(unlisten=>{nativeUnlisten=unlisten;});
window.RoasterAITransport={
  native,
  get host(){return {...selected};},
  async setHost(value){
    if(!webHost)await invoke('ai_remote_stop');
    selected={kind:webHost?'backend':'local',backend:location.origin};cursor=0;
    if(socket){socket.onclose=null;socket.close();socket=null;}clearTimeout(reconnect);connectWeb();
  },
  request(method,params={}){
    if(!webHost)return invoke('ai_rpc',{method,params});
      return webRequest('/rpc',{method:'POST',keepalive:method==='runs.cancel',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  },
  listen(callback){subscribers.add(callback);connectWeb();return ()=>{subscribers.delete(callback);if(!subscribers.size&&socket){socket.onclose=null;socket.close();socket=null;}};},
  status(){return !webHost?Promise.resolve({available:true,paired:true,host:'local'}):webRequest('/status');},
  async pair(code,name){const result=!webHost?await invoke('ai_remote_pair',{backend:selected.backend,code,name}):await webRequest('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,name})});connectWeb();return result;},
  clients(){return !webHost?invoke('ai_remote_clients',{backend:selected.backend}):webRequest('/clients');},
  revoke(id){return !webHost?invoke('ai_remote_revoke',{backend:selected.backend,id}):webRequest('/clients/'+encodeURIComponent(id),{method:'DELETE'});},
  dispose(){disposed=true;clearTimeout(reconnect);socket?.close();nativeUnlisten?.();subscribers.clear();}
};
