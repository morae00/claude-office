// Characters: where they go, what pose they hold, and the little scenes (reporting, commuting, deliveries).
import { S, actors, spotOwner, fx, elevator, nowS, clamp, hashStr, isHidden } from './state.js';
import { R, SPOTS, DESK_SEATS, DESK_VISIT, USER_SEAT, MAILBOX, ELEV_IN, ROOM_POSE, CORR_Y } from './world.js';
import { CY, SY } from './iso.js';
import { claudeLook, agentLook, USER_LOOK } from './sprites.js';

const SPEED = 300; // plan units / s

export class Actor {
  constructor(id, kind, look, name) {
    this.id = id; this.kind = kind; this.look = look; this.name = name;
    this.x = 0; this.y = 0; this.room = 'desk'; this.spot = null;
    this.path = []; this.pose = 'stand'; this.face = 'down'; this.sit = false;
    this.queue = []; this.holdUntil = 0; this.pauseUntil = 0; this.alpha = 1; this.fade = 0;
    this.bubble = null; this.label = ''; this.running = false; this.sweatUntil = 0;
    this.mode = 'work'; this.onArrive = null; this.lastIntent = null; this.latestMove = null; this.walkPhase = 0;
    this.lastBubbleId = 0; this.sid = null; this.agentKey = null; this.flip = false; this.moveDir = 'front';
    this.blinkAt = performance.now() + 2000 + Math.random() * 3000;
  }
  say(b, ttl) {
    if (!b) return;
    const defaults = { think: 4500, say: 6000, error: 5500, ask: 60000, call: 4000, msg: 5500, report: 4500, user: 6000 };
    this.bubble = { kind: b.kind, text: b.text || '', until: performance.now() + (ttl || defaults[b.kind] || 5000) };
  }
  // Decorative bubbles (message hand-offs) never cover a question, an error or a report.
  saySoft(b, ttl) {
    const cur = this.bubble;
    if (cur && performance.now() < cur.until && ['ask', 'error', 'report'].includes(cur.kind)) return;
    this.say(b, ttl);
  }
  enqueue(it) {
    if (!it.special && !it.stay) this.latestMove = it;
    this.queue.push(it);
    if (this.queue.length > 3) {
      const specials = this.queue.filter((q) => q.special);
      const moves = this.queue.filter((q) => !q.special);
      this.queue = [...specials, ...moves.slice(-2)];
    }
  }
  place(spot, room) {
    releaseSpot(this);
    this.room = room; this.spot = spot;
    reserve(spot, this);
    this.x = spot.x; this.y = spot.y;
    this.face = spot.face; this.sit = !!spot.sit;
    this.path = [];
  }
}

function reserve(spot, a) { if (spot && !spot.virtual) spotOwner.set(spot, a.id); }
export function releaseSpot(a) { if (a.spot && spotOwner.get(a.spot) === a.id) spotOwner.delete(a.spot); }
const freeFor = (spot, a) => !spotOwner.has(spot) || spotOwner.get(spot) === a.id;

function pickSpot(a, room, list) {
  if (a.room === room && a.spot && list.includes(a.spot)) return a.spot;
  const free = list.find((s) => freeFor(s, a));
  if (free) return free;
  const base = list[(hashStr(a.id) + list.length) % list.length];
  const n = (hashStr(a.id) % 3) + 1;
  return { ...base, x: base.x + (n % 2 ? 22 : -22) * Math.ceil(n / 2), y: base.y + 10, virtual: true };
}

export function seatFor(s) { return DESK_SEATS[clamp((s && s.slot) || 0, 0, DESK_SEATS.length - 1)]; }

function resolveTarget(a, it) {
  if (it.spot && typeof it.spot === 'object') return { room: it.room, spot: it.spot };
  if (it.spot === 'visit') {
    const s = S.sessions.get(a.sid);
    const list = [...DESK_VISIT[clamp((s && s.slot) || 0, 0, 3)], ...SPOTS.lobby.slice(1)];
    const spot = pickSpot(a, 'desk', list);
    return { room: SPOTS.lobby.includes(spot) ? 'lobby' : 'desk', spot };
  }
  if (it.spot === 'ask') return { room: 'user', spot: pickSpot(a, 'user', SPOTS.user) };
  return { room: it.room, spot: pickSpot(a, it.room, SPOTS[it.room] || SPOTS.lobby) };
}

function route(a, room, spot) {
  const pts = [];
  const from = R[a.room] || R.lobby;
  const exitVia = a.spot && a.spot.via ? [...a.spot.via].reverse() : [{ x: a.x, y: from.walkY }];
  if (a.room !== room) {
    pts.push(...exitVia, { x: from.door, y: from.walkY }, { x: from.door, y: CORR_Y });
    const to = R[room];
    pts.push({ x: to.door, y: CORR_Y }, { x: to.door, y: to.walkY });
    pts.push(...(spot.via ? spot.via : [{ x: spot.x, y: to.walkY }]));
  } else if (!(a.spot && Math.abs(a.x - spot.x) < 2 && Math.abs(a.y - spot.y) < 2)) {
    pts.push(...exitVia);
    pts.push(...(spot.via ? spot.via : [{ x: spot.x, y: R[room].walkY }]));
  }
  pts.push({ x: spot.x, y: spot.y });
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1] || { x: a.x, y: a.y };
    if (Math.abs(last.x - p.x) > 0.5 || Math.abs(last.y - p.y) > 0.5) out.push(p);
  }
  return out;
}

function walkTo(a, room, spot, pose, then) {
  releaseSpot(a);
  reserve(spot, a);
  a.path = route(a, room, spot);
  a.dest = { room, spot, pose };
  a.onArrive = then || null;
  a.sit = false;
  if (!a.path.length) arrive(a);
}

function arrive(a) {
  const d = a.dest;
  if (!d) return;
  a.dest = null;
  a.room = d.room; a.spot = d.spot;
  a.face = d.spot.face; a.sit = !!d.spot.sit; a.flip = false;
  a.pose = d.pose || d.spot.pose || ROOM_POSE[d.room] || 'stand';
  a.holdUntil = performance.now() + 650;
  const f = a.onArrive;
  a.onArrive = null;
  if (f) f();
}

function applyIntent(a, it) {
  const now = performance.now();
  if (it.special) return applySpecial(a, it);
  a.lastIntent = it;
  if (it.stay) {
    a.pose = it.pose;
    a.face = 'down';
    a.holdUntil = now + 700;
    return;
  }
  const { room, spot } = resolveTarget(a, it);
  const pose = it.pose || spot.pose || ROOM_POSE[room];
  if (room === a.room && spot === a.spot && !a.path.length) {
    a.pose = pose; a.face = spot.face; a.sit = !!spot.sit;
    a.holdUntil = now + 450;
    return;
  }
  walkTo(a, room, spot, pose);
}

function besideSpot(target) {
  const s = target.dest ? target.dest.spot : target.spot;
  const room = target.dest ? target.dest.room : target.room;
  if (room === 'desk' && DESK_SEATS.includes(s)) {
    const list = DESK_VISIT[DESK_SEATS.indexOf(s)];
    return { room: 'desk', spot: list.find((v) => !spotOwner.has(v)) || list[0] };
  }
  const r = R[room] || R.lobby;
  const sx = s ? s.x : target.x;
  const sy = s ? s.y : target.y;
  const dx = sx + 34 < r.x + r.w - 16 ? 34 : -34;
  return { room, spot: { x: sx + dx, y: sy + 8, face: 'down', via: s && s.via ? s.via : null, virtual: true, pose: 'stand' } };
}

function applySpecial(a, it) {
  const now = performance.now();
  switch (it.special) {
    case 'report': {
      const owner = actors.get('c:' + a.sid);
      const t = owner ? besideSpot(owner) : { room: 'lobby', spot: SPOTS.lobby[1] };
      walkTo(a, t.room, t.spot, 'report', () => {
        a.say(a.reportBubble || { kind: 'report', text: '📋 다 했습니다!' }, 4200);
        a.holdUntil = performance.now() + 4200;
        a.enqueue({ special: 'bye' });
      });
      return;
    }
    case 'bye':
      a.pose = 'wave'; a.face = 'down';
      a.say({ kind: 'say', text: '👋 퇴근합니다!' }, 1900);
      a.holdUntil = now + 1900;
      a.enqueue({ special: 'leave' });
      return;
    case 'leave':
      a.mode = 'leaving';
      walkTo(a, 'lobby', SPOTS.lobby[0], 'stand', () => {
        elevator.openUntil = performance.now() + 1600;
        releaseSpot(a);
        a.path = [{ x: ELEV_IN.x, y: ELEV_IN.y }];
        a.dest = { room: 'lobby', spot: { ...ELEV_IN, face: 'up', virtual: true }, pose: 'stand' };
        a.onArrive = () => { a.fade = -1; };
      });
      return;
    case 'deliver': {
      const to = it.to;
      if (!actors.has(to.id)) return;
      const t = besideSpot(to);
      walkTo(a, t.room, t.spot, 'talk', () => {
        a.say({ kind: 'msg', text: `📨 ${it.text}` }, 4500);
        flyEnvelope(a, to);
        to.pauseUntil = performance.now() + 1800;
        setTimeout(() => { if (actors.has(to.id)) to.saySoft({ kind: 'msg', text: `📩 ${it.fromLabel}님 메시지 받았어요!` }, 3500); }, 700);
        a.holdUntil = performance.now() + 3200;
        if (!a.queue.length && a.latestMove) a.enqueue(a.latestMove);
      });
      return;
    }
    case 'mail':
      walkTo(a, 'lobby', MAILBOX, 'stand', () => {
        a.say({ kind: 'msg', text: `📮 ${it.toLabel}에게 보냈어요` }, 3000);
        a.holdUntil = performance.now() + 2200;
        if (!a.queue.length && a.latestMove) a.enqueue(a.latestMove);
      });
      return;
    case 'home': // "퇴근시키기" from the UI
      a.queue = [];
      a.mode = 'leaving';
      a.say({ kind: 'say', text: '👋 먼저 들어가 볼게요!' }, 1800);
      a.holdUntil = now + 900;
      a.enqueue({ special: 'leave' });
      return;
  }
}

function spawnFromElevator(a) {
  a.room = 'lobby'; a.spot = null;
  a.x = ELEV_IN.x; a.y = ELEV_IN.y;
  a.alpha = 0; a.fade = 1; a.face = 'down';
  elevator.openUntil = performance.now() + 1800;
  a.path = [{ x: SPOTS.lobby[0].x, y: SPOTS.lobby[0].y }];
  a.dest = { room: 'lobby', spot: { ...SPOTS.lobby[0], virtual: true }, pose: 'stand' };
  a.holdUntil = 0;
}

function flyEnvelope(from, to) {
  fx.push({ kind: 'mail', a: [from.x, from.y, 60], b: [to.x, to.y, 60], t0: performance.now(), dur: 900 });
}

// ---- session state -> actors ----------------------------------------------------
function claudeIntent(s, st) {
  const seat = seatFor(s);
  switch (st.act) {
    case 'idle': return { room: 'desk', spot: seat, pose: 'idle' };
    case 'desk': return { room: 'desk', spot: seat, pose: 'work' };
    case 'call': return { room: 'desk', spot: seat, pose: 'phone' };
    case 'ask': return { room: 'user', spot: 'ask', pose: 'ask' };
    case 'think': return { stay: true, pose: 'think' };
    case 'say': return { stay: true, pose: 'talk' };
    case 'tool':
      if (st.room === 'desk') return { room: 'desk', spot: seat, pose: 'work' };
      if (st.room === 'user') return { room: 'user', spot: 'ask', pose: 'talk' };
      return { room: st.room || 'desk', spot: 'auto' };
    default: return { room: 'desk', spot: seat, pose: 'work' };
  }
}

function agentIntent(st) {
  switch (st.act) {
    case 'think': return { stay: true, pose: 'think' };
    case 'say': return { stay: true, pose: 'talk' };
    case 'tool':
      if (st.room === 'desk' || st.room === 'user') return { room: 'desk', spot: 'visit', pose: 'stand' };
      return { room: st.room, spot: 'auto' };
    default: return { room: 'desk', spot: 'visit', pose: 'stand' };
  }
}

const fresh = (b, ms = 6000) => b && b.at && nowS() - b.at < ms;

export function syncClaude(s, live) {
  const st = s.claude || { act: 'idle', room: 'desk' };
  const id = 'c:' + s.sid;
  let a = actors.get(id);
  const created = !a;
  if (!a) {
    a = new Actor(id, 'claude', claudeLook(s.meta.color || '#d97757'), '');
    a.sid = s.sid;
    actors.set(id, a);
  }
  a.look = claudeLook(s.meta.color || '#d97757');
  a.name = `Claude·${s.meta.acct || ''}`.replace(/·$/, '');
  if (st.bubble && st.bubble.id !== a.lastBubbleId) {
    a.lastBubbleId = st.bubble.id;
    if (live || fresh(st.bubble.at)) a.say(st.bubble);
  }
  if (st.sweat && (live ? nowS() - st.sweat < 8000 : nowS() - st.sweat < 3000)) a.sweatUntil = performance.now() + 2600;
  if (st.act !== 'ask' && a.bubble && a.bubble.kind === 'ask') a.bubble = null;
  a.label = st.label || '';
  a.running = !!st.running;
  const it = claudeIntent(s, st);
  if (created || !live) {
    if (created && s.joinedLive) {
      spawnFromElevator(a);
      a.say({ kind: 'say', text: '🛗 출근했습니다!' }, 2500);
      a.enqueue(it.stay ? { room: 'desk', spot: seatFor(s), pose: 'work' } : it);
      return;
    }
    const t = it.stay ? { room: 'desk', spot: seatFor(s) } : resolveTarget(a, it);
    a.place(t.spot, t.room);
    a.pose = it.pose || t.spot.pose || ROOM_POSE[t.room];
    a.lastIntent = it.stay ? { room: 'desk', spot: seatFor(s), pose: 'work' } : it;
    a.latestMove = a.lastIntent;
    return;
  }
  a.enqueue(it);
}

export function syncAgent(s, st, live) {
  const id = `a:${s.sid}:${st.key}`;
  let a = actors.get(id);
  if (isHidden(id)) { if (a) { releaseSpot(a); actors.delete(id); } return; }
  if (st.status === 'gone') { if (a && a.mode === 'work') { a.queue = []; a.enqueue({ special: 'leave' }); } return; }
  if (!a) {
    if (st.status !== 'working' && !live) return;
    a = new Actor(id, 'agent', agentLook(st.type), st.type || 'agent');
    a.sid = s.sid; a.agentKey = st.key;
    actors.set(id, a);
    if (live) {
      spawnFromElevator(a);
      a.say({ kind: 'say', text: `🛗 출근! ${st.desc || ''}` }, 3000);
    } else {
      const it = agentIntent(st);
      const t = it.stay ? resolveTarget(a, { room: 'desk', spot: 'visit' }) : resolveTarget(a, it);
      a.place(t.spot, t.room);
      a.pose = it.pose || t.spot.pose || ROOM_POSE[t.room];
      a.lastIntent = it.stay ? { room: 'desk', spot: 'visit' } : it;
      a.latestMove = a.lastIntent;
    }
  }
  a.label = st.label || '';
  a.running = !!st.running;
  if (st.sweat && live) a.sweatUntil = performance.now() + 2600;
  if (st.status === 'working') {
    if (a.mode !== 'work') { a.mode = 'work'; a.queue = []; a.onArrive = null; a.fade = 0; a.alpha = 1; }
    if (st.bubble && st.bubble.id !== a.lastBubbleId) {
      a.lastBubbleId = st.bubble.id;
      if (live || fresh(st.bubble.at)) a.say(st.bubble);
    }
    if (live) a.enqueue(agentIntent(st));
  } else if (st.status === 'reporting') {
    if (st.bubble) { a.lastBubbleId = st.bubble.id; a.reportBubble = st.bubble; }
    if (a.mode === 'work') { a.mode = 'reporting'; a.queue = []; a.enqueue({ special: 'report' }); }
  }
}

export function sendHome(id) {
  const a = actors.get(id);
  if (a && a.mode !== 'leaving') { a.queue = []; a.path = a.path.slice(0, 1); a.enqueue({ special: 'home' }); }
}

export function removeSessionActors(sid, walkOut) {
  for (const a of [...actors.values()]) {
    if (a.sid !== sid) continue;
    if (walkOut) { a.queue = []; a.mode = 'leaving'; a.enqueue({ special: 'bye' }); }
    else { releaseSpot(a); actors.delete(a.id); }
  }
}

export function ensureUser() {
  if (actors.has('user')) return actors.get('user');
  const u = new Actor('user', 'user', USER_LOOK, '나');
  u.place(USER_SEAT, 'user');
  u.pose = 'type';
  actors.set('user', u);
  return u;
}

export function clearActors() {
  for (const a of [...actors.values()]) if (a.kind !== 'user') { releaseSpot(a); actors.delete(a.id); }
  fx.length = 0;
}

export function assignSlots() {
  const ids = S.order.length ? S.order : [...S.sessions.keys()];
  ids.forEach((sid, i) => {
    const s = S.sessions.get(sid);
    if (!s || s.slot === i) return;
    s.slot = i;
    const a = actors.get('c:' + sid);
    if (a && a.room === 'desk' && DESK_SEATS.includes(a.spot)) a.enqueue({ room: 'desk', spot: DESK_SEATS[clamp(i, 0, 3)], pose: a.pose === 'walk' ? 'work' : a.pose });
  });
}

export function animateLink(link) {
  if (!link.live) return;
  const from = link.from.sid && actors.get('c:' + link.from.sid);
  const to = link.to.sid && actors.get('c:' + link.to.sid);
  const short = link.text.length > 80 ? link.text.slice(0, 79) + '…' : link.text;
  if (from && to) {
    to.pauseUntil = performance.now() + 4000; // the receiver waits for the messenger
    from.queue = from.queue.filter((q) => !q.special);
    from.queue.unshift({ special: 'deliver', to, text: short, fromLabel: link.from.label });
    from.holdUntil = 0;
  } else if (from) {
    const where = link.to.floor ? `${link.to.floor}F ` : '';
    from.queue.unshift({ special: 'mail', toLabel: `${where}${link.to.label}` });
    from.holdUntil = 0;
  } else if (to) {
    elevator.openUntil = performance.now() + 1400;
    fx.push({ kind: 'mail', a: [ELEV_IN.x, ELEV_IN.y + 30, 60], b: [to.x, to.y, 60], t0: performance.now(), dur: 1300 });
    const where = link.from.floor ? ` (${link.from.floor}F)` : '';
    setTimeout(() => to.saySoft({ kind: 'msg', text: `📩 ${link.from.label}${where}: ${short}` }, 6000), 1200);
  }
}

// ---- per-frame movement ------------------------------------------------------------
export function updateActors(dt, now) {
  const target = now < elevator.openUntil ? 1 : 0;
  elevator.open += (target - elevator.open) * Math.min(1, dt * 8);
  for (const a of [...actors.values()]) {
    if (a.fade > 0) { a.alpha = Math.min(1, a.alpha + dt * 2.5); if (a.alpha >= 1) a.fade = 0; }
    if (a.fade < 0) {
      a.alpha -= dt * 2.5;
      elevator.openUntil = Math.max(elevator.openUntil, now + 300);
      if (a.alpha <= 0) { releaseSpot(a); actors.delete(a.id); continue; }
    }
    if (a.path.length) {
      let remain = SPEED * dt;
      while (remain > 0 && a.path.length) {
        const p = a.path[0];
        const dx = p.x - a.x;
        const dy = p.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) {
          a.moveDir = dx * SY + dy * CY < -0.01 ? 'back' : 'front';
          a.flip = dx * CY - dy * SY < -0.01;
        }
        if (d <= remain) { a.x = p.x; a.y = p.y; a.path.shift(); remain -= d; }
        else { a.x += (dx / d) * remain; a.y += (dy / d) * remain; remain = 0; }
      }
      a.walkPhase += dt * 3.2;
      if (!a.path.length) arrive(a);
      continue;
    }
    if (a.kind === 'claude' && (a.pose === 'idle' || a.pose === 'sleep') && !a.queue.length) {
      const s = S.sessions.get(a.sid);
      a.pose = s && !s.busy && nowS() - (s.lastTs || 0) > 10 * 60 * 1000 ? 'sleep' : 'idle';
    }
    if (now < a.holdUntil || now < a.pauseUntil || !a.queue.length) continue;
    applyIntent(a, a.queue.shift());
  }
}
