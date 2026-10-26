/* Native adaptation of Mhub's region/lifecycle model. No vendor runtime or SDK. */
(function () {
  'use strict';
  const duration = 200, easing = 'cubic-bezier(.43,.77,.16,1)';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Map(), queue = [];
  let scheduled = false, paused = false, serial = 0;
  const frames = {
    sidebar: () => [{transform:'translateY(100%)'}, {transform:'translateY(0)'}],
    header: () => [{transform:'translateY(-100%)'}, {transform:'translateY(0)'}],
    tab: () => [{transform:'translateX(100%)'}, {transform:'translateX(0)'}],
    content: () => [{opacity:0, transform:'scale(1.25)'}, {opacity:1, transform:'scale(1)'}],
    mouseKey: () => [{transform:'translateX(calc(-100% - 60px))'}, {transform:'translateX(0)'}],
    footer: element => [{transform:'translateY(' + Math.max(20, innerHeight - element.getBoundingClientRect().top + element.offsetHeight) + 'px)'}, {transform:'translateY(0)'}],
    up: () => [{opacity:0, transform:'translateY(20px)'}, {opacity:1, transform:'translateY(0)'}]
  };
  function settle(record, status) {
    if (record.done) return;
    record.done = true;
    if (record.animation) {
      record.animation.onfinish = null; record.animation.oncancel = null;
      record.animation.cancel(); // Removes the WAAPI effect; authored styles are never overwritten.
    }
    if (active.get(record.element) === record) active.delete(record.element);
    record.resolve({status, id:record.id});
  }
  function cancel(element) { const record = active.get(element); if (record) settle(record, 'cancelled'); }
  function drain() {
    scheduled = false;
    if (paused) return;
    let count = 0;
    while (queue.length && count < 5) {
      const record = queue.shift();
      if (record.done || active.get(record.element) !== record) continue;
      count++;
      if (reduced.matches || !record.element.isConnected || !record.element.animate || record.element.closest('[hidden]')) { settle(record, 'skipped'); continue; }
      try {
        let keyframes = frames[record.type](record.element);
        if (record.direction === 'leave') keyframes = keyframes.slice().reverse();
        record.animation = record.element.animate(keyframes, {duration, easing, fill:'both'});
        record.animation.onfinish = () => settle(record, 'finished');
        record.animation.oncancel = () => settle(record, 'cancelled');
      } catch (_) { settle(record, 'skipped'); }
    }
    schedule();
  }
  function schedule() {
    if (scheduled || paused || !queue.length) return;
    scheduled = true;
    if ('requestIdleCallback' in window) requestIdleCallback(drain, {timeout:40});
    else setTimeout(drain, 20);
  }
  function run(element, type = 'content', direction = 'enter') {
    if (!element || !(type in frames)) return Promise.resolve({status:'skipped'});
    cancel(element);
    if (reduced.matches || !element.animate) return Promise.resolve({status:'skipped'});
    return new Promise(resolve => {
      const record = {element, type, direction, resolve, id:++serial};
      active.set(element, record); queue.push(record); schedule();
    });
  }
  function finishAll() { for (const record of [...active.values()]) settle(record, 'skipped'); queue.length = 0; }
  function pause() { paused = true; for (const record of active.values()) record.animation?.pause(); }
  function resume() { paused = false; for (const record of active.values()) record.animation?.play(); schedule(); }
  reduced.addEventListener('change', () => { if (reduced.matches) finishAll(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else resume(); });
  window.RoasterMotion = {
    enter:(element, type) => run(element, type), leave:(element, type) => run(element, type, 'leave'),
    cancel, pause, resume, finishAll,
    get state() { return {active:active.size, queued:queue.filter(record => !record.done).length, paused, reduced:reduced.matches}; },
    duration, easing, types:Object.keys(frames)
  };
})();
