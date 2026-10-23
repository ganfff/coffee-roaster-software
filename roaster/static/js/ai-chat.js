/* Shared chat UI. Business actions remain explicit and validated by their owner. */
(function () {
  'use strict';
  const native = window.RoasterNativeAI;
  const transport = window.RoasterAITransport;
  const desktop = '__TAURI_INTERNALS__' in window && !!native;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const uid = () => crypto.randomUUID();
  const clone = value => JSON.parse(JSON.stringify(value));
  const backend = () => desktop ? (window.ROASTER_BACKEND || localStorage.getItem('roaster.backendUrl') || 'http://localhost:8000') : location.origin;
  const host = desktop ? 'local' : 'backend';
  let panel, messages, history, composer, info, profileSelect, modelSelect, access, settingsCard, configForm;
  let profiles = [], providers = [], conversations = [], conversation = null, activeRun = null;
  let selectedProfile = '', contextBinding = null, queuedAttachments = [], queuedContext = null;
  let selectionInitialized = false;
  const restoredCatalogs = new Set();
  let currentRecord = null, connected = false, socket = null, reconnectTimer, generation = 0;
  let latestStatus = null, loginId = null, authBox, settingsStatus, abortEvents, nativeReady, eventCursor = 0;
  const sequences = new Map(), transient = new Map(), runBindings = new Map();
  const attachmentViews = new Map();
  const openedAuthUrls = new Set();
  const key = suffix => 'roaster.ai.' + host + '.' + (desktop ? 'this-computer' : location.origin) + '.' + suffix;
  function button(text, action, cls = '') { const b = el('button', text, 'ctrl-btn ' + cls); b.type = 'button'; b.onclick = () => { try { Promise.resolve(action()).catch(fail); } catch(error) { fail(error); } }; return b; }
  function fail(error) { const raw = error?.message || String(error); const message = /not found|failed to fetch|networkerror/i.test(raw) ? 'AI 服务暂时无法连接，请检查后端地址后点击重新连接。' : raw; if (info) info.textContent = message; if (settingsStatus) settingsStatus.textContent = message; }
  async function jsonFetch(path, options) {
    const response = await fetch(path, {credentials: 'same-origin', ...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(typeof body.detail === 'string' ? body.detail : body.error?.message || body.error || 'AI 请求失败（' + response.status + '）');
    return body;
  }
  async function rpc(method, params = {}) {
    await nativeReady;
    return transport.request(method, params);
  }
  function activeProfile() { return profiles.find(p => p.id === selectedProfile); }
  function setStatus(text) { if (info) info.textContent = text; }
  async function business(path, value, method) {
    return jsonFetch(path, value === undefined ? undefined : {method: method || 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
  }
  async function nativeRequest(request) {
    if (desktop) return native.invoke('workbench_request', {request});
    return business('/api/v1/workbench', request);
  }
  function messageText(message) {
    if (typeof message.content === 'string') return message.content;
    return (message.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  }
  // No raw HTML is interpreted. Only code, emphasis, lists, and safe HTTP links.
  function markdown(node, text) {
    let code = false, pre;
    for (const line of String(text).split('\n')) {
      if (/^\s*~~~|^\s*```/.test(line)) {
        code = !code; if (code) { pre = el('pre'); node.append(pre); } continue;
      }
      if (code) { pre.append(document.createTextNode(line + '\n')); continue; }
      const n = el(/^#{1,4} /.test(line) ? 'h4' : 'p');
      const clean = line.replace(/^#{1,4}\s/, '').replace(/^[-*]\s/, '• ');
      const re = /(\*\*[^*]+\*\*|\x60[^\x60]+\x60|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
      let last = 0;
      for (const m of clean.matchAll(re)) {
        n.append(document.createTextNode(clean.slice(last, m.index)));
        if (m[0].startsWith('**')) n.append(el('strong', m[0].slice(2, -2)));
        else if (m[0].charCodeAt(0) === 96) n.append(el('code', m[0].slice(1, -1)));
        else { const link = /^\[([^\]]+)\]\((.+)\)$/.exec(m[0]); const a = el('a', link[1]); a.href = link[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; n.append(a); }
        last = m.index + m[0].length;
      }
      n.append(document.createTextNode(clean.slice(last))); node.append(n);
    }
  }
  function updateSelect() {
    if (!profileSelect) return;
    profileSelect.replaceChildren();
    for (const p of profiles) { const o = el('option', p.name || p.provider); o.value = p.id; profileSelect.append(o); }
    if(!selectionInitialized&&profiles.length){
      const saved=localStorage.getItem(key('profile'));
      selectedProfile=selectedProfile||(profiles.some(p=>p.id===saved)?saved:(profiles.find(p=>p.can_chat)||profiles.find(p=>p.authenticated)||profiles[0]).id);
      selectionInitialized=true;
    }
    if (!profiles.some(p => p.id === selectedProfile)) selectedProfile = '';
    if(selectedProfile)localStorage.setItem(key('profile'),selectedProfile);
    else if(selectionInitialized)localStorage.removeItem(key('profile'));
    if(!selectedProfile)option(profileSelect,'',profiles.length?'请选择账户':'连接 AI 账户');
    profileSelect.value = selectedProfile;
    profileSelect.disabled = !!activeRun || !profiles.length;
    if(modelSelect){const p=activeProfile();modelSelect.replaceChildren();for(const m of p?.catalog||[])option(modelSelect,m.id,m.name||m.id);if(!modelSelect.options.length)option(modelSelect,p?.model||'',p?.model_name||p?.model||'尚未选择模型');modelSelect.value=p?.model||'';modelSelect.disabled=!!activeRun||!p?.model;}
  }
  async function refresh() {
    profiles = await rpc('profiles.list');
    conversations = await rpc('conversations.list');
    profiles = Array.isArray(profiles) ? profiles : profiles.profiles || [];
    conversations = Array.isArray(conversations) ? conversations : conversations.conversations || [];
    connected = true; access.hidden = true;
    updateSelect(); renderHistory();
    const saved = conversation?.id || localStorage.getItem(key('conversation')) || (desktop && localStorage.getItem('roaster.ai.local.'+backend()+'.conversation'));
    if (saved && conversations.some(c => c.id === saved)) await loadConversation(saved,{keepSelection:!!selectedProfile||!!conversation});
    setStatus(profiles.length ? (!activeProfile()?'请选择要使用的账户':activeProfile().can_chat === false ? accountState(activeProfile()) : 'AI 已就绪') : '连接一个 AI 账户，开始对话');
    if (!desktop) connectEvents();
    // Resume interrupted model loading once; reopening never starts OAuth.
    for(const p of profiles){
      if(p.login_id||!p.configured||restoredCatalogs.has(p.id)||!['loading','not_loaded','error','auth_required',undefined].includes(p.catalog_status))continue;
      restoredCatalogs.add(p.id);
      rpc('models',{profile_id:p.id,refresh:true}).then(refresh).then(()=>configForm&&loadSettings()).catch(async()=>{await refresh();if(configForm)await loadSettings();}).catch(fail);
    }
  }
  async function loadConversation(id,{keepSelection=false}={}) {
    conversation = await rpc('conversations.get', {id});
    localStorage.setItem(key('conversation'), id);
    if(!keepSelection)selectedProfile = conversation.profile_id || selectedProfile;
    const running = conversation.active_run || conversation.active_request || conversation.messages?.findLast(m=>m.role==='assistant'&&m.status==='streaming')?.run_id;
    if (running) { activeRun = typeof running === 'string' ? running : running.id; await replay(activeRun); }
    updateSelect(); renderMessages(); renderHistory();
  }
  async function newConversation() {
    if (activeRun) throw Error('请先停止当前回复，再新建会话');
    conversation = await rpc('conversations.create', {profile_id: selectedProfile, title: '新对话'});
    localStorage.setItem(key('conversation'), conversation.id);
    contextBinding = null; queuedContext = null; queuedAttachments = [];
    await refresh(); renderQueued();
  }
  function renderHistory() {
    if (!history) return; history.replaceChildren();
    const query = ($('ai-history-search')?.value || '').trim().toLowerCase();
    for (const c of conversations.filter(c => !query || (c.title || '').toLowerCase().includes(query))) {
      const b = button(c.title || '新对话', async () => {
        if (activeRun && c.id !== conversation?.id) throw Error('请先停止当前回复，再切换会话');
        await loadConversation(c.id);
      }, 'ai-history-item');
      b.setAttribute('aria-current', c.id === conversation?.id ? 'true' : 'false'); history.append(b);
    }
    if (!history.children.length) history.append(el('p', query ? '没有匹配会话' : '尚无会话', 'ai-muted'));
  }
  function renderMessages() {
    if (!messages) return;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 110;
    messages.replaceChildren();
    $('ai-chat-title').textContent = conversation?.title || 'AI 烘焙助手';
    for (const message of conversation?.messages || []) {
      if (!['user', 'assistant'].includes(message.role)) continue;
      if (message.status === 'streaming' && transient.has(message.run_id)) continue;
      const text = messageText(message);
      const artifacts = message.artifacts || (message.artifact ? [message.artifact] : []);
      if (!text && !artifacts.length) continue;
      const row = el('article', null, 'ai-message ai-message-' + message.role);
      row.append(el('strong', message.role === 'user' ? '你' : (message.model || 'AI'), 'ai-message-label'));
      const content = el('div', null, 'ai-message-content'); markdown(content, text); row.append(content);
      for(const a of message.attachment_info || (message.attachments||[]).map(id=>({id,name:'附件'}))) {
        const wrap=el('div',null,'ai-message-attachment');
        wrap.append(button(a.name+(a.mime_type?.startsWith('image/')?' · 查看图片':' · 下载附件'),async()=>{
          const file=await rpc('attachments.get',{id:a.id});
          if(file.mime_type?.startsWith('image/')) {
            if(attachmentViews.get(a.id)){attachmentViews.delete(a.id);renderMessages();return;}
            attachmentViews.set(a.id,file);if(attachmentViews.size>16)attachmentViews.delete(attachmentViews.keys().next().value);renderMessages();
          }else{
            const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=el('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          }
        }));
        const opened=attachmentViews.get(a.id);
        if(opened){const img=el('img');img.src='data:'+opened.mime_type+';base64,'+opened.data;img.alt=opened.name;img.loading='lazy';wrap.append(img);}
        row.append(wrap);
      }
      for (const artifact of artifacts) row.append(artifactView(artifact, runBindings.get(message.run_id || message.request_id) || message.context_binding || contextBinding));
      if (message.compaction) row.append(el('p','较早上下文已压缩，完整消息仍保留在历史中','ai-muted'));
      const actions = el('div', null, 'ai-actions');
      actions.append(button('复制', async () => { await navigator.clipboard.writeText(text); setStatus('已复制'); }));
      if (message.role === 'user') actions.append(button('编辑后重发', () => { composer.value = text; composer.dataset.retryFrom = message.id; composer.focus(); setStatus('修改后发送将创建新的回复，原消息保留在历史中'); }));
      else actions.append(button('重新生成', () => {
        const all = conversation.messages, at = all.indexOf(message);
        const previous = all.slice(0, at).reverse().find(m => m.role === 'user');
        if (previous) return send(messageText(previous), contextBinding, previous.id);
      }));
      row.append(actions); messages.append(row);
      if(['cancelled','error','interrupted'].includes(message.status))row.append(el('p',message.error?.message||(message.status==='cancelled'?'回复已停止，可重新生成':'回复已中断，可重新生成'),'ai-muted'));
    }
    for (const [id, item] of transient) if (item.conversation_id === conversation?.id) {
      const row = el('article', null, 'ai-message ai-message-assistant'); row.dataset.requestId = id;
      row.append(el('strong', 'AI', 'ai-message-label'));
      const content = el('div', null, 'ai-message-content'); markdown(content, item.text || '正在思考…'); row.append(content);
      for (const artifact of item.artifacts || []) row.append(artifactView(artifact, runBindings.get(id)));
      messages.append(row);
    }
    if (!messages.children.length) { const welcome = el('div', null, 'ai-chat-welcome'); welcome.append(el('h3', '从当前这锅开始聊'), el('p', '分析记录、推敲曲线，或选入原生文件。发送前可以查看本次携带的数据。')); messages.append(welcome); }
    if (atBottom) messages.scrollTop = messages.scrollHeight;
    $('ai-stop').disabled = !activeRun; $('ai-stop').hidden = !activeRun; $('ai-send').hidden = !!activeRun; $('ai-send').disabled = false;
  }
  function artifactView(artifact, binding) {
    if (binding && !binding.draft && window.RoasterEditor && JSON.stringify(window.RoasterEditor.getSource()) === JSON.stringify(binding.source)) binding = {...binding,draft:JSON.stringify(window.RoasterEditor.getDraft())};
    const box = el('section', null, 'ai-artifact');
    const value = artifact.value || artifact;
    box.append(el('h4', artifact.type === 'native_profile' ? '原生曲线候选' : artifact.type === 'profile' ? value.name || '曲线候选' : value.summary || '分析结果'));
    if (value.rationale) box.append(el('p', value.rationale));
    for (const k of ['observations','recommendations','assumptions']) for (const text of value[k] || []) box.append(el('p', '• ' + text));
    const actions = el('div', null, 'ai-actions'), status = el('p', '', 'ai-muted');
    if (artifact.type === 'profile') {
      box.append(el('p', (value.nodes?.length || 0) + ' 个温度节点 · 结束温度 ' + value.end_temp + '°C'));
      const base=binding?.source;
      if(base?.nodes?.length) {
        box.append(el('p','时长 '+base.nodes.at(-1).time+' → '+value.nodes.at(-1).time+' 秒 · 自动结束 '+base.end_temp+' → '+value.end_temp+'°C'));
        const table=el('table',null,'ai-diff'),head=el('tr');
        for(const label of ['时间（秒）','原目标 °C','候选 °C'])head.append(el('th',label));table.append(head);
        for(const point of value.nodes){const row=el('tr'),old=base.nodes.find(n=>n.time===point.time);for(const text of [point.time,old?.temperature??'—',point.temperature])row.append(el('td',String(text)));table.append(row);}box.append(table);
      }
      if (!window.RoasterEditor) actions.append(button(binding?.source?.id?'打开源曲线副本比较':'作为新曲线比较',()=>{
        sessionStorage.setItem('roaster.ai.openCandidate',JSON.stringify({artifact_id:artifact.id,source:binding?.source||null,locked_until:binding?.locked_until??null}));
        location.href='/editor.html?ai=1'+(binding?.source?.id?'&profile_id='+encodeURIComponent(binding.source.id):'');
      }));
      async function doPreview() {
        const editor = window.RoasterEditor;
        if (!editor || !binding?.draft) throw Error('请回到生成候选时的曲线编辑器重新分析');
        if (JSON.stringify(editor.getDraft()) !== binding.draft) throw Error('草稿已变更，请重新生成候选');
        const check = await business('/api/v1/analysis/profiles/validate', {profile: value, source: binding.source, locked_until: binding.locked_until});
        if (!check.valid) throw Error(check.errors.join('；'));
        editor.preview(value); status.textContent = '虚线为候选，原草稿尚未修改';
      }
      const preview = button('比较候选', doPreview);
      const adopt = button('确认采用到草稿', async () => {
        await doPreview();
        const editor = window.RoasterEditor;
        if (!editor || !binding?.draft || JSON.stringify(editor.getDraft()) !== binding.draft) throw Error('草稿已变更，请重新生成');
        const check = await business('/api/v1/analysis/profiles/validate', {profile:value,source:binding.source,locked_until:binding.locked_until});
        if (!check.valid) throw Error(check.errors.join('；'));
        if (latestStatus?.state && latestStatus.state !== 'IDLE') throw Error('请在待机时采用控制曲线');
        if (editor.getDraft().end_temp !== value.end_temp && !confirm('候选将改变自动结束温度为 ' + value.end_temp + '°C，确认采用？')) return;
        editor.accept({...value, ai_origin:{provider:activeProfile()?.provider,model:activeProfile()?.model,generated_at:new Date().toISOString()}}, {source:binding.source,locked_until:binding.locked_until});
        adopt.disabled = true; status.textContent = '已采用，可撤销；保存后再手动应用';
      }, 'primary');
      actions.append(preview, adopt, button('放弃候选', () => { window.RoasterEditor?.preview(null); actions.replaceChildren(); status.textContent = '候选已放弃'; }));
    } else if (artifact.type === 'native_profile') {
      if (!artifact.identity && binding?.nativeIdentity) artifact.identity = clone(binding.nativeIdentity);
      actions.append(button('比较原生候选', async () => {
        if (!await prepareNativeArtifact(artifact))return;
        const result = await window.RoasterWorkbenchAI.preview(artifact);
        status.textContent = result?.summary ? (typeof result.summary === 'string' ? result.summary : JSON.stringify(result.summary)) : '已显示原曲线与候选差异';
      }), button('确认采用到原生草稿', async () => {
        if (!await prepareNativeArtifact(artifact))return;
        const result=await window.RoasterWorkbenchAI.accept(artifact);
        status.textContent=result?.accepted?'已采用，可撤销；保存仍需明确操作':'已取消采用，原稿保持不变';
      }, 'primary'), button('放弃候选', () => {window.RoasterWorkbenchAI?.discard(); actions.replaceChildren();status.textContent='候选已放弃';}));
    } else if (value.recommendations?.length && binding?.options?.onDesign) actions.append(button('按建议设计下一锅', () => binding.options.onDesign(value)));
    box.append(actions,status); return box;
  }
  async function prepareNativeArtifact(artifact) {
    if(!window.RoasterWorkbenchAI){
      sessionStorage.setItem('roaster.ai.openNativeCandidate',artifact.id);location.href='/?workspace=workbench';return false;
    }
    if(artifact.identity?.attachment_id){
      const expected=artifact.identity.sha256,file=await rpc('attachments.get',{id:artifact.identity.attachment_id});
      const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0));
      await window.RoasterWorkbench.initialize();document.querySelector('[data-tab="workbench"]')?.click();
      await window.RoasterWorkbench.openFiles([new File([bytes],file.name)]);
      const context=await window.RoasterWorkbenchAI.getContext();
      if(context.identity.sha256!==expected)throw Error('未打开来源附件，候选保持未采用');
      artifact.identity=context.identity;
    }
    return true;
  }
  async function currentContext() {
    if (queuedContext) return clone(queuedContext);
    if (contextBinding?.options) {
      const options = contextBinding.options, context = await options.getContext();
      return {context, source:options.getSource?.() || null, kind:options.kind, draft:options.getDraft ? JSON.stringify(options.getDraft()) : null, locked_until:contextBinding.locked_until, options};
    }
    if ($('tab-workbench')?.classList.contains('active') && window.RoasterWorkbenchAI) {
      const data = await window.RoasterWorkbenchAI.getContext();
      return {context:{native:data.native,native_identity:data.identity},kind:'native',nativeIdentity:data.identity};
    }
    if (window.RoasterEditor) {
      const editor = window.RoasterEditor; await editor.ready; editor.validate();
      const context = await business('/api/v1/analysis/context');
      if(context.status?.state !== 'IDLE') throw Error('请在待机时设计控制曲线');
      return {context:{...context,draft:editor.getSource(),operation:editor.isNew()?'new_curve':'modify_current_draft'},source:editor.getSource(),draft:JSON.stringify(editor.getDraft()),kind:'design'};
    }
    if (currentRecord && $('tab-records')?.classList.contains('active')) return {context:{record:currentRecord,captured_at:new Date().toISOString()},kind:'review'};
    try {
      const context=await business('/api/v1/analysis/context');
      return {context,kind:context.status?.state==='ROASTING'?'live':'chat'};
    }catch{return {context:{},kind:'chat'};}
  }
  async function send(text, binding, retryFrom) {
    if (activeRun) throw Error('请先停止当前回复');
    if (!connected) { show(); access.hidden = false; throw Error('本机 AI 未连接，请在 AI 账户页点击重新连接'); }
    if (!selectedProfile) {openAccountSettings();throw Error('请先连接一个 AI 账户');}
    if(activeProfile()?.can_chat===false){openAccountSettings();throw Error(accountState(activeProfile()));}
    text = (text ?? composer.value).trim(); if (!text && !queuedAttachments.length) return;
    if (queuedAttachments.some(a => a.mime_type?.startsWith('image/')) && !activeProfile()?.vision) {
      const models = await rpc('models',{profile_id:selectedProfile});
      const m = models.find(m => m.id === activeProfile()?.model);
      if (!m?.input?.includes('image') && !m?.vision) throw Error('当前模型不支持图片，请切换到视觉模型或移除图片');
    }
    const selected = binding || await currentContext();
    const savedOptions = selected.options; delete selected.options;
    const id = uid(), requestGeneration = generation;
    if (!conversation) { conversation = await rpc('conversations.create', {profile_id:selectedProfile,title:text.slice(0,32)||'文件分析'}); localStorage.setItem(key('conversation'),conversation.id); }
    runBindings.set(id,{...selected,options:savedOptions,requestHost:host,requestBackend:backend()});
    activeRun = id; transient.set(id,{conversation_id:conversation.id,text:'',artifacts:[]});
    show(); renderMessages(); setStatus('正在回复 · 可随时停止');
    try {
      const params = {id,conversation_id:conversation.id,revision:conversation.revision,profile_id:selectedProfile,prompt:text||'请分析选入的文件',context:selected.context||{},source:selected.source,kind:selected.kind||'chat',attachments:queuedAttachments.map(a=>a.id),locked_until:selected.locked_until,retry_from:retryFrom||composer.dataset.retryFrom};
      const response = await rpc('runs.start',params);
      if (requestGeneration !== generation) return;
      activeRun = response.id || id;
      composer.value = ''; delete composer.dataset.retryFrom; queuedAttachments=[];queuedContext=null;renderQueued();
      conversation = await rpc('conversations.get',{id:conversation.id}); renderMessages();
    } catch(error) {activeRun=null;transient.delete(id);renderMessages();throw error;}
  }
  async function cancelRun(id) {
    return rpc('runs.cancel',{id});
  }
  async function stop() { if(activeRun) {await cancelRun(activeRun);activeRun=null;renderMessages();setStatus('已停止，原稿保持不变');} }
  async function replay(id) {
    const result = await rpc('runs.events',{id,after_sequence:sequences.get(id)||0});
    for(const event of Array.isArray(result)?result:result.events||[]) await onEvent(event);
  }
  async function onEvent(event) {
    if (!event || !event.type || ['result'].includes(event.type)) return;
    const id=event.id||event.request_id, type=event.type, data=event.data;
    if(event.sequence) {if(event.sequence <= (sequences.get(id)||0))return;sequences.set(id,event.sequence);}
    if(type.startsWith('auth_') || (id===loginId && type==='error')) {authEvent(event);return;}
    if(type==='replay_required'){if(activeRun)await replay(activeRun);return;}
    if(type==='pairing_required'){connected=false;access.hidden=false;setStatus(data?.message||'需要重新配对 AI 服务');return;}
    if(type==='host_error'){activeRun=null;setStatus(data?.message||'AI 服务已停止，可重新连接');renderMessages();return;}
    if(type==='text'||type==='text_delta') {
      const item=transient.get(id)||{conversation_id:event.conversation_id,text:'',artifacts:[]};item.text+=typeof data==='string'?data:data?.delta||'';transient.set(id,item);renderMessages();
    } else if(type==='artifact') {
      const item=transient.get(id)||{conversation_id:event.conversation_id,text:'',artifacts:[]};
      const artifact=clone(data), binding=runBindings.get(id);
      if(artifact.type==='native_profile'&&binding?.nativeIdentity)artifact.identity=clone(binding.nativeIdentity);
      item.artifacts.push(artifact);transient.set(id,item);renderMessages();
    } else if(type==='tool_request') {
      try {
        if(data?.name!=='native_samples')throw Error('工具不在允许列表');
        let value;
        if(data.identity?.attachment_id){
          const file=await rpc('attachments.get',{id:data.identity.attachment_id});
          const args=data.arguments||{};
          value=await nativeRequest({action:'analysis_samples',document:{kind:file.name.toLowerCase().endsWith('.klog')?'log':'profile',name:file.name,data:file.data},channel:args.channel,from:args.from,to:args.to,limit:args.limit||600});
          if(value.identity.sha256!==data.identity.sha256)throw Error('来源附件已变化，请重新分析');
          value.identity=data.identity;
        }else{
          if(!window.RoasterWorkbenchAI?.getSamples)throw Error('原生采样当前不可用，请在原生工作台打开该文档');
          if(JSON.stringify(window.RoasterWorkbenchAI.getIdentity())!==JSON.stringify(data.identity))throw Error('原生文档已变化，请重新分析');
          value=await window.RoasterWorkbenchAI.getSamples(data.arguments||{});
        }
        await rpc('tools.respond',{tool_request_id:data.tool_request_id,value});
      }catch(error){await rpc('tools.respond',{tool_request_id:data.tool_request_id,error:error.message});}
    } else if(type==='tool_start') setStatus('工具执行中 · '+(data?.name||data?.tool||'分析数据'));
    else if(type==='context_compacted') setStatus('较早上下文已压缩，完整消息仍保留');
    else if(type==='thinking') setStatus('正在思考…');
    else if(type==='usage') setStatus('用量 '+((data?.input||0)+(data?.output||0))+' tokens'+(activeProfile()?.mode==='subscription'?' · 订阅渠道':''));
    else if(type==='message') {
      const message=data?.message||data;
      if(conversation&&event.conversation_id===conversation.id && message?.role) {
        const index=conversation.messages.findIndex(m=>m.id===message.id);
        if(index<0)conversation.messages.push(message);else conversation.messages[index]=message;
        if(message.role==='assistant')transient.delete(id);renderMessages();
      }
    } else if(['done','error','cancelled'].includes(type)) {
      if(activeRun===id)activeRun=null;
      const item=transient.get(id);
      if(type==='error'&&item?.text) {item.text+='\n\n回复中断，可重试。';}
      else transient.delete(id);
      if(connected&&conversation?.id&&(!event.conversation_id||event.conversation_id===conversation.id)) {
        try {conversation=await rpc('conversations.get',{id:conversation.id});renderMessages();conversations=await rpc('conversations.list');renderHistory();}catch{}
      }
      renderMessages();
      if(type==='error')setStatus(typeof data==='string'?data:data?.message||'回复失败，可重试');
      else if(type==='cancelled')setStatus('已停止');
    }
  }
  function connectEvents() {
    // One transport owns WebSocket reconnect, native events and replay cursors.
  }
  function syncEditorConversation() {
    const editor=document.querySelector('.editor-app');if(!editor||!panel)return;
    const modal=!panel.hidden&&(innerWidth<1280||panel.classList.contains('ai-chat-expanded'));
    editor.inert=modal;
    if(modal){panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');}
    else {panel.removeAttribute('role');panel.removeAttribute('aria-modal');}
  }
  function show() {if(!panel)return;panel.hidden=false;$('ai-launcher').setAttribute('aria-expanded','true');syncEditorConversation();composer?.focus({preventScroll:true});}
  function hide() {panel.hidden=true;syncEditorConversation();const launch=$('ai-launcher');launch.setAttribute('aria-expanded','false');(launch.offsetParent?launch:document.querySelector('.ai-settings-chat'))?.focus();}
  function renderQueued() {
    const target=$('ai-queued');if(!target)return;target.replaceChildren();
    if(queuedContext)target.append(button('已选数据 · 移除',()=>{queuedContext=null;contextBinding=null;renderQueued();}));
    else if(contextBinding?.options)target.append(button(contextBinding.options.title+' · 移除',()=>{contextBinding=null;renderQueued();}));
    else target.append(button(window.RoasterEditor?'当前曲线草稿 · 点击仅聊天':$('tab-workbench')?.classList.contains('active')?'当前原生文件 · 点击仅聊天':currentRecord&&$('tab-records')?.classList.contains('active')?'当前记录 · 点击仅聊天':'当前设备快照 · 点击仅聊天',()=>{queuedContext={context:{},kind:'chat'};renderQueued();}));
    for(const a of queuedAttachments)target.append(button((a.name||'附件')+' ×',async()=>{queuedAttachments=queuedAttachments.filter(v=>v.id!==a.id);await rpc('attachments.delete',{id:a.id});renderQueued();}));
  }
  async function attach(files) {
    for(const file of files) {
      if(file.size>8*1024*1024)throw Error('单个附件最多 8 MiB');
      if(queuedAttachments.reduce((s,a)=>s+(a.size||0),0)+file.size>32*1024*1024)throw Error('本轮附件合计最多 32 MiB');
      const image=['image/png','image/jpeg','image/webp'].includes(file.type), ext=file.name.split('.').pop().toLowerCase();
      if(!image&&!['kpro','klog'].includes(ext))throw Error('请选择 PNG/JPEG/WebP 图片或 .kpro/.klog 文件');
      const data=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=no;r.readAsDataURL(file);});
      let nativeContext;
      if(!image){const result=await nativeRequest({action:'analysis_context',document:{kind:ext==='kpro'?'profile':'log',name:file.name,data}});nativeContext=result.native||result.context||result;}
      const saved=await rpc('attachments.add',{name:file.name,mime_type:image?file.type:'application/x-'+ext,data,context:nativeContext});
      queuedAttachments.push({...saved,name:file.name,size:file.size,mime_type:image?file.type:'application/x-'+ext});
      if(nativeContext)queuedContext={context:{native:nativeContext,native_identity:{...nativeContext.identity,attachment_id:saved.id}},kind:'native'};
    }
    renderQueued();setStatus('附件已加入，发送后由所选渠道处理');
  }
  async function selectBusiness() {
    const box=$('ai-context-picker');box.hidden=!box.hidden;if(box.hidden)return;
    box.replaceChildren(el('h4','选入曲线或记录'));
    const [curveList,recordList]=await Promise.all([business('/api/v1/profiles'),business('/api/v1/records?limit=50')]);
    for(const p of Array.isArray(curveList)?curveList:curveList.profiles||[])box.append(button('曲线 · '+p.name,async()=>{const context=await business('/api/v1/analysis/context');queuedContext={context:{...context,draft:p,operation:'modify_current_draft'},source:p,kind:context.status?.state==='ROASTING'?'live':'chat'};contextBinding=null;box.hidden=true;renderQueued();}));
    for(const r of Array.isArray(recordList)?recordList:recordList.records||[])box.append(button('记录 · '+(r.display_name||r.session_id),async()=>{const record=await business('/api/v1/records/'+encodeURIComponent(r.session_id));queuedContext={context:{record,captured_at:new Date().toISOString()},kind:'review'};contextBinding=null;box.hidden=true;renderQueued();}));
  }
  function field(name,label,type='text',parent=configForm) {
    const wrapper=el('label',null,'ai-field');wrapper.append(el('span',label));
    const input=el(type==='textarea'?'textarea':type==='select'?'select':'input');
    if(type!=='textarea'&&type!=='select')input.type=type;
    input.name=name;input.setAttribute('aria-label',label);wrapper.append(input);parent.append(wrapper);return input;
  }
  function option(select,value,text) {const o=el('option',text);o.value=value;select.append(o);}
  async function loadSettings() {
    if(!configForm)return;
    const list=$('ai-config-list');list.replaceChildren();
    for(const p of profiles) {const b=button('',()=>{selectedProfile=p.id;updateSelect();loadSettings();},'ai-account-row');b.append(el('strong',p.name||p.provider),el('span',accountState(p)));b.setAttribute('aria-pressed',String(p.id===selectedProfile));list.append(b);}
    list.closest('.ai-accounts-layout').dataset.hasAccounts=String(profiles.length>0);
    const result=await rpc('providers');providers=Array.isArray(result)?result:result.providers||[];
    editProfile(profiles.find(p=>p.id===selectedProfile)||null);
    settingsStatus.textContent=window.ROASTER_DEBUG?'账户与历史自动保存在这台电脑，网页与调试桌面共用':desktop?'账户与历史自动保存在这台电脑':'账户与历史自动保存在当前服务所在设备';
  }
  function accountState(p) {
    if(p.login_id)return '正在等待官方授权';
    if(p.catalog_status==='loading')return '正在加载账户可用模型';
    if(p.catalog_status==='auth_required')return '授权已失效，请重新登录';
    if(p.catalog_status==='error')return p.catalog_error||'模型加载失败，请重试';
    if(p.catalog_status==='empty')return '此账户暂时没有可用模型';
    if(p.needs_model_choice)return '原模型已不可用，请重新选择';
    if(p.can_chat===true || p.can_chat===undefined&&p.model&&p.configured)return '可以开始对话';
    if(p.authenticated)return '登录已保存，请加载模型';
    return p.provider==='anthropic'&&p.mode==='subscription'?'需要连接官方 Claude Code':'需要登录或连接账户';
  }
  function openAccountSettings(){
    if(window.RoasterSettings){hide();window.RoasterSettings.open('ai');return;}
    const main=document.querySelector('.tab-btn[data-tab="settings"]');
    if(main){main.click();hide();return;}
    show();$('ai-inline-settings').hidden=false;
    if(!configForm){const grid=el('div',null,'settings-grid');$('ai-inline-settings').append(grid);mountSettings();if(connected)loadSettings().catch(fail);}
  }
  async function saveModel(p,model){
    if(!model)return;
    await rpc('profiles.save',{profile:{id:p.id,model}});profiles=await rpc('profiles.list');updateSelect();
    if(settingsStatus)settingsStatus.textContent='已记住所选模型';
  }
  async function loginAccount(p){
    selectedProfile=p.id;updateSelect();openedAuthUrls.clear();authBox.replaceChildren();
    // Register before the RPC: auth events may arrive before its reply.
    loginId=uid();
    const pending=el('p','正在准备官方授权页面…','ai-status');pending.setAttribute('role','status');
    authBox.append(pending,button('取消登录',async()=>{const id=loginId;if(id)await rpc('auth.cancel',{id});loginId=null;authBox.replaceChildren();await refresh();await loadSettings();}));
    authBox.scrollIntoView({block:'nearest'});
    try {await rpc('auth.login',{id:loginId,profile_id:p.id,login_method:p.provider==='anthropic'?'official_cli':p.provider==='openai'?'browser':'device_code'});}
    catch(error){loginId=null;authBox.replaceChildren();throw error;}
  }
  async function addAccount(provider,mode='subscription',extra={},apiKey){
    const saved=await rpc('profiles.save',{profile:{mode,provider,...extra},api_key:apiKey||undefined});
    selectedProfile=saved.id;await refresh();await loadSettings();
    if(mode==='subscription')await loginAccount(saved);
    else {await rpc('models',{profile_id:saved.id,refresh:true});await refresh();await loadSettings();}
  }
  function addAccountView(){
    configForm.replaceChildren();delete configForm.dataset.profileId;if(!loginId)authBox.replaceChildren();
    configForm.append(el('h4','添加连接'),el('p','连接本地模型，或登录已有订阅账户。','ai-account-state'));
    const local=el('section',null,'ai-connection-section');local.append(el('h5','本地模型'));
    const localGrid=el('div',null,'ai-config-grid');
    const localUrl=field('local_url','本地接口地址','url',localGrid);localUrl.value='http://127.0.0.1:1234/v1';localUrl.placeholder='http://127.0.0.1:11434/v1';
    const localProtocol=field('local_protocol','接口协议','select',localGrid);for(const [id,label]of [['openai-completions','OpenAI 兼容'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic Messages']])option(localProtocol,id,label);
    const localConnect=button('连接本地模型',async()=>{localConnect.disabled=true;try{await addAccount('custom','custom',{name:'本地模型',base_url:localUrl.value.trim(),protocol:localProtocol.value});}finally{localConnect.disabled=false;}},'primary');
    local.append(localGrid,el('p','支持 LM Studio、Ollama 等兼容接口；模型从本地服务加载。','ai-muted'),localConnect);configForm.append(local);
    const subscriptions=el('section',null,'ai-connection-section');subscriptions.append(el('h5','订阅登录'));
    const primary=el('div',null,'ai-provider-picker');
    for(const [id,label]of [['openai','使用 ChatGPT 登录'],['anthropic','连接 Claude Code'],['kimi-coding','使用 Kimi Code 登录']])primary.append(button(label,()=>addAccount(id)));
    subscriptions.append(primary);configForm.append(subscriptions);
    const more=el('details',null,'ai-account-management');more.append(el('summary','其他订阅与 API'));const moreBody=el('div',null,'ai-disclosure-body'),choices=el('div',null,'ai-provider-picker');
    for(const [id,label]of [['github-copilot','GitHub Copilot 订阅'],['xai','xAI 订阅']])choices.append(button(label,()=>addAccount(id)));
    const manual=el('div',null,'ai-config-grid');
    const service=field('provider','API 服务','select',manual);for(const p of providers.filter(p=>p.api_key!==false))option(service,p.id,p.name||p.id);option(service,'custom','自定义接口');
    const secret=field('api_key','API Key','password',manual);secret.autocomplete='new-password';
    const base=field('base_url','自定义接口地址','url',manual);base.placeholder='http://127.0.0.1:1234/v1';base.closest('label').hidden=true;
    const protocol=field('protocol','接口协议','select',manual);for(const [id,label]of [['openai-completions','OpenAI Chat Completions'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic Messages']])option(protocol,id,label);protocol.closest('label').hidden=true;
    service.onchange=()=>{base.closest('label').hidden=protocol.closest('label').hidden=service.value!=='custom';};
    const connect=button('连接并加载模型',async()=>{connect.disabled=true;try{await addAccount(service.value,service.value==='custom'?'custom':'api_key',{base_url:base.value.trim(),protocol:protocol.value},secret.value);}finally{secret.value='';connect.disabled=false;}},'primary');
    moreBody.append(choices,manual,connect);more.append(moreBody);configForm.append(more);
  }
  function editProfile(p) {
    configForm.replaceChildren();if(!loginId)authBox.replaceChildren();
    if(!p){addAccountView();return;}
    configForm.dataset.profileId=p.id;
    configForm.append(el('h4',p.name||p.provider),el('p',accountState(p),'ai-account-state'));
    if(p.authenticated&&p.catalog_status!=='auth_required')configForm.append(el('p','登录状态已安全保存，再次打开会自动恢复。','ai-account-state'));
    if(p.provider==='anthropic'&&p.mode==='subscription'){
      const note=el('p','使用官方 Claude Code 2.1.248 或更新版本，订阅登录由官方客户端管理。','ai-account-state');
      const guide=el('a','安装或更新 Claude Code');guide.href='https://code.claude.com/docs/en/setup';guide.target='_blank';guide.rel='noopener noreferrer';configForm.append(note,guide);
    }
    const models=field('model','默认模型','select',configForm);models.closest('label').classList.add('ai-account-model');
    for(const m of p.catalog||[])option(models,m.id,m.name||m.id);
    if(!models.options.length)option(models,p.model||'',p.model_name||p.model||'登录后自动加载');
    if(p.needs_model_choice)option(models,'','请选择可用模型');models.value=p.model||'';
    models.disabled=!p.authenticated&&!p.configured||!p.catalog?.length;
    models.onchange=async()=>{models.disabled=true;try{await saveModel(p,models.value);await loadSettings();}catch(error){fail(error);}finally{models.disabled=false;}};
    const actions=el('div',null,'ai-actions');configForm.append(actions);
    if(p.mode==='subscription'&&(!p.authenticated||p.catalog_status==='auth_required'))actions.append(button(p.provider==='anthropic'?'连接官方 Claude Code':'登录账户',()=>loginAccount(p),'primary'));
    else if(p.can_chat!==false)actions.append(button('开始对话',()=>{show();composer.focus();},'primary'));
    const reload=async()=>{settingsStatus.textContent='正在加载账户可用模型…';try{await rpc('models',{profile_id:p.id,refresh:true});}finally{await refresh();await loadSettings();}};
    if(p.authenticated||p.configured)actions.append(button(p.catalog_status==='error'?'重试加载模型':'刷新模型',reload));
    if(p.model&&p.configured){const test=button('检查对话',async()=>{test.disabled=true;settingsStatus.textContent='正在发送一条简短消息检查连接…';try{const result=await rpc('test',{profile_id:p.id});settingsStatus.textContent=result.text||'对话检查成功';}finally{test.disabled=false;}});test.title='发送一条简短消息，使用当前渠道额度';actions.append(test);}
    const advanced=el('details',null,'ai-account-management');advanced.append(el('summary','高级参数'));const advancedBody=el('div',null,'ai-disclosure-body'),advancedGrid=el('div',null,'ai-config-grid');
    const max=field('max_tokens','回复长度上限','number',advancedGrid);max.min='1';max.max=String(p.context_window);max.value=p.max_tokens;
    const thinking=field('reasoning','思考强度','select',advancedGrid);for(const [value,label]of [['','默认'],['low','简短'],['medium','平衡'],['high','深入']])option(thinking,value,label);thinking.value=typeof p.reasoning==='string'?p.reasoning:'';
    const headers=p.mode==='custom'?field('headers','自定义请求头（JSON）','textarea',advancedGrid):null;if(headers)headers.placeholder='留空保留原有请求头';
    const replacement=p.mode!=='subscription'?field('api_key','更新 API Key（留空保留）','password',advancedGrid):null;
    advancedBody.append(advancedGrid,button('保存高级参数',async()=>{const value={id:p.id,max_tokens:Number(max.value),reasoning:thinking.value||false};if(headers?.value.trim())value.headers=JSON.parse(headers.value);await rpc('profiles.save',{profile:value,api_key:replacement?.value||undefined});if(replacement)replacement.value='';if(headers)headers.value='';await refresh();await loadSettings();settingsStatus.textContent='高级参数已保存';}));advanced.append(advancedBody);configForm.append(advanced);
    const management=el('details',null,'ai-account-management');management.append(el('summary','账户管理'));const controls=el('div',null,'ai-actions');
    if(p.mode==='subscription')controls.append(button('断开此连接',async()=>{if(!await confirmAction(p.provider==='anthropic'?'断开本软件的 Claude 连接？官方客户端登录保持，历史保留。':'退出此 AI 账户？历史会话保留。'))return;await rpc('auth.logout',{profile_id:p.id});await refresh();await loadSettings();}));
    controls.append(button('移除账户',async()=>{if(!await confirmAction('移除此账户与本软件保存的相应凭据？聊天历史保留；Claude Code 的官方登录由其自行管理。'))return;await rpc('profiles.delete',{id:p.id});await refresh();await loadSettings();},'danger'));management.append(controls);configForm.append(management);
    if(p.login_id&&!loginId){loginId=p.login_id;authBox.append(el('p','官方授权仍在进行。'),button('取消授权',async()=>{await rpc('auth.cancel',{id:loginId});loginId=null;await refresh();await loadSettings();}));}
    // Existing API connections load their selectable catalog once, without creating another account.
    if(p.mode==='api_key'&&p.configured&&!p.catalog_status)rpc('models',{profile_id:p.id}).then(async()=>{profiles=await rpc('profiles.list');updateSelect();if(selectedProfile===p.id)await loadSettings();}).catch(fail);
  }
  const confirmAction=message=>window.RoasterUI?.confirm?window.RoasterUI.confirm(message):Promise.resolve(confirm(message));
  function safeAuthUrl(value) {
    try {const url=new URL(value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return null;if(url.username||url.password)return null;return url.href;}catch{return null;}
  }
  async function openAuthPage(url,status) {
    try {
      if(desktop)await native.invoke('ai_open_external',{url});
      else {const page=window.open('about:blank','_blank');if(!page)throw Error('浏览器拦截了自动打开，请点击“打开官方授权页面”或复制地址');page.opener=null;page.location.replace(url);}
      if(status)status.textContent='已请求打开浏览器，请在官方页面完成授权。';
    }catch(error){if(status)status.textContent=error?.message||String(error);else throw error;}
  }
  function authEvent(event) {
    if(!authBox)return;
    if(!loginId)loginId=event.id;
    if(event.id!==loginId)return;
    const d=event.data||{};
    if(event.type==='auth_notify') {
      if(d.message)authBox.append(el('p',d.message));
      if(d.instructions)authBox.append(el('p',d.instructions));
      const url=safeAuthUrl(d.verificationUriComplete||d.verification_uri_complete||d.url||d.verificationUri||d.verification_uri);
      if(url&&!authBox.querySelector('[data-auth-url]')){
        const actions=el('div',null,'ai-actions');actions.dataset.authUrl='true';
        const status=el('p','正在打开默认浏览器…','ai-status');status.setAttribute('role','status');
        actions.append(button('打开官方授权页面',()=>openAuthPage(url,status),'primary'),button('复制授权地址',async()=>{await navigator.clipboard.writeText(url);status.textContent='授权地址已复制，可粘贴到浏览器打开';}));
        authBox.append(actions,status);
        const token=event.id+'|'+url;if(!openedAuthUrls.has(token)){openedAuthUrls.add(token);void openAuthPage(url,status);}
      }
      const code=d.userCode||d.user_code;if(code){const row=el('div',null,'ai-device-code');row.append(el('span','设备码'),el('code',code),button('复制设备码',async()=>{await navigator.clipboard.writeText(code);settingsStatus.textContent='设备码已复制';}));authBox.append(row);}
    }else if(event.type==='auth_prompt') {
      const wrap=el('div',null,'ai-auth-prompt');wrap.append(el('p',d.message||'请完成授权'));
      const input=el(d.type==='select'?'select':'input');if(d.type!=='select')input.type=d.type==='secret'?'password':'text';input.setAttribute('aria-label',d.message||'授权信息');
      for(const o of d.options||[])option(input,o.value||o.id||o,o.label||o.name||o);
      wrap.append(input,button('提交授权信息',async()=>{await rpc('auth.respond',{id:loginId,prompt_id:d.prompt_id||d.id,value:input.value});input.value='';wrap.remove();}));authBox.append(wrap);input.focus();
    }else if(event.type==='auth_done') {loginId=null;authBox.replaceChildren(el('p',d.can_chat?'账户已连接，模型已自动保存':accountState(d),'ai-status'));refresh().then(loadSettings).catch(fail);}
    else if(event.type==='auth_prompt_cancelled'){authBox.replaceChildren(el('p','授权已取消，可以重新登录','ai-status'));}
    else if(event.type==='error'){loginId=null;const message=typeof d==='string'?d:d.message||'登录失败，可重新登录';refresh().then(()=>{if(configForm?.dataset.profileId)editProfile(profiles.find(p=>p.id===configForm.dataset.profileId));authBox.append(el('p',message,'ai-status'));settingsStatus.textContent=message;}).catch(fail);}
  }
  function mountSettings() {
    const grid=document.querySelector('.settings-grid');if(!grid)return;
    settingsCard=el('section',null,'settings-card settings-card-wide ai-settings');settingsCard.dataset.settingsGroup='ai';grid.prepend(settingsCard);
    const heading=el('div',null,'settings-card-heading'),icon=el('i',null,'ph ph-waveform');icon.setAttribute('aria-hidden','true');
    const title=el('div');title.append(el('h3','本机 AI'),el('p','账户配置与对话记录保存在本机。'));
    const headingActions=el('div',null,'ai-settings-heading-actions');headingActions.append(button('AI 对话',show,'ai-settings-chat'),button('添加账户',addAccountView,'primary'));heading.append(icon,title,headingActions);settingsCard.append(heading);
    const layout=el('div',null,'ai-accounts-layout');settingsCard.append(layout);
    const list=el('div',null,'ai-config-list');list.id='ai-config-list';list.setAttribute('aria-label','已连接账户');layout.append(list);
    const detail=el('div',null,'ai-account-detail');layout.append(detail);
    configForm=el('div',null,'ai-config-form');detail.append(configForm);
    authBox=el('section',null,'ai-auth');authBox.setAttribute('aria-label','订阅授权进度');detail.append(authBox);
    const connection=el('footer',null,'ai-local-status');
    settingsStatus=el('p','正在连接本机 AI…','ai-status');settingsStatus.setAttribute('role','status');
    connection.append(settingsStatus,button('重新连接',async()=>{await refresh();await loadSettings();}));detail.append(connection);
  }
  function mountContext(target,options) {
    if(!target)return null;
    target.replaceChildren();const details=el('details',null,'ai-panel');details.open=!!options.open;details.append(el('summary',options.title||'AI 烘焙助手'));
    const body=el('div',null,'ai-panel-body'),label=el('label',null,'ai-field');label.append(el('span','你的要求'));const prompt=el('textarea');prompt.rows=2;prompt.placeholder='把当前数据带入完整 AI 对话';label.append(prompt);
    const status=el('p','可在全局对话中继续追问','ai-status');status.setAttribute('role','status');body.append(label,status);details.append(body);target.append(details);
    let lock,reference;
    if(options.kind==='design') {
      lock=field('locked_until','锁定前段（秒，留空不锁定）','number',body);lock.min='0';lock.step='1';
      reference=field('reference_record','参考历史记录（可选）','select',body);option(reference,'','不添加参考');
      business('/api/v1/records?limit=50').then(records=>{for(const record of records)option(reference,record.session_id,record.display_name||record.session_id);}).catch(()=>{});
    }
    let requestId=null;
    const result={panel:details,body,status,get busy(){return !!requestId&&activeRun===requestId;},invalidate(){if(requestId&&activeRun===requestId)stop().catch(fail);requestId=null;},async analyze(question){
      const context=await options.getContext(),source=options.getSource?.()||null;
      if(reference?.value)context.reference_record=await business('/api/v1/records/'+encodeURIComponent(reference.value));
      const locked_until=lock?.value?Number(lock.value):null;
      if(locked_until!==null&&(!Number.isFinite(locked_until)||locked_until<0))throw Error('请输入有效的锁定秒数');
      const selected={context,source,kind:options.kind,draft:options.getDraft?JSON.stringify(options.getDraft()):null,options,locked_until};
      contextBinding={options,locked_until};renderQueued();
      await send(question||prompt.value|| (options.kind==='design'?'按目标设计曲线，说明调整和资料缺口。':'分析当前快照，给出有数据依据的建议。'),selected);
      requestId=activeRun;
    }};
    body.append(button(options.kind==='design'?'生成／调整曲线':'分析并回复',()=>result.analyze()),button('打开完整对话',()=>{contextBinding={options};show();renderQueued();composer.value=prompt.value;composer.focus();}));
    return result;
  }
  function mount() {
    panel=el('aside',null,'ai-chat');panel.id='ai-chat';panel.hidden=true;panel.setAttribute('aria-label','AI 对话');
    const header=el('header',null,'ai-chat-header'),heading=el('h2','AI 烘焙助手');heading.id='ai-chat-title';const headerActions=el('div',null,'ai-actions');
    headerActions.append(button('会话',()=>{$('ai-history').hidden=!$('ai-history').hidden;}),button('放大',()=>{panel.classList.toggle('ai-chat-expanded');headerActions.children[1].textContent=panel.classList.contains('ai-chat-expanded')?'收起':'放大';syncEditorConversation();}),button('关闭',hide));header.append(heading,headerActions);
    const tools=el('div',null,'ai-chat-tools'),modelLine=el('div',null,'ai-model-line');profileSelect=el('select');profileSelect.id='ai-chat-profile';profileSelect.setAttribute('aria-label','当前 AI 账户');profileSelect.onchange=()=>{selectedProfile=profileSelect.value;updateSelect();setStatus('下一条消息使用所选账户，历史保留');const p=activeProfile();if(p&&!p.catalog?.length&&p.configured)rpc('models',{profile_id:p.id}).then(refresh).catch(fail);};
    modelSelect=el('select');modelSelect.id='ai-chat-model';modelSelect.setAttribute('aria-label','当前 AI 模型');modelSelect.onchange=()=>saveModel(activeProfile(),modelSelect.value).catch(fail);
    modelLine.append(profileSelect,modelSelect);tools.append(modelLine,button('新对话',newConversation),button('账户设置',openAccountSettings));
    const historyBox=el('section',null,'ai-chat-history');historyBox.id='ai-history';historyBox.hidden=true;
    const search=el('input');search.id='ai-history-search';search.type='search';search.placeholder='搜索会话';search.setAttribute('aria-label','搜索历史会话');search.oninput=renderHistory;
    history=el('nav');history.setAttribute('aria-label','历史会话');historyBox.append(search,history,button('重命名当前会话',async()=>{if(!conversation)return;const title=prompt('会话名称',conversation.title||'');if(title?.trim()){conversation=await rpc('conversations.update',{id:conversation.id,revision:conversation.revision,title:title.trim()});await refresh();}}),button('删除当前会话',async()=>{if(!conversation||!confirm('删除当前会话及其附件？'))return;if(activeRun)await stop();await rpc('conversations.delete',{id:conversation.id});conversation=null;localStorage.removeItem(key('conversation'));await refresh();renderMessages();}));
    access=el('section',null,'ai-chat-access');access.append(el('p','本机 AI 尚未连接'),button('连接 AI 账户',openAccountSettings,'primary'),button('重新连接',async()=>{await refresh();await loadSettings();}));
    const inline=el('section',null,'ai-inline-settings');inline.id='ai-inline-settings';inline.hidden=true;
    const clients=el('section',null,'ai-context-picker');clients.id='ai-clients';clients.hidden=true;
    messages=el('div',null,'ai-messages');messages.id='ai-messages';messages.tabIndex=0;messages.setAttribute('aria-label','对话消息');
    info=el('p','正在连接 AI 服务…','ai-status');info.setAttribute('role','status');
    const picker=el('section',null,'ai-context-picker');picker.id='ai-context-picker';picker.hidden=true;
    const inputArea=el('div',null,'ai-composer'),queued=el('div',null,'ai-queued');queued.id='ai-queued';
    const label=el('label',null,'ai-field');label.append(el('span','消息'));composer=el('textarea');composer.id='ai-prompt';composer.rows=3;composer.maxLength=16000;composer.placeholder='提出问题，或描述你希望调整的曲线';label.append(composer);
    const input=el('input');input.type='file';input.multiple=true;input.accept='.kpro,.klog,image/png,image/jpeg,image/webp';input.hidden=true;input.onchange=()=>{attach(input.files).catch(fail);input.value='';};
    const actions=el('div',null,'ai-input-actions');const sendButton=button('发送',()=>send(),'primary');sendButton.id='ai-send';const stopButton=button('停止',stop,'primary');stopButton.id='ai-stop';stopButton.disabled=true;stopButton.hidden=true;
    const attachments=el('details',null,'ai-attachment-menu');attachments.append(el('summary','添加','ctrl-btn'));const attachmentChoices=el('div',null,'ai-attachment-choices');
    attachmentChoices.append(button('文件或图片',()=>{attachments.open=false;input.click();}),button('曲线或记录',()=>{attachments.open=false;return selectBusiness();}),button('当前页面数据',async()=>{attachments.open=false;contextBinding=null;queuedContext=null;queuedContext=await currentContext();renderQueued();setStatus('已选入当前页面数据');}));attachments.append(attachmentChoices);actions.append(attachments,stopButton,sendButton);
    inputArea.append(queued,picker,label,actions,input);
    panel.append(header,tools,historyBox,access,inline,clients,messages,info,inputArea);
    const launch=$('ai-launcher')||button('AI 对话',()=>{});launch.id='ai-launcher';launch.classList.add('ai-launcher');launch.onclick=()=>{if(panel.hidden)show();else hide();};launch.setAttribute('aria-expanded','false');launch.setAttribute('aria-controls','ai-chat');
    document.body.append(panel);if(!launch.parentElement)document.body.append(launch);
    composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send().catch(fail);}});
    composer.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();attach(files).catch(fail);}});
    panel.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();panel.classList.add('ai-dragging');}});
    panel.addEventListener('dragleave',()=>panel.classList.remove('ai-dragging'));
    panel.addEventListener('drop',e=>{e.preventDefault();panel.classList.remove('ai-dragging');attach(e.dataTransfer.files).catch(fail);});
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'){hide();e.stopPropagation();}});
    function fitViewport(){const zoom=Number.parseFloat(getComputedStyle(document.body).zoom)||1;panel.style.setProperty('--ai-view-width',(innerWidth/zoom)+'px');syncEditorConversation();}
    fitViewport();window.addEventListener('resize',fitViewport);new MutationObserver(fitViewport).observe(document.body,{attributes:true,attributeFilter:['style']});
    mountSettings();renderMessages();renderQueued();
    refresh().then(async()=>{
      await loadSettings();
      const pending=sessionStorage.getItem('roaster.ai.openCandidate');
      if(pending&&window.RoasterEditor&&conversation){
        sessionStorage.removeItem('roaster.ai.openCandidate');const intent=JSON.parse(pending),editor=window.RoasterEditor;await editor.ready;
        const message=conversation.messages.find(m=>m.artifacts?.some(a=>a.id===intent.artifact_id));
        if(message){
          if(intent.source&&JSON.stringify({nodes:editor.getSource().nodes,end_temp:editor.getSource().end_temp})!==JSON.stringify({nodes:intent.source.nodes,end_temp:intent.source.end_temp}))throw Error('来源曲线已变化，请重新生成候选');
          runBindings.set(message.run_id,{source:intent.source,locked_until:intent.locked_until,draft:JSON.stringify(editor.getDraft())});renderMessages();show();
        }
      }
      const pendingNative=sessionStorage.getItem('roaster.ai.openNativeCandidate');
      if(pendingNative&&window.RoasterWorkbenchAI&&conversation){
        sessionStorage.removeItem('roaster.ai.openNativeCandidate');
        const artifact=conversation.messages.flatMap(m=>m.artifacts||[]).find(a=>a.id===pendingNative);
        if(artifact&&await prepareNativeArtifact(artifact)){await window.RoasterWorkbenchAI.preview(artifact);renderMessages();show();}
      }
    }).catch(error=>{access.hidden=connected;fail(error);});
  }
  nativeReady=transport.setHost({kind:host,backend:backend()}).then(async()=>{
    // Saved device/remote choices never override the desktop's local AI service.
  });
  transport.listen(event=>onEvent(event).catch(fail));
  window.addEventListener('roaster-status',event=>{latestStatus=event.detail;const binding=runBindings.get(activeRun);if(binding?.kind==='live'&&(latestStatus.state!=='ROASTING'||!latestStatus.connected||binding.context?.status?.session_id!==latestStatus.session_id))stop().catch(fail);});
  window.addEventListener('roaster-disconnected',()=>{if(runBindings.get(activeRun)?.kind==='live')stop().catch(fail);});
  window.addEventListener('roaster-record',event=>{currentRecord=event.detail;});
  if(desktop)document.addEventListener('click',event=>{const link=event.target.closest?.('.ai-chat a[href],.ai-settings a[href]');const url=link&&safeAuthUrl(link.href);if(url){event.preventDefault();native.invoke('ai_open_external',{url}).catch(fail);}});
  window.addEventListener('roaster-ai-open',()=>{contextBinding=null;queuedContext=null;show();currentContext().then(value=>{queuedContext=value;renderQueued();}).catch(fail);});
  window.addEventListener('beforeunload',()=>{if(activeRun&&runBindings.get(activeRun)?.kind==='live')cancelRun(activeRun).catch(()=>{});});
  window.RoasterChat={mountContext,open:show,request:rpc,send,refresh,attach,get current(){return conversation;},get host(){return host;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
