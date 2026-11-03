// Find which tmux pane each Claude session is running in, and — only when the server runs with
// --allow-control — type a message into it, press Escape, close a session or move it to the trash.
// remote_agent.py has the same operations for SSH hosts.
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
// status ("busy" / "idle" / "waiting" + waitingFor) and, inside tmux, its pane ("master:@0.%0" =
// session:window.pane). That is the exact session <-> pane mapping. Only <pid>.json is read, never the
// <pid>.<hash>.key files next to it.
const PROC_KEYS = ['sessionId', 'pid', 'tmux', 'name', 'status', 'waitingFor', 'statusUpdatedAt', 'cwd', 'entrypoint', 'procStart'];

async function pidAlive(pid, procStart) {
  if (!(pid > 0)) return false;
  try {
    // Linux: field 22 of /proc/<pid>/stat is the start time Claude recorded, so a reused pid doesn't count.
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (f[0] === 'Z') return false; // exited, not yet reaped
    return !/^\d+$/.test(String(procStart || '')) || f[19] === String(procStart);
  } catch {}
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function readProcFile(configDir, pid) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(configDir, 'sessions', `${pid}.json`), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

export async function listProcs({ dirs = [] }) {
  const procs = [];
  const seen = []; // config dirs that have a sessions/ folder: there, "no file" means "not running"
  for (const d of dirs) {
    const sd = path.join(d, 'sessions');
    let names = [];
    try { names = await fsp.readdir(sd); } catch { continue; }
    seen.push(d);
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
  return { procs, panes, dirs: seen };
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

// The bottom of each pane's screen (read-only). Asked only for the exact pane of a claude whose status
// file says "waiting": some dialogs (choices, permission prompts) are on screen before they reach the log.
export async function paneScreens({ panes = [] }) {
  const out = {};
  for (const pane of panes.slice(0, 20)) {
    if (!PANE_ID.test(String(pane))) continue;
    const r = await run('tmux', ['capture-pane', '-p', '-J', '-t', pane]);
    if (!r.ok) continue;
    out[pane] = r.out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-24).map((l) => l.slice(0, 200)).join('\n');
  }
  return out;
}

// ---- closing and deleting sessions (--allow-control only) -------------------------------------
// Terminal sessions only: the desktop app and IDE extensions manage their own sessions.
export const terminalEntry = (ep) => !ep || ep === 'cli';
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^(?!\.\.?$)[^/\\\0]+$/;
export const TRASH_DIR = 'office-trash';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function procCommand(pid) {
  try { return (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ').trim(); } catch {}
  return (await run('ps', ['-ww', '-o', 'command=', '-p', String(pid)])).out.trim();
}

async function liveProc(configDir, sessionId) {
  const { procs } = await listProcs({ dirs: [configDir] });
  return procs.find((p) => p.sessionId === sessionId) || null;
}

// Close a session's claude for good: SIGTERM (Claude Code shuts down cleanly and removes its
// sessions/<pid>.json), then SIGKILL if it is still there after a few seconds. Only a pid that
// <configDir>/sessions/<pid>.json ties to this very session, that is alive and that runs claude.
export async function killSession({ configDir, pid, sessionId }) {
  pid = Number(pid);
  if (!(pid > 0) || !SID_RE.test(String(sessionId || ''))) throw new Error('bad session');
  const j = await readProcFile(configDir, pid);
  if (!j || j.sessionId !== sessionId) throw new Error('이 세션의 claude 프로세스를 찾지 못했어요 (이미 끝났거나 다른 세션으로 바뀌었어요)');
  if (!terminalEntry(j.entrypoint)) throw new Error('터미널에서 연 세션만 닫을 수 있어요');
  if (!(await pidAlive(pid, j.procStart))) return { ok: true, already: true };
  if (!CLAUDE_RE.test(await procCommand(pid))) throw new Error('claude 프로세스가 아니라서 건드리지 않았어요');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if (!(await pidAlive(pid, j.procStart))) return { ok: true, how: 'term' };
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await sleep(400);
  return { ok: !(await pidAlive(pid, j.procStart)), how: 'kill' };
}

// "Delete" = move the session out of Claude's reach into <configDir>/office-trash/<stamp>_<id>/, keeping the
// same relative paths so it can be put back. Claude no longer lists it (/resume, `claude -r`).
export async function trashSession({ configDir, root, dirName, sessionId, title = '' }) {
  if (!SID_RE.test(String(sessionId || '')) || !NAME_RE.test(String(dirName || ''))) throw new Error('bad session');
  if (path.resolve(root) !== path.resolve(configDir, 'projects')) throw new Error('이 위치의 기록은 지울 수 없어요 (설정 폴더/projects 아래만)');
  if (await liveProc(configDir, sessionId)) throw new Error('아직 실행 중이에요. 먼저 종료해 주세요');
  const rels = [`projects/${dirName}/${sessionId}.jsonl`, `projects/${dirName}/${sessionId}`, `file-history/${sessionId}`, `session-env/${sessionId}`, `debug/${sessionId}.txt`];
  try { for (const n of await fsp.readdir(path.join(configDir, 'todos'))) if (n.startsWith(sessionId) && n.endsWith('.json')) rels.push(`todos/${n}`); } catch {}
  const main = path.join(configDir, rels[0]);
  try { await fsp.access(main); } catch { throw new Error('기록 파일이 없어요 (이미 지워졌을 수 있어요)'); }
  const entry = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}_${sessionId}`;
  const box = path.join(configDir, TRASH_DIR, entry);
  const items = [];
  try {
    for (const rel of rels) {
      try { await fsp.lstat(path.join(configDir, rel)); } catch { continue; }
      await fsp.mkdir(path.dirname(path.join(box, rel)), { recursive: true });
      await fsp.rename(path.join(configDir, rel), path.join(box, rel));
      items.push(rel);
    }
  } finally {
    if (items.length) await fsp.writeFile(path.join(box, 'manifest.json'), JSON.stringify({ sessionId, dirName, title, deletedAt: Date.now(), items }, null, 1));
  }
  return { ok: true, entry, items: items.length };
}

export async function listTrash({ dirs = [] }) {
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = await fsp.readdir(path.join(d, TRASH_DIR)); } catch { continue; }
    for (const n of names) {
      try {
        const m = JSON.parse(await fsp.readFile(path.join(d, TRASH_DIR, n, 'manifest.json'), 'utf8'));
        out.push({ configDir: d, entry: n, sessionId: m.sessionId, dirName: m.dirName, title: m.title || '', deletedAt: m.deletedAt || 0, items: (m.items || []).length });
      } catch {}
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt).slice(0, 200);
}

export async function restoreTrash({ configDir, entry }) {
  if (!NAME_RE.test(String(entry || ''))) throw new Error('bad entry');
  const box = path.join(configDir, TRASH_DIR, entry);
  const m = JSON.parse(await fsp.readFile(path.join(box, 'manifest.json'), 'utf8'));
  const items = (m.items || []).filter((rel) => typeof rel === 'string' && !rel.split('/').includes('..'));
  for (const rel of items) {
    let exists = false;
    try { await fsp.lstat(path.join(configDir, rel)); exists = true; } catch {}
    if (exists) throw new Error(`같은 자리에 이미 파일이 있어요: ${rel}`);
  }
  for (const rel of items) {
    await fsp.mkdir(path.dirname(path.join(configDir, rel)), { recursive: true });
    await fsp.rename(path.join(box, rel), path.join(configDir, rel));
  }
  await fsp.unlink(path.join(box, 'manifest.json'));
  await removeEmptyDirs(box);
  return { ok: true, sessionId: m.sessionId };
}

// Only empty folders: everything inside was moved back already.
async function removeEmptyDirs(dir) {
  let ents = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name));
  try { await fsp.rmdir(dir); } catch {}
}
