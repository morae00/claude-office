// Where session logs come from: this machine, or another one over SSH.
// Both expose the same small set of operations (see remote_agent.py): reading ones, plus typing into
// tmux and closing / deleting sessions, which only work with --allow-control.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { listPanes, listProcs, paneScreens, sendToPane, killSession, trashSession, restoreTrash, listTrash } from './control.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function normRoot(p) {
  p = p.replace(/^~(?=$|\/)/, os.homedir());
  if (path.basename(p.replace(/\/+$/, '')) !== 'projects' && fs.existsSync(path.join(p, 'projects'))) {
    p = path.join(p, 'projects');
  }
  return p;
}

async function readAccount(configDir) {
  const cands = [];
  if (path.basename(configDir) === '.claude') cands.push(path.join(path.dirname(configDir), '.claude.json'));
  cands.push(path.join(configDir, '.claude.json'));
  for (const c of cands) {
    try {
      const d = JSON.parse(await fsp.readFile(c, 'utf8'));
      const oa = d.oauthAccount || {};
      return { email: oa.emailAddress || '', name: oa.displayName || oa.fullName || '' };
    } catch {}
  }
  return { email: '', name: '' };
}

async function listConfigProjects(homeDir) {
  const out = [];
  let ents = [];
  try { ents = await fsp.readdir(homeDir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.name.startsWith('.claude')) continue;
    const p = path.join(homeDir, e.name, 'projects');
    try { if ((await fsp.stat(p)).isDirectory()) out.push(p); } catch {}
  }
  return out.sort();
}

export class LocalSource {
  constructor({ extraRoots = [], onlyRoots = false, allowControl = false } = {}) {
    this.id = 'local';
    this.onlyRoots = onlyRoots;
    this.allowControl = allowControl;
    this.home = os.homedir();
    this.label = os.hostname().replace(/\.local$/, '');
    this.remote = false;
    this.extraRoots = extraRoots;
    this.status = 'ok';
    this.error = '';
  }
  start() {}
  async call(op, args = {}) {
    return this['op_' + op](args);
  }

  async op_roots({ extra = [] }) {
    const cands = [];
    for (const r of [...this.extraRoots, ...extra]) cands.push(normRoot(r));
    if (this.onlyRoots) return this.rootsFrom(cands);
    if (process.env.CLAUDE_CONFIG_DIR) cands.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
    cands.push(...(await listConfigProjects(os.homedir())));
    for (const base of ['/home', '/Users']) {
      let users = [];
      try { users = await fsp.readdir(base); } catch {}
      for (const u of users) {
        const h = path.join(base, u);
        if (h === os.homedir()) continue;
        cands.push(...(await listConfigProjects(h)));
      }
    }
    return this.rootsFrom(cands);
  }

  async rootsFrom(cands) {
    const out = [];
    const seen = new Set();
    for (const p of cands) {
      try {
        const rp = await fsp.realpath(p);
        if (seen.has(rp)) continue;
        await fsp.access(p, fs.constants.R_OK | fs.constants.X_OK);
        if (!(await fsp.stat(p)).isDirectory()) continue;
        seen.add(rp);
        const cfg = path.dirname(p.replace(/\/+$/, ''));
        out.push({ root: p, configDir: cfg, account: await readAccount(cfg) });
      } catch {}
    }
    return out;
  }

  async op_scan({ roots = [] }) {
    const res = [];
    for (const root of roots) {
      const dirs = [];
      let ents = [];
      try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch {}
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const dp = path.join(root, e.name);
        try {
          const files = [];
          for (const f of await fsp.readdir(dp, { withFileTypes: true })) {
            if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
            const st = await fsp.stat(path.join(dp, f.name));
            files.push([f.name, st.size, st.mtimeMs]);
          }
          const dst = await fsp.stat(dp);
          dirs.push([e.name, dst.mtimeMs, files]);
        } catch {}
      }
      res.push({ root, dirs });
    }
    return res;
  }

  async op_poll({ files = [] }) {
    const out = [];
    await Promise.all(files.map(async (req, i) => {
      let st;
      try { st = await fsp.stat(req.path); } catch { out[i] = { path: req.path, missing: true }; return; }
      const item = { path: req.path, size: st.size, mtime: st.mtimeMs };
      const off = req.offset || 0;
      if (st.size > off) {
        const len = Math.min(req.max || 4 << 20, st.size - off);
        const fh = await fsp.open(req.path, 'r');
        try {
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, off);
          item.start = off;
          item.data = buf.subarray(0, bytesRead);
        } finally { await fh.close(); }
      }
      out[i] = item;
    }));
    return out;
  }

  async op_tail({ path: p, bytes = 2 << 20 }) {
    const st = await fsp.stat(p);
    const start = Math.max(0, st.size - bytes);
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return { size: st.size, mtime: st.mtimeMs, start, data: buf.subarray(0, bytesRead) };
    } finally { await fh.close(); }
  }

  async op_subs({ dirs = [] }) {
    const out = {};
    for (const d of dirs) {
      const lst = [];
      const scanDir = async (dir) => {
        let ents = [];
        try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.isFile() && /^agent-.*\.jsonl$/.test(e.name)) {
            try {
              const p = path.join(dir, e.name);
              const st = await fsp.stat(p);
              lst.push([p, st.size, st.mtimeMs]);
            } catch {}
          }
        }
      };
      await scanDir(path.join(d, 'subagents'));
      let wfs = [];
      try { wfs = await fsp.readdir(path.join(d, 'subagents', 'workflows')); } catch {}
      for (const w of wfs) await scanDir(path.join(d, 'subagents', 'workflows', w));
      out[d] = lst;
    }
    return out;
  }

  async op_panes() {
    return listPanes();
  }

  async op_procs(args) {
    return listProcs(args);
  }

  async op_screens(args) {
    return paneScreens(args);
  }

  async op_tmux(args) {
    this.needControl();
    return sendToPane(args);
  }

  async op_kill(args) {
    this.needControl();
    return killSession(args);
  }

  async op_trash(args) {
    this.needControl();
    return trashSession(args);
  }

  async op_restore(args) {
    this.needControl();
    return restoreTrash(args);
  }

  async op_trash_list(args) {
    return listTrash(args);
  }

  needControl() {
    if (!this.allowControl) throw new Error('control disabled (start the server with --allow-control)');
  }

  async op_texts({ paths = [], max = 65536 }) {
    const out = {};
    await Promise.all(paths.map(async (p) => {
      try {
        const fh = await fsp.open(p, 'r');
        try {
          const buf = Buffer.alloc(max);
          const { bytesRead } = await fh.read(buf, 0, max, 0);
          out[p] = buf.subarray(0, bytesRead).toString('utf8');
        } finally { await fh.close(); }
      } catch { out[p] = null; }
    }));
    return out;
  }
}

// Same operations, answered by remote_agent.py over one long-lived ssh connection.
export class SshSource {
  constructor(host, { extraRoots = [], python = 'python3', allowControl = false } = {}) {
    this.id = 'ssh:' + host;
    this.host = host;
    this.label = host;
    this.remote = true;
    this.extraRoots = extraRoots;
    this.python = python;
    this.allowControl = allowControl;
    this.home = '';
    this.status = 'connecting';
    this.error = '';
    this.proc = null;
    this.pending = new Map();
    this.seq = 1;
    this.readyWaiters = [];
    this.ready = false;
    this.stopped = false;
  }

  start() {
    const code = fs.readFileSync(path.join(HERE, 'remote_agent.py'));
    const b64 = code.toString('base64');
    const remoteCmd = `${this.python} -u -c 'import sys,base64;exec(base64.b64decode(sys.argv[1]).decode())' ${b64} ${this.allowControl ? 1 : 0}`;
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=10', this.host, remoteCmd];
    this.status = 'connecting';
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) {
        this.ready = true;
        this.status = 'ok';
        this.error = '';
        this.remoteHost = msg.result && msg.result.host;
        this.home = (msg.result && msg.result.home) || '';
        if (this.remoteHost) this.label = this.host;
        this.readyWaiters.splice(0).forEach((w) => w.resolve());
        console.log(`[ssh:${this.host}] connected (${this.remoteHost || '?'})`);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    });
    proc.on('exit', (code) => {
      this.ready = false;
      this.status = 'error';
      this.error = (stderr.trim().split('\n').pop() || `ssh exited (${code})`).slice(0, 200);
      console.log(`[ssh:${this.host}] disconnected: ${this.error}`);
      const err = new Error('ssh disconnected');
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      this.readyWaiters.splice(0).forEach((w) => w.reject(err));
      if (!this.stopped) setTimeout(() => this.start(), 5000);
    });
    proc.stdin.on('error', () => {});
  }

  waitReady() {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  async call(op, args = {}) {
    await this.waitReady();
    if (op === 'roots') args = { ...args, extra: [...this.extraRoots, ...(args.extra || [])] };
    const id = this.seq++;
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ssh request timeout: ' + op));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
    if (op === 'poll') {
      for (const it of res) if (it && typeof it.data === 'string') it.data = Buffer.from(it.data, 'base64');
    } else if (op === 'tail' && typeof res.data === 'string') {
      res.data = Buffer.from(res.data, 'base64');
    }
    return res;
  }
}
