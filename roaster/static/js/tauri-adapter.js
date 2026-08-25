/**
 * Tauri 桌面壳适配层
 *
 * 作用：当前端运行在 Tauri WebView 内时，把页面里所有「同源相对路径」请求
 * （/api/...、/ws、window.open('/api/...')）重写到用户配置的后端地址，
 * 因为 Tauri 里页面来自 asset 协议（http://tauri.localhost），
 * 不代理的话 fetch 会打到不存在的本地服务上。
 *
 * 在普通浏览器里（FastAPI 直接托管页面时）本文件完全不起作用，零副作用。
 *
 * 后端地址存 localStorage['roaster.backendUrl']，默认 http://localhost:8000；
 * 编辑器页面会注入一个图标按钮，可随时修改后端地址（仅在 Tauri 内出现）。
 */

(function () {
  'use strict';

  // Tauri v2 会在 WebView 里注入 __TAURI_INTERNALS__；浏览器环境没有
  var isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) return;

  var STORAGE_KEY = 'roaster.backendUrl';
  var HISTORY_KEY = 'roaster.backendHistory';
  var REAL_PRESET_KEY = 'roaster.realPresetUrl';
  var SIMULATOR_URL = 'http://localhost:8000';
  var DEFAULT_REAL_URL = 'http://raspberrypi.local:8000';
  var DEFAULT_BACKEND = SIMULATOR_URL;

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function normalizeUrl(v) {
    return String(v || '').trim().replace(/\/+$/, '');
  }

  function getBackend() {
    return normalizeUrl(lsGet(STORAGE_KEY)) || DEFAULT_BACKEND;
  }

  function getRealPreset() {
    return normalizeUrl(lsGet(REAL_PRESET_KEY)) || DEFAULT_REAL_URL;
  }

  function getHistory() {
    try {
      var h = JSON.parse(lsGet(HISTORY_KEY) || '[]');
      return Array.isArray(h) ? h.filter(Boolean) : [];
    } catch (e) { return []; }
  }

  function setBackend(url) {
    url = normalizeUrl(url);
    if (!url) return;
    lsSet(STORAGE_KEY, url);
    var h = [url].concat(getHistory().filter(function (e) { return e !== url; })).slice(0, 5);
    lsSet(HISTORY_KEY, JSON.stringify(h));
  }

  /** 将以 / 开头的同源路径改写到后端地址；其余原样返回 */
  function absolutize(url) {
    if (typeof url === 'string' && url.charAt(0) === '/') {
      return getBackend() + url;
    }
    return url;
  }

  // ---- 代理 fetch ----
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') input = absolutize(input);
    return origFetch(input, init);
  };

  // ---- 代理 WebSocket ----
  // app.js 用 `${protocol}//${window.location.host}/ws` 构造地址，
  // 在 Tauri 里 host 是 tauri.localhost，需要换成后端主机的 ws/wss 地址。
  var OrigWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    if (typeof url === 'string') {
      try {
        var u = new URL(url);
        if ((u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === window.location.host) {
          var b = new URL(getBackend());
          u.protocol = (b.protocol === 'https:') ? 'wss:' : 'ws:';
          u.host = b.host;
          url = u.toString();
        }
      } catch (e) { /* 非法 URL 交给原生构造器报错 */ }
    }
    // 用工厂写法返回真正的原生实例，保证 readyState/事件等完全一致
    return protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
  }
  PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
  PatchedWebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket = PatchedWebSocket;

  // ---- 代理 window.open（记录导出等）----
  var origOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    if (typeof url === 'string') url = absolutize(url);
    if (origOpen) return origOpen(url, target, features);
    window.location.href = url;
    return null;
  };

  // ---- 后端设置 UI ----
  // 主页面：接管原生「设置」tab 里的后端连接区（#backend-section）
  // 编辑器页：没有设置 tab，退回浮动 ⚙ 弹窗
  function applyAndReload(url) {
    url = normalizeUrl(url);
    if (!/^https?:\/\/.+/.test(url)) return;
    setBackend(url);
    window.location.reload();
  }

  function wireBackendSection(section) {
    section.style.display = '';
    var currentEl = section.querySelector('#backend-current');
    var realInput = section.querySelector('#backend-real-preset');
    var customInput = section.querySelector('#backend-custom');
    if (currentEl) currentEl.textContent = getBackend();
    if (realInput) realInput.value = getRealPreset();
    if (customInput) customInput.value = getBackend();

    section.querySelector('#backend-preset-sim').addEventListener('click', function () {
      applyAndReload(SIMULATOR_URL);
    });
    section.querySelector('#backend-preset-real').addEventListener('click', function () {
      applyAndReload(getRealPreset());
    });
    section.querySelector('#backend-save-preset').addEventListener('click', function () {
      var v = normalizeUrl(realInput.value);
      if (/^https?:\/\/.+/.test(v)) {
        lsSet(REAL_PRESET_KEY, v);
        this.textContent = '已保存';
        var btn = this;
        setTimeout(function () { btn.textContent = '存预设'; }, 1200);
      }
    });
    section.querySelector('#backend-apply').addEventListener('click', function () {
      applyAndReload(customInput.value);
    });

    var histBox = section.querySelector('#backend-history');
    var h = getHistory();
    if (histBox && h.length) {
      histBox.innerHTML = h.map(function (u) {
        var cur = u === getBackend();
        return '<button data-url="' + u.replace(/"/g, '&quot;') + '" class="ctrl-btn small backend-history-item' +
          (cur ? ' active' : '') + '">' + u + '</button>';
      }).join('');
      histBox.querySelectorAll('button[data-url]').forEach(function (b) {
        b.addEventListener('click', function () { applyAndReload(b.dataset.url); });
      });
    }
  }

  function injectFloatingUI() {
    if (document.getElementById('tauri-settings-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'tauri-settings-btn';
    btn.innerHTML = '<i class="ph ph-plugs-connected" aria-hidden="true"></i>';
    btn.title = '后端连接设置（仅桌面版显示）';
    btn.setAttribute('aria-label', '后端连接设置');
    btn.className = 'tauri-settings-btn';

    var overlay = document.createElement('div');
    overlay.className = 'tauri-settings-overlay';
    overlay.innerHTML =
      '<div class="tauri-settings-dialog">' +
      '<div class="tauri-settings-title"><i class="ph ph-plugs-connected" aria-hidden="true"></i><span>后端连接设置</span></div>' +
      '<p>切换后将重新加载当前页面。</p>' +
      '<input id="tauri-backend-input" type="text" spellcheck="false" aria-label="后端地址" />' +
      '<div class="tauri-settings-actions">' +
      '<button id="tauri-backend-cancel" class="tauri-dialog-button">取消</button>' +
      '<button id="tauri-backend-save" class="tauri-dialog-button primary">保存并重连</button>' +
      '</div></div>';

    function openModal() {
      overlay.querySelector('#tauri-backend-input').value = getBackend();
      overlay.classList.add('open');
    }
    function closeModal() { overlay.classList.remove('open'); }

    btn.addEventListener('click', openModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#tauri-backend-cancel').addEventListener('click', closeModal);
    overlay.querySelector('#tauri-backend-save').addEventListener('click', function () {
      var v = normalizeUrl(overlay.querySelector('#tauri-backend-input').value);
      if (!/^https?:\/\/.+/.test(v)) {
        overlay.querySelector('#tauri-backend-input').style.borderColor = 'var(--danger)';
        return;
      }
      applyAndReload(v);
    });

    document.body.appendChild(btn);
    document.body.appendChild(overlay);
  }

  function injectSettingsUI() {
    var section = document.getElementById('backend-section');
    if (section) {
      wireBackendSection(section);
    } else {
      injectFloatingUI();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSettingsUI);
  } else {
    injectSettingsUI();
  }

  // 调试入口：控制台里可看当前生效的后端地址
  window.ROASTER_BACKEND = getBackend();
})();
