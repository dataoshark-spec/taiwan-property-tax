/* Display preferences only. Full formatted sources and all calculation values stay intact. */
(function () {
  'use strict';
  const groups = {
    commission: { places: 2, label: '佣收', ids: ['s_total','s_limit','s_final','p_s_total','p_s_limit','p_s_final'] },
    percent: { places: 4, label: '下方百分比', ids: ['d_buyer_pct','p_buyer_pct','p_paid_pct','p_unpaid_pct'] },
    wan: { places: 4, label: '下方萬元', ids: ['d_buyer_total','d_buy_taxfee','d_sell_ded','d_exempt','d_buyer_pct_amt','d_target_now','d_seller_amt','p_buyer_total','p_buy_taxfee','p_sell_ded','p_buyer_pct_amt','p_target_now','p_seller_amt'] },
    flowPercent: { places: 2, label: '公式流程仲介費百分比', ids: ['flow_seller_pct','p_flow_seller_pct'] },
    agentFinalPercent: { places: 2, label: '仲介明細最終服務費百分比', ids: ['pt_agent_kpi','p_pt_agent_kpi'] }
  };
  const prefix = 'fwTax_precision_v1:';
  const byId = new Map(), source = new Map(), targets = new Map();
  const places = {};
  let started = false, onWriteError = null;
  for (const [name, group] of Object.entries(groups)) {
    places[name] = group.places;
    group.ids.forEach(id => byId.set(id, name));
  }
  function decode(name, value) {
    return /^[1-4]$/.test(value || '') ? Number(value) : groups[name].places;
  }
  function reloadPreferences() {
    for (const name of Object.keys(groups)) {
      try { places[name] = decode(name, localStorage.getItem(prefix + name)); } catch (_) {}
    }
  }
  reloadPreferences();
  function shortened(text, count) {
    // Cut the existing four-place display string, never parse/round its value.
    // Preserve sign, grouping separators, suffix, and nonnumeric placeholders.
    const match = /^([+-]?[\d,]+)\.(\d{4})(\s*%?)$/.exec(text);
    return match ? match[1] + '.' + match[2].slice(0, count) + match[3] : text;
  }
  function format(id, text) {
    const group = byId.get(id);
    if (!group) return text;
    source.set(id, String(text));
    return shortened(String(text), places[group]);
  }
  function describe(name) {
    const next = places[name] % 4 + 1;
    for (const id of groups[name].ids) {
      const target = targets.get(id);
      if (!target) continue;
      target.dataset.precisionPlaces = String(places[name]);
      target.title = '點擊切換小數位數（目前 ' + places[name] + ' 位）';
      // Keep the live label/value/unit as the button's accessible name.
      target.setAttribute('aria-description', groups[name].label + '顯示 ' + places[name] + ' 位小數，啟用改為 ' + next + ' 位');
    }
  }
  function repaint(name) {
    for (const id of groups[name].ids) {
      const node = document.getElementById(id);
      if (!node || !source.has(id)) continue;
      const output = node.querySelector('.__fit-num') || node;
      output.textContent = shortened(source.get(id), places[name]);
      if (output !== node) output.style.transform = '';
    }
    describe(name);
    if (name === 'commission' && typeof window.__fitSafetyValues === 'function') {
      requestAnimationFrame(() => window.__fitSafetyValues());
    }
    if (name === 'flowPercent' && typeof window.autoFitFlowNumbers === 'function') {
      requestAnimationFrame(() => window.autoFitFlowNumbers());
    }
  }
  function refresh() {
    reloadPreferences();
    if (started) Object.keys(groups).forEach(repaint);
  }
  function visible(target) {
    return target && target.isConnected && target.getClientRects().length &&
      !target.closest('[inert], [aria-hidden="true"]');
  }
  function targetOf(node) {
    return node instanceof Element ? node.closest('[data-precision-group]') : null;
  }
  function cycle(target, restoreFocus = false) {
    if (!visible(target)) return;
    // Draft completion can replace the clicked renderer output. Keep its logical
    // identity, then resolve the live target and the newly formatted full source.
    const name = target.dataset.precisionGroup;
    const id = target.dataset.precisionTargetId;
    if (!groups[name] || byId.get(id) !== name) return;
    // This is the app's existing completion path, including invalid draft guards.
    if (typeof window.__commitCalcKbDraft === 'function' && window.__commitCalcKbDraft() === false) return;
    refreshTargets();
    const currentTarget = targets.get(id);
    if (!visible(currentTarget)) return;
    const next = places[name] % 4 + 1;
    try { localStorage.setItem(prefix + name, String(next)); }
    catch (error) { if (onWriteError) onWriteError(prefix + name, error); return; }
    places[name] = next;
    repaint(name);
    if (restoreFocus) currentTarget.focus({ preventScroll: true });
  }

  // Native clicks are the only pointer activation. Pointer tracking rejects drags,
  // scrolling, cancelled contacts and multitouch without blocking browser gestures.
  const pointers = new Set();
  let gesture = null;
  function cancelGesture() {
    if (gesture) {
      gesture.cancelled = true;
      gesture.target.classList.remove('precision-pressed');
    }
  }
  window.addEventListener('pointerdown', event => {
    pointers.add(event.pointerId);
    if (pointers.size > 1) { cancelGesture(); return; }
    cancelGesture();
    gesture = null;
    const target = targetOf(event.target);
    if (!started || !visible(target) || !event.isPrimary || event.button !== 0) return;
    gesture = { id: event.pointerId, target, x: event.clientX, y: event.clientY,
      cancelled: false, ended: false, endedAt: 0 };
    target.classList.add('precision-pressed');
  }, { capture: true, passive: true });
  window.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) cancelGesture();
  }, { capture: true, passive: true });
  function finish(event) {
    pointers.delete(event.pointerId);
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture.ended = true;
    gesture.endedAt = performance.now();
    gesture.target.classList.remove('precision-pressed');
    const rect = gesture.target.getBoundingClientRect();
    if (event.type === 'pointercancel' || pointers.size ||
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8 ||
        event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) cancelGesture();
  }
  window.addEventListener('pointerup', finish, { capture: true, passive: true });
  window.addEventListener('pointercancel', finish, { capture: true, passive: true });
  window.addEventListener('scroll', cancelGesture, { capture: true, passive: true });
  window.addEventListener('resize', cancelGesture);
  window.addEventListener('blur', () => { cancelGesture(); pointers.clear(); });
  window.addEventListener('pagehide', () => { cancelGesture(); pointers.clear(); });
  document.addEventListener('visibilitychange', () => {
    cancelGesture(); pointers.clear();
    if (!document.hidden) refresh();
  });
  // Loaded before the app's listeners: isolate both rate-card descendants before
  // their original navigation/keyboard click handlers can run.
  document.addEventListener('click', event => {
    const target = targetOf(event.target);
    if (!started || !target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.detail > 0) {
      if (!gesture || gesture.target !== target || !gesture.ended || gesture.cancelled ||
          performance.now() - gesture.endedAt > 1000) return;
    }
    cancelGesture();
    gesture = null;
    cycle(target);
  }, true);
  document.addEventListener('keydown', event => {
    const target = targetOf(event.target);
    if (!started || !target || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) cycle(target, true);
  }, true);
  window.addEventListener('storage', event => {
    try { if (event.storageArea !== localStorage) return; } catch (_) { return; }
    if (event.key === null) { refresh(); return; }
    if (!event.key.startsWith(prefix)) return;
    const name = event.key.slice(prefix.length);
    if (!groups[name]) return;
    // A queued event can describe an older write than the current setting.
    try { places[name] = decode(name, localStorage.getItem(prefix + name)); } catch (_) { return; }
    if (started) repaint(name);
  });
  window.addEventListener('pageshow', refresh);
  window.addEventListener('focus', refresh);
  function refreshTargets() {
    for (const [id, name] of byId) {
      const node = document.getElementById(id);
      const target = !node ? null : name === 'agentFinalPercent' ? node :
        node.closest(name === 'commission' ? '.safety-cell' : name === 'flowPercent' ? '.flow-cell' : '.dash-subnote');
      if (!target) { targets.delete(id); continue; }
      targets.set(id, target);
      target.dataset.precisionGroup = name;
      target.dataset.precisionTargetId = id;
      target.setAttribute('role', 'button');
      target.tabIndex = 0;
    }
    Object.keys(groups).forEach(describe);
  }
  function start(options = {}) {
    if (started) return;
    onWriteError = options.onWriteError;
    refreshTargets();
    started = true;
    Object.keys(groups).forEach(repaint);
  }
  window.FwPrecision = Object.freeze({ format, start, refreshTargets });
})();
