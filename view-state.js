(function () {
  'use strict';

  // Reading state lives only in this page. Never capture form values or write case storage.
  const fresh = () => ({ scrollY: 0, partyTab: 'buyer', flowOpen: false, partyOpen: false });
  const views = { ready: fresh(), preview: fresh() };
  const pointers = new Map();
  let currentMode = null;
  let currentScrollReady = true;
  let generation = 0;
  let pending = null;
  let frame = null;

  const byId = id => document.getElementById(id);
  const isMode = mode => mode === 'ready' || mode === 'preview';
  const elementTarget = event => event.target instanceof Element ? event.target : null;

  function cancelPending(acceptCurrentScroll) {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
    if (acceptCurrentScroll) currentScrollReady = true;
  }

  function yieldToUser() {
    // A new reading/editing action takes precedence over a delayed return position.
    cancelPending(true);
  }

  function rememberCurrent() {
    const state = views[currentMode];
    if (!state) return;
    const party = document.querySelector('.party-tab.active')?.dataset.party;
    state.partyTab = ['buyer', 'seller', 'agent'].includes(party) ? party : 'buyer';
    state.flowOpen = !!byId('flowSection')?.classList.contains('open');
    state.partyOpen = !!byId('partySection')?.classList.contains('open');
    // During held navigation, an intermediate mode still has the preceding mode's Y.
    // Keep its own saved Y until that mode has actually been restored or used.
    if (currentScrollReady) state.scrollY = Math.max(0, window.scrollY || 0);
  }

  function beforeSwitch(mode) {
    if (!isMode(mode)) return null;
    // Startup collapse/default handling belongs to the existing initialization code.
    if (currentMode === null) {
      currentMode = mode;
      return null;
    }
    if (mode === currentMode) return null;
    rememberCurrent();
    cancelPending(false);
    currentMode = mode;
    currentScrollReady = false;
    return { generation: ++generation, mode };
  }

  function sharedBodies() {
    return ['flowSection', 'partySection'].map(id =>
      byId(id)?.querySelector('.collapse-section-body')).filter(Boolean);
  }

  function sectionMotionActive() {
    return sharedBodies().some(body => typeof body.getAnimations === 'function' &&
      body.getAnimations().some(animation => animation.pending || animation.playState === 'running'));
  }

  function keyboardMotionActive() {
    if (typeof window.__isCalcKbMotionActive === 'function') {
      return window.__isCalcKbMotionActive();
    }
    // The hook is installed later in the main script; startup itself does not restore.
    return !!byId('calcKb')?.classList.contains('show') ||
      (parseFloat(document.body.style.paddingBottom) || 0) > 0;
  }

  function schedule() {
    if (pending && frame === null && !pointers.size && !document.hidden) {
      frame = requestAnimationFrame(restoreWhenSettled);
    }
  }

  function restoreWhenSettled() {
    frame = null;
    const job = pending;
    if (!job || job.generation !== generation || job.mode !== currentMode) return;
    if (pointers.size || document.hidden) return;
    if (keyboardMotionActive() || sectionMotionActive()) {
      job.stableFrames = 0;
      job.signature = null;
      schedule();
      return;
    }
    if (!job.fitted) {
      job.fitted = true;
      if (views[currentMode].flowOpen && typeof window.autoFitFlowNumbers === 'function') {
        window.autoFitFlowNumbers();
      }
    }
    // Mode application already queues label fitting at 50/60 ms. Allow those and
    // the section transition to finish before clamping to the destination height.
    const signature = [document.documentElement.scrollHeight, window.innerWidth,
      window.innerHeight, ...sharedBodies().map(body => body.getBoundingClientRect().height)].join('|');
    job.stableFrames = signature === job.signature ? job.stableFrames + 1 : 0;
    job.signature = signature;
    if (performance.now() - job.startedAt < 80 || job.stableFrames < 2) {
      schedule();
      return;
    }
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ left: window.scrollX, top: Math.min(job.scrollY, maxY), behavior: 'instant' });
    currentScrollReady = true;
    pending = null;
  }

  function afterSwitch(ticket) {
    if (!ticket || ticket.generation !== generation || ticket.mode !== currentMode) return;
    const state = views[currentMode];
    byId('flowSection')?.classList.toggle('open', state.flowOpen);
    byId('partySection')?.classList.toggle('open', state.partyOpen);
    document.querySelectorAll('.party-tab').forEach(tab =>
      tab.classList.toggle('active', tab.dataset.party === state.partyTab));
    document.querySelectorAll('.party-content').forEach(content =>
      content.classList.toggle('active', content.id === 'party-' + state.partyTab));
    if (typeof window.__syncInteractiveRegions === 'function') window.__syncInteractiveRegions();
    if (typeof window.refreshPartyWanDisplays === 'function') window.refreshPartyWanDisplays();
    pending = { generation, mode: currentMode, scrollY: state.scrollY,
      startedAt: performance.now(), signature: null, stableFrames: 0, fitted: false };
    schedule();
  }

  function isOtherModeControl(target) {
    const button = target?.closest('.ver-btn');
    return !!button && isMode(button.dataset.ver) && button.dataset.ver !== currentMode;
  }

  window.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const target = elementTarget(event);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY,
      versionDrag: !!target?.closest('.ver-switch') });
    if (!isOtherModeControl(target)) yieldToUser();
  }, true);

  function releasePointer(event) {
    pointers.delete(event.pointerId);
    schedule();
  }
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', releasePointer, true);
  window.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      releasePointer(event);
      return;
    }
    const start = pointers.get(event.pointerId);
    if (!start || !pending) return;
    const dx = Math.abs(event.clientX - start.x), dy = Math.abs(event.clientY - start.y);
    // Horizontal dragging on the version bar may visit both modes before release.
    // A vertical gesture belongs to the user's scrolling instead.
    if ((!start.versionDrag && Math.max(dx, dy) > 8) || (dy > 8 && dy > dx)) yieldToUser();
  }, true);

  window.addEventListener('wheel', yieldToUser, { capture: true, passive: true });
  window.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && isOtherModeControl(elementTarget(event))) return;
    yieldToUser();
  }, true);
  // The existing navigation drag guard runs on window capture. Observe only clicks
  // that pass that guard, so a suppressed release click cannot cancel our restore.
  document.addEventListener('click', event => {
    // Preserve the existing same-mode click-to-top and double-click section toggle.
    // The drag handler marks its own clicks; they must not accept an inherited Y.
    if (!event.__navDrag && !isOtherModeControl(elementTarget(event))) yieldToUser();
  }, true);

  function suspend() {
    pointers.clear();
    cancelPending(false);
  }
  window.addEventListener('blur', suspend);
  window.addEventListener('pagehide', suspend);
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); });
  window.addEventListener('resize', () => { pointers.clear(); yieldToUser(); });

  window.FwViewState = Object.freeze({ beforeSwitch, afterSwitch });
})();
