(function() {
  'use strict';

  // ========== 全局状态 ==========
  let chart = null;

  // 温度曲线节点（唯一曲线类型）
  let tempNodes = [
    { time: 0,   temperature: 30  },
    { time: 60,  temperature: 100 },
    { time: 120, temperature: 135 },
    { time: 180, temperature: 155 },
    { time: 270, temperature: 188 },
    { time: 360, temperature: 203 },
    { time: 435, temperature: 212 }
  ];

  let selectedIndex = -1;
  let isDragging = false;
  let dragIndex = -1;
  let refreshRaf = null; // requestAnimationFrame 句柄

  // 撤销/重做系统
  const MAX_HISTORY = 50;
  let undoStack = [];
  let redoStack = [];
  let isUndoing = false;
  let dragFinalize = null;

  // 吸附改为 opt-in。默认拖动 1s/0.1℃ 最小量化,Shift 可吸附到 SNAP 网格
  const SNAP = { time: 5, temp: 0.5 };

  // ========== Chart.js 初始化 ==========

  function initChart() {
    Chart.defaults.color = '#a3a3a3';
    Chart.defaults.borderColor = '#262626';

    const ctx = document.getElementById('editor-chart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: '温度曲线',
            data: [],
            borderColor: '#9ca3af',
            backgroundColor: '#9ca3af',
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 0,
            borderWidth: 2,
            yAxisID: 'y',
          },
          {
            label: '预测 ROR',
            data: [],
            borderColor: '#3b82f6',
            backgroundColor: 'transparent',
            borderDash: [5, 4],
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
            yAxisID: 'y1',
          },
          {
            label: '控制点',
            data: [],
            borderColor: '#f59e0b',
            backgroundColor: '#f59e0b',
            pointRadius: 6,
            pointHoverRadius: 10,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: '#fff',
            showLine: false,
            yAxisID: 'y',
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,  // 禁用动画，避免渲染阻塞
        interaction: { mode: 'point', intersect: false },
        plugins: {
          legend: { labels: { color: '#e5e5e5', font: { size: 12 }, usePointStyle: true, boxWidth: 8 } },
          tooltip: {
            filter: (item) => item.datasetIndex !== 2,
            callbacks: {
              title: (items) => {
                if (!items || !items.length) return '';
                const v = items[0].parsed && items[0].parsed.x;
                if (v == null || Number.isNaN(v)) return '';
                return formatTimeShort(v);
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: '时间 (min)', color: '#a3a3a3' },
            grid: { color: '#1f1f1f' },
            ticks: {
              color: '#a3a3a3',
              callback: function(value) {
                return formatTimeShort(value);
              }
            },
            suggestedMax: 1200
          },
          y: {
            display: true,
            position: 'left',
            min: 0,
            max: 300,
            title: { display: true, text: '温度 (°C)', color: '#a3a3a3' },
            grid: { color: '#1f1f1f' },
            ticks: { color: '#a3a3a3' }
          },
          y1: {
            display: true,
            position: 'right',
            title: { display: true, text: '升温率 (°C/min)', color: '#a3a3a3' },
            grid: { drawOnChartArea: false },
            ticks: { color: '#60a5fa' },
            suggestedMin: -5,
            suggestedMax: 25
          }
        }
      }
    });

    // 确保 canvas 获得正确尺寸
    chart.resize();

    const canvas = chart.canvas;
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // ========== 坐标转换 ==========

  function getEventPoint(evt) {
    const rect = chart.canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const time = xScale.getValueForPixel(x);
    const val = yScale.getValueForPixel(y);
    return { x, y, time, val };
  }

  function findNearestNode(time, val) {
    const nodes = tempNodes;
    let minDist = Infinity;
    let idx = -1;
    nodes.forEach((n, i) => {
      const px = chart.scales.x.getPixelForValue(n.time);
      const py = chart.scales.y.getPixelForValue(n.temperature);
      const dx = chart.scales.x.getPixelForValue(time) - px;
      const dy = chart.scales.y.getPixelForValue(val) - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) { minDist = dist; idx = i; }
    });
    return minDist < 20 ? idx : -1;
  }

  // ========== 交互事件 ==========

  function onMouseDown(evt) {
    const pt = getEventPoint(evt);
    const idx = findNearestNode(pt.time, pt.val);
    if (idx >= 0) {
      isDragging = true;
      dragIndex = idx;
      selectNode(idx);
      dragFinalize = pushHistory('move', '移动节点');
    }
  }

  function onMouseMove(evt) {
    if (!isDragging || dragIndex < 0) return;
    const pt = getEventPoint(evt);
    const nodes = tempNodes;

    let newTime = pt.time;
    let newTemp = pt.val;

    // 吸附改为 opt-in。默认丝滑 1s/0.1℃ 最小量化(JSON 整洁),Shift 才吸附到 SNAP 网格
    if (evt.shiftKey) {
      newTime = snapValue(newTime, SNAP.time);   // 5s 网格(精确对齐)
      newTemp = snapValue(newTemp, SNAP.temp);   // 0.5℃ 网格
    } else {
      newTime = Math.round(newTime);             // 1s 最小量化
      newTemp = Math.round(newTemp * 10) / 10;   // 0.1℃ 最小量化
    }

    if (newTemp < 0) newTemp = 0;
    if (newTemp > 300) newTemp = 300;

    if (dragIndex > 0) {
      const prevTime = nodes[dragIndex - 1].time;
      if (newTime <= prevTime) newTime = prevTime + 1;
    }
    if (dragIndex < nodes.length - 1) {
      const nextTime = nodes[dragIndex + 1].time;
      if (newTime >= nextTime) newTime = nextTime - 1;
    }
    if (dragIndex === 0) newTime = 0;

    nodes[dragIndex].time = newTime;
    nodes[dragIndex].temperature = newTemp;
    sortNodes();
    const newIdx = nodes.findIndex(n => n.time === newTime && Math.abs(n.temperature - newTemp) < 0.01);
    if (newIdx >= 0) {
      selectedIndex = newIdx;
      dragIndex = newIdx;
    }

    // 更新拖拽 tooltip
    updateDragTooltip(evt.clientX, evt.clientY, newTime, newTemp);

    // 使用 requestAnimationFrame 节流，只更新图表不碰 DOM
    if (refreshRaf) cancelAnimationFrame(refreshRaf);
    refreshRaf = requestAnimationFrame(() => {
      refreshChartOnly();
      refreshRaf = null;
    });
  }

  function onMouseUp() {
    if (isDragging) {
      isDragging = false;
      dragIndex = -1;
      if (refreshRaf) {
        cancelAnimationFrame(refreshRaf);
        refreshRaf = null;
      }
      hideDragTooltip();
      refresh(); // 统一更新 DOM
      if (dragFinalize) {
        dragFinalize();
        dragFinalize = null;
      }
    }
  }

  // ========== 拖拽 Tooltip ==========

  function updateDragTooltip(x, y, time, temp) {
    let tip = document.getElementById('drag-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'drag-tooltip';
      tip.className = 'drag-tooltip';
      document.body.appendChild(tip);
    }
    tip.textContent = `${formatTimeShort(time)} / ${temp.toFixed(1)}°C`;
    tip.style.left = (x + 15) + 'px';
    tip.style.top = (y - 30) + 'px';
    tip.style.display = 'block';
  }

  function hideDragTooltip() {
    const tip = document.getElementById('drag-tooltip');
    if (tip) tip.style.display = 'none';
  }

  // ========== 撤销/重做系统 ==========

  class EditCommand {
    constructor(type, prevState, nextState, description) {
      this.type = type;
      this.prevState = deepClone(prevState);
      this.nextState = deepClone(nextState);
      this.description = description;
    }
  }

  function pushHistory(type, description) {
    if (isUndoing) return null;
    const prevState = deepClone(tempNodes);

    return function finalize() {
      const nextState = deepClone(tempNodes);
      if (JSON.stringify(prevState) === JSON.stringify(nextState)) return;
      undoStack.push(new EditCommand(type, prevState, nextState, description));
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack = [];
      updateUndoRedoUI();
    };
  }

  function undo() {
    if (undoStack.length === 0) return;
    isUndoing = true;
    const cmd = undoStack.pop();
    tempNodes = deepClone(cmd.prevState);
    selectedIndex = -1;
    refresh();
    selectNode(-1);
    redoStack.push(cmd);
    isUndoing = false;
    updateUndoRedoUI();
    showToast('已撤销');
  }

  function redo() {
    if (redoStack.length === 0) return;
    isUndoing = true;
    const cmd = redoStack.pop();
    tempNodes = deepClone(cmd.nextState);
    selectedIndex = -1;
    refresh();
    selectNode(-1);
    undoStack.push(cmd);
    isUndoing = false;
    updateUndoRedoUI();
    showToast('已重做');
  }

  function updateUndoRedoUI() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.disabled = undoStack.length === 0;
    if (btnRedo) btnRedo.disabled = redoStack.length === 0;
  }

  // ========== Toast 提示 ==========

  function showToast(message) {
    let toast = document.getElementById('editor-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'editor-toast';
      toast.className = 'editor-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 1500);
  }

  // ========== 数据操作 ==========

  function sortNodes() {
    tempNodes.sort((a, b) => a.time - b.time);
  }

  function addNode(time, temp) {
    let t = Math.max(0, Math.round(time));
    let v = Math.max(0, Math.min(300, Math.round(temp * 10) / 10));
    const existing = tempNodes.find(n => n.time === t);
    if (existing) t += 1;

    const finalize = pushHistory('add', '添加节点');
    tempNodes.push({ time: t, temperature: v });
    sortNodes();
    const idx = tempNodes.findIndex(n => n.time === t && Math.abs(n.temperature - v) < 0.01);
    selectNode(idx >= 0 ? idx : tempNodes.length - 1);
    refresh();
    if (finalize) finalize();
  }

  function deleteSelectedNode() {
    if (selectedIndex < 0 || tempNodes.length <= 2) {
      showToast('至少需要保留两个节点');
      return;
    }
    const finalize = pushHistory('delete', '删除节点');
    tempNodes.splice(selectedIndex, 1);
    selectNode(-1);
    refresh();
    finalize();
  }

  function selectNode(idx) {
    selectedIndex = idx;
    document.querySelectorAll('.node-item').forEach((el, i) => {
      el.classList.toggle('selected', i === idx);
    });
    const btnDel = document.getElementById('btn-del-node');
    if (btnDel) btnDel.disabled = idx < 0;
    const minInput  = document.getElementById('sel-time-min');
    const secInput  = document.getElementById('sel-time-sec');
    const tempInput = document.getElementById('sel-temp');
    if (idx >= 0) {
      const total = tempNodes[idx].time;
      minInput.value  = Math.floor(total / 60);
      secInput.value  = Math.round(total % 60);
      tempInput.value = tempNodes[idx].temperature;
      // 首节点强制锁定在 0:00
      const lockFirst = (idx === 0);
      minInput.disabled = lockFirst;
      secInput.disabled = lockFirst;
    } else {
      minInput.value  = '';
      secInput.value  = '';
      tempInput.value = '';
      minInput.disabled = false;
      secInput.disabled = false;
    }
  }

  function insertNodeAfter(index) {
    if (index < 0 || index >= tempNodes.length - 1) return;

    const finalize = pushHistory('insert', '插入节点');
    const curr = tempNodes[index];
    const next = tempNodes[index + 1];
    const midTime = snapValue((curr.time + next.time) / 2, SNAP.time);
    const midTemp = Math.round(getSplineTemp(tempNodes, midTime) * 10) / 10;

    tempNodes.splice(index + 1, 0, { time: midTime, temperature: midTemp });
    refresh();
    selectNode(index + 1);
    finalize();
  }

  function duplicateSelectedNode() {
    if (selectedIndex < 0) return;
    const finalize = pushHistory('duplicate', '复制节点');
    const orig = tempNodes[selectedIndex];
    const newNode = deepClone([orig])[0];

    let newTime = orig.time + 30;
    if (selectedIndex < tempNodes.length - 1) {
      const nextTime = tempNodes[selectedIndex + 1].time;
      if (newTime >= nextTime) newTime = snapValue((orig.time + nextTime) / 2, SNAP.time);
    }
    newNode.time = newTime;

    tempNodes.splice(selectedIndex + 1, 0, newNode);
    sortNodes();
    refresh();
    const newIdx = tempNodes.findIndex(n => n.time === newTime);
    selectNode(newIdx >= 0 ? newIdx : selectedIndex + 1);
    finalize();
  }

  function nudgeNode(key, shift) {
    if (selectedIndex < 0) return;
    const node = tempNodes[selectedIndex];
    const finalize = pushHistory('nudge', '微调节点');
    const timeStep = shift ? 10 : 1;
    const tempStep = shift ? 5 : 0.5;

    switch (key) {
      case 'ArrowUp':
        node.temperature = Math.min(300, Math.round((node.temperature + tempStep) * 10) / 10);
        break;
      case 'ArrowDown':
        node.temperature = Math.max(0, Math.round((node.temperature - tempStep) * 10) / 10);
        break;
      case 'ArrowRight': {
        const maxTime = selectedIndex < tempNodes.length - 1 ? tempNodes[selectedIndex + 1].time - 1 : Infinity;
        node.time = Math.min(maxTime, node.time + timeStep);
        break;
      }
      case 'ArrowLeft': {
        const minTime = selectedIndex > 0 ? tempNodes[selectedIndex - 1].time + 1 : 0;
        node.time = Math.max(minTime, node.time - timeStep);
        break;
      }
    }
    if (selectedIndex === 0) node.time = 0;
    sortNodes();
    refresh();
    selectNode(selectedIndex);
    finalize();
  }

  // ========== ROR 计算 ==========

  function computeROR(nodeList) {
    const ror = [];
    for (let i = 0; i < nodeList.length - 1; i++) {
      const dt = nodeList[i + 1].time - nodeList[i].time;
      const dT = nodeList[i + 1].temperature - nodeList[i].temperature;
      ror.push(dt > 0 ? (dT / dt * 60) : 0);
    }
    return ror;
  }

  /**
   * 构建 ROR 数据集（简单分段差分法，与 utils.js 一致）
   */
  function buildRORDataset(nodeList) {
    return window.buildRORDataset(nodeList);
  }

  // ========== UI 刷新（核心：修复 Chart.js 渲染） ==========

  /**
   * 安全更新 Chart.js 数据集：先清空数组再 push，避免直接替换导致变化检测失效
   */
  function updateDataset(idx, newData) {
    const ds = chart.data.datasets[idx].data;
    ds.length = 0;
    ds.push(...newData);
  }

  function refreshChartOnly() {
    // 温度曲线使用 Catmull-Rom 样条插值
    const interpolated = splineInterpolate(tempNodes, 5);
    updateDataset(0, interpolated);
    updateDataset(1, buildRORDataset(tempNodes));

    // 控制点
    updateDataset(2, tempNodes.map(n => ({ x: n.time, y: n.temperature })));

    // 动态调整 X 轴范围
    const lastTime = tempNodes.length ? tempNodes[tempNodes.length - 1].time : 600;
    let suggestedMax = 600;
    if (lastTime > 900) suggestedMax = 1200;
    else if (lastTime > 600) suggestedMax = 900;
    chart.options.scales.x.suggestedMax = suggestedMax;

    // 拖动时跳过动画，避免画布重绘阻塞
    chart.update('none');
  }

  function refresh() {
    refreshChartOnly();
    renderNodesList();
    renderRORList();
    updateUndoRedoUI();
  }

  function renderNodesList() {
    const container = document.getElementById('nodes-list');
    const nodes = tempNodes;
    const ror = computeROR(nodes);

    container.innerHTML = nodes.map((n, i) => {
      const slope = i < ror.length ? ror[i].toFixed(1) : '--';
      return `
        <div class="node-item ${i === selectedIndex ? 'selected' : ''}" data-idx="${i}"
             title="时间: ${formatTimeShort(n.time)}, 温度: ${n.temperature.toFixed(1)}°C">
          <span class="node-time">${formatTimeShort(n.time)}</span>
          <span class="node-val">${n.temperature.toFixed(1)}</span>
          <span class="node-slope">${slope}</span>
          <button class="node-insert-btn" data-idx="${i}" title="在下方插入节点">+</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.node-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('node-insert-btn')) return;
        const idx = parseInt(el.dataset.idx, 10);
        selectNode(idx);
      });
    });

    container.querySelectorAll('.node-insert-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        insertNodeAfter(idx);
      });
    });
  }

  /**
   * 渲染 ROR 预览列表（简单分段差分，与图表一致）
   * 每段 ROR 直接由节点间差分计算，无需再遍历数据集求平均。
   */
  function renderRORList() {
    const container = document.getElementById('ror-list');
    const nodes = tempNodes;
    if (nodes.length < 2) {
      container.innerHTML = '<div style="color:#737373;text-align:center;padding:20px 0">至少两个节点才能计算 ROR</div>';
      return;
    }

    const ror = computeROR(nodes);
    let html = '';
    for (let i = 0; i < ror.length; i++) {
      const cls = ror[i] >= 0 ? 'positive' : 'negative';
      html += `
        <div class="ror-item ${cls}">
          <span>${formatTimeShort(nodes[i].time)} ~ ${formatTimeShort(nodes[i + 1].time)}</span>
          <span>${ror[i].toFixed(1)} °C/min</span>
        </div>
      `;
    }
    container.innerHTML = html;
  }

  // ========== 保存与导出 ==========

  async function saveProfile() {
    const name = document.getElementById('profile-name').value.trim();
    if (!name) { showToast('请输入曲线名称'); return; }
    const endTemp = parseFloat(document.getElementById('profile-end-temp').value);
    const payload = {
      name: name,
      description: document.getElementById('profile-desc').value.trim(),
      nodes: tempNodes.map(n => ({ time: n.time, temperature: n.temperature })),
      end_temp: isNaN(endTemp) ? 0 : endTemp
    };
    try {
      const res = await fetch('/api/v1/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('保存成功');
        setTimeout(() => { window.location.href = '/'; }, 800);
      }
    } catch (e) {
      showToast('保存失败');
    }
  }

  function exportJSON() {
    const name = document.getElementById('profile-name').value.trim() || '未命名曲线';
    const endTemp = parseFloat(document.getElementById('profile-end-temp').value);
    const payload = {
      name: name,
      description: document.getElementById('profile-desc').value.trim(),
      nodes: tempNodes.map(n => ({ time: n.time, temperature: n.temperature })),
      end_temp: isNaN(endTemp) ? 0 : endTemp
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('导出成功');
  }

  // ========== 键盘快捷键 ==========

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // 输入框内不拦截（除 Ctrl+S）
      if (e.target.tagName === 'INPUT' && !(e.ctrlKey && e.key === 's')) return;

      const hasSelection = selectedIndex >= 0;

      switch (true) {
        case e.ctrlKey && e.key === 'z' && !e.shiftKey:
          e.preventDefault(); undo(); break;
        case e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'z')):
          e.preventDefault(); redo(); break;
        case (e.key === 'Delete' || e.key === 'Backspace') && hasSelection:
          e.preventDefault(); deleteSelectedNode(); break;
        case e.ctrlKey && e.key === 'd' && hasSelection:
          e.preventDefault(); duplicateSelectedNode(); break;
        case e.ctrlKey && e.key === 'n':
          e.preventDefault(); document.getElementById('btn-add-node').click(); break;
        case e.ctrlKey && e.key === 's':
          e.preventDefault(); saveProfile(); break;
        case ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && hasSelection:
          e.preventDefault(); nudgeNode(e.key, e.shiftKey); break;
        case e.key === 'Escape':
          e.preventDefault(); selectNode(-1); break;
      }
    });
  }

  // ========== 初始化事件 ==========

  function initEvents() {
    // 撤销/重做按钮
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.addEventListener('click', undo);
    if (btnRedo) btnRedo.addEventListener('click', redo);

    // 添加/删除节点
    document.getElementById('btn-add-node').addEventListener('click', () => {
      const last = tempNodes[tempNodes.length - 1];
      const prev = tempNodes[tempNodes.length - 2] || last;
      const dt = last ? (last.time - (prev.time || 0)) : 120;
      const dT = last ? (last.temperature - (prev.temperature || last.temperature)) : 10;
      addNode((last ? last.time : 0) + dt, (last ? last.temperature : 150) + dT);
    });

    document.getElementById('btn-del-node').addEventListener('click', deleteSelectedNode);
    document.getElementById('btn-save').addEventListener('click', saveProfile);
    document.getElementById('btn-export').addEventListener('click', exportJSON);
    // 选中节点精确编辑（分 / 秒 / 数值）
    const minInput  = document.getElementById('sel-time-min');
    const secInput  = document.getElementById('sel-time-sec');
    const tempInput = document.getElementById('sel-temp');

    function updateSelectedFromInputs() {
      if (selectedIndex < 0) return;

      // 解析分秒：空 → 0；负数 → 0；秒 ≥ 60 允许进位（例如 1分80秒 = 140s，blur 后由 selectNode 自动归一为 2:20）
      let m = parseInt(minInput.value, 10);
      let s = parseInt(secInput.value, 10);
      if (isNaN(m) || m < 0) m = 0;
      if (isNaN(s) || s < 0) s = 0;
      let t = m * 60 + s;

      let v = parseFloat(tempInput.value) || 0;
      if (v < 0) v = 0; if (v > 300) v = 300;

      // 邻居夹紧（与拖拽 / 微调保持一致）
      if (selectedIndex > 0) {
        const prevTime = tempNodes[selectedIndex - 1].time;
        if (t <= prevTime) t = prevTime + 1;
      }
      if (selectedIndex < tempNodes.length - 1) {
        const nextTime = tempNodes[selectedIndex + 1].time;
        if (t >= nextTime) t = nextTime - 1;
      }
      if (selectedIndex === 0) t = 0;

      const finalize = pushHistory('edit', '精确编辑');
      tempNodes[selectedIndex].time = t;
      tempNodes[selectedIndex].temperature = v;
      sortNodes();
      const newIdx = tempNodes.findIndex(n => n.time === t && Math.abs(n.temperature - v) < 0.01);
      if (newIdx >= 0) selectedIndex = newIdx;
      refresh();
      selectNode(selectedIndex);
      finalize();
    }

    minInput.addEventListener('change', updateSelectedFromInputs);
    secInput.addEventListener('change', updateSelectedFromInputs);
    tempInput.addEventListener('change', updateSelectedFromInputs);

    initKeyboardShortcuts();
  }

  // ========== 启动 ==========

  document.addEventListener('DOMContentLoaded', () => {
    initChart();
    refresh();
    initEvents();
    updateUndoRedoUI();
  });
})();
