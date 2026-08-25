/**
 * 公共工具函数库
 * 被 editor.js 和 app.js 共用
 */

'use strict';

// ========== Catmull-Rom 样条插值 ==========

/**
 * Catmull-Rom 样条插值核心公式
 * @param {number} p0, p1, p2, p3 - 相邻4个控制点的温度值
 * @param {number} t - 插值参数 [0,1]，表示在 p1~p2 之间的位置
 * @returns {number} 插值后的温度值
 */
function catmullRom(p0, p1, p2, p3, t) {
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * (t * t) +
    (-p0 + 3 * p1 - 3 * p2 + p3) * (t * t * t)
  );
}

/**
 * 计算任意时刻的样条温度值
 * 控制点不足4个时退化为线性插值；边界段使用虚拟点保持样条连续性
 * @param {Array} nodeList - 控制点列表 [{time, temperature}, ...]
 * @param {number} elapsed - 目标时刻（秒）
 * @returns {number} 该时刻的温度值
 */
function getSplineTemp(nodeList, elapsed) {
  if (!nodeList.length) return 0;
  if (elapsed <= nodeList[0].time) return nodeList[0].temperature;
  const n = nodeList.length;
  for (let i = 0; i < n - 1; i++) {
    const prev = nodeList[i];
    const curr = nodeList[i + 1];
    if (prev.time <= elapsed && elapsed <= curr.time) {
      if (n < 4) {
        const ratio = (elapsed - prev.time) / (curr.time - prev.time);
        return prev.temperature + ratio * (curr.temperature - prev.temperature);
      }

      let p0, p3;
      const p1 = prev.temperature;
      const p2 = curr.temperature;

      if (i === 0) {
        p0 = p1;
        p3 = nodeList[i + 2].temperature;
      } else if (i === n - 2) {
        p0 = nodeList[i - 1].temperature;
        p3 = p2;
      } else {
        p0 = nodeList[i - 1].temperature;
        p3 = nodeList[i + 2].temperature;
      }

      const t = (elapsed - prev.time) / (curr.time - prev.time);
      return catmullRom(p0, p1, p2, p3, t);
    }
  }
  return nodeList[n - 1].temperature;
}

/**
 * 对控制点进行密集样条插值，生成渲染用数据点
 * @param {Array} nodeList - 控制点列表
 * @param {number} stepSec - 插值步长（秒），默认每5秒一个点
 * @returns {Array} 密集插值点 [{x, y}, ...]
 */
function splineInterpolate(nodeList, stepSec) {
  if (nodeList.length < 2) return nodeList.map(n => ({ x: n.time, y: n.temperature }));
  const result = [];
  const lastTime = nodeList[nodeList.length - 1].time;
  for (let t = 0; t <= lastTime; t += stepSec) {
    result.push({ x: t, y: getSplineTemp(nodeList, t) });
  }
  if (result.length === 0 || result[result.length - 1].x < lastTime) {
    result.push({ x: lastTime, y: nodeList[nodeList.length - 1].temperature });
  }
  return result;
}

// ========== 格式化 ==========

/**
 * 将秒数格式化为 MM:SS
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * 将秒数格式化为 m:ss（用于显示，不补分钟前导零）
 * @param {number} seconds
 * @returns {string}
 */
function formatTimeShort(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ========== 深拷贝 ==========

/**
 * 深拷贝对象/数组
 * @param {*} obj
 * @returns {*}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ========== 网格吸附 ==========

/**
 * 将值吸附到指定粒度
 * @param {number} value
 * @param {number} granularity
 * @returns {number}
 */
function snapValue(value, granularity) {
  return Math.round(value / granularity) * granularity;
}

// ========== HTML 转义 ==========

/**
 * 转义 HTML 特殊字符
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========== 构建 ROR 数据集（供 editor.js 与 app.js 复用） ==========

/**
 * 从温度节点构建 ROR 数据集（简单分段差分法）
 * 遍历节点，每段计算 dT/dt*60，取中点作为 ROR 数据点。
 * 此方法直接反映用户在控制点之间设定的升温率，无额外平滑，
 * 与 4-17 版本行为一致，简单可预测。
 *
 * @param {Array} nodeList - [{time, temperature}, ...]
 * @returns {Array} [{x:秒, y:ROR}, ...]
 */
function buildRORDataset(nodeList) {
  if (!nodeList || nodeList.length < 2) return [];
  const data = [];
  for (let i = 0; i < nodeList.length - 1; i++) {
    const dt = nodeList[i + 1].time - nodeList[i].time;
    const dT = nodeList[i + 1].temperature - nodeList[i].temperature;
    const ror = dt > 0 ? (dT / dt * 60) : 0;
    data.push({ x: nodeList[i].time + dt / 2, y: ror });
  }
  return data;
}

// ========== CSS 变量读取(图表颜色与主题令牌同源的唯一入口) ==========

/**
 * 读取 :root / [data-theme] 上定义的 CSS 自定义属性。
 * Chart.js 与 canvas 插件的颜色全部经此取自 theme.css 令牌,
 * 主题切换后由 'roaster-themechange' 事件触发重读。
 * @param {string} name - 如 '--chart-temp'
 * @param {string} fallback - 读取失败时的兜底值(与深色主题一致)
 * @returns {string}
 */
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    const t = v ? v.trim() : '';
    return t || fallback;
  } catch (e) {
    return fallback;
  }
}
