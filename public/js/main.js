// Boot: connect to the server (SSE), keep session state, drive input, camera and the frame loop.
import { $, S, actors, prefs, nowS } from './state.js';
import { cam, fitCamera, setZoom, resetCamera, clampCam, P, defaultZoom } from './iso.js';
import { initScene, drawFrame, pick, invalidateStatic } from './scene.js';
import { syncClaude, syncAgent, removeSessionActors, ensureUser, clearActors, assignSlots, animateLink, updateActors, releaseSpot } from './actors.js';
import {
  initUI, initSettings, renderDirectory, renderTop, renderConn, renderLog, scheduleLog, renderChat,
  showTooltip, hideTooltip, select, focusActor, toast, onFleet, closeElevatorOverlay, openElevatorOverlay,
} from './ui.js';

const canvas = $('#office');
initScene(canvas);

// ---- network ---------------------------------------------------------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { floor: p.get('floor'), session: p.get('session') };
}
function writeHash(floor, session) {
  const p = new URLSearchParams();
  if (floor) p.set('floor', floor);
  if (session) p.set('session', session);
  history.replaceState(null, '', '#' + p.toString());
}

function connect(floor, session) {
  if (S.es) S.es.close();
  S.sessions.clear();
  S.order = [];
  clearActors();
  if (S.selected && S.selected.kind === 'actor' && S.selected.id !== 'user') select(null);
  const q = new URLSearchParams();
  if (floor) q.set('floor', floor);
  if (session) q.set('session', session);
  if (!prefs.coworkers) q.set('coworkers', '0');
  const es = new EventSource('/events?' + q.toString());
  S.es = es;
  S.firstView = true;
  S.rolesSeen = false;
  es.onopen = () => { S.connected = true; renderConn(); };
  es.onerror = () => { S.connected = false; renderConn(); };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
}

function mergeAgent(s, a) {
  const prev = s.agents.get(a.key);
  const merged = Object.assign(prev || { log: [] }, a);
  if (!merged.log) merged.log = [];
  s.agents.set(a.key, merged);
  return merged;
}

function handle(m) {
  switch (m.t) {
    case 'floors': {
      S.offset = m.now - Date.now();
      S.floors = m.floors;
      S.sources = m.sources;
      S.accounts = new Map(m.accounts.map((a) => [a.key, a]));
      renderDirectory();
      renderTop();
      break;
    }
    case 'view': {
      const prevNum = S.view.num;
      const changed = prevNum !== m.num || S.view.floor !== m.floor;
      S.view = { floor: m.floor, num: m.num, primary: m.primary, mode: m.mode };
      writeHash(m.floor, m.mode === 'pin' ? m.primary : null);
      if (changed) invalidateStatic();
      if (m.switched) toast('🔄 새 세션이 열려서 따라왔어요 (/clear 또는 새 claude)');
      if (S.firstView) { S.firstView = false; openElevatorOverlay(); } else if (prevNum != null && prevNum !== m.num) openElevatorOverlay();
      renderDirectory();
      renderTop();
      break;
    }
    case 'sess': {
      const snap = m.snap;
      const old = S.sessions.get(m.sid);
      const s = {
        sid: m.sid, meta: m.meta || {}, claude: snap.claude, agents: new Map(), board: snap.board, log: snap.log || [],
        busy: snap.busy, lastTs: snap.lastTs, firstTs: snap.firstTs, lastPrompt: snap.lastPrompt, stats: snap.stats, rooms: snap.rooms || {},
        slot: old ? old.slot : S.order.indexOf(m.sid) >= 0 ? S.order.indexOf(m.sid) : S.sessions.size,
        joinedLive: S.rolesSeen && !old,
      };
      for (const a of [...(snap.history || []), ...snap.agents]) mergeAgent(s, a);
      for (const a of [...actors.values()]) if (a.sid === m.sid && a.mode === 'leaving') { releaseSpot(a); actors.delete(a.id); }
      S.sessions.set(m.sid, s);
      assignSlots();
      syncClaude(s, false);
      for (const st of snap.agents) syncAgent(s, s.agents.get(st.key), false);
      if (s.joinedLive) toast(`👥 Claude·${s.meta.acct || ''} 출근: ${s.meta.title || ''}`);
      if (S.pendingSelect && S.pendingSelect.split(':')[1] === m.sid) {
        const id = S.pendingSelect;
        S.pendingSelect = null;
        setTimeout(() => focusActor(id), 300);
      }
      renderTop();
      scheduleLog();
      break;
    }
    case 'drop':
      if (S.sessions.delete(m.sid)) { removeSessionActors(m.sid, true); scheduleLog(); renderTop(); }
      break;
    case 'roles':
      S.rolesSeen = true;
      S.order = m.order;
      assignSlots();
      renderDirectory();
      break;
    case 'ev':
      onEvent(m.sid, m.e);
      break;
    case 'links':
      S.links = m.links;
      renderChat();
      break;
    case 'link':
      S.links.push(m.link);
      if (S.links.length > 200) S.links.shift();
      renderChat();
      animateLink(m.link);
      break;
    case 'fleet': {
      const prev = S.fleet;
      S.fleet = m.sessions;
      S.fleetAt = Date.now();
      onFleet(prev, m.sessions);
      break;
    }
  }
}

function onEvent(sid, e) {
  const s = S.sessions.get(sid);
  if (!s) return;
  s.lastTs = nowS();
  switch (e.k) {
    case 'claude': s.claude = e.s; syncClaude(s, true); break;
    case 'agent': syncAgent(s, mergeAgent(s, e.s), true); break;
    case 'alog': {
      const a = s.agents.get(e.key);
      if (a) { a.log.push(e.e); if (a.log.length > 40) a.log.shift(); if (prefs.logAgents) scheduleLog(); }
      break;
    }
    case 'board': s.board = e.s; break;
    case 'log': s.log.push(e.e); if (s.log.length > 120) s.log.shift(); scheduleLog(); break;
    case 'title': s.meta.title = e.title; renderTop(); break;
    case 'busy': s.busy = e.busy; break;
    case 'stats': s.stats = e.s; s.rooms = e.rooms || s.rooms; break;
    case 'prompt': {
      s.lastPrompt = { text: e.full || e.text, ts: nowS() };
      const u = actors.get('user');
      if (!e.from && u) u.say({ kind: 'user', text: '🧑‍💻 ' + e.text }, 6000);
      break;
    }
    case 'answer': {
      const u = actors.get('user');
      if (u) u.say({ kind: 'user', text: '💬 ' + e.text }, 4500);
      break;
    }
  }
}

function selectFloor(fkey, force) {
  if (!fkey) return;
  if (fkey === S.view.floor && S.view.mode === 'follow' && !force) return;
  const f = S.floors.find((x) => x.fkey === fkey);
  if (fkey !== S.view.floor) closeElevatorOverlay(f);
  writeHash(fkey, null);
  setTimeout(() => connect(fkey, null), fkey !== S.view.floor ? 380 : 0);
}
function selectSession(sid) {
  const f = S.floors.find((x) => x.sessions.some((s) => s.sid === sid));
  if (f && f.fkey !== S.view.floor) closeElevatorOverlay(f);
  writeHash(f ? f.fkey : S.view.floor, sid);
  connect(f ? f.fkey : S.view.floor, sid);
}

// ---- canvas size, camera ------------------------------------------------------------------
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1); // 3x phone screens would cost a lot for little gain
  const w = Math.max(320, canvas.clientWidth);
  const h = Math.max(240, canvas.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const first = !resize.done;
  resize.done = true;
  fitCamera(w, h, dpr);
  if (first) { cam.zoom = defaultZoom(); cam.k = cam.fit * cam.zoom; }
  clampCam();
  drawFrame(performance.now()); // resizing clears the canvas; repaint right away
}
new ResizeObserver(resize).observe(canvas);

// Mouse: drag pans, hover shows info. Touch: one finger pans, two fingers pinch-zoom, tap opens details.
let drag = null;
let pinch = null;
const pointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: cam.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    drag = null;
    cam.follow = null;
    hideTooltip();
    return;
  }
  if (pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: cam.cx, cy: cam.cy, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    setZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), mx, my);
    cam.cx -= (mx - pinch.mx) / cam.k;
    cam.cy -= (my - pinch.my) / cam.k;
    pinch.mx = mx;
    pinch.my = my;
    clampCam();
    return;
  }
  if (drag) {
    const dx = e.offsetX - drag.x;
    const dy = e.offsetY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > (e.pointerType === 'mouse' ? 4 : 10)) drag.moved = true;
    if (drag.moved) {
      cam.follow = null;
      cam.cx = drag.cx - dx / cam.k;
      cam.cy = drag.cy - dy / cam.k;
      clampCam();
      canvas.classList.add('dragging');
      hideTooltip();
      return;
    }
  }
  if (e.pointerType !== 'mouse') return; // no hover on touch screens
  const t = pick(e.offsetX, e.offsetY);
  S.hover = t;
  canvas.style.cursor = t && t.kind !== 'room' ? 'pointer' : t ? 'help' : 'grab';
  if (t) showTooltip(t, e.offsetX, e.offsetY); else hideTooltip();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; } // a pinch never ends in a tap
  const d = drag;
  drag = null;
  canvas.classList.remove('dragging');
  if (d && !d.moved && e.type === 'pointerup') {
    const t = pick(e.offsetX, e.offsetY);
    select(t ? { ...t } : null);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { S.hover = null; hideTooltip(); } });
canvas.addEventListener('dblclick', (e) => {
  const t = pick(e.offsetX, e.offsetY);
  if (t && t.kind === 'actor') { cam.follow = t.id; if (cam.zoom < 1.6) setZoom(1.8); toast('🎯 따라가는 중 — 드래그하면 멈춰요'); }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(cam.zoom * Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
}, { passive: false });

document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.cam;
  if (k === 'in') setZoom(cam.zoom * 1.25);
  if (k === 'out') setZoom(cam.zoom / 1.25);
  if (k === 'reset') resetCamera();
  if (k === 'follow') {
    const id = S.selected && S.selected.kind === 'actor' ? S.selected.id : 'c:' + S.view.primary;
    if (actors.has(id)) { cam.follow = id; if (cam.zoom < 1.6) setZoom(1.8); }
  }
}));

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape') { select(null); cam.follow = null; $('#settings').hidden = true; }
  else if (e.key === '+' || e.key === '=') setZoom(cam.zoom * 1.25);
  else if (e.key === '-') setZoom(cam.zoom / 1.25);
  else if (e.key === '0') resetCamera();
  else if (e.key === 'f' || e.key === 'F') { const id = S.selected && S.selected.id; if (id && actors.has(id)) { cam.follow = id; if (cam.zoom < 1.6) setZoom(1.8); } }
  else if (e.key === 'a' || e.key === 'A') document.querySelector('[data-tab="agents"]').click();
  else if (e.key === 'l' || e.key === 'L') document.querySelector('#labelsBtn').click();
  else if (e.key === '[' || e.key === ']') {
    const i = S.floors.findIndex((f) => f.fkey === S.view.floor);
    const next = S.floors[i + (e.key === ']' ? -1 : 1)];
    if (next) selectFloor(next.fkey);
  }
});

// ---- loop ------------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  updateActors(dt, now);
  if (cam.follow) {
    const a = actors.get(cam.follow);
    if (!a) cam.follow = null;
    else {
      const [u, v] = P(a.x, a.y, 30);
      cam.cx += (u - cam.cx) * Math.min(1, dt * 4);
      cam.cy += (v - cam.cy) * Math.min(1, dt * 4);
      clampCam();
    }
  }
  drawFrame(now);
  requestAnimationFrame(frame);
}

// ---- boot ------------------------------------------------------------------------------
initUI({ selectFloor, selectSession });
initSettings(() => connect(S.view.floor, S.view.mode === 'pin' ? S.view.primary : null));
ensureUser();
renderConn();
renderChat();
renderLog();
resize();
fetch('/api/config').then((r) => r.json()).then((c) => {
  S.config = c;
  $('#ctlBadge').hidden = !c.control;
  $('#viewBadge').hidden = !c.remote;
}).catch(() => {});
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('#backdrop').addEventListener('click', () => document.body.classList.remove('drawer-open'));
const h = readHash();
connect(h.floor, h.session);
requestAnimationFrame(frame);
window.__office = { S, actors, cam, handle, select, pick }; // for poking around in devtools
