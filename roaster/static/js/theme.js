/* Mhub appearance. Runs before CSS; the saved mode survives the palette upgrade. */
(function () {
  'use strict';
  var KEY = 'roaster.theme', PALETTE = 'roaster.palette';
  var modes = ['dark', 'light', 'auto'], memoryMode = 'auto', timer;
  var system = window.matchMedia('(prefers-color-scheme: light)');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function readMode() {
    try { var value = localStorage.getItem(KEY); if (modes.indexOf(value) !== -1) memoryMode = value; } catch (_) {}
    return memoryMode;
  }
  function resolve(mode) { return mode === 'auto' ? (system.matches ? 'light' : 'dark') : mode; }
  function getPalette() { return 'mhub'; }
  function sync() {
    var mode = readMode();
    document.querySelectorAll('[data-theme-mode]').forEach(function (button) {
      var active = button.dataset.themeMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    var quick = document.getElementById('btn-theme');
    if (quick) quick.setAttribute('aria-label', resolve(mode) === 'dark' ? '切换浅色主题' : '切换深色主题');
  }
  function apply(mode, notify) {
    var theme = resolve(mode), root = document.documentElement;
    root.dataset.theme = theme; root.dataset.palette = 'mhub'; root.setAttribute('theme-mode', theme); sync();
    if (notify) window.dispatchEvent(new CustomEvent('roaster-themechange', {detail: {theme: theme, mode: mode, palette: 'mhub'}}));
    return theme;
  }
  function clearTransition() { clearTimeout(timer); document.documentElement.classList.remove('theme-animating'); }
  function setMode(mode, options) {
    if (modes.indexOf(mode) === -1 || mode === readMode()) return;
    memoryMode = mode; try { localStorage.setItem(KEY, mode); } catch (_) {}
    clearTransition();
    if (!reduced.matches && !options?.silent) {
      document.documentElement.classList.add('theme-animating'); timer = setTimeout(clearTransition, 200);
    }
    apply(mode, true);
  }
  // Legacy callers remain supported; every old palette resolves to the new basis.
  function setPalette() { try { localStorage.setItem(PALETTE, 'mhub'); } catch (_) {} document.documentElement.dataset.palette = 'mhub'; }
  setPalette(); apply(readMode(), false);
  function listen(query, handler) { if (query.addEventListener) query.addEventListener('change', handler); else query.addListener(handler); }
  listen(system, function () { if (readMode() === 'auto') apply('auto', true); });
  listen(reduced, function () { if (reduced.matches) clearTransition(); });
  window.addEventListener('storage', function (event) { if (event.key === KEY) { memoryMode = 'auto'; apply(readMode(), true); } });
  function init() {
    document.getElementById('btn-theme')?.addEventListener('click', function () { setMode(resolve(readMode()) === 'dark' ? 'light' : 'dark'); });
    document.getElementById('theme-seg')?.addEventListener('click', function (event) { var button = event.target.closest('[data-theme-mode]'); if (button) setMode(button.dataset.themeMode); });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.RoasterTheme = {
    palettes: [{id: 'mhub', name: 'Mhub', description: '黑白灰面层与蓝色重点'}],
    getMode: readMode, getTheme: function () { return resolve(readMode()); }, setMode: setMode, getPalette: getPalette, setPalette: setPalette
  };
})();
