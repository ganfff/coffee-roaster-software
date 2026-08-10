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
  var DEFAULT_BACKEND = 'http://localhost:8000';

  function getBackend() {
    var v = '';
    try { v = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { /* 隐私模式等 */ }
    v = v.trim().replace(/\/+$/, '');
    return v || DEFAULT_BACKEND;
  }

  function setBackend(url) {
    try { localStorage.setItem(STORAGE_KEY, url); } catch (e) { /* ignore */ }
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
    overlay.innerHTML =
      '<div style="background:#1c1c1e;border:1px solid rgba(255,255,255,.15);border-radius:12px;' +
      'padding:20px 22px;width:340px;color:#eee;font-family:inherit;">' +
      '<div style="font-size:15px;font-weight:600;margin-bottom:10px;">后端连接设置</div>' +
      '<div style="font-size:12px;color:#999;margin-bottom:8px;">烘焙机后端（FastAPI）的地址，' +
      '本机运行填 localhost；连局域网树莓派填其 IP。</div>' +
      '<input id="tauri-backend-input" type="text" spellcheck="false" style="width:100%;box-sizing:border-box;' +
      'padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#2c2c2e;' +
      'color:#eee;font-size:13px;outline:none;" />' +
      '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">' +
      '<button id="tauri-backend-default" style="padding:6px 12px;border-radius:8px;border:1px solid ' +
      'rgba(255,255,255,.2);background:transparent;color:#bbb;cursor:pointer;font-size:13px;">恢复默认</button>' +
      '<button id="tauri-backend-cancel" style="padding:6px 12px;border-radius:8px;border:1px solid ' +
      'rgba(255,255,255,.2);background:transparent;color:#bbb;cursor:pointer;font-size:13px;">取消</button>' +
      '<button id="tauri-backend-save" style="padding:6px 12px;border-radius:8px;border:none;' +
      'background:#0a84ff;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">保存并重连</button>' +
      '</div></div>';

    function openModal() {
      overlay.querySelector('#tauri-backend-input').value = getBackend();
      overlay.style.display = 'flex';
    }
    function closeModal() { overlay.style.display = 'none'; }

    btn.addEventListener('click', openModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#tauri-backend-cancel').addEventListener('click', closeModal);
    overlay.querySelector('#tauri-backend-default').addEventListener('click', function () {
      overlay.querySelector('#tauri-backend-input').value = DEFAULT_BACKEND;
    });
    overlay.querySelector('#tauri-backend-save').addEventListener('click', function () {
      var v = overlay.querySelector('#tauri-backend-input').value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/.+/.test(v)) {
        overlay.querySelector('#tauri-backend-input').style.borderColor = '#ff453a';
        return;
      }
      setBackend(v);
      window.location.reload();
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
