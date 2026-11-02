// Matches "Claude A sent a message" (tmux send-keys / SendMessage) with
// "a prompt showed up in session B", so the office can show A walking over to B.
const WINDOW_BEFORE = 5 * 1000; // receiver timestamp may be slightly earlier (clock / write order)
const WINDOW_AFTER = 3 * 60 * 1000;
const KEEP = 40 * 60 * 1000;

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

function similar(a, b) {
  if (a.length < 2 || b.length < 2) return false;
  const k = Math.min(40, a.length, b.length);
  return b.includes(a.slice(0, k)) || a.includes(b.slice(0, k));
}

export class Broker {
  constructor(hub) {
    this.hub = hub;
    this.sents = [];
    this.recvs = [];
    this.pendingRecv = [];
    this.links = [];
    this.seq = 1;
  }

  sent(s) {
    s.norm = norm(s.text);
    // A copied config folder holds the same history in two logs (two session keys): count it once.
    if (this.sents.some((x) => x.sid !== s.sid && x.ts === s.ts && x.via === s.via && x.target === s.target && x.norm === s.norm)) return;
    s.at = Date.now();
    s.matched = false;
    this.sents.push(s);
    // A receiver line may already have been read (history replay order is arbitrary).
    const r = this.recvs.find((x) => !x.matched && x.sid !== s.sid && this.fits(s, x));
    if (r) { r.matched = true; s.matched = true; this.makeLink(s, r); }
  }

  received(r) {
    r.norm = norm(r.text);
    this.pendingRecv.push(r);
  }

  fits(s, r) {
    const dt = r.ts - s.ts;
    return dt >= -WINDOW_BEFORE && dt <= WINDOW_AFTER && similar(s.norm, r.norm);
  }

  // Called once per poll tick, after every file has been read, so both halves are known.
  flush() {
    const list = this.pendingRecv.splice(0);
    for (const r of list) {
      let best = null;
      for (const s of this.sents) {
        if (s.matched || s.sid === r.sid || !this.fits(s, r)) continue;
        if (!best || Math.abs(r.ts - s.ts) < Math.abs(r.ts - best.ts)) best = s;
      }
      let link = null;
      if (best) {
        best.matched = true;
        r.matched = true;
        link = this.makeLink(best, r);
      } else if (r.fromHint) {
        const from = this.hub.resolveSessionName(r.fromHint, r.sid);
        r.matched = true;
        link = this.makeLink({ sid: from, text: r.text, via: 'message', target: '', replay: r.replay, hint: r.fromHint }, r);
      }
      r.model.emitPrompt(r, link);
      if (!r.matched) this.recvs.push(r);
    }
    this.gc();
  }

  // Messages nobody (that we can see) received: still show them, addressed to the tmux pane / name.
  sweep() {
    const now = Date.now();
    for (const s of this.sents) {
      if (s.matched || s.swept || now - s.at < 15000) continue;
      s.swept = true;
      const to = this.hub.resolveSessionName(s.target, s.sid);
      this.makeLink(s, to ? { sid: to, text: s.text, ts: s.ts, replay: s.replay } : null);
    }
  }

  makeLink(s, r) {
    const link = {
      id: this.seq++,
      ts: r ? r.ts : s.ts,
      from: this.hub.sessionRef(s.sid, s.hint),
      to: r ? this.hub.sessionRef(r.sid) : { sid: null, label: s.target ? `${s.via === 'tmux' ? 'tmux ' : ''}${s.target}` : '?', floor: null },
      text: String((r && r.text) || s.text || '').slice(0, 600),
      via: s.via,
      live: !s.replay && !(r && r.replay),
    };
    this.links.push(link);
    if (this.links.length > 150) this.links.splice(0, this.links.length - 150);
    this.hub.broadcastLink(link);
    return link;
  }

  gc() {
    const cut = Date.now() - KEEP;
    if (this.sents.length > 400) this.sents.splice(0, this.sents.length - 400);
    if (this.recvs.length > 400) this.recvs.splice(0, this.recvs.length - 400);
    this.sents = this.sents.filter((s) => s.at > cut || !s.matched);
    this.recvs = this.recvs.filter((r) => (r.ts || 0) > cut - 3600000);
  }
}
