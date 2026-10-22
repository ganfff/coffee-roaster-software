/* Shared chat UI. Business actions remain explicit and validated by their owner. */
(function () {
  'use strict';
  const native = window.RoasterNativeAI;
  const desktop = '__TAURI_INTERNALS__' in window && !!native;
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const uid = () => crypto.randomUUID();
  const clone = value => JSON.parse(JSON.stringify(value));
  const backend = () => desktop ? (localStorage.getItem('roaster.backendUrl') || 'http://localhost:8000') : location.origin;
  let host = desktop && localStorage.getItem('roaster.ai.host') === 'local' ? 'local' : 'backend';
  let panel, messages, history, composer, info, profileSelect, access, settingsCard, configForm;
  let profiles = [], providers = [], conversations = [], conversation = null, activeRun = null;
  let selectedProfile = '', contextBinding = null, queuedAttachments = [], queuedContext = null;
  let currentRecord = null, connected = false, socket = null, reconnectTimer, generation = 0;
  let latestStatus = null, loginId = null, authBox, settingsStatus, abortEvents, nativeReady, eventCursor = 0;
  const sequences = new Map(), transient = new Map(), runBindings = new Map();
  const attachmentViews = new Map();
  const key = suffix => 'roaster.ai.' + host + '.' + backend() + '.' + suffix;
  function button(text, action, cls = '') { const b = el('button', text, 'ctrl-btn ' + cls); b.type = 'button'; b.onclick = () => Promise.resolve().then(action).catch(fail); return b; }
  function fail(error) { const message = error?.message || String(error); if (info) info.textContent = message; if (settingsStatus) settingsStatus.textContent = message; }
  async function jsonFetch(path, options) {
    const response = await fetch(path, {credentials: 'same-origin', ...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(typeof body.detail === 'string' ? body.detail : body.error?.message || body.error || 'AI 请求失败（' + response.status + '）');
    return body;
  }
  async function rpc(method, params = {}) {
    if (desktop) {
      await nativeReady;
      return native.invoke(host === 'local' ? 'ai_rpc' : 'ai_remote_rpc', host === 'local' ? {method, params} : {backend: backend(), method, params});
    }
    return jsonFetch('/api/v1/ai/rpc', {method: 'POST', keepalive:method==='runs.cancel', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method, params})});
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
    for (const p of profiles) { const o = el('option', (p.name || p.provider) + ' · ' + (p.model || '请选择模型') + (p.mode === 'subscription' ? ' · 订阅' : '')); o.value = p.id; profileSelect.append(o); }
    if (!profiles.some(p => p.id === selectedProfile)) selectedProfile = profiles[0]?.id || '';
    profileSelect.value = selectedProfile;
    profileSelect.disabled = !!activeRun || !profiles.length;
  }
  async function refresh() {
    profiles = await rpc('profiles.list');
    conversations = await rpc('conversations.list');
    profiles = Array.isArray(profiles) ? profiles : profiles.profiles || [];
    conversations = Array.isArray(conversations) ? conversations : conversations.conversations || [];
    connected = true; access.hidden = true;
    updateSelect(); renderHistory();
    const saved = conversation?.id || localStorage.getItem(key('conversation'));
    if (saved && conversations.some(c => c.id === saved)) await loadConversation(saved);
    setStatus(host === 'local' ? '本机 AI · 可独立于设备使用' : '设备共享 AI · 已配对客户端可查看会话');
    if (!desktop) connectEvents();
  }
  async function loadConversation(id) {
    conversation = await rpc('conversations.get', {id});
    localStorage.setItem(key('conversation'), id);
    selectedProfile = conversation.profile_id || selectedProfile;
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
    $('ai-stop').disabled = !activeRun; $('ai-send').disabled = !!activeRun;
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
    if (!connected) { show(); access.hidden = false; throw Error('请先配对 AI 服务或选择本机模式'); }
    if (!selectedProfile) throw Error('请先在 AI 配置中保存渠道和模型');
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
    const binding=runBindings.get(id);
    if(desktop&&binding?.requestHost==='backend')return native.invoke('ai_remote_rpc',{backend:binding.requestBackend,method:'runs.cancel',params:{id}});
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
    if(desktop||socket||!connected)return;
    const url=new URL('/api/v1/ai/ws',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('after',String(eventCursor));
    try {
      const ws=new WebSocket(url);socket=ws;
      ws.onmessage=e=>{try{const value=JSON.parse(e.data);eventCursor=value.cursor??eventCursor;for(const event of value.events||[value])onEvent(event).catch(fail);if(value.replay_required&&activeRun)replay(activeRun).catch(fail);}catch{}};
      ws.onopen=()=>{if(activeRun)replay(activeRun).catch(fail);};
      ws.onclose=event=>{socket=null;if([4401,4403].includes(event.code)){connected=false;access.hidden=false;setStatus('AI 配对已失效，请重新配对');return;}if(connected)reconnectTimer=setTimeout(connectEvents,2000);};
      ws.onerror=()=>ws.close();
    }catch(error){fail(error);}
  }
  function show() {if(!panel)return;panel.hidden=false;$('ai-launcher').setAttribute('aria-expanded','true');}
  function hide() {panel.hidden=true;$('ai-launcher').setAttribute('aria-expanded','false');$('ai-launcher').focus();}
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
  async function pair(code,name) {
    if(!code.trim())throw Error('请输入设备端显示的配对码');
    if(desktop)await native.invoke('ai_remote_pair',{backend:backend(),code:code.trim(),name:name||'Windows 桌面'});
    else await jsonFetch('/api/v1/ai/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.trim(),name:name||'网页客户端'})});
    await refresh(); if(configForm)await loadSettings();
  }
  function pairingUi(parent) {
    parent.append(el('h4','连接设备共享 AI'),el('p','在设备本机运行 AI 配对码命令，再将显示的配对码填入这里。','ai-muted'));
    parent.append(button('复制配对命令',()=>navigator.clipboard.writeText('python -m src.ai pair-code')));
    const label=el('label',null,'ai-field');label.append(el('span','配对码'));const input=el('input');input.autocomplete='one-time-code';input.inputMode='numeric';label.append(input);
    parent.append(label,button('配对并连接',()=>pair(input.value),'primary'));
  }
  function field(name,label,type='text',parent=configForm) {
    const wrapper=el('label',null,'ai-field');wrapper.append(el('span',label));
    const input=el(type==='textarea'?'textarea':type==='select'?'select':'input');
    if(type!=='textarea'&&type!=='select')input.type=type;
    input.name=name;wrapper.append(input);parent.append(wrapper);return input;
  }
  function option(select,value,text) {const o=el('option',text);o.value=value;select.append(o);}
  async function loadSettings() {
    if(!configForm)return;
    const list=$('ai-config-list');list.replaceChildren();
    for(const p of profiles) {const b=button((p.name||p.provider)+' · '+(p.mode==='subscription'?'订阅':p.mode==='custom'?'自定义':'API Key'),()=>editProfile(p));list.append(b);}
    const result=await rpc('providers');providers=Array.isArray(result)?result:result.providers||[];
    editProfile(profiles.find(p=>p.id===selectedProfile)||null);
    settingsStatus.textContent=host==='local'?'配置保存在本机':'设备共享配置 · 已配对客户端共用账号及会话';
  }
  function editProfile(p) {
    configForm.replaceChildren();if(!loginId)authBox.replaceChildren();
    if(p?.login_id&&!loginId){loginId=p.login_id;authBox.append(el('p','此渠道的授权仍在进行；可取消后重新登录。'),button('取消正在进行的授权',()=>rpc('auth.cancel',{id:loginId})));}
    configForm.dataset.profileId=p?.id||'';
    let mode=p?.mode||'subscription';
    const modeTabs=el('div',null,'ai-mode-tabs');modeTabs.setAttribute('role','group');modeTabs.setAttribute('aria-label','AI 认证方式');
    configForm.append(modeTabs);let fields;
    for(const [value,label] of [['subscription','订阅登录'],['api_key','API Key'],['custom','自定义配置']]) {
      const b=button(label,()=>{if(mode!==value)configForm.dataset.profileId='';mode=value;for(const child of modeTabs.children)child.setAttribute('aria-pressed',String(child===b));drawFields(null);});
      b.setAttribute('aria-pressed',String(value===mode));modeTabs.append(b);
    }
    const grid=el('div',null,'ai-config-grid');configForm.append(grid);
    const actions=el('div',null,'ai-actions');configForm.append(actions);
    function drawFields(profile) {
      grid.replaceChildren();actions.replaceChildren();
      const name=field('name','配置名称','text',grid),provider=field('provider','供应商','select',grid),model=field('model','模型 ID','text',grid);
      name.value=profile?.name||'';model.value=profile?.model||'';
      const list=el('datalist');list.id='ai-model-options';model.setAttribute('list',list.id);grid.append(list);
      const available=mode==='custom'?[{id:'custom',name:'自建 / 本地服务'}]:providers.filter(v=>mode==='subscription'?(v.subscription||['openai','anthropic','github-copilot','kimi-coding','xai'].includes(v.id)):v.api_key!==false);
      for(const v of available)option(provider,v.id,v.name||v.id);
      provider.value=profile?.provider||available[0]?.id||'';
      let method,base,protocol,secret;
      if(mode==='subscription') {
        method=field('login_method','登录方式','select',grid);
        function loginMethods() {
          method.replaceChildren();const v=providers.find(p=>p.id===provider.value);
          const methods=v?.login_methods||v?.methods||[];
          if(!methods.length)option(method,'oauth','按供应商流程授权');
          else for(const m of methods)option(method,m.id||m.value||m, m.name||m.label||m);
        }
        provider.onchange=()=>{model.value='';loginMethods();};loginMethods();
      } else {secret=field('api_key','API Key（留空保留已有密钥）','password',grid);secret.autocomplete='new-password';}
      if(mode==='custom') {
        base=field('base_url','API 根地址','url',grid);base.value=profile?.base_url||'';base.placeholder='http://127.0.0.1:1234/v1';
        protocol=field('protocol','接口协议','select',grid);for(const [id,label]of[['openai-completions','OpenAI Chat Completions'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic Messages']])option(protocol,id,label);protocol.value=profile?.protocol||'openai-completions';
      }
      const advanced=el('details',null,'ai-advanced');advanced.append(el('summary','高级参数'));grid.append(advanced);
      const advancedGrid=el('div',null,'ai-config-grid');advanced.append(advancedGrid);
      const context=field('context_window','上下文上限（tokens）','number',advancedGrid),max=field('max_tokens','单次输出上限（tokens）','number',advancedGrid);
      context.min='1024';context.value=profile?.context_window||32768;max.min='1';max.value=profile?.max_tokens||4096;
      const vision=field('vision','模型支持图片','checkbox',advancedGrid);vision.checked=!!profile?.vision;
      const reasoning=field('reasoning','模型支持推理','checkbox',advancedGrid);reasoning.checked=!!profile?.reasoning;
      const headers=field('headers','自定义请求头（JSON，留空保留）','textarea',advancedGrid);headers.placeholder='{"X-Client": "roaster"}';
      fields={name,provider,model,method,base,protocol,secret,context,max,vision,reasoning,headers,mode:()=>mode};
      actions.append(button('保存配置',()=>persist(),'primary'),button('加载模型目录',async()=>{
        const saved=await persist();const models=await rpc('models',{profile_id:saved.id});list.replaceChildren();
        for(const m of models)option(list,m.id,m.name||m.id);
        settingsStatus.textContent='已加载 '+models.length+' 个模型；选择后保存配置';
      }));
      if(mode==='subscription')actions.append(button('登录订阅',async()=>{
        const saved=await persist();authBox.replaceChildren();const result=await rpc('auth.login',{profile_id:saved.id,login_method:method.value});loginId=result.id;
        authBox.append(el('p','等待供应商授权…','ai-status'),button('取消登录',()=>rpc('auth.cancel',{id:loginId})));
      }),button('退出订阅',async()=>{const id=configForm.dataset.profileId;if(!id)throw Error('请先选择配置');await rpc('auth.logout',{profile_id:id});await refresh();await loadSettings();}));
      actions.append(button('测试连接',async()=>{const saved=await persist();const result=await rpc('test',{profile_id:saved.id});settingsStatus.textContent=result.text||'连接成功';}),button('删除此配置',async()=>{
        const id=configForm.dataset.profileId;if(!id)return;if(!confirm('删除此 AI 配置及其凭据？历史会话保留。'))return;await rpc('profiles.delete',{id});await refresh();await loadSettings();
      }));
    }
    async function persist() {
      const profile={id:configForm.dataset.profileId||undefined,name:fields.name.value.trim(),mode:fields.mode(),provider:fields.provider.value,model:fields.model.value.trim(),base_url:fields.base?.value.trim()||'',protocol:fields.protocol?.value,context_window:Number(fields.context.value),max_tokens:Number(fields.max.value),vision:fields.vision.checked,reasoning:fields.reasoning.checked};
      if(fields.headers.value.trim())profile.headers=JSON.parse(fields.headers.value);
      const saved=await rpc('profiles.save',{profile,api_key:fields.secret?.value||undefined});
      if(fields.secret)fields.secret.value='';fields.headers.value='';configForm.dataset.profileId=saved.id;selectedProfile=saved.id;
      profiles=await rpc('profiles.list');updateSelect();settingsStatus.textContent='配置已保存';return saved;
    }
    drawFields(p);
  }
  function authEvent(event) {
    if(!authBox)return;
    if(!loginId)loginId=event.id;
    if(event.id!==loginId)return;
    const d=event.data||{};
    if(event.type==='auth_notify') {
      if(d.message)authBox.append(el('p',d.message));
      if(d.instructions)authBox.append(el('p',d.instructions));
      const url=d.url||d.verificationUri||d.verification_uri;
      if(url&&/^https?:\/\//.test(url)){const a=el('a','打开供应商授权页面');a.href=url;a.target='_blank';a.rel='noopener noreferrer';authBox.append(a);}
      const code=d.userCode||d.user_code;if(code)authBox.append(button('复制设备码 '+code,()=>navigator.clipboard.writeText(code)));
    }else if(event.type==='auth_prompt') {
      const wrap=el('div',null,'ai-auth-prompt');wrap.append(el('p',d.message||'请完成授权'));
      const input=el(d.type==='select'?'select':'input');if(d.type!=='select')input.type=d.type==='secret'?'password':'text';input.setAttribute('aria-label',d.message||'授权信息');
      for(const o of d.options||[])option(input,o.value||o.id||o,o.label||o.name||o);
      wrap.append(input,button('提交授权信息',async()=>{await rpc('auth.respond',{id:loginId,prompt_id:d.prompt_id||d.id,value:input.value});input.value='';wrap.remove();}));authBox.append(wrap);input.focus();
    }else if(event.type==='auth_done') {loginId=null;authBox.replaceChildren(el('p','订阅登录成功，可加载账号可用模型','ai-status'));refresh().catch(fail);}
    else if(event.type==='error'){loginId=null;authBox.append(el('p',typeof d==='string'?d:d.message||'登录失败，可重新登录','ai-status'));}
  }
  function mountSettings() {
    const grid=document.querySelector('.settings-grid');if(!grid)return;
    settingsCard=el('section',null,'settings-card settings-card-wide ai-settings');grid.prepend(settingsCard);
    const heading=el('div',null,'settings-card-heading'),icon=el('i',null,'ph ph-waveform');icon.setAttribute('aria-hidden','true');
    const title=el('div');title.append(el('h3','AI 服务'),el('p','选择认证渠道和模型，继续同一段对话。'));heading.append(icon,title);settingsCard.append(heading);
    const hostControls=el('div',null,'ai-actions');settingsCard.append(hostControls);
    if(desktop){const hostLabel=el('label',null,'ai-field');hostLabel.append(el('span','AI 运行位置'));const select=el('select');option(select,'backend','当前后端 · 共享会话');option(select,'local','这台电脑 · 本机独立');select.value=host;hostLabel.append(select);hostControls.append(hostLabel);select.onchange=async()=>{try{await changeHost(select.value);}catch(e){fail(e);}};}
    hostControls.append(button('重新连接',async()=>{await refresh();await loadSettings();}),button('新增配置',()=>editProfile(null)),button('配对客户端',showClients));
    if(desktop)hostControls.append(button('迁移旧本机配置与历史',async()=>{
      if(!confirm('将读取旧本机 AI 配置与历史。确认迁入当前选定的 AI 服务？'))return;
      if(host==='local')await rpc('profiles.list');
      else await native.invoke('ai_migrate_legacy',{backend:backend()});
      await refresh();await loadSettings();setStatus('迁移完成，旧数据已保留');
    }));
    const pairBox=el('details');pairBox.append(el('summary','配对新的设备后端'));const pairBody=el('div',null,'ai-config-grid');pairingUi(pairBody);pairBox.append(pairBody);settingsCard.append(pairBox);
    const list=el('div',null,'ai-config-list');list.id='ai-config-list';settingsCard.append(list);
    configForm=el('div',null,'ai-config-form');settingsCard.append(configForm);
    authBox=el('section',null,'ai-auth');authBox.setAttribute('aria-label','订阅授权进度');settingsCard.append(authBox);
    settingsStatus=el('p','正在连接 AI 服务…','ai-status');settingsStatus.setAttribute('role','status');settingsCard.append(settingsStatus);
  }
  async function showClients() {
    if(desktop&&host==='local'){setStatus('本机模式只供当前电脑使用，无配对客户端');return;}
    const box=$('ai-clients');box.hidden=false;box.replaceChildren(el('h4','已配对客户端'));
    const clients=desktop?await native.invoke('ai_remote_clients',{backend:backend()}):await jsonFetch('/api/v1/ai/clients');
    for(const c of Array.isArray(clients)?clients:clients.clients||[])box.append(button((c.name||c.id)+' · 撤销配对',async()=>{
      if(!confirm('撤销这个客户端的 AI 访问权限？'))return;
      if(desktop)await native.invoke('ai_remote_revoke',{backend:backend(),id:c.id});else await jsonFetch('/api/v1/ai/clients/'+encodeURIComponent(c.id),{method:'DELETE'});
      await showClients();
    }));
    show();
  }
  async function changeHost(value) {
    if(activeRun)await stop();generation++;connected=false;conversation=null;activeRun=null;transient.clear();sequences.clear();eventCursor=0;queuedAttachments=[];queuedContext=null;contextBinding=null;
    socket?.close();socket=null;clearTimeout(reconnectTimer);abortEvents?.abort();
    if(desktop)await native.invoke('ai_remote_stop').catch(()=>{});
    host=value;localStorage.setItem('roaster.ai.host',host);
    await refresh();await loadSettings();
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
    headerActions.append(button('会话',()=>{$('ai-history').hidden=!$('ai-history').hidden;}),button('放大',()=>{panel.classList.toggle('ai-chat-expanded');headerActions.children[1].textContent=panel.classList.contains('ai-chat-expanded')?'收起':'放大';}),button('关闭',hide));header.append(heading,headerActions);
    const tools=el('div',null,'ai-chat-tools');profileSelect=el('select');profileSelect.id='ai-chat-profile';profileSelect.setAttribute('aria-label','当前 AI 渠道与模型');profileSelect.onchange=()=>{selectedProfile=profileSelect.value;setStatus('下一条消息使用新渠道，历史上下文保留');};
    tools.append(profileSelect,button('新对话',newConversation),button('配置',()=>{show();$('ai-inline-settings').hidden=!$('ai-inline-settings').hidden;const mainSettings=document.querySelector('[data-tab="settings"]');if(mainSettings){mainSettings.click();hide();}else if(!configForm){const grid=el('div',null,'settings-grid');$('ai-inline-settings').append(grid);mountSettings();if(connected)loadSettings().catch(fail);}}));
    const historyBox=el('section',null,'ai-chat-history');historyBox.id='ai-history';historyBox.hidden=true;
    const search=el('input');search.id='ai-history-search';search.type='search';search.placeholder='搜索会话';search.setAttribute('aria-label','搜索历史会话');search.oninput=renderHistory;
    history=el('nav');history.setAttribute('aria-label','历史会话');historyBox.append(search,history,button('重命名当前会话',async()=>{if(!conversation)return;const title=prompt('会话名称',conversation.title||'');if(title?.trim()){conversation=await rpc('conversations.update',{id:conversation.id,revision:conversation.revision,title:title.trim()});await refresh();}}),button('删除当前会话',async()=>{if(!conversation||!confirm('删除当前会话及其附件？'))return;if(activeRun)await stop();await rpc('conversations.delete',{id:conversation.id});conversation=null;localStorage.removeItem(key('conversation'));await refresh();renderMessages();}));
    access=el('section',null,'ai-chat-access');pairingUi(access);
    const inline=el('section',null,'ai-inline-settings');inline.id='ai-inline-settings';inline.hidden=true;
    const clients=el('section',null,'ai-context-picker');clients.id='ai-clients';clients.hidden=true;
    messages=el('div',null,'ai-messages');messages.id='ai-messages';messages.tabIndex=0;messages.setAttribute('aria-label','对话消息');
    info=el('p','正在连接 AI 服务…','ai-status');info.setAttribute('role','status');
    const picker=el('section',null,'ai-context-picker');picker.id='ai-context-picker';picker.hidden=true;
    const inputArea=el('div',null,'ai-composer'),queued=el('div',null,'ai-queued');queued.id='ai-queued';
    const label=el('label',null,'ai-field');label.append(el('span','消息'));composer=el('textarea');composer.id='ai-prompt';composer.rows=3;composer.maxLength=16000;composer.placeholder='提出问题，或描述你希望调整的曲线';label.append(composer);
    const input=el('input');input.type='file';input.multiple=true;input.accept='.kpro,.klog,image/png,image/jpeg,image/webp';input.hidden=true;input.onchange=()=>{attach(input.files).catch(fail);input.value='';};
    const actions=el('div',null,'ai-actions');const sendButton=button('发送',()=>send(),'primary');sendButton.id='ai-send';const stopButton=button('停止',stop);stopButton.id='ai-stop';stopButton.disabled=true;
    actions.append(button('添加文件 / 图片',()=>input.click()),button('选择曲线 / 记录',selectBusiness),button('带入当前页面',async()=>{contextBinding=null;queuedContext=null;queuedContext=await currentContext();renderQueued();setStatus('已选入当前页面数据');}),stopButton,sendButton);
    inputArea.append(queued,picker,label,actions,input);
    panel.append(header,tools,historyBox,access,inline,clients,messages,info,inputArea);
    const launch=button('AI 对话',()=>{if(panel.hidden)show();else hide();});launch.id='ai-launcher';launch.classList.add('ai-launcher');launch.setAttribute('aria-expanded','false');launch.setAttribute('aria-controls','ai-chat');
    document.body.append(panel,launch);
    composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send().catch(fail);}});
    composer.addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();attach(files).catch(fail);}});
    panel.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();panel.classList.add('ai-dragging');}});
    panel.addEventListener('dragleave',()=>panel.classList.remove('ai-dragging'));
    panel.addEventListener('drop',e=>{e.preventDefault();panel.classList.remove('ai-dragging');attach(e.dataTransfer.files).catch(fail);});
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'){hide();e.stopPropagation();}});
    function fitViewport(){const zoom=Number.parseFloat(getComputedStyle(document.body).zoom)||1;panel.style.setProperty('--ai-view-width',(innerWidth/zoom)+'px');}
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
  if(desktop)nativeReady=native.listen('roaster-ai-service',event=>onEvent(event.payload).catch(fail));
  window.addEventListener('roaster-status',event=>{latestStatus=event.detail;const binding=runBindings.get(activeRun);if(binding?.kind==='live'&&(latestStatus.state!=='ROASTING'||!latestStatus.connected||binding.context?.status?.session_id!==latestStatus.session_id))stop().catch(fail);});
  window.addEventListener('roaster-disconnected',()=>{if(runBindings.get(activeRun)?.kind==='live')stop().catch(fail);});
  window.addEventListener('roaster-record',event=>{currentRecord=event.detail;});
  window.addEventListener('roaster-ai-open',()=>{contextBinding=null;queuedContext=null;show();currentContext().then(value=>{queuedContext=value;renderQueued();}).catch(fail);});
  window.addEventListener('beforeunload',()=>{if(activeRun&&runBindings.get(activeRun)?.kind==='live')cancelRun(activeRun).catch(()=>{});});
  window.RoasterChat={mountContext,open:show,request:rpc,send,refresh,attach,get current(){return conversation;},get host(){return host;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
