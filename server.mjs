#!/usr/bin/env node
// Claude Office — tails Claude Code session logs (~/.claude*/projects/**/*.jsonl)
// and streams "who is where doing what" to the browser over SSE (/events).
// No packages, no hooks, no settings changes. Listens on 127.0.0.1 only by default.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LocalSource, SshSource } from './lib/sources.mjs';
import { SessionModel } from './lib/model.mjs';
import { Broker } from './lib/broker.mjs';
import { rankPanes, terminalEntry } from './lib/control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

// ---- options ----------------------------------------------------------------
function parseArgs(argv) {
  const o = { port: 4747, host: '127.0.0.1', ssh: [], roots: [], sshRoots: [], local: true, onlyRoots: false, python: 'python3', open: false, allowControl: false, share: false, key: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--ssh') o.ssh.push(next());
    else if (a === '--root') o.roots.push(next());
    else if (a === '--ssh-root') o.sshRoots.push(next());
    else if (a === '--no-local') o.local = false;
    else if (a === '--only-roots') o.onlyRoots = true;
    else if (a === '--allow-control') o.allowControl = true;
    else if (a === '--share') o.share = true;
    else if (a === '--key') o.key = next();
    else if (a === '--python') o.python = next();
    else if (a === '--open') o.open = true;
    else if (a === '--help' || a === '-h') {
      console.log(`사용법: node server.mjs [옵션]
  --port N            포트 (기본 4747)
  --ssh HOST          SSH 호스트의 Claude 세션도 표시 (여러 번 가능, ~/.ssh/config 이름 사용)
  --ssh-root PATH[=이름]  SSH 호스트에서 추가로 읽을 설정 폴더 (예: ~/.claude-work=업무)
  --root PATH[=이름]   이 PC에서 추가로 읽을 설정 폴더 (CLAUDE_CONFIG_DIR 등)
  --no-local          이 PC의 세션은 빼고 SSH 호스트만 표시
  --only-roots        자동 탐색 없이 --root 로 준 폴더만 읽기
  --allow-control     화면에서 tmux 창으로 메시지 보내기 · 멈추기(Esc), 세션 종료 · 휴지통으로 옮기기 허용 (기본은 읽기 전용)
  --share             휴대폰 등 다른 기기에서 보기 (같은 네트워크, 접속 키 필요)
  --key KEY           --share 접속 키를 직접 정하기 (기본: 켤 때마다 새로 만듦)
  --python CMD        원격에서 쓸 파이썬 (기본 python3)
  --open              브라우저 자동으로 열기
  --host ADDR         바인드 주소 (기본 127.0.0.1)`);
      process.exit(0);
    }
  }
  return o;
}
const OPT = parseArgs(process.argv.slice(2));
// Per-run secret for the control endpoint: only our own page (same origin) can read it from /api/config.
const TOKEN = crypto.randomBytes(24).toString('hex');
if (OPT.share && OPT.host === '127.0.0.1') OPT.host = '::'; // IPv4 + IPv6 (some Wi-Fi / hotspots are IPv6-only)
// Whenever other devices can reach the server, they need an access key (this PC itself does not).
const NETWORKED = !['127.0.0.1', 'localhost', '::1'].includes(OPT.host);
const ACCESS_KEY = NETWORKED ? (OPT.key || Array.from(crypto.randomBytes(10), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')) : null;

const splitLabel = (s) => {
  const i = s.lastIndexOf('=');
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
};
const rootLabels = new Map(); // expanded root path or config dir -> label
const expandHome = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME || '');
for (const r of OPT.roots) { const [p, l] = splitLabel(r); if (l) rootLabels.set(expandHome(p).replace(/\/projects\/?$/, '').replace(/\/+$/, ''), l); }

const TICK_MS = 250;
const SUBS_MS = 1500;
const SCAN_MS = 2000;
const PROCS_MS = 3000;
const ACTIVE_MS = 90 * 1000;
const AUTO_WATCH_MS = 15 * 60 * 1000;
const COWORKER_MS = 10 * 60 * 1000;
const REPLAY_BYTES = 2.5 * 1024 * 1024;
const AGENT_REPLAY_BYTES = 512 * 1024;
const AGENT_RECENT_MS = 15 * 60 * 1000;
const PALETTE = ['#d97757', '#5b6bd9', '#d9577f', '#1f9e8f', '#c9932a', '#9a5bd9', '#5f7a8a', '#7a9a2f'];

// ---- tailing ------------------------------------------------------------------
class TailFile {
  constructor(p, offset, skipFirst = false) {
    this.path = p;
    this.offset = offset;
    this.partial = null;
    this.skipFirst = skipFirst;
  }
  feed(start, buf, onObj) {
    if (start !== this.offset) this.partial = null;
    let data = this.partial ? Buffer.concat([this.partial, buf]) : buf;
    this.offset = start + buf.length;
    let pos = 0;
    if (this.skipFirst) {
      const nl = data.indexOf(10);
      if (nl < 0) { this.partial = Buffer.from(data); return; }
      pos = nl + 1;
      this.skipFirst = false;
    }
    for (;;) {
      const nl = data.indexOf(10, pos);
      if (nl < 0) break;
      const line = data.subarray(pos, nl);
      pos = nl + 1;
      if (line.length < 2) continue;
      let o;
      try { o = JSON.parse(line.toString('utf8')); } catch { continue; }
      try { onObj(o); } catch (e) { console.error('[parse]', e); }
    }
    this.partial = pos < data.length ? Buffer.from(data.subarray(pos)) : null;
  }
}

class Watcher {
  constructor(hub, sess) {
    this.hub = hub;
    this.sess = sess;
    this.listeners = new Set();
    this.subs = new Map(); // path -> { tail, dormant, key, tries }
    this.ready = false;
    this.lastWanted = Date.now();
    // The model, the broker and the browser all know a session by its key (sid@account tag).
    this.model = new SessionModel(sess.id, {
      emit: (e) => { for (const fn of this.listeners) fn(sess.id, e); },
      sent: (s) => hub.broker.sent(s),
      received: (r) => hub.broker.received(r),
    });
    if (sess.title) this.model.title = sess.title;
  }

  async init() {
    const { src, path: p } = this.sess;
    const t = await src.call('tail', { path: p, bytes: REPLAY_BYTES });
    this.model.replaying = true;
    this.main = new TailFile(p, t.start, t.start > 0);
    this.main.feed(t.start, t.data, (o) => this.model.handleMain(o));
    const list = (await src.call('subs', { dirs: [this.sess.dir] }))[this.sess.dir] || [];
    const now = Date.now();
    for (const [sp, size, mtime] of list) {
      if (now - mtime < AGENT_RECENT_MS) await this.addSub(sp, size, mtime, true);
      else this.subs.set(sp, { tail: new TailFile(sp, size), dormant: true, key: null, tries: 0 });
    }
    this.model.finishReplay(this.sess.mtime);
    this.model.replaying = false;
    if (this.model.title && !this.sess.title) this.sess.title = this.model.title;
    this.hub.broker.flush();
    this.ready = true;
  }

  async addSub(sp, size, mtime, replay) {
    const metaPath = sp.replace(/\.jsonl$/, '.meta.json');
    const texts = await this.sess.src.call('texts', { paths: [metaPath], max: 8192 });
    let meta = null;
    try { meta = texts[metaPath] ? JSON.parse(texts[metaPath]) : null; } catch {}
    const agentId = (/agent-([^/]+?)\.jsonl$/.exec(sp) || [])[1] || sp;
    const runId = (/workflows\/([^/]+)\/agent-/.exec(sp) || [])[1] || null;
    const entry = this.subs.get(sp) || { tail: new TailFile(sp, 0), dormant: false, key: null, tries: 0 };
    this.subs.set(sp, entry);
    if (!meta && !replay && entry.tries++ < 2 && !this.model.agentById.has(agentId)) return; // meta not written yet; retry
    const key = this.model.agentById.get(agentId) || (meta && meta.toolUseId) || 'a:' + agentId;
    const a = this.model.ensureAgent(key, {
      agentId, type: meta && meta.agentType, desc: meta && meta.description,
      workflowTool: runId ? this.model.workflowRuns.get(runId) || ('wf:' + runId) : null,
    }, mtime);
    a.fileMtime = mtime;
    entry.key = key;
    entry.dormant = false;
    if (replay) {
      const t = await this.sess.src.call('tail', { path: sp, bytes: AGENT_REPLAY_BYTES });
      entry.tail = new TailFile(sp, t.start, t.start > 0);
      entry.tail.feed(t.start, t.data, (o) => this.model.handleAgentLine(a, o));
    }
  }

  feedSub(entry, start, data) {
    const a = this.model.agents.get(entry.key);
    if (!a) return;
    entry.tail.feed(start, data, (o) => this.model.handleAgentLine(a, o));
  }
}

// ---- the building -------------------------------------------------------------
class Hub {
  constructor(sources) {
    this.sources = sources;
    this.accounts = new Map();
    this.floors = new Map();
    this.sessions = new Map();
    this.watchers = new Map();
    this.views = new Set();
    this.broker = new Broker(this);
    this.nextFloor = 1;
    this.floorsMsg = '';
  }

  start() {
    for (const src of this.sources) {
      src.start();
      src.roots = [];
      const loop = (fn, ms) => {
        const run = async () => {
          try { await fn(src); } catch (e) { if (!/ssh/.test(String(e))) console.error(`[${src.id}]`, e.message || e); }
          setTimeout(run, ms);
        };
        run();
      };
      loop((s) => this.scan(s), SCAN_MS);
      loop((s) => this.tick(s), TICK_MS);
      loop((s) => this.scanSubs(s), SUBS_MS);
      loop((s) => this.scanProcs(s), PROCS_MS);
    }
    setInterval(() => this.broker.sweep(), 1000);
    setInterval(() => this.broadcastFleet(), 2000);
    setInterval(() => { for (const v of this.views) v.update(false); }, 1000);
    setInterval(() => this.gcWatchers(), 10000);
  }

  account(src, root) {
    const r = src.roots.find((x) => x.root === root);
    return r ? r.akey : null;
  }

  registerRoots(src, roots) {
    const prevLabels = new Map([...this.accounts.values()].map((a) => [a.label, a.key]));
    for (const r of roots) {
      const cfg = r.configDir.replace(/\/+$/, '');
      const akey = `${src.id}|${cfg}`;
      r.akey = akey;
      if (this.accounts.has(akey)) continue;
      const base = path.basename(cfg);
      let label = rootLabels.get(cfg) || (src.remote ? labelFromSshRoots(cfg) : '') ||
        (r.account && (r.account.name || (r.account.email || '').split('@')[0])) || '';
      if (!label) label = base === '.claude' ? '기본' : base.replace(/^\.claude[-_.]?/, '') || base;
      label = label.length > 14 ? label.slice(0, 13) + '…' : label;
      if (prevLabels.has(label)) label = `${label}·${base.replace(/^\.claude[-_.]?/, '') || 'main'}`;
      prevLabels.set(label, akey);
      const color = PALETTE[this.accounts.size % PALETTE.length];
      this.accounts.set(akey, { key: akey, label, color, src: src.id, configDir: cfg });
      console.log(`[${src.id}] 계정 발견: ${label}  (${cfg})`);
    }
  }

  async scan(src) {
    const now = Date.now();
    if (!src.rootsAt || now - src.rootsAt > 30000) {
      const roots = await src.call('roots', {});
      this.registerRoots(src, roots);
      src.roots = roots;
      src.rootsAt = now;
    }
    if (!src.roots.length) return;
    const res = await src.call('scan', { roots: src.roots.map((r) => r.root) });
    const gen = (src.gen = (src.gen || 0) + 1);
    const fresh = [];
    for (const { root, dirs } of res) {
      const akey = this.account(src, root);
      const tag = acctTag(String(akey));
      for (const [dirName, dmtime, files] of dirs) {
        const fkey = `${src.id}|${dirName}`;
        let floor = this.floors.get(fkey);
        if (!floor) {
          floor = { fkey, src, dirName, num: 0, name: prettyDir(dirName), cwd: '', mtime: 0, dmtime, sessions: new Set() };
          this.floors.set(fkey, floor);
        }
        floor.dmtime = Math.max(floor.dmtime || 0, dmtime);
        for (const [fname, size, mtime] of files) {
          const sid = fname.slice(0, -6);
          // A copied config folder holds the same session ids as another account, each a separate live log:
          // key by account too (s.id), keep the real session id in s.sid.
          const id = `${sid}@${tag}`;
          let s = this.sessions.get(id);
          if (!s) {
            s = { id, sid, src, akey, root, dirName, fkey, path: path.posix.join(root, dirName, fname), dir: path.posix.join(root, dirName, sid),
              size, mtime, activeTs: mtime, title: '', startTs: 0, head: false, titleCheckedAt: 0 };
            this.sessions.set(id, s);
            fresh.push(s);
          }
          if (mtime !== s.mtime) s.titleCheckedAt = 0;
          s.size = size;
          s.mtime = mtime;
          s.activeTs = Math.max(s.activeTs || 0, mtime);
          s.gen = gen;
          floor.sessions.add(id);
        }
      }
    }
    for (const [id, s] of this.sessions) {
      if (s.src === src && s.gen !== gen && !this.watchers.has(id)) {
        this.sessions.delete(id);
        const f = this.floors.get(s.fkey);
        if (f) f.sessions.delete(id);
      }
    }
    // First lines: cwd, start time, first prompt (title fallback).
    const needHead = [...this.sessions.values()].filter((s) => s.src === src && !s.head && s.size > 0).slice(0, 40);
    if (needHead.length) {
      const texts = await src.call('texts', { paths: needHead.map((s) => s.path), max: 96 * 1024 });
      for (const s of needHead) { s.head = true; readHead(s, texts[s.path] || ''); }
    }
    const needTitle = [...this.sessions.values()].filter((s) => s.src === src && now - s.titleCheckedAt > 15000 && now - s.mtime < 7 * 86400000).slice(0, 60);
    if (needTitle.length) {
      const tp = (s) => path.posix.join(s.dir, 'custom-title.json');
      const texts = await src.call('texts', { paths: needTitle.map(tp), max: 4096 });
      for (const s of needTitle) {
        s.titleCheckedAt = now;
        try { const t = JSON.parse(texts[tp(s)] || 'null'); if (t && t.customTitle) s.title = t.customTitle; } catch {}
        const w = this.watchers.get(s.id);
        if (w && w.model.title && w.model.title !== s.title) s.title = w.model.title;
      }
    }
    for (const f of this.floors.values()) {
      if (f.src !== src) continue;
      let m = 0;
      for (const id of f.sessions) {
        const s = this.sessions.get(id);
        if (!s) continue;
        m = Math.max(m, s.activeTs || s.mtime);
        if (!f.cwd && s.cwd) { f.cwd = s.cwd; f.name = path.posix.basename(s.cwd) || f.name; }
      }
      f.mtime = m || f.dmtime || 0;
    }
    const unnumbered = [...this.floors.values()].filter((f) => !f.num).sort((a, b) => b.mtime - a.mtime);
    for (const f of unnumbered) f.num = this.nextFloor++;
    // Keep recently active sessions watched so cross-session messages and coworkers work, and every
    // session whose claude is still open: it may be sitting on a question for hours.
    for (const s of this.sessions.values()) {
      if (s.src === src && (now - s.mtime < AUTO_WATCH_MS || this.procOf(s))) this.watch(s.id).catch(() => {});
    }
    this.broadcastFloors();
  }

  async tick(src) {
    if (src.ticking) return;
    src.ticking = true;
    try {
      const reqs = [];
      const route = new Map();
      for (const w of this.watchers.values()) {
        if (!w.ready || w.sess.src !== src) continue;
        reqs.push({ path: w.main.path, offset: w.main.offset, max: 4 << 20 });
        route.set(w.main.path, { w });
        for (const [sp, e] of w.subs) {
          if (e.dormant || !e.key) continue;
          reqs.push({ path: sp, offset: e.tail.offset, max: 4 << 20 });
          route.set(sp, { w, e });
        }
      }
      if (!reqs.length) return;
      const res = await src.call('poll', { files: reqs });
      for (const r of res) {
        if (!r || r.missing) continue;
        const t = route.get(r.path);
        if (!t) continue;
        const { w, e } = t;
        const tail = e ? e.tail : w.main;
        if (r.size < tail.offset) { tail.offset = r.size; tail.partial = null; continue; }
        w.sess.activeTs = Math.max(w.sess.activeTs || 0, r.mtime);
        if (!r.data || !r.data.length) continue;
        if (e) {
          const a = w.model.agents.get(e.key);
          if (a) a.fileMtime = r.mtime;
          w.feedSub(e, r.start, r.data);
        } else {
          tail.feed(r.start, r.data, (o) => w.model.handleMain(o));
        }
      }
      this.broker.flush();
    } finally {
      src.ticking = false;
    }
  }

  async scanSubs(src) {
    const ws = [...this.watchers.values()].filter((w) => w.ready && w.sess.src === src);
    if (!ws.length) return;
    const res = await src.call('subs', { dirs: ws.map((w) => w.sess.dir) });
    for (const w of ws) {
      for (const [sp, size, mtime] of res[w.sess.dir] || []) {
        const e = w.subs.get(sp);
        if (!e) { await w.addSub(sp, size, mtime, false); continue; }
        if (e.dormant) {
          // An old agent file only comes back to life when it actually grows; it then tails from where it was.
          if (size > e.tail.offset) { if (e.key) e.dormant = false; else await w.addSub(sp, size, mtime, false); }
          continue;
        }
        if (!e.key) { if (size > 0) await w.addSub(sp, size, mtime, false); continue; }
        w.sess.activeTs = Math.max(w.sess.activeTs || 0, mtime);
      }
      // Agents that went home a while ago stop being polled until their file grows again.
      for (const e of w.subs.values()) {
        const a = e.key && w.model.agents.get(e.key);
        if (a && a.status !== 'working' && Date.now() - (a.fileMtime || 0) > 60000) e.dormant = true;
      }
    }
  }

  // Which claude process (and tmux pane) each session is open in, from <configDir>/sessions/<pid>.json.
  // Keyed by account too: a copied config folder can hold the same session id as another account.
  async scanProcs(src) {
    const dirs = [...new Set((src.roots || []).map((r) => r.configDir.replace(/\/+$/, '')))];
    if (!dirs.length) return;
    const { procs = [], panes = {}, dirs: seen } = await src.call('procs', { dirs });
    const map = new Map();
    for (const p of procs) {
      const m = /^(.+):@?\d*\.(%\d+)$/.exec(p.tmux || '');
      map.set(`${p.configDir}|${p.sessionId}`, {
        sid: p.sessionId, pid: p.pid, name: p.name || '', status: p.status || '', cwd: p.cwd || '',
        waitingFor: p.waitingFor || '', statusUpdatedAt: Number(p.statusUpdatedAt) || 0, entrypoint: p.entrypoint || '',
        tmux: m ? { session: m[1], pane: m[2], name: panes[m[2]] || null } : null,
      });
    }
    // A claude waiting on a dialog: read the bottom of its pane, the dialog may not be in the log yet.
    const waiting = [...map.values()].filter((p) => p.status === 'waiting' && p.tmux);
    if (waiting.length) {
      try {
        const scr = await src.call('screens', { panes: waiting.map((p) => p.tmux.pane) });
        for (const p of waiting) p.screen = scr[p.tmux.pane] || '';
      } catch {}
    }
    src.procs = map;
    // Accounts whose claude writes sessions/<pid>.json: there, no file means the session is closed.
    src.procDirs = new Set(seen || []);
  }

  // Is this session waiting on a human, and for what? Claude's own status file says whether it is
  // waiting (a dialog is open); the log says on what (a question, a plan, a tool to allow) or how the
  // last turn ended (with a question to you, or after messaging another session).
  attentionOf(s) {
    const p = this.procOf(s);
    if (p && p.status && p.status !== 'idle' && p.status !== 'waiting') return null; // busy, running a shell command, …
    const w = this.watchers.get(s.id);
    const wi = w && w.ready ? w.model.waitInfo() : null;
    const askOf = (a, since) => (a.kind === 'plan'
      ? { kind: 'plan', since: since || a.ts, plan: a.plan }
      : { kind: 'question', since: since || a.ts, questions: a.questions });
    if (p && p.status === 'waiting') {
      const screen = p.screen ? { screen: p.screen } : {};
      if (wi && wi.ask) return { ...askOf(wi.ask, p.statusUpdatedAt), ...screen };
      if (wi && wi.tool) return { kind: 'permission', since: p.statusUpdatedAt || wi.tool.ts, tool: wi.tool, ...screen };
      return { kind: 'dialog', since: p.statusUpdatedAt, text: WAITING_FOR[p.waitingFor] || p.waitingFor || '', ...screen };
    }
    if (!wi) return null;
    const acct = this.accounts.get(s.akey);
    const tracked = !!(acct && s.src.procDirs && s.src.procDirs.has(acct.configDir));
    // Closed sessions wait for nobody. Without status files (older Claude Code), trust a recent log.
    if (!p && (tracked || Date.now() - (wi.lastTs || 0) > 6 * 3600 * 1000)) return null;
    if (!p && wi.ask) return askOf(wi.ask, 0);
    const e = wi.ended;
    if (e && e.question) return { kind: 'reply', since: e.ts, text: e.text };
    if (e && e.peer) return { kind: 'peer', since: e.ts, target: e.peer, text: e.text };
    return null;
  }

  // Forget a session that was moved to the trash: no more watching, gone from every open page.
  forget(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.watchers.delete(id);
    this.sessions.delete(id);
    const f = this.floors.get(s.fkey);
    if (f) f.sessions.delete(id);
    for (const v of this.views) {
      const off = v.shown.get(id);
      if (off) { off(); v.shown.delete(id); v.send({ t: 'drop', sid: id }); }
      if (v.pinSid === id) { v.pinSid = null; v.mode = 'follow'; }
      if (v.primary === id) v.primary = null;
    }
    this.broadcastFloors();
  }

  // Every session in the building for the session manager (the floor guide shows only recent ones).
  sessionList() {
    return [...this.sessions.values()].map((s) => {
      const p = this.procOf(s);
      const w = this.watchers.get(s.id);
      const acct = this.accounts.get(s.akey) || {};
      const f = this.floors.get(s.fkey);
      const entry = (p && p.entrypoint) || s.entrypoint || '';
      const wait = this.attentionOf(s);
      return {
        sid: s.id, sessionId: s.sid, title: s.title || (w && w.model.title) || '', firstPrompt: s.firstPrompt || '', akey: s.akey,
        acct: acct.label || '', color: acct.color || PALETTE[0], host: s.src.remote ? s.src.label : null,
        floor: f ? f.num : null, floorName: f ? f.name : '', fkey: s.fkey, cwd: s.cwd || (f && f.cwd) || '',
        size: s.size, mtime: Math.max(s.mtime, s.activeTs || 0), startTs: s.startTs, entry, manageable: terminalEntry(entry),
        proc: p ? { pid: p.pid, status: p.status, waitingFor: p.waitingFor, tmux: p.tmux, name: p.name } : null,
        wait: wait ? wait.kind : null,
      };
    });
  }

  async trashList() {
    const out = [];
    for (const src of this.sources) {
      const accts = [...this.accounts.values()].filter((a) => a.src === src.id);
      if (!accts.length) continue;
      let list = [];
      try {
        // An SSH host that is reconnecting would hold the whole list up; skip it after a moment.
        list = await Promise.race([src.call('trash_list', { dirs: accts.map((a) => a.configDir) }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]);
      } catch { continue; }
      for (const t of list) {
        const a = accts.find((x) => x.configDir === t.configDir);
        if (a) out.push({ akey: a.key, acct: a.label, color: a.color, host: src.remote ? src.label : null, entry: t.entry, sessionId: t.sessionId, dirName: t.dirName, title: t.title, deletedAt: t.deletedAt, items: t.items });
      }
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  procOf(s) {
    const acct = s && this.accounts.get(s.akey);
    return (acct && s.src.procs && s.src.procs.get(`${acct.configDir}|${s.sid}`)) || null;
  }

  // Panes that some other session's sessions/<pid>.json names: never guess those for this session.
  // A copy of this session in another account is "other" too.
  claimedPanes(s) {
    const out = new Map();
    const acct = this.accounts.get(s.akey);
    const mine = acct ? `${acct.configDir}|${s.sid}` : '';
    for (const [k, p] of s.src.procs || new Map()) if (p.tmux && k !== mine) out.set(p.tmux.pane, p.name);
    return out;
  }

  // Session key for a key, or for a bare session id from older links (session=<sid>, /api/panes?sid=<sid>):
  // when several accounts hold that id, the copy a live claude has open wins, then the most recent one.
  resolve(id) {
    id = String(id || '');
    if (this.sessions.has(id)) return id;
    if (!id || id.includes('@')) return null;
    let best = null;
    for (const s of this.sessions.values()) if (s.sid === id && (!best || this.betterCopy(s, best))) best = s;
    return best ? best.id : null;
  }

  betterCopy(a, b) {
    const pa = this.procOf(a) ? 1 : 0;
    const pb = this.procOf(b) ? 1 : 0;
    return pa !== pb ? pa > pb : (a.activeTs || a.mtime) > (b.activeTs || b.mtime);
  }

  watch(id) {
    let w = this.watchers.get(id);
    if (w) { w.lastWanted = Date.now(); return w.initing; }
    const s = this.sessions.get(id);
    if (!s) return Promise.reject(new Error('no session ' + id));
    w = new Watcher(this, s);
    this.watchers.set(id, w);
    w.initing = w.init().then(() => w).catch((e) => { this.watchers.delete(id); throw e; });
    return w.initing;
  }

  gcWatchers() {
    const now = Date.now();
    for (const [id, w] of this.watchers) {
      if (w.listeners.size || !w.ready || this.procOf(w.sess)) continue;
      if (now - w.lastWanted > 60000 && now - (w.sess.activeTs || w.sess.mtime) > AUTO_WATCH_MS + 5 * 60000) this.watchers.delete(id);
    }
  }

  sessionRef(id, hint) {
    const s = id && this.sessions.get(id);
    if (!s) return { sid: null, label: hint || '?', acct: '', color: '#888', floor: null, fkey: null };
    const acct = this.accounts.get(s.akey);
    const f = this.floors.get(s.fkey);
    return { sid: id, label: s.title || hint || s.sid.slice(0, 8), acct: acct ? acct.label : '', color: acct ? acct.color : '#888', floor: f ? f.num : null, fkey: s.fkey };
  }

  resolveSessionName(name, exceptId) {
    if (!name) return null;
    const n = String(name).trim();
    let best = null;
    for (const s of this.sessions.values()) {
      if (s.id === exceptId) continue;
      const w = this.watchers.get(s.id);
      const names = w ? [w.model.title, ...w.model.names] : [s.title];
      if ((s.id === n || s.sid === n || s.sid.startsWith(n) || names.includes(n)) && (!best || this.betterCopy(s, best))) best = s;
    }
    return best ? best.id : null;
  }

  floorsPayload() {
    const now = Date.now();
    const floors = [...this.floors.values()].sort((a, b) => b.num - a.num).map((f) => ({
      fkey: f.fkey, num: f.num, name: f.name, cwd: f.cwd, host: f.src.remote ? f.src.label : null, mtime: f.mtime,
      // `sid` is the session key the browser uses everywhere; `sessionId` is Claude's own id.
      // The 40 most recent, plus any whose claude is still open (one of those may be waiting on you).
      sessions: [...f.sessions].map((id) => this.sessions.get(id)).filter(Boolean)
        .sort((a, b) => (b.activeTs || b.mtime) - (a.activeTs || a.mtime)).filter((s, i) => i < 40 || this.procOf(s))
        .map((s) => {
          const w = this.watchers.get(s.id);
          return { sid: s.id, sessionId: s.sid, title: s.title || (w && w.model.title) || s.firstPrompt || '', akey: s.akey, mtime: Math.max(s.mtime, s.activeTs || 0), startTs: s.startTs, busy: !!(w && w.model.busy), ...this.procBits(s), wait: this.attentionOf(s) };
        }),
    }));
    return {
      t: 'floors', now,
      sources: this.sources.map((s) => ({ id: s.id, label: s.label, remote: s.remote, status: s.status, error: s.error })),
      accounts: [...this.accounts.values()].map((a) => ({ key: a.key, label: a.label, color: a.color, src: a.src })),
      floors,
    };
  }

  broadcastFloors() {
    const msg = JSON.stringify(this.floorsPayload());
    this.floorsMsg = msg;
    for (const v of this.views) v.sendRaw(msg);
  }

  // Building-wide summary for the agent monitor: every watched session and its subagents.
  fleetPayload() {
    const sessions = [];
    for (const w of this.watchers.values()) {
      if (!w.ready) continue;
      const s = w.sess;
      const f = this.floors.get(s.fkey);
      sessions.push({ sid: s.id, ...this.sessionMeta(s.id), floor: f ? f.num : null, fkey: s.fkey, floorName: f ? f.name : '', ...w.model.fleetView() });
    }
    sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    return { t: 'fleet', now: Date.now(), sessions };
  }

  broadcastFleet() {
    if (!this.views.size) return;
    const msg = JSON.stringify(this.fleetPayload());
    for (const v of this.views) v.sendRaw(msg);
  }

  sessionMeta(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const w = this.watchers.get(id);
    const acct = this.accounts.get(s.akey) || {};
    return {
      sessionId: s.sid, title: (w && w.model.title) || s.title || s.firstPrompt || '', akey: s.akey, acct: acct.label || '', color: acct.color || PALETTE[0],
      startTs: s.startTs, cwd: s.cwd || '', configDir: acct.configDir || '', host: s.src.remote ? s.src.label : null, file: s.path,
      ...this.procBits(s),
    };
  }

  procBits(s) {
    const p = this.procOf(s);
    return { tmux: (p && p.tmux) || null, procName: p ? p.name : null, procStatus: p ? p.status : null, live: !!p };
  }

  broadcastLink(link) {
    for (const v of this.views) v.send({ t: 'link', link });
  }
}

// sessions/<pid>.json "waitingFor" when no question / plan / tool call explains it.
const WAITING_FOR = {
  'input needed': '입력을 기다려요', 'dialog open': '열린 창에서 선택을 기다려요', 'sandbox request': '샌드박스 허용을 기다려요',
  'goal proposal': '목표 제안 확인을 기다려요', 'worker request': '작업자 요청 확인을 기다려요',
};

function labelFromSshRoots(cfg) {
  for (const r of OPT.sshRoots) {
    const [p, l] = splitLabel(r);
    const c = p.replace(/\/projects\/?$/, '').replace(/\/+$/, '');
    if (l && (cfg === c || cfg.endsWith(c.replace(/^~/, '')))) return l;
  }
  return '';
}

// Short, stable, colon-free account tag for session keys ("<sid>@<tag>"): the client splits actor ids on ':'.
function acctTag(akey) {
  let h = 2166136261;
  for (let i = 0; i < akey.length; i++) h = Math.imul(h ^ akey.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function prettyDir(d) {
  return d.replace(/^-(Users|home)-[^-]+-/, '').replace(/^-/, '') || d;
}

function readHead(s, text) {
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!s.cwd && o.cwd) s.cwd = o.cwd;
    if (!s.entrypoint && o.entrypoint) s.entrypoint = o.entrypoint;
    if (!s.startTs && o.timestamp) s.startTs = Date.parse(o.timestamp) || 0;
    if (o.type === 'custom-title' && o.customTitle) s.title = o.customTitle;
    if (!s.firstPrompt && o.type === 'user' && !o.isMeta && o.message) {
      const c = o.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : '';
      if (t && !/^\s*</.test(t) && !/^Caveat:/.test(t)) s.firstPrompt = t.replace(/\s+/g, ' ').trim().slice(0, 40);
    }
    if (s.cwd && s.startTs && s.firstPrompt) break;
  }
}

// ---- one browser tab ------------------------------------------------------------
class View {
  constructor(hub, res, q) {
    this.hub = hub;
    this.res = res;
    this.fkey = q.get('floor') || null;
    this.pinSid = q.get('session') || null;
    this.mode = this.pinSid ? 'pin' : 'follow';
    this.coworkersOn = q.get('coworkers') !== '0';
    this.primary = null;
    this.shown = new Map();
    this.known = new Set();
    this.knownFloor = null;
    this.busy = false;
    this.closed = false;
    this.lastFloors = '';
    this.rolesMsg = '';
  }

  sendRaw(json) {
    if (this.closed) return;
    if (json.startsWith('{"t":"floors"')) { if (json === this.lastFloors) return; this.lastFloors = json; }
    this.res.write(`data: ${json}\n\n`);
  }
  send(obj) { this.sendRaw(JSON.stringify(obj)); }

  async start() {
    this.sendRaw(this.hub.floorsMsg || JSON.stringify(this.hub.floorsPayload()));
    this.send({ t: 'links', links: this.hub.broker.links.slice(-100) });
    this.sendRaw(JSON.stringify(this.hub.fleetPayload()));
    await this.update(true);
  }

  pickFloor() {
    const fl = this.hub.floors;
    if (this.fkey && fl.has(this.fkey)) return fl.get(this.fkey);
    if (this.pinSid && this.hub.sessions.has(this.pinSid)) return fl.get(this.hub.sessions.get(this.pinSid).fkey);
    let best = null;
    for (const f of fl.values()) if (f.sessions.size && (!best || f.mtime > best.mtime)) best = f;
    return best;
  }

  async update(initial) {
    if (this.busy || this.closed) return;
    this.busy = true;
    try { await this._update(initial); } catch (e) { console.error('[view]', e.message); } finally { this.busy = false; }
  }

  async _update(initial) {
    const hub = this.hub;
    // Older links pin a bare session id: turn it into the key of the right copy once that is known.
    if (this.pinSid && !hub.sessions.has(this.pinSid)) this.pinSid = hub.resolve(this.pinSid) || this.pinSid;
    const floor = this.pickFloor();
    if (!floor) { if (initial) this.send({ t: 'view', floor: null }); return; }
    if (this.knownFloor !== floor.fkey) {
      this.knownFloor = floor.fkey;
      this.fkey = floor.fkey;
      this.known = new Set(floor.sessions);
      initial = true;
    }
    const list = [...floor.sessions].map((id) => hub.sessions.get(id)).filter(Boolean)
      .sort((a, b) => (b.activeTs || b.mtime) - (a.activeTs || a.mtime));
    let primary = this.primary;
    let switched = false;
    if (this.mode === 'pin' && !hub.sessions.has(this.pinSid)) this.mode = 'follow';
    if (this.mode === 'pin') primary = this.pinSid;
    else {
      if (initial || !primary || !hub.sessions.has(primary)) primary = list[0] && list[0].id;
      // Only brand-new sessions (/clear, a fresh `claude`) pull the view along — not other terminals.
      const fresh = list.filter((s) => !this.known.has(s.id));
      for (const s of fresh) this.known.add(s.id);
      if (fresh.length && !initial) {
        const nf = fresh.sort((a, b) => (b.startTs || b.mtime) - (a.startTs || a.mtime))[0];
        if (nf.id !== primary) { primary = nf.id; switched = true; }
      }
    }
    if (!primary) return;
    const now = Date.now();
    const superseded = (s) => list.some((t) => t.id !== s.id && t.akey === s.akey && t.startTs && t.startTs > (s.activeTs || s.mtime) - 5000);
    const coworkers = this.coworkersOn
      ? list.filter((s) => s.id !== primary && now - (s.activeTs || s.mtime) < COWORKER_MS && !superseded(s)).slice(0, 3).map((s) => s.id)
      : [];
    const want = [primary, ...coworkers];
    if (primary !== this.primary || initial) {
      this.primary = primary;
      this.send({ t: 'view', floor: floor.fkey, num: floor.num, primary, mode: this.mode, switched });
    }
    for (const [sid, off] of this.shown) {
      if (!want.includes(sid)) { off(); this.shown.delete(sid); this.send({ t: 'drop', sid }); }
    }
    for (const sid of want) {
      if (this.shown.has(sid)) continue;
      let w;
      try { w = await hub.watch(sid); } catch { continue; }
      if (this.closed) return;
      const fn = (id, e) => this.send({ t: 'ev', sid: id, e });
      w.listeners.add(fn);
      this.shown.set(sid, () => w.listeners.delete(fn));
      const snap = w.model.snapshot();
      snap.log.sort((a, b) => a.ts - b.ts);
      this.send({ t: 'sess', sid, meta: hub.sessionMeta(sid), snap });
    }
    const roles = JSON.stringify({ t: 'roles', primary, order: want.filter((sid) => this.shown.has(sid)) });
    if (roles !== this.rolesMsg) { this.rolesMsg = roles; this.sendRaw(roles); }
  }

  close() {
    this.closed = true;
    for (const off of this.shown.values()) off();
    this.shown.clear();
  }
}

// ---- http -------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serveStatic(res, rel) {
  const p = path.normalize(path.join(PUBLIC, rel));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function localHostHeader(req) {
  const h = String(req.headers.host || '').replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

function cookieOf(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

// This PC: only localhost Host headers (blocks DNS rebinding). Other devices: the access key.
function gate(req, res, u) {
  if (isLoopback(req)) {
    if (localHostHeader(req)) return true;
    res.writeHead(403).end('forbidden host');
    return false;
  }
  if (!ACCESS_KEY) { res.writeHead(403).end('forbidden'); return false; }
  if (safeEqual(cookieOf(req, 'office_key'), ACCESS_KEY)) return true;
  const k = u.searchParams.get('key');
  if (k && safeEqual(k, ACCESS_KEY)) {
    res.writeHead(302, {
      'set-cookie': `office_key=${encodeURIComponent(ACCESS_KEY)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      location: u.pathname === '/index.html' ? '/' : u.pathname,
    });
    res.end();
    return false;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Office</title>
<body style="font-family:system-ui,'Apple SD Gothic Neo',sans-serif;background:#f4f7fc;display:grid;place-items:center;min-height:100vh;margin:0">
<form style="background:#fff;padding:24px;border-radius:18px;box-shadow:0 12px 40px rgba(30,64,130,.12);width:min(320px,86vw);display:grid;gap:12px">
<b style="font-size:17px">✳ Claude Office</b><span style="color:#64748b;font-size:13px">서버를 켠 터미널에 나온 접속 키를 넣어 주세요.</span>
<input name="key" autocomplete="off" autocapitalize="off" placeholder="접속 키" style="font-size:16px;padding:10px;border:1px solid #cbd5e1;border-radius:10px">
<button style="font-size:15px;padding:10px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-weight:700">들어가기</button></form></body>`);
    return false;
  }
  res.writeHead(401).end('unauthorized');
  return false;
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Browsers always send Origin on POST; it must be this very page.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try {
    const u = new URL(o);
    return u.host === req.headers.host && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 32 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

const bindings = new Map(); // session key -> tmux pane picked by the user in the UI

const whereOf = (s) => {
  const acct = hub.accounts.get(s.akey) || {};
  return `${s.src.remote ? s.src.label + ' ' : ''}${acct.label || ''} ${s.title || s.firstPrompt || s.sid.slice(0, 8)}`.trim();
};

// Close the claude a session is open in (its process exits; the log stays).
async function terminateSession(id) {
  const s = hub.sessions.get(hub.resolve(id));
  if (!s) throw new Error('세션을 찾을 수 없어요');
  await hub.scanProcs(s.src); // decide on fresh status files, not ones up to 3 s old
  const p = hub.procOf(s);
  if (!p) return { ok: true, already: true };
  if (!terminalEntry(p.entrypoint)) throw new Error('데스크톱 앱·IDE에서 연 세션은 그 앱에서 닫아 주세요');
  console.log(`[control] ⏏ 세션 종료 → ${whereOf(s)} (pid ${p.pid}${p.tmux ? `, tmux ${p.tmux.name || p.tmux.session}` : ''})`);
  const r = await s.src.call('kill', { configDir: hub.accounts.get(s.akey).configDir, pid: p.pid, sessionId: s.sid });
  await hub.scanProcs(s.src);
  hub.broadcastFloors();
  return r;
}

// Move a closed session's log (and its side files) to <configDir>/office-trash so Claude no longer lists it.
async function trashSessionById(id) {
  const s = hub.sessions.get(hub.resolve(id));
  if (!s) throw new Error('세션을 찾을 수 없어요');
  await hub.scanProcs(s.src);
  const p = hub.procOf(s);
  if (p) throw new Error('아직 실행 중이에요. 먼저 종료해 주세요');
  if (!terminalEntry(s.entrypoint)) throw new Error('데스크톱 앱·IDE 세션 기록은 그 앱에서 지워 주세요');
  console.log(`[control] 🗑 휴지통으로 → ${whereOf(s)}`);
  const r = await s.src.call('trash', {
    configDir: hub.accounts.get(s.akey).configDir, root: s.root, dirName: s.dirName, sessionId: s.sid, title: s.title || s.firstPrompt || '',
  });
  hub.forget(s.id);
  return r;
}

async function apiControl(body) {
  if (body.action === 'terminate' || body.action === 'trash') {
    const ids = (Array.isArray(body.sids) ? body.sids : [body.sid]).filter(Boolean).slice(0, 200);
    const results = [];
    for (const id of ids) {
      try {
        let r = {};
        if (body.action === 'terminate' || body.alsoClose) r = await terminateSession(id);
        if (body.action === 'trash') r = await trashSessionById(id);
        results.push({ sid: id, ...r, ok: r.ok !== false });
      } catch (e) { results.push({ sid: id, ok: false, error: String(e.message || e) }); }
    }
    return { ok: true, results };
  }
  if (body.action === 'restore') {
    const acct = hub.accounts.get(body.akey);
    const src = acct && sources.find((x) => x.id === acct.src);
    if (!src) throw new Error('계정을 찾을 수 없어요');
    console.log(`[control] ↩︎ 휴지통에서 되돌리기 → ${acct.label} ${body.entry}`);
    return src.call('restore', { configDir: acct.configDir, entry: body.entry });
  }
  const s = hub.sessions.get(hub.resolve(body.sid));
  if (!s) throw new Error('세션을 찾을 수 없어요');
  const acct = hub.accounts.get(s.akey) || {};
  const proc = hub.procOf(s);
  const ranked = rankPanes(await s.src.call('panes', {}), s, acct.configDir, proc && proc.tmux, hub.claimedPanes(s));
  if (body.action === 'panes') return { ...ranked, bound: bindings.get(s.id) || null };
  if (body.action === 'bind') {
    const p = ranked.panes.find((x) => x.id === body.pane && x.claude);
    if (body.pane && !p) throw new Error('claude가 도는 창만 고를 수 있어요');
    if (body.pane) bindings.set(s.id, body.pane); else bindings.delete(s.id);
    return { ok: true, bound: bindings.get(s.id) || null };
  }
  if (body.action !== 'send' && body.action !== 'interrupt') throw new Error('unknown action');
  const paneId = body.pane || ranked.exact || bindings.get(s.id) || (!ranked.ambiguous && ranked.suggested);
  if (!paneId) throw new Error('이 세션이 도는 tmux 창을 확실히 못 찾았어요. 목록에서 직접 골라 주세요.');
  // Only ever type into a pane that is running claude right now.
  const pane = ranked.panes.find((x) => x.id === paneId);
  if (!pane || !pane.claude) throw new Error('그 tmux 창에서 claude가 돌고 있지 않아요');
  const where = `${s.src.remote ? s.src.label + ' ' : ''}tmux ${pane.name} (${pane.id})`;
  if (body.action === 'interrupt') {
    console.log(`[control] ⏹ Esc → ${where}`);
    return { ...(await s.src.call('tmux', { pane: pane.id, key: 'Escape' })), pane: pane.id, name: pane.name };
  }
  const text = String(body.text || '').slice(0, 8000);
  if (!text.trim()) throw new Error('보낼 내용이 비어 있어요');
  console.log(`[control] 📨 → ${where}: ${text.slice(0, 80).replace(/\n/g, ' ')}`);
  return { ...(await s.src.call('tmux', { pane: pane.id, text })), pane: pane.id, name: pane.name };
}

const sources = [];
if (OPT.local) sources.push(new LocalSource({ extraRoots: OPT.roots.map((r) => splitLabel(r)[0]), onlyRoots: OPT.onlyRoots, allowControl: OPT.allowControl }));
for (const h of OPT.ssh) sources.push(new SshSource(h, { extraRoots: OPT.sshRoots.map((r) => splitLabel(r)[0]), python: OPT.python, allowControl: OPT.allowControl }));
if (!sources.length) { console.error('읽을 곳이 없습니다 (--no-local 이면 --ssh 를 지정하세요)'); process.exit(1); }

const hub = new Hub(sources);
hub.start();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!gate(req, res, u)) return;
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    const v = new View(hub, res, u.searchParams);
    hub.views.add(v);
    const ka = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); v.close(); hub.views.delete(v); });
    v.start();
    return;
  }
  if (u.pathname === '/api/config') {
    // Control stays on this PC: other devices (phones) get a view-only page.
    const local = isLoopback(req);
    json(res, 200, { control: OPT.allowControl && local, token: OPT.allowControl && local ? TOKEN : null, remote: !local, controlElsewhere: OPT.allowControl && !local });
    return;
  }
  if (u.pathname === '/api/control') {
    if (!OPT.allowControl) { json(res, 403, { error: '조종 기능이 꺼져 있어요. 서버를 --allow-control 옵션으로 켜 주세요.' }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
    if (!isLoopback(req)) { json(res, 403, { error: '조종은 서버를 켠 PC에서 연 화면에서만 할 수 있어요' }); return; }
    if (!sameOrigin(req) || !/^application\/json\b/.test(req.headers['content-type'] || '') || !safeEqual(req.headers['x-office-token'], TOKEN)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    readBody(req).then(apiControl).then((out) => json(res, 200, out)).catch((e) => json(res, 400, { error: String(e.message || e) }));
    return;
  }
  if (u.pathname === '/api/sessions') {
    // Read-only list for the session manager (closing / deleting goes through /api/control).
    hub.trashList().catch(() => []).then((trash) => json(res, 200, { now: Date.now(), sessions: hub.sessionList(), trash }));
    return;
  }
  if (u.pathname === '/api/panes') {
    // Read-only: which tmux pane is this session running in?
    const s = hub.sessions.get(hub.resolve(u.searchParams.get('sid')));
    if (!s) { json(res, 404, { error: '세션을 찾을 수 없어요' }); return; }
    const acct = hub.accounts.get(s.akey) || {};
    const proc = hub.procOf(s);
    s.src.call('panes', {})
      .then((r) => json(res, 200, rankPanes(r, s, acct.configDir, proc && proc.tmux, hub.claimedPanes(s))))
      .catch((e) => json(res, 200, { panes: [], error: String(e.message || e) }));
    return;
  }
  if (u.pathname === '/api/debug') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      floors: JSON.parse(hub.floorsMsg || '{}'),
      watchers: [...hub.watchers.values()].map((w) => ({ sid: w.sess.id, ready: w.ready, listeners: w.listeners.size, subs: w.subs.size, snap: w.ready ? w.model.snapshot() : null })),
      links: hub.broker.links.slice(-20),
      procs: Object.fromEntries(sources.map((src) => [src.id, Object.fromEntries(src.procs || [])])),
    }, null, 1));
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') return serveStatic(res, 'index.html');
  return serveStatic(res, u.pathname.slice(1));
});

server.listen(OPT.port, OPT.host, () => {
  const url = `http://localhost:${OPT.port}`;
  console.log(`\n🏢 Claude Office 영업 시작: ${url}`);
  console.log(`   읽는 곳: ${sources.map((s) => s.remote ? `ssh ${s.host}` : '이 PC').join(', ')}`);
  console.log(OPT.allowControl
    ? '   ⚠️  조종 켜짐: 화면에서 claude가 도는 tmux 창으로 메시지를 보내거나 멈추고, 세션을 종료하거나 휴지통(설정 폴더/office-trash)으로 옮길 수 있어요.\n'
    : '   조종 꺼짐 (읽기 전용). 켜려면 --allow-control\n');
  if (ACCESS_KEY) {
    const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal);
    const fam = (n) => String(n.family).replace('IPv', '');
    // 192.0.0.x is the IPv4 stand-in macOS uses on IPv6-only networks; other devices can't reach it.
    const v4 = nets.filter((n) => fam(n) === '4' && !n.address.startsWith('192.0.0.')).map((n) => n.address);
    const v6 = OPT.host === '::' ? nets.filter((n) => fam(n) === '6' && !/^fe80/i.test(n.address)).map((n) => `[${n.address}]`) : [];
    console.log('   📱 다른 기기(휴대폰)에서 보기 — 같은 네트워크에서 아래 주소를 여세요:');
    for (const ip of [...v4, ...v6]) console.log(`      http://${ip}:${OPT.port}/?key=${ACCESS_KEY}`);
    if (!v4.length && v6.length) console.log('      (이 네트워크는 IPv6 전용이라 IPv6 주소로만 열려요. 휴대폰도 같은 와이파이/핫스팟에 있어야 해요)');
    console.log(`      접속 키: ${ACCESS_KEY}   (이 키가 있으면 누구나 Claude 기록을 볼 수 있어요)`);
    if (OPT.allowControl) console.log('      조종은 이 PC에서 연 화면에서만 돼요. 휴대폰은 보기 전용이에요.');
    console.log('');
  }
  if (OPT.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `포트 ${OPT.port} 이미 사용 중입니다. --port 로 바꿔 보세요.` : e);
  process.exit(1);
});
