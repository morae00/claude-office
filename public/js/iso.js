// Sims-like view: the plan is turned 35° and looked at from above at an angle.
// Faces facing +x (east) and +y (south) are the ones the camera sees.
import { shade, clamp } from './state.js';
import { WALL_H } from './world.js';

const YAW = (35 * Math.PI) / 180;
export const CY = Math.cos(YAW);
export const SY = Math.sin(YAW);
export const PITCH = 0.58;
export const ZS = 0.92;

export const P = (x, y, z = 0) => [x * CY - y * SY, (x * SY + y * CY) * PITCH - z * ZS];
export const depth = (x, y) => x * SY + y * CY;
export function unproject(u, v) {
  const vp = v / PITCH;
  return { x: u * CY + vp * SY, y: -u * SY + vp * CY };
}

// World bounds in iso units (with a margin for walls and bubbles).
export const BOUNDS = (() => {
  const pts = [P(0, 0, WALL_H + 30), P(1200, 0, WALL_H + 30), P(0, 720, 0), P(1200, 720, 0), P(1200, 0, 0), P(0, 720, WALL_H)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs) - 30;
  const maxX = Math.max(...xs) + 30;
  const minY = Math.min(...ys) - 20;
  const maxY = Math.max(...ys) + 40;
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
})();

export const cam = { zoom: 1.12, cx: (BOUNDS.minX + BOUNDS.maxX) / 2, cy: (BOUNDS.minY + BOUNDS.maxY) / 2, k: 1, w: 800, h: 600, dpr: 1, fit: 1, follow: null, tx: null, ty: null };
export function fitCamera(w, h, dpr) {
  cam.w = w; cam.h = h; cam.dpr = dpr;
  cam.fit = Math.min(w / BOUNDS.w, h / BOUNDS.h);
  cam.k = cam.fit * cam.zoom;
}
export function setZoom(z, px, py) {
  const before = px != null ? fromScreen(px, py) : null;
  cam.zoom = clamp(z, 0.7, 4);
  cam.k = cam.fit * cam.zoom;
  if (before) {
    const after = fromScreen(px, py);
    cam.cx += before[0] - after[0];
    cam.cy += before[1] - after[1];
  }
  clampCam();
}
export function clampCam() {
  const hw = cam.w / 2 / cam.k;
  const hh = cam.h / 2 / cam.k;
  const cxMin = BOUNDS.minX + Math.min(hw, BOUNDS.w / 2);
  const cxMax = BOUNDS.maxX - Math.min(hw, BOUNDS.w / 2);
  const cyMin = BOUNDS.minY + Math.min(hh, BOUNDS.h / 2);
  const cyMax = BOUNDS.maxY - Math.min(hh, BOUNDS.h / 2);
  cam.cx = clamp(cam.cx, Math.min(cxMin, cxMax), Math.max(cxMin, cxMax));
  cam.cy = clamp(cam.cy, Math.min(cyMin, cyMax), Math.max(cyMin, cyMax));
}
// Narrow, tall screens (phones) start zoomed in so the office fills the frame; you can pinch out.
export function defaultZoom() {
  return cam.w < 700 ? Math.max(1.6, Math.min(2.4, (cam.h / cam.w) * 1.5)) : 1.12;
}
export function resetCamera() {
  cam.zoom = defaultZoom(); cam.k = cam.fit * cam.zoom; cam.follow = null;
  cam.cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
  cam.cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
}
export const toScreen = (u, v) => [(u - cam.cx) * cam.k + cam.w / 2, (v - cam.cy) * cam.k + cam.h / 2];
export const fromScreen = (px, py) => [(px - cam.w / 2) / cam.k + cam.cx, (py - cam.h / 2) / cam.k + cam.cy];
export const screenOf = (x, y, z = 0) => { const [u, v] = P(x, y, z); return toScreen(u, v); };

let g = null;
export const setCtx = (c) => { g = c; };
export const getCtx = () => g;
export function worldTransform(ctx = g) {
  ctx.setTransform(cam.k * cam.dpr, 0, 0, cam.k * cam.dpr, (cam.w / 2 - cam.cx * cam.k) * cam.dpr, (cam.h / 2 - cam.cy * cam.k) * cam.dpr);
}
export function screenTransform(ctx = g) { ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0); }

// ---- primitives (iso units) ---------------------------------------------------
export function poly(pts, fill, stroke, lw = 1) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
}
export const quad = (a, b, c, d, fill, stroke) => poly([P(...a), P(...b), P(...c), P(...d)], fill, stroke);
export function floorRect(x0, y0, x1, y1, fill, z = 0, stroke) {
  quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], fill, stroke);
}
export function line3(a, b, color, lw = 1) {
  const p = P(...a);
  const q = P(...b);
  g.strokeStyle = color; g.lineWidth = lw;
  g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
}

// A solid box: top, south (+y) and east (+x) faces.
export function box(x, y, z, w, d, h, base, o = {}) {
  const top = o.top || shade(base, 0.12);
  const south = o.south || base;
  const east = o.east || shade(base, -0.13);
  const z1 = z + h;
  if (!o.noEast) quad([x + w, y, z1], [x + w, y + d, z1], [x + w, y + d, z], [x + w, y, z], east);
  if (!o.noSouth) quad([x, y + d, z1], [x + w, y + d, z1], [x + w, y + d, z], [x, y + d, z], south);
  if (!o.noTop) quad([x, y, z1], [x + w, y, z1], [x + w, y + d, z1], [x, y + d, z1], top);
  if (o.edge !== false) {
    line3([x, y + d, z1], [x + w, y + d, z1], 'rgba(255,255,255,.55)', 0.8);
    line3([x + w, y, z1], [x + w, y + d, z1], 'rgba(255,255,255,.35)', 0.8);
    line3([x + w, y + d, z1], [x + w, y + d, z], 'rgba(0,30,60,.10)', 0.8);
  }
}

// Draw in a face's own 2D frame: origin at the face's top-left as you look at it, y pointing down.
//   'south': plane y = const, u → +x;  'east': plane x = const, u → -y (origin at the larger y);  'top': plane z = const.
export function face(kind, x, y, z, fn) {
  const [ox, oy] = P(x, y, z);
  g.save();
  if (kind === 'south') g.transform(CY, SY * PITCH, 0, ZS, ox, oy);
  else if (kind === 'east') g.transform(SY, -CY * PITCH, 0, ZS, ox, oy);
  else g.transform(CY, SY * PITCH, -SY, CY * PITCH, ox, oy);
  fn(g);
  g.restore();
}

// Soft contact shadow on the floor (light from the north-west).
export function shadow(x, y, w, d, spread = 7, alpha = 0.1) {
  floorRect(x + 2, y + 2, x + w + spread, y + d + spread, `rgba(40,70,120,${alpha * 0.6})`);
  floorRect(x + 1, y + 1, x + w + spread * 0.45, y + d + spread * 0.45, `rgba(40,70,120,${alpha})`);
}
export function floorEllipse(x, y, rx, ry, fill) {
  const [u, v] = P(x, y, 0);
  g.fillStyle = fill;
  g.beginPath(); g.ellipse(u, v, rx, ry * PITCH, 0, 0, Math.PI * 2); g.fill();
}

// Convex screen-space silhouette of a box (for hit testing).
export function boxHull(x, y, z, w, d, h) {
  return [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z), P(x, y + d, z + h)]
    .map(([u, v]) => toScreen(u, v));
}
export function inPoly(pts, px, py) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
