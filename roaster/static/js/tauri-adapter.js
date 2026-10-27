/* Tauri uses an owned local device service or an explicitly selected LAN service. */
(function () {
  'use strict';
  const desktop='__TAURI_INTERNALS__' in window,debug=window.ROASTER_DEBUG;
  const read=key=>{try{return localStorage.getItem(key)||'';}catch{return '';}};
  const save=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
  const clean=value=>String(value||'').trim().replace(/\/+$/,'');
  let localBackend='http://127.0.0.1:18181',runtimeError='';
  const previous=read('roaster.backendUrl'),explicitTarget=read('roaster.connectionTarget');
  const remote=explicitTarget==='remote'||(!explicitTarget&&/^https?:\/\/(?!localhost(?=[:/]|$)|127\.0\.0\.1(?=[:/]|$))/.test(previous));
  const getBackend=()=>debug?.backend||(remote?clean(previous):localBackend);
  const originalFetch=window.fetch.bind(window);
  window.RoasterConnectionReady=desktop&&!debug&&!remote
    ?window.__TAURI_INTERNALS__.invoke('device_runtime').then(value=>{localBackend=value.url;window.ROASTER_BACKEND=getBackend();})
      .catch(error=>{runtimeError=String(error?.message||error);})
    :Promise.resolve();
  if(debug)document.documentElement.dataset.debug=debug.mode==='safe-simulator'?'simulator':'device';
  window.ROASTER_BACKEND=desktop?getBackend():location.origin;
  function switchBackend(value){
    const url=new URL(clean(value));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('请输入控制服务的 http(s) 地址和端口');
    if(!desktop||debug){location.assign(url.origin);return;}
    save('roaster.backendUrl',url.origin);save('roaster.connectionTarget','remote');location.reload();
  }
  function switchLocal(){if(!desktop||debug)return;save('roaster.connectionTarget','local');save('roaster.backendUrl','');location.reload();}
  window.RoasterBackend={get url(){return desktop?getBackend():location.origin;},connect:switchBackend,local:switchLocal};
  if(desktop){
    const absolute=value=>typeof value==='string'&&value.startsWith('/')?getBackend()+value:value;
    window.fetch=(input,init)=>window.RoasterConnectionReady.then(()=>originalFetch(absolute(input),init));
    const OriginalWebSocket=window.WebSocket;
    function DeviceWebSocket(value,protocols){
      const url=new URL(value);
      if(url.host===location.host){const backend=new URL(getBackend());url.host=backend.host;url.protocol=backend.protocol==='https:'?'wss:':'ws:';}
      return protocols===undefined?new OriginalWebSocket(url.href):new OriginalWebSocket(url.href,protocols);
    }
    for(const name of ['CONNECTING','OPEN','CLOSING','CLOSED'])DeviceWebSocket[name]=OriginalWebSocket[name];
    DeviceWebSocket.prototype=OriginalWebSocket.prototype;window.WebSocket=DeviceWebSocket;
    const originalOpen=window.open.bind(window);window.open=(value,...rest)=>originalOpen(absolute(value),...rest);
  }
  async function mount(){
    await window.RoasterConnectionReady;
    const section=document.getElementById('backend-section');
    if(section){
      section.querySelector('#backend-current').textContent=window.RoasterBackend.url;
      section.querySelector('#backend-custom').value=remote?previous:'';
      const local=section.querySelector('#backend-preset-local');local.hidden=!desktop||!!debug;local.onclick=switchLocal;
      section.querySelector('#backend-apply').onclick=()=>{try{switchBackend(section.querySelector('#backend-custom').value);}catch(error){document.getElementById('device-settings-status').textContent=error.message;}};
    }else if(desktop){
      const button=document.createElement('button');button.id='tauri-settings-btn';button.className='tauri-settings-btn';button.title='设备连接';button.setAttribute('aria-label','设备连接');button.innerHTML='<i class="ph ph-plugs-connected" aria-hidden="true"></i>';
      button.onclick=()=>{location.href='index.html?settings=device';};document.body.append(button);
    }
    if(!desktop||debug)return;
    try{
      if(runtimeError)throw Error(runtimeError);
      const response=await originalFetch(getBackend()+'/api/v1/status',{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('控制服务未就绪');
    }catch(error){
      const notice=document.createElement('section');notice.id='backend-connection-notice';notice.className='backend-connection-notice';notice.setAttribute('role','status');
      const text=document.createElement('p');text.textContent='控制服务未连接：'+String(error.message||error);notice.append(text);
      const settings=document.createElement('button');settings.className='ctrl-btn';settings.textContent='设备连接';settings.onclick=()=>{notice.remove();window.RoasterSettings?.open('device');};notice.append(settings);
      const retry=document.createElement('button');retry.className='ctrl-btn';retry.textContent='重试';retry.onclick=()=>location.reload();notice.append(retry);document.body.append(notice);
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
