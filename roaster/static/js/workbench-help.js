(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean = value => String(value || '').replace(/<\/?p[^>]*>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/\\v|\v/g,'\n').trim();
  const sections = [['all','全部说明'],['features','功能与操作'],['mapping','KL 对应与适配'],['changes','功能变化'],['cautions','兼容与注意事项'],['shortcuts','快捷键'],['parameters','参数词典']];
  const articles = [
    ['features','文件与未保存草稿','新建，打开或拖入 .kpro / .klog。每次编辑都在文档副本上进行；显式保存并选定路径后才写文件。更换文件可以保存、放弃或取消。单文件最多 8 MiB。','open'],
    ['features','温度曲线与六参数贝塞尔','每个节点有锚点时间/数值、左控制柄时间/数值、右控制柄时间/数值。拖动锚点会带动控制柄；首节点时间锁定。右侧数值输入提供精确操作与键盘替代。','temperature'],
    ['features','风扇曲线与双向叠加','风扇原生单位为 RPM。主页风扇叠加按两张图未缩放纵轴范围映射，缩放不改变基准；温度可反向叠加到风扇页。风扇增减按时间累积倍率，显示不修改原始曲线。','fan'],
    ['features','选点、插点、删点和平滑','选择节点或左右控制柄后编辑。插点使用相邻中点，末节点向后延伸；也可双击画布插点。首节点保留，至少三个节点。连接左右控制柄保留对侧长度；平滑点和全部平滑均可撤销。','insert'],
    ['features','ABC 阶段预计算','右侧按建议结束、C 发展、一爆、B 美拉德、转黄、A 脱水排列。预期转黄/一爆温度、推荐程度和曲线变化会重新计算时间、占比、温升；缺少边界时留空。推荐程度在关于此文件中修改。','temperature'],
    ['features','日志通道、offsets 与 RoR','选择温度、记录 RoR、功率、风扇、电压或 PID 等实际通道。每个通道使用自己的时间偏移。记录 RoR、显示平滑与独立重算 RoR 分开；平滑和倍率只影响显示，CSV仍输出原始值。','log'],
    ['features','六类事件与阶段','转黄、一爆、一爆结束、二爆、二爆结束、结束可编辑时间或清空。原始事件与有效事件分别保留；没有事件不补造阶段比例。事件修改可以撤销。','log'],
    ['features','多文件比较与参数差异','最多四个背景文件。每份可以隐藏、移除和选择日志通道；背景不替换主文档。关于此文件及曲线设置标出字段差异。','compare'],
    ['features','参数分类、难度与搜索','沿用原参数分类、字段顺序、难度和提示。当前文件仅展示实际存在字段；词典提供完整目录。日志仅品尝笔记和烘焙日期可编辑，未知字段及schema只读。摄氏、华氏绝对温度和温差分别转换。','settings'],
    ['features','曲线变换与选择性合并','变换提供时间倍率/位移和数值倍率/位移。合并可分别选择温度、风扇、名称设计者说明、事件与推荐程度、区域、其他参数。未选择内容保留，格式版本不隐式升级。','transform'],
    ['features','从日志提取原生曲线','从日志的嵌入字段提取曲线，保留已知配置；不把采样、事件或设备身份复制进新曲线。缺少内嵌曲线时不凭空生成历史目标。','extract'],
    ['features','曲线面积、时间与缩放','面积按原采样公式，单位 °C·分钟或 RPM·分钟；时间接受秒数或 分:秒。滚轮缩放时间轴，Shift+滚轮只缩纵轴；全部缩放恢复范围，拖动空白不平移。','area'],
    ['features','原生、CSV、PNG 与 PDF 导出','原生保存保留未知行、字段顺序、重复事件、BOM、原行尾及未编辑数字。CSV 为 UTF-8 BOM 原始采样。PNG导出当前图，PDF可选当前图、温度、风扇、记录、文件信息和参数页。','pdf'],
    ['features','从本软件曲线库和记录进入','从曲线库打开会精确转换现有控制插值为贝塞尔；若保存有原生来源则优先重开原文。记录详情的在原生工作台分析读取历史采样；缺少历史曲线快照时不生成嵌入目标。','library'],
    ['features','存入现有曲线库','仅温度目标转换成新的控制曲线；待机时创建新 UUID，之后由用户在曲线管理手动应用。最多64节点，采样最大转换误差≤0.25°C，并校验实际设备温度上限和控制样条极值。','adopt'],
    ['features','AI 原生文件分析与候选','AI读取所选文件的已知参数、曲线、按offsets校准通道和确定性指标。候选先叠加预览并显示差异，确认后采用到草稿，一次撤销可恢复。日志候选创建独立.kpro，不修改采样。保存与应用仍须分别操作。','ai'],
    ['mapping','KL 功能入口对应','参考 Kaffelogic Studio 7.3.28 和离线 RoastWorkbench 0.2.2。原文件/绘制/查看/工具菜单现由工具栏、五个视图和右侧检查器承载：温度、风扇、记录、关于此文件、曲线设置。功能路径可从本说明直接跳转。','temperature'],
    ['mapping','交互适配与原版差异','界面采用本软件 风味研究图谱（以根 DESIGN.md 为准），适应 Web/Tauri，并未复制原七菜单、多窗口或 Qt/wx 像素外观。当前方向键每次1秒/1数值单位，Alt×10；原参考为0.1秒/0.1°C。普通滚轮只改时间轴；当前没有原参考200ms滚轮限频。'],
    ['mapping','原生参数与本机控制参数','风扇RPM、Kaffelogic PID、预热与区域参数保留在原生文档供分析，不转换成 TC4S 输出；工作台编辑不会修改当前执行曲线、加热、急停、SV或lookahead。'],
    ['changes','完整离线工作台进入同一控制台','原先独立离线程序的文件格式、曲线与日志计算迁入共享Web/Tauri。桌面内置独立数值引擎，无需原版、Qt或系统Python；断开设备后仍可离线编辑、比较、导出。'],
    ['changes','曲线库、记录与原生保真联通','现有曲线库与记录可进入原生工作台；原生曲线经明确适配后另存到现有曲线库，保留原生来源与转换误差证据。保存、采用和硬件应用分开。'],
    ['changes','内置说明与可审阅的AI候选','完整功能、原版对应、适配变化、快捷键和参数词典现在可离线搜索。AI可以分析原生文件并提出双曲线候选；原始字节留在本地，工具仅处理快照，采用需要确认。'],
    ['cautions','支持版本与只读诊断','可写profile schema为1.4/1.6/1.8，native log schema为1.8。未知或缺失版本、倒序或重复采样时间保持只读；不会自动升版。空文件和截断日志显示诊断，不猜测补写。只读文件可查看、比较及导出可读采样。'],
    ['cautions','保存限制与名称','曲线至少三个节点，时间严格递增，按原保存规则检查间隔及控制柄。内部短名称只允许ASCII；文件名和路径支持中文。风扇修改的整条曲线需8000–18000 RPM。schema1.4内部名称不能为空。'],
    ['cautions','取消保存与浏览器下载','取消保存保留未保存草稿。浏览器支持文件保存API时可确认写入；普通下载无法可靠区分完成与取消，因此继续保留未保存标记。原生桌面使用保存对话框。'],
    ['cautions','历史事实、默认参考与AI数据','本软件仅温度曲线生成的原生文档，风扇与设备参数来自默认参考；预期转黄/一爆初始留空。AI不读取未知字段和原文base64；内容会发送给所选AI服务。缺采样、事件或杯测时应明确资料缺口。'],
    ['cautions','AI范围与安全上限','AI原生候选限定3–64个六参数节点、时长≤7200秒，完整贝塞尔温度0–300°C、风扇8000–18000RPM。这是离线候选设计范围；进入本机曲线库还要通过实际设备上限及控制插值校验。候选过期后需重新生成。'],
    ['cautions','本次不包含的原版能力','Link .npro/.nlog、第三方格式转换、USB/Wi-Fi/云连接不属于已迁移离线功能。原生工作台不会控制Kaffelogic或替代现有TC4S控制路径。主机测试不代表真实风扇、树莓派或试烘验证。'],
    ['shortcuts','当前支持的快捷键','Ctrl+N新建，Ctrl+O打开，Ctrl+S保存，Ctrl+Z撤销，Ctrl+Y或Ctrl+Shift+Z重做，Ctrl+L全部缩放。画布焦点下Ins插点、Del删点、方向键微调、Alt加大步长。输入框内保留正常文字编辑快捷键。'],
    ['shortcuts','快捷键适配说明','当前保存总是显式选择路径。原参考的Ctrl+Shift+S、平滑、比较、变换、合并、新窗口等额外快捷键未逐项映射；相应已迁移功能可通过可见按钮操作。'],
  ].map(([category,title,body,action],i)=>({id:'topic-'+i,category,title,body,action}));

  function open({dialog,catalog,current,jump}) {
    const previousFocus=document.activeElement;
    dialog.classList.add('wb-help-dialog');
    dialog.innerHTML='<div class="wb-help-heading"><div><h3>原生工作台说明</h3><p>KL 离线功能、适配变化与参数词典</p></div><button class="ctrl-btn" type="button" data-help-close>关闭说明</button></div><label class="wb-help-search">搜索说明与参数<input id="wb-help-query" type="search" placeholder="例如：风扇、只读、ABC、preheat_power" autocomplete="off"></label><div class="wb-help-layout"><nav class="wb-help-nav" aria-label="说明分类">'+sections.map(([key,label])=>`<button type="button" data-help-category="${key}" aria-pressed="${key==='all'}">${label}</button>`).join('')+'</nav><div class="wb-help-content"><p id="wb-help-count" role="status"></p><div id="wb-help-results"></div></div></div>';
    const entries=[...articles];
    for(const [key,info] of Object.entries(catalog?.parameters||{})) {
      const present=!!current&&key in current.metadata;
      const readonly=info.readonly||/schema_version/.test(key)||(current?.document.kind==='log'&&!['tasting_notes','roast_date'].includes(key));
      entries.push({id:'param-'+key,category:'parameters',title:info.label||key,
        body:[key,info.unit?'单位：'+info.unit:'', '难度：'+(['','基础','高级','专家','工程师'][info.difficulty_level||4]),clean(info.help)||'目录没有额外说明。',present?(readonly?'当前字段只读。':'当前文件可查看此字段。'):'当前文件没有此字段；不会为历史文件自动补默认值。'].filter(Boolean).join('\n'),
        parameter:key,action:present?'parameter':null});
    }
    let category='all';
    const query=dialog.querySelector('#wb-help-query'),results=dialog.querySelector('#wb-help-results');
    function render(){
      const terms=query.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      const shown=entries.filter(e=>(terms.length||category==='all'||e.category===category)&&terms.every(t=>(e.title+' '+e.body).toLocaleLowerCase().includes(t)));
      dialog.querySelector('#wb-help-count').textContent=`${shown.length} 项${terms.length?'搜索结果':'说明'}`;
      results.innerHTML=shown.map(e=>`<article class="wb-help-article" id="${esc(e.id)}"><div class="wb-help-article-title"><h4>${esc(e.title)}</h4><span>${esc(sections.find(([key])=>key===e.category)?.[1]||'')}</span></div><p>${esc(e.body)}</p>${e.action?`<button type="button" class="ctrl-btn" data-help-action="${esc(e.action)}" ${e.parameter?`data-help-parameter="${esc(e.parameter)}"`:''}>${e.parameter?'查看当前字段':'前往操作'}</button>`:''}</article>`).join('')||'<div class="wb-help-empty"><h4>没有找到匹配内容</h4><p>试试“风扇”“只读”“ABC”，或清空搜索查看全部说明。</p><button type="button" class="ctrl-btn" data-help-reset>清空搜索</button></div>';
    }
    const close=()=>{dialog.close();dialog.classList.remove('wb-help-dialog');dialog.onclick=null;previousFocus?.focus({preventScroll:true});};
    dialog.querySelector('[data-help-close]').onclick=close;
    dialog.oncancel=()=>{dialog.classList.remove('wb-help-dialog');previousFocus?.focus({preventScroll:true});};
    dialog.onclick=event=>{
      const el=event.target.closest('[data-help-category],[data-help-action],[data-help-reset]');if(!el)return;
      if(el.dataset.helpCategory){category=el.dataset.helpCategory;query.value='';dialog.querySelectorAll('[data-help-category]').forEach(b=>b.setAttribute('aria-pressed',String(b===el)));render();}
      if(el.dataset.helpReset!==undefined){query.value='';render();query.focus();}
      if(el.dataset.helpAction){close();jump(el.dataset.helpAction,el.dataset.helpParameter);}
    };
    query.oninput=render;render();dialog.show();query.focus();
  }
  window.WorkbenchHelp={open};
})();
