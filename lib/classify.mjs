// Tool name + input  ->  which room Claude walks to, and the little label over its head.
//
// Rooms: library 📚 자료실, dev 💻 개발실, server 🗄️ 서버실, web 🌐 정보검색실,
//        meeting 🗒️ 회의실, desk 🤖 Claude 자리, user 🧑‍💻 내 자리

export const trunc = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const base = (p) => {
  if (!p) return '';
  const s = String(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1) || s;
};

const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return trunc(u, 30); }
};

function shortCmd(cmd) {
  let c = String(cmd || '').trim().split('\n')[0];
  c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
  return trunc(c, 40);
}

export function classifyTool(name, input = {}) {
  input = input || {};
  const n = name || '';
  const r = (room, label, kind = 'tool') => ({ room, label, kind });

  switch (n) {
    case 'Read': return r('library', `📖 ${base(input.file_path)}`);
    case 'NotebookRead': return r('library', `📖 ${base(input.notebook_path)}`);
    case 'Grep': return r('library', `🔍 ${trunc(input.pattern, 28)}`);
    case 'Glob': return r('library', `🗂️ ${trunc(input.pattern, 28)}`);
    case 'LS': return r('library', `🗂️ ${base(input.path)}`);
    case 'ToolSearch': return r('library', '🧰 도구 찾는 중');
    case 'Skill': return r('library', `📘 스킬 ${trunc(input.skill || input.name, 24)}`);

    case 'Edit':
    case 'MultiEdit': return r('dev', `✏️ ${base(input.file_path)}`);
    case 'Write': return r('dev', `📝 ${base(input.file_path)}`);
    case 'NotebookEdit': return r('dev', `📓 ${base(input.notebook_path)}`);

    case 'Bash':
    case 'PowerShell': {
      const cmd = String(input.command || '');
      const sends = parseTmuxSends(cmd);
      if (sends.length) {
        const tgt = sends.map((s) => s.target || '?').join(', ');
        return { room: 'desk', label: `📨 tmux → ${trunc(tgt, 20)}`, kind: 'tmux', sends };
      }
      if (/(^|[\s;&|(])git\s/.test(cmd) || /^git\b/.test(cmd.trim())) {
        return { room: 'server', label: `🌿 ${shortCmd(cmd)}`, kind: 'tool', git: true };
      }
      return r('server', `$ ${shortCmd(cmd)}`);
    }
    case 'BashOutput':
    case 'TaskOutput': return r('server', '📟 출력 확인');
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop': return r('server', '🛑 작업 중지');
    case 'Monitor': return r('server', `📡 ${trunc(input.description || '모니터링', 24)}`);

    case 'WebSearch': return r('web', `🔎 ${trunc(input.query, 28)}`);
    case 'WebFetch': return r('web', `🌐 ${hostOf(input.url)}`);
    case 'Artifact':
    case 'ArtifactData':
    case 'ArtifactComments': return r('web', `🖼️ ${n}`);

    case 'TodoWrite': return r('meeting', '🗒️ 할 일 정리', 'todo');
    case 'TaskCreate': return r('meeting', `🗒️ ${trunc(input.subject || input.title || '할 일 추가', 24)}`, 'task');
    case 'TaskUpdate': return r('meeting', `✅ 할 일 #${input.taskId ?? ''} ${input.status || ''}`.trim(), 'task');
    case 'TaskList':
    case 'TaskGet': return r('meeting', '🗒️ 할 일 확인');
    case 'EnterPlanMode': return r('meeting', '🗒️ 계획 세우는 중');
    case 'ExitPlanMode': return r('user', '🙋 계획 승인 요청', 'plan');
    case 'Workflow': return r('meeting', '🧩 워크플로 설계', 'workflow');
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup': return r('meeting', '⏰ 일정 예약');

    case 'AskUserQuestion': return r('user', '❓ 질문하러 감', 'ask');
    case 'SendUserFile': return r('user', '📎 파일 전달', 'deliver');

    case 'Agent':
    case 'Task': return r('desk', `📞 ${input.subagent_type || 'general-purpose'} 호출`, 'agent');
    case 'SendMessage': return r('desk', `📨 → ${trunc(input.to, 20)}`, 'send');
    case 'ListAgents': return r('desk', '👥 동료 확인');
    case 'ReadNotifications': return r('desk', '🔔 알림 확인');
    case 'SubagentHandback': return r('desk', '📋 결과 보고', 'handback');
  }

  if (n.startsWith('mcp__')) {
    const parts = n.split('__');
    let server = parts[1] || 'mcp';
    const tool = parts.slice(2).join('__');
    if (/session_mgmt$/.test(server) && /send_message/.test(tool)) {
      return r('desk', `📨 → ${trunc(input.to || input.session_id || input.target || '세션', 20)}`, 'send');
    }
    if (/ccd_session$/.test(server) && tool === 'mark_chapter') return r('meeting', `📑 ${trunc(input.title, 22)}`);
    if (/ccd_session$/.test(server)) return r('desk', '🧑‍🤝‍🧑 새 세션 준비');
    if (/^ccd_/.test(server)) return r('desk', `🔧 ${tool}`);
    if (/browser|chrome/i.test(server)) {
      return r('web', `🖱️ 브라우저 ${trunc(input.action || tool, 18)}`);
    }
    if (/^[0-9a-f-]{20,}$/.test(server)) server = 'mcp';
    return r('web', `🔌 ${trunc(server, 14)}·${trunc(tool, 16)}`);
  }
  return r('desk', `🔧 ${trunc(n, 24)}`);
}

// ---------------------------------------------------------------------------
// Messages one Claude sends to another through tmux (`tmux send-keys -t pane "..." Enter`).

function shellTokens(src) {
  const toks = [];
  let i = 0;
  let cur = null;
  const push = () => { if (cur !== null) { toks.push({ w: cur }); cur = null; } };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] === '\n') { i += 2; continue; }
      cur = (cur ?? '') + src[i + 1]; i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      cur = (cur ?? '') + src.slice(i + 1, end); i = end + 1; continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2; let s = '';
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2;
        } else { s += src[j++]; }
      }
      cur = (cur ?? '') + s; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let s = ''; let depth = 0;
      while (j < src.length) {
        const d = src[j];
        if (depth === 0 && d === '"') break;
        if (d === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) { s += src[j + 1]; j += 2; continue; }
        if (d === '$' && src[j + 1] === '(') { depth++; s += '$('; j += 2; continue; }
        if (d === ')' && depth > 0) depth--;
        s += d; j++;
      }
      cur = (cur ?? '') + s; i = j + 1; continue;
    }
    if (c === ' ' || c === '\t') { push(); i++; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      push();
      let op = c;
      if ((c === '&' || c === '|') && src[i + 1] === c) { op += c; i++; }
      toks.push({ op }); i++; continue;
    }
    cur = (cur ?? '') + c; i++;
  }
  push();
  return toks;
}

const KEY_NAMES = /^(Enter|C-m|C-j|KPEnter|Escape|C-c|C-u|C-l|Tab|BSpace|Up|Down|Left|Right|Home|End)$/i;

function unwrapHeredoc(w) {
  const m = /^\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\)$/.exec(w);
  return m ? m[2] : w;
}

export function parseTmuxSends(cmd) {
  if (!/\btmux\b/.test(cmd) || !/(send-keys|send|set-buffer|paste-buffer)\b/.test(cmd)) return [];
  const toks = shellTokens(cmd);
  const segs = [[]];
  for (const t of toks) {
    if (t.op) segs.push([]); else segs[segs.length - 1].push(t.w);
  }
  const out = [];
  let buffer = null;
  for (const seg of segs) {
    let k = seg.findIndex((w) => w === 'tmux' || /\/tmux$/.test(w));
    if (k < 0) continue;
    k++;
    while (k < seg.length && seg[k].startsWith('-')) k += ['-L', '-S', '-f'].includes(seg[k]) ? 2 : 1;
    const sub = seg[k];
    if (sub === 'send-keys' || sub === 'send') {
      let target = '';
      const words = [];
      for (let j = k + 1; j < seg.length; j++) {
        const w = seg[j];
        if (w === '-t') { target = seg[++j] || ''; continue; }
        if (w.startsWith('-t') && w.length > 2) { target = w.slice(2); continue; }
        if (w === '-N') { j++; continue; }
        if (/^-[lHMRXK]+$/.test(w)) continue;
        if (KEY_NAMES.test(w)) continue;
        words.push(w === 'Space' ? ' ' : unwrapHeredoc(w));
      }
      const text = words.join('').trim();
      if (text) out.push({ target, text });
    } else if (sub === 'set-buffer') {
      const rest = seg.slice(k + 1).filter((w) => !w.startsWith('-'));
      if (rest.length) buffer = unwrapHeredoc(rest[rest.length - 1]);
    } else if (sub === 'paste-buffer' && buffer) {
      const ti = seg.indexOf('-t');
      out.push({ target: ti >= 0 ? seg[ti + 1] || '' : '', text: buffer.trim() });
      buffer = null;
    }
  }
  return out;
}
