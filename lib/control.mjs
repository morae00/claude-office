// Find which tmux pane each Claude session is running in, and — only when the server runs with
// --allow-control — type a message into it or press Escape. remote_agent.py has the same
// 'procs' / 'panes' / 'tmux' operations for SSH hosts.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 6000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

const SEP = '|~|';
const CLAUDE_RE = /(^|\/)claude(\s|$)|claude-code\/cli\.js|\/claude\/versions\//;

async function configDirOf(pid) {
  try {
    const env = await fsp.readFile(`/proc/${pid}/environ`, 'utf8');
    const m = /(?:^|\0)CLAUDE_CONFIG_DIR=([^\0]*)/.exec(env);
    return m ? m[1] : null;
  } catch {}
  const r = await run('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]);
  const m = /\bCLAUDE_CONFIG_DIR=(\S+)/.exec(r.out);
  return m ? m[1] : null;
}

// Claude Code keeps <CLAUDE_CONFIG_DIR>/sessions/<pid>.json for every running claude: session id, name,
// status and, inside tmux, its pane ("master:@0.%0" = session:window.pane). That is the exact
// session <-> pane mapping. Only <pid>.json is read, never the <pid>.<hash>.key files next to it.
const PROC_KEYS = ['sessionId', 'pid', 'tmux', 'name', 'status', 'cwd'];

async function pidAlive(pid, procStart) {
  if (!(pid > 0)) return false;
  try {
    // Linux: field 22 of /proc/<pid>/stat is the start time Claude recorded, so a reused pid doesn't count.
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return !/^\d+$/.test(String(procStart || '')) || f[19] === String(procStart);
  } catch {}
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function listProcs({ dirs = [] }) {
  const procs = [];
  for (const d of dirs) {
    const sd = path.join(d, 'sessions');
    let names = [];
    try { names = await fsp.readdir(sd); } catch { continue; }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      let j;
      try { j = JSON.parse(await fsp.readFile(path.join(sd, n), 'utf8')); } catch { continue; }
      if (!j || typeof j !== 'object' || !j.sessionId) continue;
      const pid = Number(j.pid) || Number(n.slice(0, -5));
      if (!(await pidAlive(pid, j.procStart))) continue;
      const p = { configDir: d };
      for (const k of PROC_KEYS) p[k] = j[k] ?? null;
      p.pid = pid;
      procs.push(p);
    }
  }
  // Pane id (%0) -> "session:window.pane" for display.
  const panes = {};
  if (procs.some((p) => p.tmux)) {
    const r = await run('tmux', ['list-panes', '-a', '-F', ['#{pane_id}', '#{session_name}:#{window_index}.#{pane_index}'].join(SEP)]);
    for (const l of r.out.split('\n')) { const [id, name] = l.split(SEP); if (name) panes[id] = name; }
  }
  return { procs, panes };
}

export async function listPanes() {
  // tmux escapes control characters (tabs) in -F output, so use a printable separator.
  const fmt = ['#{pane_id}', '#{pane_pid}', '#{pane_current_path}', '#{session_name}:#{window_index}.#{pane_index}', '#{pane_current_command}', '#{pane_title}'].join(SEP);
  const r = await run('tmux', ['list-panes', '-a', '-F', fmt]);
  if (!r.ok) return { panes: [], home: os.homedir(), error: r.err.trim().slice(0, 200) || 'tmux error' };
  const panes = r.out.trim().split('\n').filter(Boolean).map((l) => {
    const [id, pid, path, name, cmd, title] = l.split(SEP);
    return { id, pid: Number(pid) || 0, path, name, cmd, title };
  });
  const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,command=']);
  const procs = new Map();
  const kids = new Map();
  for (const line of ps.out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const p = { pid: +m[1], ppid: +m[2], start: Date.parse(m[3].replace(/\s+/g, ' ')) || 0, cmd: m[4] };
    procs.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  for (const pane of panes) {
    const queue = [pane.pid];
    const seen = new Set();
    let found = null;
    while (queue.length && !found && seen.size < 200) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = procs.get(pid);
      if (p && CLAUDE_RE.test(p.cmd)) { found = p; break; }
      queue.push(...(kids.get(pid) || []));
    }
    if (found) {
      pane.claude = { pid: found.pid, start: found.start };
      pane.configDir = await configDirOf(found.pid);
    }
  }
  return { panes, home: os.homedir() };
}

// Rank panes for a session. When the session's sessions/<pid>.json names its pane (`exact`) and claude
// still runs there, that pane wins outright. Otherwise guess: claude running there, same folder,
// same account (CLAUDE_CONFIG_DIR), and a claude process that started before the session did —
// skipping panes that other sessions' files already claim (`claimed`: pane id -> that session's name).
export function rankPanes(res, sess, configDir, exact, claimed = new Map()) {
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  const home = res.home || '';
  const defCfg = norm(home + '/.claude');
  const exactId = exact && exact.pane && (res.panes || []).some((p) => p.id === exact.pane && p.claude) ? exact.pane : null;
  const panes = (res.panes || []).map((p) => {
    if (p.id === exactId) return { ...p, exact: true, score: 100, why: '세션 파일과 정확히 일치' };
    if (claimed.has(p.id)) return { ...p, score: 0, why: `다른 세션이 쓰는 창${claimed.get(p.id) ? ` (${claimed.get(p.id)})` : ''}` };
    let score = 0;
    const why = [];
    if (p.claude) { score += 1; why.push('claude 실행 중'); }
    if (p.claude && sess.cwd && norm(p.path) === norm(sess.cwd)) { score += 4; why.push('같은 폴더'); }
    if (p.claude && configDir && norm(p.configDir || defCfg) === norm(configDir)) { score += 2; why.push('같은 계정'); }
    if (p.claude && sess.startTs && p.claude.start && p.claude.start <= sess.startTs + 10000) { score += 1; why.push('세션 전에 시작'); }
    return { ...p, score, why: why.join(' · ') };
  }).sort((a, b) => b.score - a.score || ((b.claude && b.claude.start) || 0) - ((a.claude && a.claude.start) || 0));
  if (exactId) return { panes, suggested: exactId, exact: exactId, ambiguous: false, error: res.error || null };
  const best = panes[0] && panes[0].score >= 5 ? panes[0] : null;
  const ambiguous = !!(best && panes[1] && panes[1].score === best.score);
  return { panes, suggested: best ? best.id : null, exact: null, ambiguous, error: res.error || null };
}

const PANE_ID = /^%\d+$/;

// Type `text` into a pane and press Enter, or press a single key (Escape). Arguments go straight to
// tmux (no shell), and the caller has already checked that the pane is running claude.
export async function sendToPane({ pane, text, key }) {
  if (!PANE_ID.test(String(pane || ''))) throw new Error('bad pane id');
  if (key) {
    if (key !== 'Escape') throw new Error('only Escape is allowed');
    const r = await run('tmux', ['send-keys', '-t', pane, 'Escape']);
    return { ok: r.ok, error: r.err.trim() };
  }
  let r;
  if (String(text).includes('\n')) {
    // Multi-line text goes in as one bracketed paste so it isn't submitted line by line.
    r = await run('tmux', ['load-buffer', '-b', 'claude-office', '-'], text);
    if (r.ok) r = await run('tmux', ['paste-buffer', '-p', '-d', '-b', 'claude-office', '-t', pane]);
  } else {
    r = await run('tmux', ['send-keys', '-t', pane, '-l', text]);
  }
  if (!r.ok) return { ok: false, error: r.err.trim() };
  await new Promise((res) => setTimeout(res, 150));
  r = await run('tmux', ['send-keys', '-t', pane, 'Enter']);
  return { ok: r.ok, error: r.err.trim() };
}
