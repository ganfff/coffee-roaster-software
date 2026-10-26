/* Presentation binding only: existing controllers remain the owners of all actions. */
(function () {
  'use strict';
  const motion = window.RoasterMotion;
  const selector = '.wb-dialog,.modal-content,.tauri-settings-dialog,.atlas-confirm-box,.ai-tray,.ai-attachment-choices,.backend-connection-notice';
  const known = new WeakMap();
  function observeSurface(element) {
    if (element.querySelector('canvas')) return; // Never transform a live or editable plot.
    const visible = element.isConnected && element.getClientRects().length > 0 && !element.closest('[hidden]') && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
    if (known.get(element) === visible) return;
    known.set(element, visible);
    if (visible) motion.enter(element, element.matches('.ai-tray,.ai-attachment-choices') ? 'up' : 'content');
    else motion.cancel(element);
  }
  function scan(node) {
    if (!(node instanceof Element)) return;
    if (node.matches(selector)) observeSurface(node);
    node.querySelectorAll(selector).forEach(observeSurface);
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(scan);
        record.removedNodes.forEach(node => { if (node instanceof Element) { motion.cancel(node); known.delete(node); node.querySelectorAll(selector).forEach(element => { motion.cancel(element); known.delete(element); }); } });
      } else if (record.target.matches(selector) || record.target.matches('.wb-modal,.modal-overlay,.tauri-settings-overlay,details')) scan(record.target);
    }
  }).observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['hidden','class','open']});
  scan(document.body);
  const status = document.querySelector('.connection-copy'), copy = document.getElementById('nav-device-status');
  function syncDevice() { if (copy && status) copy.textContent = status.textContent; }
  if (status) new MutationObserver(syncDevice).observe(status, {childList:true, characterData:true, subtree:true});
  syncDevice();
  // Stable shell: only its identity/navigation enters; telemetry and safety never do.
  motion.enter(document.querySelector('.nav-brand'), 'header');
  motion.enter(document.querySelector('.workspace-nav .tabs'), 'sidebar');
  document.addEventListener('click', event => {
    const button = event.target.closest('.settings-nav button');
    if (button) motion.enter(document.querySelector('.settings-content'), 'up');
  });
})();
