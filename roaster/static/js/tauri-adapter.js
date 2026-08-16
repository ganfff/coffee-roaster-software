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
 * 页面右下角会注入一个 ⚙ 按钮可随时修改（仅在 Tauri 内出现）。
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

  // ---- 注入后端地址设置 UI（自定义弹窗，Tauri 里 prompt() 不可用）----
  function injectSettingsUI() {
    if (document.getElementById('tauri-settings-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'tauri-settings-btn';
    btn.textContent = '⚙';
    btn.title = '后端连接设置（仅桌面版显示）';
    btn.style.cssText =
      'position:fixed;right:12px;bottom:64px;z-index:1030;width:36px;height:36px;' +
      'border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(40,40,42,.85);' +
      'color:#ddd;font-size:17px;cursor:pointer;opacity:.65;transition:opacity .15s;';
    btn.onmouseenter = function () { btn.style.opacity = '1'; };
    btn.onmouseleave = function () { btn.style.opacity = '.65'; };

    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1031;background:rgba(0,0,0,.55);display:none;' +
      'align-items:center;justify-content:center;';

    var panel =
      '<div style="background:#1c1c1e;border:1px solid rgba(255,255,255,.15);border-radius:12px;' +
      'padding:20px 22px;width:380px;color:#eee;font-family:inherit;">' +
      '<div style="font-size:15px;font-weight:600;margin-bottom:12px;">后端连接设置</div>' +

      '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
      '<button data-preset="sim" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);' +
      'background:#2c2c2e;color:#eee;cursor:pointer;font-size:13px;text-align:left;">' +
      '<div style="font-weight:600;">模拟器</div>' +
      '<div style="font-size:10px;color:#999;">本机模拟后端</div></button>' +
      '<button data-preset="real" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);' +
      'background:#2c2c2e;color:#eee;cursor:pointer;font-size:13px;text-align:left;">' +
      '<div style="font-weight:600;">实机</div>' +
      '<div style="font-size:10px;color:#999;">树莓派 · 真实温控器</div></button>' +
      '</div>' +

      '<div style="display:flex;gap:6px;margin-bottom:12px;align-items:center;">' +
      '<input id="tauri-real-preset" type="text" spellcheck="false" style="flex:1;padding:6px 8px;border-radius:6px;' +
      'border:1px solid rgba(255,255,255,.2);background:#2c2c2e;color:#eee;font-size:11px;outline:none;" />' +
      '<button id="tauri-save-preset" style="padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);' +
      'background:transparent;color:#bbb;cursor:pointer;font-size:11px;white-space:nowrap;">存为实机预设</button>' +
      '</div>' +

      '<div id="tauri-history" style="margin-bottom:12px;"></div>' +

      '<input id="tauri-backend-input" type="text" spellcheck="false" style="width:100%;box-sizing:border-box;' +
      'padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#2c2c2e;' +
      'color:#eee;font-size:13px;outline:none;" />' +
      '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">' +
      '<button id="tauri-backend-cancel" style="padding:6px 12px;border-radius:8px;border:1px solid ' +
      'rgba(255,255,255,.2);background:transparent;color:#bbb;cursor:pointer;font-size:13px;">取消</button>' +
      '<button id="tauri-backend-save" style="padding:6px 12px;border-radius:8px;border:none;' +
      'background:#0a84ff;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">保存并重连</button>' +
      '</div></div>';
    overlay.innerHTML = panel;

    function renderHistory() {
      var box = overlay.querySelector('#tauri-history');
      var h = getHistory();
      if (!h.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div style="font-size:11px;color:#999;margin-bottom:5px;">最近使用</div>' +
        h.map(function (u) {
          var cur = u === getBackend();
          return '<button data-url="' + u.replace(/"/g, '&quot;') + '" style="margin:0 6px 6px 0;padding:4px 10px;' +
            'border-radius:12px;font-size:11px;cursor:pointer;border:1px solid ' +
            (cur ? '#0a84ff' : 'rgba(255,255,255,.2)') + ';background:' +
            (cur ? 'rgba(10,132,255,.18)' : '#2c2c2e') + ';color:' + (cur ? '#0a84ff' : '#ccc') + ';">' +
            u + '</button>';
        }).join('');
      box.querySelectorAll('button[data-url]').forEach(function (b) {
        b.addEventListener('click', function () { applyAndReload(b.dataset.url); });
      });
    }

    function applyAndReload(url) {
      if (!/^https?:\/\/.+/.test(url)) return;
      setBackend(url);
      window.location.reload();
    }

    function openModal() {
      overlay.querySelector('#tauri-backend-input').value = getBackend();
      overlay.querySelector('#tauri-real-preset').value = getRealPreset();
      renderHistory();
      overlay.style.display = 'flex';
    }
    function closeModal() { overlay.style.display = 'none'; }

    btn.addEventListener('click', openModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#tauri-backend-cancel').addEventListener('click', closeModal);
    overlay.querySelector('[data-preset="sim"]').addEventListener('click', function () {
      applyAndReload(SIMULATOR_URL);
    });
    overlay.querySelector('[data-preset="real"]').addEventListener('click', function () {
      applyAndReload(getRealPreset());
    });
    overlay.querySelector('#tauri-save-preset').addEventListener('click', function () {
      var v = normalizeUrl(overlay.querySelector('#tauri-real-preset').value);
      if (/^https?:\/\/.+/.test(v)) {
        lsSet(REAL_PRESET_KEY, v);
        overlay.querySelector('#tauri-save-preset').textContent = '已保存 ✓';
        setTimeout(function () {
          overlay.querySelector('#tauri-save-preset').textContent = '存为实机预设';
        }, 1200);
      }
    });
    overlay.querySelector('#tauri-backend-save').addEventListener('click', function () {
      var v = normalizeUrl(overlay.querySelector('#tauri-backend-input').value);
      if (!/^https?:\/\/.+/.test(v)) {
        overlay.querySelector('#tauri-backend-input').style.borderColor = '#ff453a';
        return;
      }
      applyAndReload(v);
    });

    document.body.appendChild(btn);
    document.body.appendChild(overlay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSettingsUI);
  } else {
    injectSettingsUI();
  }

  // 调试入口：控制台里可看当前生效的后端地址
  window.ROASTER_BACKEND = getBackend();
})();
