// One place that decides "is this agent working, stuck, done…" for the office, the monitor and alerts.
import { S, nowS, esc } from './state.js';

export const STATUS = {
  working: { label: '일하는 중', icon: '🟢', cls: 'ok' },
  thinking: { label: '생각 중', icon: '💭', cls: 'ok' },
  arriving: { label: '출근 중', icon: '🛗', cls: 'ok' },
  asking: { label: '질문 대기', icon: '❓', cls: 'warn' },
  stale: { label: '멈춤', icon: '💤', cls: 'warn' },
  reporting: { label: '보고 중', icon: '📋', cls: 'ok' },
  done: { label: '퇴근', icon: '✅', cls: 'muted' },
  failed: { label: '실패', icon: '❌', cls: 'bad' },
  lost: { label: '연락 끊김', icon: '👻', cls: 'muted' },
  idle: { label: '대기', icon: '☕', cls: 'muted' },
  sleeping: { label: '졸음', icon: '😴', cls: 'muted' },
};

// entry: agent state ({status, result, act, lastTs}) or session-ish ({busy, act, lastTs}).
export function statusOf(e, kind, staleMs) {
  const idle = nowS() - (e.lastTs || 0);
  if (kind === 'agent') {
    if (e.status === 'working') {
      if (idle > staleMs) return 'stale';
      if (e.act === 'think') return 'thinking';
      if (e.act === 'arrive') return 'arriving';
      return 'working';
    }
    if (e.status === 'reporting' && nowS() - (e.doneAt || e.lastTs || 0) < 20000) return 'reporting';
    if (e.result === 'fail') return 'failed';
    if (e.result === 'lost') return 'lost';
    return 'done';
  }
  if (e.act === 'ask') return 'asking';
  if (e.busy) {
    if (idle > staleMs) return 'stale';
    return e.act === 'think' ? 'thinking' : 'working';
  }
  return idle > 10 * 60 * 1000 ? 'sleeping' : 'idle';
}

export function agentState(actor) {
  const s = S.sessions.get(actor.sid);
  return s && actor.agentKey ? s.agents.get(actor.agentKey) : null;
}

export function sessionEntry(s) {
  return { busy: s.busy, act: s.claude && s.claude.act, lastTs: s.lastTs };
}

// Why a session is waiting (server: Hub.attentionOf), for every floor, account and host.
// `me`: it needs you. `peer` only waits for another session's answer.
export const WAIT = {
  permission: { icon: '🔐', label: '권한 승인 대기', me: true },
  question: { icon: '❓', label: '선택 질문', me: true },
  plan: { icon: '🗒️', label: '계획 승인 대기', me: true },
  dialog: { icon: '🪟', label: '창 응답 대기', me: true },
  reply: { icon: '💬', label: '내 답장 대기', me: true },
  peer: { icon: '📨', label: '다른 세션 답 대기', me: false },
};

export function waitOf(sid) {
  for (const f of S.floors) {
    const x = f.sessions.find((s) => s.sid === sid);
    if (x) return x.wait && WAIT[x.wait.kind] ? x.wait : null;
  }
  return null;
}

// [{ s: floor-guide entry, f: floor, w: wait }], the ones that need you first, longest waiting first.
export function waitList() {
  const out = [];
  for (const f of S.floors) for (const s of f.sessions) if (s.wait && WAIT[s.wait.kind]) out.push({ s, f, w: s.wait });
  return out.sort((a, b) => (WAIT[b.w.kind].me - WAIT[a.w.kind].me) || (a.w.since || 0) - (b.w.since || 0));
}

const tailText = (t) => { t = String(t || ''); return t.length > 500 ? '…' + t.slice(-500) : t; };

export function waitBodyHtml(w) {
  const screen = w.screen
    ? `<details class="screen" ${w.kind === 'dialog' ? 'open' : ''}><summary>🖥 지금 터미널 화면</summary><pre>${esc(w.screen)}</pre></details>`
    : '';
  return waitText(w) + screen;
}

function waitText(w) {
  switch (w.kind) {
    case 'question':
      return (w.questions || []).map((q) => `<div class="wq">${q.header ? `<span class="tag">${esc(q.header)}</span> ` : ''}<b>${esc(q.q || '질문')}</b>${q.multi ? ' <span class="muted small">(여러 개 고르기)</span>' : ''}
        ${q.options && q.options.length ? `<ol class="opts">${q.options.map((o) => `<li><b>${esc(o.label)}</b>${o.desc ? ` <span class="muted">— ${esc(o.desc)}</span>` : ''}</li>`).join('')}</ol>` : ''}</div>`).join('');
    case 'plan': return `<div>계획을 세우고 진행해도 될지 묻고 있어요.</div><details><summary>계획 펼쳐 보기</summary><pre>${esc(w.plan || '')}</pre></details>`;
    case 'permission': return `<div>이 작업을 해도 될지 묻고 있어요: <b>${esc((w.tool && (w.tool.label || w.tool.name)) || '도구 실행')}</b></div>${w.tool && w.tool.detail ? `<pre>${esc(w.tool.detail)}</pre>` : ''}`;
    case 'dialog': return `<div>${esc(w.text || '터미널에 열린 창이 있어요')}</div>`;
    case 'reply': return `<div class="muted small">질문으로 턴을 끝내고 쉬고 있어요. 마지막 말:</div><pre class="said">${esc(tailText(w.text))}</pre>`;
    case 'peer': return `<div>📨 <b>${esc(w.target || '다른 세션')}</b>에 메시지를 보내고 답을 기다려요</div>${w.text ? `<pre class="said">${esc(tailText(w.text))}</pre>` : ''}`;
  }
  return '';
}
