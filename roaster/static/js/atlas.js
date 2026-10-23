/* Shared application presentation; all device actions stay in existing controllers. */
(() => {
 'use strict';
 const $=s=>document.querySelector(s);
 window.RoasterUI={confirm:message=>new Promise(resolve=>{const previous=document.activeElement;const overlay=document.createElement('div');overlay.className='atlas-confirm';const box=document.createElement('section');box.className='atlas-confirm-box';box.setAttribute('role','dialog');box.setAttribute('aria-label','确认操作');const text=document.createElement('p');text.textContent=message;box.append(text);const finish=value=>{overlay.remove();previous?.focus();resolve(value);};const actions=document.createElement('div');actions.className='actions';for(const [label,value] of [['取消',false],['确认',true]]){const b=document.createElement('button');b.className='ctrl-btn'+(value?' primary':'');b.textContent=label;b.onclick=()=>finish(value);actions.append(b);}box.append(actions);overlay.append(box);document.body.append(overlay);actions.firstChild.focus();overlay.onkeydown=e=>{if(e.key==='Escape')finish(false);};})};
 if(window.Chart)Chart.defaults.font.size=12;
 const summary=$('#event-temps-bar');if(summary){const details=document.createElement('details');details.className='command-disclosure event-details';const label=document.createElement('summary');label.textContent='事件详情';details.append(label,summary);$('.command-scroll')?.append(details);}
 const title=$('#workspace-title');
 document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>{if(title)title.textContent=b.textContent.trim();}));
 const cards=$('#profile-cards');
 if(cards){
  const library=document.createElement('div');library.className='profile-library';cards.before(library);library.append(cards);
  const detail=document.createElement('section');detail.className='profile-preview';detail.setAttribute('aria-label','曲线预览');library.append(detail);
  let previewId=null,plot=null,revision=0;
  async function preview(card){
   if(!card)return;previewId=card.dataset.id;const rev=++revision;
   cards.querySelectorAll('.profile-card').forEach(c=>c.dataset.preview=String(c===card));
   detail.replaceChildren();const back=document.createElement('button');back.className='ctrl-btn';back.textContent='返回曲线列表';back.onclick=()=>library.classList.remove('preview-open');detail.append(back);
   const heading=document.createElement('h3');heading.textContent=card.querySelector('.name').textContent;detail.append(heading);
   const state=document.createElement('p');state.className='preview-state';state.textContent=card.classList.contains('active')?'当前使用曲线':'预览曲线 · 应用后用于下一锅';detail.append(state);
   const wrap=document.createElement('div');wrap.className='profile-preview-chart';const canvas=document.createElement('canvas');wrap.append(canvas);detail.append(wrap);
   const actions=document.createElement('div');actions.className='actions';card.querySelectorAll('.actions button').forEach(original=>{const b=original.cloneNode(true);b.onclick=()=>original.click();actions.append(b);});detail.append(actions);library.classList.add('preview-open');
   if(plot){plot.destroy();plot=null;}
   try{const response=await fetch('/api/v1/profiles/'+encodeURIComponent(previewId));if(!response.ok)throw Error('读取失败');const data=await response.json();if(rev!==revision)return;
    const css=getComputedStyle(document.documentElement),color=n=>css.getPropertyValue(n).trim();
    plot=new Chart(canvas,{type:'line',data:{datasets:[{label:'曲线目标',data:(data.nodes||[]).map(n=>({x:n.time,y:n.temperature})),borderColor:color('--chart-setpoint'),pointRadius:2,tension:.25}]},options:{responsive:true,maintainAspectRatio:false,animation:false,plugins:{eventLines:false,legend:{display:false}},scales:{x:{type:'linear',title:{display:true,text:'时间 / 秒',color:color('--text-secondary')},ticks:{color:color('--chart-tick')},grid:{color:color('--chart-grid')}},y:{title:{display:true,text:'温度 / °C',color:color('--text-secondary')},ticks:{color:color('--chart-tick')},grid:{color:color('--chart-grid')}}}}});
   }catch(error){state.textContent='预览加载失败，请重新选择曲线。';}
  }
  cards.addEventListener('click',e=>{const card=e.target.closest('.profile-card');if(card&&!e.target.closest('button'))preview(card);});
  cards.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.profile-card')){e.preventDefault();preview(e.target);}});
  new MutationObserver(()=>{cards.querySelectorAll('.profile-card').forEach(c=>{c.tabIndex=0;c.setAttribute('role','button');c.setAttribute('aria-label','预览 '+c.querySelector('.name').textContent);});const card=[...cards.querySelectorAll('.profile-card')].find(c=>c.dataset.id===previewId)||cards.querySelector('.profile-card');if(card)preview(card);else{if(plot)plot.destroy();plot=null;detail.textContent='创建或导入曲线后，可在这里预览。';}}).observe(cards,{childList:true});
  new MutationObserver(()=>{const card=[...cards.querySelectorAll('.profile-card')].find(c=>c.dataset.id===previewId);if(!card)return;detail.querySelectorAll('.actions button').forEach(b=>{const source=card.querySelector('[data-action="'+b.dataset.action+'"]');if(source)b.disabled=source.disabled;});const state=detail.querySelector('.preview-state');if(state)state.textContent=card.classList.contains('active')?'当前使用曲线':'预览曲线 · 应用后用于下一锅';}).observe(cards,{subtree:true,attributes:true,attributeFilter:['disabled','class']});
  window.addEventListener('roaster-themechange',()=>preview([...cards.querySelectorAll('.profile-card')].find(c=>c.dataset.id===previewId)));
  cards.addEventListener('click',e=>{if(e.target.closest('[data-action=apply]'))setTimeout(()=>preview(e.target.closest('.profile-card')),400);});
 }
 const wb=$('#wb-root');if(wb)new MutationObserver(()=>{
  const toolbar=wb.querySelector('.wb-toolbar');if(!toolbar||toolbar.dataset.grouped)return;toolbar.dataset.grouped='true';
  for(const [label,ids] of [['文件',['new','open','save','library','adopt']],['编辑',['undo','redo']],['比较',['compare']]]){const group=document.createElement('div');group.className='wb-tool-group';const caption=document.createElement('span');caption.textContent=label;group.append(caption);ids.forEach(id=>{const el=$('#wb-'+id);if(el)group.append(el);});toolbar.append(group);}
  const bottom=wb.querySelector(':scope > .wb-actions');if(bottom)for(const [label,ids] of [['视图',['fit','zoom-in','zoom-out']],['分析',['transform','merge','extract','area','time']],['导出',['csv','png','pdf']],['帮助',['help']]]){const group=document.createElement('div');group.className='wb-tool-group';const caption=document.createElement('span');caption.textContent=label;group.append(caption);ids.forEach(id=>{const el=$('#wb-'+id);if(el)group.append(el);});bottom.append(group);}
 }).observe(wb,{childList:true});
 const resize=new ResizeObserver(()=>window.dispatchEvent(new Event('resize')));const workspace=$('#workspace');if(workspace)resize.observe(workspace);
})();

