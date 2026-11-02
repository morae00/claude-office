// Draws the office: a pre-rendered floor/back-wall layer, then furniture, glass walls and people
// sorted back-to-front, then screen-space overlays (bubbles, name tags, room labels).
import { S, actors, fx, elevator, prefs, nowS, clamp, shade, mulberry } from './state.js';
import {
  R, CORRIDOR, ROOM_INFO, SPOTS, DESK_SEATS, USER_SEAT, WALLS, DOORS, WALL_H, GLASS_H, SHELVES, DEV_DESKS, RACKS, WEB_DESKS,
  GLOBE, BOARD, TABLE, LIB_TABLE, USER_DESK, ELEVATOR, MAILBOX_BOX, HOTSPOTS, roomAt,
} from './world.js';
import {
  P, depth, unproject, BOUNDS, cam, setCtx, getCtx, worldTransform, screenTransform, toScreen, fromScreen, screenOf,
  poly, quad, floorRect, line3, box, face, shadow, floorEllipse, boxHull, inPoly, PITCH,
} from './iso.js';
import { drawPerson, SPRITE_W, SPRITE_H } from './sprites.js';
import { agentState, statusOf } from './status.js';

const FONT = '"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Segoe UI",system-ui,sans-serif';
let g = null;
let canvas = null;

export function initScene(c) {
  canvas = c;
  g = c.getContext('2d');
  setCtx(g);
}

// ---- static layer -----------------------------------------------------------------
let bg = null;
let bgScale = 0;
let bgKey = '';
export function invalidateStatic() { bgKey = ''; }

function ensureStatic() {
  const want = clamp(cam.k * cam.dpr, 0.8, 2.6);
  const key = `${S.view.num || ''}|${S.view.floor || ''}`;
  if (bg && key === bgKey && Math.abs(want - bgScale) / bgScale < 0.3) return;
  bgScale = want;
  bgKey = key;
  bg = document.createElement('canvas');
  bg.width = Math.ceil(BOUNDS.w * want);
  bg.height = Math.ceil(BOUNDS.h * want);
  const ctx = bg.getContext('2d');
  ctx.setTransform(want, 0, 0, want, -BOUNDS.minX * want, -BOUNDS.minY * want);
  setCtx(ctx);
  try { paintStatic(ctx); } finally { setCtx(g); }
}

function txt(ctx, t, x, y, { size = 11, color = '#1f2a3d', align = 'left', weight = 500, base = 'alphabetic' } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(t, x, y);
}

function paintStatic(ctx) {
  // the model's base slab
  box(2, 2, -18, 1196, 716, 18, '#e2eaf4', { top: '#eef3f9', south: '#d9e3ef', east: '#cbd7e6', edge: false });
  // floors
  for (const r of Object.values(R)) paintFloor(ctx, r);
  paintFloor(ctx, CORRIDOR);
  // corridor runner
  floorRect(40, 336, 1160, 364, '#dbe9fb');
  floorRect(40, 336, 1160, 338, '#b9d3f5');
  floorRect(40, 362, 1160, 364, '#b9d3f5');
  face('top', 60, 340, 0.2, (c) => {
    txt(c, S.view.num ? `${S.view.num}F` : '', 0, 18, { size: 18, weight: 800, color: 'rgba(79,140,230,.55)' });
    const f = S.floors.find((x) => x.fkey === S.view.floor);
    if (f) txt(c, f.name, 44, 17, { size: 12, weight: 700, color: 'rgba(79,140,230,.45)' });
  });
  // rugs and mats
  rug(ctx, 92, 196, 270, 248, '#f7d9c4', '#efc7ab');
  rug(ctx, 405, 528, 645, 640, '#dce8ff', '#c9dafc');
  rug(ctx, 726, 446, 958, 668, '#fde7d6', '#f6d6bf');
  rug(ctx, 1010, 600, 1110, 680, '#e9e1ff', '#d9cdfb');
  // lobby floor logo
  face('top', 1080 - 40, 170, 0.3, (c) => {
    c.fillStyle = 'rgba(217,119,87,.10)';
    c.beginPath(); c.arc(40, 40, 38, 0, Math.PI * 2); c.fill();
    txt(c, '✳', 40, 54, { size: 40, align: 'center', color: 'rgba(217,119,87,.45)', weight: 700 });
  });
  for (const d of DOORS) floorRect(d.x - 26, d.y - 6, d.x + 26, d.y + 6, 'rgba(160,190,230,.35)');
  // back walls (north + west), with windows
  paintBackWalls(ctx);
}

function paintFloor(ctx, r) {
  const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  floorRect(x0, y0, x1, y1, r.floor);
  ctx.save();
  poly([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)]);
  ctx.clip();
  const pat = r.pattern || 'tile';
  const lc = r.floor2;
  if (pat === 'wood') {
    for (let y = y0; y < y1; y += 14) {
      line3([x0, y, 0], [x1, y, 0], lc, 0.8);
      const off = ((y - y0) / 14) % 3;
      for (let x = x0 + 30 + off * 40; x < x1; x += 120) line3([x, y, 0], [x, y + 14, 0], lc, 0.6);
    }
  } else if (pat === 'raised') {
    for (let x = x0; x < x1; x += 30) line3([x, y0, 0], [x, y1, 0], lc, 0.9);
    for (let y = y0; y < y1; y += 30) line3([x0, y, 0], [x1, y, 0], lc, 0.9);
    ctx.fillStyle = shade(lc, -0.05);
    for (let x = x0 + 15; x < x1; x += 30) for (let y = y0 + 15; y < y1; y += 30) { const [u, v] = P(x, y); ctx.fillRect(u - 0.8, v - 0.5, 1.6, 1); }
  } else if (pat === 'marble') {
    for (let x = x0; x < x1; x += 52) line3([x, y0, 0], [x, y1, 0], lc, 0.8);
    for (let y = y0; y < y1; y += 52) line3([x0, y, 0], [x1, y, 0], lc, 0.8);
    const rnd = mulberry(11);
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 9; i++) { const sx = x0 + rnd() * r.w; const sy = y0 + rnd() * r.h; line3([sx, sy, 0], [sx + 30 + rnd() * 40, sy + 12 + rnd() * 20, 0], '#d9e0ea', 0.8); }
    ctx.globalAlpha = 1;
  } else if (pat === 'carpet') {
    const rnd = mulberry(5);
    ctx.fillStyle = shade(r.floor, -0.05);
    for (let i = 0; i < 380; i++) { const [u, v] = P(x0 + rnd() * r.w, y0 + rnd() * r.h); ctx.fillRect(u, v, 1.2, 0.8); }
  } else {
    for (let x = x0; x < x1; x += 36) line3([x, y0, 0], [x, y1, 0], lc, 0.8);
    for (let y = y0; y < y1; y += 36) line3([x0, y, 0], [x1, y, 0], lc, 0.8);
  }
  // ceiling light pool
  const [cu, cv] = P(x0 + r.w / 2, y0 + r.h / 2);
  const rad = Math.max(r.w, r.h) * 0.7;
  const gr = ctx.createRadialGradient(cu, cv, 10, cu, cv, rad);
  gr.addColorStop(0, 'rgba(255,255,255,.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(cu - rad, cv - rad, rad * 2, rad * 2);
  // ambient occlusion along the outer back walls
  for (let i = 0; i < 6; i++) {
    const a = 0.05 * (1 - i / 6);
    if (y0 <= 16) floorRect(x0, y0 + i * 4, x1, y0 + i * 4 + 4, `rgba(60,90,140,${a})`);
    if (x0 <= 16) floorRect(x0 + i * 4, y0, x0 + i * 4 + 4, y1, `rgba(60,90,140,${a})`);
  }
  ctx.restore();
}

function rug(ctx, x0, y0, x1, y1, fill, border) {
  floorRect(x0, y0, x1, y1, border);
  floorRect(x0 + 4, y0 + 4, x1 - 4, y1 - 4, fill);
}

function paintBackWalls(ctx) {
  const H = WALL_H;
  // north wall: we see its south face
  face('south', 16, 16, H, (c) => {
    const gr = c.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#f4f8fd'); gr.addColorStop(1, '#ffffff');
    c.fillStyle = gr; c.fillRect(0, 0, 1168, H);
    c.fillStyle = '#e3eaf4'; c.fillRect(0, H - 7, 1168, 7);
    window(c, 14, 8, 300, 22, 6);             // library clerestory (above shelves)
    window(c, 352, 14, 330, 84, 6);           // dev: big windows
    c.fillStyle = '#e6edf6';                  // server: vents
    for (let i = 0; i < 4; i++) { c.fillRect(706 + i * 64, 10, 40, 12); c.fillStyle = '#d5dfeb'; for (let k = 0; k < 4; k++) c.fillRect(708 + i * 64, 12 + k * 3, 36, 1); c.fillStyle = '#e6edf6'; }
    // lobby sign
    c.fillStyle = 'rgba(255,255,255,.9)'; roundRect(c, 1006, 10, 120, 22, 6); c.fill();
    txt(c, '✳ CLAUDE OFFICE', 1066, 25, { size: 10, weight: 800, align: 'center', color: '#d97757' });
  });
  // west wall: we see its east face (u runs from y=704 back to y=16)
  face('east', 16, 704, H, (c) => {
    const gr = c.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#eef3fa'); gr.addColorStop(1, '#f9fbfe');
    c.fillStyle = gr; c.fillRect(0, 0, 688, H);
    c.fillStyle = '#dfe7f2'; c.fillRect(0, H - 7, 688, 7);
    // web room: world map display
    c.fillStyle = '#16233b'; roundRect(c, 24, 26, 250, 72, 5); c.fill();
    const rnd = mulberry(3);
    c.fillStyle = 'rgba(120,200,255,.55)';
    for (let i = 0; i < 260; i++) {
      const x = 34 + rnd() * 230; const y = 34 + rnd() * 56;
      const land = Math.sin(x * 0.05) * Math.cos(y * 0.13) + Math.sin(x * 0.021 + 1) > 0.35;
      if (land) c.fillRect(x, y, 2, 2);
    }
    c.fillStyle = '#5ef0b5'; [[80, 50], [150, 62], [210, 46]].forEach(([x, y]) => { c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill(); });
    // corridor end: floor sign
    c.fillStyle = 'rgba(255,255,255,.95)'; roundRect(c, 318, 34, 72, 44, 8); c.fill();
    txt(c, S.view.num ? `${S.view.num}F` : '', 354, 66, { size: 22, weight: 800, align: 'center', color: '#4f8ce6' });
    // library windows
    window(c, 432, 22, 236, 86, 4);
  });
  // wall tops (thickness)
  quad([8, 8, H], [1192, 8, H], [1192, 16, H], [16, 16, H], '#ffffff');
  quad([8, 8, H], [16, 16, H], [16, 712, H], [8, 712, H], '#ffffff');
  line3([16, 16, H], [1184, 16, H], '#d3deec', 1);
  line3([16, 16, H], [16, 704, H], '#d3deec', 1);
  line3([16, 16, 0], [16, 16, H], 'rgba(120,150,190,.35)', 1);
}

function window(c, x, y, w, h, panes) {
  c.fillStyle = '#d8e6f5'; c.fillRect(x - 2, y - 2, w + 4, h + 4);
  const gr = c.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, '#bfe0ff'); gr.addColorStop(1, '#eef7ff');
  c.fillStyle = gr; c.fillRect(x, y, w, h);
  // a faint skyline
  if (h > 40) {
    const rnd = mulberry(x | 0);
    c.fillStyle = 'rgba(140,180,225,.35)';
    for (let bx = x; bx < x + w; bx += 10 + rnd() * 14) { const bh = 8 + rnd() * h * 0.45; c.fillRect(bx, y + h - bh, 8 + rnd() * 8, bh); }
  }
  c.fillStyle = 'rgba(255,255,255,.35)';
  c.beginPath(); c.moveTo(x + w * 0.1, y + h); c.lineTo(x + w * 0.25, y); c.lineTo(x + w * 0.32, y); c.lineTo(x + w * 0.17, y + h); c.fill();
  c.fillStyle = '#c9d7e8';
  for (let i = 1; i < panes; i++) c.fillRect(x + (w * i) / panes - 1, y, 2, h);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ---- furniture ------------------------------------------------------------------
const rngD = mulberry(7);
const BOOK = ['#e0795f', '#5b8def', '#f2b84b', '#4fbf8f', '#a78bfa', '#38bdf8', '#f472b6', '#94a3b8', '#fde68a'];
const SHELF_BOOKS = SHELVES.map(() => Array.from({ length: 4 }, () => {
  const out = []; let x = 0;
  while (x < 56) { const w = 3 + Math.floor(rngD() * 4); out.push({ x, w: Math.min(w, 58 - x), h: 13 + Math.floor(rngD() * 7), c: BOOK[Math.floor(rngD() * BOOK.length)] }); x += w + (rngD() < 0.15 ? 3 : 1); }
  return out;
}));
const CODE = Array.from({ length: 40 }, () => ({ ind: Math.floor(rngD() * 4) * 3, w: 6 + Math.floor(rngD() * 22), c: ['#7dd3fc', '#fcd34d', '#c4b5fd', '#86efac', '#fda4af', '#e2e8f0'][Math.floor(rngD() * 6)] }));
const LEDS = RACKS.map(() => Array.from({ length: 36 }, () => rngD()));

function inRoomActors(room) { return [...actors.values()].filter((a) => a.room === room && !a.path.length); }

function props(now) {
  const list = [];
  const add = (x, y, fn) => list.push({ d: depth(x, y), fn });

  // library
  SHELVES.forEach((s, i) => add(s.x + s.w / 2, s.y + s.d, () => {
    shadow(s.x, s.y + s.d - 4, s.w, 10, 8);
    box(s.x, s.y, 0, s.w, s.d, s.h, '#b98a5f', { top: '#d3a87c', east: '#9a6f48' });
    face('south', s.x, s.y + s.d, s.h, (c) => {
      c.fillStyle = '#7a5236'; c.fillRect(3, 3, 60, 98);
      SHELF_BOOKS[i].forEach((row, ri) => {
        const by = 4 + ri * 24.5;
        for (const b of row) { c.fillStyle = b.c; c.fillRect(4 + b.x, by + 21 - b.h, b.w, b.h); c.fillStyle = 'rgba(255,255,255,.2)'; c.fillRect(4 + b.x, by + 21 - b.h, 1, b.h); }
        c.fillStyle = '#d3a87c'; c.fillRect(3, by + 21, 60, 3);
      });
    });
  }));
  add(LIB_TABLE.x + 60, LIB_TABLE.y + LIB_TABLE.d, () => table(LIB_TABLE, '#f3e6d3', (c) => {
    c.fillStyle = '#fffdf6'; c.fillRect(20, 10, 22, 14); c.fillRect(70, 18, 22, 14);
    c.fillStyle = '#e0795f'; c.fillRect(30.5, 10, 1, 14); c.fillStyle = '#5b8def'; c.fillRect(80.5, 18, 1, 14);
  }));
  [150, 212].forEach((x) => add(x, 128, () => chairBack(x, 124, '#9fd8c5')));
  add(40, 230, () => armchair(30, 200, '#8fd3bd'));
  add(36, 284, () => plant(36, 284, 1.1));
  add(326, 284, () => plant(326, 284, 1));

  // dev
  DEV_DESKS.forEach((dk, i) => {
    const typing = inRoomActors('dev').some((a) => a.spot === SPOTS.dev[i] && a.pose === 'type');
    add(dk.c, dk.y + 32, () => devDesk(dk.c, dk.y, typing, i, now));
    const seat = SPOTS.dev[i];
    add(seat.x, seat.y - 1, () => chair(seat.x, seat.y));
  });
  add(362, 284, () => plant(362, 284, 1));
  add(690, 284, () => plant(690, 284, 1.2));

  // server
  const fast = [...actors.values()].some((a) => a.room === 'server' && a.running);
  RACKS.forEach((r, i) => add(r.x + r.w / 2, r.y + r.d, () => rack(r, i, fast, now)));
  add(840, 230, () => {
    shadow(810, 222, 60, 22, 6);
    box(810, 222, 0, 60, 22, 26, '#ffffff', { top: '#f4f7fb', south: '#eef2f7', east: '#dfe6ef' });
    box(826, 226, 26, 28, 3, 16, '#2f3747');
    face('south', 827, 229, 41, (c) => { c.fillStyle = fast ? '#0b2a1c' : '#1d2635'; c.fillRect(0, 0, 26, 13); c.fillStyle = '#4ade80'; for (let l = 0; l < 3; l++) c.fillRect(2, 2 + l * 3.5, 6 + ((l * 7 + Math.floor(now / (fast ? 200 : 2000))) % 14), 1.5); });
  });

  // lobby
  add(1080, 17, () => elevatorDoor(now));
  add(MAILBOX_BOX.x + 9, MAILBOX_BOX.y + MAILBOX_BOX.d, () => mailbox());
  add(1003, 250, () => sofa(990, 160));
  add(1170, 40, () => plant(1170, 40, 1.1));
  add(1170, 284, () => plant(1170, 284, 1));

  // corridor
  add(30, 388, () => plant(30, 388, 0.9));
  add(1170, 388, () => plant(1170, 388, 0.9));
  add(700, 388, () => plant(700, 388, 0.8));

  // web
  WEB_DESKS.forEach((dk, i) => {
    const active = inRoomActors('web').some((a) => a.spot === SPOTS.web[i]);
    add(dk.c, dk.y + 32, () => webDesk(dk.c, dk.y, active, i, now));
    const seat = SPOTS.web[i];
    add(seat.x, seat.y - 1, () => chair(seat.x, seat.y));
  });
  const browsing = inRoomActors('web').length > 0;
  add(GLOBE.x, GLOBE.y + 14, () => globe(now, browsing));
  add(320, 690, () => plant(320, 690, 1));

  // meeting
  add(BOARD.x + BOARD.w / 2, BOARD.y + BOARD.d, () => whiteboard());
  add(TABLE.x + TABLE.w / 2, TABLE.y + TABLE.d, () => table(TABLE, '#f4e6d1', (c) => {
    c.fillStyle = '#e8eef6'; c.fillRect(50, 14, 26, 18); c.fillStyle = '#cbd5e1'; c.fillRect(52, 16, 22, 14);
    c.fillStyle = '#ffffff'; c.fillRect(110, 20, 16, 12); c.fillRect(150, 12, 8, 8); c.fillRect(30, 30, 8, 8);
  }));
  SPOTS.meeting.slice(2).forEach((s) => add(s.x, s.y - 14, () => chairBack(s.x, s.y - 16, '#a5b4fc')));
  add(366, 690, () => plant(366, 690, 1));
  add(690, 690, () => plant(690, 690, 1.1));

  // Claude desks
  DESK_SEATS.forEach((seat, i) => {
    const owner = [...S.sessions.values()].find((s) => s.slot === i);
    const color = owner ? owner.meta.color : '#c9d4e3';
    add(seat.x, seat.y - 12, () => chairBack(seat.x, seat.y - 14, color, 34));
    add(seat.x, seat.y + 42, () => claudeDesk(seat, owner, color));
  });
  add(960, 690, () => plant(960, 690, 1));

  // my desk
  add(USER_DESK.x + USER_DESK.w / 2, USER_DESK.y + USER_DESK.d, () => userDesk(now));
  add(USER_SEAT.x, USER_SEAT.y - 1, () => chair(USER_SEAT.x, USER_SEAT.y));
  add(1050, 640, () => beanbag(1050, 640));
  add(1168, 690, () => plant(1168, 690, 1.1));

  return list;
}

function table(t, top, decorate) {
  shadow(t.x, t.y, t.w, t.d, 10);
  const leg = '#e2e8f0';
  [[t.x + 4, t.y + 4], [t.x + t.w - 8, t.y + 4], [t.x + 4, t.y + t.d - 8], [t.x + t.w - 8, t.y + t.d - 8]].forEach(([x, y]) => box(x, y, 0, 4, 4, t.h - 4, leg, { edge: false }));
  box(t.x, t.y, t.h - 4, t.w, t.d, 4, top, { top: shade(top, 0.25), south: shade(top, -0.06), east: shade(top, -0.14) });
  if (decorate) face('top', t.x, t.y, t.h + 0.2, decorate);
}

function devDesk(c, y, typing, i, now) {
  shadow(c - 40, y, 80, 32, 8);
  box(c - 38, y + 3, 0, 4, 26, 26, '#e7edf5', { edge: false });
  box(c + 34, y + 3, 0, 4, 26, 26, '#e7edf5', { edge: false });
  box(c - 40, y, 26, 80, 32, 3, '#f3e5cf', { top: '#f8eddd', south: '#e3cfb2', east: '#d6c2a3' });
  box(c - 3, y + 6, 29, 6, 4, 7, '#d7dde6', { edge: false });
  box(c - 24, y + 3, 36, 48, 3, 31, '#f1f4f8', { top: '#ffffff', east: '#d8dee8' });
  face('south', c - 22, y + 6, 65, (k) => {
    k.fillStyle = typing ? '#0f172a' : '#1e293b'; k.fillRect(0, 0, 44, 25);
    if (typing) {
      const off = Math.floor(now / 140) % CODE.length;
      for (let l = 0; l < 7; l++) { const cd = CODE[(off + l + i * 7) % CODE.length]; k.fillStyle = cd.c; k.fillRect(3 + cd.ind, 2 + l * 3.2, Math.min(cd.w, 36 - cd.ind), 1.8); }
    } else {
      k.fillStyle = 'rgba(217,119,87,.9)'; k.font = `700 9px ${FONT}`; k.textAlign = 'center'; k.fillText('✳', 22, 16);
    }
    k.fillStyle = 'rgba(255,255,255,.12)'; k.fillRect(0, 0, 44, 6);
  });
  face('top', c - 14, y + 17, 29.2, (k) => { k.fillStyle = '#ffffff'; k.fillRect(0, 0, 28, 6); k.fillStyle = '#e2e8f0'; for (let r = 0; r < 2; r++) k.fillRect(1, 1 + r * 2.5, 26, 1); k.fillStyle = '#f8fafc'; k.fillRect(34, 1, 6, 4); });
}

function webDesk(c, y, active, i, now) {
  shadow(c - 50, y, 100, 32, 8);
  box(c - 48, y + 3, 0, 4, 26, 26, '#e7edf5', { edge: false });
  box(c + 44, y + 3, 0, 4, 26, 26, '#e7edf5', { edge: false });
  box(c - 50, y, 26, 100, 32, 3, '#ffffff', { top: '#ffffff', south: '#e8eef6', east: '#d9e2ee' });
  box(c - 3, y + 6, 29, 6, 4, 7, '#cfd6df', { edge: false });
  box(c - 27, y + 3, 36, 54, 3, 33, '#334155', { top: '#475569', east: '#1e293b' });
  face('south', c - 25, y + 6, 67, (k) => {
    k.fillStyle = '#f8fafc'; k.fillRect(0, 0, 50, 28);
    k.fillStyle = '#e2e8f0'; k.fillRect(0, 0, 50, 5);
    k.fillStyle = '#f87171'; k.fillRect(2, 1.5, 2, 2); k.fillStyle = '#fbbf24'; k.fillRect(5, 1.5, 2, 2); k.fillStyle = '#34d399'; k.fillRect(8, 1.5, 2, 2);
    k.fillStyle = '#ffffff'; k.fillRect(12, 1, 36, 3);
    if (active) {
      const p = (now / 900) % 1;
      k.fillStyle = '#3b82f6'; k.fillRect(0, 5, 50 * p, 1.2);
      for (let l = 0; l < 4; l++) { k.fillStyle = l === 0 ? '#3b82f6' : '#94a3b8'; k.fillRect(4, 9 + l * 4.5, 20 + ((l * 13 + i * 7) % 20), 2); }
    } else {
      k.fillStyle = '#93c5fd'; k.beginPath(); k.arc(25, 16, 6, 0, Math.PI * 2); k.fill();
    }
  });
}

function chair(x, y) {
  floorEllipse(x + 2, y + 2, 11, 9, 'rgba(40,70,120,.12)');
  box(x - 1.5, y - 1.5, 0, 3, 3, 12, '#94a3b8', { edge: false });
  box(x - 11, y - 9, 12, 22, 16, 4, '#64748b', { top: '#7c8ba1', south: '#56657a', east: '#4b5869' });
}

function chairBack(x, y, color, h = 30) {
  box(x - 11, y, 0, 22, 6, h, color, { top: shade(color, 0.2), south: shade(color, -0.04), east: shade(color, -0.2) });
}

function armchair(x, y, color) {
  shadow(x, y, 32, 40, 6);
  box(x, y, 0, 32, 40, 12, color);
  box(x, y, 12, 8, 40, 16, shade(color, -0.05));
  box(x, y, 12, 32, 6, 10, shade(color, -0.03));
  box(x, y + 34, 12, 32, 6, 10, shade(color, -0.03));
}

function sofa(x, y) {
  shadow(x, y, 26, 90, 6);
  box(x, y, 0, 26, 90, 12, '#bfe0f7', { top: '#d8ecfb' });
  box(x, y, 12, 8, 90, 16, '#a9d2ef');
  box(x + 10, y + 12, 12, 12, 26, 4, '#ffffff', { edge: false });
  box(x + 10, y + 52, 12, 12, 26, 4, '#fde68a', { edge: false });
}

function beanbag(x, y) {
  floorEllipse(x + 4, y + 4, 22, 18, 'rgba(40,70,120,.14)');
  const [u, v] = P(x, y, 10);
  const gr = g.createRadialGradient(u - 6, v - 8, 2, u, v, 22);
  gr.addColorStop(0, '#ffd2c2'); gr.addColorStop(1, '#ff9f8a');
  g.fillStyle = gr;
  g.beginPath(); g.ellipse(u, v, 22, 15, 0, 0, Math.PI * 2); g.fill();
}

export function plant(x, y, s = 1) {
  floorEllipse(x + 3, y + 3, 11 * s, 9 * s, 'rgba(40,70,120,.15)');
  box(x - 7 * s, y - 7 * s, 0, 14 * s, 14 * s, 16 * s, '#f8fafc', { top: '#ffffff', south: '#eef2f7', east: '#dbe3ee' });
  const [u, v] = P(x, y, 16 * s);
  const leaf = (dx, dy, r, c) => {
    const gr = g.createRadialGradient(u + dx - r * 0.3, v + dy - r * 0.4, 1, u + dx, v + dy, r);
    gr.addColorStop(0, shade(c, 0.25)); gr.addColorStop(1, c);
    g.fillStyle = gr; g.beginPath(); g.arc(u + dx, v + dy, r, 0, Math.PI * 2); g.fill();
  };
  leaf(0, -10 * s, 11 * s, '#3fae6a');
  leaf(-7 * s, -18 * s, 8 * s, '#52c27d');
  leaf(7 * s, -17 * s, 8 * s, '#47b874');
  leaf(0, -24 * s, 7 * s, '#5fd08b');
}

function rack(r, i, fast, now) {
  shadow(r.x, r.y + r.d - 6, r.w, 12, 8);
  box(r.x, r.y, 0, r.w, r.d, r.h, '#334155', { top: '#475569', east: '#1e293b' });
  face('south', r.x, r.y + r.d, r.h, (c) => {
    c.fillStyle = '#1e293b'; c.fillRect(2, 2, r.w - 4, r.h - 4);
    for (let u = 0; u < 10; u++) {
      const uy = 5 + u * 10.6;
      c.fillStyle = '#273449'; c.fillRect(4, uy, r.w - 8, 9);
      c.fillStyle = '#3b4a63'; c.fillRect(4, uy, r.w - 8, 0.8);
      c.fillStyle = '#0f172a'; c.fillRect(6, uy + 3, 16, 3);
      for (let l = 0; l < 3; l++) {
        const seed = LEDS[i][(u * 3 + l) % 36];
        const period = fast ? 90 + seed * 120 : 700 + seed * 1400;
        const on = Math.floor((now + seed * 5000) / period) % 2 === 0;
        c.fillStyle = l === 2 ? (on ? '#fbbf24' : '#5b4a20') : (on ? '#4ade80' : '#1f4d33');
        c.fillRect(30 + l * 5, uy + 3.5, 3, 2);
        if (on && fast) { c.fillStyle = l === 2 ? 'rgba(251,191,36,.3)' : 'rgba(74,222,128,.3)'; c.fillRect(29 + l * 5, uy + 2.5, 5, 4); }
      }
    }
  });
}

function elevatorDoor(now) {
  const open = elevator.open;
  face('south', ELEVATOR.x - 8, 16.5, ELEVATOR.h + 18, (c) => {
    c.fillStyle = '#cfd8e3'; c.fillRect(0, 0, ELEVATOR.w + 16, ELEVATOR.h + 18);
    c.fillStyle = '#0f172a'; roundRect(c, (ELEVATOR.w + 16) / 2 - 20, 3, 40, 11, 3); c.fill();
    const arrow = open > 0.05 ? (Math.floor(now / 300) % 2 ? '▲' : ' ') : '';
    txt(c, `${arrow}${S.view.num ? S.view.num + 'F' : '--'}`, (ELEVATOR.w + 16) / 2, 12, { size: 8.5, weight: 800, align: 'center', color: '#fbbf24' });
    const dx = 8, dy = 18, dw = ELEVATOR.w, dh = ELEVATOR.h;
    c.fillStyle = '#1f2937'; c.fillRect(dx, dy, dw, dh);
    c.fillStyle = `rgba(255,240,200,${0.25 + open * 0.6})`; c.fillRect(dx + 2, dy + 2, dw - 4, dh - 2);
    const pw = (dw / 2) * (1 - open);
    const grL = c.createLinearGradient(dx, 0, dx + dw / 2, 0);
    grL.addColorStop(0, '#b8c4d3'); grL.addColorStop(1, '#e2e8f0');
    c.fillStyle = grL; c.fillRect(dx, dy, pw, dh);
    const grR = c.createLinearGradient(dx + dw / 2, 0, dx + dw, 0);
    grR.addColorStop(0, '#e2e8f0'); grR.addColorStop(1, '#aebbcc');
    c.fillStyle = grR; c.fillRect(dx + dw - pw, dy, pw, dh);
    c.fillStyle = '#94a3b8'; c.fillRect(dx + pw - 0.5, dy, 1, dh); c.fillRect(dx + dw - pw - 0.5, dy, 1, dh);
    c.fillStyle = '#e2e8f0'; c.fillRect(dx + dw + 2, dy + 34, 4, 9);
    c.fillStyle = open > 0.05 ? '#fbbf24' : '#94a3b8'; c.fillRect(dx + dw + 3, dy + 36, 2, 2);
  });
}

function mailbox() {
  const m = MAILBOX_BOX;
  shadow(m.x, m.y, m.w, m.d, 6);
  box(m.x + 7, m.y + 5, 0, 4, 4, 16, '#94a3b8', { edge: false });
  box(m.x, m.y, 16, m.w, m.d, 18, '#ff7a72', { top: '#ff9d96', east: '#e35d55' });
  face('south', m.x, m.y + m.d, 34, (c) => { c.fillStyle = '#7f1d1d'; c.fillRect(4, 4, 10, 2); c.fillStyle = '#ffffff'; c.font = `700 6px ${FONT}`; c.fillText('POST', 3, 14); });
}

function globe(now, fast) {
  const G = GLOBE;
  floorEllipse(G.x + 6, G.y + 6, 30, 24, 'rgba(40,70,120,.16)');
  box(G.x - 16, G.y - 12, 0, 32, 24, 6, '#e2e8f0');
  box(G.x - 2, G.y - 2, 6, 4, 4, 34, '#94a3b8', { edge: false });
  const [u, v] = P(G.x, G.y, G.z);
  const r = G.r;
  g.save();
  g.beginPath(); g.arc(u, v, r, 0, Math.PI * 2); g.closePath();
  g.fillStyle = '#7cc4f5'; g.fill();
  g.clip();
  const off = (now * (fast ? 0.06 : 0.012)) % 160;
  g.fillStyle = '#6fd39a';
  const blobs = [[0, -14, 20, 11], [30, 4, 16, 16], [62, -8, 24, 13], [96, 13, 15, 9], [124, -18, 18, 9], [-30, 16, 13, 8]];
  for (const [bx, by, bw, bh] of blobs) for (const k of [-160, 0, 160]) {
    g.beginPath(); g.ellipse(u - 80 + ((bx + off + k + 160) % 320) - 80, v + by, bw / 2, bh / 2, 0, 0, Math.PI * 2); g.fill();
  }
  const sh = g.createRadialGradient(u - 12, v - 14, 3, u, v, r + 4);
  sh.addColorStop(0, 'rgba(255,255,255,.55)'); sh.addColorStop(0.4, 'rgba(255,255,255,.05)'); sh.addColorStop(1, 'rgba(20,50,110,.35)');
  g.fillStyle = sh; g.fillRect(u - r - 4, v - r - 4, r * 2 + 8, r * 2 + 8);
  g.restore();
  g.strokeStyle = '#cbd5e1'; g.lineWidth = 3;
  g.beginPath(); g.arc(u, v, r + 4, Math.PI * 0.6, Math.PI * 2.4); g.stroke();
  g.lineWidth = 1;
}

export function currentBoard() {
  let best = null;
  for (const s of S.sessions.values()) {
    if (s.board && s.board.items && s.board.items.length && (!best || (s.board.ts || 0) > (best.board.ts || 0))) best = s;
  }
  return best;
}

function whiteboard() {
  const b = BOARD;
  shadow(b.x, b.y, b.w, b.d + 6, 8);
  box(b.x + 10, b.y + 1, 0, 3, 3, b.z, '#94a3b8', { edge: false });
  box(b.x + b.w - 13, b.y + 1, 0, 3, 3, b.z, '#94a3b8', { edge: false });
  box(b.x, b.y, b.z, b.w, b.d, b.h, '#dbe3ee', { top: '#eef2f7', east: '#c3cedc' });
  face('south', b.x + 3, b.y + b.d, b.z + b.h - 3, (c) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, b.w - 6, b.h - 8);
    c.fillStyle = '#e8eef6'; c.fillRect(0, b.h - 8, b.w - 6, 3);
    c.fillStyle = '#2563eb'; c.fillRect(20, b.h - 9, 10, 2); c.fillStyle = '#ef4444'; c.fillRect(34, b.h - 9, 10, 2);
    const s = currentBoard();
    c.save();
    c.beginPath(); c.rect(2, 2, b.w - 10, b.h - 12); c.clip();
    if (!s) {
      txt(c, '오늘의 계획', (b.w - 6) / 2, 36, { size: 13, weight: 800, align: 'center', color: '#c8d3e2' });
      txt(c, '할 일 · 계획 · 워크플로가 여기 적혀요', (b.w - 6) / 2, 52, { size: 9, align: 'center', color: '#c8d3e2' });
    } else {
      const bd = s.board;
      txt(c, bd.title || '계획', 8, 14, { size: 11, weight: 800, color: '#1d4ed8' });
      if (S.sessions.size > 1) txt(c, `by ${s.meta.acct}`, b.w - 14, 13, { size: 8, weight: 700, align: 'right', color: s.meta.color });
      bd.items.slice(0, 6).forEach((it, i) => {
        const st = it.status;
        const mark = st === 'completed' ? '☑' : st === 'in_progress' ? '▶' : st === 'head' ? '' : '☐';
        const col = st === 'completed' ? '#94a3b8' : st === 'in_progress' ? '#dc2626' : st === 'head' ? '#1d4ed8' : '#2563eb';
        txt(c, `${mark} ${it.text}`.slice(0, 40), 8, 27 + i * 10, { size: 8.5, color: col, weight: st === 'in_progress' || st === 'head' ? 700 : 500 });
      });
      if (bd.items.length > 6) txt(c, `… 외 ${bd.items.length - 6}개`, b.w - 14, b.h - 14, { size: 8, align: 'right', color: '#94a3b8' });
    }
    c.restore();
  });
}

function claudeDesk(seat, owner, color) {
  const x = seat.x - 42, y = seat.y + 10;
  shadow(x, y, 84, 32, 9);
  box(x + 2, y + 3, 0, 4, 26, 26, '#e7edf5', { edge: false });
  box(x + 78, y + 3, 0, 4, 26, 26, '#e7edf5', { edge: false });
  box(x, y, 26, 84, 32, 3, '#f3e5cf', { top: '#f8eddd', south: '#e3cfb2', east: '#d6c2a3' });
  // laptop lid (we see its back), phone, mug
  box(seat.x + 8, y + 4, 29, 26, 2, 17, '#e2e8f0', { top: '#f1f5f9', east: '#cbd5e1' });
  face('south', seat.x + 8, y + 6, 46, (c) => { c.fillStyle = color; c.beginPath(); c.arc(13, 8, 2.6, 0, Math.PI * 2); c.fill(); });
  const claude = owner && actors.get('c:' + owner.sid);
  const onPhone = claude && claude.pose === 'phone' && !claude.path.length;
  box(seat.x - 36, y + 12, 29, 14, 9, 4, '#475569', { top: '#64748b' });
  if (!onPhone) box(seat.x - 37, y + 12, 33, 16, 4, 2.5, '#1e293b', { top: '#334155' });
  else line3([seat.x - 29, y + 16, 33], [seat.x - 6, seat.y - 2, 40], '#334155', 1);
  box(seat.x - 16, y + 14, 29, 6, 6, 8, '#ffffff', { top: '#6b4226' });
  face('south', x, y + 32, 29, (c) => {
    const label = owner ? `Claude·${owner.meta.acct || ''}`.replace(/·$/, '') : '빈자리';
    c.font = `700 7px ${FONT}`;
    const tw = Math.min(70, c.measureText(label).width + 10);
    c.fillStyle = owner ? color : '#cbd5e1';
    roundRect(c, 42 - tw / 2, 6, tw, 10, 3); c.fill();
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.fillText(label.length > 14 ? label.slice(0, 13) + '…' : label, 42, 13.5);
  });
}

function userDesk(now) {
  const d = USER_DESK;
  shadow(d.x, d.y, d.w, d.d, 9);
  box(d.x + 2, d.y + 3, 0, 4, 26, 27, '#e7edf5', { edge: false });
  box(d.x + d.w - 6, d.y + 3, 0, 4, 26, 27, '#e7edf5', { edge: false });
  box(d.x, d.y, 27, d.w, d.d, 3, '#ffffff', { top: '#ffffff', south: '#e8eef6', east: '#d9e2ee' });
  box(d.x + 56, d.y + 6, 30, 6, 4, 6, '#334155', { edge: false });
  box(d.x + 30, d.y + 3, 36, 58, 3, 34, '#1e293b', { top: '#334155', east: '#0f172a' });
  const busy = [...S.sessions.values()].some((s) => s.busy);
  face('south', d.x + 32, d.y + 6, 68, (c) => {
    c.fillStyle = '#0b1220'; c.fillRect(0, 0, 54, 30);
    for (let l = 0; l < 5; l++) { const w = 10 + ((l * 17 + Math.floor(now / (busy ? 300 : 3000))) % 30); c.fillStyle = l === 4 ? '#f59e0b' : '#4ade80'; c.fillRect(3, 3 + l * 5, w, 1.8); }
    if (Math.floor(now / 500) % 2) { c.fillStyle = '#e2e8f0'; c.fillRect(40, 25, 4, 2.5); }
  });
  face('top', d.x + 44, d.y + 18, 30.2, (c) => { c.fillStyle = '#f8fafc'; c.fillRect(0, 0, 30, 7); c.fillStyle = '#e2e8f0'; c.fillRect(1, 2, 28, 1); c.fillRect(1, 4.5, 28, 1); c.fillStyle = '#ffffff'; c.fillRect(48, 2, 7, 7); });
}

// ---- glass walls ----------------------------------------------------------------------
function wallDrawable(wseg) {
  const mid = (wseg.a + wseg.b) / 2;
  const d = wseg.axis === 'x' ? depth(mid, wseg.y) : depth(wseg.x, mid);
  return { d, fn: () => drawWall(wseg) };
}
function drawWall(w) {
  const pt = (t, z) => (w.axis === 'x' ? [t, w.y, z] : [w.x, t, z]);
  if (w.kind === 'front') {
    if (w.axis === 'x') box(w.a, w.y, 0, w.b - w.a, 8, w.h, '#edf2f8', { top: '#ffffff', south: '#e6edf6', east: '#d9e2ee', edge: false });
    else box(w.x, w.a, 0, 8, w.b - w.a, w.h, '#edf2f8', { top: '#ffffff', south: '#e6edf6', east: '#d9e2ee', edge: false });
    return;
  }
  quad(pt(w.a, 6), pt(w.b, 6), pt(w.b, 0), pt(w.a, 0), 'rgba(255,255,255,.75)');
  quad(pt(w.a, w.h), pt(w.b, w.h), pt(w.b, 6), pt(w.a, 6), 'rgba(170,212,255,.16)');
  line3(pt(w.a, w.h), pt(w.b, w.h), '#c3d2e6', 1.8);
  line3(pt(w.a, w.h - 5), pt(w.b, w.h - 5), 'rgba(255,255,255,.6)', 0.7);
  line3(pt(w.a, 6), pt(w.b, 6), 'rgba(150,180,220,.45)', 0.7);
  line3(pt(w.a, 0), pt(w.a, w.h), 'rgba(150,180,220,.5)', 0.8);
}

// ---- frame ----------------------------------------------------------------------------
export function drawFrame(now) {
  const ctx = getCtx();
  screenTransform(ctx);
  ctx.clearRect(0, 0, cam.w, cam.h);
  ensureStatic();
  worldTransform(ctx);
  ctx.drawImage(bg, BOUNDS.minX, BOUNDS.minY, BOUNDS.w, BOUNDS.h);

  // hovered / selected room highlight
  const hiRoom = (S.hover && S.hover.kind === 'room' && S.hover.room) || (S.selected && S.selected.kind === 'room' && S.selected.room);
  if (hiRoom) {
    const r = hiRoom === 'corridor' ? CORRIDOR : R[hiRoom];
    if (r) floorRect(r.x + 2, r.y + 2, r.x + r.w - 2, r.y + r.h - 2, 'rgba(79,140,250,.10)', 0.5, 'rgba(79,140,250,.45)');
  }

  const list = props(now);
  for (const w of WALLS) list.push(wallDrawable(w));
  const staleMs = prefs.staleMin * 60000;
  for (const a of actors.values()) list.push({ d: depth(a.x, a.y) + 0.5, actor: a });
  list.sort((p, q) => p.d - q.d);
  for (const it of list) {
    if (!it.actor) { it.fn(); continue; }
    const a = it.actor;
    const st = a.kind === 'agent' ? agentState(a) : null;
    const stale = st && statusOf(st, 'agent', staleMs) === 'stale';
    const sel = S.selected && S.selected.kind === 'actor' && S.selected.id === a.id;
    const hov = (S.hover && S.hover.kind === 'actor' && S.hover.id === a.id) || S.highlight === a.id;
    if (sel || hov) {
      floorEllipse(a.x, a.y, 20, 16, sel ? 'rgba(59,130,246,.22)' : 'rgba(59,130,246,.12)');
      const [u, v] = P(a.x, a.y);
      ctx.strokeStyle = sel ? 'rgba(59,130,246,.9)' : 'rgba(59,130,246,.5)';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(u, v, 20, 20 * PITCH, 0, 0, Math.PI * 2); ctx.stroke();
    }
    drawPerson(ctx, a, now, { dim: stale });
  }

  // flying envelopes (world space)
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    const p = (now - f.t0) / f.dur;
    if (p >= 1) { fx.splice(i, 1); continue; }
    const x = f.a[0] + (f.b[0] - f.a[0]) * p;
    const y = f.a[1] + (f.b[1] - f.a[1]) * p;
    const z = f.a[2] + Math.sin(p * Math.PI) * 50;
    const [u, v] = P(x, y, z);
    ctx.font = `16px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('✉️', u, v);
  }

  // screen-space overlays
  screenTransform(ctx);
  const p = S.sessions.get(S.view.primary);
  const anyBusy = [...S.sessions.values()].some((s) => s.busy);
  if (p && !anyBusy && nowS() - (p.lastTs || 0) > 30 * 60 * 1000) {
    ctx.fillStyle = 'rgba(30,50,90,.18)';
    ctx.fillRect(0, 0, cam.w, cam.h);
    pill(ctx, cam.w / 2, 26, '🌙 조용한 사무실 — 최근 30분간 기록이 없어요', { bg: 'rgba(255,255,255,.88)', color: '#334155', size: 12 });
  }
  roomLabels(ctx);
  for (const a of actors.values()) overlayActor(ctx, a, now, staleMs);
  for (const it of layoutBubbles(ctx, now)) drawBubble(ctx, it, now);
  if (!S.sessions.size) pill(ctx, cam.w / 2, cam.h / 2, S.connected ? '이 층에는 아직 아무도 출근하지 않았어요' : '서버에 연결하는 중…', { bg: 'rgba(255,255,255,.92)', color: '#334155', size: 13 });
}

function pill(ctx, cx, cy, t, { bg = 'rgba(255,255,255,.9)', color = '#1e293b', size = 11, weight = 700, stroke = 'rgba(148,170,200,.45)' } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const w = ctx.measureText(t).width + size * 1.4;
  const h = size + 10;
  ctx.fillStyle = bg;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t, cx, cy + 0.5);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const labelRects = [];
function roomLabels(ctx) {
  labelRects.length = 0;
  for (const [k, r] of Object.entries(R)) {
    const info = ROOM_INFO[k];
    // Signs hang above each room's back edge: the outer wall for the top row, the corridor glass for the bottom row.
    const [sx, sy] = r.top ? screenOf(r.x + r.w / 2, 16, WALL_H + 14) : screenOf(r.x + r.w / 2, 400, GLASS_H + 26);
    const n = [...actors.values()].filter((a) => a.room === k && a.kind !== 'user' && !a.path.length).length;
    const t = `${info.icon} ${info.name}${n ? `  ·  ${n}` : ''}`;
    ctx.font = `700 11px ${FONT}`;
    const w = ctx.measureText(t).width + 18;
    const x = sx - w / 2;
    const y = sy - 11;
    const hot = (S.hover && S.hover.kind === 'room' && S.hover.room === k) || (S.selected && S.selected.kind === 'room' && S.selected.room === k);
    ctx.fillStyle = hot ? 'rgba(59,130,246,.95)' : 'rgba(255,255,255,.88)';
    roundRect(ctx, x, y, w, 22, 11); ctx.fill();
    ctx.strokeStyle = hot ? 'rgba(59,130,246,1)' : 'rgba(148,170,200,.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = hot ? '#ffffff' : '#1e293b'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x + 9, y + 11.5);
    labelRects.push({ room: k, x, y, w, h: 22 });
    if (prefs.labels && (cam.w > 700 || cam.k > 0.9)) {
      const tools = info.tools.slice(0, 4).join(' · ');
      ctx.font = `500 10px ${FONT}`;
      const tw = Math.max(ctx.measureText(tools).width, ctx.measureText(info.visual).width) + 16;
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      roundRect(ctx, x, y + 25, tw, 34, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(148,170,200,.4)'; ctx.stroke();
      ctx.fillStyle = '#2563eb'; ctx.fillText(tools, x + 8, y + 36);
      ctx.fillStyle = '#64748b'; ctx.fillText(info.visual, x + 8, y + 50);
    }
  }
}

function overlayActor(ctx, a, now, staleMs) {
  if (a.alpha < 0.4) return;
  const zoomOK = cam.k > 0.55;
  const [fx0, fy0] = screenOf(a.x, a.y, 0);
  const headY = fy0 - (SPRITE_H - (a.sit ? 6 : 0)) * cam.k;
  const seated = a.kind === 'claude' && !a.path.length && DESK_SEATS.includes(a.spot);
  if (!seated && zoomOK) {
    const isClaude = a.kind === 'claude';
    ctx.font = `700 ${isClaude ? 10 : 9.5}px ${FONT}`;
    const t = a.name || '';
    const w = ctx.measureText(t).width + 12;
    ctx.fillStyle = isClaude ? a.look.hood : a.kind === 'user' ? 'rgba(100,116,139,.95)' : 'rgba(255,255,255,.92)';
    roundRect(ctx, fx0 - w / 2, fy0 + 3, w, 15, 7.5); ctx.fill();
    if (!isClaude && a.kind !== 'user') { ctx.strokeStyle = a.look.shirt; ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.fillStyle = isClaude || a.kind === 'user' ? '#ffffff' : '#1e293b';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, fx0, fy0 + 11);
  }
  const st = a.kind === 'agent' ? agentState(a) : null;
  const stale = st && statusOf(st, 'agent', staleMs) === 'stale';
  const busyBubble = a.bubble && performance.now() < a.bubble.until;
  if (stale && !busyBubble) {
    const zt = (now / 1200) % 1;
    ctx.font = `700 ${12 + zt * 4}px ${FONT}`;
    ctx.fillStyle = `rgba(100,116,139,${1 - zt})`;
    ctx.textAlign = 'center';
    ctx.fillText('💤', fx0 + 14 + zt * 8, headY - 6 - zt * 12);
  }
  if (a.pose === 'sleep' && !a.path.length) {
    const zt = (now / 1200) % 1;
    ctx.font = `800 ${11 + zt * 4}px ${FONT}`;
    ctx.fillStyle = `rgba(99,102,241,${1 - zt})`;
    ctx.textAlign = 'center';
    ctx.fillText('z', fx0 + 14 + zt * 6, headY - 4 - zt * 10);
    ctx.fillText('Z', fx0 + 22 + zt * 6, headY - 14 - zt * 10);
  }
  if (a.label && !a.path.length && !busyBubble && zoomOK && !(a.kind === 'claude' && ['think', 'talk', 'idle', 'sleep'].includes(a.pose))) {
    ctx.font = `600 10px ${FONT}`;
    const t = a.label.length > 28 ? a.label.slice(0, 27) + '…' : a.label;
    const w = ctx.measureText(t).width + 14;
    const y = headY - 22;
    ctx.fillStyle = 'rgba(15,23,42,.78)';
    roundRect(ctx, fx0 - w / 2, y, w, 17, 8.5); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, fx0, y + 9);
  }
}

// ---- bubbles ---------------------------------------------------------------------------
const BUBBLE = {
  say: { bg: 'rgba(255,255,255,.96)', bd: 'rgba(148,163,184,.6)', fg: '#0f172a' },
  think: { bg: 'rgba(245,243,255,.96)', bd: 'rgba(167,139,250,.7)', fg: '#4c1d95' },
  error: { bg: 'rgba(254,242,242,.97)', bd: 'rgba(239,68,68,.9)', fg: '#991b1b' },
  ask: { bg: 'rgba(255,251,235,.97)', bd: 'rgba(245,158,11,.9)', fg: '#78350f' },
  call: { bg: 'rgba(236,253,245,.97)', bd: 'rgba(16,185,129,.8)', fg: '#065f46' },
  msg: { bg: 'rgba(239,246,255,.97)', bd: 'rgba(59,130,246,.85)', fg: '#1e3a8a' },
  report: { bg: 'rgba(240,253,244,.97)', bd: 'rgba(34,197,94,.85)', fg: '#14532d' },
  user: { bg: 'rgba(255,255,255,.97)', bd: 'rgba(100,116,139,.7)', fg: '#0f172a' },
};

function wrap(ctx, str, maxW, maxLines) {
  const out = [];
  let truncated = false;
  const paras = String(str).split('\n');
  outer: for (let pi = 0; pi < paras.length; pi++) {
    let line = '';
    for (const ch of paras[pi]) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) {
        let next = ch;
        const sp = line.lastIndexOf(' ');
        if (sp > 0 && sp > line.length - 10) { next = line.slice(sp + 1) + ch; line = line.slice(0, sp); }
        out.push(line);
        line = next;
        if (out.length >= maxLines) { truncated = true; break outer; }
      } else line = test;
    }
    out.push(line);
    if (out.length >= maxLines && pi < paras.length - 1) { truncated = true; break; }
  }
  if (truncated) {
    let l = out[maxLines - 1] || '';
    while (l && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
    out[maxLines - 1] = l + '…';
  }
  return out.slice(0, maxLines);
}

function layoutBubbles(ctx, now) {
  const items = [];
  const pnow = performance.now();
  for (const a of actors.values()) {
    const b = a.bubble;
    if (!b || pnow > b.until || a.alpha < 0.3) continue;
    let t = b.text;
    if (b.kind === 'think' && !t) t = '·'.repeat(1 + (Math.floor(now / 350) % 3));
    ctx.font = `500 11.5px ${FONT}`;
    const lines = wrap(ctx, t, 190, b.kind === 'msg' || b.kind === 'report' ? 4 : 3);
    const w = Math.max(30, Math.min(208, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20));
    const h = lines.length * 15 + 12;
    const [fx0, fy0] = screenOf(a.x, a.y, 0);
    const headY = fy0 - (SPRITE_H - (a.sit ? 6 : 0)) * cam.k;
    items.push({ a, b, lines, w, h, x: clamp(fx0 - w / 2, 8, cam.w - 8 - w), y: headY - h - 14, ax: fx0, ay: headY - 2 });
  }
  items.sort((p, q) => q.ay - p.ay);
  const placed = [];
  for (const it of items) {
    for (let k = 0; k < 8; k++) {
      const hit = placed.find((p) => it.x < p.x + p.w && it.x + it.w > p.x && it.y < p.y + p.h && it.y + it.h > p.y);
      if (!hit) break;
      it.y = hit.y - it.h - 5;
    }
    it.y = Math.max(4, it.y);
    placed.push(it);
  }
  return items;
}

function drawBubble(ctx, it, now) {
  const st = BUBBLE[it.b.kind] || BUBBLE.say;
  const fade = clamp((it.b.until - performance.now()) / 400, 0, 1);
  ctx.save();
  ctx.globalAlpha = fade;
  const { x, y, w, h } = it;
  ctx.shadowColor = 'rgba(30,60,120,.18)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = st.bg;
  roundRect(ctx, x, y, w, h, it.b.kind === 'think' ? 14 : 10); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = st.bd; ctx.lineWidth = it.b.kind === 'error' ? 1.8 : 1.2; ctx.stroke();
  const tx = clamp(it.ax, x + 12, x + w - 12);
  if (it.b.kind === 'think') {
    for (const [dx, dy, r] of [[0, 7, 4], [4, 14, 2.5]]) { ctx.beginPath(); ctx.arc(tx + dx, y + h + dy, r, 0, Math.PI * 2); ctx.fillStyle = st.bg; ctx.fill(); ctx.stroke(); }
  } else {
    ctx.fillStyle = st.bg;
    ctx.beginPath(); ctx.moveTo(tx - 6, y + h - 0.5); ctx.lineTo(tx, Math.min(it.ay, y + h + 10)); ctx.lineTo(tx + 6, y + h - 0.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(tx - 6, y + h); ctx.lineTo(tx, Math.min(it.ay, y + h + 10)); ctx.lineTo(tx + 6, y + h); ctx.stroke();
  }
  ctx.fillStyle = st.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `${it.b.kind === 'error' ? 700 : 500} 11.5px ${FONT}`;
  it.lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 18 + i * 15));
  ctx.restore();
}

// ---- hit testing (screen px) ----------------------------------------------------------
export function pick(px, py) {
  let best = null;
  for (const a of actors.values()) {
    if (a.alpha < 0.3) continue;
    const [sx, sy] = screenOf(a.x, a.y, 0);
    const hw = (SPRITE_W / 2 + 3) * cam.k;
    const top = sy - (SPRITE_H + 4) * cam.k;
    if (px >= sx - hw && px <= sx + hw && py >= top && py <= sy + 16) {
      const d = depth(a.x, a.y);
      if (!best || d > best.d) best = { kind: 'actor', id: a.id, d };
    }
  }
  if (best) return best;
  for (const l of labelRects) if (px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h) return { kind: 'room', room: l.room };
  for (const h of HOTSPOTS) {
    const [x, y, z, w, d, hh] = h.box;
    if (inPoly(boxHull(x, y, z, w, d, hh), px, py)) {
      const dd = depth(x + w / 2, y + d);
      if (!best || dd > best.d) best = { kind: 'prop', id: h.id, room: h.room, slot: h.slot, d: dd };
    }
  }
  if (best) return best;
  const [u, v] = fromScreen(px, py);
  const p = unproject(u, v);
  const room = roomAt(p.x, p.y);
  return room ? { kind: 'room', room } : null;
}
