(function() {
  'use strict';

  // ========== 全局状态 ==========
  let ws = null;
  let reconnectTimer = null;
  let currentProfile = null;
  let profileMap = {};
  let roastChart = null;
  const MAX_POINTS = 2400;
  let eventAnnotations = [];
  let lastState = 'IDLE';
  let lastBodyState = null; // 缓存上次写入 body 的状态 class,避免每帧 remove/add 触发样式重算
  let lastEventsSig = '';   // 缓存上次 events 签名,events 未变时跳过 eventAnnotations 重建 + chart.update
  let currentSessionId = null;
  let lastPromptedSessionId = null;
  let compareMode = false;
  let selectedRecords = new Set();
  let selectedProfileId = null;

  // 急停按钮双击确认状态
  let eStopConfirmTimer = null;
  let eStopConfirming = false;

  // ERROR 状态标记
  let inErrorState = false;

  // ROR 前端 EWMA 平滑
  let rorEwma = 0;
  const ROR_EWMA_ALPHA = 0.3;
  let lastRORValue = null;
  let lastRORTime = null;

  // ========== Chart.js 自定义插件：事件垂直线 ==========
  const eventLinesPlugin = {
    id: 'eventLines',
    afterDatasetsDraw(chart, args, options) {
      const { ctx, scales: { x, y } } = chart;
      if (!x || !y) return;
      ctx.save();
      const annotations = (options && options.annotations) ? options.annotations : eventAnnotations;
      annotations.forEach(ann => {
        const xPos = x.getPixelForValue(ann.time);
        if (xPos < x.left || xPos > x.right) return;
        ctx.beginPath();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = ann.color || '#f59e0b';
        ctx.moveTo(xPos, y.top);
        ctx.lineTo(xPos, y.bottom);
        ctx.stroke();
        const text = ann.label;
        ctx.font = '11px Fira Sans';
        const textWidth = ctx.measureText(text).width;
        const padding = 4;
        const labelY = y.top + 6;
        ctx.fillStyle = 'rgba(10,10,10,0.8)';
        ctx.fillRect(xPos + 4, labelY, textWidth + padding * 2, 16);
        ctx.fillStyle = ann.color || '#f59e0b';
        ctx.fillText(text, xPos + 4 + padding, labelY + 12);
      });
      ctx.restore();
    }
  };
  Chart.register(eventLinesPlugin);

  // ========== Chart.js 初始化 ==========
  function initCharts() {
    Chart.defaults.color = '#a3a3a3';
    Chart.defaults.borderColor = '#262626';

    const ctx = document.getElementById('roast-chart').getContext('2d');
    roastChart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: '温度',
            data: [],
            borderColor: '#00e676',
            backgroundColor: '#00e676',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2.5,
            yAxisID: 'y',
          },
          {
            label: '设定温度',
            data: [],
            borderColor: '#ff5252',
            backgroundColor: '#ff5252',
            borderDash: [6, 4],
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
            yAxisID: 'y',
          },
          {
            label: '目标曲线',
            data: [],
            borderColor: '#9e9e9e',
            backgroundColor: 'rgba(158,158,158,0.06)',
            borderDash: [8, 4],
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
            fill: false,
            yAxisID: 'y',
          },
          {
            label: 'ROR',
            data: [],
            borderColor: '#448aff',
            backgroundColor: 'rgba(68,138,255,0.12)',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
            fill: true,
            yAxisID: 'y1',
          },
          {
            label: 'ROR 预览',
            data: [],
            borderColor: '#82b1ff',
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false,
            yAxisID: 'y1',
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: '#e5e5e5',
              font: { size: 13, weight: '500' },
              usePointStyle: true,
              pointStyle: 'rectRounded',
              boxWidth: 24,
              boxHeight: 12,
              padding: 16,
            },
            onClick: (e, legendItem, legend) => {
              const index = legendItem.datasetIndex;
              const ci = legend.chart;
              if (ci.isDatasetVisible(index)) {
                ci.hide(index);
                legendItem.hidden = true;
              } else {
                ci.show(index);
                legendItem.hidden = false;
              }
            }
          },
          tooltip: {
            enabled: true,
            mode: 'index',
            intersect: false,
            filter: function(context) {
              // dataset[2]=目标曲线(profile target), dataset[4]=ROR预览 — 插值曲线始终有数据，始终显示
              if (context.datasetIndex === 2 || context.datasetIndex === 4) return true;
              // dataset[0]=PV温度, dataset[1]=SV设定值, dataset[3]=ROR实时值 — 只在有数据范围内显示
              const data = context.chart.data.datasets[context.datasetIndex].data;
              if (!data || data.length === 0) return false;
              const xMin = data[0].x !== undefined ? data[0].x : data[0].t;
              const xMax = data[data.length - 1].x !== undefined ? data[data.length - 1].x : data[data.length - 1].t;
              const x = context.parsed.x !== undefined ? context.parsed.x : context.parsed.t;
              return x >= xMin && x <= xMax;
            },
            callbacks: {
              title: (items) => {
                if (!items || !items.length) return '';
                const sec = items[0].parsed.x;
                if (sec == null || Number.isNaN(sec)) return '';
                const m = Math.floor(sec / 60);
                const s = Math.floor(sec % 60);
                return `${m}:${String(s).padStart(2, '0')}`;
              },
              label: (item) => {
                const ds = item.dataset.label || '';
                const v = item.parsed.y;
                if (v == null || Number.isNaN(v)) return '';
                if (ds.includes('ROR')) return `${ds}: ${v.toFixed(1)} °C/min`;
                return `${ds}: ${v.toFixed(1)} °C`;
              }
            }
          },
          eventLines: {}
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: '时间 (min)', color: '#a3a3a3', font: { size: 12 } },
            grid: { color: '#1f1f1f' },
            ticks: {
              color: '#a3a3a3',
              callback: function(value) {
                const m = Math.floor(value / 60);
                const s = Math.floor(value % 60);
                return `${m}:${String(s).padStart(2,'0')}`;
              }
            }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            min: 0,
            max: 300,
            title: { display: true, text: '温度 (°C)', color: '#a3a3a3', font: { size: 12 } },
            grid: { color: '#1f1f1f' },
            ticks: { color: '#a3a3a3' }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'ROR (°C/min)', color: '#a3a3a3', font: { size: 12 } },
            grid: { drawOnChartArea: false },
            ticks: { color: '#60a5fa' },
            suggestedMin: -5,
            suggestedMax: 25
          },
        }
      }
    });
  }

  function appendChartData(datasetIndex, x, y) {
    const ds = roastChart.data.datasets[datasetIndex].data;
    ds.push({ x, y });
    if (ds.length > MAX_POINTS) ds.shift();
  }

  /**
   * 安全更新 Chart.js 数据集（v3.4）
   * 先清空数组再 push，避免直接替换导致 Proxy 变化检测失效
   */
  function safeUpdateDataset(chart, datasetIndex, newData) {
    const ds = chart.data.datasets[datasetIndex].data;
    ds.length = 0;
    ds.push(...newData);
  }

  function setProfileCurve(nodes, name) {
    const interpolated = splineInterpolate(nodes, 5);
    safeUpdateDataset(roastChart, 2, interpolated);
    // 同时加载该曲线的 ROR 预览
    const profileROR = buildRORDataset(nodes || []);
    safeUpdateDataset(roastChart, 4, profileROR);
    const lastTime = interpolated.length ? interpolated[interpolated.length - 1].x : 600;
    let suggestedMax = 600;
    if (lastTime > 900) suggestedMax = 1200;
    else if (lastTime > 600) suggestedMax = 900;
    roastChart.options.scales.x.suggestedMax = suggestedMax;
    // 当前曲线名进图例:dataset[2] label 动态显示,chart.update 后图例自动反映
    roastChart.data.datasets[2].label = name || '目标曲线';
    roastChart.update('none');
  }

  function updateEventAnnotations(events) {
    // events 未变就完整跳过——包括 eventAnnotations 数组重建与 chart.update('none')。
    // ROASTING 中 0.5s 广播的中间帧 events 几乎不变,这层 guard 把每帧的 chart 重绘消除。
    const list = events || [];
    const sig = list.map(e => `${e.type}:${e.time}:${e.temperature}`).join(',') + '|' + list.length;
    if (sig === lastEventsSig) return;
    lastEventsSig = sig;

    const colors = {
      charge: '#22c55e',
      yellowing: '#f59e0b',
      first_crack: '#ef4444',
      first_crack_end: '#ef4444',
      second_crack: '#a855f7',
      second_crack_end: '#a855f7',
      drop: '#3b82f6'
    };
    eventAnnotations = list.map(e => ({
      time: e.time,
      label: eventLabel(e.type),
      color: colors[e.type] || '#f59e0b'
    }));
    if (roastChart) roastChart.update('none');
  }

  // ========== WebSocket ==========
  // 指数退避：1s → 2s → 4s → ... → 30s 封顶；onerror 与 onclose 双路径用 wsGen 序号去重，防止双 timer race
  let wsGen = 0;
  let reconnectDelay = 1000;
  const RECONNECT_MAX_DELAY = 30000;
  let pingTimer = null;

  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const myGen = ++wsGen;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws = sock;

    sock.onopen = () => {
      if (myGen !== wsGen) return;
      reconnectDelay = 1000; // 成功连接后退避复位
      updateWsStatus(true);
      // 心跳：每 15 秒发一个空 ping,后端如未响应 6 秒则主动 close 触发重连
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) {
          try { sock.send(JSON.stringify({ cmd: '__ping' })); } catch (_) {}
        }
      }, 15000);
    };
    sock.onmessage = (event) => {
      if (myGen !== wsGen) return;
      const msg = JSON.parse(event.data);
      // 跳过命令回包(ok/error),避免它们走完整 state 解析路径
      if (msg.ok === true || msg.error != null) return;
      handleStateUpdate(msg);
    };
    sock.onclose = () => {
      // 旧 sock 的 onclose 不应再触发重连
      if (myGen !== wsGen) return;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      updateWsStatus(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // 指数退避 + 30s 封顶,避免局域网瞬态抖动时每 2s 撞墙
      reconnectTimer = setTimeout(connectWS, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    };
    sock.onerror = () => {
      // 不主动 close —— 浏览器规范上 error 后会自动跟一个 close,二次 close 反而触发双 timer
      // 只在仍然是当前 sock 时清理 ws 句柄,让 onclose 兜底重连
      if (myGen !== wsGen) return;
    };
  }

  function sendCmd(cmd, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd, ...payload }));
    }
  }

  // ========== UI 更新 ==========
  /**
   * 处理 WebSocket 状态更新：刷新读数、图表、按钮、事件、阶段条
   * @param {object} msg - 后端广播的状态对象
   */
  function handleStateUpdate(msg) {
    document.getElementById('pv-val').textContent = msg.pv != null ? msg.pv.toFixed(1) : '--';
    document.getElementById('sv-val').textContent = msg.sv != null ? msg.sv.toFixed(1) : '--';
    document.getElementById('ror-val').textContent = msg.ror != null ? msg.ror.toFixed(1) : '--';

    // 超前预测实际使用值反馈
    const laUsedEl = document.getElementById('lookahead-used');
    if (laUsedEl) {
      laUsedEl.textContent = (msg.lookahead_used != null) ? msg.lookahead_used.toFixed(1) : '--';
    }

    // 用户拖动滑块作为唯一可信源,后端不反向回写

    const badge = document.getElementById('state-badge');
    // 状态未变就不写 textContent / className,避免每帧触发 selector 重匹配
    const badgeText = stateLabel(msg.state);
    if (badge.textContent !== badgeText) badge.textContent = badgeText;
    const badgeCls = 'state-badge ' + msg.state;
    if (badge.className !== badgeCls) badge.className = badgeCls;

    // 同步 <body> 状态 class，便于 CSS 按状态控制动画/可见性（出豆按钮脉冲、事件栏可见性等）
    // 仅在状态确实变化时才操作 body classList,避免每帧无谓的 remove/add 触发样式重算
    if (msg.state !== lastBodyState) {
      const bodyStateClasses = ['state-idle', 'state-roasting', 'state-cooling', 'state-error'];
      document.body.classList.remove(...bodyStateClasses);
      if (msg.state) {
        document.body.classList.add('state-' + String(msg.state).toLowerCase());
      }
      lastBodyState = msg.state;
    }

    // 时间文本短路（mm:ss 至少 1s 才变,中间帧跳过）
    const elapsedEl = document.getElementById('elapsed');
    const elapsedText = formatTime(msg.elapsed || 0);
    if (elapsedEl.textContent !== elapsedText) elapsedEl.textContent = elapsedText;

    if (msg.connected !== undefined) {
      updateTc4sStatus(msg.connected);
    }

    // ERROR 状态处理
    if (msg.state === 'ERROR') {
      if (compareMode) exitCompareMode();
      showErrorOverlay(msg.error_reason);
    } else if (inErrorState) {
      hideErrorOverlay();
    }

    // 对比模式下不更新实时图表
    if (!compareMode && msg.state !== 'ERROR') {
      // 状态转换时清空旧数据
      const enteringRoast = msg.state === 'ROASTING' && lastState !== 'ROASTING';
      const enteringIdle = msg.state === 'IDLE' && lastState !== 'IDLE';

      if (enteringRoast) {
        roastChart.data.datasets[0].data = [];
        roastChart.data.datasets[1].data = [];
        roastChart.data.datasets[3].data = [];
        eventAnnotations = [];
        rorEwma = 0;
        lastRORValue = null;
        lastRORTime = null;
      }
      if (enteringIdle) {
        roastChart.data.datasets[0].data = [];
        roastChart.data.datasets[1].data = [];
        roastChart.data.datasets[3].data = [];
        eventAnnotations = [];
        rorEwma = 0;
      }
      lastState = msg.state;

      // 仅在烘焙活跃阶段追加实时数据，防止 IDLE/COOLING 拖出异常连线
      if (msg.state === 'ROASTING') {
        const t = msg.elapsed || 0;
        appendChartData(0, t, msg.pv);
        appendChartData(1, t, msg.sv);

        // EWMA 平滑 ROR，跳过 2 秒内重复值
        if (msg.ror != null) {
          const shouldAppend = (msg.ror !== lastRORValue) || (t - (lastRORTime || 0) >= 2);
          if (shouldAppend) {
            rorEwma = ROR_EWMA_ALPHA * msg.ror + (1 - ROR_EWMA_ALPHA) * rorEwma;
            appendChartData(3, t, rorEwma);
            lastRORValue = msg.ror;
            lastRORTime = t;
          }
        }
        roastChart.update('none');
      } else if (msg.state === 'COOLING') {
        // COOLING 时只定格温度与 SV，不再追加 ROR
        const t = msg.elapsed || 0;
        appendChartData(0, t, msg.pv);
        appendChartData(1, t, msg.sv);
        roastChart.update('none');
      }
    } else {
      lastState = msg.state;
    }

    updateProgress(msg);
    updateButtonVisibility(msg.state);

    if (msg.events) {
      updateEventAnnotations(msg.events);
      updateEventTempsBar(msg.events);
      updateDevelopmentInfo(msg.events, msg.elapsed || 0, msg.pv);
    }
    // 根据 state.events 同步事件按钮 active 高亮 + 时间温度 badge
    syncEventActionsBar(msg.events || []);

    if (msg.event_stats) {
      updateSegmentBar(msg.event_stats);
    }

    // COOLING 状态弹窗确认保存（session-scoped，确保只弹一次）
    if (msg.state === 'COOLING' && msg.session_id && msg.session_id !== lastPromptedSessionId) {
      lastPromptedSessionId = msg.session_id;
      setTimeout(() => {
        const save = confirm('是否保存此锅烘焙记录？');
        if (save) {
          showToast('正在保存...');
          fetch('/api/v1/control/save_and_clear', { method: 'POST' }).catch(() => {});
        } else {
          // 点击不保存后立即乐观重置 UI，不等后端 WS 回包
          optimisticResetToIdle();
          fetch('/api/v1/control/discard_and_clear', { method: 'POST' }).catch(() => {});
        }
      }, 500);
    }

    currentSessionId = msg.session_id || currentSessionId;
  }

  // ========== ERROR 状态全屏阻断 ==========
  function showErrorOverlay(reason) {
    if (inErrorState) return;
    inErrorState = true;
    document.body.classList.add('error-active');
    const overlay = document.getElementById('error-overlay');
    const reasonEl = document.getElementById('error-reason');
    reasonEl.textContent = reason || '未知错误';
    overlay.classList.remove('hidden');
  }

  function hideErrorOverlay() {
    if (!inErrorState) return;
    inErrorState = false;
    document.body.classList.remove('error-active');
    document.getElementById('error-overlay').classList.add('hidden');
  }

  /**
   * 乐观重置：用户点击"不保存"后，前端立即回到待机状态
   * 不等待后端 WS 广播 IDLE，避免"正在等待保存确认"卡顿感
   */
  function optimisticResetToIdle() {
    lastPromptedSessionId = null;
    lastState = 'IDLE';
    currentSessionId = null;
    rorEwma = 0;
    lastRORValue = null;
    lastRORTime = null;

    // 清空实时曲线
    roastChart.data.datasets[0].data = [];
    roastChart.data.datasets[1].data = [];
    roastChart.data.datasets[3].data = [];
    eventAnnotations = [];
    roastChart.update('none');

    // 重置 UI 读数
    document.getElementById('state-badge').textContent = '待机';
    document.getElementById('state-badge').className = 'state-badge IDLE';
    // 同步 body 状态 class（清除 ROASTING/COOLING 残留以恢复出豆按钮静止态等）
    document.body.classList.remove('state-roasting', 'state-cooling', 'state-error');
    document.body.classList.add('state-idle');
    document.getElementById('elapsed').textContent = '00:00';
    document.getElementById('pv-val').textContent = '--';
    document.getElementById('sv-val').textContent = '--';
    document.getElementById('ror-val').textContent = '--';
    updateButtonVisibility('IDLE');

    // 清空事件与统计
    // 清空事件按钮 active 高亮 + badge（防止上锅残留）
    syncEventActionsBar([]);
    updateSegmentBar({ total_time: 0, segment_times: {}, segment_ratios: {} });

    // 清空顶部事件温度
    document.getElementById('yellowing-info').textContent = '--';
    document.getElementById('first-crack-info').textContent = '--';
    document.getElementById('development-info').textContent = '--';
  }

  function showToast(message) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      toast.className = 'app-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 1500);
  }

  function stateLabel(state) {
    const map = {
      IDLE: '待机',
      ROASTING: '烘焙中',
      COOLING: '烘焙结束',
      ERROR: '错误'
    };
    return map[state] || state;
  }

  function updateWsStatus(online) {
    const dot = document.getElementById('conn-status-ws');
    if (!dot) return;
    dot.classList.toggle('online', online);
    dot.classList.toggle('offline', !online);
  }
  function updateTc4sStatus(connected) {
    const dot = document.getElementById('conn-status-tc4s');
    if (!dot) return;
    dot.classList.toggle('online', connected);
    dot.classList.toggle('offline', !connected);
  }

  /**
   * 烘焙进度条
   * - 三段拼接（脱水蓝 / 梅纳橙 / 发展期红），按事件时间戳分配段宽，未到的段用默认 1:1:1
   * - 标签与发光指示器随当前阶段切换颜色，IDLE/COOLING/无曲线时优雅降级
   * - 进度位置用 transform: translateX 走合成层，避免 layout 抖动
   * - 不显示百分比数字
   * - 三层签名短路（结构/位置/时间文本），避免每帧重建 DOM/style 触发合成层 invalidation
   * @param {object} msg - WebSocket 状态广播对象
   */
  let lastStructureSig = '';
  let lastPositionSig  = '';
  let lastTimeText     = '';
  let lastPhaseLabel   = '';
  function updateProgress(msg) {
    const root  = document.getElementById('roast-progress-inline');
    if (!root) return;
    const segs  = root.querySelectorAll('.rpb-seg');
    const ind   = root.querySelector('.rpb-indicator');
    const lab   = document.getElementById('rpb-phase-label');
    const time  = document.getElementById('rpb-time');

    const phaseLabelMap = {
      drying: '脱水期',
      maillard: '梅纳期',
      development: '发展期',
      cooling: '冷却中',
      idle: '待机',
    };

    const totalProfile = (currentProfile && currentProfile.nodes && currentProfile.nodes.length)
      ? currentProfile.nodes[currentProfile.nodes.length - 1].time : 0;

    // ============ 非烘焙状态：清零段位 ============
    if (msg.state !== 'ROASTING' || !totalProfile) {
      let phaseKey = 'idle';
      if (msg.state === 'COOLING') phaseKey = 'cooling';

      // 结构签名：state 与 phaseKey 唯一决定 IDLE/COOLING 下的视觉结构
      const structureSig = `idle|${msg.state}|${phaseKey}`;
      if (structureSig !== lastStructureSig) {
        lastStructureSig = structureSig;
        // 清掉 ROASTING 阶段写入的位置签名缓存,使下次进入 ROASTING 时一定写一次 indicator
        lastPositionSig = '';
        if (root.dataset.phase !== phaseKey) root.dataset.phase = phaseKey;
        if (root.classList.contains('active')) root.classList.remove('active');
        root.style.setProperty('--rpb-cols', '1fr 1fr 1fr');
        segs.forEach(s => {
          if (s.classList.contains('active') || s.classList.contains('done')) {
            s.classList.remove('active', 'done');
          }
        });
        if (ind) {
          const tf = 'translate(-50%, -50%)';
          if (ind.style.transform !== tf) ind.style.transform = tf;
        }
      }

      const phaseLabel = phaseLabelMap[phaseKey] || '--';
      if (lab && lastPhaseLabel !== phaseLabel) {
        lab.textContent = phaseLabel;
        lastPhaseLabel = phaseLabel;
      }

      // 时间文本：IDLE/COOLING 下只在每秒边界变化
      const tt = msg.elapsed ? formatTime(msg.elapsed) : '--:--';
      if (time && tt !== lastTimeText) {
        time.textContent = tt;
        lastTimeText = tt;
      }
      return;
    }

    // ============ ROASTING 路径 ============
    const elapsed = Math.max(0, msg.elapsed || 0);

    // 段边界推断：优先用真实事件时间戳；缺失则按 profile 等比例兜底
    const events = Array.isArray(msg.events) ? msg.events : [];
    const yellowing  = events.find(e => e.type === 'yellowing');
    const firstCrack = events.find(e => e.type === 'first_crack');

    let dryingEnd    = yellowing  ? yellowing.time  : totalProfile / 3;
    let maillardEnd  = firstCrack ? firstCrack.time : totalProfile * 2 / 3;
    let totalEnd     = totalProfile;

    // 单调修正
    dryingEnd   = Math.max(0, Math.min(dryingEnd, totalEnd));
    maillardEnd = Math.max(dryingEnd + 0.1, Math.min(maillardEnd, totalEnd));

    const dryingW   = dryingEnd;
    const maillardW = maillardEnd - dryingEnd;
    const devW      = Math.max(0, totalEnd - maillardEnd);

    // 当前阶段
    let phaseKey = msg.current_phase || null;
    if (!phaseKey) {
      if (elapsed < dryingEnd)        phaseKey = 'drying';
      else if (elapsed < maillardEnd) phaseKey = 'maillard';
      else                             phaseKey = 'development';
    }
    const phaseAlias = {
      'drying': 'drying', '脱水期': 'drying', '脱水': 'drying',
      'maillard': 'maillard', '梅纳期': 'maillard', '美拉德': 'maillard', '梅纳': 'maillard',
      'development': 'development', '发展期': 'development', '发展': 'development',
    };
    phaseKey = phaseAlias[phaseKey] || 'drying';

    // ---------- 结构签名（不含 elapsed / ratio）----------
    // 同结构签名 → 跳过 cols / dataset.phase / classList / 段类切换
    const structureSig = [
      'roast', phaseKey,
      dryingW.toFixed(2), maillardW.toFixed(2), devW.toFixed(2),
      totalEnd.toFixed(2)
    ].join('|');
    if (structureSig !== lastStructureSig) {
      lastStructureSig = structureSig;
      const cols = `${dryingW}fr ${maillardW}fr ${devW}fr`;
      // 即便值未变也别写,浏览器即使值相同也可能重新匹配 selector
      root.style.setProperty('--rpb-cols', cols);
      if (root.dataset.phase !== phaseKey) root.dataset.phase = phaseKey;
      if (!root.classList.contains('active')) root.classList.add('active');

      // 段状态：当前段 active，先完成的段 done
      const order = ['drying', 'maillard', 'development'];
      const curIdx = order.indexOf(phaseKey);
      segs.forEach(s => {
        const p = s.dataset.phase;
        const idx = order.indexOf(p);
        const wantDone   = idx < curIdx;
        const wantActive = idx === curIdx;
        const hasDone   = s.classList.contains('done');
        const hasActive = s.classList.contains('active');
        if (hasDone !== wantDone)     s.classList.toggle('done',   wantDone);
        if (hasActive !== wantActive) s.classList.toggle('active', wantActive);
      });
    }

    // ---------- 位置签名（千分位精度）----------
    const ratio = totalEnd > 0 ? Math.max(0, Math.min(1, elapsed / totalEnd)) : 0;
    const positionSig = Math.round(ratio * 1000).toString();
    if (positionSig !== lastPositionSig) {
      lastPositionSig = positionSig;
      if (ind) {
        const track = ind.parentElement;
        const w = track ? track.clientWidth : 0;
        const x = ratio * w;
        const tf = `translate(${x.toFixed(2)}px, -50%)`;
        if (ind.style.transform !== tf) ind.style.transform = tf;
      }
    }

    // ---------- 阶段文本 ----------
    const phaseLabel = phaseLabelMap[phaseKey] || phaseKey;
    if (lab && phaseLabel !== lastPhaseLabel) {
      lab.textContent = phaseLabel;
      lastPhaseLabel = phaseLabel;
    }

    // ---------- 时间文本（mm:ss / mm:ss）----------
    // 0.5s 广播但 elapsed 至少 1s 才会让 mm:ss 文本变化,中间帧文本一致就别写
    const timeText = `${formatTime(elapsed)} / ${formatTime(totalEnd)}`;
    if (time && timeText !== lastTimeText) {
      time.textContent = timeText;
      lastTimeText = timeText;
    }
  }

  /**
   * 根据当前烘焙状态显示/隐藏控制按钮
   * 仅 IDLE 显示开始烘焙按钮；ROASTING 不展示中间按钮（drop 事件即结束烘焙）。
   * 紧急停止按钮固定在右下角嵌入小方框（.estop-box > .estop-btn），id 为 #btn-e-stop。
   * @param {string} state - 当前状态 (IDLE/ROASTING/COOLING/ERROR)
   */
  function updateButtonVisibility(state) {
    const btnStart = document.getElementById('btn-start');
    const btnEStop = document.getElementById('btn-e-stop');
    const roastGrid = document.getElementById('roast-btn-grid');
    const coolingGrid = document.getElementById('cooling-btn-grid');

    if (state === 'IDLE') {
      btnStart.style.display = '';
      roastGrid.style.display = '';
      coolingGrid.style.display = 'none';
      // IDLE 时禁用 e-stop（无可停止的对象）
      if (btnEStop) btnEStop.classList.add('disabled');
    } else if (state === 'ROASTING') {
      btnStart.style.display = 'none';
      roastGrid.style.display = 'none';
      coolingGrid.style.display = 'none';
      if (btnEStop) btnEStop.classList.remove('disabled');
    } else if (state === 'COOLING') {
      roastGrid.style.display = 'none';
      coolingGrid.style.display = '';
      if (btnEStop) btnEStop.classList.remove('disabled');
    } else {
      // ERROR 等其他状态：保持 e-stop 可用
      if (btnEStop) btnEStop.classList.remove('disabled');
    }
  }

  // ========== 阶段颜色条 ==========
  /**
   * 动态更新顶部阶段颜色条：根据事件统计显示/隐藏脱水期、梅纳期、发展期
   * 只有已记录的阶段才会显示，避免未到达阶段挤占空间
   * 签名短路：event_stats 每帧广播但只在事件触发时变化，静止帧完全跳过
   * style.flex / classList / textContent 写。
   * @param {object} stats - 后端计算的 event_stats 对象
   */
  let lastSegmentSig = '';
  function updateSegmentBar(stats) {
    const segments = [
      { key: '脱水期', el: 'seg-drying', valEl: 'seg-drying-val' },
      { key: '梅纳期', el: 'seg-maillard', valEl: 'seg-maillard-val' },
      { key: '发展期', el: 'seg-development', valEl: 'seg-development-val' },
    ];

    // 计算签名:每段的 time + ratio 决定视觉,未变则全部跳过
    const sigParts = segments.map(s => {
      const t = (stats.segment_times && stats.segment_times[s.key]);
      const r = (stats.segment_ratios && stats.segment_ratios[s.key]);
      return `${t == null ? '-' : t}|${r == null ? '-' : r}`;
    });
    const sig = sigParts.join(';');
    if (sig === lastSegmentSig) return;
    lastSegmentSig = sig;

    segments.forEach(s => {
      const time = stats.segment_times && stats.segment_times[s.key];
      const ratio = stats.segment_ratios && stats.segment_ratios[s.key];
      const el = document.getElementById(s.el);
      const valEl = document.getElementById(s.valEl);
      if (time != null && ratio != null) {
        const flexStr = String(time);
        if (el.style.flex !== flexStr) el.style.flex = flexStr;
        if (!el.classList.contains('active')) el.classList.add('active');
        if (el.classList.contains('hidden')) el.classList.remove('hidden');
        const txt = formatTime(time) + ' (' + ratio + '%)';
        if (valEl.textContent !== txt) valEl.textContent = txt;
      } else {
        if (el.style.flex !== '1') el.style.flex = '1';
        if (el.classList.contains('active')) el.classList.remove('active');
        if (!el.classList.contains('hidden')) el.classList.add('hidden');
        if (valEl.textContent !== '--') valEl.textContent = '--';
      }
    });
  }

  // ========== 顶部事件温度显示 ==========
  /**
   * 更新顶部事件温度条：显示转黄和一爆的时间与温度
   * @param {Array} events - 烘焙事件列表
   */
  function updateEventTempsBar(events) {
    const yellowing = events.find(e => e.type === 'yellowing');
    const firstCrack = events.find(e => e.type === 'first_crack');

    const yellowingEl = document.getElementById('yellowing-info');
    const firstCrackEl = document.getElementById('first-crack-info');

    if (yellowing && yellowing.temperature != null) {
      yellowingEl.textContent = `${formatTime(yellowing.time)} @ ${yellowing.temperature.toFixed(1)}°C`;
    } else {
      yellowingEl.textContent = '--';
    }

    if (firstCrack && firstCrack.temperature != null) {
      firstCrackEl.textContent = `${formatTime(firstCrack.time)} @ ${firstCrack.temperature.toFixed(1)}°C`;
    } else {
      firstCrackEl.textContent = '--';
    }
  }

  // ========== 发展期信息（一爆后直观展示） ==========
  function updateDevelopmentInfo(events, elapsed, currentTemp) {
    const firstCrack = events.find(e => e.type === 'first_crack');
    const devEl = document.getElementById('development-info');
    if (!firstCrack) {
      devEl.textContent = '--';
      return;
    }
    const deltaT = (currentTemp != null && firstCrack.temperature != null)
      ? `+${(currentTemp - firstCrack.temperature).toFixed(1)}°C`
      : '';
    const devTime = formatTime(elapsed - firstCrack.time);
    devEl.textContent = `${deltaT} · ${devTime}`;
  }

  function eventLabel(type) {
    const map = {
      charge: '入豆',
      yellowing: '转黄',
      first_crack: '一爆开始',
      first_crack_end: '一爆结束',
      second_crack: '二爆开始',
      second_crack_end: '二爆结束',
      drop: '出豆'
    };
    return map[type] || type;
  }

  // 阶段时长由顶部 #segment-bar 渲染（updateSegmentBar）。

  /**
   * 同步事件按钮 active 高亮 + 时间温度 badge。
   * - 命中 state.events 的按钮加 .active class，badge 显示 "m:ss · 温度°"
   * - 未命中（含 IDLE 时事件数组为空）则清空 badge 和 active class
   * - 短路 textContent / classList 写,避免每帧 6 个按钮无谓的 active 切换。
   * @param {Array} events - 后端广播的事件数组（空数组也合法）
   */
  function syncEventActionsBar(events) {
    const eventBar = document.getElementById('event-actions-bar');
    if (!eventBar) return;
    const list = Array.isArray(events) ? events : [];
    eventBar.querySelectorAll('[data-event]').forEach(btn => {
      const type = btn.dataset.event;
      const evt = list.find(e => e.type === type);
      let badge = btn.querySelector('.event-badge');
      if (!badge) {
        // 兜底：按钮缺 badge 子元素时动态补一个，保证向前/向后兼容
        badge = document.createElement('span');
        badge.className = 'event-badge';
        btn.appendChild(badge);
      }
      if (evt) {
        if (!btn.classList.contains('active')) btn.classList.add('active');
        const t = Number(evt.time) || 0;
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        const tempStr = (typeof evt.temperature === 'number' && isFinite(evt.temperature))
          ? `${evt.temperature.toFixed(0)}°`
          : '--°';
        const txt = `${m}:${String(s).padStart(2, '0')} · ${tempStr}`;
        if (badge.textContent !== txt) badge.textContent = txt;
      } else {
        if (btn.classList.contains('active')) btn.classList.remove('active');
        if (badge.textContent !== '') badge.textContent = '';
      }
    });
  }

  // ========== Tabs ==========
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'records') {
          loadRecords();
        }
      });
    });
  }

  // ========== 全屏 ==========
  function initFullscreen() {
    const btn = document.getElementById('btn-fullscreen');
    btn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  // ========== 曲线管理 ==========
  async function loadProfiles() {
    try {
      const res = await fetch('/api/v1/profiles');
      const list = await res.json();
      profileMap = {};
      list.forEach(p => {
        profileMap[p.id] = p;
      });
      if (list.length > 0) {
        // 保持原选择（若仍存在）；否则取第一项
        if (selectedProfileId && profileMap[selectedProfileId]) {
          // keep current selection
        } else {
          selectedProfileId = list[0].id;
        }
        await applySelectedProfile();
      } else {
        currentProfile = null;
      }
      // 同步当前曲线只读显示
      const displayEl = document.getElementById('current-profile-display');
      if (displayEl) {
        const activeProfile = profileMap[selectedProfileId];
        displayEl.textContent = activeProfile ? (activeProfile.name || '--') : '--';
      }
      await renderProfileCards(list);
    } catch (e) {
      showToast('加载曲线失败');
    }
  }

  async function renderProfileCards(list) {
    const container = document.getElementById('profile-cards');
    if (!container) return;
    if (!list || list.length === 0) {
      container.innerHTML = '<div style="color:#737373;text-align:center;padding:20px 0;grid-column:1/-1">暂无曲线，点击「新建曲线」创建</div>';
      return;
    }

    // 拉取每个 profile 的完整数据用于绘制 sparkline 与计算总时长
    const fullProfiles = await Promise.all(
      list.map(s => fetch('/api/v1/profiles/' + s.id).then(r => r.ok ? r.json() : null).catch(() => null))
    );

    // 缓存到 profileMap（覆盖摘要）
    fullProfiles.forEach(p => { if (p && p.id) profileMap[p.id] = p; });

    const activeId = selectedProfileId;

    container.innerHTML = fullProfiles.map((p, i) => {
      if (!p) {
        const s = list[i];
        return `<div class="profile-card" data-id="${s.id}">
          <div class="name">${escapeHtml(s.name || '未命名')}</div>
          <div class="meta">加载失败</div>
        </div>`;
      }
      const nodes = p.nodes || [];
      const total = nodes.length ? nodes[nodes.length - 1].time : 0;
      const m = Math.floor(total / 60);
      const sec = Math.floor(total % 60);
      const sparkline = buildSparklineSVG(nodes);
      const isActive = p.id === activeId ? 'active' : '';
      return `
        <div class="profile-card ${isActive}" data-id="${p.id}">
          <div class="name">${escapeHtml(p.name || '未命名')}</div>
          <div class="meta">${nodes.length} 节点 · ${m}:${String(sec).padStart(2,'0')}</div>
          ${sparkline}
          <div class="actions">
            <button class="ctrl-btn small primary" data-action="apply" data-id="${p.id}">应用</button>
            <button class="ctrl-btn small" data-action="export" data-id="${p.id}">导出</button>
            <button class="ctrl-btn small danger" data-action="delete" data-id="${p.id}">删除</button>
          </div>
        </div>
      `;
    }).join('');

    // 绑定按钮事件（事件委托到容器）
    container.querySelectorAll('.profile-card .actions button').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'apply') {
          selectedProfileId = id;
          await applySelectedProfile();
          updateProfileCardsActive();
          showToast('已应用曲线');
        } else if (action === 'export') {
          window.open('/api/v1/profiles/' + id + '/export', '_blank');
        } else if (action === 'delete') {
          const p = profileMap[id];
          if (!p) return;
          if (!confirm('确定要删除曲线「' + p.name + '」吗？')) return;
          try {
            const res = await fetch('/api/v1/profiles/' + id, { method: 'DELETE' });
            if (res.ok) {
              await loadProfiles();
            }
          } catch (err) {
            showToast('删除曲线失败');
          }
        }
      });
    });

    // 整张卡片点击 = 应用
    container.querySelectorAll('.profile-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = card.dataset.id;
        selectedProfileId = id;
        await applySelectedProfile();
        updateProfileCardsActive();
      });
    });
  }

  /**
   * 构建 SVG sparkline：把节点时间/温度归一化到 200x50 视区
   */
  function buildSparklineSVG(nodes) {
    if (!nodes || nodes.length < 2) {
      return '<svg class="sparkline" viewBox="0 0 200 50" preserveAspectRatio="none"></svg>';
    }
    const W = 200, H = 50, pad = 2;
    const tMin = nodes[0].time;
    const tMax = nodes[nodes.length - 1].time;
    const tempVals = nodes.map(n => n.temperature);
    const yMin = Math.min(...tempVals);
    const yMax = Math.max(...tempVals);
    const tSpan = tMax - tMin || 1;
    const ySpan = yMax - yMin || 1;
    const points = nodes.map(n => {
      const x = pad + (n.time - tMin) / tSpan * (W - 2 * pad);
      const y = (H - pad) - (n.temperature - yMin) / ySpan * (H - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke="#00e676" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  }

  function updateProfileCardsActive() {
    const activeId = selectedProfileId;
    document.querySelectorAll('.profile-card').forEach(card => {
      card.classList.toggle('active', card.dataset.id === activeId);
    });
  }

  async function applySelectedProfile() {
    const id = selectedProfileId;
    if (!id) return;
    try {
      const res = await fetch('/api/v1/profiles/' + id);
      if (!res.ok) return;
      currentProfile = await res.json();
      profileMap[id] = currentProfile;
      setProfileCurve(currentProfile.nodes || [], currentProfile?.name);
      // 同步当前曲线只读显示
      const displayEl = document.getElementById('current-profile-display');
      if (displayEl) {
        displayEl.textContent = currentProfile ? (currentProfile.name || '--') : '--';
      }
    } catch (e) {
      showToast('应用曲线失败');
    }
  }

  function initProfileEditor() {
    document.getElementById('btn-new-profile').addEventListener('click', () => {
      window.location.href = '/editor.html';
    });

    const goProfileLink = document.getElementById('btn-go-profile-tab');
    if (goProfileLink) {
      goProfileLink.addEventListener('click', function(e) {
        e.preventDefault();
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const profileBtn = document.querySelector('.tab-btn[data-tab="profile"]');
        if (profileBtn) profileBtn.classList.add('active');
        document.getElementById('tab-profile').classList.add('active');
        loadRecords();
      });
    }

    const refreshBtn = document.getElementById('btn-refresh-profiles');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        await loadProfiles();
        showToast('已刷新');
      });
    }

    const importTrigger = document.getElementById('btn-import-trigger');
    const importFile = document.getElementById('btn-import-file');
    importTrigger.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await fetch('/api/v1/profiles/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if (result.success) {
          await loadProfiles();
          selectedProfileId = result.id;
          await applySelectedProfile();
          updateProfileCardsActive();
        } else {
          alert('导入失败');
        }
      } catch (err) {
        alert('文件格式错误');
      }
      importFile.value = '';
    });
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  // ========== 超前预测阶段设置 ==========
  function initPhaseLookahead() {
    const phases = ['drying', 'maillard', 'development'];
    // 100ms setTimeout debounce（避免高频后端写入）
    // raf 在持续拖动下会发 ~60 cmd/s,后端每条都立即 broadcast,
    // 前端 handleStateUpdate 每帧 update chart,叠加 appendChartData 造成已记录曲线"被刷"。
    const sendDebounced = {};
    const defaults = { drying: 1.0, maillard: 0.5, development: 1.0 };

    phases.forEach(phase => {
      const numEl    = document.getElementById('phase-' + phase);
      const sliderEl = document.getElementById('phase-' + phase + '-slider');
      if (!numEl || !sliderEl) return;

      function commit(rawV, source) {
        let v = parseFloat(rawV);
        if (isNaN(v)) v = defaults[phase];
        // v3.18 上限延伸到 30 秒（前后端对齐）
        v = Math.max(0, Math.min(30, round1(v)));   // PITFALL #18 clamp+round1
        if (source !== 'num')    numEl.value    = v.toFixed(1);
        if (source !== 'slider') sliderEl.value = v.toFixed(1);
        if (sendDebounced[phase]) clearTimeout(sendDebounced[phase]);
        sendDebounced[phase] = setTimeout(() => {
          sendCmd('set_phase_lookahead', { phase, value: v });
          sendDebounced[phase] = null;
        }, 100);
      }

      sliderEl.addEventListener('input', () => {
        commit(sliderEl.value, 'slider');
      });
      numEl.addEventListener('input', () => {
        commit(numEl.value, 'num');
      });
      numEl.addEventListener('change', () => commit(numEl.value, 'num'));
    });
  }

  // ========== 偏移微调（相机 EV 曝光补偿风格） ==========
  /**
   * 把 [-3, +3] 的偏移量映射到刻度尺像素位置，用 transform:translateX 走合成层
   * 缓存上次写入的 transform 字符串，相同则跳过 style 写，避免合成层 invalidation
   * @param {number} v - 当前偏移值
   */
  let lastEvPointerTransform = '';
  function updateEvPointer(v) {
    const pointer = document.getElementById('ev-pointer');
    const scaleTrack = pointer && pointer.parentElement;
    if (!pointer || !scaleTrack) return;
    const w = scaleTrack.clientWidth || 0;
    if (w <= 0) return;
    const ratio = (Math.max(-3, Math.min(3, v)) + 3) / 6;     // 0..1
    // 三角形 14px 宽（border-left + border-right），尖端在元素水平中心 → -7 偏移让尖端对齐刻度
    const x = ratio * w - 7;
    const tf = `translateX(${x.toFixed(2)}px)`;
    if (tf === lastEvPointerTransform) return;
    lastEvPointerTransform = tf;
    pointer.style.transform = tf;
  }

  function initLookaheadOffset() {
    const sliderEl = document.getElementById('lookahead-offset-slider');
    const valueEl  = document.getElementById('lookahead-offset-value');
    const prefixEl = document.getElementById('ev-prefix');
    if (!sliderEl || !valueEl) return;
    // 100ms setTimeout debounce（避免高频后端写入造成已记录曲线视觉"被刷"）
    let sendTimer = null;

    function applyValue(v, fromUser) {
      v = Math.max(-3.0, Math.min(3.0, round1(v)));
      valueEl.textContent = Math.abs(v).toFixed(1);
      if (prefixEl) prefixEl.textContent = v > 0 ? '+' : (v < 0 ? '−' : '±');
      updateEvPointer(v);
      if (fromUser) {
        if (sendTimer) clearTimeout(sendTimer);
        sendTimer = setTimeout(() => {
          sendCmd('set_lookahead_offset', { value: v });
          sendTimer = null;
        }, 100);
      }
    }

    sliderEl.addEventListener('input', () => {
      let v = parseFloat(sliderEl.value);
      if (isNaN(v)) v = 0;
      applyValue(v, true);
    });

    // 初始指针位置（窗口尺寸就绪后）
    requestAnimationFrame(() => updateEvPointer(parseFloat(sliderEl.value) || 0));
    window.addEventListener('resize', () => {
      updateEvPointer(parseFloat(sliderEl.value) || 0);
    });
  }

  // ========== 防闪烁（PITFALLS #36）：拖动 slider 期间给 body 加 .dragging-slider，
  // 让 .roast-section / 进度条 transition 全部静默，避免触发 transition repaint
  // 与 #charts-panel canvas 在合成层间互相干扰 ==========
  function installSliderDragGuard() {
    const sliders = document.querySelectorAll(
      '.phase-slider, #lookahead-offset-slider'
    );
    let activeCount = 0;
    function start() {
      activeCount++;
      document.body.classList.add('dragging-slider');
    }
    function end() {
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) document.body.classList.remove('dragging-slider');
    }
    sliders.forEach(el => {
      el.addEventListener('pointerdown', start);
      el.addEventListener('pointerup',   end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
      // 兜底：blur/touchend 也清一次（部分树莓派触摸驱动可能漏 pointerup）
      el.addEventListener('touchend',    end);
      el.addEventListener('blur',        end);
    });

    // window 级强制兜底。极端情况下（用户在 slider 轨道外松手、
    // 触摸驱动漏事件、focus-trap 等）activeCount 可能漏 -1 → body class 长期残留。
    // 这里只要 body 还有 .dragging-slider，就强制清零并移除（不重复扣减 activeCount）。
    function forceCleanup() {
      if (document.body.classList.contains('dragging-slider')) {
        activeCount = 0;
        document.body.classList.remove('dragging-slider');
      }
    }
    window.addEventListener('pointerup',     forceCleanup, true);
    window.addEventListener('pointercancel', forceCleanup, true);
  }

  // ========== 触摸事件辅助函数 ==========
  function bindTouchClick(element, handler) {
    if (!element) return;
    let touched = false;
    element.addEventListener('touchstart', (e) => {
      touched = true;
      e.preventDefault();
      handler(e);
    }, { passive: false });
    element.addEventListener('click', (e) => {
      if (touched) {
        touched = false;
        return;
      }
      handler(e);
    });
  }

  // ========== 事件与流程控制 ==========
  function initControls() {
    bindTouchClick(document.getElementById('btn-start'), () => {
      const profileId = selectedProfileId;
      if (!profileId) { alert('请先选择一条曲线'); return; }
      sendCmd('start', { profile_id: profileId });
    });

    // 急停按钮：双击确认机制（v3.18：嵌入右下角 .estop-box 小方框，按钮自身仍是 #btn-e-stop）
    // ERROR 状态下短路双击确认,直接触发复位——错误横幅与右下角按钮认知冲突时,任一单击都能恢复。
    const eStopBtn = document.getElementById('btn-e-stop');
    bindTouchClick(eStopBtn, () => {
      // IDLE 时禁用急停
      if (eStopBtn.classList.contains('disabled')) return;
      if (inErrorState) {
        // ERROR 状态：直接复位,无需双击
        sendCmd('emergency_stop');
        return;
      }
      if (eStopConfirming) {
        // 第二次点击：执行急停
        clearTimeout(eStopConfirmTimer);
        eStopConfirming = false;
        eStopBtn.classList.remove('confirming');
        eStopBtn.textContent = 'E-STOP';
        sendCmd('emergency_stop');
      } else {
        // 第一次点击：进入确认状态
        eStopConfirming = true;
        eStopBtn.classList.add('confirming');
        eStopBtn.textContent = '再次确认';
        eStopConfirmTimer = setTimeout(() => {
          eStopConfirming = false;
          eStopBtn.classList.remove('confirming');
          eStopBtn.textContent = 'E-STOP';
        }, 2000);
      }
    });

    // 快捷事件操作栏（始终可见）
    document.querySelectorAll('#event-actions-bar .event-action-btn').forEach(btn => {
      bindTouchClick(btn, () => {
        // 已 active 的按钮拒绝重复触发，防止后端重复记录
        if (btn.classList.contains('active')) return;
        const type = btn.dataset.event;
        // drop 事件由后端自动触发结束烘焙，前端不再补发 end
        sendCmd('event', { type: type });
      });
    });

    // ERROR 复位按钮
    bindTouchClick(document.getElementById('btn-error-reset'), () => {
      sendCmd('emergency_stop');
      // 不主动隐藏 overlay，等待 handleStateUpdate 收到 state !== "ERROR" 后自然恢复
    });

    bindTouchClick(document.getElementById('btn-compare'), enterCompareMode);
    bindTouchClick(document.getElementById('btn-exit-compare'), exitCompareMode);
    bindTouchClick(document.getElementById('btn-back-to-list'), backToRecordList);

    const chartFsBtn = document.getElementById('btn-chart-fullscreen');
    if (chartFsBtn) {
      // 全屏切换：进入时显示右上 × 按钮，退出时隐藏
      const toggleRecordChartFullscreen = () => {
        const container = document.getElementById('record-chart-container');
        if (!container) return;
        const isFs = container.classList.toggle('record-chart-fullscreen');
        chartFsBtn.textContent = isFs ? '退出全屏' : '图表全屏';
        const exitBtn = document.getElementById('btn-chart-exit-fullscreen');
        if (exitBtn) exitBtn.hidden = !isFs;
        if (recordChart) {
          // 容器尺寸变化后让 Chart.js 重新计算
          setTimeout(() => recordChart.resize(), 50);
        }
      };
      bindTouchClick(chartFsBtn, toggleRecordChartFullscreen);

      const exitBtn = document.getElementById('btn-chart-exit-fullscreen');
      if (exitBtn) {
        bindTouchClick(exitBtn, () => {
          const container = document.getElementById('record-chart-container');
          if (container && container.classList.contains('record-chart-fullscreen')) {
            toggleRecordChartFullscreen();
          }
        });
      }

      // ESC 退出全屏：监听器仅注册一次
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const container = document.getElementById('record-chart-container');
        if (container && container.classList.contains('record-chart-fullscreen')) {
          toggleRecordChartFullscreen();
        }
      });
    }
  }

  // ========== 烘焙记录查看 ==========
  async function loadRecords() {
    const container = document.getElementById('records-list');
    container.innerHTML = '<div style="color:#737373;text-align:center;padding:20px 0">加载中...</div>';
    try {
      const res = await fetch('/api/v1/records');
      const list = await res.json();
      if (!list.length) {
        container.innerHTML = '<div style="color:#737373;text-align:center;padding:20px 0">暂无记录</div>';
        document.getElementById('btn-compare').style.display = 'none';
        return;
      }
      container.innerHTML = list.map(r => {
        const fallbackSeq = r.seq_no ? String(r.seq_no).padStart(3, '0') : '---';
        const displayName = r.display_name || ('log' + fallbackSeq);
        const profileName = r.profile_name || '未命名';
        const startedStr = r.started_at ? new Date(r.started_at).toLocaleString('zh-CN') : '--';
        return `
        <div class="record-item" data-session="${r.session_id}">
          <input type="checkbox" class="record-checkbox" data-session="${r.session_id}" ${selectedRecords.has(r.session_id) ? 'checked' : ''} />
          <div class="record-info">
            <div class="record-name">${escapeHtml(displayName)}</div>
            <div class="record-meta">${startedStr} · ${formatTime(r.duration_sec)} · ${escapeHtml(profileName)}</div>
          </div>
        </div>
      `;
      }).join('');

      // 复选框事件
      container.querySelectorAll('.record-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const sid = e.target.dataset.session;
          if (e.target.checked) {
            if (selectedRecords.size >= 2) {
              e.target.checked = false;
              alert('最多选择2条记录进行对比');
              return;
            }
            selectedRecords.add(sid);
          } else {
            selectedRecords.delete(sid);
          }
          document.getElementById('btn-compare').style.display = selectedRecords.size >= 2 ? '' : 'none';
        });
      });

      // 点击记录详情（不包括复选框）
      container.querySelectorAll('.record-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('record-checkbox')) return;
          showRecordDetail(el.dataset.session);
        });
      });

      document.getElementById('btn-compare').style.display = selectedRecords.size >= 2 ? '' : 'none';
    } catch (e) {
      container.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px 0">加载失败</div>';
    }
  }

  let recordChart = null;

  async function showRecordDetail(sessionId) {
    try {
      const res = await fetch('/api/v1/records/' + sessionId);
      if (!res.ok) return;
      const record = await res.json();

      // 隐藏列表，显示详情
      document.getElementById('records-list').style.display = 'none';
      document.getElementById('compare-actions').style.display = 'none';
      document.getElementById('record-detail').style.display = '';

      // 标题和日期
      const profileName = record.profile_name || record.profile_id || '未命名';
      const titleEl = document.getElementById('detail-profile-name');
      if (record.display_name) {
        titleEl.innerHTML = `${escapeHtml(record.display_name)} <span class="detail-profile-sub">${escapeHtml(profileName)}</span>`;
      } else {
        titleEl.textContent = profileName;
      }
      const startedAt = record.started_at ? new Date(record.started_at).toLocaleString('zh-CN') : '--';
      document.getElementById('detail-date').textContent = startedAt;

      // 统计信息
      const dur = record.data && record.data.length ? record.data[record.data.length - 1][0] : 0;
      const events = record.events || [];
      const charge = events.find(e => e.type === 'charge');
      const firstCrack = events.find(e => e.type === 'first_crack');
      const drop = events.find(e => e.type === 'drop');
      const yellowing = events.find(e => e.type === 'yellowing');

      let statsHtml = `<span>总时长: ${formatTime(dur)}</span>`;
      if (firstCrack && charge) {
        const dtr = drop
          ? ((drop.time - firstCrack.time) / (drop.time - charge.time) * 100).toFixed(1)
          : ((dur - firstCrack.time) / (dur - charge.time) * 100).toFixed(1);
        statsHtml += `<span>DTR: ${dtr}%</span>`;
      }
      if (yellowing && charge) {
        statsHtml += `<span>脱水期: ${formatTime(yellowing.time - charge.time)}</span>`;
      }
      if (firstCrack && yellowing) {
        statsHtml += `<span>梅纳期: ${formatTime(firstCrack.time - yellowing.time)}</span>`;
      }
      if (firstCrack) {
        const devEnd = drop ? drop.time : dur;
        statsHtml += `<span>发展期: ${formatTime(devEnd - firstCrack.time)}</span>`;
      }

      // 终温：以实际记录的最后一个采样点 BT 为准；data 缺失时回退到 record.end_temp
      const dataArr = Array.isArray(record.data) ? record.data : [];
      let actualEndTemp = null;
      if (dataArr.length > 0) {
        const last = dataArr[dataArr.length - 1];
        // record.data 元素格式：[time, bt(pv), env(sv), ror]
        actualEndTemp = Array.isArray(last) ? last[1] : (last && (last.bt ?? last.temperature));
      }
      if (actualEndTemp == null && record.end_temp != null) {
        actualEndTemp = record.end_temp;
      }
      statsHtml += `<span>终温: ${actualEndTemp != null ? actualEndTemp.toFixed(1) : '--'}°C</span>`;

      // 背景曲线快照信息
      if (record.profile_snapshot && record.profile_snapshot.nodes && record.profile_snapshot.nodes.length) {
        const snap = record.profile_snapshot;
        const snapNodes = snap.nodes;
        statsHtml += `<span>节点数: ${snapNodes.length}</span>`;
      }
      document.getElementById('detail-stats').innerHTML = statsHtml;

      // 事件列表（带颜色）
      const eventColors = {
        charge: '#22c55e',
        yellowing: '#f59e0b',
        first_crack: '#ef4444',
        first_crack_end: '#ef4444',
        second_crack: '#a855f7',
        second_crack_end: '#a855f7',
        drop: '#3b82f6'
      };
      document.getElementById('detail-events').innerHTML = events.map(e => {
        const color = eventColors[e.type] || '#a3a3a3';
        const tempStr = e.temperature != null ? ` @ ${e.temperature.toFixed(1)}°C` : '';
        // eventLabel 的 default 分支可能返回未知 type 原文,统一转义防 XSS
        return `<div class="detail-event-item">
          <span class="detail-event-dot" style="background:${color}"></span>
          <span class="detail-event-time">${formatTime(e.time)}</span>
          <span class="detail-event-name">${escapeHtml(eventLabel(e.type))}${escapeHtml(tempStr)}</span>
        </div>`;
      }).join('');

      // 绘制曲线
      renderRecordChart(record);

      // 导出按钮
      document.getElementById('btn-detail-csv').onclick = () => {
        window.open('/api/v1/records/' + sessionId + '/export/csv', '_blank');
      };
      document.getElementById('btn-detail-json').onclick = () => {
        window.open('/api/v1/records/' + sessionId + '/export/json', '_blank');
      };
    } catch (e) {
      showToast('加载记录详情失败');
    }
  }

  function renderRecordChart(record) {
    const ctx = document.getElementById('record-chart').getContext('2d');
    const data = record.data || [];
    const events = record.events || [];

    const pvData = data.map(d => ({ x: d[0], y: d[1] }));
    const svData = data.map(d => ({ x: d[0], y: d[2] }));
    const rorData = data.map(d => ({ x: d[0], y: d[3] }));

    // 背景曲线（来自 profile_snapshot）
    let bgData = [];
    const snap = record.profile_snapshot;
    if (snap && snap.nodes && snap.nodes.length >= 2) {
      bgData = splineInterpolate(snap.nodes, 5);
    }

    // 构建事件标注
    const eventAnnos = events.map(e => ({
      time: e.time,
      label: eventLabel(e.type),
      color: {
        charge: '#22c55e',
        yellowing: '#f59e0b',
        first_crack: '#ef4444',
        first_crack_end: '#ef4444',
        second_crack: '#a855f7',
        second_crack_end: '#a855f7',
        drop: '#3b82f6'
      }[e.type] || '#f59e0b'
    }));

    if (recordChart) {
      recordChart.destroy();
    }

    const datasets = [
      {
        label: '温度',
        data: pvData,
        borderColor: '#00e676',
        backgroundColor: '#00e676',
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
        yAxisID: 'y',
      },
      {
        label: '设定温度',
        data: svData,
        borderColor: '#ff5252',
        backgroundColor: '#ff5252',
        borderDash: [6, 4],
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 1.5,
        yAxisID: 'y',
      },
      {
        label: 'ROR',
        data: rorData,
        borderColor: '#448aff',
        backgroundColor: 'rgba(68,138,255,0.08)',
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 1.5,
        fill: true,
        yAxisID: 'y1',
      }
    ];

    if (bgData.length) {
      datasets.push({
        label: '背景曲线',
        data: bgData,
        borderColor: '#a3a3a3',
        backgroundColor: 'transparent',
        borderDash: [4, 4],
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 1.5,
        yAxisID: 'y',
      });
    }

    recordChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: '#e5e5e5',
              font: { size: 13, weight: '500' },
              usePointStyle: true,
              pointStyle: 'rectRounded',
              boxWidth: 24,
              boxHeight: 12,
              padding: 16,
            }
          },
          tooltip: {
            enabled: true,
            mode: 'index',
            intersect: false,
            filter: function(context) {
              // 记录图表：背景曲线(dataset[3])始终显示；其他只在有数据范围内显示
              if (context.datasetIndex === 3) return true;
              const data = context.chart.data.datasets[context.datasetIndex].data;
              if (!data || data.length === 0) return false;
              const xMin = data[0].x !== undefined ? data[0].x : data[0].t;
              const xMax = data[data.length - 1].x !== undefined ? data[data.length - 1].x : data[data.length - 1].t;
              const x = context.parsed.x !== undefined ? context.parsed.x : context.parsed.t;
              return x >= xMin && x <= xMax;
            },
            callbacks: {
              title: (items) => {
                if (!items || !items.length) return '';
                const sec = items[0].parsed.x;
                if (sec == null || Number.isNaN(sec)) return '';
                const m = Math.floor(sec / 60);
                const s = Math.floor(sec % 60);
                return `${m}:${String(s).padStart(2, '0')}`;
              },
              label: (item) => {
                const ds = item.dataset.label || '';
                const v = item.parsed.y;
                if (v == null || Number.isNaN(v)) return '';
                if (ds.includes('ROR')) return `${ds}: ${v.toFixed(1)} °C/min`;
                return `${ds}: ${v.toFixed(1)} °C`;
              }
            }
          },
          eventLines: { annotations: eventAnnos }
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: '时间 (min)', color: '#a3a3a3', font: { size: 11 } },
            grid: { color: '#1f1f1f' },
            ticks: {
              color: '#a3a3a3',
              callback: function(value) {
                const m = Math.floor(value / 60);
                const s = Math.floor(value % 60);
                return `${m}:${String(s).padStart(2,'0')}`;
              }
            }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            min: 0,
            max: 300,
            title: { display: true, text: '温度 (°C)', color: '#a3a3a3', font: { size: 11 } },
            grid: { color: '#1f1f1f' },
            ticks: { color: '#a3a3a3' }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'ROR (°C/min)', color: '#a3a3a3', font: { size: 11 } },
            grid: { drawOnChartArea: false },
            ticks: { color: '#60a5fa' },
            suggestedMin: -5,
            suggestedMax: 25
          }
        }
      }
    });
  }

  function backToRecordList() {
    document.getElementById('record-detail').style.display = 'none';
    document.getElementById('records-list').style.display = '';
    document.getElementById('compare-actions').style.display = '';
    const container = document.getElementById('record-chart-container');
    if (container) {
      container.classList.remove('record-chart-fullscreen');
      const fsBtn = document.getElementById('btn-chart-fullscreen');
      if (fsBtn) fsBtn.textContent = '图表全屏';
      const exitBtn = document.getElementById('btn-chart-exit-fullscreen');
      if (exitBtn) exitBtn.hidden = true;
    }
    if (recordChart) {
      recordChart.destroy();
      recordChart = null;
    }
  }

  // ========== 烘焙日志对比 ==========
  /**
   * 进入对比模式：加载选中的两条历史记录，在主图表上以橙色/紫色叠加显示温度曲线
   * 隐藏实时数据、背景曲线和ROR，仅显示两条历史温度曲线
   */
  async function enterCompareMode() {
    if (selectedRecords.size < 2) return;
    const sids = Array.from(selectedRecords);
    try {
      const [res1, res2] = await Promise.all([
        fetch('/api/v1/records/' + sids[0]),
        fetch('/api/v1/records/' + sids[1])
      ]);
      const r1 = await res1.json();
      const r2 = await res2.json();

      // 记录A温度曲线（橙色）
      safeUpdateDataset(roastChart, 0, (r1.data || []).map(d => ({ x: d[0], y: d[1] })));
      roastChart.data.datasets[0].label = '记录A';
      roastChart.data.datasets[0].borderColor = '#ff9800';
      roastChart.data.datasets[0].backgroundColor = '#ff9800';

      // 记录B温度曲线（紫色）
      safeUpdateDataset(roastChart, 1, (r2.data || []).map(d => ({ x: d[0], y: d[1] })));
      roastChart.data.datasets[1].label = '记录B';
      roastChart.data.datasets[1].borderColor = '#e040fb';
      roastChart.data.datasets[1].backgroundColor = '#e040fb';
      roastChart.data.datasets[1].borderDash = [];

      // 隐藏背景曲线、ROR 和 ROR 预览
      roastChart.data.datasets[2].data.length = 0;
      roastChart.data.datasets[2].label = '目标曲线';
      roastChart.data.datasets[3].data.length = 0;
      roastChart.data.datasets[4].data.length = 0;
      eventAnnotations = [];

      roastChart.update('none');
      compareMode = true;
      document.getElementById('btn-compare').style.display = 'none';
      document.getElementById('btn-exit-compare').style.display = '';
    } catch (e) {
      showToast('加载对比记录失败');
    }
  }

  /**
   * 退出对比模式：恢复图表到实时烘焙显示状态，重置数据集颜色和标签
   */
  function exitCompareMode() {
    // 恢复实时显示模式
    roastChart.data.datasets[0].data.length = 0;
    roastChart.data.datasets[0].label = '温度';
    roastChart.data.datasets[0].borderColor = '#00e676';
    roastChart.data.datasets[0].backgroundColor = '#00e676';

    roastChart.data.datasets[1].data.length = 0;
    roastChart.data.datasets[1].label = '设定温度';
    roastChart.data.datasets[1].borderColor = '#ff5252';
    roastChart.data.datasets[1].backgroundColor = '#ff5252';
    roastChart.data.datasets[1].borderDash = [6, 4];

    // 恢复背景曲线
    if (currentProfile) {
      setProfileCurve(currentProfile.nodes || [], currentProfile?.name);
    }

    roastChart.data.datasets[3].data.length = 0;
    roastChart.update('none');
    compareMode = false;
    document.getElementById('btn-compare').style.display = selectedRecords.size >= 2 ? '' : 'none';
    document.getElementById('btn-exit-compare').style.display = 'none';
  }

  // ========== 时钟 ==========
  function updateClock() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  }

  // ========== 启动 ==========
  document.addEventListener('DOMContentLoaded', async () => {
    initCharts();
    initTabs();
    initFullscreen();
    initProfileEditor();
    initPhaseLookahead();
    initLookaheadOffset();
    installSliderDragGuard();
    initControls();
    connectWS();
    await loadProfiles();
    setInterval(updateClock, 1000);
    updateClock();
  });
})();
