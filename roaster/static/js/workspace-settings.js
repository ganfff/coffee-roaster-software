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
