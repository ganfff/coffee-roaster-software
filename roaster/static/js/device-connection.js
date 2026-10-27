/* Device status reflects validated RTU replies rather than an open TCP socket. */
(function () {
  'use strict';
  const $=id=>document.getElementById(id);
  let connection=null, settings=null, ports=[], online=false, state='IDLE', dirty=false, busy=false;
  const text=(node,value)=>{if(node&&node.textContent!==value)node.textContent=value;};
  function render() {
    if(connection)document.documentElement.dataset.connectionMode=connection.mode;
    const simulator=connection?.mode==='simulator',connected=online&&connection?.connected;
    const label=simulator?'模拟器':connection?.port||'未选择串口';
    const status=!online?'服务未连接':connected?'已连接':connection?.transport_open?'等待响应':'未连接';
    const copy=label+' · '+status;
    text(document.querySelector('.connection-copy'),copy);text($('device-status-text'),copy);
    const tc4s=$('conn-status-tc4s');
    if(tc4s){tc4s.title=copy;text(tc4s.parentElement.querySelector('.conn-label'),simulator?'模拟':'TC4S');}
    if($('device-apply'))$('device-apply').disabled=busy||state!=='IDLE';
    if($('btn-start'))$('btn-start').disabled=!connected;
    if($('device-serial-fields'))$('device-serial-fields').disabled=busy||$('device-mode').value==='simulator'||state!=='IDLE';
    if($('device-mode'))$('device-mode').disabled=busy||state!=='IDLE';
    if(!busy&&state!=='IDLE')text($('device-settings-status'),'请先结束并保存本锅，再修改连接');
    else if(!busy&&!dirty&&connection?.error)text($('device-settings-status'),connection.error);
  }
  function populate() {
    if(!$('device-port'))return;
    const select=$('device-port'),selected=dirty?select.value:settings?.port||'';
    select.replaceChildren(new Option('自动识别 USB-RS485',''));
    for(const port of ports)select.add(new Option(port.device+' · '+(port.description||''),port.device));
    if(selected&&!ports.some(p=>p.device===selected))select.add(new Option(selected+' · 未发现',selected));
    select.value=selected;
    if(settings&&!dirty){$('device-mode').value=settings.mode||'device';$('device-baudrate').value=String(settings.baudrate||9600);$('device-slave-id').value=settings.slave_id||1;}
    render();
  }
  async function refresh() {
    const response=await fetch('/api/v1/connection');const value=await response.json();
    if(!response.ok)throw Error(value.detail||'无法读取设备连接');
    connection=value;settings=value.settings||value;ports=value.ports||[];populate();render();
  }
  function fail(error) {text($('device-settings-status'),error.message||String(error));}
  window.RoasterDevice={setWebSocketOnline(value){online=!!value;render();},refresh};
  window.addEventListener('roaster-status',event=>{state=event.detail.state;connection=event.detail.connection||connection;render();});
  async function mount() {
    await window.RoasterConnectionReady;
    if(!$('backend-section'))return;
    for(const id of ['device-mode','device-port','device-baudrate','device-slave-id'])$(id).onchange=()=>{dirty=true;text($('device-settings-status'),'');render();};
    $('device-refresh').onclick=()=>refresh().catch(fail);
    $('device-apply').onclick=async()=>{
      if(busy||!$('device-slave-id').reportValidity())return;
      busy=true;render();text($('device-settings-status'),'正在连接…');
      try {
        const payload={mode:$('device-mode').value,port:$('device-port').value,baudrate:Number($('device-baudrate').value),slave_id:Number($('device-slave-id').value)};
        const response=await fetch('/api/v1/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const value=await response.json();if(!response.ok)throw Error(typeof value.detail==='string'?value.detail:'连接参数无效');
        dirty=false;connection=value;settings=value.settings;ports=value.ports||[];populate();
        location.reload();
      }catch(error){fail(error);}finally{busy=false;render();}
    };
    await refresh().catch(fail);
    window.__TAURI__?.event?.listen('device-runtime-error',event=>{
      let toast=$('app-toast');if(!toast){toast=document.createElement('div');toast.id='app-toast';toast.className='app-toast';document.body.append(toast);}
      toast.textContent=String(event.payload);toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),6000);
    }).catch(fail);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
