// Floor plan (plan units; x → east, y → south). The iso view projects this; walking logic works in plan space.
export const CORR_Y = 350;
export const WALL_H = 140; // outer back walls
export const GLASS_H = 34; // interior glass partitions
export const FRONT_H = 20; // outer front walls (kept low so nothing is hidden)

export const R = {
  library: { x: 16, y: 16, w: 330, h: 284, door: 181, walkY: 262, top: true, floor: '#f2e7d5', floor2: '#e6d7bf', pattern: 'wood' },
  dev: { x: 346, y: 16, w: 360, h: 284, door: 526, walkY: 262, top: true, floor: '#eef3f9', floor2: '#dfe7f1', pattern: 'tile' },
  server: { x: 706, y: 16, w: 270, h: 284, door: 841, walkY: 262, top: true, floor: '#e6ebf2', floor2: '#d3dbe6', pattern: 'raised' },
  lobby: { x: 976, y: 16, w: 208, h: 284, door: 1080, walkY: 262, top: true, floor: '#f7f9fc', floor2: '#e9eef5', pattern: 'marble' },
  web: { x: 16, y: 400, w: 330, h: 304, door: 181, walkY: 492, floor: '#e6f6f3', floor2: '#d4ece7', pattern: 'tile' },
  meeting: { x: 346, y: 400, w: 360, h: 304, door: 380, walkY: 505, floor: '#f5ecdf', floor2: '#eadcc8', pattern: 'wood' },
  desk: { x: 706, y: 400, w: 270, h: 304, door: 841, walkY: 440, floor: '#f8f0e8', floor2: '#ecdfd2', pattern: 'wood' },
  user: { x: 976, y: 400, w: 208, h: 304, door: 1010, walkY: 500, floor: '#f1eef9', floor2: '#e2dcf1', pattern: 'carpet' },
};
export const CORRIDOR = { x: 16, y: 300, w: 1168, h: 100, floor: '#eef2f7', floor2: '#e2e8f0' };

export const ROOM_INFO = {
  library: { icon: '📚', name: '자료실', desc: '파일을 읽고 코드를 찾아보는 곳', tools: ['Read', 'Grep', 'Glob', 'LS', 'Skill', 'ToolSearch'], visual: '책장 앞에서 책을 펴고 읽어요' },
  dev: { icon: '💻', name: '개발실', desc: '코드를 고치고 새 파일을 쓰는 곳', tools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'], visual: '아이맥 화면에 코드가 흘러요' },
  server: { icon: '🗄️', name: '서버실', desc: '명령을 실행하고 git을 다루는 곳', tools: ['Bash', 'git', 'BashOutput', 'KillShell', 'Monitor', 'TaskStop'], visual: '명령이 도는 동안 랙 불빛이 빨라져요' },
  web: { icon: '🌐', name: '정보검색실', desc: '웹 검색 · 웹 페이지 · MCP 도구 · 브라우저', tools: ['WebSearch', 'WebFetch', 'mcp__*', 'Browser', 'Artifact'], visual: '지구본이 빨리 돌고 브라우저가 로딩돼요' },
  meeting: { icon: '🗒️', name: '회의실', desc: '할 일과 계획을 세우는 곳', tools: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'EnterPlanMode', 'Workflow', 'Cron'], visual: '화이트보드에 할 일 · 계획이 적혀요' },
  desk: { icon: '🤖', name: 'Claude 자리', desc: '서브에이전트를 부르고, 다른 세션에 메시지를 보내는 자리', tools: ['Agent', 'Task', 'SendMessage', 'tmux send-keys', 'ListAgents'], visual: '전화를 걸고, 쉴 땐 커피를, 오래 쉬면 졸아요' },
  user: { icon: '🧑‍💻', name: '내 자리', desc: '나에게 묻거나 결과물을 건네는 곳', tools: ['AskUserQuestion', 'ExitPlanMode', 'SendUserFile'], visual: '물어볼 게 생기면 내 책상까지 찾아와요' },
  lobby: { icon: '🛗', name: '엘리베이터 홀', desc: '서브에이전트가 출퇴근하고, 다른 층으로 메시지를 보내는 곳', tools: ['서브에이전트 출퇴근', '📮 다른 층 메시지'], visual: '엘리베이터 문이 열리고 닫혀요' },
  corridor: { icon: '🚶', name: '복도', desc: '방과 방 사이를 오가는 길', tools: [], visual: '' },
};

// ---- where characters stand / sit ------------------------------------------
const sp = (x, y, o = {}) => ({ x, y, face: 'up', sit: false, pose: 'stand', ...o });

export const SPOTS = {
  library: [
    sp(63, 78, { face: 'down', pose: 'read' }),
    sp(141, 78, { face: 'down', pose: 'read', via: [{ x: 96, y: 262 }, { x: 96, y: 110 }, { x: 141, y: 110 }] }),
    sp(219, 78, { face: 'down', pose: 'read', via: [{ x: 268, y: 262 }, { x: 268, y: 110 }, { x: 219, y: 110 }] }),
    sp(297, 78, { face: 'down', pose: 'read' }),
    sp(150, 140, { face: 'down', pose: 'read', sit: true, via: [{ x: 96, y: 262 }, { x: 96, y: 124 }, { x: 150, y: 124 }] }),
    sp(212, 140, { face: 'down', pose: 'read', sit: true, via: [{ x: 268, y: 262 }, { x: 268, y: 124 }, { x: 212, y: 124 }] }),
  ],
  dev: [
    sp(416, 112, { sit: true, pose: 'type', screen: 0 }), sp(526, 112, { sit: true, pose: 'type', screen: 1 }), sp(636, 112, { sit: true, pose: 'type', screen: 2 }),
    sp(471, 212, { sit: true, pose: 'type', screen: 3 }), sp(581, 212, { sit: true, pose: 'type', screen: 4 }),
  ],
  server: [744, 808, 872, 936].map((x, i) => sp(x, 100, { pose: 'rack', rack: i }))
    .concat([sp(777, 200, { pose: 'stand' }), sp(901, 200, { pose: 'stand' })]),
  lobby: [sp(1080, 66, { face: 'down' }), sp(1040, 150, { face: 'down' }), sp(1130, 150, { face: 'down' }), sp(1052, 214, { face: 'down' }), sp(1136, 214, { face: 'down' })],
  web: [sp(86, 476, { sit: true, pose: 'browse', screen: 0 }), sp(276, 476, { sit: true, pose: 'browse', screen: 1 }),
    sp(110, 652, { pose: 'browse' }), sp(252, 652, { pose: 'browse' })],
  meeting: [sp(486, 470, { pose: 'board' }), sp(626, 470, { pose: 'board' })]
    .concat([465, 525, 585].map((x) => sp(x, 546, { face: 'down', sit: true, pose: 'listen' }))),
  desk: [],
  user: [
    sp(1040, 482, { face: 'down', pose: 'ask', via: [{ x: 1010, y: 500 }, { x: 1040, y: 500 }] }),
    sp(1105, 542, { face: 'up', pose: 'ask', via: [{ x: 1010, y: 500 }, { x: 1010, y: 542 }] }),
    sp(1152, 548, { face: 'up', pose: 'ask', via: [{ x: 1010, y: 500 }, { x: 1010, y: 560 }, { x: 1152, y: 560 }] }),
  ],
};

export const DESK_SEATS = [
  sp(776, 470, { sit: true, face: 'down', pose: 'work', via: [{ x: 841, y: 440 }, { x: 776, y: 440 }] }),
  sp(906, 470, { sit: true, face: 'down', pose: 'work', via: [{ x: 841, y: 440 }, { x: 906, y: 440 }] }),
  sp(776, 610, { sit: true, face: 'down', pose: 'work', via: [{ x: 841, y: 440 }, { x: 841, y: 575 }, { x: 776, y: 575 }] }),
  sp(906, 610, { sit: true, face: 'down', pose: 'work', via: [{ x: 841, y: 440 }, { x: 841, y: 575 }, { x: 906, y: 575 }] }),
];
export const DESK_VISIT = [
  [sp(724, 476, { face: 'down', via: [{ x: 841, y: 440 }, { x: 724, y: 440 }] }), sp(841, 480, { face: 'down', via: [{ x: 841, y: 440 }] })],
  [sp(958, 476, { face: 'down', via: [{ x: 841, y: 440 }, { x: 958, y: 440 }] }), sp(841, 500, { face: 'down', via: [{ x: 841, y: 440 }] })],
  [sp(724, 616, { face: 'down', via: [{ x: 841, y: 440 }, { x: 841, y: 575 }, { x: 724, y: 575 }] }), sp(841, 620, { face: 'down', via: [{ x: 841, y: 440 }, { x: 841, y: 575 }] })],
  [sp(958, 616, { face: 'down', via: [{ x: 841, y: 440 }, { x: 841, y: 575 }, { x: 958, y: 575 }] }), sp(841, 640, { face: 'down', via: [{ x: 841, y: 440 }, { x: 841, y: 575 }] })],
];
export const USER_SEAT = sp(1105, 476, { sit: true, face: 'up', pose: 'type' });
export const MAILBOX = sp(1132, 112, { face: 'down', pose: 'stand' });
export const ELEV_IN = { x: 1080, y: 26 };
export const ROOM_POSE = { library: 'read', dev: 'type', server: 'rack', web: 'browse', meeting: 'board', lobby: 'stand', user: 'ask', desk: 'work' };

// ---- furniture footprints (also used for hover / click) ----------------------
export const SHELVES = [30, 108, 186, 264].map((x) => ({ x, y: 20, w: 66, d: 24, h: 104 }));
export const DEV_DESKS = [{ c: 416, y: 56 }, { c: 526, y: 56 }, { c: 636, y: 56 }, { c: 471, y: 156 }, { c: 581, y: 156 }];
export const RACKS = [718, 782, 846, 910].map((x) => ({ x, y: 20, w: 52, d: 36, h: 112 }));
export const WEB_DESKS = [{ c: 86, y: 418 }, { c: 276, y: 418 }];
export const GLOBE = { x: 181, y: 602, r: 32, z: 74 };
export const BOARD = { x: 436, y: 418, w: 238, d: 6, z: 22, h: 86 };
export const TABLE = { x: 425, y: 560, w: 200, d: 50, h: 28 };
export const LIB_TABLE = { x: 120, y: 150, w: 120, d: 40, h: 28 };
export const USER_DESK = { x: 1046, y: 418, w: 118, d: 32, h: 30 };
export const ELEVATOR = { x: 1040, w: 80, h: 92 };
export const MAILBOX_BOX = { x: 1150, y: 98, w: 18, d: 14, h: 34 };

// Things you can hover or click besides characters and rooms.
export const HOTSPOTS = [
  { id: 'board', room: 'meeting', box: [BOARD.x, BOARD.y, 0, BOARD.w, BOARD.d, BOARD.z + BOARD.h] },
  { id: 'elevator', room: 'lobby', box: [ELEVATOR.x, 12, 0, ELEVATOR.w, 6, ELEVATOR.h + 16] },
  { id: 'mailbox', room: 'lobby', box: [MAILBOX_BOX.x, MAILBOX_BOX.y, 0, MAILBOX_BOX.w, MAILBOX_BOX.d, MAILBOX_BOX.h] },
  { id: 'globe', room: 'web', box: [GLOBE.x - GLOBE.r, GLOBE.y - GLOBE.r, 0, GLOBE.r * 2, GLOBE.r * 2, GLOBE.z + GLOBE.r] },
  { id: 'racks', room: 'server', box: [718, 20, 0, 244, 36, 112] },
  { id: 'shelves', room: 'library', box: [30, 20, 0, 300, 24, 104] },
  { id: 'userdesk', room: 'user', box: [USER_DESK.x, USER_DESK.y, 0, USER_DESK.w, USER_DESK.d, 70] },
  ...DESK_SEATS.map((s, i) => ({ id: 'desk' + i, room: 'desk', slot: i, box: [s.x - 42, s.y + 10, 0, 84, 32, 40] })),
];

// ---- walls ---------------------------------------------------------------------
function hsegs(y, x0, x1, gaps, h, kind) {
  const out = [];
  const cuts = gaps.map((g) => [g - 28, g + 28]).sort((a, b) => a[0] - b[0]);
  let cur = x0;
  for (const [a, b] of cuts) { if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
  if (cur < x1) out.push([cur, x1]);
  return out.flatMap(([a, b]) => split(a, b).map(([p, q]) => ({ axis: 'x', y, a: p, b: q, h, kind })));
}
function vsegs(x, y0, y1, h, kind) {
  return split(y0, y1).map(([p, q]) => ({ axis: 'y', x, a: p, b: q, h, kind }));
}
function split(a, b, step = 36) {
  const n = Math.max(1, Math.round((b - a) / step));
  const out = [];
  for (let i = 0; i < n; i++) out.push([a + ((b - a) * i) / n, a + ((b - a) * (i + 1)) / n]);
  return out;
}
export const WALLS = [
  ...hsegs(300, 16, 1184, [181, 526, 841, 1080], GLASS_H, 'glass'),
  ...hsegs(400, 16, 1184, [181, 380, 841, 1010], GLASS_H, 'glass'),
  ...[346, 706, 976].flatMap((x) => [...vsegs(x, 16, 300, GLASS_H, 'glass'), ...vsegs(x, 400, 704, GLASS_H, 'glass')]),
  ...vsegs(1184, 16, 704, FRONT_H, 'front'),
  ...hsegs(704, 16, 1184, [], FRONT_H, 'front'),
];
export const DOORS = [
  ...['library', 'dev', 'server', 'lobby'].map((k) => ({ x: R[k].door, y: 300 })),
  ...['web', 'meeting', 'desk', 'user'].map((k) => ({ x: R[k].door, y: 400 })),
];

export function roomAt(x, y) {
  for (const [k, r] of Object.entries(R)) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return k;
  if (x >= CORRIDOR.x && x < CORRIDOR.x + CORRIDOR.w && y >= CORRIDOR.y && y < CORRIDOR.y + CORRIDOR.h) return 'corridor';
  return null;
}
