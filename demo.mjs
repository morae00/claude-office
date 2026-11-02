#!/usr/bin/env node
// Demo: fake Claude Code logs for two accounts (alice, bob) working in the same folder,
// talking to each other through tmux, plus subagents. Starts the office on port 4748.
//   node demo.mjs            → http://localhost:4748
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(os.tmpdir(), 'claude-office-demo');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 4748);
const CWD = '/home/dev/shared-app';
const DIR = CWD.replace(/[^a-zA-Z0-9]/g, '-');

fs.rmSync(BASE, { recursive: true, force: true });
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function account(name, display) {
  const cfg = path.join(BASE, `.claude-${name}`);
  fs.mkdirSync(path.join(cfg, 'projects', DIR), { recursive: true });
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: display, emailAddress: `${name}@example.com` } }));
  return cfg;
}

class Session {
  constructor(cfg, title, cwd = CWD) {
    this.sid = uuid();
    this.cwd = cwd;
    const dir = path.join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${this.sid}.jsonl`);
    this.dir = path.join(dir, this.sid);
    this.line({ type: 'custom-title', customTitle: title });
    this.line({ type: 'agent-name', agentName: title });
  }
  line(o, file = this.file) {
    fs.appendFileSync(file, JSON.stringify({ ...o, sessionId: this.sid, cwd: this.cwd, timestamp: new Date().toISOString(), uuid: uuid() }) + '\n');
  }
  prompt(text) { this.line({ type: 'user', message: { role: 'user', content: text } }); }
  think(text) { this.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }], stop_reason: null } }); }
  say(text, end = false) { this.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: end ? 'end_turn' : null } }); }
  tool(name, input) {
    const id = 'toolu_' + crypto.randomBytes(8).toString('hex');
    this.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
    return id;
  }
  result(id, content, { error = false, tur } = {}) {
    this.line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] }, toolUseResult: tur });
  }
  async run(name, input, content, ms = 1600, opts) {
    const id = this.tool(name, input);
    await sleep(ms);
    this.result(id, content, opts);
    return id;
  }
}

class Sub {
  constructor(sess, type, desc, toolUseId) {
    this.sess = sess;
    this.agentId = 'a' + crypto.randomBytes(8).toString('hex');
    const dir = path.join(sess.dir, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `agent-${this.agentId}.jsonl`);
    fs.writeFileSync(path.join(dir, `agent-${this.agentId}.meta.json`), JSON.stringify({ agentType: type, description: desc, toolUseId }));
    this.line({ type: 'user', message: { role: 'user', content: desc } });
  }
  line(o) { this.sess.line({ ...o, isSidechain: true, agentId: this.agentId }, this.file); }
  async run(name, input, ms = 1500) {
    const id = 'toolu_' + crypto.randomBytes(8).toString('hex');
    this.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
    await sleep(ms);
    this.line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  }
  think(text) { this.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }], stop_reason: null } }); }
  handback(msg) {
    this.line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_hb' + this.agentId, name: 'SubagentHandback', input: { message: msg } }], stop_reason: 'tool_use' } });
  }
}

const alice = account('alice', 'Alice');
const bob = account('bob', 'Bob');
const blog = new Session(alice, '블로그 글 다듬기', '/home/dev/blog');
blog.prompt('지난주 회고 글 맞춤법 봐줘');
blog.say('맞춤법 고쳐 두었어요.', true);

async function scenario(round) {
  const A = new Session(alice, round === 1 ? '로그인 버그 수정' : `로그인 버그 수정 (${round}회차, /clear 후)`);
  const B = round === 1 ? (scenario.B = new Session(bob, 'E2E 테스트 담당')) : scenario.B;
  await sleep(2500);

  A.prompt('로그인하면 세션이 바로 풀리는 버그 고쳐줘. 다 되면 bob 세션한테 e2e 테스트 부탁해.');
  await sleep(1500);
  A.think('로그인 흐름부터 살펴봐야겠어요. 세션 쿠키 만료 시간이 의심됩니다.');
  await sleep(2500);
  await A.run('Glob', { pattern: 'src/auth/**/*.ts' }, 'src/auth/login.ts\nsrc/auth/session.ts');
  await A.run('Read', { file_path: '/home/dev/shared-app/src/auth/login.ts' }, '...');
  await A.run('Grep', { pattern: 'maxAge' }, 'src/auth/session.ts:12');
  await A.run('TodoWrite', { todos: [
    { content: '세션 쿠키 만료 원인 찾기', status: 'in_progress' },
    { content: 'maxAge 단위(초→밀리초) 고치기', status: 'pending' },
    { content: '단위 테스트 통과시키기', status: 'pending' },
    { content: 'bob에게 e2e 테스트 요청', status: 'pending' },
  ] }, 'ok', 1200);

  // A subagent goes to work.
  const exploreId = A.tool('Agent', { description: '세션 저장소 사용처 조사', prompt: '...', subagent_type: 'Explore', run_in_background: true });
  const ex = new Sub(A, 'Explore', '세션 저장소 사용처 조사', exploreId);
  await sleep(600);
  A.result(exploreId, 'Async agent launched successfully.', { tur: { status: 'async_launched', agentId: ex.agentId, isAsync: true } });
  await sleep(1500);
  ex.think('세션 저장소를 쓰는 곳을 전부 찾아볼게요.');
  await sleep(1500);
  await ex.run('Grep', { pattern: 'sessionStore' }, 1800);
  await ex.run('Read', { file_path: 'src/auth/session.ts' }, 1800);
  await A.run('Read', { file_path: '/home/dev/shared-app/src/auth/session.ts' }, '...', 1800);
  await ex.run('Glob', { pattern: 'src/**/*.test.ts' }, 1500);
  ex.handback('세션 저장소는 3곳에서 씁니다. session.ts의 maxAge가 초 단위로 들어가 쿠키가 바로 만료돼요.');
  await sleep(800);
  A.prompt(`<task-notification>\n<task-id>${ex.agentId}</task-id>\n<tool-use-id>${exploreId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "세션 저장소 사용처 조사" completed</summary>\n<result>세션 저장소는 3곳에서 씁니다. maxAge가 초 단위라 바로 만료돼요.</result>\n</task-notification>`);
  await sleep(4000);

  A.think('원인을 찾았어요. maxAge를 밀리초로 바꾸면 되겠네요.');
  await sleep(2000);
  await A.run('Edit', { file_path: '/home/dev/shared-app/src/auth/session.ts' }, 'ok', 2500);
  await A.run('Bash', { command: 'npm test -- auth', description: 'Run auth tests' }, 'Exit code 1\nFAIL src/auth/session.test.ts\n  expected 3600000, got 3600', 3000, { error: true });
  await sleep(1200);
  A.think('테스트 기대값도 같이 바꿔야 하네요.');
  await sleep(2000);
  await A.run('Edit', { file_path: '/home/dev/shared-app/src/auth/session.test.ts' }, 'ok', 2000);
  await A.run('Bash', { command: 'npm test -- auth' }, 'PASS 12 tests', 3500);

  // Plan agent, synchronous.
  const planId = A.tool('Agent', { description: '회귀 방지 계획', prompt: '...', subagent_type: 'Plan' });
  const pl = new Sub(A, 'Plan', '회귀 방지 계획', planId);
  await sleep(1800);
  pl.think('쿠키 옵션을 한곳에서 만들도록 정리하면 좋겠어요.');
  await sleep(1500);
  await pl.run('Read', { file_path: 'src/auth/cookies.ts' }, 2000);
  await pl.run('Grep', { pattern: 'cookie(' }, 1800);
  A.result(planId, [{ type: 'text', text: '쿠키 옵션을 cookies.ts 한곳에서 만들고, 단위 테스트에 만료 시간을 고정값으로 넣자는 계획입니다.' }], { tur: { status: 'completed', agentId: pl.agentId } });
  await sleep(3500);

  // Ask bob (another account, another tmux pane) to run e2e.
  const ask = '로그인 세션 버그 고쳤어요 (maxAge 단위). e2e 로그인 시나리오 한 번 돌려줄래요?';
  await A.run('Bash', { command: `tmux send-keys -t bob "${ask}" Enter`, description: 'Ask bob session for e2e' }, '', 900);
  await sleep(700);
  B.prompt(ask);
  await sleep(1500);
  A.say('bob 세션에 e2e 테스트를 부탁했어요. 결과 기다릴게요.');
  await sleep(1500);
  B.think('alice가 고친 로그인 흐름을 e2e로 확인해 볼게요.');
  await sleep(2000);
  await B.run('Read', { file_path: '/home/dev/shared-app/e2e/login.spec.ts' }, '...');
  await B.run('Bash', { command: 'npx playwright test e2e/login.spec.ts' }, 'Exit code 1\n1 flaky: login > remember me', 3500, { error: true });
  B.think('remember me 케이스가 가끔 깨지네요. 알려진 이슈인지 찾아볼게요.');
  await sleep(1800);
  await B.run('WebSearch', { query: 'playwright flaky cookie remember me test' }, '...', 2200);
  await B.run('WebFetch', { url: 'https://playwright.dev/docs/test-retries' }, '...', 2000);
  await B.run('Bash', { command: 'npx playwright test e2e/login.spec.ts --retries=2' }, '3 passed', 3500);
  const reply = 'e2e 통과했어요 👍 remember me는 원래 flaky라서 재시도 2회 넣었어요. PR 올려도 됩니다.';
  await B.run('Bash', { command: `tmux send-keys -t alice '${reply}' Enter` }, '', 900);
  await sleep(700);
  A.prompt(reply);
  B.say('alice 세션에 결과를 전달했어요.', true);
  await sleep(2000);

  A.think('e2e도 통과했으니 커밋하고 PR 제목만 확인받을게요.');
  await sleep(1800);
  await A.run('Bash', { command: 'git add -A && git commit -m "fix(auth): cookie maxAge in ms"' }, '[fix/login 1a2b3c4] fix(auth)', 2000);
  const qid = A.tool('AskUserQuestion', { questions: [{ question: 'PR 제목을 "로그인 세션이 바로 풀리는 버그 수정"으로 할까요?', header: 'PR', options: [] }] });
  await sleep(6000);
  A.result(qid, 'User has answered your questions: "PR 제목을…"="네, 그걸로 해줘"');
  await sleep(1200);
  await A.run('Bash', { command: 'git push -u origin fix/login && gh pr create --fill' }, 'https://github.com/example/shared-app/pull/42', 3000);
  A.say('PR 올렸습니다! 로그인 세션이 바로 풀리던 문제는 maxAge 단위 때문이었어요.', true);
}

async function main() {
  const server = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--port', String(PORT), '--only-roots',
    '--root', path.join(BASE, '.claude-alice'), '--root', path.join(BASE, '.claude-bob')], { stdio: 'inherit' });
  process.on('SIGINT', () => { server.kill(); process.exit(0); });
  process.on('exit', () => server.kill());
  console.log(`\n🎬 데모 데이터: ${BASE}\n   브라우저에서 http://localhost:${PORT} 을 열어 보세요. (Ctrl+C 로 종료)\n`);
  for (let round = 1; ; round++) {
    await scenario(round);
    await sleep(12000);
  }
}
main();
