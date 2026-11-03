// One Claude Code session, reduced from its jsonl lines into "who is where doing what".
// The server keeps this model for snapshots and forwards each change to browsers as an event.
import { classifyTool, trunc } from './classify.mjs';

const MAX_LOG = 80;
const MAX_AGENT_LOG = 40;
const KEEP_DONE_MS = 30 * 60 * 1000;

function firstSentence(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = /^(.{8,}?[.!?。])(\s|$)/.exec(s);
  return trunc(m ? m[1] : s, n);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

function firstLine(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const l = lines.find((x) => !/^<\/?[\w-]+>$/.test(x)) || lines[0] || '';
  return l.replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '');
}

const clip = (s, n) => {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const SKIP_USER_TEXT = /^<(local-command|command-message|command-args|system-reminder|bash-|user-memory|local-command-caveat|user-prompt-submit-hook|ide_)/;

// What a pending tool call is about, for "Claude is waiting for your OK to run …".
function toolDetail(name, input) {
  const i = input || {};
  const v = i.command || i.file_path || i.notebook_path || i.url || i.query || i.pattern || i.path || '';
  return clip(v || (Object.keys(i).length ? JSON.stringify(i) : ''), 600);
}

const WAITS_FOR_REPLY = /기다릴게|기다리겠|기다리는 중|기다려 볼게|(답|답장|결과|회신)(이)? ?(오면|올 때까지|받으면)|wait(ing)? for (a |the |their )?(reply|answer|response|result)/i;

// Did Claude end its turn by asking the user something? (last lines, code blocks ignored)
function asksUser(text) {
  const lines = String(text || '').replace(/```[\s\S]*?```/g, '').split('\n')
    .map((l) => l.replace(/^[\s>*_#-]+|[\s*_`]+$/g, '')).filter(Boolean);
  if (!lines.length) return false;
  return /[?？]/.test(lines.slice(-5).join(' ')) || /(까요|나요|ㄴ가요|인가요|할지|을지|실래요)[.!…~\s]*$/.test(lines[lines.length - 1]);
}

// Token usage. Claude Code writes one line per content block, each repeating the message's usage,
// so a message id seen again replaces its previous numbers instead of adding to them.
const newStats = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, context: 0, model: '', tools: 0, errors: 0, turns: 0, lastMsgId: null, lastU: null });
export const statsView = (s) => ({ in: s.in, out: s.out, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, context: s.context, model: s.model, tools: s.tools, errors: s.errors, turns: s.turns });
function trackUsage(st, m) {
  const u = m && m.usage;
  if (!u || !m.id) return false;
  const cur = { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 };
  if (st.lastMsgId === m.id && st.lastU) {
    st.in -= st.lastU.in; st.out -= st.lastU.out; st.cacheRead -= st.lastU.cr; st.cacheWrite -= st.lastU.cw;
  }
  st.in += cur.in; st.out += cur.out; st.cacheRead += cur.cr; st.cacheWrite += cur.cw;
  st.lastMsgId = m.id;
  st.lastU = cur;
  st.context = cur.in + cur.cr + cur.cw;
  if (m.model && m.model !== '<synthetic>') st.model = m.model;
  return true;
}

export class SessionModel {
  constructor(sid, hooks) {
    this.sid = sid;
    this.hooks = hooks; // { emit(e), sent(s), received(r) }
    this.title = '';
    this.names = new Set();
    this.claude = { act: 'idle', room: 'desk', label: '', bubble: null, running: false, ts: 0, toolSince: 0 };
    this.agents = new Map();
    this.agentById = new Map();
    this.workflowRuns = new Map(); // runId -> Workflow tool_use id
    this.board = { title: '', items: [], ts: 0 };
    this.log = [];
    this.pending = new Map();
    this.busy = false;
    this.lastTs = 0;
    this.firstTs = 0;
    this.lastPrompt = null;
    this.replaying = false;
    this.seenNotif = new Set();
    this.recentPrompts = new Map();
    this.bubbleSeq = 1;
    this.lastSay = '';
    this.stats = newStats();
    this.roomCounts = {};
    this.statsAt = 0;
    this.statsTimer = null;
    // Waiting on the human: an open AskUserQuestion / ExitPlanMode, or how the last turn ended.
    this.waitAsk = null; // { id, kind: 'question' | 'plan', ts, questions | plan }
    this.lastSaid = null; // last text Claude wrote in this turn: { text, ts }
    this.turnSend = null; // last message this turn sent to another session: { target, text }
    this.ended = null; // { ts, text, question, peer }
  }

  waitInfo() {
    let tool = null;
    for (const p of this.pending.values()) {
      if (!['agent', 'ask', 'plan'].includes(p.kind) && (!tool || p.ts > tool.ts)) tool = p;
    }
    return { ask: this.waitAsk, tool: tool && { name: tool.name, label: tool.label, detail: tool.detail, ts: tool.ts }, ended: this.ended, lastTs: this.lastTs };
  }

  now(ts) {
    return this.replaying ? (ts || this.lastTs || Date.now()) : Date.now();
  }

  emit(e) {
    if (!this.replaying) this.hooks.emit(e);
  }

  bubble(kind, text, ts) {
    return { id: this.bubbleSeq++, kind, text: trunc(text, 160), at: this.now(ts) };
  }

  addLog(ts, who, text, kind = 'tool', extra = {}) {
    const e = { ts: ts || this.lastTs || Date.now(), who, text: trunc(text, 220), kind, ...extra };
    this.log.push(e);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.emit({ k: 'log', e });
  }

  agentLog(a, ts, text, kind = 'tool', room = null) {
    const e = { ts: ts || this.lastTs || Date.now(), text: trunc(text, 220), kind, room };
    a.log.push(e);
    if (a.log.length > MAX_AGENT_LOG) a.log.splice(0, a.log.length - MAX_AGENT_LOG);
    this.emit({ k: 'alog', key: a.key, e });
  }

  countRoom(room) {
    if (!room) return;
    this.roomCounts[room] = (this.roomCounts[room] || 0) + 1;
  }

  emitStats() {
    if (this.replaying) return;
    const send = () => {
      this.statsTimer = null;
      this.statsAt = Date.now();
      this.hooks.emit({ k: 'stats', s: statsView(this.stats), rooms: { ...this.roomCounts } });
    };
    const wait = 1000 - (Date.now() - this.statsAt);
    if (wait <= 0) send();
    else if (!this.statsTimer) this.statsTimer = setTimeout(send, wait);
  }

  setClaude(patch, ts) {
    Object.assign(this.claude, patch, { ts: this.now(ts) });
    this.emit({ k: 'claude', s: { ...this.claude } });
  }

  setAgent(a, patch, ts, full = false) {
    Object.assign(a, patch, { ts: this.now(ts) });
    a.lastTs = Math.max(a.lastTs || 0, ts || 0);
    this.emit({ k: 'agent', s: this.agentView(a, full) });
  }

  // `full` adds the long texts (instructions, report); the browser merges partial updates.
  agentView(a, full = false) {
    const v = {
      key: a.key, agentId: a.agentId, type: a.type, desc: a.desc, name: a.name, status: a.status, result: a.result,
      act: a.act, room: a.room, label: a.label, bubble: a.bubble, running: a.running, sweat: a.sweat,
      ts: a.ts, lastTs: a.lastTs, startedAt: a.startedAt, toolSince: a.toolSince, doneAt: a.doneAt,
      background: a.background, stats: statsView(a.stats),
    };
    if (full) { v.prompt = a.prompt; v.report = a.report; v.log = a.log.slice(); }
    return v;
  }

  setBoard(board, ts) {
    this.board = { ...board, ts: this.now(ts) };
    this.emit({ k: 'board', s: this.board });
  }

  setTitle(t) {
    if (!t || t === this.title) return;
    this.title = t;
    this.emit({ k: 'title', title: t });
  }

  // ---- main session lines -------------------------------------------------
  handleMain(o) {
    const ts = Date.parse(o.timestamp) || 0;
    if (ts) {
      this.lastTs = Math.max(this.lastTs, ts);
      if (!this.firstTs) this.firstTs = ts;
    }
    switch (o.type) {
      case 'custom-title': this.setTitle(o.customTitle); break;
      case 'agent-name': if (o.agentName) { this.names.add(o.agentName); if (!this.title) this.setTitle(o.agentName); } break;
      case 'assistant': this.onAssistant(o, ts, null); break;
      case 'user': this.onUser(o, ts, null); break;
      case 'attachment': {
        const a = o.attachment || {};
        if (a.type === 'queued_command' && typeof a.prompt === 'string') this.onUserText(a.prompt, ts, true);
        break;
      }
      case 'queue-operation':
        if (o.operation === 'enqueue' && typeof o.content === 'string' && /^\s*<(task-notification|[\w-]*message\b)/.test(o.content)) {
          this.onUserText(o.content, ts, true);
        }
        break;
      case 'system':
        if (o.subtype === 'api_error' && !this.replaying) {
          this.setClaude({ bubble: this.bubble('error', '😵 API 오류… 다시 시도 중', ts), sweat: this.now(ts) }, ts);
        } else if (o.subtype === 'compact_boundary') {
          this.addLog(ts, 'claude', '🧹 대화가 길어서 정리(compact)했어요', 'info');
          this.setClaude({ bubble: this.bubble('say', '🧹 기억 정리 중…', ts) }, ts);
        } else if (o.subtype === 'stop_hook_summary' || o.subtype === 'turn_duration') {
          this.turnEnd(ts);
        }
        break;
    }
  }

  onAssistant(o, ts, agent) {
    const m = o.message;
    if (!m || !Array.isArray(m.content)) return;
    if (trackUsage(agent ? agent.stats : this.stats, m) && !agent) this.emitStats();
    if (o.isApiErrorMessage || o.error) {
      const t = resultText(m.content) || 'API 오류';
      if (agent) this.agentError(agent, t, ts);
      else {
        this.stats.errors++;
        this.setClaude({ bubble: this.bubble('error', '😵 ' + firstLine(t), ts), sweat: this.now(ts) }, ts);
        this.addLog(ts, 'claude', '💦 ' + firstLine(t), 'error');
      }
      return;
    }
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        const text = firstSentence(b.thinking || '', 90);
        if (agent) this.agentThink(agent, text, ts);
        else {
          this.setClaude({ act: 'think', bubble: this.bubble('think', text || '', ts) }, ts);
          if (text) this.addLog(ts, 'claude', '💭 ' + text, 'think', { room: this.claude.room });
        }
      } else if (b.type === 'text') {
        const t = String(b.text || '').trim();
        if (!t) continue;
        if (agent) {
          agent.lastSay = t;
          this.setAgent(agent, { act: 'say', bubble: this.bubble('say', t, ts) }, ts);
          this.agentLog(agent, ts, '💬 ' + t, 'say', agent.room);
        } else {
          this.lastSay = t;
          this.lastSaid = { text: t, ts };
          this.ended = null;
          this.setClaude({ act: 'say', bubble: this.bubble('say', t, ts) }, ts);
          this.addLog(ts, 'claude', '💬 ' + t, 'say', { room: this.claude.room });
        }
      } else if (b.type === 'tool_use') {
        if (agent) this.agentTool(agent, b, ts);
        else this.claudeTool(b, ts);
      }
    }
    if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') {
      if (agent) this.agentDone(agent.key, 'report', agent.lastSay || '작업 끝났습니다', ts);
      else this.turnEnd(ts);
    }
  }

  turnEnd(ts) {
    if (!this.ended && this.lastSaid) {
      const text = this.lastSaid.text;
      // Waiting on another session only if it asked that session something or said it would wait.
      const t = this.turnSend;
      const peer = t && (asksUser(t.text) || WAITS_FOR_REPLY.test(text)) ? t.target : null;
      this.ended = { ts: ts || this.lastSaid.ts, text: clip(text, 1500), question: asksUser(text), peer };
    }
    this.waitAsk = null;
    this.pending.clear();
    if (!this.busy && this.claude.act === 'idle') return;
    this.busy = false;
    this.pending.clear();
    this.setClaude({ act: 'idle', room: 'desk', label: '', running: false, toolSince: 0 }, ts);
    this.emit({ k: 'busy', busy: false });
  }

  onUser(o, ts, agent) {
    if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
    const c = o.message && o.message.content;
    if (agent) {
      if (typeof c === 'string') this.agentInstruction(agent, c, ts);
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'tool_result') this.agentToolResult(agent, b, ts);
          else if (b.type === 'text') this.agentInstruction(agent, b.text, ts);
        }
      }
      return;
    }
    if (typeof c === 'string') this.onUserText(c, ts, false);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'tool_result') this.onToolResult(b, o.toolUseResult, ts);
        else if (b.type === 'text') this.onUserText(b.text, ts, false);
      }
    }
  }

  onUserText(text, ts, queued) {
    const t = String(text || '').trim();
    if (!t) return;
    if (t.startsWith('<task-notification')) return this.onNotification(t, ts);
    const tag = /^<([\w-]*message)\b([^>]*)>/.exec(t);
    if (tag) {
      const from = (/from="([^"]+)"/.exec(tag[2]) || [])[1] || '';
      const body = t.replace(/^<[^>]*>/, '').replace(/<\/[\w-]+>\s*$/, '')
        .replace(/^\s*\[Subagent hand-back\][^\n]*\n?/, '').trim();
      const key = this.agentById.get(from) || (this.agents.has(from) ? from : null);
      if (key) { this.agentDone(key, 'report', body, ts); return; }
      this.promptIn(body, ts, from || tag[1]);
      return;
    }
    if (/^\[Request interrupted by user/.test(t)) {
      this.busy = false;
      this.ended = null;
      this.waitAsk = null;
      this.pending.clear();
      this.setClaude({ act: 'idle', room: 'desk', running: false, label: '', toolSince: 0, bubble: this.bubble('say', '앗, 멈출게요 🛑', ts) }, ts);
      this.addLog(ts, 'user', '🛑 사용자가 작업을 멈췄어요', 'info');
      return;
    }
    if (t.startsWith('<command-name>')) {
      const cmd = (/<command-name>([^<]+)/.exec(t) || [])[1] || '';
      this.addLog(ts, 'user', `⌨️ ${cmd.trim()}`, 'prompt');
      return;
    }
    if (SKIP_USER_TEXT.test(t) || t.startsWith('Caveat:')) return;
    this.promptIn(t, ts, null);
  }

  promptIn(text, ts, fromHint) {
    const k = text.slice(0, 300);
    const prev = this.recentPrompts.get(k);
    if (prev && Math.abs(prev - ts) < 20000) return; // same prompt seen twice (queued + delivered)
    this.recentPrompts.set(k, ts);
    if (this.recentPrompts.size > 50) this.recentPrompts.delete(this.recentPrompts.keys().next().value);
    this.lastPrompt = { text: clip(text, 600), ts };
    this.ended = null;
    this.lastSaid = null;
    this.turnSend = null;
    this.stats.turns++;
    if (!this.busy) {
      this.busy = true;
      this.setClaude({ act: 'desk', room: 'desk', label: '', running: false }, ts);
      this.emit({ k: 'busy', busy: true });
    }
    // The broker decides whether this came from the human or from another Claude, then calls emitPrompt().
    this.hooks.received({ sid: this.sid, text, ts, fromHint, replay: this.replaying, model: this });
  }

  emitPrompt(r, link) {
    const who = link ? link.from.label : null;
    this.addLog(r.ts, link ? 'peer' : 'user', link ? `📩 ${who}: ${r.text}` : `🧑‍💻 ${r.text}`, link ? 'msg' : 'prompt', { room: 'user' });
    if (!r.replay) this.hooks.emit({ k: 'prompt', text: trunc(r.text, 160), full: clip(r.text, 600), from: link ? link.from : null, at: Date.now() });
  }

  onNotification(t, ts) {
    const tool = (/<tool-use-id>([^<]+)/.exec(t) || [])[1];
    const task = (/<task-id>([^<]+)/.exec(t) || [])[1];
    const status = ((/<status>([^<]+)/.exec(t) || [])[1] || '').trim();
    const summary = ((/<summary>([\s\S]*?)<\/summary>/.exec(t) || [])[1] || '').trim();
    const nk = `${tool || task}:${status}`;
    if (this.seenNotif.has(nk)) return;
    this.seenNotif.add(nk);
    const key = (tool && this.agents.has(tool)) ? tool : (task && this.agentById.get(task));
    if (key) {
      const result = ((/<result>([\s\S]*?)<\/result>/.exec(t) || [])[1] || summary).trim();
      this.agentDone(key, status === 'completed' ? 'report' : 'fail', result, ts);
      return;
    }
    if (tool && this.workflowRunsByTool(tool)) {
      for (const a of this.agents.values()) {
        if (a.workflowTool === tool && a.status === 'working') this.agentDone(a.key, status === 'completed' ? 'report' : 'fail', '워크플로 끝!', ts);
      }
    }
    this.addLog(ts, 'claude', `🔔 ${summary || '백그라운드 작업 ' + status}`, 'info');
  }

  workflowRunsByTool(tool) {
    for (const v of this.workflowRuns.values()) if (v === tool) return true;
    return false;
  }

  claudeTool(b, ts) {
    const input = b.input || {};
    const c = classifyTool(b.name, input);
    this.pending.set(b.id, { name: b.name, kind: c.kind, ts, label: c.label, detail: toolDetail(b.name, input) });
    this.lastSaid = null;
    this.ended = null;
    if (c.kind === 'ask' || c.kind === 'plan') {
      this.waitAsk = c.kind === 'plan'
        ? { id: b.id, kind: 'plan', ts, plan: clip(input.plan, 4000) }
        : {
          id: b.id, kind: 'question', ts,
          questions: (Array.isArray(input.questions) ? input.questions : [{ question: input.question }]).slice(0, 4).map((q) => ({
            q: clip(q && q.question, 400), header: clip(q && q.header, 40), multi: !!(q && q.multiSelect),
            options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clip(o && o.label, 80), desc: clip(o && o.description, 160) })),
          })),
        };
    }
    this.stats.tools++;
    this.countRoom(c.room);
    this.emitStats();
    if (!this.busy) { this.busy = true; this.emit({ k: 'busy', busy: true }); }
    const room = c.room;
    switch (c.kind) {
      case 'agent': {
        const type = input.subagent_type || 'general-purpose';
        const desc = input.description || '';
        const a = this.ensureAgent(b.id, { type, desc, name: input.name || '', prompt: input.prompt }, ts);
        a.background = !!input.run_in_background;
        this.setClaude({ act: 'call', room: 'desk', label: c.label, running: false, toolSince: ts,
          bubble: this.bubble('call', `📞 ${type}님, "${desc}" 부탁해요!`, ts) }, ts);
        this.addLog(ts, 'claude', `📞 ${type} 호출: ${desc}`, 'agent', { room, agent: b.id });
        return;
      }
      case 'send': {
        const to = String(input.to || input.session_id || input.target || '');
        const msg = String(input.message || input.text || input.prompt || '');
        const key = this.agentById.get(to) || this.findAgentByName(to);
        if (key) {
          const a = this.agents.get(key);
          this.setClaude({ act: 'call', room: 'desk', label: c.label, running: false, toolSince: ts,
            bubble: this.bubble('call', `📞 ${a.type}님, 하나 더요: ${msg}`, ts) }, ts);
          this.resumeAgent(a, ts, true);
          this.agentLog(a, ts, `📨 추가 지시: ${msg}`, 'msg', 'desk');
          this.addLog(ts, 'claude', `📞 ${a.type}에게 추가 지시: ${msg}`, 'agent', { room, agent: key });
        } else {
          this.setClaude({ act: 'call', room: 'desk', label: c.label, running: false, toolSince: ts,
            bubble: this.bubble('msg', `📨 ${to}: ${msg}`, ts) }, ts);
          this.addLog(ts, 'claude', `📨 → ${to}: ${msg}`, 'msg', { room });
          this.turnSend = { target: to || '다른 세션', text: msg };
          this.hooks.sent({ sid: this.sid, text: msg, target: to, via: 'SendMessage', ts, replay: this.replaying });
        }
        return;
      }
      case 'tmux': {
        for (const s of c.sends) {
          this.hooks.sent({ sid: this.sid, text: s.text, target: s.target, via: 'tmux', ts, replay: this.replaying });
          this.addLog(ts, 'claude', `📨 tmux ${s.target || ''} → ${s.text}`, 'msg', { room });
          this.turnSend = { target: s.target ? `tmux ${s.target}` : 'tmux', text: s.text };
        }
        const s0 = c.sends[0];
        this.setClaude({ act: 'call', room: 'desk', label: c.label, running: true, toolSince: ts,
          bubble: this.bubble('msg', `📨 ${s0.target ? s0.target + ': ' : ''}${s0.text}`, ts) }, ts);
        return;
      }
      case 'todo': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        this.setBoard({ title: '할 일', items: todos.slice(0, 20).map((t) => ({ text: trunc(t.content || t.activeForm || '', 60), status: t.status || 'pending' })) }, ts);
        break;
      }
      case 'task': {
        const items = this.board.title === '할 일' ? [...this.board.items] : [];
        if (b.name === 'TaskCreate') {
          items.push({ id: String(items.length + 1), text: trunc(input.subject || input.title || input.description || '', 60), status: 'pending' });
        } else {
          const it = items.find((x) => x.id === String(input.taskId));
          if (it) {
            if (input.status) it.status = input.status;
            if (input.subject) it.text = trunc(input.subject, 60);
          }
        }
        this.setBoard({ title: '할 일', items: items.slice(-20) }, ts);
        break;
      }
      case 'plan': {
        const lines = String(input.plan || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^```/.test(l));
        const items = lines.slice(0, 20).map((l) => ({ text: trunc(l.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '• '), 60), status: /^#/.test(l) ? 'head' : 'pending' }));
        this.setBoard({ title: '계획', items }, ts);
        this.setClaude({ act: 'ask', room: 'user', label: c.label, running: false, toolSince: ts, bubble: this.bubble('ask', '🗒️ 계획 세웠어요. 확인 부탁드려요!', ts) }, ts);
        this.addLog(ts, 'claude', '🗒️ 계획 승인 요청', 'ask', { room: 'user' });
        return;
      }
      case 'workflow': {
        const meta = /meta\s*=\s*\{[\s\S]*?name:\s*['"]([^'"]+)['"][\s\S]*?description:\s*['"]([^'"]+)['"]/.exec(String(input.script || ''));
        const phases = [...String(input.script || '').matchAll(/\{\s*title:\s*['"]([^'"]+)['"](?:,\s*detail:\s*['"]([^'"]*)['"])?/g)];
        this.setBoard({ title: '🧩 ' + trunc(meta ? meta[2] : (input.name || '워크플로'), 40), items: phases.slice(0, 12).map((p) => ({ text: trunc(p[1] + (p[2] ? ' — ' + p[2] : ''), 60), status: 'pending' })) }, ts);
        break;
      }
      case 'ask': {
        const q = (Array.isArray(input.questions) && input.questions[0] && input.questions[0].question) || input.question || '질문이 있어요';
        this.setClaude({ act: 'ask', room: 'user', label: c.label, running: false, toolSince: ts, bubble: this.bubble('ask', '❓ ' + q, ts), question: clip(q, 400) }, ts);
        this.addLog(ts, 'claude', '❓ ' + q, 'ask', { room: 'user' });
        return;
      }
      case 'deliver': {
        this.setClaude({ act: 'tool', room: 'user', label: c.label, running: false, toolSince: ts, bubble: this.bubble('say', '📎 결과물 여기 있어요!', ts) }, ts);
        this.addLog(ts, 'claude', '📎 파일 전달', 'tool', { room: 'user' });
        return;
      }
    }
    this.setClaude({ act: 'tool', room, label: c.label, running: true, git: !!c.git, toolSince: ts, tool: b.name }, ts);
    this.addLog(ts, 'claude', c.label, 'tool', { room, tool: b.name });
  }

  onToolResult(b, tur, ts) {
    const id = b.tool_use_id;
    const p = this.pending.get(id);
    this.pending.delete(id);
    const isErr = !!b.is_error;
    const text = resultText(b.content);
    if (this.agents.has(id) && (!p || p.kind === 'agent')) {
      const a = this.agents.get(id);
      if (tur && typeof tur === 'object' && (tur.status === 'async_launched' || tur.isAsync)) {
        if (tur.agentId) { a.agentId = tur.agentId; this.agentById.set(tur.agentId, id); }
        return;
      }
      if (tur && tur.agentId) { a.agentId = tur.agentId; this.agentById.set(tur.agentId, id); }
      this.agentDone(id, isErr ? 'fail' : 'report', text, ts);
      return;
    }
    if (p && p.kind === 'workflow' && tur && tur.runId) this.workflowRuns.set(tur.runId, id);
    if (isErr) {
      this.stats.errors++;
      this.emitStats();
      const msg = /doesn't want to proceed|was rejected|denied/i.test(text) ? '🙅 거절당했어요…' : '💦 ' + firstLine(text);
      this.setClaude({ act: this.claude.act === 'ask' ? 'desk' : this.claude.act, room: this.claude.act === 'ask' ? 'desk' : this.claude.room,
        running: false, toolSince: 0, bubble: this.bubble('error', msg, ts), sweat: this.now(ts) }, ts);
      this.addLog(ts, 'claude', msg, 'error', { room: this.claude.room });
      return;
    }
    if (this.waitAsk && this.waitAsk.id === id) this.waitAsk = null;
    if (p && (p.kind === 'ask' || p.kind === 'plan')) {
      const ans = [...text.matchAll(/="([^"]+)"/g)].map((m) => m[1]).join(', ');
      if (!this.replaying) this.hooks.emit({ k: 'answer', text: trunc(ans || (p.kind === 'plan' ? '👍 좋아요, 진행하세요' : '답변 완료'), 120), at: Date.now() });
      this.addLog(ts, 'user', `💬 ${ans || '답변함'}`, 'prompt', { room: 'user' });
      this.setClaude({ act: 'desk', room: 'desk', label: '', running: false, toolSince: 0, question: '' }, ts);
      return;
    }
    if (this.claude.running || this.claude.toolSince) this.setClaude({ running: false, toolSince: 0 }, ts);
  }

  // ---- subagents -----------------------------------------------------------
  ensureAgent(key, info, ts) {
    let a = this.agents.get(key);
    if (!a) {
      a = { key, agentId: info.agentId || null, type: info.type || 'general-purpose', desc: info.desc || '', name: info.name || '',
        status: 'working', result: null, act: 'arrive', room: 'desk', label: '', bubble: null, running: false, ts: this.now(ts), lastTs: ts || 0,
        startedAt: ts || this.now(ts), toolSince: 0, doneAt: 0, workflowTool: info.workflowTool || null,
        prompt: info.prompt ? clip(info.prompt, 4000) : '', report: '', log: [], stats: newStats(), lastSay: '' };
      this.agents.set(key, a);
      if (a.agentId) this.agentById.set(a.agentId, key);
      this.emit({ k: 'agent', s: this.agentView(a, true) });
      if (!this.replaying) this.addLog(ts, a.type, `🛗 ${a.type} 출근: ${a.desc}`, 'agent', { room: 'lobby', agent: key });
    } else {
      if (info.agentId && !a.agentId) { a.agentId = info.agentId; this.agentById.set(info.agentId, key); }
      if (info.type && a.type === 'general-purpose' && info.type !== 'general-purpose') a.type = info.type;
      if (info.desc && !a.desc) a.desc = info.desc;
      if (info.prompt && !a.prompt) a.prompt = clip(info.prompt, 4000);
    }
    return a;
  }

  findAgentByName(to) {
    if (!to) return null;
    for (const a of this.agents.values()) if (a.name === to || a.agentId === to || a.desc === to) return a.key;
    return null;
  }

  agentInstruction(a, text, ts) {
    const t = String(text || '').trim();
    if (!t || SKIP_USER_TEXT.test(t)) return;
    if (a.prompt && t.slice(0, 200) === a.prompt.slice(0, 200)) return; // the brief itself, already known from the Agent call
    if (!a.prompt) { a.prompt = clip(t, 4000); this.emit({ k: 'agent', s: this.agentView(a, true) }); return; }
    this.agentLog(a, ts, `📨 ${t}`, 'msg', a.room);
  }

  resumeAgent(a, ts, byOrder) {
    if (a.status === 'working') return;
    this.setAgent(a, { status: 'working', result: null, act: 'arrive', room: 'desk', doneAt: 0, bubble: this.bubble('say', byOrder ? '앗, 하나 더요? 🏃' : '다시 일하러 갑니다 🏃', ts) }, ts);
    this.addLog(ts, a.type, `🔁 ${a.type} 다시 작업 시작`, 'agent', { agent: a.key });
  }

  agentThink(a, text, ts) {
    if (a.status !== 'working') this.resumeAgent(a, ts, false);
    this.setAgent(a, { act: 'think', bubble: this.bubble('think', text, ts) }, ts);
    if (text) this.agentLog(a, ts, '💭 ' + text, 'think', a.room);
  }

  agentTool(a, b, ts) {
    if (b.name === 'SubagentHandback') {
      const msg = (b.input && (b.input.message || b.input.summary)) || '';
      this.agentDone(a.key, 'report', msg, ts);
      return;
    }
    if (a.status !== 'working') this.resumeAgent(a, ts, false);
    const c = classifyTool(b.name, b.input || {});
    let room = c.room;
    if (c.kind === 'ask' || c.kind === 'deliver' || c.kind === 'plan') room = 'desk';
    a.stats.tools++;
    this.countRoom(room);
    this.setAgent(a, { act: 'tool', room, label: c.label, running: true, toolSince: ts, tool: b.name }, ts);
    this.agentLog(a, ts, c.label, 'tool', room);
  }

  agentToolResult(a, b, ts) {
    if (b.is_error) this.agentError(a, resultText(b.content), ts);
    else if (a.running || a.toolSince) this.setAgent(a, { running: false, toolSince: 0 }, ts);
  }

  agentError(a, text, ts) {
    a.stats.errors++;
    this.setAgent(a, { running: false, toolSince: 0, bubble: this.bubble('error', '💦 ' + firstLine(text), ts), sweat: this.now(ts) }, ts);
    this.agentLog(a, ts, '💦 ' + firstLine(text), 'error', a.room);
  }

  agentDone(key, mode, text, ts) {
    const a = this.agents.get(key);
    if (!a || a.status !== 'working') return;
    const clean = String(text || '').replace(/^#+\s*/gm, '').replace(/[*`]/g, '');
    const summary = firstSentence(clean, 110) || '끝났습니다!';
    a.report = clip(String(text || '').trim(), 6000);
    this.setAgent(a, { status: 'reporting', result: mode === 'fail' ? 'fail' : 'ok', act: 'report', running: false, toolSince: 0,
      bubble: this.bubble(mode === 'fail' ? 'error' : 'report', (mode === 'fail' ? '😓 ' : '📋 ') + summary, ts), doneAt: this.now(ts) }, ts, true);
    this.agentLog(a, ts, `${mode === 'fail' ? '😓 실패' : '📋 보고'}: ${summary}`, mode === 'fail' ? 'error' : 'report', 'desk');
    this.addLog(ts, a.type, `${mode === 'fail' ? '😓' : '📋'} ${a.type} 보고: ${summary}`, 'agent', { agent: key });
  }

  handleAgentLine(a, o) {
    const ts = Date.parse(o.timestamp) || 0;
    if (ts) { this.lastTs = Math.max(this.lastTs, ts); a.lastTs = Math.max(a.lastTs || 0, ts); }
    if (o.type === 'assistant') this.onAssistant(o, ts, a);
    else if (o.type === 'user') this.onUser(o, ts, a);
  }

  // After replaying the tail of an old log, settle into a sensible resting state.
  finishReplay(fileMtime) {
    const now = Date.now();
    // Line timestamps beat file mtimes: resuming a session touches old files without new lines.
    const quiet = now - (this.lastTs || fileMtime || 0);
    if (quiet > 10 * 60 * 1000) {
      // Only the picture rests: pending calls stay, since a claude can sit on an open question for hours.
      this.busy = false;
      Object.assign(this.claude, { act: 'idle', room: 'desk', label: '', running: false, toolSince: 0 });
    }
    for (const a of [...this.agents.values()]) {
      const aq = now - (a.lastTs || a.fileMtime || 0);
      if (a.status !== 'working' || aq > 10 * 60 * 1000) {
        if (a.status === 'working') a.result = a.result || 'lost';
        a.status = 'gone';
        a.doneAt = a.doneAt || a.lastTs;
      }
    }
  }

  snapshot() {
    const now = Date.now();
    const agents = [];
    const history = [];
    for (const a of this.agents.values()) {
      if (a.status === 'working') agents.push(this.agentView(a, true));
      else if (a.status === 'reporting' && now - (a.doneAt || 0) < 12000) agents.push(this.agentView(a, true));
      else history.push(this.agentView(a, true));
    }
    history.sort((p, q) => (q.doneAt || q.lastTs || 0) - (p.doneAt || p.lastTs || 0));
    return {
      sid: this.sid, title: this.title, names: [...this.names], claude: { ...this.claude }, agents, history: history.slice(0, 20),
      board: this.board, log: this.log.slice(-60), busy: this.busy, lastTs: this.lastTs, firstTs: this.firstTs, lastPrompt: this.lastPrompt,
      stats: statsView(this.stats), rooms: { ...this.roomCounts }, now,
    };
  }

  // Compact summary for the building-wide agent monitor.
  fleetView() {
    const now = Date.now();
    const agents = [];
    for (const a of this.agents.values()) {
      // A report is a short scene; after that the agent has gone home.
      if (a.status === 'reporting' && now - (a.doneAt || 0) > 20000) a.status = 'gone';
      if (a.status !== 'working' && now - (a.doneAt || a.lastTs || 0) > KEEP_DONE_MS) continue;
      agents.push({
        key: a.key, type: a.type, desc: a.desc, status: a.status, result: a.result, act: a.act, room: a.room, label: a.label,
        lastTs: a.lastTs, startedAt: a.startedAt, toolSince: a.toolSince, doneAt: a.doneAt, background: a.background,
        tools: a.stats.tools, errors: a.stats.errors, tokens: a.stats.in + a.stats.out + a.stats.cacheRead + a.stats.cacheWrite,
        context: a.stats.context, model: a.stats.model,
      });
    }
    agents.sort((p, q) => (q.lastTs || 0) - (p.lastTs || 0));
    const c = this.claude;
    return {
      busy: this.busy, act: c.act, room: c.room, label: c.label, toolSince: c.toolSince, question: c.question || '',
      lastTs: this.lastTs, firstTs: this.firstTs, stats: statsView(this.stats), agents: agents.slice(0, 40),
      lastPrompt: this.lastPrompt ? { text: trunc(this.lastPrompt.text, 140), ts: this.lastPrompt.ts } : null,
    };
  }
}
