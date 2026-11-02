// Shared state and small helpers.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const S = {
  floors: [], accounts: new Map(), sources: [], offset: 0,
  view: { floor: null, num: null, primary: null, mode: 'follow' },
  sessions: new Map(), // sid -> { sid, meta, claude, agents: Map, history: Map, board, log, busy, lastTs, stats, rooms, slot }
  order: [], links: [], fleet: [], fleetAt: 0,
  connected: false, es: null, firstView: true, rolesSeen: false,
  selected: null, // { kind: 'actor', id } | { kind: 'room', room } | { kind: 'prop', id }
  hover: null,
  highlight: null, // actor id highlighted from a list row
  showOld: false,
  pendingSelect: null,
  config: { control: false, token: null }, // from /api/config
  prefill: null, // { sid, text } waiting for that Claude's control box
};

export const actors = new Map();
export const spotOwner = new Map();
export const fx = [];
export const elevator = { openUntil: 0, open: 0 };

const PREF_KEY = 'office.prefs.v2';
export const prefs = Object.assign(
  { coworkers: true, notify: false, staleMin: 5, labels: false, hidden: [], tab: 'log', logRoom: 'all', logAgents: true, scope: 'floor', agentFilter: 'all', sortKey: 'last', sortDir: -1 },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } })(),
);
export function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }
// Actor ids carry the session key (sid@account tag); ids saved before that have the bare sid.
const legacyId = (id) => id.replace(/@[0-9a-z]+(?=:|$)/, '');
export const isHidden = (id) => prefs.hidden.includes(id) || prefs.hidden.includes(legacyId(id));
export function setHidden(id, on) {
  if (on && !prefs.hidden.includes(id)) prefs.hidden.push(id);
  if (!on) for (const x of [id, legacyId(id)]) { const i = prefs.hidden.indexOf(x); if (i >= 0) prefs.hidden.splice(i, 1); }
  if (prefs.hidden.length > 300) prefs.hidden.splice(0, prefs.hidden.length - 300);
  savePrefs();
}

export const nowS = () => Date.now() + S.offset;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
export function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (nowS() - ms) / 1000);
  if (s < 10) return '방금';
  if (s < 60) return `${s | 0}초 전`;
  if (s < 3600) return `${(s / 60) | 0}분 전`;
  if (s < 86400) return `${(s / 3600) | 0}시간 전`;
  return `${(s / 86400) | 0}일 전`;
}
export function dur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}
export const hhmmss = (ts) => new Date(ts).toTimeString().slice(0, 8);
export function fmtTok(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}
export function shade(c, amt) {
  let r, g, b;
  if (typeof c === 'string' && c[0] === '#') {
    const n = parseInt(c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1), 16);
    r = n >> 16; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
    if (!m) return c;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  const f = (v) => clamp(Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)), 0, 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  const ta = document.createElement('textarea');
  ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}
