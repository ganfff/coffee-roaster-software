(function() {
  'use strict';

  // ========== 全局状态 ==========
  let ws = null;
  let reconnectTimer = null;
  let currentProfile = null;
  let activeRoastProfile = null;
  let activeRoastProfileId = null;
  let activeRoastProfileName = null;
  let activeRoastProfileFetchId = null;
  let activeRoastProfileRequestSeq = 0;
  let profileCurveKey = '';
  let profileMap = {};
  let roastChart = null;
  const MAX_POINTS = 2400;
  let eventAnnotations = [];
  let lastState = 'IDLE';
  let latestState = 'IDLE';
  let lastBodyState = null; // 缓存上次写入 body 的状态 class,避免每帧 remove/add 触发样式重算
  let lastEventsSig = '';   // 缓存上次 events 签名,events 未变时跳过 eventAnnotations 重建 + chart.update
  let lastPromptedSessionId = null;
  let lastOfflineCommandToastAt = 0;
  let compareMode = false;
  let lastDeltaColor = '';
  let selectedRecords = new Set();
  let selectedProfileId = null;

  // 急停按钮双击确认状态
  let eStopConfirmTimer = null;
  let eStopConfirming = false;

  // ERROR 状态标记
  let inErrorState = false;

  // ROR 前端 EWMA 平滑（α 可在设置页调整）
  let rorEwma = 0;
  let ROR_EWMA_ALPHA = 0.3;

  // Artisan 风格辅助：回温点自动检测 / 接近结束提醒 / 自动标记 / 自定义报警
  let tpTime = null, tpTemp = null, minPv = null, minPvTime = null;
  let endApproachAlerted = false;
  let lastProjectionSig = '';
  const AUTO_DEFAULTS = { autoDryEnabled: false, autoDryTemp: 150, autoFCsEnabled: false, autoFCsTemp: 200 };
  const UI_DEFAULTS = { sound: true, scale: 100, rorAlpha: 0.3, projectionSec: 60, alertOffsetC: 10 };
  let autoCfg = { ...AUTO_DEFAULTS };
  let uiCfg = { ...UI_DEFAULTS };
  let alarms = [];
  let firedAlarms = new Set();

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('roaster.settings') || '{}'); } catch (e) {}
    // 兼容旧键 roaster.automation
    let legacy = {};
    try { legacy = JSON.parse(localStorage.getItem('roaster.automation') || '{}'); } catch (e) {}
    autoCfg = { ...AUTO_DEFAULTS, ...(legacy.auto || {}), ...(s.auto || {}) };
    alarms = Array.isArray(s.alarms) ? s.alarms : (Array.isArray(legacy.alarms) ? legacy.alarms : []);
    uiCfg = { ...UI_DEFAULTS, ...(s.ui || {}) };
    ROR_EWMA_ALPHA = uiCfg.rorAlpha;
  }

  function saveSettings() {
    try {
      localStorage.setItem('roaster.settings', JSON.stringify({ auto: autoCfg, alarms, ui: uiCfg }));
    } catch (e) { /* 隐私模式等 */ }
  }

  function applyUiScale() {
    try { document.body.style.zoom = uiCfg.scale + '%'; } catch (e) {}
  }

  let audioCtx = null;
  function beep(force) {
    if (!force && !uiCfg.sound) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.6);
    } catch (e) { /* 无音频设备时静默 */ }
  }

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
        ctx.strokeStyle = ann.color || chartPalette.eventDefault;
        ctx.moveTo(xPos, y.top);
        ctx.lineTo(xPos, y.bottom);
        ctx.stroke();
        const text = ann.label;
        ctx.font = '11px ' + (chartPalette.fontMono || 'monospace');
        const textWidth = ctx.measureText(text).width;
        const padding = 4;
        const labelY = y.top + 6;
        ctx.fillStyle = chartPalette.eventLabelBg || 'rgba(10,10,10,0.82)';
        ctx.fillRect(xPos + 4, labelY, textWidth + padding * 2, 16);
        ctx.fillStyle = ann.color || chartPalette.eventDefault;
        ctx.fillText(text, xPos + 4 + padding, labelY + 12);
      });
      ctx.restore();
    }
  };
  Chart.register(eventLinesPlugin);

  // ========== 主题色板(Chart.js / canvas 颜色与 theme.css 令牌同源) ==========
  // refreshChartPalette 在 initCharts 与 'roaster-themechange' 时重读 CSS 变量;
  // 事件插件在绘制时实时引用 chartPalette,换主题后下一帧自然生效。
  let chartPalette = {};

  function refreshChartPalette() {
    chartPalette = {
      fontUi: cssVar('--font-ui', 'sans-serif'),
      fontMono: cssVar('--font-mono', 'monospace'),
      grid: cssVar('--chart-grid', '#1f1f1f'),
      tick: cssVar('--chart-tick', '#a3a3a3'),
      legend: cssVar('--chart-legend', '#e5e5e5'),
      temp: cssVar('--chart-temp', '#00e676'),
      setpoint: cssVar('--chart-setpoint', '#ff5252'),
      target: cssVar('--chart-target', '#9e9e9e'),
      targetFill: cssVar('--chart-target-fill', 'rgba(158,158,158,0.06)'),
      ror: cssVar('--chart-ror', '#448aff'),
      rorFill: cssVar('--chart-ror-fill', 'rgba(68,138,255,0.12)'),
      rorPreview: cssVar('--chart-ror-preview', '#82b1ff'),
      projection: cssVar('--chart-projection', 'rgba(0,230,118,0.45)'),
      y1Tick: cssVar('--chart-y1-tick', '#60a5fa'),
      compareA: cssVar('--chart-compare-a', '#ff9800'),
      compareB: cssVar('--chart-compare-b', '#e040fb'),
      eventLabelBg: cssVar('--chart-event-label-bg', 'rgba(10,10,10,0.82)'),
      tooltipBg: cssVar('--chart-tooltip-bg', 'rgba(24,24,27,0.96)'),
      tooltipBorder: cssVar('--chart-tooltip-border', 'rgba(255,255,255,0.1)'),
      tooltipText: cssVar('--chart-tooltip-text', '#f5f5f7'),
      eventDefault: cssVar('--event-yellowing', '#f59e0b'),
      eventColors: {
        charge: cssVar('--event-charge', '#22c55e'),
        yellowing: cssVar('--event-yellowing', '#f59e0b'),
        first_crack: cssVar('--event-first-crack', '#ef4444'),
        first_crack_end: cssVar('--event-first-crack', '#ef4444'),
        second_crack: cssVar('--event-second-crack', '#a855f7'),
        second_crack_end: cssVar('--event-second-crack', '#a855f7'),
        drop: cssVar('--event-drop', '#3b82f6'),
        tp: cssVar('--event-tp', '#26a69a')
      },
      deltaGood: cssVar('--delta-good', '#22c55e'),
      deltaWarn: cssVar('--delta-warn', '#f97316'),
      deltaInfo: cssVar('--delta-info', '#3b82f6')
    };
  }

  function eventColor(type) {
    return (chartPalette.eventColors && chartPalette.eventColors[type]) || chartPalette.eventDefault || '#f59e0b';
  }

  // ========== Chart.js 初始化 ==========
  function initCharts() {
    refreshChartPalette();
    Chart.defaults.color = chartPalette.tick;
    Chart.defaults.borderColor = chartPalette.grid;
    Chart.defaults.font.family = chartPalette.fontUi;

    const ctx = document.getElementById('roast-chart').getContext('2d');
    roastChart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: '温度',
            data: [],
            borderColor: chartPalette.temp,
            backgroundColor: chartPalette.temp,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2.5,
            yAxisID: 'y',
          },
          {
            label: '设定温度',
            data: [],
            borderColor: chartPalette.setpoint,
            backgroundColor: chartPalette.setpoint,
            borderDash: [6, 4],
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
            yAxisID: 'y',
          },
          {
            label: '目标曲线',
            data: [],
            borderColor: chartPalette.target,
            backgroundColor: chartPalette.targetFill,
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
            borderColor: chartPalette.ror,
            backgroundColor: chartPalette.rorFill,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
            fill: true,
            yAxisID: 'y1',
          },
          {
            label: 'ROR 预览',
            data: [],
            borderColor: chartPalette.rorPreview,
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false,
            yAxisID: 'y1',
          },
          {
            label: '预测',
            data: [],
            borderColor: chartPalette.projection,
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            tension: 0,
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false,
            yAxisID: 'y',
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
              color: chartPalette.legend,
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
            backgroundColor: chartPalette.tooltipBg,
            titleColor: chartPalette.tooltipText,
            bodyColor: chartPalette.tooltipText,
            borderColor: chartPalette.tooltipBorder,
            borderWidth: 1,
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
            title: { display: true, text: '时间 (min)', color: chartPalette.tick, font: { size: 12 } },
            grid: { color: chartPalette.grid },
            ticks: {
              color: chartPalette.tick,
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
            title: { display: true, text: '温度 (°C)', color: chartPalette.tick, font: { size: 12 } },
            grid: { color: chartPalette.grid },
            ticks: { color: chartPalette.tick }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'ROR (°C/min)', color: chartPalette.tick, font: { size: 12 } },
            grid: { drawOnChartArea: false },
            ticks: { color: chartPalette.y1Tick },
            suggestedMin: -5,
            suggestedMax: 25
          },
        }
      }
    });
  }

  /**
   * tooltip 配色随主题写入(两张图共用)。
   */
  function applyTooltipTheme(tip) {
    if (!tip) return;
    tip.backgroundColor = chartPalette.tooltipBg;
    tip.titleColor = chartPalette.tooltipText;
    tip.bodyColor = chartPalette.tooltipText;
    tip.borderColor = chartPalette.tooltipBorder;
    tip.borderWidth = 1;
  }

  /**
   * 主题切换后给常驻图表原地换色:只改颜色配置并 update('none'),
   * 不触碰数据、动画与交互配置(PITFALLS #33/#43)。
   * 事件标注对象带 annType,颜色可无损重映射。
   */
  function applyChartTheme() {
    refreshChartPalette();
    const p = chartPalette;
    Chart.defaults.color = p.tick;
    Chart.defaults.borderColor = p.grid;

    if (roastChart) {
      const ds = roastChart.data.datasets;
      // 全部数据集先按常规色板重染(compare 模式只清 ds[2..5] 的数据不清颜色,
      // 不无条件重染会导致退出 compare 后残留旧主题色),compare 模式再覆盖 ds[0]/ds[1]
      ds[0].borderColor = p.temp;      ds[0].backgroundColor = p.temp;
      ds[1].borderColor = p.setpoint;  ds[1].backgroundColor = p.setpoint;
      ds[2].borderColor = p.target;    ds[2].backgroundColor = p.targetFill;
      ds[3].borderColor = p.ror;       ds[3].backgroundColor = p.rorFill;
      ds[4].borderColor = p.rorPreview;
      ds[5].borderColor = p.projection;
      if (compareMode) {
        ds[0].borderColor = p.compareA; ds[0].backgroundColor = p.compareA;
        ds[1].borderColor = p.compareB; ds[1].backgroundColor = p.compareB;
      }
      roastChart.options.plugins.legend.labels.color = p.legend;
      applyTooltipTheme(roastChart.options.plugins.tooltip);
      const sx = roastChart.options.scales.x;
      const sy = roastChart.options.scales.y;
      const sy1 = roastChart.options.scales.y1;
      sx.title.color = p.tick;  sx.grid.color = p.grid;  sx.ticks.color = p.tick;
      sy.title.color = p.tick;  sy.grid.color = p.grid;  sy.ticks.color = p.tick;
      sy1.title.color = p.tick; sy1.ticks.color = p.y1Tick;
      eventAnnotations.forEach(a => { a.color = eventColor(a.annType); });
      roastChart.update('none');
    }

    if (recordChart) {
      // renderRecordChart 数据集顺序:0 温度 / 1 设定 / 2 ROR / [3 背景曲线]
      const ds = recordChart.data.datasets;
      if (ds[0]) { ds[0].borderColor = p.temp;     ds[0].backgroundColor = p.temp; }
      if (ds[1]) { ds[1].borderColor = p.setpoint; ds[1].backgroundColor = p.setpoint; }
      if (ds[2]) { ds[2].borderColor = p.ror;      ds[2].backgroundColor = p.rorFill; }
      if (ds[3]) { ds[3].borderColor = p.target; }
      if (recordChart.options.plugins.legend) {
        recordChart.options.plugins.legend.labels.color = p.legend;
      }
      applyTooltipTheme(recordChart.options.plugins.tooltip);
      const s = recordChart.options.scales;
      if (s.x)  { s.x.title.color = p.tick;  s.x.grid.color = p.grid;  s.x.ticks.color = p.tick; }
      if (s.y)  { s.y.title.color = p.tick;  s.y.grid.color = p.grid;  s.y.ticks.color = p.tick; }
      if (s.y1) { s.y1.title.color = p.tick; s.y1.ticks.color = p.y1Tick; }
      const ann = recordChart.options.plugins.eventLines && recordChart.options.plugins.eventLines.annotations;
      if (Array.isArray(ann)) ann.forEach(a => { a.color = eventColor(a.annType); });
      recordChart.update('none');
    }
  }

  /**
   * 同一秒内只保留最新有效值，减少广播重复点造成的重绘。
   */
  function appendRealtimePoint(datasetIndex, x, y) {
    if (y == null || Number.isNaN(y)) return false;
    const ds = roastChart.data.datasets[datasetIndex].data;
    const last = ds[ds.length - 1];
    if (last && last.x === x) {
      if (last.y === y) return false;
      last.y = y;
      return true;
    }
    ds.push({ x, y });
    if (ds.length > MAX_POINTS) ds.shift();
    return true;
  }

  /**
   * 只在确实清空了数据时触发图表更新。
   */
  function clearDatasetIfNeeded(datasetIndex) {
    const ds = roastChart.data.datasets[datasetIndex].data;
    if (!ds.length) return false;
    ds.length = 0;
    return true;
  }

  /**
   * 避免高频广播重复触发文本节点重排。
   */
  function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  /**
   * 烘焙活跃期以后端锁定曲线为准，避免本地选中项影响当前锅显示。
   */
  function isRoastActiveState(state) {
    return state === 'ROASTING' || state === 'COOLING';
  }

  /**
   * profile_id 是 URL path segment，必须编码后再拼接 REST 端点。
   */
  function profileEndpoint(id) {
    return '/api/v1/profiles/' + encodeURIComponent(String(id));
  }

  /**
   * data-* 属性仍走字符串模板时需要转义引号，避免 id 破坏属性边界。
   */
  function escapeAttr(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, ch => map[ch]);
  }

  /**
   * 活跃烘焙按后端 profile_id 拉取曲线，但不改变本地待机选中项。
   */
  async function fetchProfileById(id) {
    const res = await fetch(profileEndpoint(id));
    if (!res.ok) return null;
    return await res.json();
  }

  /**
   * 曲线来源签名用于避免 WebSocket 静止帧重复重建目标曲线数据集。
   */
  function buildProfileCurveKey(profile, source) {
    const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
    const first = nodes[0] || {};
    const last = nodes[nodes.length - 1] || {};
    return [
      source,
      profile?.id || '',
      profile?.name || '',
      nodes.length,
      first.time ?? '',
      first.temperature ?? '',
      last.time ?? '',
      last.temperature ?? ''
    ].join('|');
  }

  /**
   * 没有可用曲线时必须清掉目标温度与 ROR 预览，防止旧曲线残留。
   */
  function clearProfilePreview() {
    if (!roastChart) return;
    let dirty = false;
    dirty = clearDatasetIfNeeded(2) || dirty;
    dirty = clearDatasetIfNeeded(4) || dirty;
    if (roastChart.data.datasets[2].label !== '目标曲线') {
      roastChart.data.datasets[2].label = '目标曲线';
      dirty = true;
    }
    if (roastChart.options.scales.x.suggestedMax !== 600) {
      roastChart.options.scales.x.suggestedMax = 600;
      dirty = true;
    }
    profileCurveKey = 'empty';
    if (dirty) roastChart.update('none');
  }

  /**
   * 只在来源真的变化时更新目标曲线，降低状态广播下的图表扰动。
   */
  function showProfileCurve(profile, source) {
    if (!profile || !Array.isArray(profile.nodes) || !profile.nodes.length) {
      clearProfilePreview();
      return false;
    }
    const key = buildProfileCurveKey(profile, source);
    if (key === profileCurveKey) return false;
    profileCurveKey = key;
    setProfileCurve(profile.nodes || [], profile.name);
    return true;
  }

  /**
   * 图表/进度条在活跃烘焙期读取后端曲线，待机期读取本地选中曲线。
   */
  function getProfileForState(state) {
    return isRoastActiveState(state) ? activeRoastProfile : currentProfile;
  }

  /**
   * 当前曲线标签必须跟随实际显示来源，避免用户误判当前锅使用的曲线。
   */
  function updateCurrentProfileDisplay(state) {
    const displayEl = document.getElementById('current-profile-display');
    if (!displayEl) return;
    if (isRoastActiveState(state)) {
      const name = activeRoastProfileName || activeRoastProfile?.name || (activeRoastProfileId ? `曲线 ${activeRoastProfileId}` : '--');
      setTextIfChanged(displayEl, name || '--');
      return;
    }
    const localProfile = currentProfile || (selectedProfileId ? profileMap[selectedProfileId] : null);
    setTextIfChanged(displayEl, localProfile ? (localProfile.name || '--') : '--');
  }

  /**
   * 状态切换后恢复该状态应该看到的曲线来源。
   */
  function restoreProfileCurveForState(state) {
    const profile = getProfileForState(state);
    if (profile) {
      showProfileCurve(profile, isRoastActiveState(state) ? 'active' : 'selected');
    } else {
      clearProfilePreview();
    }
  }

  /**
   * 曲线库为空时彻底清理本地选择与预览，避免旧选择继续显示。
   */
  function clearSelectedProfileState() {
    selectedProfileId = null;
    currentProfile = null;
    clearProfilePreview();
    const displayEl = document.getElementById('current-profile-display');
    setTextIfChanged(displayEl, '--');
    updateProfileCardsActive();
  }

  /**
   * 活跃烘焙的曲线以状态广播中的 profile_id/profile_name 为唯一显示来源。
   */
  function syncActiveRoastProfile(msg) {
    const state = msg.state;
    if (!isRoastActiveState(state)) {
      const hadActiveProfile = activeRoastProfile || activeRoastProfileId || activeRoastProfileName;
      activeRoastProfile = null;
      activeRoastProfileId = null;
      activeRoastProfileName = null;
      activeRoastProfileFetchId = null;
      activeRoastProfileRequestSeq++;
      updateCurrentProfileDisplay(state);
      if (hadActiveProfile) restoreProfileCurveForState(state);
      return;
    }

    const backendId = msg.profile_id != null ? String(msg.profile_id) : null;
    const backendName = msg.profile_name != null ? String(msg.profile_name) : '';
    if (backendId !== activeRoastProfileId) {
      activeRoastProfile = null;
      activeRoastProfileFetchId = null;
      activeRoastProfileRequestSeq++;
    }
    activeRoastProfileId = backendId;
    activeRoastProfileName = backendName;
    updateCurrentProfileDisplay(state);

    if (!backendId) {
      clearProfilePreview();
      return;
    }
    if (activeRoastProfile && String(activeRoastProfile.id) === backendId) {
      showProfileCurve(activeRoastProfile, 'active');
      updateCurrentProfileDisplay(state);
      return;
    }
    if (currentProfile && String(currentProfile.id) === backendId) {
      activeRoastProfile = currentProfile;
      showProfileCurve(activeRoastProfile, 'active');
      updateCurrentProfileDisplay(state);
      return;
    }
    const cached = profileMap[backendId];
    if (cached && Array.isArray(cached.nodes)) {
      activeRoastProfile = cached;
      showProfileCurve(activeRoastProfile, 'active');
      updateCurrentProfileDisplay(state);
      return;
    }

    clearProfilePreview();
    if (activeRoastProfileFetchId === backendId) return;
    activeRoastProfileFetchId = backendId;
    const requestSeq = ++activeRoastProfileRequestSeq;
    fetchProfileById(backendId)
      .then(profile => {
        if (requestSeq !== activeRoastProfileRequestSeq) return;
        if (!isRoastActiveState(latestState) || activeRoastProfileId !== backendId) return;
        if (!profile) return;
        activeRoastProfile = profile;
        profileMap[backendId] = profile;
        showProfileCurve(activeRoastProfile, 'active');
        updateCurrentProfileDisplay(latestState);
        updateProfileCardsActive();
      })
      .catch(() => {});
  }

  /**
   * 安全更新 Chart.js 数据集
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

    eventAnnotations = list.map(e => ({
      time: e.time,
      label: eventLabel(e.type),
      color: eventColor(e.type),
      annType: e.type
    }));
    // 回温点（前端自动检测）一并标注
    if (tpTime != null) {
      eventAnnotations.push({ time: tpTime, label: '回温点', color: eventColor('tp'), annType: 'tp' });
    }
    if (roastChart) roastChart.update('none');
  }

  // ========== WebSocket ==========
  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onopen = () => updateWsStatus(true);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      // 命令回包不进入状态解析，避免配置命令触发整页刷新路径
      if (msg.error != null) {
        showToast(String(msg.error));
        return;
      }
      if (msg.ok === true) return;
      handleStateUpdate(msg);
    };
    ws.onclose = () => {
      updateWsStatus(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWS, 2000);
    };
    ws.onerror = () => ws.close();
  }

  /**
   * 关键控制命令断线时必须给反馈，避免用户以为操作已经送达硬件。
   */
  function shouldWarnOfflineCommand(cmd) {
    const name = String(cmd || '');
    return name === 'start' || name === 'event' || name === 'emergency_stop' || name === 'e-stop' || name.startsWith('set_');
  }

  function sendCmd(cmd, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd, ...payload }));
      return true;
    }
    if (shouldWarnOfflineCommand(cmd)) {
      const now = Date.now();
      if (now - lastOfflineCommandToastAt > 2000) {
        showToast('WebSocket 未连接，操作未发送');
        lastOfflineCommandToastAt = now;
      }
    }
    return false;
  }

  // ========== UI 更新 ==========
  /**
   * 处理 WebSocket 状态更新：刷新读数、图表、按钮、事件、阶段条
   * @param {object} msg - 后端广播的状态对象
   */
  function handleStateUpdate(msg) {
    latestState = msg.state || latestState;
    if (!compareMode) syncActiveRoastProfile(msg);

    setTextIfChanged(document.getElementById('pv-val'), msg.pv != null ? msg.pv.toFixed(1) : '--');
    setTextIfChanged(document.getElementById('sv-val'), msg.sv != null ? msg.sv.toFixed(1) : '--');
    setTextIfChanged(document.getElementById('ror-val'), msg.ror != null ? msg.ror.toFixed(1) : '--');

    // 目标偏差（Artisan 风格 ahead/behind 读数）
    const deltaEl = document.getElementById('delta-val');
    if (deltaEl) {
      const deltaProf = getProfileForState(msg.state);
      if (msg.state === 'ROASTING' && deltaProf && Array.isArray(deltaProf.nodes)
          && deltaProf.nodes.length >= 2 && msg.pv != null) {
        const d = msg.pv - getSplineTemp(deltaProf.nodes, msg.elapsed || 0);
        setTextIfChanged(deltaEl, (d >= 0 ? '+' : '') + d.toFixed(1) + '°C');
        // 浏览器会把 style.color 序列化成 rgb(...),直接比对恒为假,
        // 用模块级缓存比对才能真正短路(PITFALLS #43 精神)
        const dc = Math.abs(d) <= 2 ? chartPalette.deltaGood : (d > 0 ? chartPalette.deltaWarn : chartPalette.deltaInfo);
        if (lastDeltaColor !== dc) { deltaEl.style.color = dc; lastDeltaColor = dc; }
      } else {
        setTextIfChanged(deltaEl, '--');
        if (lastDeltaColor !== '') { deltaEl.style.color = ''; lastDeltaColor = ''; }
      }
    }

    // 超前预测实际使用值反馈
    const laUsedEl = document.getElementById('lookahead-used');
    setTextIfChanged(laUsedEl, (msg.lookahead_used != null) ? msg.lookahead_used.toFixed(1) : '--');

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
      let chartDirty = false;

      if (enteringRoast) {
        chartDirty = clearDatasetIfNeeded(0) || chartDirty;
        chartDirty = clearDatasetIfNeeded(1) || chartDirty;
        chartDirty = clearDatasetIfNeeded(3) || chartDirty;
        chartDirty = clearDatasetIfNeeded(5) || chartDirty;
        chartDirty = eventAnnotations.length > 0 || chartDirty;
        eventAnnotations = [];
        rorEwma = 0;
        tpTime = null; tpTemp = null; minPv = null; minPvTime = null;
        endApproachAlerted = false;
        firedAlarms = new Set();
        lastProjectionSig = '';
      }
      if (enteringIdle) {
        chartDirty = clearDatasetIfNeeded(0) || chartDirty;
        chartDirty = clearDatasetIfNeeded(1) || chartDirty;
        chartDirty = clearDatasetIfNeeded(3) || chartDirty;
        chartDirty = clearDatasetIfNeeded(5) || chartDirty;
        chartDirty = eventAnnotations.length > 0 || chartDirty;
        eventAnnotations = [];
        rorEwma = 0;
        tpTime = null; tpTemp = null; minPv = null; minPvTime = null;
        endApproachAlerted = false;
        firedAlarms = new Set();
        lastProjectionSig = '';
      }
      lastState = msg.state;

      // 仅在烘焙活跃阶段追加实时数据，防止 IDLE/COOLING 拖出异常连线
      if (msg.state === 'ROASTING') {
        const t = Math.max(0, Math.floor(msg.elapsed || 0));
        chartDirty = appendRealtimePoint(0, t, msg.pv) || chartDirty;
        chartDirty = appendRealtimePoint(1, t, msg.sv) || chartDirty;

        // EWMA 平滑 ROR，同一秒内覆盖最新值，避免重复 x 点累积
        if (msg.ror != null) {
          rorEwma = ROR_EWMA_ALPHA * msg.ror + (1 - ROR_EWMA_ALPHA) * rorEwma;
          chartDirty = appendRealtimePoint(3, t, rorEwma) || chartDirty;
        }

        if (msg.pv != null) {
          // 回温点检测（Artisan TP：最低点回升 2°C 锁定；2 分钟无信号兜底）
          if (minPv == null || msg.pv < minPv) {
            minPv = msg.pv;
            minPvTime = t;
          } else if (tpTime == null && msg.pv - minPv >= 2.0 && (minPvTime || 0) >= 5) {
            tpTime = minPvTime;
            tpTemp = minPv;
          }
          if (tpTime == null && minPv != null && t >= 120) {
            tpTime = minPvTime;
            tpTemp = minPv;
          }

          // 接近结束温度提醒（每锅一次，提前 10°C）
          const alertProf = getProfileForState(msg.state);
          if (!endApproachAlerted && alertProf && alertProf.end_temp > 0
              && msg.pv >= alertProf.end_temp - uiCfg.alertOffsetC && msg.pv < alertProf.end_temp) {
            endApproachAlerted = true;
            showToast('接近结束温度 ' + alertProf.end_temp.toFixed(0) + '°C（当前 ' + msg.pv.toFixed(1) + '°C）');
            beep();
          }

          // 自动事件标记（Artisan autoDRY / autoFCs，默认关）
          const evtsNow = Array.isArray(msg.events) ? msg.events : [];
          if (autoCfg.autoDryEnabled && msg.pv >= autoCfg.autoDryTemp
              && !evtsNow.some(e => e.type === 'yellowing')) {
            sendCmd('event', { type: 'yellowing' });
          }
          if (autoCfg.autoFCsEnabled && msg.pv >= autoCfg.autoFCsTemp
              && !evtsNow.some(e => e.type === 'first_crack')) {
            sendCmd('event', { type: 'first_crack' });
          }

          // 自定义报警（每锅每条一次，提示音 + 弹窗）
          alarms.forEach((a, i) => {
            if (!a.enabled || firedAlarms.has(i)) return;
            const hit = a.type === 'time' ? (msg.elapsed || 0) >= a.value : msg.pv >= a.value;
            if (hit) {
              firedAlarms.add(i);
              showToast(a.note || (a.type === 'time'
                ? '报警：已烘焙 ' + formatTime(a.value)
                : '报警：温度到达 ' + a.value + '°C'));
              beep();
            }
          });
        }

        // 预测线（dataset 5）：从最新 PV 点按平滑 ROR 外推（时长可在设置页调整/关闭）
        if (uiCfg.projectionSec > 0) {
          const pvDs = roastChart.data.datasets[0].data;
          const ds5 = roastChart.data.datasets[5].data;
          let sig = '';
          if (pvDs.length) {
            const last = pvDs[pvDs.length - 1];
            const endY = Math.max(0, Math.min(300, last.y + rorEwma * (uiCfg.projectionSec / 60)));
            sig = last.x + '|' + endY.toFixed(2);
            if (sig !== lastProjectionSig) {
              lastProjectionSig = sig;
              ds5.length = 0;
              ds5.push({ x: last.x, y: last.y }, { x: last.x + uiCfg.projectionSec, y: endY });
              chartDirty = true;
            }
          } else if (ds5.length) {
            lastProjectionSig = '';
            ds5.length = 0;
            chartDirty = true;
          }
        } else {
          chartDirty = clearDatasetIfNeeded(5) || chartDirty;
          lastProjectionSig = '';
        }
      } else if (msg.state === 'COOLING') {
        // COOLING 时只定格温度与 SV，不再追加 ROR
        const t = Math.max(0, Math.floor(msg.elapsed || 0));
        chartDirty = appendRealtimePoint(0, t, msg.pv) || chartDirty;
        chartDirty = appendRealtimePoint(1, t, msg.sv) || chartDirty;
        chartDirty = clearDatasetIfNeeded(5) || chartDirty;
        lastProjectionSig = '';
      }
      if (chartDirty) roastChart.update('none');
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

    // 回温点信息条
    setTextIfChanged(document.getElementById('tp-info'),
      tpTime != null ? `${formatTimeShort(tpTime)} @ ${tpTemp.toFixed(1)}°C` : '--');

    // 预计到达结束温度（Artisan 风格 ETA）
    const etaRow = document.getElementById('eta-row');
    const etaInfo = document.getElementById('eta-info');
    if (etaRow && etaInfo) {
      const etaProf = getProfileForState(msg.state);
      let etaText = '';
      if (msg.state === 'ROASTING' && etaProf && etaProf.end_temp > 0
          && msg.pv != null && msg.ror >= 0.5 && msg.pv < etaProf.end_temp) {
        const etaSec = (etaProf.end_temp - msg.pv) / msg.ror * 60;
        etaText = `预计 ${formatTimeShort(etaSec)} 后到达结束温度 ${etaProf.end_temp.toFixed(0)}°C`;
      }
      if (etaText) {
        setTextIfChanged(etaInfo, etaText);
        if (etaRow.style.display === 'none') etaRow.style.display = '';
      } else if (etaRow.style.display !== 'none') {
        etaRow.style.display = 'none';
      }
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
  }

  // ========== ERROR 状态全屏阻断 ==========
  function showErrorOverlay(reason) {
    if (inErrorState) return;
    inErrorState = true;
    document.body.classList.add('error-active');
    const overlay = document.getElementById('error-overlay');
    const reasonEl = document.getElementById('error-reason');
    setTextIfChanged(reasonEl, reason || '未知错误');
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
    latestState = 'IDLE';
    activeRoastProfile = null;
    activeRoastProfileId = null;
    activeRoastProfileName = null;
    activeRoastProfileFetchId = null;
    activeRoastProfileRequestSeq++;
    rorEwma = 0;
    tpTime = null; tpTemp = null; minPv = null; minPvTime = null;
    endApproachAlerted = false;
    firedAlarms = new Set();
    lastProjectionSig = '';

    // 清空实时曲线
    roastChart.data.datasets[0].data = [];
    roastChart.data.datasets[1].data = [];
    roastChart.data.datasets[3].data = [];
    roastChart.data.datasets[5].data = [];
    eventAnnotations = [];
    roastChart.update('none');

    // 重置 UI 读数
    setTextIfChanged(document.getElementById('state-badge'), '待机');
    document.getElementById('state-badge').className = 'state-badge IDLE';
    // 同步 body 状态 class（清除 ROASTING/COOLING 残留以恢复出豆按钮静止态等）
    document.body.classList.remove('state-roasting', 'state-cooling', 'state-error');
    document.body.classList.add('state-idle');
    setTextIfChanged(document.getElementById('elapsed'), '00:00');
    setTextIfChanged(document.getElementById('pv-val'), '--');
    setTextIfChanged(document.getElementById('sv-val'), '--');
    setTextIfChanged(document.getElementById('ror-val'), '--');
    updateCurrentProfileDisplay('IDLE');
    restoreProfileCurveForState('IDLE');
    updateProfileCardsActive();
    updateButtonVisibility('IDLE');

    // 清空事件与统计
    // 清空事件按钮 active 高亮 + badge（防止上锅残留）
    syncEventActionsBar([]);
    updateSegmentBar({ total_time: 0, segment_times: {}, segment_ratios: {} });

    // 清空顶部事件温度
    setTextIfChanged(document.getElementById('yellowing-info'), '--');
    setTextIfChanged(document.getElementById('first-crack-info'), '--');
    setTextIfChanged(document.getElementById('development-info'), '--');
    setTextIfChanged(document.getElementById('tp-info'), '--');
    const resetDelta = document.getElementById('delta-val');
    if (resetDelta) {
      setTextIfChanged(resetDelta, '--');
      resetDelta.style.color = '';
    }
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

    const progressProfile = getProfileForState(msg.state);
    const totalProfile = (progressProfile && progressProfile.nodes && progressProfile.nodes.length)
      ? progressProfile.nodes[progressProfile.nodes.length - 1].time : 0;

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
   * 紧急停止按钮集成在底部状态栏右侧（#footer .footer-right），id 为 #btn-e-stop。
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

    setEventActionsEnabled(state === 'ROASTING');
    setProfileMutationEnabled(!isRoastActiveState(state));
  }

  /**
   * 非烘焙状态下禁用事件按钮，避免误触发送事件命令。
   */
  function setEventActionsEnabled(enabled) {
    const eventBar = document.getElementById('event-actions-bar');
    if (!eventBar) return;
    eventBar.querySelectorAll('.event-action-btn').forEach(btn => {
      const shouldDisable = !enabled;
      if (btn.disabled !== shouldDisable) btn.disabled = shouldDisable;
    });
  }

  /**
   * 烘焙进行中禁止改变曲线库对当前图表的含义，只保留导出等只读操作。
   */
  function setProfileMutationEnabled(enabled) {
    const cards = document.getElementById('profile-cards');
    if (!cards) return;
    cards.querySelectorAll('[data-action="apply"], [data-action="delete"]').forEach(btn => {
      const shouldDisable = !enabled;
      if (btn.disabled !== shouldDisable) btn.disabled = shouldDisable;
    });
    cards.querySelectorAll('.profile-card').forEach(card => {
      card.classList.toggle('locked', !enabled);
      card.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    });
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
      setTextIfChanged(yellowingEl, `${formatTime(yellowing.time)} @ ${yellowing.temperature.toFixed(1)}°C`);
    } else {
      setTextIfChanged(yellowingEl, '--');
    }

    if (firstCrack && firstCrack.temperature != null) {
      setTextIfChanged(firstCrackEl, `${formatTime(firstCrack.time)} @ ${firstCrack.temperature.toFixed(1)}°C`);
    } else {
      setTextIfChanged(firstCrackEl, '--');
    }
  }

  // ========== 发展期信息（一爆后直观展示） ==========
  function updateDevelopmentInfo(events, elapsed, currentTemp) {
    const firstCrack = events.find(e => e.type === 'first_crack');
    const devEl = document.getElementById('development-info');
    if (!firstCrack) {
      setTextIfChanged(devEl, '--');
      return;
    }
    const deltaT = (currentTemp != null && firstCrack.temperature != null)
      ? `+${(currentTemp - firstCrack.temperature).toFixed(1)}°C`
      : '';
    const devTime = formatTime(elapsed - firstCrack.time);
    setTextIfChanged(devEl, `${deltaT} · ${devTime}`);
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
    // iOS 分段控件滑动拇指:按实测 offsetLeft/offsetWidth 定位,对等宽 flex 分段天然适配
    const glider = document.querySelector('.tabs .tab-glider');
    const moveGlider = (btn) => {
      if (!glider || !btn) return;
      glider.style.width = btn.offsetWidth + 'px';
      glider.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
    };
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        moveGlider(btn);
        if (btn.dataset.tab === 'records') {
          loadRecords();
        }
      });
    });
    // 初始定位 + 视口变化跟随(首帧布局未就绪,等一帧再量)
    const syncGlider = () => moveGlider(document.querySelector('.tab-btn.active'));
    requestAnimationFrame(syncGlider);
    window.addEventListener('resize', syncGlider);
    // 支持 #tab 深链（如 index.html#settings 直达设置页）
    const hash = (location.hash || '').replace('#', '');
    if (hash && document.getElementById('tab-' + hash)) {
      const target = document.querySelector('.tab-btn[data-tab="' + hash + '"]');
      if (target) target.click();
    }
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

    // 全屏切换（尤其退出）后 Chart.js 偶发不重测容器，导致图表停留在全屏尺寸。
    // fullscreenchange 后延迟强制 resize 两次：一次等布局落地，一次兜底 transition 长尾。
    document.addEventListener('fullscreenchange', () => {
      [60, 260].forEach(delay => setTimeout(() => {
        if (roastChart) roastChart.resize();
        if (recordChart) recordChart.resize();
      }, delay));
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
        if (!isRoastActiveState(latestState)) {
          await applySelectedProfile({ silent: true });
        } else {
          updateCurrentProfileDisplay(latestState);
          restoreProfileCurveForState(latestState);
        }
      } else {
        clearSelectedProfileState();
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
      container.innerHTML = '<div class="list-placeholder">暂无曲线，点击「新建曲线」创建</div>';
      return;
    }

    // 拉取每个 profile 的完整数据用于绘制 sparkline 与计算总时长
    const fullProfiles = await Promise.all(
      list.map(s => fetch(profileEndpoint(s.id)).then(r => r.ok ? r.json() : null).catch(() => null))
    );

    // 缓存到 profileMap（覆盖摘要）
    fullProfiles.forEach(p => { if (p && p.id) profileMap[p.id] = p; });

    const activeId = isRoastActiveState(latestState) ? activeRoastProfileId : selectedProfileId;

    container.innerHTML = fullProfiles.map((p, i) => {
      if (!p) {
        const s = list[i];
        const safeId = escapeAttr(s.id || '');
        return `<div class="profile-card" data-id="${safeId}">
          <div class="name">${escapeHtml(s.name || '未命名')}</div>
          <div class="meta">加载失败</div>
        </div>`;
      }
      const safeId = escapeAttr(p.id || '');
      const nodes = p.nodes || [];
      const total = nodes.length ? nodes[nodes.length - 1].time : 0;
      const m = Math.floor(total / 60);
      const sec = Math.floor(total % 60);
      const sparkline = buildSparklineSVG(nodes);
      const isActive = p.id === activeId ? 'active' : '';
      return `
        <div class="profile-card ${isActive}" data-id="${safeId}">
          <div class="name">${escapeHtml(p.name || '未命名')}</div>
          <div class="meta">${nodes.length} 节点 · ${m}:${String(sec).padStart(2,'0')}</div>
          ${sparkline}
          <div class="actions">
            <button class="ctrl-btn small primary" data-action="apply" data-id="${safeId}">应用</button>
            <button class="ctrl-btn small" data-action="export" data-id="${safeId}">导出</button>
            <button class="ctrl-btn small danger" data-action="delete" data-id="${safeId}">删除</button>
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
        if (isRoastActiveState(latestState) && (action === 'apply' || action === 'delete')) {
          showToast(action === 'delete' ? '烘焙中不能删除曲线' : '烘焙中不能应用曲线');
          return;
        }
        if (action === 'apply') {
          selectedProfileId = id;
          const applied = await applySelectedProfile();
          if (!applied) return;
          updateProfileCardsActive();
          showToast('已应用曲线');
        } else if (action === 'export') {
          window.open(profileEndpoint(id) + '/export', '_blank');
        } else if (action === 'delete') {
          const p = profileMap[id];
          if (!p) return;
          if (!confirm('确定要删除曲线「' + p.name + '」吗？')) return;
          try {
            const res = await fetch(profileEndpoint(id), { method: 'DELETE' });
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
        if (isRoastActiveState(latestState)) {
          showToast('烘焙中不能应用曲线');
          return;
        }
        const id = card.dataset.id;
        selectedProfileId = id;
        const applied = await applySelectedProfile();
        if (!applied) return;
        updateProfileCardsActive();
      });
    });
    setProfileMutationEnabled(!isRoastActiveState(latestState));
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
      <polyline points="${points}" fill="none" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  }

  function updateProfileCardsActive() {
    const activeId = isRoastActiveState(latestState) ? activeRoastProfileId : selectedProfileId;
    document.querySelectorAll('.profile-card').forEach(card => {
      card.classList.toggle('active', card.dataset.id === activeId);
    });
  }

  /**
   * 应用曲线只影响待机期的本地选择，活跃烘焙期必须保留后端曲线来源。
   */
  async function applySelectedProfile(options = {}) {
    const id = selectedProfileId;
    if (!id) return false;
    if (isRoastActiveState(latestState)) {
      if (!options.silent) showToast('烘焙中不能应用曲线');
      return false;
    }
    try {
      const res = await fetch(profileEndpoint(id));
      if (!res.ok) return false;
      currentProfile = await res.json();
      profileMap[id] = currentProfile;
      showProfileCurve(currentProfile, 'selected');
      updateCurrentProfileDisplay(latestState);
      return true;
    } catch (e) {
      showToast('应用曲线失败');
      return false;
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
        loadProfiles();
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
          if (isRoastActiveState(latestState)) {
            showToast('已导入，烘焙结束后可应用');
          } else {
            selectedProfileId = result.id;
            const applied = await applySelectedProfile();
            if (applied) updateProfileCardsActive();
          }
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

    phases.forEach(phase => {
      const numEl    = document.getElementById('phase-' + phase);
      const sliderEl = document.getElementById('phase-' + phase + '-slider');
      if (!numEl || !sliderEl) return;

      let sendTimer = null;
      let pendingValue = null;
      let lastSent = normalizePhaseValue(sliderEl.value);

      function sameValue(a, b) {
        return a != null && b != null && Math.abs(a - b) < 0.0001;
      }

      function parsePhaseNumber(rawV) {
        const text = String(rawV).trim();
        if (!text) return null;
        const parsed = Number(text);
        return Number.isFinite(parsed) ? parsed : null;
      }

      function normalizePhaseValue(rawV) {
        const parsed = parsePhaseNumber(rawV);
        if (parsed == null) return null;
        return Math.max(0, Math.min(30, round1(parsed)));
      }

      function normalizeLiveNumberValue(rawV) {
        const parsed = parsePhaseNumber(rawV);
        if (parsed == null) return null;
        return Math.max(0, Math.min(30, round1(parsed)));
      }

      function syncControls(v, source) {
        const text = v.toFixed(1);
        if (source !== 'num' && numEl.value !== text) numEl.value = text;
        if (source !== 'slider' && sliderEl.value !== text) sliderEl.value = text;
      }

      function cancelPendingSend() {
        if (sendTimer) clearTimeout(sendTimer);
        sendTimer = null;
        pendingValue = null;
      }

      function scheduleSend(v) {
        if (v == null) return;
        if (sameValue(lastSent, v)) {
          cancelPendingSend();
          return;
        }
        if (sameValue(pendingValue, v)) return;
        pendingValue = v;
        if (sendTimer) clearTimeout(sendTimer);
        sendTimer = setTimeout(() => {
          const valueToSend = pendingValue;
          pendingValue = null;
          sendTimer = null;
          if (sameValue(lastSent, valueToSend)) return;
          if (sendCmd('set_phase_lookahead', { phase, value: valueToSend })) {
            lastSent = valueToSend;
          }
        }, 100);
      }

      function sendValueNow(v) {
        if (v == null) return;
        cancelPendingSend();
        if (sameValue(lastSent, v)) return;
        if (sendCmd('set_phase_lookahead', { phase, value: v })) {
          lastSent = v;
        }
      }

      sliderEl.addEventListener('input', () => {
        const v = normalizePhaseValue(sliderEl.value);
        if (v == null) return;
        syncControls(v, 'slider');
        scheduleSend(v);
      });

      numEl.addEventListener('input', () => {
        numEl.dataset.userEditing = '1';
        const v = normalizeLiveNumberValue(numEl.value);
        if (v == null) return;
        syncControls(v, 'num');
      });

      function commitNumber() {
        delete numEl.dataset.userEditing;
        let v = normalizePhaseValue(numEl.value);
        if (v == null) v = normalizePhaseValue(sliderEl.value);
        if (v == null) v = 0;
        syncControls(v, null);
        sendValueNow(v);
      }

      numEl.addEventListener('change', commitNumber);
      numEl.addEventListener('blur', commitNumber);
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
      setTextIfChanged(valueEl, Math.abs(v).toFixed(1));
      if (prefixEl) setTextIfChanged(prefixEl, v > 0 ? '+' : (v < 0 ? '−' : '±'));
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

  // ========== 拖动 slider 期间给 body 加 .dragging-slider，
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

    // 急停按钮：双击确认机制，按钮位于右下角小方框中
    const eStopBtn = document.getElementById('btn-e-stop');
    bindTouchClick(eStopBtn, () => {
      // IDLE 时禁用急停
      if (eStopBtn.classList.contains('disabled')) return;
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
        if (lastState !== 'ROASTING' || btn.disabled) return;
        // 已 active 的按钮拒绝重复触发，防止后端重复记录
        if (btn.classList.contains('active')) return;
        const type = btn.dataset.event;
        // drop 事件由后端自动触发结束烘焙，前端不再补发 end
        sendCmd('event', { type: type });
      });
    });
    setEventActionsEnabled(lastState === 'ROASTING');

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
    container.innerHTML = '<div class="list-placeholder">加载中...</div>';
    try {
      const res = await fetch('/api/v1/records');
      const list = await res.json();
      if (!list.length) {
        container.innerHTML = '<div class="list-placeholder">暂无记录</div>';
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
      container.innerHTML = '<div class="list-placeholder error">加载失败</div>';
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

      // 回温点：入豆后前 120s 内 PV 最低点（Artisan TP）
      if (dataArr.length) {
        let tpMin = null;
        let tpMinT = 0;
        dataArr.forEach(d => {
          const tt = Array.isArray(d) ? d[0] : null;
          const vv = Array.isArray(d) ? d[1] : null;
          if (tt != null && vv != null && tt <= 120 && (tpMin == null || vv < tpMin)) {
            tpMin = vv;
            tpMinT = tt;
          }
        });
        if (tpMin != null) {
          statsHtml += `<span>回温点: ${formatTime(tpMinT)} @ ${tpMin.toFixed(1)}°C</span>`;
        }
      }

      // 背景曲线快照信息
      if (record.profile_snapshot && record.profile_snapshot.nodes && record.profile_snapshot.nodes.length) {
        const snap = record.profile_snapshot;
        const snapNodes = snap.nodes;
        statsHtml += `<span>节点数: ${snapNodes.length}</span>`;
      }
      document.getElementById('detail-stats').innerHTML = statsHtml;

      // 事件列表（带颜色,未知事件类型回退刻度灰,PITFALLS #15 兜底语义保留）
      document.getElementById('detail-events').innerHTML = events.map(e => {
        const color = chartPalette.eventColors[e.type] || chartPalette.tick;
        const tempStr = e.temperature != null ? ` @ ${e.temperature.toFixed(1)}°C` : '';
        return `<div class="detail-event-item">
          <span class="detail-event-dot" style="background:${color}"></span>
          <span class="detail-event-time">${formatTime(e.time)}</span>
          <span class="detail-event-name">${eventLabel(e.type)}${tempStr}</span>
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

    // 构建事件标注(颜色取自主题色板,annType 供主题切换后无损重映射)
    const eventAnnos = events.map(e => ({
      time: e.time,
      label: eventLabel(e.type),
      color: eventColor(e.type),
      annType: e.type
    }));

    if (recordChart) {
      recordChart.destroy();
    }

    const datasets = [
      {
        label: '温度',
        data: pvData,
        borderColor: chartPalette.temp,
        backgroundColor: chartPalette.temp,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
        yAxisID: 'y',
      },
      {
        label: '设定温度',
        data: svData,
        borderColor: chartPalette.setpoint,
        backgroundColor: chartPalette.setpoint,
        borderDash: [6, 4],
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 1.5,
        yAxisID: 'y',
      },
      {
        label: 'ROR',
        data: rorData,
        borderColor: chartPalette.ror,
        backgroundColor: chartPalette.rorFill,
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
        borderColor: chartPalette.target,
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
              color: chartPalette.legend,
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
            backgroundColor: chartPalette.tooltipBg,
            titleColor: chartPalette.tooltipText,
            bodyColor: chartPalette.tooltipText,
            borderColor: chartPalette.tooltipBorder,
            borderWidth: 1,
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
            title: { display: true, text: '时间 (min)', color: chartPalette.tick, font: { size: 11 } },
            grid: { color: chartPalette.grid },
            ticks: {
              color: chartPalette.tick,
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
            title: { display: true, text: '温度 (°C)', color: chartPalette.tick, font: { size: 11 } },
            grid: { color: chartPalette.grid },
            ticks: { color: chartPalette.tick }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: 'ROR (°C/min)', color: chartPalette.tick, font: { size: 11 } },
            grid: { drawOnChartArea: false },
            ticks: { color: chartPalette.y1Tick },
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
      roastChart.data.datasets[0].borderColor = chartPalette.compareA;
      roastChart.data.datasets[0].backgroundColor = chartPalette.compareA;

      // 记录B温度曲线（紫色）
      safeUpdateDataset(roastChart, 1, (r2.data || []).map(d => ({ x: d[0], y: d[1] })));
      roastChart.data.datasets[1].label = '记录B';
      roastChart.data.datasets[1].borderColor = chartPalette.compareB;
      roastChart.data.datasets[1].backgroundColor = chartPalette.compareB;
      roastChart.data.datasets[1].borderDash = [];

      // 隐藏背景曲线、ROR、ROR 预览与预测线
      roastChart.data.datasets[2].data.length = 0;
      roastChart.data.datasets[2].label = '目标曲线';
      roastChart.data.datasets[3].data.length = 0;
      roastChart.data.datasets[4].data.length = 0;
      roastChart.data.datasets[5].data.length = 0;
      profileCurveKey = 'compare';
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
    roastChart.data.datasets[0].borderColor = chartPalette.temp;
    roastChart.data.datasets[0].backgroundColor = chartPalette.temp;

    roastChart.data.datasets[1].data.length = 0;
    roastChart.data.datasets[1].label = '设定温度';
    roastChart.data.datasets[1].borderColor = chartPalette.setpoint;
    roastChart.data.datasets[1].backgroundColor = chartPalette.setpoint;
    roastChart.data.datasets[1].borderDash = [6, 4];

    // 恢复背景曲线
    restoreProfileCurveForState(latestState);

    roastChart.data.datasets[3].data.length = 0;
    roastChart.update('none');
    compareMode = false;
    document.getElementById('btn-compare').style.display = selectedRecords.size >= 2 ? '' : 'none';
    document.getElementById('btn-exit-compare').style.display = 'none';
  }

  // ========== 界面/提醒设置 ==========
  function initSettingsUI() {
    const scaleSel = document.getElementById('ui-scale');
    if (scaleSel) {
      scaleSel.value = String(uiCfg.scale);
      scaleSel.addEventListener('change', () => {
        uiCfg.scale = parseInt(scaleSel.value, 10) || 100;
        saveSettings();
        applyUiScale();
      });
    }

    const ra = document.getElementById('ui-ror-alpha');
    const ran = document.getElementById('ui-ror-alpha-num');
    if (ra && ran) {
      ra.value = uiCfg.rorAlpha;
      ran.value = uiCfg.rorAlpha;
      const applyAlpha = (v, src) => {
        v = Math.max(0.05, Math.min(0.6, parseFloat(v) || 0.3));
        v = Math.round(v * 100) / 100;
        uiCfg.rorAlpha = v;
        ROR_EWMA_ALPHA = v;
        if (src !== 'slider') ra.value = v;
        if (src !== 'num') ran.value = v;
        saveSettings();
      };
      ra.addEventListener('input', () => applyAlpha(ra.value, 'slider'));
      ran.addEventListener('change', () => applyAlpha(ran.value, 'num'));
    }

    const projSel = document.getElementById('ui-projection');
    if (projSel) {
      projSel.value = String(uiCfg.projectionSec);
      projSel.addEventListener('change', () => {
        uiCfg.projectionSec = parseInt(projSel.value, 10) || 0;
        lastProjectionSig = '';
        saveSettings();
      });
    }

    const snd = document.getElementById('ui-sound');
    if (snd) {
      snd.checked = !!uiCfg.sound;
      snd.addEventListener('change', () => {
        uiCfg.sound = snd.checked;
        saveSettings();
      });
    }
    const sndTest = document.getElementById('ui-sound-test');
    if (sndTest) sndTest.addEventListener('click', () => beep(true));

    const offSel = document.getElementById('ui-alert-offset');
    if (offSel) {
      offSel.value = String(uiCfg.alertOffsetC);
      offSel.addEventListener('change', () => {
        uiCfg.alertOffsetC = parseInt(offSel.value, 10) || 10;
        saveSettings();
      });
    }
  }

  // ========== 自动化设置（自动标记 + 报警，localStorage 持久化） ==========
  function initAutomationUI() {
    const dryEn = document.getElementById('auto-dry-enabled');
    const dryTemp = document.getElementById('auto-dry-temp');
    const fcsEn = document.getElementById('auto-fcs-enabled');
    const fcsTemp = document.getElementById('auto-fcs-temp');
    if (!dryEn || !dryTemp || !fcsEn || !fcsTemp) return;

    dryEn.checked = !!autoCfg.autoDryEnabled;
    dryTemp.value = autoCfg.autoDryTemp;
    fcsEn.checked = !!autoCfg.autoFCsEnabled;
    fcsTemp.value = autoCfg.autoFCsTemp;

    const clampTemp = (v, fb) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(300, n)) : fb;
    };
    dryEn.addEventListener('change', () => { autoCfg.autoDryEnabled = dryEn.checked; saveSettings(); });
    dryTemp.addEventListener('change', () => { autoCfg.autoDryTemp = clampTemp(dryTemp.value, autoCfg.autoDryTemp); dryTemp.value = autoCfg.autoDryTemp; saveSettings(); });
    fcsEn.addEventListener('change', () => { autoCfg.autoFCsEnabled = fcsEn.checked; saveSettings(); });
    fcsTemp.addEventListener('change', () => { autoCfg.autoFCsTemp = clampTemp(fcsTemp.value, autoCfg.autoFCsTemp); fcsTemp.value = autoCfg.autoFCsTemp; saveSettings(); });

    const addBtn = document.getElementById('btn-add-alarm');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        alarms.push({ enabled: true, type: 'temp', value: 150, note: '' });
        saveSettings();
        renderAlarms();
      });
    }
    renderAlarms();
  }

  function renderAlarms() {
    const list = document.getElementById('alarms-list');
    if (!list) return;
    if (!alarms.length) {
      list.innerHTML = '<div class="list-placeholder">暂无报警，点「+ 添加」创建</div>';
      return;
    }
    // 布局与配色全部由 .alarm-row CSS 承载,模板不再写内联样式(主题兼容)
    list.innerHTML = alarms.map((a, i) => `
      <div class="alarm-row" data-idx="${i}">
        <input type="checkbox" data-k="enabled" ${a.enabled ? 'checked' : ''} title="启用">
        <select data-k="type">
          <option value="temp" ${a.type === 'temp' ? 'selected' : ''}>温度≥</option>
          <option value="time" ${a.type === 'time' ? 'selected' : ''}>时间≥</option>
        </select>
        <input type="number" data-k="value" value="${a.value}" min="0" step="1" class="phase-number">
        <input type="text" data-k="note" value="${escapeAttr(a.note || '')}" placeholder="备注（如：检查脱水）">
        <button class="ctrl-btn small danger" data-k="del">删除</button>
      </div>`).join('');

    list.querySelectorAll('.alarm-row').forEach(row => {
      const i = parseInt(row.dataset.idx, 10);
      row.querySelectorAll('[data-k]').forEach(el => {
        const k = el.dataset.k;
        if (k === 'del') {
          el.addEventListener('click', () => {
            alarms.splice(i, 1);
            saveSettings();
            renderAlarms();
          });
        } else {
          el.addEventListener('change', () => {
            if (k === 'enabled') alarms[i].enabled = el.checked;
            else if (k === 'type') alarms[i].type = el.value;
            else if (k === 'value') alarms[i].value = parseFloat(el.value) || 0;
            else if (k === 'note') alarms[i].note = el.value;
            saveSettings();
          });
        }
      });
    });
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
    loadSettings();
    applyUiScale();
    initSettingsUI();
    // 主题切换 → 图表原地换色(theme.js 在 <head> 已把首帧主题写到 <html>)
    window.addEventListener('roaster-themechange', applyChartTheme);
    initAutomationUI();
    connectWS();
    await loadProfiles();
    setInterval(updateClock, 1000);
    updateClock();
  });
})();
