// One place that decides "is this agent working, stuck, done…" for the office, the monitor and alerts.
import { S, nowS } from './state.js';

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
