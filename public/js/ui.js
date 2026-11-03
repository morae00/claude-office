// Everything outside the canvas: floor guide, header, tooltips, the inspector panel,
// the agent monitor, activity log, session chat, settings and notifications.
import { $, $$, S, actors, prefs, savePrefs, isHidden, setHidden, nowS, esc, ago, dur, hhmmss, fmtTok, copyText } from './state.js';
import { ROOM_INFO, R } from './world.js';
import { cam, screenOf, setZoom } from './iso.js';
import { STATUS, statusOf, sessionEntry, WAIT, waitOf, waitList, waitBodyHtml } from './status.js';
import { sendHome, releaseSpot } from './actors.js';
import { currentBoard } from './scene.js';

let H = {}; // handlers from main.js: selectFloor(fkey), selectSession(sid), follow()
const staleMs = () => prefs.staleMin * 60000;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------------
export function initUI(handlers) {
  H = handlers;
  $('#floors').addEventListener('click', (e) => {
    if (e.target.closest('.store[data-sid], .floor-row')) document.body.classList.remove('drawer-open');
    const st = e.target.closest('.store[data-sid]');
    if (st) { H.selectSession(st.dataset.sid); return; }
    const fr = e.target.closest('.floor-row');
    if (fr) H.selectFloor(fr.dataset.fkey);
  });
  $('#toggleOld').addEventListener('click', () => { S.showOld = !S.showOld; renderDirectory(); });
  $('#followBtn').addEventListener('click', () => H.selectFloor(S.view.floor, true));
  $('#labelsBtn').addEventListener('click', () => { prefs.labels = !prefs.labels; savePrefs(); syncToggles(); });
  $('#notifyBtn').addEventListener('click', toggleNotify);
  $('#agentsBtn').addEventListener('click', () => setTab('agents', true));
  $('#staleBtn').addEventListener('click', () => { prefs.agentFilter = 'stale'; savePrefs(); setTab('agents', true); });
  $('#settingsBtn').addEventListener('click', openSettings);
  $$('#dock .tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#inspector .close').addEventListener('click', () => select(null));
  $('#inspector').addEventListener('click', onInspectorClick);
  $('#logSearch').addEventListener('input', () => renderLog());
  $('#logRoom').addEventListener('change', (e) => { prefs.logRoom = e.target.value; savePrefs(); renderLog(); });
  $('#logAgents').addEventListener('change', (e) => { prefs.logAgents = e.target.checked; savePrefs(); renderLog(); });
  $('#log').addEventListener('click', onFeedClick);
  $('#chat').addEventListener('click', (e) => {
    const b = e.target.closest('.body');
    if (b) { b.classList.toggle('open'); return; }
    onFeedClick(e);
  });
  $('#agentSearch').addEventListener('input', () => renderAgents());
  $$('#agentFilters [data-filter]').forEach((b) => b.addEventListener('click', () => { prefs.agentFilter = b.dataset.filter; savePrefs(); renderAgents(); }));
  $$('#agentScope [data-scope]').forEach((b) => b.addEventListener('click', () => { prefs.scope = b.dataset.scope; savePrefs(); renderAgents(); }));
  $('#agentTable').addEventListener('click', onAgentTableClick);
  $('#agentTable').addEventListener('mouseover', (e) => { const tr = e.target.closest('tr[data-id]'); S.highlight = tr ? tr.dataset.id : null; });
  $('#agentTable').addEventListener('mouseleave', () => { S.highlight = null; });
  $('#bulkStale').addEventListener('click', () => bulk('stale'));
  $('#bulkDone').addEventListener('click', () => bulk('done'));
  $('#showHidden').addEventListener('change', (e) => { S.showHidden = e.target.checked; renderAgents(); });
  const sel = $('#logRoom');
  sel.innerHTML = `<option value="all">모든 방</option>${Object.entries(ROOM_INFO).filter(([k]) => k !== 'corridor').map(([k, r]) => `<option value="${k}">${r.icon} ${r.name}</option>`).join('')}`;
  sel.value = prefs.logRoom;
  $('#logAgents').checked = prefs.logAgents;
  syncToggles();
  setTab(prefs.tab || 'log');
  setInterval(() => { renderDirectory(); renderAgents(); refreshInspector(); }, 1000);
}

function syncToggles() {
  $('#labelsBtn').classList.toggle('on', !!prefs.labels);
  $('#notifyBtn').classList.toggle('on', !!prefs.notify && 'Notification' in window && Notification.permission === 'granted');
  $('#coworkersToggle') && ($('#coworkersToggle').checked = prefs.coworkers);
}

export function setTab(tab, focus) {
  prefs.tab = tab; savePrefs();
  $$('#dock .tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('#dock .tab-body').forEach((b) => { b.hidden = b.dataset.body !== tab; });
  if (tab === 'agents') renderAgents(true);
  if (tab === 'log') renderLog();
  if (focus) $('#dock').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- floor guide ------------------------------------------------------------------
function acctChip(akey) {
  const a = S.accounts.get(akey);
  return a ? `<span class="acct" style="--c:${esc(a.color)}">${esc(a.label)}</span>` : '';
}

// tmux session the claude process runs in, from Claude Code's own sessions/<pid>.json (exact, not guessed).
const PROC_STATUS = { busy: '일하는 중', idle: '쉬는 중', waiting: '답 기다리는 중' };
function tmuxChip(s) {
  const t = s && s.tmux;
  if (!t) return '';
  const tip = [`tmux ${t.name || t.session} (${t.pane})`, s.procName, PROC_STATUS[s.procStatus] || s.procStatus].filter(Boolean).join(' · ');
  return `<span class="fhost" style="white-space:nowrap;font-weight:600" title="${esc(tip)}">🪟 ${esc(t.session)}</span>`;
}

// Live floor-guide entry for a session (has the latest tmux/proc fields; meta is only sent once).
function floorSess(sid) {
  for (const f of S.floors) { const x = f.sessions.find((s) => s.sid === sid); if (x) return x; }
  return null;
}

export function waitChip(w) {
  const m = w && WAIT[w.kind];
  return m ? `<span class="wchip ${m.me ? 'me' : ''}" title="${esc(m.label)}">${m.icon}<span class="lbl"> ${esc(m.label)}</span></span>` : '';
}

export function renderDirectory() {
  const now = nowS();
  const src = S.sources.filter((s) => s.remote || s.status !== 'ok');
  $('#sources').innerHTML = src.map((s) => {
    const ok = s.status === 'ok';
    return `<span class="chip ${ok ? '' : 'err'}" title="${esc(s.error || '')}"><i class="dot" style="background:${ok ? 'var(--ok)' : s.status === 'connecting' ? 'var(--warn)' : 'var(--bad)'}"></i>🖥 ${esc(s.label)} ${ok ? '연결됨' : s.status === 'connecting' ? '연결 중…' : '연결 실패'}</span>`;
  }).join('');
  $('#accounts').innerHTML = S.accounts.size > 1 ? [...S.accounts.values()].map((a) => `<span class="chip"><i class="dot" style="background:${esc(a.color)}"></i>${esc(a.label)}</span>`).join('') : '';
  let hidden = 0;
  const html = [];
  for (const f of S.floors) {
    const isCur = f.fkey === S.view.floor;
    const active = now - f.mtime < 90000;
    const old = now - f.mtime > 7 * 86400000 && !f.sessions.some((s) => s.wait || s.live);
    if (old && !isCur && !S.showOld) { hidden++; continue; }
    const busy = f.sessions.some((s) => s.busy);
    let body = '';
    if (isCur) {
      body = `<ul class="store-list">${f.sessions.map((s) => {
        const on = now - s.mtime < 90000;
        const primary = s.sid === S.view.primary;
        const shown = S.sessions.has(s.sid);
        const pin = primary && S.view.mode === 'pin';
        return `<li class="store ${primary ? 'primary' : shown ? 'coworker' : ''} ${s.wait ? 'waiting' : ''}" data-sid="${esc(s.sid)}" title="클릭하면 이 세션에 고정 📌">
          <span class="lamp ${on ? 'on' : ''} ${s.busy ? 'busy' : ''}"></span>
          <span class="t">${pin ? '📌 ' : primary ? '👁 ' : shown ? '👥 ' : ''}${esc(s.title || '새 세션')}${s.wait || s.tmux ? `<br>${waitChip(s.wait)}${tmuxChip(s)}` : ''}</span>
          <span class="meta">${acctChip(s.akey)}<span>${esc(ago(s.mtime))}</span></span></li>`;
      }).join('') || '<li class="store empty">세션 없음</li>'}</ul>`;
    } else if (f.sessions.length) {
      const names = f.sessions.map((s) => s.title || '새 세션');
      body = `<div class="stores">${esc(names.slice(0, 3).join(' · '))}${names.length > 3 ? ` 외 ${names.length - 3}` : ''}</div>`;
    }
    const waits = f.sessions.filter((s) => s.wait && WAIT[s.wait.kind] && WAIT[s.wait.kind].me).length;
    html.push(`<div class="floor ${isCur ? 'current' : ''} ${old ? 'old' : ''}">
      <div class="floor-row" data-fkey="${esc(f.fkey)}" title="${esc(f.cwd || f.name)}">
        <span class="fnum">${f.num}F</span><span class="lamp ${active ? 'on' : ''} ${busy ? 'busy' : ''}"></span>
        <span class="fname">${esc(f.name)}${waits ? ` <span class="wchip me" title="내 결정을 기다리는 세션 ${waits}개">✋${waits}</span>` : ''}</span>${f.host ? `<span class="fhost">🖥 ${esc(f.host)}</span>` : '<span></span>'}
      </div>${body}</div>`);
  }
  const next = html.join('') || '<div class="stores pad">아직 층이 없어요. Claude Code를 한 번 실행해 보세요.</div>';
  if ($('#floors').innerHTML !== next) $('#floors').innerHTML = next;
  const tb = $('#toggleOld');
  if (hidden || S.showOld) { tb.hidden = false; tb.textContent = S.showOld ? '▴ 오래 쉰 층 접기' : `💤 7일 넘게 쉰 층 ${hidden}개 펼치기`; } else tb.hidden = true;
}

export function renderTop() {
  const f = S.floors.find((x) => x.fkey === S.view.floor);
  $('#floorBadge').textContent = f ? `${f.num}F` : '–';
  $('#floorName').textContent = f ? `${f.name}${f.host ? ' · 🖥 ' + f.host : ''}` : (S.connected ? '세션을 찾는 중…' : '연결 중…');
  const p = S.sessions.get(S.view.primary);
  const cw = [...S.sessions.keys()].filter((k) => k !== S.view.primary).length;
  $('#sessTitle').textContent = p ? `${p.meta.title || '새 세션'}${p.meta.acct ? ' · ' + p.meta.acct : ''}${cw ? ` · 동료 ${cw}명` : ''}` : '';
  $('#modeBadge').textContent = S.view.mode === 'pin' ? '📌 고정' : '🔄 따라가는 중';
  $('#modeBadge').title = S.view.mode === 'pin' ? '이 세션에 고정되어 있어요' : '이 층의 최근 세션을 따라가요 (/clear 하면 새 세션으로)';
  $('#followBtn').hidden = S.view.mode !== 'pin';
}

export function renderConn() {
  const c = $('#conn');
  c.className = 'conn ' + (S.connected ? 'ok' : 'bad');
  c.title = S.connected ? '실시간 연결됨' : '연결 끊김 — 다시 시도 중';
}

// ---- tooltip ----------------------------------------------------------------------
export function showTooltip(target, px, py) {
  const tip = $('#tooltip');
  const html = target ? tooltipHtml(target) : '';
  if (!html) { tip.hidden = true; return; }
  if (tip.dataset.key !== JSON.stringify(target) || tip.hidden) tip.innerHTML = html;
  tip.dataset.key = JSON.stringify(target);
  tip.hidden = false;
  const stage = $('#stage').getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = px + 18;
  let y = py + 14;
  if (x + w > stage.width - 8) x = px - w - 18;
  if (y + h > stage.height - 8) y = Math.max(8, stage.height - h - 8);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
export function hideTooltip() { $('#tooltip').hidden = true; }

function chip(st) {
  const m = STATUS[st] || STATUS.idle;
  return `<span class="st ${m.cls}">${m.icon} ${m.label}</span>`;
}

function roomOccupants(room) {
  return [...actors.values()].filter((a) => a.room === room && !a.path.length && a.kind !== 'user');
}

function recentInRoom(room, n) {
  const rows = [];
  for (const s of S.sessions.values()) {
    for (const e of s.log) if (e.room === room) rows.push({ ...e, who: e.who === 'claude' ? `Claude·${s.meta.acct}` : e.who });
    for (const a of s.agents.values()) for (const e of a.log || []) if (e.room === room) rows.push({ ...e, who: a.type });
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, n);
}

function roomCount(room) {
  let n = 0;
  for (const s of S.sessions.values()) n += (s.rooms && s.rooms[room]) || 0;
  return n;
}

function tooltipHtml(t) {
  const sm = staleMs();
  if (t.kind === 'actor') {
    const a = actors.get(t.id);
    if (!a) return '';
    if (a.kind === 'user') {
      const asks = waitList().filter((x) => WAIT[x.w.kind].me);
      return `<div class="tt-h"><b>🧑‍💻 나</b><span class="muted">내 자리</span></div>
        <div class="tt-r">${asks.length ? `✋ 내 결정·답을 기다리는 세션 ${asks.length}개 (건물 전체)` : '기다리는 질문 없음'}</div><div class="tt-f">클릭하면 자세히</div>`;
    }
    const s = S.sessions.get(a.sid);
    if (!s) return '';
    if (a.kind === 'claude') {
      const st = statusOf(sessionEntry(s), 'claude', sm);
      const c = s.claude || {};
      const working = [...s.agents.values()].filter((x) => x.status === 'working').length;
      const w = waitOf(s.sid);
      return `<div class="tt-h"><b style="color:${esc(s.meta.color)}">${esc(a.name)}</b>${chip(st)}</div>
        <div class="tt-t">${esc(s.meta.title || '새 세션')}</div>
        ${c.label ? `<div class="tt-r">지금 <b>${esc(c.label)}</b>${c.toolSince ? ` <span class="muted">· ${dur(nowS() - c.toolSince)}째</span>` : ''}</div>` : ''}
        ${w ? `<div class="tt-r warn">${WAIT[w.kind].icon} ${esc(WAIT[w.kind].label)} <span class="muted">· ${ago(w.since)}부터</span></div>` : c.act === 'ask' && c.question ? `<div class="tt-r warn">❓ ${esc(c.question)}</div>` : ''}
        ${s.lastPrompt ? `<div class="tt-r muted">마지막 요청: ${esc(s.lastPrompt.text.slice(0, 80))}</div>` : ''}
        <div class="tt-g"><span>도구 <b>${s.stats.tools}</b></span><span>오류 <b>${s.stats.errors}</b></span><span>컨텍스트 <b>${fmtTok(s.stats.context)}</b></span><span>서브에이전트 <b>${working}</b></span></div>
        <div class="tt-f">클릭하면 자세히 · 더블클릭하면 따라가기</div>`;
    }
    const ag = s.agents.get(a.agentKey);
    if (!ag) return '';
    const st = statusOf(ag, 'agent', sm);
    return `<div class="tt-h"><b>${esc(ag.type)}</b>${chip(st)}</div>
      <div class="tt-t">${esc(ag.desc || '')}</div>
      ${ag.label ? `<div class="tt-r">지금 <b>${esc(ag.label)}</b>${ag.toolSince ? ` <span class="muted">· ${dur(nowS() - ag.toolSince)}째</span>` : ''}</div>` : ''}
      <div class="tt-g"><span>출근 <b>${ago(ag.startedAt)}</b></span><span>마지막 활동 <b>${ago(ag.lastTs)}</b></span><span>도구 <b>${ag.stats ? ag.stats.tools : 0}</b></span><span>오류 <b>${ag.stats ? ag.stats.errors : 0}</b></span></div>
      <div class="tt-r muted">소속: Claude·${esc(s.meta.acct)} — ${esc(s.meta.title || '')}</div>
      ${st === 'stale' ? `<div class="tt-r warn">💤 ${prefs.staleMin}분 넘게 움직임이 없어요</div>` : ''}
      <div class="tt-f">클릭하면 지시·보고·타임라인</div>`;
  }
  if (t.kind === 'room') {
    const info = ROOM_INFO[t.room];
    if (!info) return '';
    const occ = roomOccupants(t.room);
    const recent = recentInRoom(t.room, 3);
    return `<div class="tt-h"><b>${info.icon} ${info.name}</b>${roomCount(t.room) ? `<span class="muted">방문 ${roomCount(t.room)}회</span>` : ''}</div>
      <div class="tt-t">${esc(info.desc)}</div>
      ${info.tools.length ? `<div class="tools">${info.tools.map((x) => `<code>${esc(x)}</code>`).join('')}</div>` : ''}
      ${info.visual ? `<div class="tt-r muted">${esc(info.visual)}</div>` : ''}
      ${occ.length ? `<div class="tt-r">지금 여기: ${occ.map((a) => `<b>${esc(a.name)}</b>${a.label ? ` <span class="muted">${esc(a.label)}</span>` : ''}`).join(', ')}</div>` : ''}
      ${recent.length ? `<div class="tt-l">${recent.map((e) => `<div><span class="muted">${hhmmss(e.ts)}</span> ${esc(e.who)} ${esc(e.text.slice(0, 60))}</div>`).join('')}</div>` : ''}
      <div class="tt-f">클릭하면 이 방 기록 보기</div>`;
  }
  if (t.kind === 'prop') return propTooltip(t);
  return '';
}

function propTooltip(t) {
  switch (t.id) {
    case 'board': {
      const s = currentBoard();
      if (!s) return '<div class="tt-h"><b>🗒️ 화이트보드</b></div><div class="tt-t">할 일(TodoWrite) · 계획 · 워크플로 단계가 적혀요. 아직 비어 있어요.</div>';
      return `<div class="tt-h"><b>🗒️ ${esc(s.board.title || '계획')}</b><span class="muted">by ${esc(s.meta.acct)}</span></div>
        <div class="tt-l">${s.board.items.slice(0, 8).map((it) => `<div>${it.status === 'completed' ? '☑' : it.status === 'in_progress' ? '▶' : '☐'} ${esc(it.text)}</div>`).join('')}</div><div class="tt-f">클릭하면 전체 보기</div>`;
    }
    case 'elevator': return '<div class="tt-h"><b>🛗 엘리베이터</b></div><div class="tt-t">서브에이전트가 이걸 타고 출퇴근해요. 다른 층에서 온 메시지도 여기로 와요.</div><div class="tt-f">클릭하면 층 목록</div>';
    case 'mailbox': {
      const l = S.links[S.links.length - 1];
      return `<div class="tt-h"><b>📮 우체통</b><span class="muted">${S.links.length}통</span></div><div class="tt-t">다른 층·다른 계정 세션으로 보낸 메시지가 모여요.</div>${l ? `<div class="tt-r muted">최근: ${esc(l.from.label)} → ${esc(l.to.label)}: ${esc(l.text.slice(0, 60))}</div>` : ''}<div class="tt-f">클릭하면 세션 간 대화</div>`;
    }
    case 'globe': return `<div class="tt-h"><b>🌐 지구본</b></div><div class="tt-t">웹 검색 · MCP 도구를 쓰는 동안 빨리 돌아요.</div>`;
    case 'racks': {
      const run = [...actors.values()].filter((a) => a.room === 'server' && a.running);
      return `<div class="tt-h"><b>🗄️ 서버 랙</b>${run.length ? '<span class="st ok">⚡ 실행 중</span>' : '<span class="st muted">대기</span>'}</div><div class="tt-t">명령(Bash · git)이 도는 동안 불빛이 빨라져요.</div>${run.map((a) => `<div class="tt-r"><b>${esc(a.name)}</b> ${esc(a.label)}</div>`).join('')}`;
    }
    case 'shelves': return '<div class="tt-h"><b>📚 책장</b></div><div class="tt-t">파일을 읽을 때(Read · Grep · Glob) 여기서 책을 꺼내 봐요.</div>';
    case 'userdesk': return tooltipHtml({ kind: 'actor', id: 'user' });
    default:
      if (t.id.startsWith('desk')) {
        const s = [...S.sessions.values()].find((x) => x.slot === t.slot);
        return s ? tooltipHtml({ kind: 'actor', id: 'c:' + s.sid }) : '<div class="tt-h"><b>🪑 빈자리</b></div><div class="tt-t">같은 층에서 다른 세션이 일하면 여기 앉아요.</div>';
      }
  }
  return '';
}

// ---- inspector ---------------------------------------------------------------------------
export function select(target) {
  S.selected = target;
  const panel = $('#inspector');
  if (!target) { panel.hidden = true; document.body.classList.remove('inspecting'); return; }
  if (target.kind === 'prop') {
    if (target.id === 'elevator') { $('#directory').scrollIntoView({ behavior: 'smooth' }); flash($('#floors')); }
    if (target.id === 'mailbox') setTab('chat', true);
    if (target.id === 'userdesk') target = S.selected = { kind: 'actor', id: 'user' };
    if (target.id && target.id.startsWith('desk')) {
      const s = [...S.sessions.values()].find((x) => x.slot === target.slot);
      if (s) target = S.selected = { kind: 'actor', id: 'c:' + s.sid };
    }
  }
  panel.hidden = false;
  document.body.classList.add('inspecting');
  renderInspector(true);
}

function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

let inspKey = '';
export function refreshInspector() {
  if (!S.selected || $('#inspector').hidden) return;
  renderInspector(false);
}

function renderInspector(full) {
  const t = S.selected;
  const key = JSON.stringify(t);
  if (full || key !== inspKey) {
    inspKey = key;
    $('#inspBody').innerHTML = inspectorHtml(t) || '<div class="empty">정보가 없어요</div>';
    if (t.kind === 'actor' && t.id.startsWith('c:')) loadPanes(t.id.slice(2));
    return;
  }
  // light refresh of the live bits; compared with what was last written (not innerHTML), so a <details>
  // the user opened isn't rebuilt and closed again every second
  const live = liveBits(t);
  for (const [k, v] of Object.entries(live)) {
    const el = $(`#inspBody [data-live="${k}"]`);
    if (el && (el.dataset.v ?? el.innerHTML) !== v) { el.innerHTML = v; el.dataset.v = v; }
  }
}

function statGrid(items) {
  return `<div class="stats">${items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>`;
}

function timeline(rows) {
  if (!rows.length) return '<div class="empty">아직 기록이 없어요</div>';
  return `<ol class="tl">${rows.map((e) => `<li class="${esc(e.kind || '')}"><span class="tm">${hhmmss(e.ts)}</span><span>${esc(e.text)}</span></li>`).join('')}</ol>`;
}

function liveBits(t) {
  const sm = staleMs();
  const out = {};
  if (t.kind === 'actor' && t.id.startsWith('c:')) {
    const s = S.sessions.get(t.id.slice(2));
    if (!s) return out;
    const c = s.claude || {};
    out.status = chip(statusOf(sessionEntry(s), 'claude', sm));
    out.tmux = tmuxChip(floorSess(s.sid) || s.meta);
    out.now = c.label ? `${esc(c.label)}${c.toolSince ? ` <span class="muted">· ${dur(nowS() - c.toolSince)}째</span>` : ''}` : `<span class="muted">${c.act === 'idle' ? '쉬는 중' : c.act === 'think' ? '생각 중' : '—'}</span>`;
    out.stats = statGrid([['도구 호출', s.stats.tools], ['오류', s.stats.errors], ['요청', s.stats.turns], ['입력 토큰', fmtTok(s.stats.in + s.stats.cacheRead + s.stats.cacheWrite)], ['출력 토큰', fmtTok(s.stats.out)], ['컨텍스트', fmtTok(s.stats.context)], ['마지막 활동', ago(s.lastTs)], ['모델', esc((s.stats.model || '—').replace(/^claude-/, ''))]]);
    out.agents = agentChips(s);
    const w = waitOf(s.sid);
    out.wait = w ? `<div class="wcard k-${esc(w.kind)} ${WAIT[w.kind].me ? 'me' : ''}"><div class="wc-head"><span class="wk">${WAIT[w.kind].icon} ${esc(WAIT[w.kind].label)}</span></div><div class="wc-body">${waitBodyHtml(w)}</div></div>` : '';
    out.timeline = timeline(s.log.filter((e) => e.who === 'claude' || e.who === 'user' || e.who === 'peer').slice(-40).reverse());
  } else if (t.kind === 'actor' && t.id.startsWith('a:')) {
    const { s, ag } = agentOf(t.id);
    if (!ag) return out;
    out.status = chip(statusOf(ag, 'agent', sm));
    out.now = ag.label ? `${esc(ag.label)}${ag.toolSince ? ` <span class="muted">· ${dur(nowS() - ag.toolSince)}째</span>` : ''}` : '<span class="muted">—</span>';
    out.stats = statGrid([['출근', ago(ag.startedAt)], ['일한 시간', dur((ag.doneAt || nowS()) - (ag.startedAt || nowS()))], ['마지막 활동', ago(ag.lastTs)], ['도구 호출', ag.stats ? ag.stats.tools : 0], ['오류', ag.stats ? ag.stats.errors : 0], ['토큰', fmtTok(ag.stats ? ag.stats.in + ag.stats.out + ag.stats.cacheRead + ag.stats.cacheWrite : 0)], ['컨텍스트', fmtTok(ag.stats ? ag.stats.context : 0)], ['모델', esc(((ag.stats && ag.stats.model) || '—').replace(/^claude-/, ''))]]);
    out.timeline = timeline((ag.log || []).slice(-40).reverse());
    out.report = ag.report ? `<pre>${esc(ag.report)}</pre>` : '<div class="empty">아직 보고 전이에요</div>';
    void s;
  } else if (t.kind === 'room') {
    out.occ = occList(t.room);
    out.recent = timeline(recentInRoom(t.room, 25).map((e) => ({ ...e, text: `${e.who} · ${e.text}` })));
  } else if (t.kind === 'actor' && t.id === 'user') {
    out.asks = userAsks();
  }
  return out;
}

function agentOf(id) {
  const [, sid, ...rest] = id.split(':');
  const key = rest.join(':');
  const s = S.sessions.get(sid);
  return { s, ag: s ? s.agents.get(key) : null };
}

function agentChips(s) {
  const list = [...s.agents.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 12);
  if (!list.length) return '<div class="empty">아직 부른 서브에이전트가 없어요</div>';
  return `<div class="chips">${list.map((ag) => {
    const st = statusOf(ag, 'agent', staleMs());
    return `<button class="mini" data-act="select" data-id="${esc(`a:${s.sid}:${ag.key}`)}" title="${esc(ag.desc)}">${STATUS[st].icon} ${esc(ag.type)} <span class="muted">${esc((ag.desc || '').slice(0, 18))}</span></button>`;
  }).join('')}</div>`;
}

function occList(room) {
  const occ = roomOccupants(room);
  if (!occ.length) return '<div class="empty">지금은 아무도 없어요</div>';
  return `<div class="chips">${occ.map((a) => `<button class="mini" data-act="select" data-id="${esc(a.id)}">${esc(a.name)} <span class="muted">${esc(a.label || '')}</span></button>`).join('')}</div>`;
}

function userAsks() {
  const asks = waitList().filter((x) => WAIT[x.w.kind].me);
  if (!asks.length) return '<div class="empty">지금 답을 기다리는 질문은 없어요</div>';
  return asks.slice(0, 6).map(({ s, f, w }) => {
    const a = S.accounts.get(s.akey);
    return `<div class="card warn">${WAIT[w.kind].icon} <b>Claude·${esc(a ? a.label : '')}</b> — ${esc(s.title || '')} <span class="muted">${f.num}F · ${ago(w.since)}부터</span></div>`;
  }).join('') + '<button class="mini" data-act="waitTab">✋ 결정 대기 목록 열기</button>';
}

function inspectorHtml(t) {
  if (!t) return '';
  if (t.kind === 'actor' && t.id.startsWith('c:')) {
    const sid = t.id.slice(2);
    const s = S.sessions.get(sid);
    if (!s) return '';
    const m = s.meta;
    const live = liveBits(t);
    const isPrimary = sid === S.view.primary;
    const sessionId = m.sessionId || sid; // sid is the office's key (sid@account tag)
    const resume = `cd ${shq(m.cwd || '.')} && ${m.configDir && !/\/\.claude$/.test(m.configDir) ? `CLAUDE_CONFIG_DIR=${shq(m.configDir)} ` : ''}claude --resume ${sessionId}`;
    const vs = m.cwd ? (m.host ? `vscode://vscode-remote/ssh-remote+${encodeURIComponent(m.host)}${m.cwd}` : `vscode://file${m.cwd}`) : '';
    return `
      <div class="insp-head"><span class="avatar" style="--c:${esc(m.color)}">✳</span><div><div class="title">Claude·${esc(m.acct || '')} <span data-live="tmux">${live.tmux}</span></div><div class="sub">${esc(m.title || '새 세션')}</div></div><span data-live="status">${live.status}</span></div>
      <div class="kv"><span>지금</span><b data-live="now">${live.now}</b></div>
      <div data-live="wait">${live.wait}</div>
      <div data-live="stats">${live.stats}</div>
      ${s.lastPrompt ? `<details open><summary>마지막 요청 <span class="muted">${ago(s.lastPrompt.ts)}</span></summary><pre>${esc(s.lastPrompt.text)}</pre></details>` : ''}
      <h4>서브에이전트</h4><div data-live="agents">${live.agents}</div>
      <h4>작업</h4>
      <div class="actions">
        ${isPrimary && S.view.mode === 'pin' ? '<button data-act="unpin">🔄 따라가기로</button>' : `<button data-act="pin" data-sid="${esc(sid)}">📌 이 세션 고정</button>`}
        <button data-act="follow" data-id="${esc(t.id)}">🎯 카메라 따라가기</button>
        <button data-act="copy" data-text="${esc(resume)}" title="${esc(resume)}">⌨️ 이어서 하기 명령 복사</button>
        <button data-act="copy" data-text="${esc(sessionId)}">🆔 세션 ID 복사</button>
        <button data-act="copy" data-text="${esc(m.file || '')}">📄 기록 파일 경로 복사</button>
        ${vs ? `<a class="btnlike" href="${esc(vs)}">🧩 VS Code로 폴더 열기</a>` : ''}
      </div>
      <h4>${S.config.control ? '🎮 조종 <span class="muted small">(tmux 창으로 메시지 · 멈추기)</span>' : 'tmux 창 <span class="muted small">(이 세션이 도는 창 찾기 · 읽기 전용)</span>'}</h4>
      <div id="paneBox" class="panebox"><div class="empty">찾는 중…</div></div>
      <h4>타임라인</h4><div data-live="timeline">${live.timeline}</div>`;
  }
  if (t.kind === 'actor' && t.id.startsWith('a:')) {
    const { s, ag } = agentOf(t.id);
    if (!ag || !s) return '<div class="empty">이 에이전트 기록은 이 층에 없어요</div>';
    const live = liveBits(t);
    const stopText = `백그라운드 에이전트 "${ag.desc || ag.type}"${ag.agentId ? ` (id: ${ag.agentId})` : ''}는 이제 필요 없으니 TaskStop으로 중지해줘.`;
    const hidden = isHidden(t.id);
    return `
      <div class="insp-head"><span class="avatar agent" style="--c:${esc(agentColor(ag.type))}">●</span><div><div class="title">${esc(ag.type)}</div><div class="sub">${esc(ag.desc || '')}</div></div><span data-live="status">${live.status}</span></div>
      <div class="kv"><span>지금</span><b data-live="now">${live.now}</b></div>
      <div class="kv"><span>소속</span><button class="link" data-act="select" data-id="c:${esc(s.sid)}">Claude·${esc(s.meta.acct)} — ${esc(s.meta.title || '')}</button></div>
      <div data-live="stats">${live.stats}</div>
      <details ${ag.report ? '' : 'open'}><summary>받은 지시</summary>${ag.prompt ? `<pre>${esc(ag.prompt)}</pre>` : '<div class="empty">지시 내용이 기록에 없어요</div>'}</details>
      <details ${ag.report ? 'open' : ''}><summary>보고</summary><div data-live="report">${live.report}</div></details>
      <h4>관리</h4>
      <div class="actions">
        <button data-act="follow" data-id="${esc(t.id)}">🎯 따라가기</button>
        <button data-act="home" data-id="${esc(t.id)}" title="사무실에서 내보내고 목록에서 숨겨요 (실제 작업은 멈추지 않아요)">🏠 퇴근시키기</button>
        <button data-act="hide" data-id="${esc(t.id)}">${hidden ? '👀 다시 보이기' : '🙈 숨기기'}</button>
        ${ag.agentId ? `<button data-act="copy" data-text="${esc(ag.agentId)}">🆔 에이전트 ID 복사</button>` : ''}
        ${S.config.control
          ? `<button data-act="askStop" data-sid="${esc(s.sid)}" data-text="${esc(stopText)}" title="${esc(stopText)}">🛑 소속 Claude에게 중지 요청</button>`
          : `<button data-act="copy" data-text="${esc(stopText)}" title="${esc(stopText)}">🛑 중지 요청 문구 복사</button>`}
      </div>
      <p class="hint">${S.config.control
        ? '중지 요청은 소속 Claude 패널에 문구를 채워 두기만 해요. 보내기는 직접 누르세요.'
        : '실제로 멈추려면 복사한 문구를 소속 Claude 세션에 붙여 넣으세요. 서버를 --allow-control로 켜면 화면에서 바로 보낼 수 있어요.'}</p>
      <h4>타임라인</h4><div data-live="timeline">${live.timeline}</div>`;
  }
  if (t.kind === 'actor' && t.id === 'user') {
    const live = liveBits(t);
    return `<div class="insp-head"><span class="avatar" style="--c:#7c8aa5">🧑‍💻</span><div><div class="title">나</div><div class="sub">내 자리</div></div></div>
      <h4>답을 기다리는 질문</h4><div data-live="asks">${live.asks}</div>
      <h4>최근 요청</h4>${[...S.sessions.values()].filter((s) => s.lastPrompt).map((s) => `<div class="card"><b>Claude·${esc(s.meta.acct)}</b> <span class="muted">${ago(s.lastPrompt.ts)}</span><div>${esc(s.lastPrompt.text.slice(0, 200))}</div></div>`).join('') || '<div class="empty">없음</div>'}`;
  }
  if (t.kind === 'room') {
    const info = ROOM_INFO[t.room];
    if (!info) return '';
    const live = liveBits(t);
    return `<div class="insp-head"><span class="avatar room">${info.icon}</span><div><div class="title">${info.name}</div><div class="sub">${esc(info.desc)}</div></div></div>
      ${info.tools.length ? `<h4>여기로 오는 도구</h4><div class="tools">${info.tools.map((x) => `<code>${esc(x)}</code>`).join('')}</div>` : ''}
      ${info.visual ? `<p class="hint">${esc(info.visual)}</p>` : ''}
      ${R[t.room] ? `<div class="kv"><span>이 층 방문</span><b>${roomCount(t.room)}회</b></div>` : ''}
      <h4>지금 여기</h4><div data-live="occ">${live.occ}</div>
      <h4>최근 활동</h4><div data-live="recent">${live.recent}</div>`;
  }
  if (t.kind === 'prop' && t.id === 'board') {
    const s = currentBoard();
    if (!s) return '<div class="insp-head"><span class="avatar room">🗒️</span><div><div class="title">화이트보드</div><div class="sub">아직 비어 있어요</div></div></div>';
    return `<div class="insp-head"><span class="avatar room">🗒️</span><div><div class="title">${esc(s.board.title || '계획')}</div><div class="sub">by Claude·${esc(s.meta.acct)}</div></div></div>
      <ol class="board">${s.board.items.map((it) => `<li class="${esc(it.status)}">${it.status === 'completed' ? '☑' : it.status === 'in_progress' ? '▶' : it.status === 'head' ? '' : '☐'} ${esc(it.text)}</li>`).join('')}</ol>`;
  }
  if (t.kind === 'prop') return inspectorHtml({ kind: 'room', room: t.room });
  return '';
}

function agentColor(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'explore') return '#34b07a';
  if (t === 'plan') return '#8b5cf6';
  if (t.includes('general')) return '#3b82f6';
  if (t.includes('workflow')) return '#14b8a6';
  return '#64748b';
}

// ---- tmux: find the pane; with --allow-control also type into it --------------------------
export async function controlCall(body) {
  const r = await fetch('/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-office-token': S.config.token || '' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const paneState = { sid: null, panes: [], target: null, busy: false };

async function loadPanes(sid) {
  const box = $('#paneBox');
  if (!box) return;
  const control = !!S.config.control;
  try {
    const r = control
      ? await controlCall({ action: 'panes', sid })
      : await fetch(`/api/panes?sid=${encodeURIComponent(sid)}`).then((x) => x.json());
    if (!$('#paneBox') || !S.selected || S.selected.id !== 'c:' + sid) return;
    const panes = (r.panes || []).filter((p) => p.claude);
    paneState.sid = sid;
    paneState.panes = panes;
    paneState.target = r.exact || r.bound || (!r.ambiguous && r.suggested) || null;
    if (!panes.length) {
      box.innerHTML = `<div class="empty">${r.error ? esc(r.error) + ' — ' : ''}claude가 도는 tmux 창을 못 찾았어요. tmux 밖에서 실행 중일 수 있어요.</div>`;
      return;
    }
    box.innerHTML = panes.slice(0, 6).map((p) => `
      <label class="pane ${p.id === paneState.target ? 'best' : ''}">
        <div class="pane-top">${control ? `<input type="radio" name="paneSel" value="${esc(p.id)}" ${p.id === paneState.target ? 'checked' : ''}>` : ''}
          <b>${esc(p.name)}</b> <code>${esc(p.id)}</code>
          ${p.exact ? '<span class="st ok" title="Claude Code가 남긴 세션 파일(sessions/<pid>.json)에 적힌 창이에요">정확히 일치</span>' : p.id === r.bound ? '<span class="st ok">내가 고름</span>' : p.id === r.suggested ? `<span class="st ${r.ambiguous ? 'warn' : 'ok'}">${r.ambiguous ? '추정 (확인 필요)' : '이 세션'}</span>` : ''}</div>
        <div class="muted small">${esc(p.path)} · ${esc(p.why || '')}</div>
        <div class="actions">
          <button class="mini" data-act="copy" data-text="${esc(`tmux switch-client -t ${p.name.split('.')[0]} \; select-pane -t ${p.id}`)}">🪟 이 창으로 가는 명령 복사</button>
          ${control ? '' : `<button class="mini" data-act="compose" data-pane="${esc(p.id)}">💬 메시지 명령 만들기</button>`}
        </div>
      </label>`).join('') + (control ? controlBox() : copyBox());
    if (control) {
      box.querySelectorAll('input[name=paneSel]').forEach((el) => el.addEventListener('change', () => bindPane(sid, el.value)));
      const ta = $('#ctlText');
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ctlSend(); } });
      if (S.prefill && S.prefill.sid === sid) { ta.value = S.prefill.text; S.prefill = null; ta.focus(); }
      updateTarget();
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">tmux 정보를 못 읽었어요 (${esc(e.message || e)})</div>`;
  }
}

function controlBox() {
  return `<div class="compose control">
    <div class="target">보낼 곳: <b id="ctlTarget">—</b></div>
    <textarea id="ctlText" rows="3" placeholder="이 Claude에게 보낼 메시지 (⌘/Ctrl + Enter로 보내기)"></textarea>
    <div class="actions">
      <button class="primary" data-act="ctlSend">📨 보내기</button>
      <button class="danger" data-act="ctlStop" title="그 창에 Esc를 눌러 지금 하던 일을 멈춰요">⏹ 멈추기 (Esc)</button>
    </div>
    <p class="hint">⚠️ 실제 터미널에 입력되고 Enter까지 눌려요. claude가 도는 창으로만 보낼 수 있어요.</p>
  </div>`;
}

function copyBox() {
  return `<div id="composeBox" hidden class="compose">
    <textarea id="composeText" rows="3" placeholder="이 세션에 보낼 메시지"></textarea>
    <button class="primary" data-act="composeCopy">📋 tmux 명령으로 복사</button>
    <p class="hint">복사한 명령을 터미널에 붙여 넣으면 그 창에 메시지가 입력돼요. ${S.config.controlElsewhere
      ? '조종은 서버를 켠 PC에서 연 화면에서만 할 수 있어요.'
      : '서버를 <code>--allow-control</code>로 켜면 여기서 바로 보낼 수 있어요.'}</p></div>`;
}

function updateTarget() {
  const el = $('#ctlTarget');
  if (!el) return;
  const p = paneState.panes.find((x) => x.id === paneState.target);
  el.textContent = p ? `tmux ${p.name} (${p.id})${p.exact ? ' · 정확히 일치' : ''}` : '창을 골라 주세요';
  el.classList.toggle('warnc', !p);
}

async function bindPane(sid, pane) {
  paneState.target = pane;
  updateTarget();
  try { await controlCall({ action: 'bind', sid, pane }); } catch (e) { toast('⚠️ ' + e.message); }
}

async function ctlSend() {
  const ta = $('#ctlText');
  const text = ta ? ta.value.trim() : '';
  if (!text || paneState.busy) return;
  if (!paneState.target) { toast('보낼 tmux 창을 먼저 골라 주세요'); return; }
  paneState.busy = true;
  try {
    const r = await controlCall({ action: 'send', sid: paneState.sid, pane: paneState.target, text });
    toast(`📨 ${r.name || r.pane} 창에 보냈어요`);
    ta.value = '';
  } catch (e) { toast('⚠️ ' + e.message, 5000); } finally { paneState.busy = false; }
}

async function ctlStop() {
  if (!paneState.target) { toast('멈출 tmux 창을 먼저 골라 주세요'); return; }
  const p = paneState.panes.find((x) => x.id === paneState.target);
  if (!confirm(`${p ? p.name : paneState.target} 창의 Claude를 멈출까요? (Esc를 누릅니다)`)) return;
  try {
    const r = await controlCall({ action: 'interrupt', sid: paneState.sid, pane: paneState.target });
    toast(`⏹ ${r.name || r.pane} 창에 Esc를 보냈어요`);
  } catch (e) { toast('⚠️ ' + e.message, 5000); }
}

let composePane = null;
function onInspectorClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'copy') { copyText(b.dataset.text || '').then(() => toast('📋 복사했어요')); return; }
  if (act === 'select') { focusActor(b.dataset.id); return; }
  if (act === 'follow') { cam.follow = b.dataset.id; if (cam.zoom < 1.6) setZoom(1.8); toast('🎯 따라가는 중 — 배경을 드래그하면 멈춰요'); return; }
  if (act === 'pin') { H.selectSession(b.dataset.sid); return; }
  if (act === 'unpin') { H.selectFloor(S.view.floor, true); return; }
  if (act === 'home') { sendHome(b.dataset.id); setHidden(b.dataset.id, true); toast('🏠 퇴근시켰어요 (숨김 목록에서 되돌릴 수 있어요)'); select(null); renderAgents(); return; }
  if (act === 'hide') { const on = !isHidden(b.dataset.id); setHidden(b.dataset.id, on); if (on) dropActor(b.dataset.id); renderInspector(true); renderAgents(); return; }
  if (act === 'waitTab') { setTab('wait', true); return; }
  if (act === 'ctlSend') { ctlSend(); return; }
  if (act === 'ctlStop') { ctlStop(); return; }
  if (act === 'askStop') {
    // Hand the stop request to the parent Claude: open its panel with the message ready to send.
    S.prefill = { sid: b.dataset.sid, text: b.dataset.text };
    focusActor('c:' + b.dataset.sid);
    toast('🛑 소속 Claude 패널에 중지 요청 문구를 넣어 뒀어요. 확인하고 보내기를 누르세요');
    return;
  }
  if (act === 'compose') { composePane = b.dataset.pane; const c = $('#composeBox'); c.hidden = false; $('#composeText').focus(); return; }
  if (act === 'composeCopy') {
    const text = $('#composeText').value.trim();
    if (!text || !composePane) return;
    const cmd = text.includes('\n')
      ? `tmux set-buffer -b office ${shq(text)} && tmux paste-buffer -p -d -b office -t ${composePane} && tmux send-keys -t ${composePane} Enter`
      : `tmux send-keys -t ${composePane} -l ${shq(text)} && tmux send-keys -t ${composePane} Enter`;
    copyText(cmd).then(() => toast('📋 tmux 명령을 복사했어요. 터미널에 붙여 넣으세요'));
  }
}

function dropActor(id) {
  const a = actors.get(id);
  if (a) { releaseSpot(a); actors.delete(id); }
}

export function focusActor(id) {
  if (!actors.has(id) && !(id.startsWith('a:') && agentOf(id).ag)) { toast('이 층에 없는 캐릭터예요'); return; }
  select({ kind: 'actor', id });
  const a = actors.get(id);
  if (a) {
    const [sx, sy] = screenOf(a.x, a.y, 0);
    if (sx < 40 || sy < 40 || sx > cam.w - 40 || sy > cam.h - 40) { cam.follow = id; setTimeout(() => { if (cam.follow === id) cam.follow = null; }, 1200); }
  }
}

function onFeedClick(e) {
  const li = e.target.closest('[data-actor]');
  if (li) focusActor(li.dataset.actor);
}

// ---- activity log ---------------------------------------------------------------------
let logTimer = 0;
export function scheduleLog() {
  if (logTimer) return;
  logTimer = setTimeout(() => { logTimer = 0; if (prefs.tab === 'log') renderLog(); }, 300);
}
export function renderLog() {
  const q = ($('#logSearch').value || '').trim().toLowerCase();
  const room = prefs.logRoom;
  const rows = [];
  const multi = S.sessions.size > 1;
  for (const s of S.sessions.values()) {
    for (const e of s.log) {
      const who = e.who === 'claude' ? (multi ? `Claude·${s.meta.acct}` : 'Claude') : e.who === 'user' ? '나' : e.who === 'peer' ? '동료' : e.who;
      const actor = e.who === 'claude' ? 'c:' + s.sid : e.agent ? `a:${s.sid}:${e.agent}` : '';
      rows.push({ e, who, color: s.meta.color, actor });
    }
    if (prefs.logAgents) {
      for (const ag of s.agents.values()) for (const e of ag.log || []) rows.push({ e, who: ag.type, color: s.meta.color, actor: `a:${s.sid}:${ag.key}`, sub: true });
    }
  }
  const filtered = rows.filter(({ e, who }) => (room === 'all' || e.room === room) && (!q || e.text.toLowerCase().includes(q) || who.toLowerCase().includes(q)))
    .sort((a, b) => b.e.ts - a.e.ts).slice(0, 200);
  $('#log').innerHTML = filtered.map(({ e, who, color, actor, sub }) => `<li class="${esc(e.kind)} ${sub ? 'sub' : ''}" ${actor ? `data-actor="${esc(actor)}"` : ''}>
    <span class="tm">${hhmmss(e.ts)}</span><i class="sd" style="background:${esc(color)}"></i>
    <span class="tx"><span class="who">${esc(who)}</span>${e.room && ROOM_INFO[e.room] ? `<span class="rm">${ROOM_INFO[e.room].icon}</span>` : ''}${esc(e.text)}</span></li>`).join('')
    || '<li class="empty">조건에 맞는 기록이 없어요</li>';
}

// ---- session chat ----------------------------------------------------------------------
export function renderChat() {
  const here = new Set(S.sessions.keys());
  const list = [...S.links].reverse().slice(0, 150);
  $('#chatCount').textContent = S.links.length ? S.links.length : '';
  const lbl = (r) => `<span class="acct" style="--c:${esc(r.color || '#94a3b8')}">${esc(r.acct || '?')}</span>${esc(r.label)}${r.floor ? ` <span class="muted">${r.floor}F</span>` : ''}`;
  $('#chat').innerHTML = list.map((l) => `<li class="${here.has(l.from.sid) || here.has(l.to.sid) ? 'here' : ''}" ${l.from.sid && here.has(l.from.sid) ? `data-actor="c:${esc(l.from.sid)}"` : ''}>
    <span class="tm">${hhmmss(l.ts)}</span>
    <div><div class="route">${lbl(l.from)}<span class="arrow">→</span>${l.to.sid ? lbl(l.to) : `<span>📮 ${esc(l.to.label)}</span>`}<span class="muted">· ${esc(l.via)}</span></div>
    <div class="body">${esc(l.text)}</div></div></li>`).join('')
    || '<li class="empty">다른 세션(계정)과 주고받은 메시지가 여기 쌓여요.<br>tmux send-keys · SendMessage 로 보낸 내용을 받는 쪽 프롬프트와 맞춰 찾아냅니다.</li>';
}

// ---- agent monitor -----------------------------------------------------------------------
function fleetRows() {
  const sm = staleMs();
  const rows = [];
  const scopeFloor = prefs.scope === 'floor';
  const live = new Map([...S.sessions.values()].map((s) => [s.sid, s]));
  for (const f of S.fleet) {
    if (scopeFloor && f.fkey !== S.view.floor) continue;
    const s = live.get(f.sid);
    const busy = s ? s.busy : f.busy;
    const act = s ? s.claude.act : f.act;
    const lastTs = s ? s.lastTs : f.lastTs;
    const stats = s ? s.stats : f.stats;
    rows.push({
      id: 'c:' + f.sid, kind: 'claude', sid: f.sid, fkey: f.fkey, floor: f.floor, name: `Claude·${f.acct}`, color: f.color,
      type: 'Claude', desc: f.title, label: s ? s.claude.label : f.label, status: statusOf({ busy, act, lastTs }, 'claude', sm),
      startedAt: f.firstTs, lastTs, toolSince: s ? s.claude.toolSince : f.toolSince, tools: stats.tools, errors: stats.errors,
      tokens: stats.in + stats.out + stats.cacheRead + stats.cacheWrite, context: stats.context, session: f.title,
    });
    const agents = s ? [...s.agents.values()] : f.agents;
    for (const ag of agents) {
      const tokens = ag.stats ? ag.stats.in + ag.stats.out + ag.stats.cacheRead + ag.stats.cacheWrite : ag.tokens || 0;
      rows.push({
        id: `a:${f.sid}:${ag.key}`, kind: 'agent', sid: f.sid, fkey: f.fkey, floor: f.floor, name: ag.type, color: agentColor(ag.type),
        type: ag.type, desc: ag.desc, label: ag.label, status: statusOf(ag, 'agent', sm), startedAt: ag.startedAt, lastTs: ag.lastTs,
        toolSince: ag.toolSince, tools: ag.stats ? ag.stats.tools : ag.tools || 0, errors: ag.stats ? ag.stats.errors : ag.errors || 0,
        tokens, context: ag.stats ? ag.stats.context : ag.context || 0, session: f.title, owner: f.acct, background: ag.background,
      });
    }
  }
  return rows;
}

let agentsHtmlKey = '';
export function renderAgents(force) {
  const rows = fleetRows();
  const stale = rows.filter((r) => r.status === 'stale' && !isHidden(r.id));
  $('#staleBtn').hidden = !stale.length;
  $('#staleCount').textContent = stale.length;
  const workingAgents = rows.filter((r) => r.kind === 'agent' && ['working', 'thinking', 'arriving', 'reporting'].includes(r.status)).length;
  $('#agentsCount').textContent = workingAgents || '';
  if (prefs.tab !== 'agents' && !force) return;
  const q = ($('#agentSearch').value || '').trim().toLowerCase();
  const f = prefs.agentFilter;
  const group = (st) => (['working', 'thinking', 'arriving', 'reporting', 'asking'].includes(st) ? 'active' : st === 'stale' ? 'stale' : ['done', 'failed', 'lost'].includes(st) ? 'done' : 'idle');
  let list = rows.filter((r) => (S.showHidden || !isHidden(r.id))
    && (f === 'all' || group(r.status) === f || (f === 'agents' && r.kind === 'agent'))
    && (!q || `${r.name} ${r.desc} ${r.label} ${r.session}`.toLowerCase().includes(q)));
  const keyFn = { name: (r) => r.name, status: (r) => r.status, started: (r) => r.startedAt || 0, last: (r) => r.lastTs || 0, tools: (r) => r.tools, errors: (r) => r.errors, tokens: (r) => r.tokens, floor: (r) => r.floor || 0 }[prefs.sortKey] || ((r) => r.lastTs || 0);
  list.sort((a, b) => { const x = keyFn(a); const y = keyFn(b); return (x > y ? 1 : x < y ? -1 : 0) * prefs.sortDir; });
  $$('#agentFilters [data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === f));
  $$('#agentScope [data-scope]').forEach((b) => b.classList.toggle('on', b.dataset.scope === prefs.scope));
  const counts = { all: rows.length, active: rows.filter((r) => group(r.status) === 'active').length, stale: rows.filter((r) => group(r.status) === 'stale').length, done: rows.filter((r) => group(r.status) === 'done').length };
  $$('#agentFilters [data-filter]').forEach((b) => { const c = counts[b.dataset.filter]; const sp = b.querySelector('i'); if (sp) sp.textContent = c != null ? c : ''; });
  const hiddenN = rows.filter((r) => isHidden(r.id)).length;
  $('#hiddenCount').textContent = hiddenN ? `(${hiddenN})` : '';
  const sortMark = (k) => (prefs.sortKey === k ? (prefs.sortDir > 0 ? ' ▲' : ' ▼') : '');
  const html = `<thead><tr>
      <th data-sort="status">상태${sortMark('status')}</th><th data-sort="name">이름${sortMark('name')}</th><th>하는 일</th>
      ${prefs.scope === 'all' ? `<th data-sort="floor" class="opt">층${sortMark('floor')}</th>` : ''}
      <th data-sort="started" class="opt">출근${sortMark('started')}</th><th data-sort="last">마지막 활동${sortMark('last')}</th>
      <th data-sort="tools" class="num opt">도구${sortMark('tools')}</th><th data-sort="errors" class="num">오류${sortMark('errors')}</th><th data-sort="tokens" class="num opt">토큰${sortMark('tokens')}</th><th></th></tr></thead>
    <tbody>${list.map((r) => {
      const st = STATUS[r.status] || STATUS.idle;
      const here = actors.has(r.id);
      return `<tr data-id="${esc(r.id)}" class="${r.kind} ${st.cls} ${isHidden(r.id) ? 'hiddenrow' : ''}">
        <td><span class="st ${st.cls}">${st.icon} ${st.label}</span></td>
        <td><i class="sd" style="background:${esc(r.color)}"></i><b>${esc(r.name)}</b>${r.kind === 'agent' ? `<div class="muted small">${esc(r.owner ? 'Claude·' + r.owner : '')}</div>` : ''}</td>
        <td class="desc"><div>${esc(r.desc || '')}</div>${r.label ? `<div class="muted small">${esc(r.label)}${r.toolSince ? ` · ${dur(nowS() - r.toolSince)}째` : ''}</div>` : ''}</td>
        ${prefs.scope === 'all' ? `<td class="opt">${r.floor ? r.floor + 'F' : ''}</td>` : ''}
        <td class="small opt">${ago(r.startedAt)}</td><td class="small ${r.status === 'stale' ? 'warnc' : ''}">${ago(r.lastTs)}</td>
        <td class="num opt">${r.tools}</td><td class="num ${r.errors ? 'badc' : ''}">${r.errors}</td><td class="num opt">${fmtTok(r.tokens)}</td>
        <td class="row-actions">
          <button class="icon" data-act="view" title="${here ? '사무실에서 보기' : '자세히 보기'}">👁</button>
          ${r.kind === 'agent' ? `<button class="icon" data-act="home" title="퇴근시키기 (숨김)">🏠</button><button class="icon" data-act="hide" title="${isHidden(r.id) ? '다시 보이기' : '숨기기'}">${isHidden(r.id) ? '👀' : '🙈'}</button>` : ''}
        </td></tr>`;
    }).join('')}</tbody>`;
  if (!list.length) {
    $('#agentTable').innerHTML = `<tbody><tr><td class="empty">${rows.length ? '조건에 맞는 항목이 없어요' : '최근 15분 안에 움직인 세션이 없어요'}</td></tr></tbody>`;
    agentsHtmlKey = '';
    return;
  }
  if (html !== agentsHtmlKey) { $('#agentTable').innerHTML = html; agentsHtmlKey = html; }
}

function onAgentTableClick(e) {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    if (prefs.sortKey === k) prefs.sortDir *= -1; else { prefs.sortKey = k; prefs.sortDir = k === 'name' || k === 'status' ? 1 : -1; }
    savePrefs(); renderAgents(true); return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  const btn = e.target.closest('[data-act]');
  const act = btn ? btn.dataset.act : 'view';
  if (act === 'home') { sendHome(id); setHidden(id, true); toast('🏠 퇴근시켰어요'); renderAgents(true); return; }
  if (act === 'hide') { const on = !isHidden(id); setHidden(id, on); if (on) dropActor(id); renderAgents(true); return; }
  const row = fleetRows().find((r) => r.id === id);
  if (row && row.fkey !== S.view.floor) { S.pendingSelect = id; H.selectFloor(row.fkey); return; }
  focusActor(id);
}

function bulk(kind) {
  const rows = fleetRows().filter((r) => r.kind === 'agent' && !isHidden(r.id));
  const pick = kind === 'stale' ? rows.filter((r) => r.status === 'stale') : rows.filter((r) => ['done', 'failed', 'lost'].includes(r.status));
  for (const r of pick) { sendHome(r.id); setHidden(r.id, true); }
  toast(pick.length ? `${kind === 'stale' ? '💤 멈춘' : '✅ 끝난'} 에이전트 ${pick.length}개를 정리했어요` : '정리할 항목이 없어요');
  renderAgents(true);
}

// ---- notifications --------------------------------------------------------------------------
async function toggleNotify() {
  if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않아요'); return; }
  if (!prefs.notify) {
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    prefs.notify = p === 'granted';
    toast(prefs.notify ? '🔔 질문이 오거나 작업이 끝나면 알려 드릴게요' : '알림 권한이 없어요');
  } else { prefs.notify = false; toast('🔕 알림을 껐어요'); }
  savePrefs(); syncToggles();
}

const seenStale = new Set();
export function onFleet(prev, next) {
  const before = new Map(prev.map((s) => [s.sid, s]));
  for (const s of next) {
    const p = before.get(s.sid);
    if (!p) continue;
    const name = `Claude·${s.acct} — ${s.title || '세션'}`;
    // Questions and approvals are announced from the floor guide's wait states (manage.js).
    if (p.busy && !s.busy && !waitOf(s.sid)) notify(`✅ ${name}`, '작업이 끝났어요', s);
  }
  const sm = staleMs();
  for (const s of next) for (const a of s.agents) {
    const id = `a:${s.sid}:${a.key}`;
    if (statusOf(a, 'agent', sm) === 'stale' && !seenStale.has(id) && !isHidden(id)) {
      seenStale.add(id);
      toast(`💤 ${a.type} "${(a.desc || '').slice(0, 24)}" 가 ${prefs.staleMin}분째 조용해요 — 에이전트 탭에서 정리할 수 있어요`, 5000);
    }
  }
}

export function notify(title, body, s) {
  if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) { toast(`${title}: ${body}`); return; }
  try {
    const n = new Notification(title, { body: String(body).slice(0, 140), tag: s.sid });
    n.onclick = () => { window.focus(); if (s.fkey !== S.view.floor) H.selectFloor(s.fkey); n.close(); };
  } catch {}
}

// ---- settings ---------------------------------------------------------------------------------
function openSettings() {
  const m = $('#settings');
  m.hidden = false;
  $('#staleSel').value = String(prefs.staleMin);
  $('#coworkersToggle').checked = prefs.coworkers;
  $('#hiddenTotal').textContent = prefs.hidden.length;
}
export function initSettings(onCoworkers) {
  $('#settings .close').addEventListener('click', () => { $('#settings').hidden = true; });
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; });
  $('#staleSel').addEventListener('change', (e) => { prefs.staleMin = Number(e.target.value) || 5; savePrefs(); renderAgents(true); });
  $('#coworkersToggle').addEventListener('change', (e) => { prefs.coworkers = e.target.checked; savePrefs(); onCoworkers(); });
  $('#resetHidden').addEventListener('click', () => { prefs.hidden = []; savePrefs(); $('#hiddenTotal').textContent = '0'; toast('숨김 목록을 비웠어요'); renderAgents(true); });
}

// ---- floor switch overlay -------------------------------------------------------------------
let overlayOpenAt = 0;
export function closeElevatorOverlay(f) {
  const ov = $('#elevatorOverlay');
  $('#evArrow').textContent = f && f.num < (S.view.num || 0) ? '▼' : '▲';
  $('#evNum').textContent = f ? `${f.num}F` : '';
  $('#evName').textContent = f ? f.name : '';
  ov.classList.add('closed');
  overlayOpenAt = performance.now() + 900;
}
export function openElevatorOverlay() {
  const ov = $('#elevatorOverlay');
  if (!ov.classList.contains('closed')) return;
  setTimeout(() => ov.classList.remove('closed'), Math.max(0, overlayOpenAt - performance.now()));
}

