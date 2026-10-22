(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const eventLabels = {colour_change:'转黄',first_crack:'一爆',first_crack_end:'一爆结束',second_crack:'二爆',second_crack_end:'二爆结束',roast_end:'结束'};
  let current = null, catalog = null, savedSha = '', tab = 'roast_profile', selected = 0, part = 'point';
  let undo = [], redo = [], comparisons = [], links = {}, busy = false, zoom = null, drag = null, canvas, ctx, dimensions;
  let channels = new Set(), channelsInitialized=false, preferences = {smoothing:1,multiplier:1,fan_steps:false}, unit = 'C', difficulty = 4;
  let initialized = false, initPromise, lastError = '', editError='';
  let operationQueue=Promise.resolve(), phaseTimer, phaseDraft=null, generation=0;
  let revision=0,documentSessionId=crypto.randomUUID(),aiPreview=null,helpReady=null,previewSequence=0;
  const savedDocuments=new Map();
  function getIdentity(){return current?{document_session_id:documentSessionId,generation,revision,sha256:current.document.sha256}:null;}
  function sameIdentity(value){const actual=getIdentity();return !!actual&&!!value&&['document_session_id','generation','revision','sha256'].every(key=>actual[key]===value[key]);}
  function clearAIPreview(){previewSequence++;aiPreview=null;const host=$('wb-ai-preview');if(host){host.hidden=true;host.replaceChildren();}draw();}
  function invalidateAI(){revision++;clearAIPreview();window.dispatchEvent(new CustomEvent('roaster-native-revision',{detail:getIdentity()}));}
  function flushPhase() {
    clearTimeout(phaseTimer);const draft=phaseDraft;phaseDraft=null;
    if(!draft||draft.generation!==generation)return Promise.resolve();
    return perform({action:'parameters',values:{[draft.key]:draft.value||'0'},unit:draft.unit},true);
  }
  const button = (id, text, extra='') => `<button type="button" id="${id}" class="ctrl-btn" ${extra}>${text}</button>`;
  function message(text='') { lastError = text; if ($('wb-error')) { $('wb-error').textContent = text; $('wb-error').hidden = !text; } }
  async function api(request) {
    if (window.__TAURI_INTERNALS__ && window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('workbench_request', {request});
    const response = await fetch('/api/v1/workbench', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    const data = await response.json();
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data));
    return data;
  }
  function snapshot() { return {document:current.document,selected,part,links:clone(links),tab,documentSessionId,savedSha}; }
  function dirty() { return current && current.document.sha256 !== savedSha; }
  function writable() { return current && !current.readonly; }
  function perform(request, edit=false, replace=false) {
    const job=operationQueue.then(()=>execute(request,edit,replace));
    operationQueue=job.catch(()=>{});return job;
  }
  async function execute(request, edit=false, replace=false) {
    if (busy) throw Error('正在处理文件，请稍候');
    busy = true; message(); refreshButtons();
    const previous = current ? snapshot() : null;
    try {
      const result = await api({document:current?.document, preferences, ...request});
      if (result.document) {
        if (edit && previous && previous.document.data !== result.document.data) { undo.push(previous); if(undo.length>80)undo.shift(); redo=[]; }
        const changed=!current||current.document.data!==result.document.data;
        current = result;
        if(edit)editError='';
        if (replace) { savedDocuments.set(documentSessionId,savedSha);documentSessionId=crypto.randomUUID();editError='';generation++; clearTimeout(phaseTimer);phaseDraft=null;undo=[]; redo=[]; links={}; comparisons=[]; selected=0; part='point'; savedSha=result.document.sha256;savedDocuments.set(documentSessionId,savedSha); zoom=null; channels.clear();channelsInitialized=false; }
        if(changed||replace)invalidateAI();
        if (result.selected_index != null) selected=result.selected_index;
        if (current.document.kind !== 'log' && tab === 'log') tab='roast_profile';
        render();
      }
      return result;
    } catch (error) { if(edit)editError=error.message||String(error);message(error.message || String(error)); throw error; }
    finally { busy=false; refreshButtons(); }
  }
  function safe(action) { return (...args) => Promise.resolve().then(()=>action(...args)).catch(error=>{if(args[0]?.type==='change'&&args[0].target?.closest('#wb-inspector,#wb-properties'))editError=error.message||String(error);message(error.message||String(error));}); }
  async function choose(title, body, choices) {
    const dialog=$('wb-dialog');
    if(dialog.open)dialog.close('cancel'); dialog.returnValue='';
    dialog.classList.remove('wb-help-dialog');dialog.onclick=null;
    dialog.innerHTML=`<form method="dialog"><h3>${esc(title)}</h3><p>${esc(body)}</p><div class="wb-actions">${choices.map(([value,label])=>`<button class="ctrl-btn" value="${value}">${label}</button>`).join('')}</div></form>`;
    dialog.show();
    return new Promise(resolve=>{dialog.onclose=()=>resolve(dialog.returnValue); dialog.querySelector('button').focus();});
  }
  async function allowReplace() {
    await flushPhase(); await operationQueue;
    if(!dirty()&&!editError)return true;
    const answer=await choose('保存当前文件','当前文件有未保存的修改。',[['save','保存文件'],['discard','放弃修改'],['cancel','取消']]);
    if(answer==='save') return await exportNative();
    return answer==='discard';
  }
  function rawDocument(bytes,name) {
    if(bytes.byteLength>8*1024*1024)throw Error('文件过大（最多 8 MiB）');
    const extension=name.toLowerCase().split('.').pop();
    if(!['kpro','klog'].includes(extension))throw Error('请选择 .kpro 或 .klog');
    let binary=''; for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
    return {name,kind:extension==='klog'?'log':'profile',data:btoa(binary)};
  }
  async function openFiles(files, compare=false) {
    if(!files.length)return;
    if(!compare && !await allowReplace())return;
    if(compare && comparisons.length+files.length>4)throw Error('最多同时比较四个背景文件');
    const documents=[];
    for(const file of files)documents.push(rawDocument(new Uint8Array(await file.arrayBuffer()),file.name));
    if(compare) {
      const views=[]; for(const document of documents) views.push(await api({action:'view',document,preferences}));
      comparisons.push(...views.map(value=>({view:value,visible:true,channel:value.channels[0]?.name || ''}))); render();
    } else {
      await perform({action:'view',document:documents[0]},false,true);
      tab=current.document.kind==='log'?'log':'roast_profile'; comparisons=[]; render();
    }
  }
  async function download(blob,name) {
    if(window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('workbench_save_file',{name,data:Array.from(new Uint8Array(await blob.arrayBuffer()))});
    if(window.showSaveFilePicker) {
      try {const handle=await window.showSaveFilePicker({suggestedName:name});const stream=await handle.createWritable();await stream.write(blob);await stream.close();return true;}
      catch(error){if(error.name==='AbortError')return false;throw error;}
    }
    const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=name;
    document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    return false;
  }
  async function exportNative() {
    await flushPhase(); await operationQueue;
    if(editError)throw Error('请先修正输入：'+editError);
    if(!current)throw Error('请先打开文件');
    const data=await perform({action:'export',changed:dirty()});
    const exported=clone(current.document), exportedGeneration=generation;
    const saved=await download(new Blob([Uint8Array.from(atob(data.data),c=>c.charCodeAt(0))],{type:data.mime}),exported.name);
    if(saved&&generation===exportedGeneration){savedSha=exported.sha256;savedDocuments.set(documentSessionId,savedSha);renderTitle();}
    else $('wb-status').textContent='保存未确认完成，继续保留未保存状态';
    return saved&&generation===exportedGeneration&&current.document.sha256===exported.sha256;
  }
  async function historyStep(back) {
    const stack=back?undo:redo, other=back?redo:undo;
    if(!stack.length||busy)return;
    const restore=stack.at(-1), previous=snapshot();
    await perform({action:'view',document:restore.document});
    stack.pop(); other.push(previous); selected=restore.selected; part=restore.part; links=restore.links;
    if(restore.documentSessionId&&restore.documentSessionId!==documentSessionId){savedDocuments.set(documentSessionId,savedSha);documentSessionId=restore.documentSessionId;savedSha=savedDocuments.get(documentSessionId)??restore.savedSha;generation++;channels.clear();channelsInitialized=false;}
    tab=restore.tab||tab;invalidateAI();render();
  }
  function editCurve(operation, values={}) {
    if(!writable()||current.document.kind!=='profile')throw Error('请先打开可编辑曲线，或从日志提取曲线');
    return perform({action:'curve',curve:tab,index:selected,operation,...values},true);
  }
  function temperature(y) { return unit==='F'?y*1.8+32:y; }
  function nativeTemperature(y) { return unit==='F'?(y-32)/1.8:y; }
  function time(value) { if(value==null||!Number.isFinite(value))return '—'; const s=Math.abs(value); return `${value<0?'-':''}${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }
  function numeric(value,places=1) { return value==null?'—':Number(value).toFixed(places).replace(/\.0+$/,''); }
  function parseTime(text) { const parts=String(text).trim().split(':'); if(parts.length===1&&Number.isFinite(Number(text))&&text!=='')return Number(text); if(parts.length===2&&Number.isFinite(Number(parts[0]))&&Number(parts[1])>=0&&Number(parts[1])<60)return (String(parts[0]).startsWith('-')?-1:1)*(Math.abs(Number(parts[0]))*60+Number(parts[1])); throw Error('时间请输入秒数或 分:秒'); }
  function renderTitle() {
    $('wb-filename').textContent=current?`${current.document.name}${dirty()?' · 未保存':''}${current.readonly?' · 只读':''}`:'打开 .kpro / .klog，或新建曲线';
  }
  function refreshButtons() {
    if(!$('wb-new'))return;
    $('wb-root').setAttribute('aria-busy',String(busy));
    for(const id of ['wb-new','wb-open','wb-compare','wb-library'])$(id).disabled=busy;
    for(const id of ['wb-save','wb-transform','wb-merge','wb-extract','wb-adopt'])$(id).disabled=busy||!writable();
    $('wb-extract').disabled=busy||!writable()||current.document.kind!=='log';
    for(const id of ['wb-png','wb-pdf','wb-area'])$(id).disabled=busy||!current;
    $('wb-csv').disabled=busy||current?.document.kind!=='log';
    $('wb-undo').disabled=busy||!undo.length; $('wb-redo').disabled=busy||!redo.length;
    $('wb-transform').disabled=busy||!writable()||current.document.kind!=='profile'||!current.curves[tab];
    $('wb-merge').disabled=busy||!writable()||current.document.kind!=='profile';
    $('wb-plot-toolbar').querySelectorAll('button').forEach(el=>{el.disabled=busy||!writable()||current.document.kind!=='profile';});
  }
  function render() {
    renderTitle();
    document.querySelectorAll('[data-wb-tab]').forEach(el=>{el.setAttribute('aria-selected',String(el.dataset.wbTab===tab));el.hidden=el.dataset.wbTab==='log'&&current?.document.kind!=='log';});
    $('wb-warning').textContent=current?.warnings.join('\n')||'';
    $('wb-main').hidden=['about','settings'].includes(tab); $('wb-properties').hidden=!['about','settings'].includes(tab);
    $('wb-plot-toolbar').hidden=!current?.curves[tab]||current.document.kind!=='profile';
    $('wb-smoothing-label').hidden=tab!=='log'; $('wb-multiplier-label').hidden=tab!=='log';
    $('wb-comparisons').innerHTML=comparisons.map((entry,i)=>`<div class="wb-comparison"><label><input type="checkbox" data-compare-show="${i}" ${entry.visible?'checked':''}> ${esc(entry.view.document.name)}</label>${entry.view.channels.length?`<select aria-label="比较通道" data-compare-channel="${i}">${entry.view.channels.map(ch=>`<option ${ch.name===entry.channel?'selected':''}>${esc(ch.name)}</option>`).join('')}</select>`:''}<button class="ctrl-btn" data-compare-remove="${i}" aria-label="移除 ${esc(entry.view.document.name)}">移除</button></div>`).join('');
    renderInspector(); if(['about','settings'].includes(tab))renderProperties(); resize(); refreshButtons();
  }
  function renderInspector() {
    const host=$('wb-inspector'), focused=document.activeElement?.id, focusedValue=document.activeElement?.value;
    const selection=document.activeElement?.selectionStart;
    if(!current) { host.innerHTML='<h3>离线文件工作台</h3><p>双曲线编辑、ABC 预计算、日志分析与文件比较。</p><p>拖入文件开始。原文件只在你显式保存时生成下载副本。</p>'; return; }
    if(tab==='log') {
      if(!channelsInitialized){for(const c of current.channels.filter(c=>/temp|actual_ROR|mean_temp/i.test(c.name)).slice(0,3))channels.add(c.name);channelsInitialized=true;}
      host.innerHTML=`<h3>记录通道</h3><p>${current.sample_count} 个采样 · offsets ${esc(current.offsets.join(', '))}</p>${current.channels.map(c=>`<label><span>${esc(c.name)}</span><input type="checkbox" data-channel="${esc(c.name)}" ${channels.has(c.name)?'checked':''}></label>`).join('')}<div class="wb-phase"><strong>事件与阶段</strong>${Object.entries(eventLabels).map(([key,label])=>`<label>${label}<input id="wb-event-${key}" data-event="${key}" value="${esc(current.events.find(e=>e.kind===key)?.time??'')}" placeholder="秒或 分:秒" ${current.readonly?'disabled':''}></label>`).join('')}<p>清空时间可移除事件；不补造缺失事件。</p></div>${metricHTML(current.metrics)}<details><summary>全部原始事件（${current.event_records.length}）</summary>${current.event_records.map(e=>`<div>${esc(eventLabels[e.kind]||e.kind)} ${time(e.time)}</div>`).join('')}</details>`;
    } else if(current.curves[tab]) {
      const points=current.curves[tab].points; selected=Math.min(Math.max(0,selected),points.length-1);
      const p=points[selected], offset=part==='left'?2:part==='right'?4:0;
      const value=tab==='roast_profile'?temperature(p[offset+1]):p[offset+1];
      host.innerHTML=`<h3>${tab==='roast_profile'?'温度曲线':'风扇曲线'}</h3><div class="wb-node-list">${points.map((p,i)=>`<button data-node="${i}" aria-pressed="${i===selected}">${i+1}</button>`).join('')}</div><label>编辑对象<select id="wb-part"><option value="point">锚点</option><option value="left" ${part==='left'?'selected':''}>左控制柄</option><option value="right" ${part==='right'?'selected':''}>右控制柄</option></select></label><label>时间（秒）<input id="wb-x" value="${p[offset].toFixed(3)}" ${current.readonly?'disabled':''}></label><label>${tab==='roast_profile'?`温度（°${unit}）`:'转速（RPM）'}<input id="wb-y" type="number" step="any" value="${Number(value.toFixed(3))}" ${current.readonly?'disabled':''}></label><label>连接左右控制柄<input id="wb-linked" type="checkbox" ${links[`${tab}:${selected}`]!==false?'checked':''}></label><p>方向键微调，Alt 加大步长；双击画布插点。</p>${phaseHTML()}`;
    } else host.innerHTML='<p>文件没有此曲线。可以查看文件信息及记录通道。</p>';
    if(focused&&$(focused)) { if($(focused).dataset.phase&&Number(focusedValue)===Number($(focused).value))$(focused).value=focusedValue; $(focused).focus({preventScroll:true}); if(selection!=null&&$(focused).type!=='number')try{$(focused).setSelectionRange(selection,selection);}catch{} }
  }
  function phaseHTML() {
    if(!current.phases)return '';
    const {events,phases}=current.phases;
    const phase=(key,label)=>{const value=phases[key];return `<div class="wb-phase"><strong>${label}</strong><div><span>时长</span><span>${time(value?.duration)}</span></div><div><span>比例</span><span>${value?.percent==null?'—':numeric(value.percent)+'%'}</span></div><div><span>温升</span><span>${value?numeric(value.increase*(unit==='F'?1.8:1))+'°'+unit:'—'}</span></div></div>`;};
    const event=(key,label,param)=>`<div class="wb-phase"><strong>${label}</strong>${param?`<label>预期温度 °${unit}<input id="wb-phase-${param}" data-phase="${param}" type="number" step="any" value="${events[key]?.temperature==null?'':numeric(temperature(events[key].temperature),3)}" ${current.readonly||current.document.kind==='log'?'disabled':''}></label>`:`<div><span>温度</span><span>${numeric(events[key]?.temperature==null?null:temperature(events[key].temperature))} °${unit}</span></div>`}<div><span>时间</span><span>${time(events[key]?.time)}</span></div></div>`;
    return event('roast_end','建议结束')+phase('development','C 发展')+event('first_crack','预期一爆','expect_fc')+phase('maillard','B 美拉德')+event('colour_change','预期转黄','expect_colrchange')+phase('drying','A 脱水');
  }
  function metricHTML(m) {
    if(!m)return '';
    return [['结束',m.end_time,m.final_temperature],['一爆',m.first_crack,m.first_crack_temperature],['转黄',m.colour_change,m.colour_change_temperature]].map(([label,t,y])=>`<div class="wb-phase"><strong>${label}</strong><div>${time(t)} · ${numeric(y==null?null:temperature(y))} °${unit}</div></div>`).join('')+[['发展','development'],['美拉德','maillard'],['脱水','drying']].map(([label,key])=>`<div class="wb-phase"><strong>${label}</strong><div>${time(m[key+'_time'])} · ${m[key+'_ratio']==null?'—':numeric(m[key+'_ratio']*100)+'%'}</div><div>温升 ${numeric(m[key+'_increase']==null?null:m[key+'_increase']*(unit==='F'?1.8:1))} °${unit}</div></div>`).join('');
  }
  function parameterValue(key, raw) {
    const info=catalog.parameters[key]||{};
    if(info.type==='multiline')return raw.replace(/\\v|\v/g,'\n');
    if(unit==='F'&&(info.temperature||info.temperature_delta)&&raw.trim()&&Number.isFinite(Number(raw))) {
      if(Number(raw)===0&&catalog.metadata.keepZeroParameters.includes(key))return '0';
      return numeric(Number(raw)*1.8+(info.temperature_delta?0:32),3);
    }
    return raw;
  }
  function renderProperties() {
    if(!current||!catalog)return;
    const focus=document.activeElement?.dataset.parameter, selection=document.activeElement?.selectionStart;
    const search=$('wb-search').value.toLowerCase();
    const categories=tab==='settings'?catalog.settings_categories:catalog.about_categories;
    const known=new Set(categories.flatMap(c=>c.keys));
    const extra=Object.keys(current.metadata).filter(key=>!known.has(key)&&!['roast_profile','fan_profile'].includes(key)&&!catalog.parameters[key]);
    const groups=[...categories,...(extra.length?[{label:'其他原始字段（只读）',keys:extra}]:[])];
    $('wb-property-list').innerHTML=groups.map(group=>{
      const fields=group.keys.filter(key=>key in current.metadata||(current.document.kind==='log'&&['tasting_notes','roast_date'].includes(key))).filter(key=>{const info=catalog.parameters[key]||{};return (info.difficulty_level||4)<=difficulty&&(!search||`${key} ${info.label||''} ${info.help||''}`.toLowerCase().includes(search));});
      if(!fields.length)return '';
      return `<details class="wb-section" open><summary>${esc(group.label)}</summary>${fields.map(key=>{
        const info=catalog.parameters[key]||{}, value=parameterValue(key,current.metadata[key]||'');
        const readonly=current.readonly||!catalog.parameters[key]||info.readonly||/schema_version/.test(key)||(current.document.kind==='log'&&!['tasting_notes','roast_date'].includes(key))||(current.document.kind==='profile'&&info.saved_in_profile===false);
        const diffs=comparisons.filter(e=>e.view.metadata[key]!==undefined&&e.view.metadata[key]!==current.metadata[key]);
        const id='wb-param-'+key;
        return `<div class="wb-property ${diffs.length?'wb-different':''}"><label for="${esc(id)}">${esc(info.label||key)}${info.unit?' · '+esc(info.unit):''}${readonly?' · 只读':''}</label><div>${info.type==='multiline'?`<textarea id="${esc(id)}" data-parameter="${esc(key)}" ${readonly?'readonly':''}>${esc(value)}</textarea>`:`<input id="${esc(id)}" data-parameter="${esc(key)}" value="${esc(value)}" ${readonly?'readonly':''}>`}<div class="wb-help">${esc(info.help||'').replace(/\\v/g,'\n')}</div>${diffs.map(e=>`<div class="wb-diff">${esc(e.view.document.name)}：${esc(parameterValue(key,e.view.metadata[key]))}</div>`).join('')}</div></div>`;
      }).join('')}</details>`;
    }).join('')||'<p>没有匹配的字段。</p>';
    if(focus){const input=$('wb-param-'+focus);if(input){input.focus({preventScroll:true});if(selection!=null)input.setSelectionRange(selection,selection);}}
  }
  function color(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function resize() {
    if(!canvas||!canvas.parentElement.clientWidth)return;
    const box=canvas.parentElement.getBoundingClientRect(), ratio=window.devicePixelRatio||1;
    canvas.width=Math.round(box.width*ratio); canvas.height=Math.round(Math.max(200,box.height)*ratio);
    ctx.setTransform(ratio,0,0,ratio,0,0); dimensions={width:box.width,height:Math.max(200,box.height)}; draw();
  }
  function plottedSeries() {
    if(!current)return [];
    if(tab==='log')return current.channels.filter(c=>channels.has(c.name)).map((c,i)=>({name:c.name,points:c.data,color:['--chart-temp','--chart-ror','--info','--chart-compare-b','--warning'][i%5],group:/ror|rate/i.test(c.name)?'ror':/temp|profile|mean/i.test(c.name)?'temp':'auto'}));
    const c=current.curves[tab];if(!c)return [];
    const series=[{name:tab==='fan_profile'?'风扇 RPM':`温度 °${unit}`,points:c.samples,color:'--chart-temp',group:tab==='fan_profile'?'fan':'temp'}];
    if(tab==='roast_profile'&&$('wb-overlay').checked&&current.fan_overlay)series.push({name:'风扇叠加',points:current.fan_overlay,color:'--info',group:'temp',dash:true,overlay:true});
    if(tab==='fan_profile'&&$('wb-overlay').checked&&current.temperature_overlay)series.push({name:'温度叠加',points:current.temperature_overlay,color:'--info',group:'fan',dash:true});
    if(tab==='fan_profile'&&preferences.fan_steps&&current.fan_adjusted)series.push({name:'增减后的风扇',points:current.fan_adjusted,color:'--chart-ror',group:'fan',dash:true});
    if(tab==='roast_profile'&&$('wb-ror').checked)series.push({name:'曲线 RoR',points:c.ror,color:'--chart-ror',group:'ror'});
    return series;
  }
  function scales(series) {
    let xmax=600;for(const s of series)for(const p of s.points)if(Number.isFinite(p[0]))xmax=Math.max(xmax,p[0]);
    for(const c of Object.values(current?.curves||{}))xmax=Math.max(xmax,c.points.at(-1)[0]);
    const native=current?.axes?.[tab];
    const candidate=aiPreview?.candidate.axes[tab];
    const base=native?{...native,x1:Math.max(...Object.values(current.axes).map(a=>a.x1))}:{x0:0,x1:xmax*1.03,y0:0,y1:tab==='fan_profile'?18000:250};
    if(candidate){base.x0=Math.min(base.x0,candidate.x0);base.x1=Math.max(base.x1,candidate.x1);base.y0=Math.min(base.y0,candidate.y0);base.y1=Math.max(base.y1,candidate.y1);}
    return zoom||base;
  }
  function draw(preview=null) {
    if(!ctx||!dimensions)return;
    const {width:w,height:h}=dimensions, plot={left:58,right:w-48,top:42,bottom:h-40};
    ctx.clearRect(0,0,w,h);ctx.fillStyle=color('--canvas');ctx.fillRect(0,0,w,h);
    const series=plottedSeries(); const scale=scales(series);
    const X=x=>plot.left+(x-scale.x0)/(scale.x1-scale.x0)*(plot.right-plot.left),Y=y=>plot.bottom-(y-scale.y0)/(scale.y1-scale.y0)*(plot.bottom-plot.top);
    dimensions={...dimensions,plot,scale,X,Y};
    ctx.font='12px '+getComputedStyle(document.body).fontFamily;ctx.lineWidth=1;
    for(let i=0;i<=6;i++){
      const y=plot.bottom-i/6*(plot.bottom-plot.top), value=scale.y0+(scale.y1-scale.y0)*i/6;
      ctx.strokeStyle=color('--chart-grid');ctx.beginPath();ctx.moveTo(plot.left,y);ctx.lineTo(plot.right,y);ctx.stroke();
      ctx.fillStyle=color('--chart-tick');ctx.textAlign='right';ctx.fillText(numeric(tab==='fan_profile'?value:temperature(value),0),plot.left-7,y+4);
      const x=plot.left+i/6*(plot.right-plot.left);ctx.textAlign='center';ctx.fillText(time(scale.x0+(scale.x1-scale.x0)*i/6),x,plot.bottom+23);
    }
    let legend=plot.left;
    const drawSeries=(s,i)=>{
      const raw=s.points.filter(p=>p[1]!=null&&Number.isFinite(p[1])), values=raw.map(p=>p[1]);
      let low,high;
      if(s.group==='ror'){low=-20;high=80;}else if(s.group==='auto'){low=Math.min(0,...values);high=Math.max(1,...values)*1.05;}
      const ymap=low==null?Y:y=>plot.bottom-(y-low)/(high-low)*(plot.bottom-plot.top);
      ctx.strokeStyle=color(s.color);ctx.lineWidth=i===0?2:1.5;ctx.setLineDash(s.dash?[10,6]:[]);
      ctx.save();ctx.beginPath();ctx.rect(plot.left,plot.top,plot.right-plot.left,plot.bottom-plot.top);ctx.clip();ctx.beginPath();let started=false;
      for(const p of raw){const x=X(p[0]),y=ymap(p[1]);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);}ctx.stroke();ctx.restore();ctx.setLineDash([]);
      ctx.fillStyle=color(s.color);ctx.textAlign='left';const label=s.name+(low!=null?` [${numeric(low,0)}–${numeric(high,0)}]`:'');ctx.fillText(label,legend,21);legend+=ctx.measureText(label).width+18;
    };
    series.forEach(drawSeries);
    comparisons.forEach((c,i)=>{if(!c.visible)return;const data=tab==='log'?c.view.channels.find(ch=>ch.name===c.channel)?.data:c.view.curves[tab]?.samples;if(data)drawSeries({name:c.view.document.name,points:data,color:i%2?'--chart-compare-b':'--info',group:tab==='log'?(/ror/i.test(c.channel)?'ror':/temp|profile|mean/i.test(c.channel)?'temp':'auto'):tab==='fan_profile'?'fan':'temp',dash:true},series.length+i);});
    const proposed=aiPreview?.candidate.curves[tab];
    if(proposed)drawSeries({name:'AI 候选 · 尚未采用',points:proposed.samples,color:'--chart-compare-b',group:tab==='fan_profile'?'fan':'temp',dash:true},series.length+comparisons.length);
    if(tab==='log')for(const event of current?.events||[]){const x=X(event.time);ctx.strokeStyle=color('--text-tertiary');ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(x,plot.top);ctx.lineTo(x,plot.bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color('--text-secondary');ctx.fillText(eventLabels[event.kind]||event.kind,x+3,plot.top+15);}
    if(current?.curves[tab]&&current.document.kind==='profile'){
      const points=preview||current.curves[tab].points;
      if(preview){ctx.strokeStyle=color('--accent');ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(X(points[0][0]),Y(points[0][1]));for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];ctx.bezierCurveTo(X(a[4]),Y(a[5]),X(b[2]),Y(b[3]),X(b[0]),Y(b[1]));}ctx.stroke();}
      points.forEach((p,i)=>{if(i===selected){for(const offset of [2,4]){if((offset===2&&i===0)||(offset===4&&i===points.length-1))continue;ctx.strokeStyle=color('--text-tertiary');ctx.beginPath();ctx.moveTo(X(p[0]),Y(p[1]));ctx.lineTo(X(p[offset]),Y(p[offset+1]));ctx.stroke();ctx.fillStyle=color('--info');ctx.fillRect(X(p[offset])-4,Y(p[offset+1])-4,8,8);}}ctx.beginPath();ctx.arc(X(p[0]),Y(p[1]),i===selected?6:4,0,Math.PI*2);ctx.fillStyle=color(i===selected?'--accent':'--editor-curve');ctx.fill();});
    }
    if(!current){ctx.fillStyle=color('--text-secondary');ctx.textAlign='center';ctx.fillText('拖入 .kpro / .klog 文件，或点击新建曲线',w/2,h/2);}
  }
  function pointerPosition(event) { const rect=canvas.getBoundingClientRect();const x=(event.clientX-rect.left)*dimensions.width/rect.width,y=(event.clientY-rect.top)*dimensions.height/rect.height;const {plot,scale}=dimensions;return {px:x,py:y,x:scale.x0+(x-plot.left)/(plot.right-plot.left)*(scale.x1-scale.x0),y:scale.y0+(plot.bottom-y)/(plot.bottom-plot.top)*(scale.y1-scale.y0)}; }
  function installCanvas() {
    canvas.addEventListener('pointerdown',event=>{
      if(event.button!==0||busy||!current?.curves[tab]||current.document.kind!=='profile')return;
      const pos=pointerPosition(event),points=current.curves[tab].points;let hit=null;
      const test=(index,offset,kind)=>{const p=points[index],d=Math.hypot(dimensions.X(p[offset])-pos.px,dimensions.Y(p[offset+1])-pos.py);if(d<=13&&(!hit||d<hit.d))hit={index,kind,d};};
      if(selected>0)test(selected,2,'left');if(selected<points.length-1)test(selected,4,'right');points.forEach((_,i)=>test(i,0,'point'));
      if(!hit)return;
      selected=hit.index;part=hit.kind;renderInspector();draw();canvas.focus({preventScroll:true});
      if(!writable())return;
      drag={pointer:event.pointerId,start:pos,points:clone(points),moved:false};canvas.setPointerCapture(event.pointerId);event.preventDefault();
    });
    canvas.addEventListener('pointermove',event=>{
      if(!drag||drag.pointer!==event.pointerId){if(current){const pos=pointerPosition(event);let text=time(pos.x);if(tab==='log'){for(const ch of current.channels.filter(c=>channels.has(c.name))){let closest=null;for(const row of ch.data)if(!closest||Math.abs(row[0]-pos.x)<Math.abs(closest[0]-pos.x))closest=row;if(closest)text+=` · ${ch.name}: ${numeric(closest[1],2)}`;}}else text+=` · ${numeric(tab==='roast_profile'?temperature(pos.y):pos.y,2)} ${tab==='fan_profile'?'RPM':'°'+unit}`;$('wb-status').textContent=text;}return;}
      const pos=pointerPosition(event);if(Math.hypot(pos.px-drag.start.px,pos.py-drag.start.py)<3&&!drag.moved)return;
      drag.moved=true;drag.position=pos;const points=clone(drag.points),p=points[selected];
      if(part==='point'){const x=selected===0?p[0]:Math.max(points[selected-1][0]+1,Math.min(points[selected+1]?.[0]-1||Infinity,pos.x)),dx=x-p[0],dy=pos.y-p[1];p[0]=x;p[1]=pos.y;for(const offset of [2,4]){p[offset]+=dx;p[offset+1]+=dy;}}
      else {const offset=part==='left'?2:4;p[offset]=pos.x;p[offset+1]=pos.y;}
      draw(points);$('wb-status').textContent=`${pos.x.toFixed(2)} 秒 · ${numeric(tab==='roast_profile'?temperature(pos.y):pos.y,2)} ${tab==='roast_profile'?'°'+unit:'RPM'}`;
    });
    const finish=safe(async(event,cancel=false)=>{if(!drag||drag.pointer!==event.pointerId)return;const old=drag;drag=null;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);if(!cancel&&old.moved){const pos=old.position;if(part==='point'){const p=old.points[selected];const x=selected===0?p[0]:Math.max(old.points[selected-1][0]+1,Math.min(old.points[selected+1]?.[0]-1||Infinity,pos.x));await editCurve('move',{x,y:pos.y});}else await editCurve('handle',{side:part,x:pos.x,y:pos.y,linked:links[`${tab}:${selected}`]!==false});}draw();});
    canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',e=>finish(e,true));canvas.addEventListener('lostpointercapture',()=>{if(drag){drag=null;draw();}});
    canvas.addEventListener('dblclick',safe(async e=>{if(!writable()||current.document.kind!=='profile')return;const pos=pointerPosition(e);await editCurve('insert',{x:pos.x,y:pos.y});}));
    canvas.addEventListener('wheel',event=>{if(!current)return;event.preventDefault();const s=dimensions.scale,factor=event.deltaY>0?Math.SQRT2:1/Math.SQRT2,p=pointerPosition(event);zoom={...s};if(!event.shiftKey){zoom.x0=p.x+(s.x0-p.x)*factor;zoom.x1=p.x+(s.x1-p.x)*factor;}else{zoom.y0=p.y+(s.y0-p.y)*(event.deltaY>0?2:.5);zoom.y1=p.y+(s.y1-p.y)*(event.deltaY>0?2:.5);}draw();},{passive:false});
    canvas.addEventListener('keydown',safe(async event=>{if(!current?.curves[tab]||!writable())return;const key=event.key;if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Insert'].includes(key))return;event.preventDefault();if(key==='Delete')return editCurve('delete');if(key==='Insert')return insertPoint();const offset=part==='left'?2:part==='right'?4:0,p=current.curves[tab].points[selected],step=event.altKey?10:1;const x=p[offset]+(key==='ArrowLeft'?-step:key==='ArrowRight'?step:0),y=p[offset+1]+(key==='ArrowDown'?-step:key==='ArrowUp'?step:0);await editCurve(part==='point'?'move':'handle',{x,y,side:part,linked:links[`${tab}:${selected}`]!==false});}));
  }
  async function insertPoint() {
    const points=current?.curves[tab]?.points;if(!points)throw Error('请选择曲线');
    const p=points[selected],next=points[selected+1];
    await editCurve('insert',{x:next?(p[0]+next[0])/2:p[0]+30,y:next?(p[1]+next[1])/2:p[1]});
  }
  async function toolDialog(type) {
    if(!current&&type!=='time')return;
    const dialog=$('wb-dialog');
    dialog.classList.remove('wb-help-dialog');dialog.onclick=null;
    let body,title;
    if(type==='transform'){title='变换当前曲线';body=[['time_scale','时间倍率','1'],['time_offset','时间位移（秒）','0'],['value_scale','数值倍率','1'],['value_offset','数值位移（原生单位）','0']].map(([key,label,value])=>`<label>${label}<input name="${key}" type="number" step="any" value="${value}" required></label>`).join('');}
    if(type==='area'){title='曲线下面积';body='<label>曲线<select name="curve"><option value="roast_profile">温度</option><option value="fan_profile">风扇</option></select></label>'+[['start','开始（秒，可留空）',''],['end','结束（秒，可留空）',''],['baseline','基线','0']].map(([key,label,value])=>`<label>${label}<input name="${key}" type="number" step="any" value="${value}"></label>`).join('');}
    if(type==='time'){title='时间计算器';body='<label>秒数或 分:秒<input name="value" value="5:30" required></label>';}
    if(type==='merge'){title='选择性合并曲线';body='<label>来源文件<input name="file" type="file" accept=".kpro,.klog" required></label>'+[['roast_profile','温度曲线'],['fan_profile','风扇曲线'],['metadata','名称、设计者和说明'],['events','预期事件与推荐程度'],['zones','区域参数'],['other_settings','其他参数']].map(([key,label])=>`<label>${label}<input name="groups" type="checkbox" value="${key}"></label>`).join('');}
    if(type==='pdf'){title='导出 PDF';body=[['plot','当前图表'],['roast_profile','温度曲线'],['fan_profile','风扇曲线'],['log','记录通道'],['about','关于此文件'],['settings','曲线设置']].filter(([key])=>key!=='log'||current.document.kind==='log').map(([key,label],i)=>`<label>${label}<input name="pages" type="checkbox" value="${key}" ${i===0?'checked':''}></label>`).join('');}
    dialog.innerHTML=`<form><h3>${title}</h3>${body}<div id="wb-tool-result" role="status"></div><div class="wb-actions"><button type="button" class="ctrl-btn" data-close-dialog>取消</button><button class="ctrl-btn primary" type="submit">${['area','time'].includes(type)?'计算':'确认'}</button></div></form>`;
    dialog.show();dialog.querySelector('input,select').focus();dialog.querySelector('[data-close-dialog]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=safe(async event=>{
      event.preventDefault();const form=new FormData(event.currentTarget),out=$('wb-tool-result');
      try {
        if(type==='transform') { await editCurve('transform',Object.fromEntries(form));dialog.close(); }
        if(type==='merge') {const file=form.get('file'),source=rawDocument(new Uint8Array(await file.arrayBuffer()),file.name);await perform({action:'merge',source,groups:form.getAll('groups')},true);dialog.close();}
        if(type==='area') {const result=await api({action:'area',document:current.document,curve:form.get('curve'),range:{start:form.get('start'),end:form.get('end'),baseline:form.get('baseline')}});out.textContent=`面积：${numeric(result.area,4)} ${form.get('curve')==='fan_profile'?'RPM':'°C'}·分钟`;}
        if(type==='time') {const result=await api({action:'time',value:form.get('value')});out.textContent=`${result.seconds} 秒 = ${result.time}`;}
        if(type==='pdf') {const pages=form.getAll('pages');if(!pages.length)throw Error('至少选择一页');await exportPDF(pages);dialog.close();}
      }catch(error){out.textContent=error.message;}
    });
  }
  function propertyPages(kind) {
    const groups=kind==='settings'?catalog.settings_categories:catalog.about_categories;
    const pages=[];let page,c,y;
    const add=()=>{page=document.createElement('canvas');page.width=1684;page.height=1190;c=page.getContext('2d');c.fillStyle=color('--surface');c.fillRect(0,0,page.width,page.height);c.fillStyle=color('--text');c.font='30px '+getComputedStyle(document.body).fontFamily;c.fillText(`${current.document.name} · ${kind==='about'?'关于此文件':'曲线设置'}`,55,60);y=110;pages.push(page);};
    add();
    for(const group of groups){if(y>1040)add();c.font='bold 27px '+getComputedStyle(document.body).fontFamily;c.fillText(group.label,55,y);y+=46;for(const key of group.keys){if(!(key in current.metadata))continue;const label=catalog.parameters[key]?.label||key;const text=`${label}：${parameterValue(key,current.metadata[key])}`;c.font='23px '+getComputedStyle(document.body).fontFamily;let row='';for(const char of text){if(char==='\n'||c.measureText(row+char).width>1550){if(y>1120)add();c.fillText(row,65,y);y+=33;row=char==='\n'?'':char;}else row+=char;}if(y>1120)add();c.fillText(row,65,y);y+=38;}}
    return pages;
  }
  async function exportPDF(pages) {
    const original=tab,originalZoom=zoom,result=[],name=current.document.name.replace(/\.[^.]+$/,'')+'.pdf';let pdf;
    try {
      for(const page of pages){if(['about','settings'].includes(page)){result.push(...propertyPages(page));continue;}tab=page==='plot'?original:page;zoom=null;const exportCanvas=document.createElement('canvas');exportCanvas.width=1684;exportCanvas.height=1190;const context=exportCanvas.getContext('2d');context.fillStyle=color('--canvas');context.fillRect(0,0,1684,1190);context.fillStyle=color('--text');context.font='30px '+getComputedStyle(document.body).fontFamily;context.fillText(current.document.name+' · '+({roast_profile:'温度曲线',fan_profile:'风扇曲线',log:'记录通道'}[tab]||'图表'),45,55);context.drawImage(pdfPlot(),35,90);result.push(exportCanvas);}
      pdf=window.WorkbenchPDF.build(result);
    }finally{tab=original;zoom=originalZoom;draw();}
    await download(pdf,name);
  }
  function pdfPlot() {
    // Render at print resolution; never stretch the screen canvas or its text.
    const output=document.createElement('canvas');output.width=1614;output.height=1000;
    const previousContext=ctx,previousDimensions=dimensions;
    try {ctx=output.getContext('2d');ctx.setTransform(2,0,0,2,0,0);dimensions={width:807,height:500};draw();return output;}
    finally {ctx=previousContext;dimensions=previousDimensions;}
  }
  async function libraryDialog() {
    const response=await fetch('/api/v1/profiles');if(!response.ok)throw Error('曲线库连接失败');const profiles=await response.json();
    const dialog=$('wb-dialog');dialog.innerHTML=`<form><h3>从现有曲线库打开</h3><label>曲线<select name="id" required>${profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><p>精确转换现有插值为贝塞尔曲线。已保存原生来源的曲线优先重开原生文件。</p><div class="wb-actions"><button type="button" class="ctrl-btn" data-close-dialog>取消</button><button class="ctrl-btn primary">打开</button></div></form>`;dialog.show();dialog.querySelector('[data-close-dialog]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=safe(async event=>{event.preventDefault();const id=new FormData(event.currentTarget).get('id');dialog.close();if(!await allowReplace())return;const response=await fetch('/api/v1/profiles/'+encodeURIComponent(id));if(!response.ok)throw Error('无法读取曲线');const profile=await response.json();if(profile.native_source)await perform({action:'view',document:profile.native_source},false,true);else await perform({action:'from_app',profile},false,true);tab='roast_profile';render();});
  }
  async function adopt() {
    await flushPhase();await operationQueue;
    const answer=await choose('保存到现有曲线库','仅将温度目标转换为新的控制曲线；风扇和 Kaffelogic 参数保留在原生文件中。保存后在曲线管理中手动应用。',[['save','保存新副本'],['cancel','取消']]);
    if(answer!=='save')return;
    const response=await fetch('/api/v1/workbench/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({document:current.document})});
    const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));
    $('wb-status').textContent=`已保存到曲线库 · 转换采样最大误差 ${data.conversion.max_sample_error_c.toFixed(3)}°C · 尚未应用`;
    window.dispatchEvent(new CustomEvent('roaster-profiles-changed'));
  }
  async function nativeContext(){
    await window.RoasterWorkbench.initialize();if(document.activeElement?.closest('#wb-inspector,#wb-properties'))document.activeElement.blur();await flushPhase();await operationQueue;
    if(!current)throw Error('请先在原生工作台打开 .kpro / .klog 文件');
    if(editError)throw Error('请先修正输入：'+editError);
    if(drag)throw Error('请先完成当前曲线拖动');
    const identity=getIdentity(),nativeDocument=clone(current.document);
    const result=await api({action:'analysis_context',document:nativeDocument,identity});
    if(!sameIdentity(identity))throw Error('文件已变化，请重新读取分析上下文');
    return {native:result.native,native_document:nativeDocument,identity};
  }
  function renderAIPreview(){
    const host=$('wb-ai-preview');if(!host||!aiPreview)return;
    const {proposal}=aiPreview;host.hidden=false;
    host.innerHTML=`<div class="wb-preview-heading"><h3>AI 候选 · 尚未采用</h3><button type="button" class="ctrl-btn" data-native-discard>放弃候选</button></div><p>${esc(proposal.rationale||'请对照当前曲线审阅候选。')}</p><div class="wb-preview-changes">${Object.entries(proposal.changes).map(([key,diff])=>`<div><strong>${key==='fan'?'风扇':'温度'}曲线</strong><span>节点 ${diff.before_points} → ${diff.after_points}</span><span>结束 ${time(diff.before_end_sec)} → ${time(diff.after_end_sec)}</span><span>采样最大变化 ${numeric(diff.max_sample_change,2)} ${key==='fan'?'RPM':'°C'}</span><span>候选范围 ${numeric(diff.range.min,2)}–${numeric(diff.range.max,2)} ${key==='fan'?'RPM':'°C'}</span><button type="button" class="ctrl-btn" data-native-preview="${key==='fan'?'fan_profile':'roast_profile'}">查看${key==='fan'?'风扇':'温度'}叠加</button></div>`).join('')}</div>${proposal.warnings.map(w=>`<p class="wb-preview-warning">${esc(w)}</p>`).join('')}<p>${esc(proposal.boundary)}</p><div class="wb-actions"><button type="button" class="ctrl-btn primary" data-native-accept>${proposal.separate_document?'确认为独立曲线草稿':'确认采用到草稿'}</button></div>`;
    const phaseBox=document.createElement('div');phaseBox.className='wb-preview-phase';
    phaseBox.innerHTML='<strong>预期 ABC 阶段变化</strong>'+Object.entries(proposal.phase_changes||{}).map(([key,value])=>`<div><span>${{drying:'A 脱水',maillard:'B 美拉德',development:'C 发展'}[key]}</span><span>${value.before?`${time(value.before.duration)} · ${numeric(value.before.percent)}%`:'—'} → ${value.after?`${time(value.after.duration)} · ${numeric(value.after.percent)}%`:'—'}</span></div>`).join('')+'<p>缺少预期事件温度时留空；这里是曲线预计算，不替代日志实测阶段。</p>';
    host.querySelector('.wb-preview-changes').after(phaseBox);
    host.querySelector('[data-native-discard]').onclick=clearAIPreview;
    host.querySelector('[data-native-accept]').onclick=safe(()=>acceptNative(aiPreview.artifact));
    host.querySelectorAll('[data-native-preview]').forEach(button=>{button.onclick=()=>{tab=button.dataset.nativePreview;zoom=null;render();};});
  }
  async function previewNative(artifact){
    artifact=clone(artifact);
    const sequence=++previewSequence;
    await window.RoasterWorkbench.initialize();await flushPhase();await operationQueue;
    if(editError)throw Error('请先修正输入：'+editError);
    if(drag)throw Error('请先完成当前曲线拖动');
    if(!sameIdentity(artifact?.identity))throw Error('原生文件已变化，候选已过期，请重新生成');
    if(sequence!==previewSequence)throw Error('候选预览已取消或被新的预览替换');
    const result=await api({action:'preview_native_proposal',document:current.document,proposal:artifact.value,identity:artifact.identity,preferences});
    if(!sameIdentity(artifact.identity))throw Error('请求期间文件已变化，候选已过期');
    if(sequence!==previewSequence)throw Error('候选预览已取消或被新的预览替换');
    aiPreview={...result,artifact:clone(artifact)};
    tab=artifact.value.temperature?'roast_profile':'fan_profile';zoom=null;render();renderAIPreview();
    $('wb-ai-preview').scrollIntoView({block:'nearest',behavior:'auto'});
    return clone(result.proposal);
  }
  async function acceptNative(artifact){
    artifact=clone(artifact);
    await previewNative(artifact);
    const sequence=previewSequence;
    const answer=await choose('采用 AI 原生候选',aiPreview.proposal.separate_document?'创建独立 .kpro 草稿；来源文件保留，撤销可返回。采用后仍需单独保存。':'将所选温度或风扇曲线写入当前原生草稿，可一次撤销。采用后仍需单独保存。',[['accept','确认采用'],['cancel','取消']]);
    if(answer!=='accept')return {accepted:false,cancelled:true};
    await flushPhase();
    const job=operationQueue.then(async()=>{
      if(!sameIdentity(artifact.identity)||sequence!==previewSequence||editError||drag)throw Error('原生文件或候选已变化，请重新预览');
      busy=true;refreshButtons();
      try{
        const result=await api({action:'preview_native_proposal',document:current.document,proposal:artifact.value,identity:artifact.identity,preferences});
        if(!sameIdentity(artifact.identity)||sequence!==previewSequence)throw Error('原生文件或候选已变化，请重新预览');
        const previous=snapshot(),sourceName=current.document.name;
        undo.push(previous);if(undo.length>80)undo.shift();redo=[];
        if(result.proposal.separate_document){savedDocuments.set(documentSessionId,savedSha);documentSessionId=crypto.randomUUID();savedSha='';savedDocuments.set(documentSessionId,savedSha);generation++;channels.clear();channelsInitialized=false;comparisons=[];}
        current=result.candidate;links={};selected=0;part='point';zoom=null;tab=artifact.value.temperature?'roast_profile':'fan_profile';
        invalidateAI();render();
        $('wb-status').textContent=result.proposal.separate_document?`已创建独立曲线草稿；来源 ${sourceName} 保留，可撤销返回。尚未保存。`:'已采用到原生草稿，可撤销；尚未保存或应用。';
        return {accepted:true,identity:getIdentity(),separate_document:result.proposal.separate_document};
      }finally{busy=false;refreshButtons();}
    });
    operationQueue=job.catch(()=>{});return job;
  }
  async function openHelp(){
    if(!window.WorkbenchHelp){helpReady=helpReady||new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=new URL('js/workbench-help.js',document.baseURI).href;script.onload=resolve;script.onerror=()=>{helpReady=null;script.remove();reject(Error('离线说明资源加载失败'));};document.head.append(script);});await helpReady;}
    const dialog=$('wb-dialog');if(dialog.open)dialog.close('cancel');dialog.onclose=null;
    window.WorkbenchHelp.open({dialog,catalog,current,jump:(action,parameter)=>{
      if(action==='ai'){window.dispatchEvent(new CustomEvent('roaster-ai-open',{detail:{context:'native'}}));return;}
      const views={temperature:'roast_profile',fan:'fan_profile',log:'log',settings:'settings',parameter:'settings'};
      if(views[action]){tab=views[action];if(action==='parameter'){const about=catalog.about_categories.some(group=>group.keys.includes(parameter));tab=about?'about':'settings';$('wb-search').value=parameter;difficulty=4;$('wb-difficulty').value='4';}render();if(parameter)$('wb-param-'+parameter)?.focus({preventScroll:false});return;}
      const target=$('wb-'+action);if(target&&!target.disabled){target.click();target.focus();}else if($('wb-status'))$('wb-status').textContent='请先打开适用于此操作的可编辑文件；日志可先提取曲线。';
    }});
  }
  async function initialize() {
    if(initialized)return; initialized=true;
    $('wb-root').innerHTML=`<div class="wb-heading"><h2>原生工作台</h2><span id="wb-filename" class="wb-filename"></span></div><div class="wb-toolbar">${[['new','新建'],['open','打开文件'],['save','保存文件'],['undo','撤销'],['redo','重做'],['compare','比较文件'],['library','从曲线库打开'],['adopt','存入曲线库']].map(([id,label])=>button('wb-'+id,label)).join('')}<input type="file" id="wb-file" accept=".kpro,.klog" hidden><input type="file" id="wb-compare-file" accept=".kpro,.klog" multiple hidden></div><div id="wb-error" class="wb-message" role="alert" hidden></div><div id="wb-warning" class="wb-warning"></div><div class="wb-tabs" role="tablist" aria-label="原生文件视图">${[['roast_profile','温度曲线'],['fan_profile','风扇曲线'],['log','记录'],['about','关于此文件'],['settings','曲线设置']].map(([key,label])=>`<button role="tab" data-wb-tab="${key}" aria-selected="${key===tab}">${label}</button>`).join('')}<div class="wb-options"><label>单位<select id="wb-unit"><option>C</option><option>F</option></select></label><label><input type="checkbox" id="wb-overlay" checked>双曲线叠加</label><label><input type="checkbox" id="wb-ror">RoR</label><label><input type="checkbox" id="wb-fan-steps">风扇增减</label><label id="wb-smoothing-label">平滑<input id="wb-smoothing" type="number" min="1" max="1000" value="1"></label><label id="wb-multiplier-label">RoR 倍率<input id="wb-multiplier" type="number" min="0.01" step="0.1" value="1"></label></div></div><div id="wb-comparisons" class="wb-comparisons"></div><div class="wb-main" id="wb-main"><div class="wb-plot-panel"><div id="wb-plot-toolbar" class="wb-actions">${[['insert','插点'],['delete','删点'],['smooth','平滑点'],['smooth-all','全部平滑']].map(([id,label])=>button('wb-'+id,label)).join('')}</div><div class="wb-canvas-wrap"><canvas id="wb-canvas" tabindex="0" role="img" aria-label="原生温度与风扇曲线编辑画布，可用数值输入和方向键编辑"></canvas></div><div id="wb-status" class="wb-status" role="status">所有编辑均在文件副本中进行</div></div><aside id="wb-inspector" class="wb-inspector" aria-label="节点、阶段与通道"></aside></div><div id="wb-properties" class="wb-properties" hidden><div class="wb-options"><label>筛选字段<input id="wb-search" type="search" placeholder="名称或参数键"></label><label>难度<select id="wb-difficulty"><option value="1">基础</option><option value="2">高级</option><option value="3">专家</option><option value="4" selected>工程师</option></select></label></div><div id="wb-property-list"></div></div><div class="wb-actions">${[['fit','全部缩放'],['zoom-in','放大'],['zoom-out','缩小'],['transform','曲线变换'],['merge','选择性合并'],['extract','从记录提取曲线'],['area','曲线面积'],['time','时间计算'],['csv','导出 CSV'],['png','导出图像'],['pdf','导出 PDF'],['help','操作帮助']].map(([id,label])=>button('wb-'+id,label)).join('')}</div><dialog id="wb-dialog" class="wb-dialog" aria-label="工作台操作"></dialog>`;
    canvas=$('wb-canvas');ctx=canvas.getContext('2d');installCanvas();new ResizeObserver(resize).observe(canvas.parentElement);
    const previewHost=document.createElement('section');previewHost.id='wb-ai-preview';previewHost.className='wb-ai-preview';previewHost.setAttribute('aria-label','AI 原生候选审阅');previewHost.hidden=true;$('wb-main').before(previewHost);
    const helpHeading=document.createElement('button');helpHeading.type='button';helpHeading.className='ctrl-btn';helpHeading.textContent='功能与说明';helpHeading.onclick=safe(openHelp);document.querySelector('.wb-heading').append(helpHeading);
    const actions={new:async()=>{if(await allowReplace()){await perform({action:'new'},false,true);savedSha='';renderTitle();}},open:()=>$('wb-file').click(),save:exportNative,undo:()=>historyStep(true),redo:()=>historyStep(false),compare:()=>$('wb-compare-file').click(),library:libraryDialog,adopt,insert:insertPoint,delete:()=>editCurve('delete'),smooth:()=>editCurve('smooth'),'smooth-all':()=>editCurve('smooth_all'),fit:()=>{zoom=null;draw();},'zoom-in':()=>zoomPlot(.7071067812),'zoom-out':()=>zoomPlot(Math.SQRT2),transform:()=>toolDialog('transform'),merge:()=>toolDialog('merge'),extract:async()=>{if(await allowReplace()){await perform({action:'extract'},false,true);savedSha='';tab='roast_profile';render();}},area:()=>toolDialog('area'),time:()=>toolDialog('time'),csv:async()=>{const result=await perform({action:'export',format:'csv'});await download(new Blob([Uint8Array.from(atob(result.data),c=>c.charCodeAt(0))],{type:result.mime}),current.document.name.replace(/\.[^.]+$/,'.csv'));},png:async()=>{const name=current.document.name+'.png';const blob=await new Promise(ok=>canvas.toBlob(ok));if(!blob)throw Error('图像导出失败');await download(blob,name);},pdf:()=>toolDialog('pdf'),help:()=>choose('操作帮助','锚点及左右控制柄可拖动，也可用右侧数值输入。方向键微调，Alt 加大步长；Ins 插点，Del 删点。滚轮缩放，Shift+滚轮只缩放纵轴。Ctrl+S 保存，Ctrl+Z 撤销，Ctrl+Y 重做。只读文件可查看、比较及导出采样。曲线库保存只生成新副本。',[['ok','知道了']])};
    actions.help=openHelp;$('wb-help').textContent='功能与说明';
    for(const [id,action] of Object.entries(actions))$('wb-'+id).onclick=safe(action);
    function zoomPlot(factor){const s=dimensions.scale,c=(s.x0+s.x1)/2;zoom={...s,x0:c+(s.x0-c)*factor,x1:c+(s.x1-c)*factor};draw();}
    $('wb-file').onchange=safe(async event=>{await openFiles([...event.target.files]);event.target.value='';});
    $('wb-compare-file').onchange=safe(async event=>{await openFiles([...event.target.files],true);event.target.value='';});
    $('wb-root').addEventListener('click',safe(async event=>{const el=event.target.closest('[data-wb-tab],[data-node],[data-compare-remove]');if(!el)return;if(el.dataset.wbTab){tab=el.dataset.wbTab;selected=0;part='point';zoom=null;render();}if(el.dataset.node!=null){selected=Number(el.dataset.node);part='point';renderInspector();draw();}if(el.dataset.compareRemove!=null){comparisons.splice(Number(el.dataset.compareRemove),1);render();}}));
    $('wb-root').addEventListener('change',safe(async event=>{const el=event.target;if(el.dataset.channel){if(el.checked)channels.add(el.dataset.channel);else channels.delete(el.dataset.channel);draw();}if(el.dataset.compareShow!=null){comparisons[el.dataset.compareShow].visible=el.checked;draw();}if(el.dataset.compareChannel!=null){comparisons[el.dataset.compareChannel].channel=el.value;draw();}if(el.dataset.parameter){await perform({action:'parameters',values:{[el.dataset.parameter]:el.value},unit},true);}if(el.dataset.phase){await perform({action:'parameters',values:{[el.dataset.phase]:el.value||'0'},unit},true);}if(el.dataset.event){await perform({action:'event',kind:el.dataset.event,value:el.value.trim()===''?null:el.value},true);}if(el.id==='wb-part'){part=el.value;renderInspector();draw();}if(el.id==='wb-linked'){links[`${tab}:${selected}`]=el.checked;}if(['wb-x','wb-y'].includes(el.id)){const x=parseTime($('wb-x').value),y=Number($('wb-y').value);if(!Number.isFinite(y))throw Error('请输入有效数值');await editCurve(part==='point'?'move':'handle',{x,y:tab==='roast_profile'?nativeTemperature(y):y,side:part,linked:links[`${tab}:${selected}`]!==false});}}));
    $('wb-root').addEventListener('input',event=>{const el=event.target;if(el.dataset.phase||el.dataset.parameter||el.dataset.event||['wb-x','wb-y'].includes(el.id))invalidateAI();if(!el.dataset.phase)return;clearTimeout(phaseTimer);phaseDraft={key:el.dataset.phase,value:el.value,unit,generation};phaseTimer=setTimeout(safe(flushPhase),180);});
    $('wb-unit').onchange=()=>{unit=$('wb-unit').value;render();};
    for(const id of ['wb-overlay','wb-ror'])$(id).onchange=()=>draw();
    for(const id of ['wb-smoothing','wb-multiplier','wb-fan-steps'])$(id).onchange=safe(async()=>{preferences={smoothing:Number($('wb-smoothing').value),multiplier:Number($('wb-multiplier').value),fan_steps:$('wb-fan-steps').checked};if(current)await perform({action:'view'});});
    $('wb-search').oninput=renderProperties;$('wb-difficulty').onchange=()=>{difficulty=Number($('wb-difficulty').value);renderProperties();};
    $('wb-root').addEventListener('dragover',event=>{event.preventDefault();$('wb-root').classList.add('wb-drop');});
    $('wb-root').addEventListener('dragleave',()=>$('wb-root').classList.remove('wb-drop'));
    $('wb-root').addEventListener('drop',safe(async event=>{event.preventDefault();$('wb-root').classList.remove('wb-drop');await openFiles([...event.dataTransfer.files],event.shiftKey);}));
    window.addEventListener('roaster-themechange',()=>draw());
    window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
    document.addEventListener('keydown',event=>{if(document.body.dataset.view!=='workbench'||!(event.ctrlKey||event.metaKey)||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;const key=event.key.toLowerCase();const map={s:exportNative,z:()=>historyStep(!event.shiftKey),y:()=>historyStep(false),o:()=>$('wb-file').click(),n:actions.new,l:actions.fit};if(map[key]){event.preventDefault();safe(map[key])();}});
    render();
    try{catalog=await api({action:'catalog'});if(current&&['settings','about'].includes(tab))renderProperties();}catch(error){message('工作台引擎尚未就绪：'+error.message);}
  }
  window.RoasterWorkbench={initialize:()=>initPromise||(initPromise=initialize()),getSnapshot:()=>current?clone(current):null,getHistory:()=>({undo:undo.length,redo:redo.length}),getError:()=>lastError,openFiles,api};
  window.RoasterWorkbenchAI={getContext:nativeContext,getIdentity,preview:previewNative,accept:acceptNative,discard:clearAIPreview,
    getSamples:async({channel,from,to,limit=600})=>{const context=await nativeContext();return api({action:'analysis_samples',document:context.native_document,identity:context.identity,channel,from,to,limit});}};
  document.addEventListener('DOMContentLoaded',()=>{
    let selectedRecord=null;
    window.addEventListener('roaster-record',event=>{selectedRecord=event.detail;});
    const recordButton=document.createElement('button');recordButton.className='ctrl-btn';recordButton.textContent='在原生工作台分析';
    document.querySelector('.record-actions').append(recordButton);
    recordButton.onclick=safe(async()=>{if(!selectedRecord)throw Error('请先选择一份记录');await window.RoasterWorkbench.initialize();document.querySelector('[data-tab="workbench"]').click();if(!await allowReplace())return;await perform({action:'from_record',record:selectedRecord},false,true);tab='log';render();});
    document.querySelector('[data-tab="workbench"]').addEventListener('click',()=>{window.RoasterWorkbench.initialize().then(resize);});
    if(location.hash==='#workbench')window.RoasterWorkbench.initialize();
  });
})();
