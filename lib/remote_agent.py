# Claude Office remote helper.
# Runs on the SSH host (python3 only, nothing installed): `ssh host python3 -u -c ...`.
# Reads JSON requests line by line from stdin and answers on stdout.
# It reads Claude Code session logs, sessions/<pid>.json and the tmux pane list. Typing into a pane ('tmux' op) only works
# when the server was started with --allow-control (passed here as argv[2] == '1').
import sys, os, json, glob, base64, socket, subprocess, time, re

HOME = os.path.expanduser('~')
CONTROL = len(sys.argv) > 2 and sys.argv[2] == '1'


def account_for(config_dir):
    cands = []
    if os.path.basename(config_dir) == '.claude':
        cands.append(os.path.join(os.path.dirname(config_dir), '.claude.json'))
    cands.append(os.path.join(config_dir, '.claude.json'))
    for c in cands:
        try:
            with open(c, 'rb') as f:
                d = json.loads(f.read().decode('utf-8', 'replace'))
            oa = d.get('oauthAccount') or {}
            return {'email': oa.get('emailAddress') or '',
                    'name': oa.get('displayName') or oa.get('fullName') or ''}
        except Exception:
            pass
    return {'email': '', 'name': ''}


def norm_root(p):
    p = os.path.expanduser(p)
    if os.path.basename(p.rstrip('/')) != 'projects' and os.path.isdir(os.path.join(p, 'projects')):
        p = os.path.join(p, 'projects')
    return p


def op_roots(a):
    pats = [os.path.join(HOME, '.claude*', 'projects'), '/home/*/.claude*/projects',
            '/root/.claude*/projects', '/Users/*/.claude*/projects']
    env = os.environ.get('CLAUDE_CONFIG_DIR')
    if env:
        pats.insert(0, os.path.join(env, 'projects'))
    extra = [norm_root(x) for x in (a.get('extra') or [])]
    out, seen = [], set()
    for pat in extra + pats:
        for p in sorted(glob.glob(pat)):
            try:
                rp = os.path.realpath(p)
                if rp in seen or not os.path.isdir(p) or not os.access(p, os.R_OK | os.X_OK):
                    continue
                seen.add(rp)
                cfg = os.path.dirname(p.rstrip('/'))
                out.append({'root': p, 'configDir': cfg, 'account': account_for(cfg)})
            except Exception:
                pass
    return out


def op_scan(a):
    res = []
    for root in a.get('roots') or []:
        dirs = []
        try:
            ents = list(os.scandir(root))
        except Exception:
            ents = []
        for e in ents:
            try:
                if not e.is_dir():
                    continue
                files = []
                for f in os.scandir(e.path):
                    if f.name.endswith('.jsonl') and f.is_file():
                        st = f.stat()
                        files.append([f.name, st.st_size, st.st_mtime * 1000])
                dirs.append([e.name, e.stat().st_mtime * 1000, files])
            except Exception:
                continue
        res.append({'root': root, 'dirs': dirs})
    return res


def op_poll(a):
    out = []
    for req in a.get('files') or []:
        p = req['path']
        off = req.get('offset', 0)
        mx = req.get('max', 4 << 20)
        try:
            st = os.stat(p)
        except Exception:
            out.append({'path': p, 'missing': True})
            continue
        item = {'path': p, 'size': st.st_size, 'mtime': st.st_mtime * 1000}
        if st.st_size > off:
            with open(p, 'rb') as f:
                f.seek(off)
                data = f.read(min(mx, st.st_size - off))
            item['start'] = off
            item['data'] = base64.b64encode(data).decode('ascii')
        out.append(item)
    return out


def op_tail(a):
    p = a['path']
    n = a.get('bytes', 2 << 20)
    st = os.stat(p)
    start = max(0, st.st_size - n)
    with open(p, 'rb') as f:
        f.seek(start)
        data = f.read(st.st_size - start)
    return {'size': st.st_size, 'mtime': st.st_mtime * 1000, 'start': start,
            'data': base64.b64encode(data).decode('ascii')}


def op_subs(a):
    out = {}
    for d in a.get('dirs') or []:
        lst = []
        for pat in ('subagents/agent-*.jsonl', 'subagents/workflows/*/agent-*.jsonl'):
            for p in glob.glob(os.path.join(d, pat)):
                try:
                    st = os.stat(p)
                    lst.append([p, st.st_size, st.st_mtime * 1000])
                except Exception:
                    pass
        out[d] = lst
    return out


def op_texts(a):
    mx = a.get('max', 65536)
    out = {}
    for p in a.get('paths') or []:
        try:
            with open(p, 'rb') as f:
                out[p] = f.read(mx).decode('utf-8', 'replace')
        except Exception:
            out[p] = None
    return out


def run(args, inp=None):
    try:
        r = subprocess.run(args, input=inp, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=6)
        return r.returncode == 0, r.stdout, r.stderr
    except FileNotFoundError:
        return False, '', '%s: not found' % args[0]
    except Exception as e:
        return False, '', str(e)


CLAUDE_RE = re.compile(r'(^|/)claude(\s|$)|claude-code/cli\.js|/claude/versions/')


def config_dir_of(pid):
    try:
        with open('/proc/%d/environ' % pid, 'rb') as f:
            for kv in f.read().split(b'\0'):
                if kv.startswith(b'CLAUDE_CONFIG_DIR='):
                    return kv.split(b'=', 1)[1].decode('utf-8', 'replace')
        return None
    except Exception:
        pass
    ok, out, _ = run(['ps', '-E', '-ww', '-o', 'command=', '-p', str(pid)])
    m = re.search(r'\bCLAUDE_CONFIG_DIR=(\S+)', out or '')
    return m.group(1) if m else None


def op_panes(a):
    sep = '|~|'  # tmux escapes tabs in -F output
    fmt = sep.join(['#{pane_id}', '#{pane_pid}', '#{pane_current_path}',
                    '#{session_name}:#{window_index}.#{pane_index}', '#{pane_current_command}', '#{pane_title}'])
    ok, out, err = run(['tmux', 'list-panes', '-a', '-F', fmt])
    if not ok:
        return {'panes': [], 'home': HOME, 'error': (err or 'tmux error').strip()[:200]}
    panes = []
    for line in out.strip().split('\n'):
        parts = line.split(sep)
        if len(parts) < 6:
            continue
        panes.append({'id': parts[0], 'pid': int(parts[1] or 0), 'path': parts[2], 'name': parts[3],
                      'cmd': parts[4], 'title': parts[5]})
    ok, out, _ = run(['ps', '-A', '-o', 'pid=,ppid=,lstart=,command='])
    procs, kids = {}, {}
    for line in (out or '').split('\n'):
        m = re.match(r'\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$', line)
        if not m:
            continue
        try:
            start = time.mktime(time.strptime(re.sub(r'\s+', ' ', m.group(3)), '%a %b %d %H:%M:%S %Y')) * 1000
        except Exception:
            start = 0
        p = {'pid': int(m.group(1)), 'ppid': int(m.group(2)), 'start': start, 'cmd': m.group(4)}
        procs[p['pid']] = p
        kids.setdefault(p['ppid'], []).append(p['pid'])
    for pane in panes:
        queue, seen, found = [pane['pid']], set(), None
        while queue and not found and len(seen) < 200:
            pid = queue.pop(0)
            if pid in seen:
                continue
            seen.add(pid)
            pr = procs.get(pid)
            if pr and CLAUDE_RE.search(pr['cmd']):
                found = pr
                break
            queue.extend(kids.get(pid, []))
        if found:
            pane['claude'] = {'pid': found['pid'], 'start': found['start']}
            pane['configDir'] = config_dir_of(found['pid'])
    return {'panes': panes, 'home': HOME}


# Claude Code keeps <CLAUDE_CONFIG_DIR>/sessions/<pid>.json for every running claude: session id, name,
# status and, inside tmux, its pane ("master:@0.%0"). Only <pid>.json is read, never <pid>.<hash>.key.
PROC_KEYS = ('sessionId', 'pid', 'tmux', 'name', 'status', 'cwd')


def pid_alive(pid, proc_start):
    if pid <= 0:
        return False
    try:
        # field 22 of /proc/<pid>/stat is the start time Claude recorded, so a reused pid doesn't count
        with open('/proc/%d/stat' % pid) as f:
            st = f.read()
        fields = st[st.rindex(')') + 2:].split(' ')
        return not str(proc_start or '').isdigit() or fields[19] == str(proc_start)
    except Exception:
        pass
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def op_procs(a):
    procs = []
    for d in a.get('dirs') or []:
        sd = os.path.join(d, 'sessions')
        try:
            names = os.listdir(sd)
        except Exception:
            continue
        for n in names:
            if not re.match(r'^\d+\.json$', n):
                continue
            try:
                with open(os.path.join(sd, n), 'rb') as f:
                    j = json.loads(f.read().decode('utf-8', 'replace'))
                pid = int(j.get('pid') or n[:-5])
            except Exception:
                continue
            if not j.get('sessionId') or not pid_alive(pid, j.get('procStart')):
                continue
            item = {'configDir': d}
            for k in PROC_KEYS:
                item[k] = j.get(k)
            item['pid'] = pid
            procs.append(item)
    panes = {}  # pane id (%0) -> "session:window.pane" for display
    if any(p.get('tmux') for p in procs):
        sep = '|~|'
        ok, out, _ = run(['tmux', 'list-panes', '-a', '-F', sep.join(['#{pane_id}', '#{session_name}:#{window_index}.#{pane_index}'])])
        for line in (out or '').split('\n'):
            parts = line.split(sep)
            if len(parts) == 2:
                panes[parts[0]] = parts[1]
    return {'procs': procs, 'panes': panes}


def op_tmux(a):
    if not CONTROL:
        raise Exception('control disabled (start the server with --allow-control)')
    pane = a.get('pane') or ''
    if not re.match(r'^%\d+$', pane):
        raise Exception('bad pane id')
    if a.get('key'):
        if a['key'] != 'Escape':
            raise Exception('only Escape is allowed')
        ok, _, err = run(['tmux', 'send-keys', '-t', pane, 'Escape'])
        return {'ok': ok, 'error': err.strip()}
    text = a.get('text') or ''
    if '\n' in text:
        ok, _, err = run(['tmux', 'load-buffer', '-b', 'claude-office', '-'], inp=text)
        if ok:
            ok, _, err = run(['tmux', 'paste-buffer', '-p', '-d', '-b', 'claude-office', '-t', pane])
    else:
        ok, _, err = run(['tmux', 'send-keys', '-t', pane, '-l', text])
    if not ok:
        return {'ok': False, 'error': err.strip()}
    time.sleep(0.15)
    ok, _, err = run(['tmux', 'send-keys', '-t', pane, 'Enter'])
    return {'ok': ok, 'error': err.strip()}


OPS = {'roots': op_roots, 'scan': op_scan, 'poll': op_poll, 'tail': op_tail,
       'subs': op_subs, 'texts': op_texts, 'panes': op_panes, 'procs': op_procs, 'tmux': op_tmux}


def main():
    w = sys.stdout
    w.write(json.dumps({'id': 0, 'ok': True, 'result': {'hello': 'claude-office', 'home': HOME,
                                                        'host': socket.gethostname()}}) + '\n')
    w.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            resp = {'id': rid, 'ok': True, 'result': OPS[req['op']](req.get('args') or {})}
        except Exception as e:
            resp = {'id': rid, 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        w.write(json.dumps(resp) + '\n')
        w.flush()


main()
