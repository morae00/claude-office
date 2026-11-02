// Pixel-art people, drawn upright at their feet position.
import { P } from './iso.js';
import { shade, hashStr, hslToHex } from './state.js';

export const U = 3; // iso units per sprite pixel
export const SPRITE_W = 14 * U;
export const SPRITE_H = 21 * U;

export function claudeLook(color) {
  return { kind: 'claude', hood: color, shirt: color, pants: '#46506a', skin: '#f8d7c2', spark: true };
}
export function agentLook(type) {
  const t = String(type || '').toLowerCase();
  const base = { kind: 'agent', hair: '#4a3426', pants: '#3f4a63', skin: '#f5d3b8' };
  if (t === 'explore') return { ...base, shirt: '#34b07a', hat: 'explorer', hatColor: '#257a55' };
  if (t === 'plan') return { ...base, shirt: '#8b5cf6', glasses: true, hair: '#2e2440' };
  if (t.includes('general')) return { ...base, shirt: '#3b82f6', headset: true };
  if (t.includes('workflow')) return { ...base, shirt: '#14b8a6', hat: 'hard' };
  if (t.includes('guide')) return { ...base, shirt: '#f2b134', hat: 'cap', hatColor: '#b9811a' };
  if (t.includes('review') || t.includes('critic')) return { ...base, shirt: '#ef5f6b', glasses: true };
  const hue = hashStr(t) % 360;
  return { ...base, shirt: hslToHex(hue, 58, 55), hat: 'cap', hatColor: hslToHex(hue, 55, 38) };
}
export const USER_LOOK = { kind: 'user', hair: '#2a2730', shirt: '#7c8aa5', pants: '#3a3f52', skin: '#f3d0b6' };

const FRONT_POSES = ['think', 'talk', 'wave', 'report', 'ask', 'phone', 'idle', 'sleep', 'read', 'listen', 'work'];

export function facingOf(a) {
  if (a.path.length) return a.moveDir === 'back' ? 'back' : 'front';
  if (a.face === 'up' && !FRONT_POSES.includes(a.pose)) return 'back';
  return 'front';
}

export function drawPerson(g, a, now, opts = {}) {
  const look = a.look;
  const walking = a.path.length > 0;
  const facing = facingOf(a);
  const sit = a.sit && !walking;
  const pose = walking ? 'walk' : a.pose;
  const bob = walking ? (Math.floor(a.walkPhase * 2) % 2) * 0.6 : 0;
  const [fx, fy] = P(a.x, a.y, 0);
  const ox = fx - 7 * U;
  const oy = fy - 21 * U + (sit ? 2 * U : 0) - bob;
  const flip = a.flip ? -1 : 1;
  const px = (x, y, w, h, c) => {
    g.fillStyle = c;
    const X = flip > 0 ? x : 14 - x - w;
    g.fillRect(ox + X * U, oy + y * U, w * U + 0.3, h * U + 0.3);
  };
  g.save();
  g.globalAlpha = a.alpha * (opts.dim ? 0.55 : 1);

  // contact shadow
  g.fillStyle = 'rgba(30,60,110,.22)';
  g.beginPath(); g.ellipse(fx, fy - 1, 12, 4, 0, 0, Math.PI * 2); g.fill();

  const hair = look.hood || look.hair;
  const shirt = look.shirt;
  const dark = shade(shirt, -0.18);
  const skin = look.skin;
  const t = now / 1000;
  if (!sit) {
    const step = walking ? (Math.floor(a.walkPhase * 4) % 2 ? 1 : -1) : 0;
    px(4, 15, 2, 5 - (step > 0 ? 1 : 0), look.pants);
    px(8, 15, 2, 5 - (step < 0 ? 1 : 0), look.pants);
    px(4, 20 - (step > 0 ? 1 : 0), 2, 1, '#2b2f3a');
    px(8, 20 - (step < 0 ? 1 : 0), 2, 1, '#2b2f3a');
  } else {
    px(4, 15, 2, 2, look.pants);
    px(8, 15, 2, 2, look.pants);
  }
  // body
  px(3, 9, 8, 7, shirt);
  px(10, 9, 1, 7, dark);
  px(3, 9, 1, 3, shade(shirt, 0.15));
  if (look.spark && facing === 'front') { px(5, 13, 4, 2, dark); px(6.5, 10, 1, 3, '#fff6ee'); px(5.5, 11, 3, 1, '#fff6ee'); }
  if (look.kind === 'claude' && facing === 'back') px(4, 9, 6, 3, shade(shirt, -0.08));

  const armDown = (side, len = 5) => { const x = side < 0 ? 2 : 11; px(x, 10, 1, len, shirt); px(x, 10 + len, 1, 1, skin); };
  switch (pose) {
    case 'walk': {
      const sw = Math.floor(a.walkPhase * 4) % 2 ? 1 : 0;
      px(2, 10, 1, 4 + sw, shirt); px(2, 14 + sw, 1, 1, skin);
      px(11, 10, 1, 5 - sw, shirt); px(11, 15 - sw, 1, 1, skin);
      break;
    }
    case 'read': {
      armDown(-1, 2); armDown(1, 2);
      px(3, 12, 1, 1, skin); px(10, 12, 1, 1, skin);
      px(3, 11, 8, 4, '#fffdf5');
      px(3, 11, 0.5, 4, '#e0795f'); px(10.5, 11, 0.5, 4, '#e0795f');
      px(6.75, 11, 0.5, 4, '#cfc8b6');
      const flipP = (t * 0.8) % 1;
      if (flipP < 0.25) px(7 + flipP * 12, 11, 0.5, 4, '#ece4cf');
      for (let l = 0; l < 3; l++) { px(3.8, 11.8 + l, 2.4, 0.4, '#b8bcc6'); px(7.6, 11.8 + l, 2.4, 0.4, '#b8bcc6'); }
      break;
    }
    case 'type':
    case 'browse': {
      const j = Math.floor(t * 8) % 2;
      px(2, 9 + j * 0.5, 1, 4, shirt); px(11, 9 + (1 - j) * 0.5, 1, 4, shirt);
      if (facing === 'front') { px(2, 13, 1, 1, skin); px(11, 13, 1, 1, skin); }
      break;
    }
    case 'rack': {
      const j = Math.floor(t * 3) % 2;
      armDown(-1);
      px(11, 4 + j, 1, 6, shirt); px(11, 3 + j, 1, 1, skin);
      break;
    }
    case 'board': {
      const j = Math.sin(t * 6) * 1.2;
      armDown(-1);
      px(11 + j * 0.3, 3, 1, 7, shirt); px(11 + j * 0.3, 2, 1, 1, skin); px(11 + j * 0.3, 1, 1, 1, '#2563eb');
      break;
    }
    case 'think': {
      armDown(-1, 4);
      px(9, 9, 2, 2, shirt); px(8, 8, 2, 1, skin);
      break;
    }
    case 'phone': {
      armDown(-1, 4);
      px(11, 5, 1, 5, shirt); px(10.5, 4, 1.5, 2, skin); px(11.2, 2.4, 1.2, 4, '#2b2f3a');
      break;
    }
    case 'ask': {
      armDown(-1);
      const j = Math.floor(t * 2) % 2;
      px(11, 3 + j, 1, 7, shirt); px(11, 2 + j, 1, 1, skin);
      break;
    }
    case 'wave': {
      armDown(-1);
      const j = Math.floor(t * 5) % 2;
      px(11 + j, 3, 1, 7, shirt); px(11 + j, 2, 1, 1, skin);
      break;
    }
    case 'report': {
      px(2, 10, 1, 3, shirt); px(11, 10, 1, 3, shirt);
      px(3, 12, 1, 1, skin); px(10, 12, 1, 1, skin);
      px(4, 10.5, 6, 5, '#ffffff');
      for (let l = 0; l < 3; l++) px(4.8, 11.5 + l * 1.2, 4.4, 0.4, '#9fb3c8');
      break;
    }
    case 'idle': {
      armDown(-1, 4);
      px(10, 11, 1, 3, shirt);
      px(9, 12, 2, 2, '#ffffff'); px(11, 12.5, 0.6, 1, '#ffffff');
      if (Math.floor(t * 1.5) % 2) px(9.5, 10.5, 0.5, 1, 'rgba(255,255,255,.8)'); else px(10.2, 10, 0.5, 1, 'rgba(255,255,255,.8)');
      break;
    }
    case 'work': {
      const j = Math.floor(t * 7) % 2;
      px(2, 10, 1, 4, shirt); px(11, 10, 1, 4, shirt);
      px(3, 13 + j * 0.5, 1, 1, skin); px(10, 13 + (1 - j) * 0.5, 1, 1, skin);
      break;
    }
    case 'talk': {
      armDown(-1);
      const j = Math.floor(t * 3) % 2;
      px(11, 8 + j, 1, 5, shirt); px(11, 7 + j, 1, 1, skin);
      break;
    }
    case 'listen':
    default:
      armDown(-1); armDown(1);
  }

  // head
  if (facing === 'front') {
    if (look.hood) {
      px(3, 0, 8, 1, hair); px(2, 1, 10, 8, hair);
      px(11, 2, 1, 6, shade(hair, -0.14));
      px(3, 0.5, 3, 1, shade(hair, 0.2));
      px(4, 2, 6, 6, skin);
      px(9, 3, 1, 5, shade(skin, -0.06));
      px(3, 8, 8, 1, shade(hair, -0.14));
    } else {
      px(3, 1, 8, 7, skin);
      px(3, 0, 8, 2, hair); px(2, 1, 1, 5, hair); px(11, 1, 1, 5, hair);
      px(3, 2, 2, 1, hair);
    }
    const blink = now > a.blinkAt && now < a.blinkAt + 130;
    if (now > a.blinkAt + 130) a.blinkAt = now + 2500 + Math.random() * 3500;
    const eyeY = pose === 'think' ? 3.5 : 4.5;
    if (pose === 'sleep' || blink) { px(5, 5, 1, 0.5, '#2a2333'); px(8, 5, 1, 0.5, '#2a2333'); }
    else { px(5, eyeY, 1, 1.2, '#2a2333'); px(8, eyeY, 1, 1.2, '#2a2333'); }
    g.globalAlpha = a.alpha * 0.55;
    px(4.2, 6, 1, 0.8, '#ff9aa2'); px(8.8, 6, 1, 0.8, '#ff9aa2');
    g.globalAlpha = a.alpha * (opts.dim ? 0.55 : 1);
    const talking = ['talk', 'phone', 'ask', 'report', 'wave'].includes(pose) || (a.bubble && a.bubble.kind !== 'think' && now < a.bubble.until);
    if (talking && Math.floor(t * 6) % 2) px(6.3, 6.6, 1.4, 0.9, '#8a3b3b');
    else if (pose !== 'think') px(6.3, 6.8, 1.4, 0.4, '#8a3b3b');
    if (look.glasses) { px(4.4, 4, 2.2, 1.6, '#232733'); px(4.8, 4.3, 1.4, 1, '#d8ecff'); px(7.4, 4, 2.2, 1.6, '#232733'); px(7.8, 4.3, 1.4, 1, '#d8ecff'); px(6.6, 4.4, 0.8, 0.4, '#232733'); }
  } else {
    px(3, 0, 8, 1, hair); px(2, 1, 10, 8, hair);
    px(3, 0.5, 3, 1, shade(hair, 0.2));
    px(11, 2, 1, 6, shade(hair, -0.14));
    if (!look.hood) px(3, 7, 8, 1, skin);
  }
  if (look.hat === 'explorer') { px(0.5, 1, 13, 1, shade(look.hatColor, -0.1)); px(3, -2, 8, 3, look.hatColor); px(3, 0, 8, 0.7, '#f1e2b3'); }
  else if (look.hat === 'hard') { px(2.5, -1.5, 9, 2.5, '#f8c630'); px(1.5, 0.8, 11, 0.8, '#dba915'); px(6.5, -1.5, 1, 2.5, '#ffe58a'); }
  else if (look.hat === 'cap') { px(3, -0.8, 8, 2, look.hatColor); if (facing === 'front') px(2, 1, 6, 0.8, shade(look.hatColor, -0.15)); }
  if (look.headset) { px(2, -0.6, 10, 0.8, '#2f3442'); px(1.2, 3, 1.4, 3, '#2f3442'); px(11.4, 3, 1.4, 3, '#2f3442'); if (facing === 'front') px(9, 6.8, 3, 0.5, '#2f3442'); }

  if (now < a.sweatUntil) {
    const d = (now / 400) % 1;
    g.fillStyle = '#5cc8ff';
    g.beginPath(); g.ellipse(ox + 12.5 * U, oy + (2 + d * 4) * U, 2.4, 3.4, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(ox + 0.8 * U, oy + (3 + ((d + 0.5) % 1) * 4) * U, 2, 3, 0, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
