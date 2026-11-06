"""A fake host generated from a release profile: a temporary root laid out as the profile's live state, synthetic env
values, and one stub script installed as systemctl, systemd-run, curl, nginx, psql and cp. Every value here is
synthetic. Six host behaviours the tool must handle are reproduced:

  appRoleKey         backend env holds APP_DATABASE_URL (the App role) and a DATABASE_URL naming another role
  cmsCaFallback      operator.json has no CMS CA key; psql refuses a connection without an existing CA file
  systemdHostZone    `systemctl show` prints timer times in the host zone unless the caller sets TZ=UTC
  implicitParents    manifests list a parent directory only when it is an entry itself
  nginxStaleWorker   right after a reload, requests within a short window get the previous configuration's answer
  strictReportQuery  the report queue answers 400 to any query string

The stubs keep their state in <root>/stub.json under a lock and log their argv to <root>/stub-argv.log.
"""
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
RELEASE = HERE.parent
EXAMPLE_PROFILE = HERE / 'fixtures' / 'profile.example.json'
TOOLS = ('systemctl', 'systemd-run', 'curl', 'nginx', 'psql', 'cp', 'journalctl')
APP_ROLE, DECOY_ROLE = 'r1_app_role', 'r1_decoy_role'

STUB = r'''#!@PYTHON@ -IS
import fcntl, hashlib, json, os, re, signal, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
ROOT = open(os.path.join(HERE, 'ROOT')).read().strip()
PROFILE = json.load(open(os.path.join(HERE, 'profile.json')))
STATE = os.path.join(ROOT, 'stub.json')
NAME = os.path.basename(sys.argv[0])
ARGS = sys.argv[1:]
SERVICES = PROFILE['services']
UNIT_OF = {spec['unit']: name for name, spec in SERVICES.items()}
UNTOUCHED = {spec['unit']: spec for spec in PROFILE.get('untouched', {}).values()}


def P(path):
    return ROOT + path


class State:
    def __enter__(self):
        self.fd = os.open(STATE + '.lock', os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        self.s = json.load(open(STATE))
        return self.s

    def __exit__(self, *exc):
        if exc[0] is None:
            tmp = STATE + '.%d' % os.getpid()
            json.dump(self.s, open(tmp, 'w'))
            os.replace(tmp, STATE)
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


with open(os.path.join(ROOT, 'stub-argv.log'), 'a') as _log:
    _log.write(json.dumps([NAME] + ARGS) + '\n')


def env_file(path):
    values = {}
    if os.path.exists(P(path)):
        for line in open(P(path)).read().split('\n'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                values[k.strip()] = v.strip()
    return values


def dropin_wd(unit):
    folder = P('/etc/systemd/system/%s.d' % unit)
    value = ''
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if name.endswith('.conf'):
                for m in re.finditer(r'^WorkingDirectory=(.*)$', open(os.path.join(folder, name)).read(), re.M):
                    value = m.group(1).strip()
    return value


def shown(t):
    """As some systemd versions do: the host's zone whatever --timestamp says, UTC only under TZ=UTC."""
    if not t:
        return ''
    if os.environ.get('TZ') == 'UTC':
        return time.strftime('%a %Y-%m-%d %H:%M:%S UTC', time.gmtime(t))
    zone = PROFILE['timeZone']
    return time.strftime('%a %Y-%m-%d %H:%M:%S ', time.gmtime(t + zone['utcOffsetSeconds'])) + zone['hostZone']


def start(unit, s):
    u = s['units'].setdefault(unit, {'state': 'inactive', 'nrestarts': '0'})
    if s.get('failStart', {}).get(unit, 0) > 0:
        s['failStart'][unit] -= 1
        u['state'], u['pid'] = 'failed', 0
        return 1
    u['state'], u['pid'] = 'active', s['nextPid']
    s['nextPid'] += 1
    u['starts'] = u.get('starts', 0) + 1
    loop = s.get('restartLoop')
    cwd = s['loaded'].get(unit) or UNTOUCHED.get(unit, {}).get('cwd', '')
    u['nrestarts'] = '2' if loop and loop[0] == unit and loop[1] in cwd else '0'
    proc = P('/proc/%d' % u['pid'])
    os.makedirs(proc, exist_ok=True)
    os.symlink(cwd, os.path.join(proc, 'cwd'))
    environ = {}
    for name in SERVICES.get(UNIT_OF.get(unit), {}).get('envFiles', []):
        environ.update(env_file(PROFILE['envFiles'][name]['path']))
    open(os.path.join(proc, 'environ'), 'w').write('\0'.join('%s=%s' % kv for kv in environ.items()))
    u['cwd'] = cwd
    return 0


def systemctl():
    verb = ARGS[0]
    if verb == 'show':
        unit = ARGS[1]
        props = [a.split('=', 1)[1] for a in ARGS if a.startswith('--property=')]
        with State() as s:
            if unit in s.get('showFails', []):
                return 1              # a show that failed or timed out: no answer at all
            values = {}
            if unit in s.get('transient', {}):
                values = {'LoadState': 'loaded', 'ActiveState': 'active' if alive(s['transient'][unit]) else 'inactive',
                          'Result': 'success'}
            elif unit.endswith('.timer'):
                timer = s['timers'].get(unit, {})
                values = {'LoadState': 'loaded' if timer else 'not-found', 'ActiveState': timer.get('state', 'inactive'),
                          'NextElapseUSecRealtime': shown(timer.get('next')) if timer.get('state') == 'active' else ''}
            else:
                u = s['units'].get(unit, {})
                known = unit in UNIT_OF or unit in UNTOUCHED or unit in s['units']
                values = {'LoadState': 'loaded' if known else 'not-found', 'ActiveState': u.get('state', 'inactive'),
                          'SubState': 'running' if u.get('state') == 'active' else 'dead',
                          'MainPID': str(u.get('pid', 0)) if u.get('state') == 'active' else '0',
                          'NRestarts': u.get('nrestarts', '0'),
                          'WorkingDirectory': s['loaded'].get(unit) or UNTOUCHED.get(unit, {}).get('cwd', ''),
                          'InvocationID': 'i%d' % u.get('pid', 0)}
        for p in props:
            print('%s=%s' % (p, values.get(p, '')))
        return 0
    if verb == 'list-units':
        with State() as s:
            for unit, pid in sorted(s.get('transient', {}).items()):
                up = alive(pid)
                print('%s loaded %s %s x' % (unit, 'active' if up else 'inactive', 'running' if up else 'dead'))
        return 0
    with State() as s:
        s.setdefault('calls', []).append([verb] + ARGS[1:])
        unit = ARGS[-1] if len(ARGS) > 1 else None
        if verb == 'daemon-reload':
            if s.get('daemonReloadFail'):
                return 1
            for u in UNIT_OF:
                s['loaded'][u] = dropin_wd(u)
            return 0
        if verb == 'reset-failed':
            if unit in s['units'] and s['units'][unit].get('state') == 'failed':
                s['units'][unit]['state'] = 'inactive'
            return 0
        if verb == 'reload':
            n = s['nginx']
            n['previous'], n['current'] = n['current'], hashlib.sha256(open(P(PROFILE['paths']['nginxSite']), 'rb').read()).hexdigest()
            n['reloadedAt'], n['reloads'] = time.time(), n.get('reloads', 0) + 1
            n['markers'] = [n.get('markers', [[], []])[1], re.findall(r'location = (/r1-[a-z-]+)', open(P(PROFILE['paths']['nginxSite'])).read())]
            return 0
        if verb == 'stop':
            if unit in s.get('transient', {}):
                try:
                    os.kill(s['transient'][unit], signal.SIGTERM)     # KillMode=mixed: SIGTERM to the main process
                except OSError:
                    pass
                return 0
            u = s['units'].setdefault(unit, {'state': 'inactive'})
            if s.get('stopHangs') == unit:
                return 0
            u['state'] = 'failed' if unit in s.get('stopLandsInFailed', []) else 'inactive'
            u['pid'] = 0
            return 0
        if verb == 'start':
            sleep = s.get('sleepOnStart') == unit
            if sleep:
                s['sleepOnStart'] = None
                s['sleeping'] = unit
    if verb == 'start':
        if sleep:
            time.sleep(30)
        with State() as s:
            return start(unit, s)
    return 0


def systemd_run():
    unit = next(a.split('=', 1)[1] for a in ARGS if a.startswith('--unit='))
    env = {'PATH': '/usr/bin:/bin'}
    rest = []
    for i, a in enumerate(ARGS):
        if a.startswith('--setenv='):
            k, v = a[len('--setenv='):].split('=', 1)
            env[k] = v
        elif not a.startswith('--'):
            rest = ARGS[i:]
            break
    child = subprocess.Popen(rest, env=env, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    with State() as s:
        s.setdefault('transient', {})[unit] = child.pid
    return 0


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        out = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, timeout=5).stdout.decode().strip()
    except (OSError, subprocess.TimeoutExpired):
        return True
    return bool(out) and not out.startswith('Z')


def running_env(s, service):
    u = s['units'].get(SERVICES[service]['unit'], {})
    if u.get('state') != 'active':
        return None
    return dict(x.split('=', 1) for x in open(P('/proc/%d/environ' % u['pid'])).read().split('\0') if '=' in x)


def active(s, service):
    return service in SERVICES and s['units'].get(SERVICES[service]['unit'], {}).get('state') == 'active'


def route(s, method, url, auth, resolve, headers):
    checks = PROFILE['checks']
    queue = checks.get('reportQueue', {}).get('url')
    if queue and url.split('?', 1)[0] == queue:
        if not active(s, 'backend'):
            return None
        if '?' in url:
            return 400            # the queue's query schema is strict
        env = running_env(s, 'backend') or {}
        if auth and auth == env.get(checks['reportQueue']['token']['key']):
            return 200
        base = checks['reportQueue'].get('base')
        if auth and base and auth == env.get(base['key']):
            return 403
        return 401
    m = re.match(r'http://127\.0\.0\.1:([0-9]+)(/[^?]*)', url)
    if m:
        for name, spec in SERVICES.items():
            for probe in spec.get('probes', []):
                if probe['url'].startswith('http://127.0.0.1:%s/' % m.group(1)):
                    if not active(s, name):
                        return None
                    fail = s.get('probeFail', {}).get(name)
                    if fail and fail in s['units'][spec['unit']].get('cwd', ''):
                        return 503
                    return 200
        return None
    m = re.match(r'https://([^/]+)(/[^?]*)', url)
    if m and resolve and resolve.endswith(':443:127.0.0.1'):
        host, path = m.groups()
        n = s['nginx']
        stale = time.time() - n.get('reloadedAt', 0) < s.get('staleSeconds', 0)
        markers = n.get('markers', [[], []])[0 if stale else 1]
        if path.startswith('/r1-'):
            return 200 if path in markers else 404
        if host == checks['apex']:
            if method == 'POST' and path == checks['mcpDoor']:
                if not active(s, 'admin'):
                    return 502
                headers['WWW-Authenticate'] = 'Bearer' + ' resource_metadata="https://%s/.well-known/oauth-protected-resource/api/mcp"' % host
                return 401
            owner = 'admin' if path.startswith('/admin') else 'web'
            return 200 if active(s, owner) else 502
        if host == checks.get('issuerHost'):
            if not active(s, 'issuer'):
                return 502
            if path == '/.well-known/oauth-authorization-server':
                return 200, json.dumps({'issuer': 'https://' + host}).encode()
            return 200 if path == '/healthz' else 404
    return None


def curl():
    method, head, body_path, fmt, url, auth, resolve, headers = 'GET', None, None, '%{http_code}', None, None, None, {}
    i = 0
    while i < len(ARGS):
        a = ARGS[i]
        if a in ('-X', '-D', '-o', '-w', '-H', '--url', '--resolve', '--max-time', '--max-filesize', '--data', '--noproxy'):
            v = ARGS[i + 1]
            if a == '-X':
                method = v
            elif a == '-D':
                head = v
            elif a == '-o':
                body_path = v
            elif a == '-w':
                fmt = v
            elif a == '--url':
                url = v
            elif a == '--resolve':
                resolve = v
            elif a == '-H' and v.startswith('@'):
                auth = open(v[1:]).read().split('Bearer ', 1)[1].strip()
            i += 2
        else:
            i += 1
    out_headers, body = {}, b''
    with State() as s:
        code = route(s, method, url, auth, resolve, out_headers)
        s.setdefault('curl', []).append([method, url])
    if isinstance(code, tuple):
        code, body = code
    if code is None:
        print('000', end='')
        return 7
    if head:
        open(head, 'w').write('HTTP/1.1 %s X\r\n' % code + ''.join('%s: %s\r\n' % kv for kv in out_headers.items()))
    if body_path:
        open(body_path, 'wb').write(body)
    print(fmt.replace('%{http_code}', str(code)), end='')
    return 0


def nginx():
    with State() as s:
        if s.get('nginxTestFail'):
            return 1
    return 1 if b'BROKEN' in open(P(PROFILE['paths']['nginxSite']), 'rb').read() else 0


def psql():
    sql = sys.stdin.read()
    ca = os.environ.get('PGSSLROOTCERT')
    with open(os.path.join(ROOT, 'stub-psql.log'), 'a') as handle:
        handle.write(json.dumps({'user': os.environ.get('PGUSER'), 'ca': ca, 'readOnly':
                                 'default_transaction_read_only=on' in os.environ.get('PGOPTIONS', '')}) + '\n')
    if not ca or not os.path.isfile(ca):
        sys.stderr.write('psql: error: connection failed\nERROR:  08006\n')
        return 2
    name = re.search(r'/\* q:([a-z_]+) \*/', sql).group(1)
    with State() as s:
        names = s['ledgers'].get(name.replace('_ledger', ''), [])
    print(json.dumps({'names': names}))
    return 0


def cp():
    source, dest = ARGS[-2], ARGS[-1]
    assert ARGS[:2] == ['-a', '--link']
    os.makedirs(dest)
    for folder, dirs, files in os.walk(source):
        rel = os.path.relpath(folder, source)
        target = os.path.join(dest, rel) if rel != '.' else dest
        for d in dirs:
            full = os.path.join(folder, d)
            if os.path.islink(full):
                os.symlink(os.readlink(full), os.path.join(target, d))
            else:
                os.makedirs(os.path.join(target, d), exist_ok=True)
                os.chmod(os.path.join(target, d), os.stat(full).st_mode & 0o7777)
        for f in files:
            full = os.path.join(folder, f)
            if os.path.islink(full):
                os.symlink(os.readlink(full), os.path.join(target, f))
            else:
                os.link(full, os.path.join(target, f))
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(folder, d))]
    return 0


sys.exit({'systemctl': systemctl, 'systemd-run': systemd_run, 'curl': curl, 'nginx': nginx, 'psql': psql, 'cp': cp,
          'journalctl': lambda: 0}[NAME]())
'''


def load_profile(path=None):
    path = path or os.environ.get('ARTVENN_RELEASE_PROFILE') or EXAMPLE_PROFILE
    return json.loads(pathlib.Path(path).read_text()), str(path)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def synthetic(key, role=None):
    """A synthetic value of the right shape for a key name (never a real one)."""
    if key.endswith('DATABASE_URL') or key.endswith('_TARGET'):
        return 'postgresql://%s:%s@db.example.invalid:5432/app?sslmode=verify-full' % (
            role or key.lower()[:20].replace('_', ''), 'Pw' + secrets.token_hex(12))
    if key.endswith('CA_FILE'):
        return '/etc/app-test/ca.pem'
    if key == 'AGENT_AUTHORIZATION_CLIENTS':
        return '[{"clientId":"https://client.example.invalid/meta","family":"claude","label":"Claude"}]'
    if key.endswith(('ISSUER', 'RESOURCE', '_URL')):
        return 'https://%s.example.invalid' % key.lower().replace('_', '-')
    return 'Tk' + secrets.token_urlsafe(30)


class FakeHost:
    """profile: the whole release profile (its `host` section drives the layout)."""

    def __init__(self, profile, scratch=None):
        self.profile = profile
        self.h = profile['host']
        self.base = pathlib.Path(tempfile.mkdtemp(prefix='release-fake-', dir=scratch))
        self.root = str(self.base / 'root')
        self.bin = self.base / 'bin'
        self.bin.mkdir(parents=True)
        os.makedirs(self.root)
        self.host_profile = self.base / 'host-profile.json'
        self.host_profile.write_text(json.dumps(self.h, indent=1, sort_keys=True))
        self.values = {}
        self.build()

    # -------------------------------------------------------------------------------------------- layout
    def P(self, path):
        return self.root + path

    def write(self, path, raw, mode=0o644):
        real = self.P(path)
        os.makedirs(os.path.dirname(real), exist_ok=True)
        pathlib.Path(real).write_bytes(raw if isinstance(raw, bytes) else raw.encode())
        os.chmod(real, mode)

    def artifact_rows(self, artifact, label, service):
        """(manifest rows, {path: bytes}) for a small runtime artifact. Parents are listed only where the build lists
        them: `.next/static` and the cache mount; every other parent is implicit."""
        spec = self.h['services'][service]
        cwd = spec.get('cwd') or ''
        pre = (cwd + '/') if cwd else ''
        files = {'package.json': ('{"name":"%s"}' % artifact).encode(),
                 pre + 'entry.js': ('%s %s\n' % (label, artifact)).encode(),
                 pre + 'lib/deep/one.js': ('deep %s\n' % artifact).encode()}
        if artifact == 'backend':
            files['services/agent-authorization/dist/main.js'] = b'issuer\n'
        rows = []
        if spec.get('union'):
            files[pre + '.next/BUILD_ID'] = label.encode()
            files[spec['union'] + '/chunks/%s.js' % label] = ('chunk %s\n' % label).encode()
            rows.append({'path': spec['union'], 'type': 'directory'})
            rows.append({'path': pre + '.next/cache', 'type': 'mount', 'mode': 0o755})
        for path, raw in sorted(files.items()):
            rows.append({'path': path, 'type': 'file', 'sha256': sha(raw), 'mode': 0o444, 'bytes': len(raw)})
        rows.append({'path': pre + 'lib/link.js', 'type': 'symlink', 'target': 'deep/one.js'})
        return rows, files

    def manifest(self, artifact, label, service, source):
        rows, files = self.artifact_rows(artifact, label, service)
        value = {'schema': 1, 'role': artifact, 'source': source, 'status': 'RUNTIME_FILE_PLAN', 'files': rows}
        return json.dumps(value, sort_keys=True).encode(), files

    def lay_root(self, root, manifest_raw, files):
        value = json.loads(manifest_raw)
        for row in value['files']:
            real = self.P(root + '/' + row['path'])
            if row['type'] in ('directory', 'mount'):
                os.makedirs(real, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(real), exist_ok=True)
            if row['type'] == 'symlink':
                os.symlink(row['target'], real)
            else:
                pathlib.Path(real).write_bytes(files[row['path']])
                os.chmod(real, row['mode'] & 0o555)
        self.write(root + '/runtime-manifest.json', manifest_raw, 0o444)

    def pin_text(self, service, label, root):
        """A pin with exactly the profile's number of label tokens on directive lines, in the usual shapes: a comment
        naming the label (never counted), WorkingDirectory, ExecStart, the union and cache binds, then fillers."""
        spec, live = self.h['services'][service], self.h['live'][service]
        count = live['pinCount']
        cwd = root + ('/' + spec['cwd'] if spec.get('cwd') else '')
        lines = ['[Service]', '# release pin written at %s; only the release tool edits this file' % label,
                 'WorkingDirectory=%s' % cwd, 'ExecStart=']
        used = 1
        if count - used >= 1 and count != 1:
            lines.append('ExecStart=/opt/node/bin/node %s/entry.js' % cwd)
            used += 1
        else:
            lines.append('ExecStart=/usr/bin/env NODE_ENV=production /opt/node/bin/node entry.js')
        runtime, cache = self.h['paths']['runtime'], self.h['paths']['cache']
        if spec.get('union') and count - used >= 2:
            lines.append('BindReadOnlyPaths=%s/%s/static-compat/%s:%s/.next/static:rbind' % (runtime, label, service, cwd))
            used += 2
        if spec.get('cache') and count - used >= 4:
            lines.append('BindPaths=%s/%s/%s:%s/.next/cache:rbind' % (cache, label, service, cwd))
            lines.append('ReadWritePaths=%s/.next/cache %s/%s/%s' % (cwd, cache, label, service))
            used += 4
        while used < count:
            lines.append('ReadOnlyPaths=%s' % root)
            used += 1
        assert used == count, 'profile pinCount cannot be laid out for ' + service
        return '\n'.join(lines) + '\n'

    def build(self):
        h = self.h
        state = {'units': {}, 'loaded': {}, 'nextPid': 4000, 'timers': {}, 'ledgers': {}, 'transient': {},
                 'nginx': {'current': None, 'previous': None, 'reloadedAt': 0, 'markers': [[], []]},
                 'stopLandsInFailed': [h['services']['web']['unit']] if 'web' in h['services'] else []}
        self.manifests, self.files = {}, {}
        for service in sorted(h['services']):
            spec, live = h['services'][service], h['live'][service]
            root = live['root']
            if spec.get('cloneOf'):
                continue
            raw, files = self.manifest(spec['artifact'], live['label'], service, live['commit'])
            self.manifests[service], self.files[service] = raw, files
            self.lay_root(root, raw, files)
        for service in sorted(h['services']):
            spec, live = h['services'][service], h['live'][service]
            if spec.get('cloneOf'):
                source = h['live'][spec['cloneOf']]['root']
                shutil.copytree(self.P(source), self.P(live['root']), symlinks=True, copy_function=os.link)
                self.manifests[service] = self.manifests[spec['cloneOf']]
            if spec.get('union'):
                union = '%s/%s/static-compat/%s' % (h['paths']['runtime'], live['label'], service)
                self.write(union + '/chunks/%s.js' % live['label'], 'chunk %s\n' % live['label'])
                self.write(union + '/chunks/older.js', 'older\n')
            if spec.get('cache'):
                os.makedirs(self.P('%s/%s/%s' % (h['paths']['cache'], live['label'], service)), mode=0o750, exist_ok=True)
            pin_dir = '/etc/systemd/system/%s.d' % spec['unit']
            assert os.path.dirname(live['pinFile']) == pin_dir, 'pin outside its unit drop-in directory'
            self.write(pin_dir + '/10-limits.conf', '[Service]\nLimitNOFILE=65536\n')
            self.write(live['pinFile'], self.pin_text(service, live['label'], live['root']))
        for name, spec in h['envFiles'].items():
            values = {}
            for key in spec['keys']:
                role = APP_ROLE if key == 'APP_DATABASE_URL' else DECOY_ROLE if key == 'DATABASE_URL' else None
                values[key] = synthetic(key, role)
            self.values[name] = values
        for rule in h.get('envEqualities', []):
            first = rule['files'][0]
            for other in rule['files'][1:]:
                if rule['key'] in self.values[first] and rule['key'] in self.values[other]:
                    self.values[other][rule['key']] = self.values[first][rule['key']]
        queue = h.get('checks', {}).get('reportQueue')
        if queue and queue['token']['key'] in self.values.get('admin', {}):
            self.values['admin'][queue['token']['key']] = self.values[queue['token']['envFile']][queue['token']['key']]
        for name, spec in h['envFiles'].items():
            body = '# synthetic %s environment\n' % name + ''.join('%s=%s\n' % kv for kv in self.values[name].items())
            self.write(spec['path'], body, 0o600)
            if spec.get('staged'):
                keys = list(self.values[name])
                skip = keys[1] if spec.get('stagedDiffers') and len(keys) > 3 else None
                staged = '# synthetic staged %s environment\n' % name + ''.join(
                    '%s=%s\n' % (k, v) for k, v in self.values[name].items() if k != skip)
                self.write(spec['staged'], staged, 0o600)
        db = h['database']
        operator = {db['operatorApp']['url']: synthetic('APP_MIGRATION_DATABASE_URL', 'r1_migration'),
                    db['operatorApp']['ca']: '/etc/app-test/ca.pem',
                    db['operatorCms']['url']: synthetic('CMS_DATABASE_URL', 'r1_cms')}
        self.write(h['paths']['operator'], json.dumps(operator), 0o600)
        self.write('/etc/app-test/ca.pem', '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n')
        self.write(h['paths']['nginxSite'], '# synthetic site\nserver {\n    server_name %s;\n}\n' % h['checks']['apex'], 0o644)
        os.makedirs(self.P(os.path.dirname(h['paths']['lock'])), exist_ok=True)
        os.makedirs(self.P('/proc'), exist_ok=True)
        os.makedirs(self.P(h['paths'].get('freeSpace', '/')), exist_ok=True)
        state['ledgers'] = {'app': ['20261105010000', '20261105030000'], 'cms': ['20261105_131739_mcp_connection_identity']}
        now = int(time.time())
        for guard in h.get('timerGuards', []):
            state['timers'][guard['timer']] = {'state': 'active', 'next': now + 6 * 3600}
            state['units'][guard['service']] = {'state': 'inactive', 'pid': 0, 'nrestarts': '0'}
        (pathlib.Path(self.root) / 'stub.json').write_text(json.dumps(state))
        stub = STUB.replace('@PYTHON@', sys.executable)
        (self.bin / 'ROOT').write_text(self.root)
        (self.bin / 'profile.json').write_text(json.dumps(self.h))
        for name in TOOLS:
            path = self.bin / name
            path.write_text(stub)
            path.chmod(0o755)
        # Boot: daemon-reload loads the drop-ins, then every managed and untouched unit starts.
        self.systemctl('daemon-reload')
        for spec in list(h['services'].values()) + list(h.get('untouched', {}).values()):
            self.systemctl('start', spec['unit'])

    # -------------------------------------------------------------------------------------------- helpers
    def systemctl(self, *args):
        done = subprocess_run([str(self.bin / 'systemctl')] + list(args))
        assert done == 0, args

    def env(self, **extra):
        value = {'RELEASE_TEST_ROOT': self.root, 'RELEASE_TEST_BIN': json.dumps({n: str(self.bin / n) for n in TOOLS}),
                 'RELEASE_TIME_SCALE': '0.02', 'RELEASE_HOST_PROFILE': str(self.host_profile),
                 'RELEASE_TEST_IGNORE_CLOCK': '1', 'PATH': '/usr/bin:/bin'}
        value.update(extra)
        return value

    def state(self):
        return json.loads((pathlib.Path(self.root) / 'stub.json').read_text())

    def set(self, **knobs):
        path = pathlib.Path(self.root) / 'stub.json'
        value = json.loads(path.read_text())
        value.update(knobs)
        path.write_text(json.dumps(value))

    def unit(self, service):
        return self.state()['units'][self.h['services'][service]['unit']]

    def read(self, path):
        return pathlib.Path(self.P(path)).read_bytes()

    def secrets(self):
        """Every synthetic env value: none of them may ever appear in any output."""
        return {v for values in self.values.values() for v in values.values() if len(v) >= 12}

    def argv_log(self):
        path = pathlib.Path(self.root) / 'stub-argv.log'
        return path.read_text() if path.exists() else ''

    def release(self, commit, modes, scratch=None):
        """A staged release the way release.py builds and stages one: new manifests (unchanged files marked base,
        changed ones as content-addressed blobs), the payload assembled under the state directory, plan.json and
        build.json under plans/<planId>/. Returns the plan id."""
        h = self.h
        label = commit[:8]
        artifacts = sorted({h['services'][s]['artifact'] for s, m in modes.items() if m == 'root'})
        manifests, blobs = {}, {}
        for artifact in artifacts:
            service = next(s for s in sorted(h['services']) if h['services'][s]['artifact'] == artifact and
                           not h['services'][s].get('cloneOf'))
            raw, files = self.manifest(artifact, label, service, commit)
            live = {r['path']: r for r in json.loads(self.manifests[service])['files']}
            value = json.loads(raw)
            for row in value['files']:
                if row['type'] != 'file':
                    continue
                old = live.get(row['path'])
                if old and old.get('sha256') == row['sha256'] and old.get('mode') == row['mode']:
                    row['src'] = 'base'
                else:
                    row['src'] = 'blob'
                    blobs[row['sha256']] = files[row['path']]
            manifests[artifact] = json.dumps(value, sort_keys=True).encode()
        payload_sha = sha(b''.join(sha(m).encode() for m in manifests.values()) + ''.join(sorted(blobs)).encode())
        payload_id = payload_sha[:16]
        folder = h['paths']['state'] + '/payloads/' + payload_id
        for artifact, raw in manifests.items():
            self.write(folder + '/manifests/%s.json' % artifact, raw, 0o600)
        for digest, raw in blobs.items():
            self.write(folder + '/blobs/' + digest, raw, 0o600)
        self.write(folder + '/assembled.json', json.dumps({'payloadSha256': payload_sha}), 0o600)
        order = [s for s in h.get('restartOrder', sorted(h['services'])) if s in modes]
        plan = {'kind': 'artvenn-release-plan', 'schema': 1, 'source': commit, 'label': label, 'order': order,
                'services': {s: {'mode': m, 'artifact': h['services'][s]['artifact']} for s, m in modes.items()}}
        plan_raw = json.dumps(plan, sort_keys=True, indent=1).encode()
        plan_id = sha(plan_raw)[:16]
        build = {'kind': 'artvenn-release-build', 'planId': plan_id, 'source': commit, 'payloadSha256': payload_sha,
                 'payloadId': payload_id, 'manifests': {a: sha(m) for a, m in manifests.items()}}
        self.write(h['paths']['state'] + '/plans/%s/plan.json' % plan_id, plan_raw, 0o600)
        self.write(h['paths']['state'] + '/plans/%s/build.json' % plan_id, json.dumps(build).encode(), 0o600)
        return plan_id

    def outside_release(self, service, label, commit, old_label=None):
        """A release made by another tool: a new root for `service` under `label` (its manifest names `commit`), the
        service's pin rewritten to name it on every directive line, then daemon-reload and a restart."""
        h = self.h
        spec, live = h['services'][service], h['live'][service]
        old_label = old_label or live['label']
        root = '%s/%s/%s' % (h['paths']['runtime'], label, spec.get('rootName') or service)
        raw, files = self.manifest(spec['artifact'], label, service, commit)
        self.lay_root(root, raw, files)
        if spec.get('union'):
            self.write('%s/%s/static-compat/%s/chunks/%s.js' % (h['paths']['runtime'], label, service, label), label)
        if spec.get('cache'):
            os.makedirs(self.P('%s/%s/%s' % (h['paths']['cache'], label, service)), exist_ok=True)
        text = self.read(live['pinFile']).decode()
        lines = [l if l.lstrip().startswith('#') else l.replace(old_label, label) for l in text.split('\n')]
        self.write(live['pinFile'], '\n'.join(lines))
        self.systemctl('daemon-reload')
        self.systemctl('stop', spec['unit'])
        self.systemctl('start', spec['unit'])
        return root

    def close(self):
        state = self.state()
        for pid in state.get('transient', {}).values():
            if pid in (os.getpid(), os.getppid()):
                continue
            try:
                if os.getpgid(pid) == pid:          # only the session leaders the fake systemd-run started
                    os.killpg(pid, 15)
            except OSError:
                pass
        shutil.rmtree(self.base, ignore_errors=True)


def json_values(text):
    """Every JSON object an output holds: whole lines, and the object after `RESULT ` or an event's status word."""
    for line in text.splitlines():
        start = line.find('{')
        if start < 0:
            continue
        try:
            yield json.loads(line[start:])
        except ValueError:
            continue


def secret_shapes(texts, secret_like):
    """Strings shaped like a secret anywhere in the outputs, outside the fields where a digest or a commit belongs."""
    found = []

    def walk(value, key=None):
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, k)
        elif isinstance(value, list):
            for v in value:
                walk(v, key)
        elif isinstance(value, str):
            if key and str(key).lower().endswith('sha256') and len(value) == 64:
                return
            if key in ('commit', 'source') and len(value) == 40:
                return
            if value != '[withheld]' and secret_like(value):
                found.append((key, value[:12]))
    for text in texts:
        for value in json_values(text):
            walk(value)
    return found


def subprocess_run(args):
    import subprocess
    return subprocess.run(args, capture_output=True, timeout=60).returncode
