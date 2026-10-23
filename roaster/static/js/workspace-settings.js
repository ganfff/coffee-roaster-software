/* Settings task groups. Existing controls keep their IDs and device contracts. */
(function () {
  'use strict';
  function mount() {
    const root=document.getElementById('tab-settings'),grid=root?.querySelector('.settings-grid');
    if(!grid)return;
    const groups=[['appearance','外观'],['ai','AI 账户'],['device','设备连接'],['roasting','烘焙偏好']];
    const frame=document.createElement('div');frame.className='settings-frame';grid.before(frame);
    const nav=document.createElement('nav');nav.className='settings-nav';nav.setAttribute('aria-label','设置分类');nav.setAttribute('role','tablist');
    const content=document.createElement('div');content.className='settings-content';content.id='settings-content';content.setAttribute('role','tabpanel');
    frame.append(nav,content);content.append(grid);
    for(const card of grid.children){
      const heading=card.querySelector('h3')?.textContent;
      card.dataset.settingsGroup=card.classList.contains('ai-settings')?'ai':card.id==='backend-section'?'device':['外观','界面','关于'].includes(heading)?'appearance':'roasting';
    }
    const interfaceCard=document.getElementById('ui-scale')?.closest('.settings-card');
    if(interfaceCard){
      const curveCard=document.createElement('section');curveCard.className='settings-card';curveCard.dataset.settingsGroup='roasting';
      const title=document.createElement('h3');title.textContent='曲线显示';curveCard.append(title);
      for(const id of ['ui-ror-alpha','ui-projection']){const row=document.getElementById(id)?.closest('.phase-input-row');if(row)curveCard.append(row);}
      grid.append(curveCard);
    }
    const appearance=document.getElementById('theme-seg')?.closest('.settings-card');
    if(appearance){
      const title=document.createElement('h4');title.textContent='配色';appearance.append(title);
      const palettes=document.createElement('div');palettes.className='palette-picker';palettes.setAttribute('role','group');palettes.setAttribute('aria-label','主题配色');
      for(const {id,name:label,description} of window.RoasterTheme.palettes){
        const button=document.createElement('button');button.type='button';button.className='palette-option';button.dataset.palette=id;
        const preview=document.createElement('span');preview.className='palette-preview';preview.setAttribute('aria-hidden','true');
        for(let i=0;i<3;i++)preview.append(document.createElement('span'));
        const name=document.createElement('strong');name.textContent=label;
        const detail=document.createElement('span');detail.className='palette-description';detail.textContent=description;
        button.append(preview,name,detail);button.onclick=()=>window.RoasterTheme.setPalette(id);palettes.append(button);
      }
      const sync=()=>palettes.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.palette===window.RoasterTheme.getPalette())));
      window.addEventListener('roaster-themechange',sync);appearance.append(palettes);sync();
    }
    if(!window.__TAURI_INTERNALS__){const note=document.createElement('section');note.className='settings-card';note.dataset.settingsGroup='device';const h=document.createElement('h3');h.textContent='设备连接';const p=document.createElement('p');p.textContent='设备由当前服务连接。连接状态始终显示在底部状态栏，AI 账户可以单独使用。';note.append(h,p);grid.append(note);}
    function select(group){
      for(const card of grid.children)card.hidden=card.dataset.settingsGroup!==group;
      for(const button of nav.children){const active=button.dataset.group===group;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}
      content.setAttribute('aria-labelledby','settings-group-'+group);
      root.dataset.settingsGroup=group;
    }
    for(const [id,label] of groups){const b=document.createElement('button');b.type='button';b.id='settings-group-'+id;b.textContent=label;b.dataset.group=id;b.setAttribute('role','tab');b.setAttribute('aria-controls',content.id);b.onclick=()=>select(id);nav.append(b);}
    nav.onkeydown=event=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...nav.children],current=buttons.indexOf(document.activeElement);let next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(/Up|Left/.test(event.key)?-1:1)+buttons.length)%buttons.length;buttons[next].click();buttons[next].focus();};
    window.RoasterSettings={open(group='appearance'){document.querySelector('.tab-btn[data-tab="settings"]')?.click();select(groups.some(([id])=>id===group)?group:'appearance');}};
    select('appearance');
    const requested=new URLSearchParams(location.search).get('settings');if(requested)window.RoasterSettings.open(requested);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
