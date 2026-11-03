// The "✋ waiting on you" inbox (every floor, account and host) and the session manager:
// every session in the building, with closing them and moving them to the trash (--allow-control).
import { $, $$, S, esc, ago, copyText } from './state.js';
import { WAIT, waitList, waitBodyHtml } from './status.js';
import { toast, controlCall, notify, setTab } from './ui.js';

let H = {}; // selectSession(sid), selectFloor(fkey) from main.js
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function initManage(handlers) {
  H = handlers;
  $('#waitBtn').addEventListener('click', () => setTab('wait', true));
  $('[data-tab="wait"]').addEventListener('click', () => renderWaits(true));
  $('#waitList').addEventListener('click', onWaitClick);
  $('#waitList').addEventListener('input', (e) => { const ta = e.target.closest('textarea[data-sid]'); if (ta) drafts.set(ta.dataset.sid, ta.value); });
  $('#waitList').addEventListener('keydown', (e) => {
    const ta = e.target.closest('textarea[data-sid]');
    if (ta && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(ta.dataset.sid); }
  });
  $('#sessMgrBtn').addEventListener('click', openManager);
  $('#dirMgrBtn').addEventListener('click', () => { document.body.classList.remove('drawer-open'); openManager(); });
  $('#sessMgr .close').addEventListener('click', closeManager);
  $('#sessMgr').addEventListener('click', (e) => { if (e.target.id === 'sessMgr') closeManager(); });
  $$('#smFilter [data-f]').forEach((b) => b.addEventListener('click', () => { sm.filter = b.dataset.f; renderManager(); }));
  $('#smDays').addEventListener('change', (e) => { sm.days = Number(e.target.value) || 7; renderManager(); });
  $('#smSearch').addEventListener('input', () => renderManager());
  $('#smAll').addEventListener('change', (e) => {
    for (const r of visibleRows()) if (e.target.checked) sm.sel.add(r.sid); else sm.sel.delete(r.sid);
    renderManager();
  });
  $('#smTable').addEventListener('click', onTableClick);
  $('#smTrash').addEventListener('click', onTrashClick);
  $$('#sessMgr [data-sm]').forEach((b) => b.addEventListener('click', () => bulk(b.dataset.sm)));
  setInterval(() => { renderWaits(false); if (!$('#sessMgr').hidden) loadManager(); }, 1000);
}

// ---- ✋ inbox -------------------------------------------------------------------------------------
const drafts = new Map(); // sid -> unsent reply text, kept across re-renders
let waitKey = '';
const seenWaits = new Set();
let firstFloors = true;

function where(s, f) {
  const a = S.accounts.get(s.akey);
  return `${a ? `<span class="acct" style="--c:${esc(a.color)}">${esc(a.label)}</span>` : ''}<span class="muted">${f.num}F ${esc(f.name)}${f.host ? ` · 🖥 ${esc(f.host)}` : ''}${s.tmux ? ` · 🪟 ${esc(s.tmux.name || s.tmux.session)}` : ''}</span>`;
}

function gotoCmd(s, f) {
  if (!s.tmux) return '';
  return f.host ? `ssh -t ${f.host} tmux attach -t ${shq(s.tmux.session)}` : `tmux switch-client -t ${shq(s.tmux.session)} \\; select-pane -t ${s.tmux.pane}`;
}

export function renderWaits(force) {
  const list = waitList();
  const mine = list.filter((x) => WAIT[x.w.kind].me).length;
  $('#waitCount').textContent = list.length || '';
  $('#waitBtn').hidden = !mine;
  $('#waitBtnCount').textContent = mine;
  document.title = mine ? `(✋${mine}) Claude Office` : 'Claude Office';
  for (const el of $$('#waitList [data-since]')) el.textContent = ago(Number(el.dataset.since)) + '부터';
  const control = !!S.config.control;
  // Rebuilt only when something changes, so a half-typed reply survives.
  const key = JSON.stringify([control, list.map((x) => [x.s.sid, x.w, x.s.tmux, x.s.title])]);
  if (key === waitKey && !force) return;
  waitKey = key;
  const focused = document.activeElement && document.activeElement.closest('#waitList textarea[data-sid]');
  const focusSid = focused ? focused.dataset.sid : null;
  const openShots = new Set($$('#waitList .wcard details[open]').map((d) => d.closest('[data-sid]').dataset.sid + '|' + d.className));
  const card = ({ s, f, w }) => {
    const m = WAIT[w.kind];
    const cmd = gotoCmd(s, f);
    // Typing needs the tmux pane Claude's status file names; without tmux there is nowhere to type.
    const canReply = control && (w.kind === 'reply' || w.kind === 'peer') && s.live && s.tmux;
    const canEsc = control && ['permission', 'question', 'plan', 'dialog'].includes(w.kind) && s.live && s.tmux;
    return `<div class="wcard k-${esc(w.kind)} ${m.me ? 'me' : ''}" data-sid="${esc(s.sid)}">
      <div class="wc-head"><span class="wk">${m.icon} ${esc(m.label)}</span><b class="wt">${esc(s.title || '새 세션')}</b><span class="since" data-since="${Number(w.since) || 0}">${ago(w.since)}부터</span></div>
      <div class="wc-where">${where(s, f)}</div>
      <div class="wc-body">${waitBodyHtml(w)}</div>
      ${canReply ? `<div class="compose control"><textarea rows="2" data-sid="${esc(s.sid)}" placeholder="이 Claude에게 답장 (⌘/Ctrl + Enter로 보내기)">${esc(drafts.get(s.sid) || '')}</textarea></div>` : ''}
      <div class="actions">
        <button class="mini" data-w="go">👁 보러 가기</button>
        ${cmd ? `<button class="mini" data-w="copy" data-text="${esc(cmd)}" title="${esc(cmd)}">🪟 그 tmux 창으로 가는 명령 복사</button>` : ''}
        ${canReply ? '<button class="mini primary" data-w="reply">📨 답장 보내기</button>' : ''}
        ${canEsc ? `<button class="mini danger" data-w="esc" title="그 창에 Esc를 눌러 이 요청을 거절·취소해요">⏹ 거절·취소 (Esc)</button>` : ''}
      </div>
      ${m.me && !canReply && !canEsc ? `<p class="hint">${!control ? '답·선택·승인은 그 터미널에서 해 주세요.' : s.live && !s.tmux ? 'tmux 밖에서 도는 세션이라 여기서 보낼 수 없어요. 그 터미널에서 답해 주세요.' : '그 터미널에서 답해 주세요.'}</p>` : ''}
      ${canEsc ? '<p class="hint">선택·승인은 그 터미널에서 해 주세요. 여기서는 거절·취소(Esc)만 보낼 수 있어요.</p>' : ''}
    </div>`;
  };
  const me = list.filter((x) => WAIT[x.w.kind].me);
  const peer = list.filter((x) => !WAIT[x.w.kind].me);
  $('#waitList').innerHTML = !list.length
    ? '<div class="empty">지금 내 결정이나 답을 기다리는 세션은 없어요 🎉</div>'
    : `${me.length ? `<h4>내 차례 <span class="muted">${me.length}</span></h4>${me.map(card).join('')}` : ''}
       ${peer.length ? `<h4>세션끼리 기다리는 중 <span class="muted">${peer.length}</span></h4>${peer.map(card).join('')}` : ''}`;
  for (const d of $$('#waitList .wcard details')) if (openShots.has(d.closest('[data-sid]').dataset.sid + '|' + d.className)) d.open = true;
  if (focusSid) {
    const ta = $(`#waitList textarea[data-sid="${CSS.escape(focusSid)}"]`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

// Called whenever the floor guide updates: announce waits that are new since the last update.
export function onFloorsWait() {
  const now = new Set();
  for (const { s, f, w } of waitList()) {
    const k = `${s.sid}|${w.kind}|${w.since}`;
    now.add(k);
    if (seenWaits.has(k) || firstFloors) continue;
    const m = WAIT[w.kind];
    const a = S.accounts.get(s.akey);
    const what = w.kind === 'question' ? (w.questions && w.questions[0] && w.questions[0].q) : w.kind === 'permission' ? (w.tool && (w.tool.label || w.tool.name)) : w.kind === 'peer' ? `${w.target}의 답` : (w.text || '').slice(-120);
    if (!m.me) continue;
    const title = `${m.icon} ${m.label} — Claude·${a ? a.label : ''} ${s.title || ''}`;
    if (document.visibilityState === 'visible') toast(`${title}: ${String(what || '').slice(0, 80)}`, 5000);
    notify(title, what || '확인해 주세요', { sid: s.sid, fkey: f.fkey });
  }
  firstFloors = false;
  seenWaits.clear();
  for (const k of now) seenWaits.add(k);
  renderWaits(false);
}

function onWaitClick(e) {
  const b = e.target.closest('[data-w]');
  if (!b) return;
  const sid = b.closest('[data-sid]').dataset.sid;
  const act = b.dataset.w;
  if (act === 'go') { S.pendingSelect = 'c:' + sid; H.selectSession(sid); return; }
  if (act === 'copy') { copyText(b.dataset.text).then(() => toast('📋 복사했어요. 터미널에 붙여 넣으세요')); return; }
  if (act === 'reply') { sendReply(sid); return; }
  if (act === 'esc') {
    if (!confirm('그 창에 Esc를 눌러 이 요청을 거절·취소할까요?')) return;
    controlCall({ action: 'interrupt', sid }).then((r) => toast(`⏹ ${r.name || r.pane} 창에 Esc를 보냈어요`)).catch((err) => toast('⚠️ ' + err.message, 5000));
  }
}

async function sendReply(sid) {
  const ta = $(`#waitList textarea[data-sid="${CSS.escape(sid)}"]`);
  const text = ta ? ta.value.trim() : '';
  if (!text) { toast('보낼 내용을 적어 주세요'); return; }
  try {
    const r = await controlCall({ action: 'send', sid, text });
    drafts.delete(sid);
    if (ta) ta.value = '';
    toast(`📨 ${r.name || r.pane} 창에 보냈어요`);
  } catch (err) { toast('⚠️ ' + err.message, 5000); }
}

// ---- 🗂️ session manager ------------------------------------------------------------------------
const sm = { filter: 'all', days: 7, sel: new Set(), rows: [], trash: [], loading: false, key: '', busy: false };

function openManager() {
  $('#sessMgr').hidden = false;
  $('#smDays').value = String(sm.days);
  loadManager(true);
}
export function closeManager() { $('#sessMgr').hidden = true; }

async function loadManager(first) {
  if (sm.loading) return;
  sm.loading = true;
  try {
    const r = await fetch('/api/sessions').then((x) => x.json());
    sm.rows = r.sessions || [];
    sm.trash = r.trash || [];
    const ids = new Set(sm.rows.map((x) => x.sid));
    for (const id of [...sm.sel]) if (!ids.has(id)) sm.sel.delete(id);
    renderManager(first);
  } catch (e) {
    if (first) $('#smTable').innerHTML = `<tbody><tr><td class="empty">목록을 못 불러왔어요 (${esc(e.message)})</td></tr></tbody>`;
  } finally { sm.loading = false; }
}

const DAY = 86400000;
const isOld = (r) => !r.proc && Date.now() - r.mtime > sm.days * DAY;
function stateOf(r) {
  if (r.wait && WAIT[r.wait]) return { cls: 'warn', text: `${WAIT[r.wait].icon} ${WAIT[r.wait].label}` };
  if (!r.proc) return { cls: 'muted', text: '⚪ 꺼짐' };
  if (r.proc.status === 'waiting') return { cls: 'warn', text: '✋ 응답 대기' };
  if (r.proc.status === 'idle' || !r.proc.status) return { cls: 'idle', text: '🟡 열려 있음' };
  return { cls: 'ok', text: r.proc.status === 'shell' ? '🟢 명령 실행 중' : '🟢 일하는 중' };
}

function visibleRows() {
  const q = ($('#smSearch').value || '').trim().toLowerCase();
  const f = sm.filter;
  return sm.rows.filter((r) => (f === 'all' || (f === 'live' && r.proc) || (f === 'wait' && r.wait) || (f === 'closed' && !r.proc) || (f === 'old' && isOld(r)))
    && (!q || [r.title, r.firstPrompt, r.cwd, r.floorName, r.acct, r.host, r.sessionId, r.proc && r.proc.tmux && r.proc.tmux.session].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.mtime - a.mtime);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function renderManager(force) {
  const control = !!S.config.control;
  const rows = visibleRows();
  const counts = { all: sm.rows.length, live: sm.rows.filter((r) => r.proc).length, wait: sm.rows.filter((r) => r.wait).length, closed: sm.rows.filter((r) => !r.proc).length, old: sm.rows.filter(isOld).length };
  $$('#smFilter [data-f]').forEach((b) => { b.classList.toggle('on', b.dataset.f === sm.filter); b.querySelector('i').textContent = counts[b.dataset.f]; });
  const totalSize = sm.rows.reduce((t, r) => t + (r.size || 0), 0);
  $('#smSummary').textContent = `세션 ${counts.all}개 · 열려 있음 ${counts.live} · 기록 ${fmtSize(totalSize)}`;
  const sel = sm.rows.filter((r) => sm.sel.has(r.sid));
  $('#smSel').textContent = `${sel.length}개 선택`;
  $('#smAll').checked = rows.length > 0 && rows.every((r) => sm.sel.has(r.sid));
  $$('#sessMgr [data-sm]').forEach((b) => { b.disabled = !control || !sel.length || sm.busy; });
  $('#smHint').innerHTML = control
    ? '⏏ <b>종료</b>는 그 세션의 claude를 끝내요(기록은 남아요). 🗑 <b>휴지통으로</b>는 기록을 설정 폴더의 <code>office-trash/</code>로 옮겨 Claude 목록(<code>/resume</code>)에서 빼요 — 아래 휴지통에서 되돌릴 수 있어요. 터미널에서 연 세션만 다룰 수 있고, 데스크톱 앱 · IDE 세션은 그 앱에서 정리하세요.'
    : '보기 전용이에요. 종료 · 정리는 서버를 <code>--allow-control</code>로 켜고 서버를 켠 PC에서 연 화면에서 할 수 있어요.';
  const html = `<thead><tr><th class="ck"></th><th>상태</th><th>세션</th><th class="opt">계정</th><th class="opt">위치</th><th>마지막 활동</th><th class="num opt">크기</th><th></th></tr></thead>
    <tbody>${rows.map((r) => {
      const st = stateOf(r);
      const tm = r.proc && r.proc.tmux;
      const can = control && r.manageable;
      return `<tr data-sid="${esc(r.sid)}" class="${sm.sel.has(r.sid) ? 'sel' : ''} ${isOld(r) ? 'oldrow' : ''}">
        <td class="ck"><input type="checkbox" ${sm.sel.has(r.sid) ? 'checked' : ''} ${r.manageable ? '' : 'disabled title="데스크톱 앱 · IDE 세션"'}></td>
        <td><span class="st ${st.cls}">${st.text}</span></td>
        <td class="desc"><div><b>${esc(r.title || r.firstPrompt || '(제목 없음)')}</b></div>
          <div class="muted small">${r.title && r.firstPrompt ? esc(r.firstPrompt) + ' · ' : ''}<code>${esc(r.sessionId.slice(0, 8))}</code>${r.manageable ? '' : ` · 🖥 ${esc(r.entry)}`}</div></td>
        <td class="opt"><span class="acct" style="--c:${esc(r.color)}">${esc(r.acct)}</span></td>
        <td class="opt small">${r.floor ? `${r.floor}F ` : ''}${esc(r.floorName)}${r.host ? `<div class="muted">🖥 ${esc(r.host)}</div>` : ''}${tm ? `<div class="muted">🪟 ${esc(tm.name || tm.session)}</div>` : ''}</td>
        <td class="small">${esc(ago(r.mtime))}</td>
        <td class="num opt small">${fmtSize(r.size || 0)}</td>
        <td class="row-actions">
          <button class="icon" data-r="view" title="사무실에서 보기">👁</button>
          ${r.proc ? `<button class="icon" data-r="terminate" ${can ? '' : 'disabled'} title="종료 — claude를 끝내요">⏏</button>` : ''}
          <button class="icon" data-r="trash" ${can ? '' : 'disabled'} title="${r.proc ? '종료하고 휴지통으로' : '휴지통으로'}">🗑</button>
        </td></tr>`;
    }).join('') || `<tr><td colspan="8" class="empty">${sm.rows.length ? '조건에 맞는 세션이 없어요' : '세션이 없어요'}</td></tr>`}</tbody>`;
  if (html !== sm.key || force) { $('#smTable').innerHTML = html; sm.key = html; }
  $('#smTrashCount').textContent = sm.trash.length ? `(${sm.trash.length})` : '(비어 있음)';
  const th = sm.trash.length
    ? `<ul class="trash">${sm.trash.slice(0, 50).map((t) => `<li><span><b>${esc(t.title || t.sessionId.slice(0, 8))}</b> <span class="acct" style="--c:${esc(t.color)}">${esc(t.acct)}</span>${t.host ? ` <span class="muted">🖥 ${esc(t.host)}</span>` : ''} <span class="muted small">${esc(ago(t.deletedAt))} 옮김 · ${esc(t.dirName || '')}</span></span>
        ${control ? `<button class="mini" data-akey="${esc(t.akey)}" data-entry="${esc(t.entry)}">↩︎ 되돌리기</button>` : ''}</li>`).join('')}</ul>
      <p class="hint">휴지통은 각 설정 폴더의 <code>office-trash/</code>예요. 완전히 지우려면 그 폴더를 직접 지우세요.</p>`
    : '<div class="empty">휴지통이 비어 있어요</div>';
  if ($('#smTrash').dataset.k !== th) { $('#smTrash').innerHTML = th; $('#smTrash').dataset.k = th; }
}

function onTableClick(e) {
  const tr = e.target.closest('tr[data-sid]');
  if (!tr) return;
  const sid = tr.dataset.sid;
  const r = sm.rows.find((x) => x.sid === sid);
  if (!r) return;
  if (e.target.matches('input[type=checkbox]')) {
    if (e.target.checked) sm.sel.add(sid); else sm.sel.delete(sid);
    renderManager();
    return;
  }
  const b = e.target.closest('[data-r]');
  if (!b || b.disabled) return;
  if (b.dataset.r === 'view') { closeManager(); S.pendingSelect = 'c:' + sid; H.selectSession(sid); return; }
  run(b.dataset.r, [r]);
}

function bulk(kind) {
  const rows = sm.rows.filter((r) => sm.sel.has(r.sid) && r.manageable);
  if (!rows.length) { toast('고른 세션이 없어요'); return; }
  run(kind, rows);
}

async function run(kind, rows) {
  if (sm.busy) return;
  if (kind === 'terminate') rows = rows.filter((r) => r.proc);
  if (!rows.length) { toast('열려 있는 세션이 없어요'); return; }
  const names = rows.slice(0, 8).map((r) => `• ${r.acct} ${r.title || r.firstPrompt || r.sessionId.slice(0, 8)}${r.host ? ` (🖥 ${r.host})` : ''}`).join('\n') + (rows.length > 8 ? `\n… 외 ${rows.length - 8}개` : '');
  const live = rows.filter((r) => r.proc).length;
  const msg = kind === 'terminate'
    ? `세션 ${rows.length}개의 claude를 종료할까요?\n(그 터미널에서 Claude가 꺼져요. 기록은 남아서 나중에 claude --resume 으로 이어 갈 수 있어요)\n\n${names}`
    : `세션 ${rows.length}개를 휴지통으로 옮길까요?${live ? `\n열려 있는 ${live}개는 먼저 종료해요.` : ''}\n(Claude 목록에서 빠지고, 이 화면의 휴지통에서 되돌릴 수 있어요)\n\n${names}`;
  if (!confirm(msg)) return;
  sm.busy = true;
  renderManager();
  toast(kind === 'terminate' ? '⏏ 종료하는 중…' : '🗑 옮기는 중…', 8000);
  try {
    const r = await controlCall({ action: kind, sids: rows.map((x) => x.sid), alsoClose: kind === 'trash' });
    const ok = r.results.filter((x) => x.ok);
    const bad = r.results.filter((x) => !x.ok);
    for (const x of ok) sm.sel.delete(x.sid);
    toast(`${kind === 'terminate' ? '⏏ 종료' : '🗑 휴지통으로'} ${ok.length}개 완료${bad.length ? ` · 실패 ${bad.length}개: ${bad[0].error}` : ''}`, bad.length ? 7000 : 4000);
  } catch (e) { toast('⚠️ ' + e.message, 6000); } finally {
    sm.busy = false;
    loadManager(true);
  }
}

async function onTrashClick(e) {
  const b = e.target.closest('button[data-entry]');
  if (!b) return;
  b.disabled = true;
  try {
    await controlCall({ action: 'restore', akey: b.dataset.akey, entry: b.dataset.entry });
    toast('↩︎ 되돌렸어요. 몇 초 안에 층별 안내에 다시 나타나요');
  } catch (err) { toast('⚠️ ' + err.message, 6000); b.disabled = false; } finally { loadManager(true); }
}
