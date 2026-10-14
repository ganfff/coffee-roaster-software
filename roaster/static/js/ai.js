(function () {
  'use strict';
  const native = window.RoasterNativeAI;
  const enabled = '__TAURI_INTERNALS__' in window && !!native;
  const pending = new Map();
  const backend = () => localStorage.getItem('roaster.backendUrl') || 'http://localhost:8000';
  let latestStatus = null, livePanel = null, recordPanel = null, liveEnabled = false, liveSession = null, lastLive = 0, lastPhase = null;
  const element = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  async function api(url, options) {
    const r = await fetch(url, options); const body = await r.json();
    if (!r.ok) throw Error(typeof body.detail === 'string' ? body.detail : body.detail?.errors?.join('；') || (r.status === 404 ? '此功能需要更新烘焙机后端' : `请求失败 ${r.status}`));
    return body;
  }
  const post = (url, body, method = 'POST') => api(url, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  let ready = enabled ? native.listen('roaster-ai', event => {
    const item = pending.get(event.payload.id); if (!item) return;
    const {type, data} = event.payload;
    if (type === 'error') {pending.delete(event.payload.id); item.reject(Error(data));}
    else if (type === 'done') {pending.delete(event.payload.id); item.resolve(item.result);}
    else {item.result[type] = data; item.onEvent?.(type, data);}
  }) : Promise.resolve();
  async function run(request, onEvent, onId) {
    await ready;
    const id = crypto.randomUUID(); onId?.(id);
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject, result: {}, onEvent});
      native.invoke('ai_run', {request: {...request, id}}).catch(e => {pending.delete(id); reject(Error(String(e)));});
    });
  }
  async function cancel(id) {
    if (!id) return;
    const item = pending.get(id); pending.delete(id);
    item?.reject(Error('已取消，原稿保持不变'));
    await native.invoke('ai_cancel', {id});
  }
  const contextFields = [['bean_name','豆子'],['origin','产地'],['process','处理法'],['charge_weight_g','投豆量（g）'],['target_roast','目标焙度'],['target_flavor','目标风味']];
  function contextForm(parent, value = {}, feedback = null) {
    const details = element('details', null, 'ai-context'); details.append(element('summary', '豆子与烘焙资料（可选）'));
    const grid = element('div', null, 'ai-field-grid'); details.append(grid);
    for (const [name, label] of contextFields) {
      const field = element('label', null, 'ai-field'); field.append(element('span', label));
      const input = element('input'); input.name = name; input.value = value?.[name] ?? ''; input.type = name === 'charge_weight_g' ? 'number' : 'text'; input.maxLength = name === 'target_flavor' ? 1000 : 200;
      if (input.type === 'number') {input.min = '0.1'; input.max = '100000'; input.step = '0.1';}
      field.append(input); grid.append(field);
    }
    let notes;
    if (feedback !== null) {const label = element('label', null, 'ai-field'); label.append(element('span', '杯测／口感反馈')); notes = element('textarea'); notes.value = feedback?.notes || ''; notes.maxLength = 4000; label.append(notes); details.append(label);}
    parent.append(details);
    return {read(validate=true) {const data = {temperature_source: 'bean'}; for (const [name] of contextFields) {const v = grid.querySelector(`[name="${name}"]`).value.trim(); if (name === 'charge_weight_g') {const n = v ? Number(v) : null;if(validate&&n!==null&&(!Number.isFinite(n)||n<=0||n>100000))throw Error('投豆量需为有效正数'); data[name] = n;} else data[name] = v;} return data;}, feedback: () => ({notes: notes?.value || ''}), node: details};
  }
  function mount(host, options) {
    if (!enabled || !host) return null;
    host.replaceChildren();
    const panel = element('details', null, 'ai-panel'); panel.open = !!options.open;
    panel.append(element('summary', options.title || 'AI 烘焙助手'));
    const body = element('div', null, 'ai-panel-body'); panel.append(body); host.append(panel);
    body.append(element('p', options.kind === 'live' ? '只读辅导 · 基于本锅快照，显示分析时刻。' : '结合当前数据对话，生成可审阅的建议。', 'ai-muted'));
    const output = element('div', null, 'ai-output'); output.tabIndex = 0;
    const status = element('p', '准备就绪', 'ai-status'); status.setAttribute('role', 'status');
    const promptLabel = element('label', null, 'ai-field'); promptLabel.append(element('span', '你的要求'));
    const prompt = element('textarea'); prompt.rows = 3; prompt.maxLength = 4000; prompt.placeholder = options.kind === 'design' ? '例如：保留前 3 分钟，延长发展期 20 秒' : '例如：分析一爆前后的 ROR，并给出下一锅建议'; promptLabel.append(prompt);
    let lockInput, reference;
    if (options.kind === 'design') {const label = element('label', null, 'ai-field'); label.append(element('span', '锁定前段（秒，留空不锁定）')); lockInput = element('input'); lockInput.type = 'number'; lockInput.min = '0'; lockInput.step = '1'; label.append(lockInput); body.append(label);}
    if (options.kind === 'design') {const label=element('label',null,'ai-field');label.append(element('span','参考历史记录（可选）'));reference=element('select');const empty=element('option','不添加参考');empty.value='';reference.append(empty);label.append(reference);body.append(label);api('/api/v1/records?limit=50').then(records=>{for(const record of records){const item=element('option',`${record.display_name||record.session_id} · ${record.profile_name||'历史烘焙'}`);item.value=record.session_id;reference.append(item);}reference.value=new URLSearchParams(location.search).get('record_id')||'';}).catch(()=>{});}
    const actions = element('div', null, 'ai-actions');
    const send = element('button', options.kind === 'design' ? '生成／调整曲线' : '分析并回复', 'ctrl-btn primary');
    const stop = element('button', '取消', 'ctrl-btn'); stop.disabled = true;
    const clear = element('button', '新对话', 'ctrl-btn');
    actions.append(send, stop, clear); body.append(promptLabel, actions, status, output);
    const resultActions = element('div', null, 'ai-actions'); body.append(resultActions);
    let requestId = null, busy = false, artifact = null, savedDraft = null, storageKey = '', analysisSession = null, revision = 0;
    const draftKey=crypto.randomUUID();
    function invalidate() {revision++; artifact = null; resultActions.replaceChildren(); options.onPreview?.(null); if (requestId) cancel(requestId).catch(() => {});}
    async function analyze(question) {
      if (busy) return;
      let localRevision = revision, endpoint = backend();
      busy = true; send.disabled = true; stop.disabled = false; clear.disabled = true; artifact = null; output.replaceChildren(); resultActions.replaceChildren();
      const stream = element('p', null, 'ai-stream'); output.append(stream);
      try {
        const context = await options.getContext();
        if(reference?.value) context.reference_record=await api('/api/v1/records/'+encodeURIComponent(reference.value));
        savedDraft = options.getDraft ? JSON.stringify(options.getDraft()) : null;
        if (localRevision !== revision || endpoint !== backend()) return;
        analysisSession = context.status?.session_id;
        const source = options.getSource?.() || null;
        const locked = lockInput?.value === '' || !lockInput ? null : Number(lockInput.value);
        const objectKey=options.objectKey?.() || context.record?.session_id || source?.id;
        storageKey = `${endpoint}|${options.kind}|${!objectKey||objectKey==='new'?draftKey:objectKey}|${JSON.stringify(options.getIdentity ? options.getIdentity() : source || context.record?.profile_snapshot || null)}|${JSON.stringify(context.record?.roast_context || null)}|${JSON.stringify(context.record?.cup_feedback || null)}`;
        status.textContent = `分析中 · 快照 ${new Date(context.captured_at || Date.now()).toLocaleTimeString('zh-CN')} · 可随时取消`;
        const data = await run({kind: options.kind, prompt: question || prompt.value.trim() || (options.kind === 'design' ? '根据豆子资料和目标设计烘焙曲线，并说明假设。' : '评价本锅烘焙，指出有数据依据的问题与下一锅建议。'), context, source, locked_until: locked, storage_key: storageKey}, (type, value) => {
          if (localRevision !== revision || endpoint !== backend()) return;
          if (type === 'text') stream.textContent += value;
          if (type === 'artifact') artifact = value;
        }, id => requestId = id);
        if (localRevision !== revision || endpoint !== backend()) return;
        if (options.kind === 'live' && (latestStatus?.state !== 'ROASTING' || latestStatus?.session_id !== analysisSession)) {status.textContent = '本锅已结束，忽略过期建议'; return;}
        if (artifact?.type === 'review') {
          const value = artifact.value; output.append(element('h4', value.summary));
          for (const [key, label] of [['observations','过程观察'],['recommendations','建议'],['assumptions','假设与资料缺口']]) {if (!value[key]?.length) continue; output.append(element('strong', label)); const list = element('ul'); value[key].forEach(text => list.append(element('li', text))); output.append(list);}
          if (options.onDesign) {const design = element('button', '按建议设计下一锅', 'ctrl-btn'); design.onclick = () => options.onDesign(value); resultActions.append(design);}
        }
        if (artifact?.type === 'profile') {
          const p = artifact.value, draft = options.getDraft();
          const serverCheck = await post('/api/v1/analysis/profiles/validate', {profile: p, source, locked_until: locked});
          if (!serverCheck.valid) throw Error(serverCheck.errors.join('；'));
          if (localRevision !== revision) return;
          const unchanged = savedDraft === JSON.stringify(options.getDraft());
          output.append(element('h4', p.name), element('p', p.rationale), element('p', `时长 ${draft.nodes.at(-1).time} → ${p.nodes.at(-1).time} 秒 · 自动结束 ${draft.end_temp} → ${p.end_temp}°C · ${p.nodes.length} 节点`));
          const table = element('table', null, 'ai-diff'); const head = element('tr'); ['候选时间（秒）','候选温度（°C）','原节点温度（同一时间）'].forEach(t => head.append(element('th',t))); table.append(head);
          p.nodes.forEach(n => {const row = element('tr'); [n.time,n.temperature,draft.nodes.find(old => old.time === n.time)?.temperature ?? '—'].forEach(t => row.append(element('td',String(t)))); table.append(row);}); output.append(table);
          options.onPreview?.(p);
          const accept = element('button', '采用到草稿', 'ctrl-btn primary'); accept.disabled = !unchanged;
          if (!unchanged) output.append(element('p','请求期间草稿已变更，请重新生成。','ai-muted'));
          accept.onclick = async () => {
            if (savedDraft !== JSON.stringify(options.getDraft())) {accept.disabled = true; status.textContent = '草稿已变更，请重新生成'; return;}
            if (draft.end_temp !== p.end_temp && !confirm(`自动结束温度将从 ${draft.end_temp} 改为 ${p.end_temp}°C${p.end_temp === 0 ? '（关闭自动结束）' : ''}。采用这项调整？`)) return;
            const cfg = await native.invoke('ai_settings');
            options.onAccept({...p, ai_origin: {provider: cfg.provider, model: cfg.model, source_id: source?.id || null, generated_at: new Date().toISOString()}}, {source, locked_until: locked});
            accept.disabled = true; status.textContent = '已采用，可撤销；保存后再手动应用';
          };
          const discard = element('button', '放弃候选', 'ctrl-btn'); discard.onclick = () => {invalidate(); status.textContent = '已放弃，原稿保持不变';}; resultActions.append(accept, discard);
        }
        let usage = data.usage;
        status.textContent = `分析完成 · 数据时刻 ${new Date(context.captured_at || Date.now()).toLocaleTimeString('zh-CN')}${usage ? ` · ${usage.input + usage.output} tokens` : ''}`;
      } catch (e) {if (localRevision === revision) status.textContent = String(e.message || e);}
      finally {busy = false; requestId = null; send.disabled = false; stop.disabled = true; clear.disabled = false;}
    }
    send.onclick = () => analyze();
    stop.onclick = () => {invalidate(); status.textContent = '已取消，原稿保持不变';};
    clear.onclick = async () => {invalidate(); output.replaceChildren(); if (storageKey) await native.invoke('ai_clear_history',{storageKey}); status.textContent = '已开始新对话';};
    return {analyze, invalidate, get busy() {return busy;}, panel, body, status};
  }

  async function settings(host) {
    if (!enabled) return;
    const card = element('section', null, 'settings-card ai-settings'); card.append(element('h3','AI 服务'),element('p','密钥保存在 Windows 凭据管理器，分析数据发送到你选择的服务。','ai-muted'));
    const providerLabel = element('label', null, 'ai-field'); providerLabel.append(element('span','供应商')); const provider = element('select');
    [['','请选择'],['deepseek','DeepSeek'],['moonshotai-cn','Moonshot 中国'],['openai','OpenAI'],['anthropic','Anthropic'],['google','Gemini'],['openrouter','OpenRouter'],['custom','自定义兼容 API / 本地模型']].forEach(([v,t])=>{const option=element('option',t);option.value=v;provider.append(option);}); providerLabel.append(provider);card.append(providerLabel);
    const field = (name, label, type='text') => {const wrapper = element('label',null,'ai-field');wrapper.append(element('span',label));const input=element('input');input.type=type;input.name=name;wrapper.append(input);card.append(wrapper);return input;};
    const model=field('model','模型 ID'), base=field('base_url','自定义 API 地址（仅自定义供应商）'), secret=field('api_key','API Key（留空保留已存密钥）','password');secret.autocomplete='new-password';
    const modelsList = element('datalist'); modelsList.id='ai-model-options'; model.setAttribute('list',modelsList.id);card.append(modelsList);
    const actions=element('div',null,'ai-actions');const save=element('button','保存配置','ctrl-btn primary'), list=element('button','加载模型目录','ctrl-btn'), test=element('button','测试连接','ctrl-btn'), remove=element('button','删除密钥','ctrl-btn');actions.append(save,list,test,remove);card.append(actions);
    const status=element('p','尚未配置','ai-status');status.setAttribute('role','status');card.append(status);host.prepend(card);
    const load=async()=>{const cfg=await native.invoke('ai_settings');provider.value=cfg.provider||'';model.value=cfg.model||'';base.value=cfg.base_url||'';status.textContent=cfg.configured?'密钥已配置':'未保存密钥；本地无密钥接口可直接使用';};
    const persist=async()=>{const value={provider:provider.value,model:model.value.trim(),base_url:base.value.trim(),api_key:secret.value};await native.invoke('ai_save_settings',{settings:value});secret.value='';};
    async function action(kind) {save.disabled=list.disabled=test.disabled=remove.disabled=true;try {await persist();if(kind==='save') await load();else {status.textContent='请求中…';const result=await run({kind,storage_key:'connection-test'});if(kind==='models') {modelsList.replaceChildren();for(const item of result.models||[]) {const o=element('option');o.value=item.id;o.label=item.name;modelsList.append(o);}status.textContent=`已加载 ${result.models?.length||0} 个模型，可在模型输入框选择`;}else status.textContent=`连接成功${result.usage?` · ${result.usage.input+result.usage.output} tokens`:''}`;}}catch(e){status.textContent=String(e.message||e);}finally{save.disabled=list.disabled=test.disabled=remove.disabled=false;}}
    save.onclick=()=>action('save');list.onclick=()=>action('models');test.onclick=()=>action('test');remove.onclick=async()=>{try{await native.invoke('ai_delete_key');await load();}catch(e){status.textContent=String(e);}};
    provider.onchange=()=>{model.value='';base.disabled=provider.value!=='custom';};
    try {await load();base.disabled=provider.value!=='custom';} catch(e) {status.textContent=String(e);}
  }

  window.RoasterAI={enabled,api,post,contextForm,mount,backend};
  if (!enabled) return;
  window.addEventListener('roaster-status', event => {
    const status=event.detail, previous=latestStatus;latestStatus=status;
    if(status.state!=='ROASTING'||!status.connected||(previous?.session_id&&status.session_id!==previous.session_id)||(liveEnabled&&status.session_id!==liveSession)) {if(liveEnabled||livePanel?.busy){liveEnabled=false;livePanel?.invalidate();if(livePanel)livePanel.status.textContent='持续辅导已停止，请每锅重新开启';const toggle=document.querySelector('.ai-live-toggle');if(toggle){toggle.textContent='开启本锅持续辅导';toggle.setAttribute('aria-pressed','false');}}}
    if(liveEnabled && (Date.now()-lastLive>=60000 || status.current_phase!==lastPhase)) {if(!livePanel.busy){lastLive=Date.now();lastPhase=status.current_phase;livePanel.analyze('根据最新快照给出简短的实时建议，标明依据时刻，不修改设备。');}}
  });
  window.addEventListener('roaster-disconnected',()=>{liveEnabled=false;livePanel?.invalidate();if(livePanel)livePanel.status.textContent='连接已断开，持续辅导停止';const toggle=document.querySelector('.ai-live-toggle');if(toggle){toggle.textContent='开启本锅持续辅导';toggle.setAttribute('aria-pressed','false');}});
  window.addEventListener('roaster-record', event => {
    recordPanel?.invalidate();const record=event.detail;const host=document.querySelector('#record-detail');
    let container=host.querySelector('.ai-record-host');if(!container){container=element('div',null,'ai-record-host');host.append(container);}
    recordPanel=mount(container,{kind:'review',title:'AI 烘焙复盘',objectKey:()=>record.session_id,
      getContext:async()=>({record:{...record,roast_context:form.read(),cup_feedback:form.feedback()},captured_at:new Date().toISOString()}),
      onDesign:async value=>{if(latestStatus?.state!=='IDLE'){recordPanel.status.textContent='请在待机时设计下一锅曲线';return;}try{await post('/api/v1/records/'+encodeURIComponent(record.session_id)+'/context',{roast_context:form.read(),cup_feedback:form.feedback()},'PATCH');sessionStorage.setItem('roaster.ai.brief',value.recommendations.join('\n'));window.location.href='/editor.html?ai=1&record_id='+encodeURIComponent(record.session_id);}catch(e){recordPanel.status.textContent=e.message;}}});
    const form=contextForm(recordPanel.body,record.roast_context,record.cup_feedback||{});
    const save=element('button','保存本锅资料与反馈','ctrl-btn');save.onclick=async()=>{try{const data={roast_context:form.read(),cup_feedback:form.feedback()};await post('/api/v1/records/'+encodeURIComponent(record.session_id)+'/context',data,'PATCH');Object.assign(record,data);recordPanel.status.textContent='资料已保存';}catch(e){recordPanel.status.textContent=e.message;}};form.node.append(save);
  });
  document.addEventListener('DOMContentLoaded',()=>{
    const grid=document.querySelector('.settings-grid');if(grid)settings(grid);
    const controls=document.querySelector('#controls-panel .command-scroll');
    if(controls){const container=element('div');controls.append(container);livePanel=mount(container,{kind:'live',title:'AI 实时辅导',getContext:async()=>{const context=await api('/api/v1/analysis/context');if(context.status.state!=='ROASTING'||!context.status.connected)throw Error('请在设备连接且正在烘焙时分析');return context;}});
      const toggle=element('button','开启本锅持续辅导','ctrl-btn ai-live-toggle');toggle.setAttribute('aria-pressed','false');toggle.onclick=()=>{if(!liveEnabled&&(!latestStatus||latestStatus.state!=='ROASTING'||!latestStatus.connected)){livePanel.status.textContent='请先开始烘焙并保持设备连接';return;}liveEnabled=!liveEnabled;liveSession=latestStatus?.session_id;lastLive=0;lastPhase=null;toggle.textContent=liveEnabled?'暂停持续辅导':'开启本锅持续辅导';toggle.setAttribute('aria-pressed',String(liveEnabled));if(!liveEnabled)livePanel.invalidate();};livePanel.body.prepend(toggle);
    }
    const actions=document.querySelector('.profile-actions');if(actions){const design=element('button','AI 设计曲线','ctrl-btn');design.onclick=()=>{if(latestStatus?.state!=='IDLE'){livePanel.status.textContent='请在待机时设计曲线';livePanel.panel.open=true;return;}window.location.href='/editor.html?ai=1';};actions.append(design);}
    const editor=window.RoasterEditor;if(editor){const host=element('div');document.querySelector('.props-panel').prepend(host);const panel=mount(host,{kind:'design',title:'AI 曲线助手',open:new URLSearchParams(location.search).has('ai'),getDraft:editor.getDraft,getSource:editor.getSource,getIdentity:editor.getIdentity,objectKey:()=>new URLSearchParams(location.search).get('profile_id')||new URLSearchParams(location.search).get('record_id')||'new',
      getContext:async()=>{await editor.ready;if(editor.error)throw Error(editor.error);editor.validate();const context=await api('/api/v1/analysis/context');if(context.status.state!=='IDLE')throw Error('请回到控制台，待机后再设计曲线');return {...context,operation:editor.isNew()?'new_curve':'modify_current_draft',draft:editor.getSource(),roast_context:editor.getDraft().roast_context};},onPreview:editor.preview,onAccept:editor.accept});editor.setAI(panel);
      const brief=sessionStorage.getItem('roaster.ai.brief');if(brief){panel.body.querySelector('textarea').value=brief;sessionStorage.removeItem('roaster.ai.brief');}
    }
  });
  window.addEventListener('beforeunload',()=>{for(const id of pending.keys())native.invoke('ai_cancel',{id}).catch(()=>{});});
})();
