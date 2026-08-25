/* theme.js — 深色 / 浅色主题切换
 *
 * 加载时机:必须在 <head> 内、样式表之前以普通 <script src> 引入
 * (Tauri CSP script-src 'self' 禁止内联脚本),从而在首次绘制前
 * 把 data-theme 写到 <html>,避免主题闪烁(FOUC)。
 *
 * 契约:
 * - localStorage 键 'roaster.theme' ∈ 'dark' | 'light' | 'auto'(默认 'dark',
 *   保持树莓派 kiosk 既有观感;'auto' 跟随系统 prefers-color-scheme)
 * - 解析后的实际主题写在 <html data-theme="dark|light">,CSS 依此分支
 * - 主题变化时派发 window 事件 'roaster-themechange',
 *   detail = { theme: 'dark'|'light', mode: 'dark'|'light'|'auto' }
 *   app.js / editor.js 用它给 Chart.js 重新上色并 update('none')
 * - 切换瞬间给 <html> 加 .theme-animating(约 420ms),启用颜色过渡动画,
 *   结束后移除;prefers-reduced-motion 时跳过
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'roaster.theme';
  var MODES = ['dark', 'light', 'auto'];
  var mq = null;
  var animTimer = null;

  function readMode() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'dark' || v === 'light' || v === 'auto') return v;
    } catch (e) { /* 隐私模式等场景读不到存储,按默认处理 */ }
    return 'dark';
  }

  function resolve(mode) {
    if (mode === 'auto') {
      try {
        mq = mq || window.matchMedia('(prefers-color-scheme: light)');
        return mq.matches ? 'light' : 'dark';
      } catch (e) { return 'dark'; }
    }
    return mode;
  }

  /* 立即应用(无动画),供首次加载与系统主题变化使用 */
  function applySilent(mode) {
    var theme = resolve(mode);
    var root = document.documentElement;
    if (root.getAttribute('data-theme') !== theme) {
      root.setAttribute('data-theme', theme);
    }
    return theme;
  }

  function dispatch(theme, mode) {
    try {
      window.dispatchEvent(new CustomEvent('roaster-themechange', {
        detail: { theme: theme, mode: mode }
      }));
    } catch (e) { /* CustomEvent 不可用时静默降级,仅 CSS 主题生效 */ }
  }

  /* 用户主动切换:带过渡动画 */
  function setMode(mode, opts) {
    if (MODES.indexOf(mode) === -1) return;
    if (mode === readMode()) return; // 重复点击当前模式:零副作用早退
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) { /* 忽略 */ }
    var root = document.documentElement;
    var theme = resolve(mode);

    var reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* 忽略 */ }

    if (!reduced && !(opts && opts.silent)) {
      root.classList.add('theme-animating');
      if (animTimer) clearTimeout(animTimer);
      animTimer = setTimeout(function () {
        root.classList.remove('theme-animating');
        animTimer = null;
      }, 420);
    }

    applySilent(mode);
    syncSegUI(mode);
    dispatch(theme, mode);
  }

  function getMode() { return readMode(); }
  function getTheme() { return resolve(readMode()); }

  /* 设置页三段选择器与头部快捷按钮的状态同步 */
  function syncSegUI(mode) {
    var seg = document.getElementById('theme-seg');
    if (seg) {
      var btns = seg.querySelectorAll('button[data-theme-mode]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-theme-mode') === mode);
      }
    }
  }

  function onSystemChange() {
    if (readMode() !== 'auto') return;
    var theme = applySilent('auto');
    dispatch(theme, 'auto');
  }

  function initUI() {
    // 跟随系统模式下的系统主题监听
    try {
      mq = mq || window.matchMedia('(prefers-color-scheme: light)');
      if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
      else if (mq.addListener) mq.addListener(onSystemChange);
    } catch (e) { /* 忽略 */ }

    // 头部快捷切换:dark <-> light(显式选择,脱离 auto)
    var quick = document.getElementById('btn-theme');
    if (quick) {
      quick.addEventListener('click', function () {
        setMode(getTheme() === 'dark' ? 'light' : 'dark');
      });
    }

    // 设置页:跟随系统 / 深色 / 浅色
    var seg = document.getElementById('theme-seg');
    if (seg) {
      seg.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-theme-mode]') : null;
        if (!btn) return;
        setMode(btn.getAttribute('data-theme-mode'));
      });
    }

    syncSegUI(readMode());
  }

  // 1) 脚本在 <head> 同步执行:立刻落主题,防闪烁
  applySilent(readMode());

  // 2) DOM 就绪后再接控件
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  // 3) 对外 API(供 app.js / editor.js / 调试)
  window.RoasterTheme = {
    getMode: getMode,
    getTheme: getTheme,
    setMode: setMode
  };
})();
