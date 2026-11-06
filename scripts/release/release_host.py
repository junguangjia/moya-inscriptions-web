#!/usr/bin/python3 -I
"""Standing release tool, host side (phase A). Runs as root, Python standard library only.

Installed once per version next to the private host profile it was built for (release.py install); a release payload
never carries it. Every answer passes a field allowlist and a secret-shape filter: no password, key, token, env value
or certificate key is printed or stored outside the files that already hold it.

  release_host.py baseline                                 read-only facts
  release_host.py facts                                    read-only facts the local plan needs
  release_host.py manifest --service S                     the runtime manifest of S's live root (a file list)
  release_host.py status                                   read-only: lock, release units, ledger head
  release_host.py adopt --run-id ID [--rebaseline]         records the live state as the ledger's next entry
  release_host.py prepare --run-id ID --plan P             new roots, static unions, caches, rendered pins
  release_host.py env-set --run-id ID --files A,B --key K (--value-inbox F | --generate token64) [--add] [--plan P]
  release_host.py switch --run-id ID --services A,B [--plan P]     without a plan: a restart on the same roots
  release_host.py verify --run-id ID                       read-only checks
  release_host.py rollback --run-id ID --to previous
  release_host.py close-out --run-id ID --as accepted

State lives under the profile's state directory: an append-only ledger (ledger.jsonl), a content-addressed store of
every pin and env file version the tool wrote or replaced (store/), one journal per run (runs/), plans, payloads.
Each service has one tool-owned drop-in: the pin the ledger names (adopted once, then only this tool writes it).
Tests set RELEASE_TEST_ROOT (a fake /), RELEASE_TEST_BIN (stub tools), RELEASE_TIME_SCALE and RELEASE_HOST_PROFILE.
"""
import base64
import datetime
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import string
import subprocess
import sys
import tempfile
import time
import urllib.parse

VERSION = 'r1-phase-a-2'
HERE = os.path.dirname(os.path.abspath(__file__))
TEST_ROOT = ''
TEST_BIN = {}
TIME_SCALE = 1.0
TESTING = False
PROFILE = {}
ENV = {}
CHANGEABLE = ('WorkingDirectory', 'ExecStart', 'BindPaths', 'BindReadOnlyPaths', 'ReadWritePaths', 'ReadOnlyPaths')
TOKEN_ALPHABET = string.ascii_letters + string.digits
BASE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin'


def configure(env=None, profile_path=None):
    """Read the test overrides and the profile at call time, so tests can run several fake hosts in one process."""
    global TEST_ROOT, TEST_BIN, TIME_SCALE, TESTING, PROFILE, ENV
    ENV = dict(os.environ if env is None else env)
    TEST_ROOT = ENV.get('RELEASE_TEST_ROOT') or ''
    TEST_BIN = json.loads(ENV.get('RELEASE_TEST_BIN') or '{}')
    TIME_SCALE = float(ENV.get('RELEASE_TIME_SCALE') or '1')
    TESTING = bool(TEST_ROOT)
    path = profile_path or (ENV.get('RELEASE_HOST_PROFILE') if TESTING else None) or os.path.join(HERE, 'profile.json')
    with open(path, 'rb') as handle:
        PROFILE = json.loads(handle.read())
    ALLOWED.update(PROFILE.get('services', {}), PROFILE.get('envFiles', {}), PROFILE.get('untouched', {}))


def check_profile():
    """Refuses a host profile the verbs would misread: every service in restartOrder exactly once (rollback and plan
    walk it), a live entry and known env files for each, and the checks verify reads."""
    services = PROFILE.get('services') or {}
    order = PROFILE.get('restartOrder')
    need(isinstance(order, list) and len(set(order)) == len(order) and set(order) == set(services), 'PROFILE_RESTART_ORDER')
    for service, spec in services.items():
        need(service in (PROFILE.get('live') or {}), 'PROFILE_LIVE_MISSING:' + service)
        need(all(f in (PROFILE.get('envFiles') or {}) for f in spec.get('envFiles', [])), 'PROFILE_ENV_FILE:' + service)
    need(all((PROFILE.get('checks') or {}).get(k) for k in ('apex', 'mcpDoor')), 'PROFILE_CHECKS')


class Refusal(Exception):
    """A named reason that holds no value."""


def need(ok, code):
    if not ok:
        raise Refusal(code)


def code_of(error):
    return str(error) if isinstance(error, Refusal) else 'UNEXPECTED:' + type(error).__name__


# ------------------------------------------------------------------------------------------------ output allowlist

ALLOWED = set('''
status code step runId at finishedAt finishedNs plan failure problems exactState undone warnings failures version
services units ActiveState SubState NRestarts MainPID cwd WorkingDirectory LoadState unit label commit source root
pinFile pinSha256 pinCount envSha256 envFiles live staged exists mode owner keys sha256 file beforeSha256 afterSha256
key files sameInAll generated pendingRestart ledger head seq op id previous base target entries lockFree freeGiB
releaseUnits installed appRole role ledgers app cms rows names have timers timer minutes guards roots union cache
pins linked copied directories symlinks manifestSha256 restart seconds checks pages mcpDoor resourceMetadata issuer
healthz metadata issuerMatches registrationEndpoint reportQueue withToken withoutToken wrongToken baseToken equalities
removed kept removable accepted drift nginxTest artifact labels reason already prepared rendered order mods untouched
manifest bytes files count kind payload payloadId restarted entry missing renders tokenCount utc hostEpoch probes
expect got buildId empty added minutesAway ok renderedSha256 originalSha256 outcome changed staleAnswers waited
rootMoved notAdopted hint rebaselined
'''.split())
REBASELINE = 'run adopt --rebaseline'
LIVE_HINT = 'set profile.live (root, label, commit, pinFile, pinCount) to what runs, install, then adopt --rebaseline'
LABEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{2,80}')
NAME_KEY = re.compile(r'/[A-Za-z0-9_./-]{0,300}|[A-Z][A-Z0-9_]{1,80}|[a-z][a-z0-9.@-]{0,80}\.(?:service|timer)|'
                      r'20[0-9]{6}[0-9_a-z]{0,60}')
SECRET_MARK = re.compile(r'://[^\s/@]*:[^\s/@]*@|-----BEGIN|SCRAM-SHA-256\$|PRIVATE KEY')


def secret_like(text):
    """True for anything that could be a credential: userinfo URLs, PEM, SCRAM, and any run of 32 or more token
    characters that holds base64 punctuation, a mixed-case word or bare hex. Paths and UPPER_SNAKE names pass."""
    if SECRET_MARK.search(text):
        return True
    for run_ in re.findall(r'[A-Za-z0-9+/=_-]{32,}', text):
        if re.search(r'[+=]', run_):
            return True
        if run_.startswith('/'):
            continue
        if any(re.search('[a-z]', w) and re.search('[A-Z]', w) for w in re.findall(r'[A-Za-z0-9]+', run_)):
            return True
        if re.fullmatch(r'[0-9a-f]{32,}', re.sub(r'[-_]', '', run_)):
            return True
    return False


def clean(value, key=None):
    """Keys outside ALLOWED (and outside the name shapes) are dropped; strings shaped like a secret are withheld. A
    64-hex digest passes only in a *Sha256 field, a 40-hex commit only in commit/source."""
    if isinstance(value, dict):
        return {k: clean(v, k) for k, v in value.items()
                if isinstance(k, str) and (k in ALLOWED or NAME_KEY.fullmatch(k))}
    if isinstance(value, (list, tuple)):
        return [clean(v, key) for v in value]
    if isinstance(value, str):
        if key and key.lower().endswith('sha256') and re.fullmatch(r'[0-9a-f]{64}', value):
            return value
        if key in ('commit', 'source') and re.fullmatch(r'[0-9a-f]{40}', value):
            return value
        return '[withheld]' if secret_like(value) else value[:300]
    return value


def emit(value):
    print(json.dumps(clean(value), sort_keys=True), flush=True)


# ------------------------------------------------------------------------------------------------ files and processes

def P(path):
    return TEST_ROOT + path if TEST_ROOT else path


def unprefixed(real):
    return real[len(TEST_ROOT):] if TEST_ROOT and real.startswith(TEST_ROOT) else real


def scaled(seconds):
    return seconds * TIME_SCALE


def sleep(seconds):
    time.sleep(max(0.0, scaled(seconds)))


def sha_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def sha_real(real):
    digest = hashlib.sha256()
    with open(real, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def sha_file(path):
    return sha_real(P(path))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def read(path, limit=64 << 20):
    fd = os.open(P(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        need(stat.S_ISREG(os.fstat(fd).st_mode), 'NOT_A_FILE:' + path)
        data = b''
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                return data
            data += chunk
            need(len(data) <= limit, 'TOO_LARGE:' + path)
    finally:
        os.close(fd)


def exists(path):
    return os.path.lexists(P(path))


def utc_stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def ensure_dir(path, mode=0o700):
    os.makedirs(P(path), mode=mode, exist_ok=True)
    return path


def write_atomic(path, raw, mode, uid=0, gid=0):
    real = P(path)
    os.makedirs(os.path.dirname(real), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.release-', dir=os.path.dirname(real))
    try:
        os.write(fd, raw)
        os.fchmod(fd, mode)
        if not TESTING:
            os.fchown(fd, uid, gid)
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, real)
    finally:
        if fd is not None:
            os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_like(path, raw):
    """Atomic, same owner and mode as the plain single-link file it replaces."""
    info = os.lstat(P(path))
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'NOT_A_PLAIN_FILE:' + path)
    write_atomic(path, raw, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)


def tool(name):
    return TEST_BIN[name] if name in TEST_BIN else PROFILE['tools'][name]


def run(args, seconds=30, env=None, data=None):
    try:
        done = subprocess.run(args, capture_output=True, timeout=max(scaled(seconds), 20) if TESTING else seconds,
                              env=env or {'PATH': BASE_PATH, 'LANG': 'C.UTF-8', 'SYSTEMD_PAGER': ''}, input=data,
                              cwd='/')
        return done.returncode, done.stdout, done.stderr
    except (subprocess.TimeoutExpired, OSError):
        return 124, b'', b''


def state_dir(*parts):
    return '/'.join([PROFILE['paths']['state']] + list(parts))


# ------------------------------------------------------------------------------------------------ journal and lock

CURRENT = []


class Run:
    """One run's journal: <state>/runs/<step>/<runId>.events.jsonl and .result.json. A run's result never replaces
    another run's, so a refusal on the way in never hides an earlier success."""

    def __init__(self, step, run_id):
        need(re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', run_id or '') is not None, 'RUN_ID')
        self.step, self.run_id, self.changed = step, run_id, False
        ensure_dir(state_dir())
        ensure_dir(state_dir('runs', step))
        need(not exists(self.path('result.json')), 'RUN_ID_USED')
        CURRENT[:] = [self]

    def path(self, suffix):
        return state_dir('runs', self.step, '%s.%s' % (self.run_id, suffix))

    def change(self):
        self.changed = True

    def event(self, name, **facts):
        row = clean(dict(facts, at=utc_stamp(), step=self.step, runId=self.run_id, status=name))
        with open(P(self.path('events.jsonl')), 'a') as handle:
            handle.write(json.dumps(row, sort_keys=True) + '\n')

    def finish(self, status, **facts):
        value = clean(dict(facts, status=status, step=self.step, runId=self.run_id, finishedAt=utc_stamp(),
                           finishedNs=time.time_ns(), version=VERSION, changed=self.changed))
        write_atomic(self.path('result.json'), json.dumps(value, sort_keys=True).encode(), 0o600)
        print(json.dumps(value, sort_keys=True), flush=True)
        return value


def results_of(step):
    folder = P(state_dir('runs', step))
    rows = []
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            if name.endswith('.result.json'):
                try:
                    rows.append(json.loads(read(state_dir('runs', step, name))))
                except (ValueError, Refusal, OSError):
                    continue
    return sorted(rows, key=lambda r: r.get('finishedNs') or 0)


LOCKS = []


class Lock:
    """The deploy lock every release toolkit on the host shares; held until the process (or main) ends."""

    def __init__(self):
        self.fd = os.open(P(PROFILE['paths']['lock']), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            raise Refusal('DEPLOY_LOCK_HELD')
        LOCKS.append(self.fd)


def release_locks():
    while LOCKS:
        os.close(LOCKS.pop())


def lock_free():
    path = PROFILE['paths']['lock']
    if not exists(path):
        return True
    fd = os.open(P(path), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


def stop_signal(*_):
    raise Refusal('SIGTERM')


# ------------------------------------------------------------------------------------------------ systemd

UTC_ENV = {'PATH': BASE_PATH, 'LANG': 'C.UTF-8', 'SYSTEMD_PAGER': '', 'TZ': 'UTC'}


def show(unit, props, unix=False):
    """Some systemd versions print timestamps in the host's zone even with --timestamp=unix, so a timestamp read always
    runs with TZ=UTC; a systemd without --timestamp=unix is read again in its plain form, still in UTC."""
    named = ['--property=' + p for p in props]
    rc, out, _ = run([tool('systemctl'), 'show', unit, '--no-pager'] + (['--timestamp=unix'] if unix else []) + named, 15,
                     env=UTC_ENV if unix else None)
    if unix and rc != 0:
        rc, out, _ = run([tool('systemctl'), 'show', unit, '--no-pager'] + named, 15, env=UTC_ENV)
    values = {}
    for line in out.decode('utf-8', 'replace').splitlines():
        key, sep, value = line.partition('=')
        if sep:
            values.setdefault(key, value)
    return values


def stamp_seconds(value):
    """`@1730858400` or the plain UTC form; anything else (a host-zone stamp) is unknown, never guessed."""
    value = (value or '').strip()
    if re.fullmatch(r'@[0-9]{9,12}', value):
        return int(value[1:])
    try:
        return int(datetime.datetime.strptime(value, '%a %Y-%m-%d %H:%M:%S UTC').replace(
            tzinfo=datetime.timezone.utc).timestamp())
    except ValueError:
        return None


def unit_state(unit):
    state = show(unit, ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'NRestarts', 'WorkingDirectory', 'InvocationID'])
    state['cwd'] = None
    if state.get('MainPID') not in (None, '', '0'):
        try:
            state['cwd'] = os.readlink(P('/proc/%s/cwd' % state['MainPID']))
        except OSError:
            pass
    return state


def systemctl(*args, seconds=60):
    rc, _, _ = run([tool('systemctl')] + list(args), seconds)
    return rc


def daemon_reload():
    need(systemctl('daemon-reload') == 0, 'DAEMON_RELOAD')


def stop_unit(unit):
    """A unit that lands in failed on SIGTERM (Web does) counts as stopped."""
    systemctl('stop', unit, seconds=120)
    state = show(unit, ['ActiveState', 'MainPID'])
    need(state.get('ActiveState') in ('inactive', 'failed') and state.get('MainPID') in ('0', ''), 'DID_NOT_STOP:' + unit)


def probes_ok(probes):
    for probe in probes:
        if curl(probe['url'], headers=probe.get('headers'))['code'] != probe.get('expect', '200'):
            return False
    return True


def start_unit(unit, cwd, probes, ready_seconds=180):
    """reset-failed first, then start, then: active, NRestarts 0, the expected cwd, every probe answering."""
    began = time.monotonic()
    systemctl('reset-failed', unit, seconds=15)
    need(systemctl('start', unit, seconds=120) == 0, 'DID_NOT_START:' + unit)
    deadline = time.monotonic() + scaled(ready_seconds)
    while time.monotonic() < deadline:
        state = unit_state(unit)
        need(state.get('ActiveState') != 'failed', 'START_FAILED:' + unit)
        need(state.get('NRestarts') in ('0', ''), 'RESTARTING:' + unit)
        if state.get('ActiveState') == 'active' and state.get('cwd') is not None:
            need(state['cwd'] == cwd or time.monotonic() - began < scaled(5), 'CWD_MISMATCH:' + unit)
            if state['cwd'] == cwd and probes_ok(probes):
                state = unit_state(unit)
                need(state.get('ActiveState') == 'active' and state.get('NRestarts') in ('0', ''), 'RESTARTING:' + unit)
                return round(time.monotonic() - began, 1)
        sleep(1)
    raise Refusal('READY_TIMEOUT:' + unit)


def restart(service, cwd):
    spec = PROFILE['services'][service]
    began = time.monotonic()
    stop_unit(spec['unit'])
    start_unit(spec['unit'], cwd, spec.get('probes') or [], PROFILE.get('readySeconds', {}).get(service, 180))
    return round(time.monotonic() - began, 1)


def directive_key(line):
    stripped = line.strip()
    if not stripped or stripped.startswith(('#', ';', '[')) or '=' not in stripped:
        return None
    return stripped.split('=', 1)[0].strip()


def drop_in_dir(service):
    return '/etc/systemd/system/%s.d' % PROFILE['services'][service]['unit']


# Where systemd reads unit files and drop-ins, highest priority first. Drop-ins from all of them apply in the order of
# their file names; a same-named drop-in in a directory above /etc/systemd/system hides the one there. Only each
# directory's <unit>.d is scanned: prefix drop-ins (yoyi-.service.d) and a top-level service.d are not.
UNIT_DIRS = ('/etc/systemd/system.control', '/run/systemd/system.control', '/run/systemd/transient',
             '/run/systemd/generator.early', '/etc/systemd/system', '/run/systemd/system', '/run/systemd/generator',
             '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system',
             '/run/systemd/generator.late')
ABOVE_ETC = UNIT_DIRS[:UNIT_DIRS.index('/etc/systemd/system')]


def read_unit_text(path):
    """A unit file or drop-in as text, following a symlink the way systemd does."""
    with open(P(path), 'rb') as handle:
        return handle.read(1 << 20).decode('utf-8', 'replace')


def find_pin(service, cwd):
    """The one drop-in naming `cwd` in WorkingDirectory. No drop-in that applies after it (a later file name, in the
    <unit>.d of any directory in UNIT_DIRS) sets any key the pin sets: a later ExecStart, BindPaths or WorkingDirectory
    would win over the pin, so a switch would move the directory while something else runs. A same-named drop-in
    above /etc/systemd/system would hide the pin itself."""
    directory = drop_in_dir(service)
    need(os.path.isdir(P(directory)), 'PIN_DIR_MISSING:' + service)
    names = sorted(n for n in os.listdir(P(directory)) if n.endswith('.conf'))
    hits = [n for n in names if re.search(rb'^WorkingDirectory=' + re.escape(cwd.encode()) + rb'\s*$',
                                          read(directory + '/' + n), re.M)]
    need(len(hits) == 1, 'PIN_COUNT:%s:%d' % (service, len(hits)))
    unit = PROFILE['services'][service]['unit']
    for root in UNIT_DIRS:
        folder = '%s/%s.d' % (root, unit)
        if not os.path.isdir(P(folder)):
            continue
        for name in sorted(n for n in os.listdir(P(folder)) if n.endswith('.conf')):
            if name == hits[0]:
                need(root not in ABOVE_ETC, 'PIN_NOT_LAST:%s:HIDDEN' % service)
                continue
            if name < hits[0]:
                continue
            for line in read_unit_text(folder + '/' + name).split('\n'):
                key = directive_key(line)
                need(key not in CHANGEABLE, 'PIN_NOT_LAST:%s:%s' % (service, key))
    return directory + '/' + hits[0]


def label_count(text, label):
    """How often `label` appears on directive lines; a label on any other directive than CHANGEABLE refuses."""
    count = 0
    for line in text.split('\n'):
        if label in line and directive_key(line) is not None:
            need(directive_key(line) in CHANGEABLE, 'PIN_KEY:%s' % directive_key(line))
            count += line.count(label)
    return count


def render_pin(service, original, old_label, new_label, count):
    """Pure: the old label becomes the new one on CHANGEABLE directive lines, exactly `count` times; comment lines and
    every other line stay byte for byte."""
    need(isinstance(original, bytes) and b'\0' not in original and b'\r' not in original, 'PIN_ENCODING:' + service)
    need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{2,80}', new_label or '') is not None, 'LABEL_SHAPE')
    text = original.decode('utf-8')
    need(label_count(text, old_label) == count, 'PIN_TOKEN_COUNT:%s:%d' % (service, label_count(text, old_label)))
    if old_label == new_label:
        return original
    need(label_count(text, new_label) == 0, 'PIN_ALREADY_NEW:' + service)
    out = []
    for line in text.split('\n'):
        key = directive_key(line)
        out.append(line.replace(old_label, new_label) if key in CHANGEABLE else line)
    rendered = '\n'.join(out)
    need(label_count(rendered, old_label) == 0 and label_count(rendered, new_label) == count, 'PIN_TOKEN_LEFT:' + service)
    keys = lambda value: [directive_key(l) for l in value.split('\n')]
    need(keys(rendered) == keys(text), 'PIN_KEYS_CHANGED:' + service)
    return rendered.encode('utf-8')


def pin_paths(rendered, label):
    """Every absolute path on a CHANGEABLE directive line that names `label` (both sides of a bind), so a switch can
    refuse before any stop when the rendered pin points at something prepare did not make."""
    paths = []
    for line in rendered.decode('utf-8').split('\n'):
        key = directive_key(line)
        if key not in CHANGEABLE or label not in line:
            continue
        for word in line.split('=', 1)[1].split():
            word = word.lstrip('-+!@:')
            parts = word.split(':')[:2] if key in ('BindPaths', 'BindReadOnlyPaths') else [word]
            paths += [p for p in parts if p.startswith('/') and label in p]
    return paths


# ------------------------------------------------------------------------------------------------ env files

ENV_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')


def parse_env(raw):
    """What a service reads from an EnvironmentFile, following systemd's parser (src/basic/env-file.c) state by state:
    `#` or `;` starts a comment only before a key; an unquoted value drops a backslash and keeps the next character,
    eats an escaped newline and loses trailing whitespace; single quotes keep everything; inside double quotes a
    backslash escapes only " \\ ` $ (and a newline); text after a closing quote joins the value. Assignments whose
    name is not a valid environment name (`export X=1`) are dropped, as systemd drops them; the last one wins."""
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise Refusal('ENV_NOT_UTF8')
    values = {}
    state, key, value, key_ws, value_ws = 'PRE_KEY', [], [], None, None

    def push():
        name = ''.join(key[:key_ws] if key_ws is not None else key)
        if ENV_NAME.fullmatch(name):
            values[name] = ''.join(value)

    for c in text.split('\0', 1)[0]:
        if state == 'PRE_KEY':
            if c in '#;':
                state = 'COMMENT'
            elif c not in ' \t\n\r':
                state, key, key_ws = 'KEY', [c], None
        elif state == 'KEY':
            if c in '\n\r':
                state = 'PRE_KEY'
            elif c == '=':
                state, value, value_ws = 'PRE_VALUE', [], None
            else:
                if c not in ' \t\n\r':
                    key_ws = None
                elif key_ws is None:
                    key_ws = len(key)
                key.append(c)
        elif state == 'PRE_VALUE':
            if c in '\n\r':
                push()
                state = 'PRE_KEY'
            elif c == "'":
                state = 'SINGLE'
            elif c == '"':
                state = 'DOUBLE'
            elif c == '\\':
                state = 'VALUE_ESCAPE'
            elif c not in ' \t\n\r':
                state = 'VALUE'
                value.append(c)
        elif state == 'VALUE':
            if c in '\n\r':
                if value_ws is not None:
                    del value[value_ws:]
                push()
                state = 'PRE_KEY'
            elif c == '\\':
                state, value_ws = 'VALUE_ESCAPE', None
            else:
                if c not in ' \t\n\r':
                    value_ws = None
                elif value_ws is None:
                    value_ws = len(value)
                value.append(c)
        elif state == 'VALUE_ESCAPE':
            state = 'VALUE'
            if c not in '\n\r':
                value.append(c)
        elif state == 'SINGLE':
            if c == "'":
                state = 'PRE_VALUE'
            else:
                value.append(c)
        elif state == 'DOUBLE':
            if c == '"':
                state = 'PRE_VALUE'
            elif c == '\\':
                state = 'DOUBLE_ESCAPE'
            else:
                value.append(c)
        elif state == 'DOUBLE_ESCAPE':
            state = 'DOUBLE'
            if c in '"\\`$':
                value.append(c)
            elif c != '\n':
                value += ['\\', c]
        elif state == 'COMMENT':
            if c == '\\':
                state = 'COMMENT_ESCAPE'
            elif c in '\n\r':
                state = 'PRE_KEY'
        elif state == 'COMMENT_ESCAPE':
            state = 'PRE_KEY' if c in '\n\r' else 'COMMENT'
    if state in ('PRE_VALUE', 'VALUE', 'VALUE_ESCAPE', 'SINGLE', 'DOUBLE', 'DOUBLE_ESCAPE'):
        if state == 'VALUE' and value_ws is not None:
            del value[value_ws:]
        push()
    return values


def env_paths(name):
    spec = PROFILE['envFiles'][name]
    return [('live', spec['path'])] + ([('staged', spec['staged'])] if spec.get('staged') else [])


def env_values(name, which='live'):
    path = dict(env_paths(name)).get(which)
    return parse_env(read(path)) if path and exists(path) else None


def env_file_facts(path):
    if not exists(path):
        return {'exists': False}
    info = os.lstat(P(path))
    return {'exists': True, 'mode': oct(stat.S_IMODE(info.st_mode)), 'owner': '%d:%d' % (info.st_uid, info.st_gid),
            'keys': sorted(parse_env(read(path))), 'sha256': sha_file(path)}


def env_shas():
    out = {}
    for name in sorted(PROFILE['envFiles']):
        out[name] = {which: (sha_file(path) if exists(path) else None) for which, path in env_paths(name)}
        out[name].setdefault('staged', None)
    return out


def service_env_sha(service, shas):
    files = (PROFILE['services'].get(service) or {}).get('envFiles', [])
    return sha_bytes(canonical([[f, (shas.get(f) or {}).get('live')] for f in files]))


def set_key(raw, key, value, add):
    """Pure: KEY=value on the one line that sets KEY (or appended with add when absent); nothing else moves."""
    lines = raw.decode('utf-8').split('\n')
    hits = [i for i, line in enumerate(lines) if directive_key(line) == key or
            (directive_key(line) or '').replace('export ', '').strip() == key]
    need(len(hits) <= 1, 'ENV_KEY_REPEATED:' + key)
    if hits:
        lines[hits[0]] = '%s=%s' % (key, value)
        out = '\n'.join(lines).encode()
    else:
        need(add, 'ENV_KEY_ABSENT:' + key)
        out = raw + (b'' if raw.endswith(b'\n') or not raw else b'\n') + ('%s=%s\n' % (key, value)).encode()
    before, after = parse_env(raw), parse_env(out)
    need(after.get(key) == value, 'ENV_VALUE_NOT_READ_BACK:' + key)
    need({k: v for k, v in before.items() if k != key} == {k: v for k, v in after.items() if k != key},
         'ENV_OTHER_KEYS_MOVED:' + key)
    return out


# ------------------------------------------------------------------------------------------------ store and ledger

def store_put(raw):
    digest = sha_bytes(raw)
    path = state_dir('store', digest)
    if not exists(path):
        ensure_dir(state_dir('store'))
        write_atomic(path, raw, 0o600)
    return digest


def store_get(digest, code):
    path = state_dir('store', digest)
    need(re.fullmatch(r'[0-9a-f]{64}', digest or '') is not None and exists(path), code)
    raw = read(path)
    need(sha_bytes(raw) == digest, code)
    return raw


def entry_id(entry):
    return sha_bytes(canonical({k: v for k, v in entry.items() if k != 'id'}))


def ledger():
    """Every entry, oldest first, with its chain checked: seq, previous and id."""
    path = state_dir('ledger.jsonl')
    if not exists(path):
        return []
    rows = []
    for number, line in enumerate(read(path, 256 << 20).decode('utf-8').splitlines()):
        entry = json.loads(line)
        need(entry.get('seq') == number + 1 and entry.get('id') == entry_id(entry) and
             entry.get('previous') == (rows[-1]['id'] if rows else None), 'LEDGER_CHAIN_BROKEN:%d' % (number + 1))
        rows.append(entry)
    return rows


def ledger_head(rows=None):
    rows = ledger() if rows is None else rows
    return rows[-1] if rows else None


def ledger_entry(rows, wanted):
    hits = [r for r in rows if r['id'] == wanted]
    need(len(hits) == 1, 'LEDGER_ENTRY_UNKNOWN')
    return hits[0]


def ledger_append(op, run_id, services, envs, base, **extra):
    """Append-only: O_APPEND, one canonical line, fsync. The entry names the one before it and its own id. It is the
    last thing a step does: once the line is written the step is done (see committed), so SIGTERM waits until the
    write and the fsync are over."""
    rows = ledger()
    head = ledger_head(rows)
    entry = dict(extra, seq=len(rows) + 1, at=utc_stamp(), ns=time.time_ns(), op=op, runId=run_id, services=services,
                 envFiles=envs, previous=head['id'] if head else None, base=base, version=VERSION)
    entry['id'] = entry_id(entry)
    ensure_dir(state_dir())
    blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    try:
        fd = os.open(P(state_dir('ledger.jsonl')), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, json.dumps(entry, sort_keys=True).encode() + b'\n')
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
    return entry


def committed(run_id, op):
    """The entry this run appended, when an error or SIGTERM came after its line reached the ledger (an fsync error,
    a signal held back until the write was over). Every check ran before the append, so the step is done: undoing it
    now would leave the ledger naming a state the services were moved away from, and wedge every later verb."""
    try:
        head = ledger_head()
    except BaseException:
        return None
    return head if head and head.get('runId') == run_id and head.get('op') == op else None


def moved_roots(head):
    """Services the head names whose unit runs on another directory than the head says: a release made outside this
    tool. Until `adopt --rebaseline` records them, every verb names them."""
    moved = []
    for service, item in sorted(head['services'].items()):
        if service in PROFILE['services']:
            state = observe(service)
            if state['ActiveState'] == 'active' and state['cwd'] and state['cwd'] != item['cwd']:
                moved.append(service)
    return moved


def not_adopted(head):
    """Profile services and env files the head does not hold (added to the profile after the ledger began)."""
    return (sorted(set(PROFILE['services']) - set(head['services'])) +
            ['ENV:' + n for n in sorted(set(PROFILE['envFiles']) - set(head['envFiles']))])


def need_current(head):
    """A step that writes starts only from a ledger that covers the profile and still matches the host's roots."""
    extra = sorted(set(head['services']) - set(PROFILE['services']))
    need(not extra, 'NOT_IN_PROFILE:' + ','.join(extra))
    moved = moved_roots(head)
    need(not moved, 'ROOT_MOVED:%s:%s' % (','.join(moved), REBASELINE))
    gaps = not_adopted(head)
    need(not gaps, 'NOT_ADOPTED:%s:run adopt' % ','.join(gaps))


def short(entry):
    return {'seq': entry['seq'], 'op': entry['op'], 'id': entry['id'][:16], 'at': entry['at'], 'plan': entry.get('plan'),
            'base': (entry.get('base') or '')[:16] or None}


def check_drift(head):
    """What the tool owns is still what the ledger's head says: every pin and every env file, byte for byte."""
    drift = []
    for service, item in head['services'].items():
        if not exists(item['pinFile']) or sha_file(item['pinFile']) != item['pinSha256']:
            drift.append('PIN:' + service)
    now = env_shas()
    for name, item in head['envFiles'].items():
        if now.get(name) != item:
            drift.append('ENV:' + name)
    return drift


# ------------------------------------------------------------------------------------------------ http

KEPT_HEADERS = ('www-authenticate', 'content-type', 'location')


def curl(url, method='GET', headers=None, resolve=None, insecure=False, token=None, seconds=20):
    """Code, a few named headers and the body, in memory only. A token goes through a 0600 header file, never argv."""
    scratch = ensure_dir(state_dir('tmp'))
    head_fd, head_path = tempfile.mkstemp(prefix='h-', dir=P(scratch))
    body_fd, body_path = tempfile.mkstemp(prefix='b-', dir=P(scratch))
    os.close(head_fd)
    os.close(body_fd)
    auth_path = None
    args = [tool('curl'), '-sS', '--noproxy', '*', '--max-time', str(seconds), '--max-filesize', '1048576', '-X', method,
            '-D', head_path, '-o', body_path, '-w', '%{http_code}']
    for name, value in (headers or {}).items():
        args += ['-H', '%s: %s' % (name, value)]
    if token is not None:
        fd, auth_path = tempfile.mkstemp(prefix='a-', dir=P(scratch))
        with os.fdopen(fd, 'w') as handle:
            handle.write('Authorization: Bearer %s\n' % token)
        args += ['-H', '@' + auth_path]
    if method == 'POST':
        args += ['-H', 'Content-Type: application/json', '--data', '{}']
    if resolve:
        args += ['--resolve', resolve]
    if insecure:
        args.append('--insecure')
    try:
        rc, out, _ = run(args + ['--url', url], seconds + 5)
        heads = {}
        try:
            for line in open(head_path, 'rb').read().decode('latin-1').splitlines():
                name, sep, value = line.partition(':')
                if sep and name.strip().lower() in KEPT_HEADERS:
                    heads[name.strip().lower()] = value.strip()
            body = open(body_path, 'rb').read(65536)
        except OSError:
            body = b''
        code = out.decode().strip()
        return {'code': code if rc == 0 and re.fullmatch(r'[0-9]{3}', code) else 'none', 'headers': heads, 'body': body}
    finally:
        for path in (head_path, body_path, auth_path):
            if path and os.path.exists(path):
                os.unlink(path)


def body_json(answer):
    try:
        return json.loads(answer['body'].decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return None


# ------------------------------------------------------------------------------------------------ nginx

def nginx_test():
    rc, _, _ = run([tool('nginx'), '-t', '-q'], 60)
    return rc == 0


def nginx_settle():
    """`systemctl reload` returns once the signal is sent; an old worker can still answer with the previous
    configuration for a moment, so nothing is checked before this wait."""
    sleep(PROFILE.get('settleSeconds', 3))


def nginx_reload():
    need(nginx_test(), 'NGINX_TEST_FAILED')
    need(systemctl('reload', 'nginx.service') == 0, 'NGINX_RELOAD_FAILED')
    nginx_settle()


def nginx_write(raw, allowed_current):
    """The site file replaced only when it is still one of the expected versions, tested before the reload; a failed
    test puts the previous bytes back and reloads nothing. Returns the bytes it replaced."""
    site = PROFILE['paths']['nginxSite']
    before = read(site)
    need(sha_bytes(before) in allowed_current, 'NGINX_FILE_DRIFT')
    store_put(before)
    write_like(site, raw)
    if not nginx_test():
        write_like(site, before)
        raise Refusal('NGINX_TEST_FAILED')
    need(systemctl('reload', 'nginx.service') == 0, 'NGINX_RELOAD_FAILED')
    nginx_settle()
    return before


# ------------------------------------------------------------------------------------------------ database (read-only)

def url_parts(raw):
    return urllib.parse.urlsplit(raw or '')


def operator_json():
    return json.loads(read(PROFILE['paths']['operator']))


class Database:
    """psql with the credential only in the child environment, statements on stdin, errors as a SQLSTATE only."""

    def __init__(self, url, ca, label):
        parts = url_parts(url)
        need(parts.password and parts.username and parts.hostname, 'DB_URL_SHAPE:' + label)
        query = urllib.parse.parse_qs(parts.query)
        self.env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent', 'PGHOST': parts.hostname,
                    'PGPORT': str(parts.port or 5432), 'PGDATABASE': parts.path.lstrip('/'),
                    'PGUSER': urllib.parse.unquote(parts.username), 'PGPASSWORD': urllib.parse.unquote(parts.password),
                    'PGSSLMODE': (query.get('sslmode') or ['verify-full'])[0], 'PGCONNECT_TIMEOUT': '10',
                    'PGAPPNAME': 'artvenn-release', 'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=30000'}
        if ca:
            self.env['PGSSLROOTCERT'] = ca
        self.label = label

    def json(self, name, statement):
        args = [tool('psql'), '--no-psqlrc', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-f', '-']
        rc, out, err = run(args, 45, env=self.env, data=('/* q:%s */\n%s\n' % (name, statement)).encode())
        state = re.search(rb'ERROR:\s+([0-9A-Z]{5})', err)
        need(rc == 0, 'SQL_FAILED:%s:%s' % (name, state.group(1).decode() if state else rc))
        lines = [l for l in out.decode('utf-8', 'replace').splitlines() if l.strip()]
        need(len(lines) == 1, 'SQL_SHAPE:' + name)
        return json.loads(lines[0])


def database(which):
    """The App ledger through the App migration URL and CA; the CMS ledger through the CMS URL and the CMS CA, or the
    App migration CA when operator.json names none."""
    spec = PROFILE['database']
    operator = operator_json()
    keys = spec['operatorApp'] if which == 'app' else spec['operatorCms']
    url = operator.get(keys['url'])
    need(isinstance(url, str) and url, 'DATABASE_URL_MISSING:' + which)
    ca = operator.get(keys['ca']) or operator.get(spec['caFallback'])
    need(ca and exists(ca), 'DATABASE_CA_MISSING:' + which)
    return Database(url, P(ca) if TESTING else ca, which)


def db_ledgers():
    out = {}
    try:
        out['app'] = database('app').json('app_ledger', "SELECT json_build_object('names',(SELECT coalesce(json_agg("
                                          "migration_id ORDER BY migration_id),'[]'::json) FROM community.schema_migrations))")
    except Refusal as error:
        out['app'] = {'status': 'REFUSED', 'code': str(error)}
    try:
        out['cms'] = database('cms').json('cms_ledger', "SELECT json_build_object('names',(SELECT coalesce(json_agg(name "
                                          "ORDER BY name),'[]'::json) FROM payload_migrations))")
    except Refusal as error:
        out['cms'] = {'status': 'REFUSED', 'code': str(error)}
    return out


def app_role():
    """The Backend's App role is the user of APP_DATABASE_URL (the profile names the key); backend.env also holds a
    DATABASE_URL with another role, which is never read for this."""
    spec = PROFILE['database']['appRole']
    values = env_values(spec['envFile']) or {}
    url = values.get(spec['key'])
    role = urllib.parse.unquote(url_parts(url).username or '') if url else ''
    return {'key': spec['key'], 'role': role if re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role) else None}


# ------------------------------------------------------------------------------------------------ guards

def time_guard():
    now = datetime.datetime.now(datetime.timezone.utc)
    minute = now.hour * 60 + now.minute
    start, end = PROFILE['reservedUtc']
    need((TESTING and ENV.get('RELEASE_TEST_IGNORE_CLOCK') == '1') or not start <= minute <= end, 'RESERVED_UTC_WINDOW')
    return timer_guards(enforce=True)


def timer_guards(enforce=False):
    """No release step while a backup or archive runs, or within its guard minutes of the next run (read in UTC).
    Enforced, it fails closed: a timer or service systemd does not report as loaded with a known state (a `systemctl
    show` that timed out, failed or answered nothing) refuses, as the run it guards against could be under way."""
    out = []
    for guard in PROFILE.get('timerGuards', []):
        service = show(guard['service'], ['LoadState', 'ActiveState'])
        timer = show(guard['timer'], ['LoadState', 'ActiveState', 'NextElapseUSecRealtime'], unix=True)
        upcoming = stamp_seconds(timer.get('NextElapseUSecRealtime'))
        row = {'timer': guard['timer'], 'ActiveState': timer.get('ActiveState'), 'LoadState': timer.get('LoadState')}
        if upcoming is not None:
            row['minutesAway'] = round((upcoming - time.time()) / 60.0, 1)
        out.append(row)
        if enforce:
            need(service.get('LoadState') == 'loaded' and service.get('ActiveState'), 'TIMER_STATE_UNKNOWN:' + guard['service'])
            need(timer.get('LoadState') == 'loaded' and timer.get('ActiveState') in ('active', 'inactive', 'failed'),
                 'TIMER_STATE_UNKNOWN:' + guard['timer'])
            need(service['ActiveState'] in ('inactive', 'failed'), 'TIMER_SERVICE_ACTIVE:' + guard['service'])
            if timer['ActiveState'] == 'active':
                need(upcoming is not None, 'TIMER_TIMES_UNKNOWN:' + guard['timer'])
                need(row['minutesAway'] >= guard['minutes'], 'TIMER_TOO_CLOSE:%s' % guard['timer'])
    return out


# ------------------------------------------------------------------------------------------------ roots

def runtime_dir(label):
    return '%s/%s' % (PROFILE['paths']['runtime'], label)


def root_of(service, label):
    spec = PROFILE['services'][service]
    return '%s/%s' % (runtime_dir(label), spec.get('rootName') or service)


def cwd_of(service, root):
    sub = PROFILE['services'][service].get('cwd') or ''
    return root + ('/' + sub if sub else '')


def union_of(service, label):
    return '%s/static-compat/%s' % (runtime_dir(label), service)


def cache_of(service, label):
    return '%s/%s/%s' % (PROFILE['paths']['cache'], label, service)


def payload_dir(payload_id):
    return state_dir('payloads', payload_id)


def manifest_rows(raw):
    value = json.loads(raw)
    need(isinstance(value.get('files'), list), 'MANIFEST_SHAPE')
    return value


def assemble(manifest_raw, payload, base, dest):
    """A new root from the manifest: a row marked `base` is a hard link to the live root's file after its sha256 and
    mode are checked; anything else comes from the payload's content-addressed blobs. Built aside, verified, renamed."""
    value = manifest_rows(manifest_raw)
    need(not exists(dest), 'ROOT_EXISTS:' + dest)
    partial = dest + '.partial'
    if exists(partial):
        shutil.rmtree(P(partial))
    os.makedirs(P(partial), mode=0o755)
    counts = {'linked': 0, 'copied': 0, 'directories': 0, 'symlinks': 0}
    links = []
    for row in value['files']:
        path = row['path']
        need(not path.startswith('/') and '..' not in path.split('/') and path, 'MANIFEST_PATH')
        target = P(partial + '/' + path)
        kind = row['type']
        if kind in ('directory', 'mount'):
            os.makedirs(target, exist_ok=True)
            os.chmod(target, (row.get('mode', 0o755) & 0o755) if kind == 'mount' else 0o755)
            counts['directories'] += 1
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if kind == 'symlink':
            links.append((target, row['target']))
            continue
        mode = row['mode'] & 0o555
        if row.get('src') == 'base':
            candidate = P(base + '/' + path)
            info = os.lstat(candidate) if os.path.lexists(candidate) else None
            need(info is not None and stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == mode, 'BASE_DIFFERS:' + path)
            need(sha_real(candidate) == row['sha256'], 'BASE_DIFFERS:' + path)
            os.link(candidate, target)
            counts['linked'] += 1
        else:
            blob = P(payload + '/blobs/' + row['sha256'])
            need(os.path.isfile(blob), 'BLOB_MISSING:' + path)
            data = open(blob, 'rb').read()
            need(sha_bytes(data) == row['sha256'] and len(data) == row.get('bytes', len(data)), 'BLOB_SHA:' + path)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
            os.chmod(target, mode)
            counts['copied'] += 1
    for target, link in links:
        os.symlink(link, target)
        counts['symlinks'] += 1
    real = os.path.realpath(P(partial))
    for target, _ in links:
        resolved = os.path.realpath(target)
        need(resolved == real or resolved.startswith(real + os.sep), 'SYMLINK_LEAVES_ROOT')
    fd = os.open(P(partial + '/runtime-manifest.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(manifest_raw)
    verify_root(manifest_raw, partial)
    os.rename(P(partial), P(dest))
    counts['manifestSha256'] = sha_bytes(manifest_raw)
    return counts


def verify_root(manifest_raw, root):
    """Exact path set, types, modes, link targets and every file's sha256. Build manifests list a parent directory only
    when it is itself an entry; such an implicit parent must be a plain directory."""
    want = {row['path']: row for row in manifest_rows(manifest_raw)['files']}
    implicit = {'/'.join(path.split('/')[:i]) for path in want for i in range(1, len(path.split('/')))} - set(want)
    seen = set()
    base = P(root)
    need(os.path.isdir(base), 'ROOT_MISSING_DIR')
    for folder, directories, files in os.walk(base):
        for name in directories + files:
            full = os.path.join(folder, name)
            rel = os.path.relpath(full, base)
            if rel == 'runtime-manifest.json':
                continue
            if rel in implicit:
                need(os.path.isdir(full) and not os.path.islink(full), 'ROOT_DIR:' + rel)
                continue
            row = want.get(rel)
            need(row is not None, 'ROOT_EXTRA:' + rel)
            seen.add(rel)
            if row['type'] == 'symlink':
                need(os.path.islink(full) and os.readlink(full) == row['target'], 'ROOT_LINK:' + rel)
            elif row['type'] in ('directory', 'mount'):
                need(os.path.isdir(full) and not os.path.islink(full), 'ROOT_DIR:' + rel)
            else:
                info = os.lstat(full)
                need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == row['mode'] & 0o555, 'ROOT_MODE:' + rel)
                need(sha_real(full) == row['sha256'], 'ROOT_SHA:' + rel)
        directories[:] = [d for d in directories if not os.path.islink(os.path.join(folder, d))]
    need(seen == set(want), 'ROOT_MISSING:%d' % len(set(want) - seen))


def build_union(old, new_static, dest):
    """The live static union plus the new root's static files, hard links, refusing a name with other bytes."""
    need(not exists(dest), 'UNION_EXISTS')
    partial = dest + '.partial'
    if exists(partial):
        shutil.rmtree(P(partial))
    rows = {}
    for source in (old, new_static):
        need(os.path.isdir(P(source)), 'UNION_SOURCE_MISSING:' + source)
        for folder, _, files in os.walk(P(source)):
            for name in files:
                full = os.path.join(folder, name)
                rel = os.path.relpath(full, P(source))
                need(os.path.isfile(full) and not os.path.islink(full), 'UNION_NOT_FILE:' + rel)
                digest = sha_real(full)
                if rel in rows:
                    need(rows[rel][1] == digest, 'STATIC_UNION_COLLISION:' + rel)
                    continue
                rows[rel] = (full, digest)
    os.makedirs(P(partial), mode=0o755, exist_ok=True)
    for rel, (full, _) in sorted(rows.items()):
        target = P(partial + '/' + rel)
        os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
        os.link(full, target)
    os.rename(P(partial), P(dest))
    return len(rows)


def ensure_cache(live, dest):
    """An empty cache directory owned and moded like the live one."""
    info = os.lstat(P(live))
    need(stat.S_ISDIR(info.st_mode), 'LIVE_CACHE_MISSING:' + live)
    if not exists(dest):
        os.makedirs(P(os.path.dirname(dest)), mode=0o755, exist_ok=True)
        os.mkdir(P(dest), stat.S_IMODE(info.st_mode))
        os.chmod(P(dest), stat.S_IMODE(info.st_mode))
        if not TESTING:
            os.chown(P(dest), info.st_uid, info.st_gid)
    mine = os.lstat(P(dest))
    need(stat.S_ISDIR(mine.st_mode) and (mine.st_uid, mine.st_gid) == (info.st_uid, info.st_gid), 'CACHE_OWNER')
    return '%d:%d' % (mine.st_uid, mine.st_gid)


def clone_root(source, dest, manifest_raw):
    """A hard-link copy of a verified root (the issuer runs from its own copy of the Backend's)."""
    if exists(dest):
        verify_root(manifest_raw, dest)
        return 'ALREADY'
    partial = dest + '.partial'
    if exists(partial):
        shutil.rmtree(P(partial))
    rc, _, _ = run([tool('cp'), '-a', '--link', P(source), P(partial)], 600)
    need(rc == 0, 'CLONE_FAILED:%d' % rc)
    verify_root(manifest_raw, partial)
    os.rename(P(partial), P(dest))
    return 'CLONED'


# ------------------------------------------------------------------------------------------------ plans

def load_plan(plan_id):
    need(re.fullmatch(r'[0-9a-f]{16}', plan_id or '') is not None, 'PLAN_ID')
    folder = state_dir('plans', plan_id)
    need(exists(folder + '/plan.json') and exists(folder + '/build.json'), 'PLAN_NOT_STAGED:' + plan_id)
    raw = read(folder + '/plan.json')
    need(sha_bytes(raw)[:16] == plan_id, 'PLAN_SHA')
    plan, build = json.loads(raw), json.loads(read(folder + '/build.json'))
    need(build.get('planId') == plan_id and build.get('source') == plan.get('source'), 'BUILD_NOT_THIS_PLAN')
    return plan, build


def plan_manifest(build, artifact):
    folder = payload_dir(build['payloadId'])
    need(exists(folder + '/assembled.json'), 'PAYLOAD_NOT_STAGED')
    need(json.loads(read(folder + '/assembled.json')).get('payloadSha256') == build['payloadSha256'], 'PAYLOAD_SHA')
    raw = read(folder + '/manifests/%s.json' % artifact, 256 << 20)
    need(sha_bytes(raw) == build['manifests'].get(artifact), 'MANIFEST_SHA:' + artifact)
    return raw, folder


def prepared_for(plan_id):
    hits = [r for r in results_of('prepare') if r.get('plan') == plan_id and r.get('status') == 'PREPARED']
    need(hits, 'PREPARE_NOT_DONE:' + plan_id)
    return hits[-1]


# ------------------------------------------------------------------------------------------------ live state

def observe(service):
    unit = PROFILE['services'][service]['unit']
    state = unit_state(unit)
    return {k: state.get(k) for k in ('LoadState', 'ActiveState', 'NRestarts', 'WorkingDirectory', 'cwd')}


def adopt_state(names=None):
    """The live state as the profile says the last release left it, checked against the host: each service runs on
    its live root, and its pin names that root with the expected number of label tokens."""
    services = {}
    for service in sorted(PROFILE['services'] if names is None else names):
        live = PROFILE['live'][service]
        cwd = cwd_of(service, live['root'])
        need(live['root'] == root_of(service, live['label']), 'PROFILE_ROOT_SHAPE:' + service)
        state = observe(service)
        need(state['ActiveState'] == 'active' and state['cwd'] == cwd, 'ADOPT_LIVE_MISMATCH:' + service)
        pin = find_pin(service, cwd)
        need(pin == live['pinFile'], 'ADOPT_PIN_FILE:%s:%s' % (service, LIVE_HINT))
        raw = read(pin)
        need(label_count(raw.decode('utf-8', 'replace'), live['label']) == live['pinCount'], 'ADOPT_PIN_COUNT:%s:%s' % (service, LIVE_HINT))
        store_put(raw)
        services[service] = {'unit': PROFILE['services'][service]['unit'], 'label': live['label'], 'commit': live['commit'],
                             'root': live['root'], 'cwd': cwd, 'pinFile': pin, 'pinSha256': sha_bytes(raw),
                             'pinCount': live['pinCount']}
    return services


def manifest_source(root):
    """The commit a root was built from, as its runtime manifest names it (None when it names none)."""
    try:
        value = json.loads(read(root + '/runtime-manifest.json', 256 << 20))
    except (OSError, ValueError, Refusal):
        return None
    source = value.get('source') if isinstance(value, dict) else None
    return source if isinstance(source, str) and re.fullmatch(r'[0-9a-f]{40}', source) else None


def moved_state(service, item):
    """A service a release outside this tool moved, re-recorded from the host: the root and label from the unit's
    working directory, checked the way adopt_state checks a first adopt (the unit runs there, find_pin finds one pin
    naming it and nothing later overrides it, the pin holds the expected number of label tokens). The expected pin
    file and count are profile.live's when it names that root, otherwise the ones the head recorded; the commit is
    the root manifest's source, or profile.live's."""
    spec = PROFILE['services'][service]
    state = observe(service)
    cwd = state['cwd'] or ''
    need(state['ActiveState'] == 'active' and cwd, 'ADOPT_LIVE_MISMATCH:' + service)
    sub = spec.get('cwd') or ''
    need(not sub or cwd.endswith('/' + sub), 'REBASELINE_ROOT_SHAPE:' + service)
    root = cwd[:-(len(sub) + 1)] if sub else cwd
    label = os.path.basename(os.path.dirname(root))
    need(LABEL.fullmatch(label) is not None and root == root_of(service, label), 'REBASELINE_ROOT_SHAPE:' + service)
    live = PROFILE['live'].get(service) or {}
    named = live.get('root') == root and live.get('label') == label
    pin_file, pin_count = (live['pinFile'], live['pinCount']) if named else (item['pinFile'], item['pinCount'])
    commits = {c for c in (manifest_source(root), live.get('commit') if named else None) if c}
    need(len(commits) == 1, 'REBASELINE_COMMIT_%s:%s' % ('UNKNOWN' if not commits else 'DIFFERS', service))
    pin = find_pin(service, cwd)
    need(pin == pin_file, 'ADOPT_PIN_FILE:%s:%s' % (service, LIVE_HINT))
    raw = read(pin)
    need(label_count(raw.decode('utf-8', 'replace'), label) == pin_count, 'ADOPT_PIN_COUNT:%s:%s' % (service, LIVE_HINT))
    store_put(raw)
    return {'unit': spec['unit'], 'label': label, 'commit': commits.pop(), 'root': root, 'cwd': cwd, 'pinFile': pin,
            'pinSha256': sha_bytes(raw), 'pinCount': pin_count}


def snapshot_envs():
    for name in PROFILE['envFiles']:
        for _, path in env_paths(name):
            if exists(path):
                store_put(read(path))
    return env_shas()


def with_env(services, envs):
    return {s: dict(v, envSha256=service_env_sha(s, envs)) for s, v in services.items()}


# ------------------------------------------------------------------------------------------------ read-only commands

def baseline():
    facts = {'utc': datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M'), 'hostEpoch': int(time.time()),
             'lockFree': lock_free(), 'version': VERSION}
    usage = shutil.disk_usage(P(PROFILE['paths'].get('freeSpace', '/')) if exists(PROFILE['paths'].get('freeSpace', '/'))
                              else P('/'))
    facts['freeGiB'] = round(usage.free / (1 << 30), 1)
    facts['units'] = {name: observe(name) for name in PROFILE['services']}
    for name, spec in PROFILE.get('untouched', {}).items():
        state = unit_state(spec['unit'])
        facts['units'][name] = {k: state.get(k) for k in ('ActiveState', 'NRestarts', 'cwd')}
    head = ledger_head()
    facts['ledger'] = {'entries': head['seq'] if head else 0, 'head': short(head) if head else None}
    moved = ledger_gaps(head, facts)
    facts['pins'] = {}
    for service in PROFILE['services']:
        if head and (service not in head['services'] or service in moved):
            code = ('ROOT_MOVED:%s:%s' % (service, REBASELINE)) if service in moved else 'NOT_ADOPTED:%s:run adopt' % service
            facts['pins'][service] = {'status': 'REFUSED', 'code': code}
            continue
        live = head['services'][service] if head else dict(PROFILE['live'][service], cwd=cwd_of(service, PROFILE['live'][service]['root']))
        try:
            pin = find_pin(service, live['cwd'])
            raw = read(pin)
            count = label_count(raw.decode('utf-8', 'replace'), live['label'])
            facts['pins'][service] = {'file': pin, 'sha256': sha_bytes(raw), 'tokenCount': count,
                                      'status': 'RENDERS' if count == live['pinCount'] else 'COUNT_DIFFERS'}
        except Refusal as error:
            facts['pins'][service] = {'status': 'REFUSED', 'code': str(error)}
    facts['envFiles'] = {}
    for name in PROFILE['envFiles']:
        for which, path in env_paths(name):
            facts['envFiles'].setdefault(name, {})[which] = env_file_facts(path)
    facts['appRole'] = app_role()
    facts['ledgers'] = db_ledgers()
    facts['timers'] = timer_guards()
    facts['nginxTest'] = nginx_test()
    facts['status'] = 'BASELINE'
    emit(facts)
    return 0


def ledger_gaps(head, out):
    """For the read-only verbs: what the head lacks (notAdopted) and which roots moved under it (rootMoved), with the
    step that fixes them. Moves are looked for only while no release step holds the lock, as a step part way through a
    restart has a unit on its new root before its ledger line is written."""
    if head is None:
        return []
    out['notAdopted'] = not_adopted(head)
    moved = moved_roots(head) if lock_free() else []
    out['rootMoved'] = moved
    if moved or out['notAdopted']:
        out['hint'] = REBASELINE if moved else 'run adopt'
    return moved


def facts_cmd():
    """What the local plan needs: the ledger head (or the profile's live state before any entry), the env key names,
    the migration ledgers and each live root's manifest sha256; and what the head lacks or no longer matches, which
    the plan refuses."""
    head = ledger_head()
    services = head['services'] if head else {s: {'label': v['label'], 'commit': v['commit'], 'root': v['root']}
                                              for s, v in PROFILE['live'].items()}
    out = {'status': 'FACTS', 'version': VERSION, 'ledger': {'head': short(head) if head else None},
           'services': {}, 'envFiles': {}}
    ledger_gaps(head, out)
    for service, item in services.items():
        path = item['root'] + '/runtime-manifest.json'
        out['services'][service] = {'label': item['label'], 'commit': item['commit'], 'root': item['root'],
                                    'manifestSha256': sha_file(path) if exists(path) else None}
    for name in PROFILE['envFiles']:
        values = env_values(name)
        out['envFiles'][name] = {'keys': sorted(values) if values is not None else None}
    out['ledgers'] = db_ledgers()
    emit(out)
    return 0


MANIFEST_KEYS = {'path', 'type', 'sha256', 'mode', 'bytes', 'target', 'src'}


def manifest_cmd(service):
    """The live root's runtime manifest (a list of file names and digests, no content), for the local delta. Checked to
    hold only manifest fields, printed raw (base64) with its sha256: the allowlist would mangle file names."""
    need(service in PROFILE['services'], 'SERVICE')
    head = ledger_head()
    root = head['services'][service]['root'] if head else PROFILE['live'][service]['root']
    raw = read(root + '/runtime-manifest.json', 256 << 20)
    value = manifest_rows(raw)
    need(all(isinstance(r, dict) and set(r) <= MANIFEST_KEYS for r in value['files']), 'MANIFEST_FIELDS')
    print(json.dumps({'status': 'MANIFEST', 'sha256': sha_bytes(raw), 'b64': base64.b64encode(raw).decode()}), flush=True)
    return 0


def status_cmd():
    rc, out, _ = run([tool('systemctl'), 'list-units', '--all', '--plain', '--no-legend', '--no-pager',
                      PROFILE['unitPrefix'] + '*'], 15)
    units = [{'unit': p[0], 'ActiveState': p[2]} for p in (l.split() for l in out.decode().splitlines())
             if len(p) >= 3 and p[0].startswith(PROFILE['unitPrefix'])]
    head = ledger_head()
    tools_dir = P(state_dir('host-tool'))
    usage = shutil.disk_usage(P(PROFILE['paths'].get('freeSpace', '/')) if exists(PROFILE['paths'].get('freeSpace', '/'))
                              else P('/'))
    out = {'status': 'STATUS', 'version': VERSION, 'lockFree': lock_free(), 'releaseUnits': units,
           'ledger': {'entries': head['seq'] if head else 0, 'head': short(head) if head else None},
           'installed': sorted(os.listdir(tools_dir)) if os.path.isdir(tools_dir) else [],
           'freeGiB': round(usage.free / (1 << 30), 1)}
    ledger_gaps(head, out)
    emit(out)
    return 0


# ------------------------------------------------------------------------------------------------ adopt

def adopt(run_id, rebaseline=False):
    """The first entry, or a new one after a change made outside this tool: the live state as found. Services and env
    files added to the profile after the ledger began are added, checked against profile.live like a first adopt.
    With --rebaseline it also re-records services a release made outside this tool moved to another root (see
    moved_state); without it such a move refuses. An adopt entry has no base, so rollback --to previous never
    crosses it into a state someone else replaced."""
    step = Run('adopt', run_id)
    Lock()
    head = ledger_head()
    moved, added, pending = [], [], []
    if head is None:
        services = adopt_state()
    else:
        extra = sorted(set(head['services']) - set(PROFILE['services']))
        need(not extra, 'NOT_IN_PROFILE:' + ','.join(extra))
        moved = moved_roots(head)
        need(rebaseline or not moved, 'ROOT_MOVED:%s:%s' % (','.join(moved), REBASELINE))
        added = not_adopted(head)
        need(moved or added or check_drift(head), 'NOTHING_TO_ADOPT')
        services = {}
        for service, item in head['services'].items():
            if service in moved:
                services[service] = moved_state(service, item)
                continue
            state = observe(service)
            need(state['ActiveState'] == 'active' and state['cwd'] == item['cwd'], 'ADOPT_LIVE_MISMATCH:' + service)
            live = PROFILE['live'].get(service) or {}
            named = live.get('root') == root_of(service, item['label']) and live.get('label') == item['label']
            pin_file, pin_count = (live['pinFile'], live['pinCount']) if named else (item['pinFile'], item['pinCount'])
            pin = find_pin(service, item['cwd'])
            need(pin == pin_file, 'ADOPT_PIN_FILE:%s:%s' % (service, LIVE_HINT))
            raw = read(pin)
            need(label_count(raw.decode('utf-8', 'replace'), item['label']) == pin_count, 'ADOPT_PIN_COUNT:%s:%s' % (service, LIVE_HINT))
            store_put(raw)
            services[service] = dict(item, pinFile=pin_file, pinCount=pin_count, pinSha256=sha_bytes(raw))
        services.update(adopt_state([s for s in added if not s.startswith('ENV:')]))
        # A restart still owed stays owed: the env files it waits for are recorded as they are.
        pending = sorted(s for s in head.get('pendingRestart') or [] if s in services and s not in moved)
    step.change()
    envs = snapshot_envs()
    entry = ledger_append('adopt', run_id, with_env(services, envs), envs, None, pendingRestart=pending,
                          rebaselined=moved, added=added)
    step.finish('ADOPTED', entry=short(entry), rebaselined=moved, added=added,
                services={s: {'label': v['label'], 'cwd': v['cwd']} for s, v in services.items()})
    return 0


# ------------------------------------------------------------------------------------------------ prepare

def prepare(run_id, plan_id):
    step = Run('prepare', run_id)
    Lock()
    os.umask(0o022)       # runtime trees keep ordinary modes: services read them as their own users
    plan, build = load_plan(plan_id)
    head = ledger_head()
    need(head is not None, 'LEDGER_EMPTY:run adopt first')
    need_current(head)
    label = plan['label']
    need(label == plan['source'][:8], 'PLAN_LABEL')
    out = {'plan': plan_id, 'label': label, 'roots': {}, 'pins': {}, 'union': {}, 'cache': {}}
    built = {}

    def root_for(artifact, base_service):
        if artifact in built:
            return built[artifact]
        raw, folder = plan_manifest(build, artifact)
        dest = '%s/%s' % (runtime_dir(label), artifact)
        if exists(dest):
            verify_root(raw, dest)
            facts = {'status': 'ALREADY', 'manifestSha256': sha_bytes(raw)}
        else:
            step.change()
            ensure_dir(runtime_dir(label), 0o755)
            facts = assemble(raw, folder, head['services'][base_service]['root'], dest)
        step.event('root-ready', root=dest)
        built[artifact] = (dest, raw, facts)
        return built[artifact]

    for service in plan['order']:
        if plan['services'][service]['mode'] != 'root':
            continue
        spec = PROFILE['services'][service]
        if spec.get('cloneOf'):
            source, raw, facts = root_for(spec['artifact'], spec['cloneOf'])
            dest = root_of(service, label)
            state = clone_root(source, dest, raw)
            if state == 'CLONED':
                step.change()
            out['roots'][service] = {'root': dest, 'status': state, 'manifestSha256': sha_bytes(raw)}
        else:
            dest, raw, facts = root_for(spec['artifact'], service)
            need(dest == root_of(service, label), 'ROOT_NAME:' + service)
            out['roots'][service] = dict(facts, root=dest)
        current = head['services'][service]
        if spec.get('union'):
            target = union_of(service, label)
            if not exists(target):
                step.change()
                out['union'][service] = build_union(union_of(service, current['label']), dest + '/' + spec['union'], target)
            else:
                out['union'][service] = 'ALREADY'
        if spec.get('cache'):
            out['cache'][service] = ensure_cache(cache_of(service, current['label']), cache_of(service, label))
        original = read(current['pinFile'])
        need(sha_bytes(original) == current['pinSha256'], 'DRIFT:PIN:' + service)
        rendered = render_pin(service, original, current['label'], label, current['pinCount'])
        store_put(rendered)
        out['pins'][service] = {'file': current['pinFile'], 'originalSha256': current['pinSha256'],
                                'renderedSha256': sha_bytes(rendered)}
    step.finish('PREPARED', **out)
    return 0


# ------------------------------------------------------------------------------------------------ undo

class Undo:
    def __init__(self, step):
        self.step, self.items = step, []

    def add(self, name, action):
        self.items.append((name, action))

    def unwind(self):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        problems = []
        for name, action in reversed(self.items):
            try:
                action()
                self.step.event('undone', reason=name)
            except BaseException as error:
                problems.append('%s:%s' % (name, code_of(error)))
        return problems


def exact_state(services):
    return {s: {k: observe(s).get(k) for k in ('ActiveState', 'cwd', 'NRestarts')} for s in services}


def restore_files(files):
    """Every file back to the bytes it had, each attempted whatever happened to the one before. A file that already
    holds those bytes (one the step never reached) is left alone, so its own refusal cannot fail the undo."""
    failed = []
    for path, raw in files:
        try:
            if exists(path) and read(path) == raw:
                continue
            write_like(path, raw)
        except BaseException as error:
            failed.append('%s:%s' % (os.path.basename(path), code_of(error)))
    need(not failed, 'RESTORE:' + ','.join(failed))


def put_back(files):
    """The undo of a step that wrote unit drop-ins: the files back, then a daemon-reload whatever the restore met."""
    problems = []
    try:
        restore_files(files)
    except BaseException as error:
        problems.append(code_of(error))
    try:
        daemon_reload()
    except BaseException as error:
        problems.append(code_of(error))
    need(not problems, ';'.join(problems))


def all_back(files):
    """True when every file holds exactly the bytes it had before the step."""
    try:
        return all(exists(path) and read(path) == raw for path, raw in files)
    except BaseException:
        return False


# ------------------------------------------------------------------------------------------------ env-set

def inbox_path(path):
    return re.fullmatch(re.escape(state_dir('inbox')) + r'/[A-Za-z0-9_.:-]{1,160}\.value', path or '') is not None


def read_inbox(path):
    need(inbox_path(path), 'INBOX_PATH')
    info = os.lstat(P(path))
    need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'INBOX_FILE_SHAPE')
    raw = read(path, 1 << 16)
    os.unlink(P(path))
    return raw.decode('utf-8')


def env_set(run_id, files, key, inbox=None, generate=None, add=False, plan_id=None):
    step = Run('env-set', run_id)
    try:
        value = read_inbox(inbox) if inbox else None
    finally:
        if inbox and inbox_path(inbox) and exists(inbox):
            os.unlink(P(inbox))
    Lock()
    signal.signal(signal.SIGTERM, stop_signal)
    need(re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', key or '') is not None, 'ENV_KEY_SHAPE')
    names = [n for n in (files or '').split(',') if n]
    need(names and len(set(names)) == len(names) and all(n in PROFILE['envFiles'] for n in names), 'ENV_FILES')
    need((value is None) != (generate is None), 'ENV_VALUE_SOURCE')
    if generate is not None:
        need(generate == 'token64', 'GENERATE_KIND')
        value = ''.join(secrets.choice(TOKEN_ALPHABET) for _ in range(64))
    need(value and '\n' not in value and '\r' not in value and '\0' not in value and value[0] not in '"\'' and
         value == value.strip() and len(value) <= 32768, 'ENV_VALUE_SHAPE')
    if plan_id:
        load_plan(plan_id)
    head = ledger_head()
    need(head is not None, 'LEDGER_EMPTY:run adopt first')
    need_current(head)
    drift = [d for d in check_drift(head) if d.startswith('ENV:') and d[4:] in names]
    need(not drift, 'DRIFT:' + ','.join(drift))
    targets = []
    for name in names:
        for which, path in env_paths(name):
            need(exists(path), 'ENV_FILE_MISSING:%s:%s' % (name, which))
            info = os.lstat(P(path))
            # Checked for every file before the first write, as write_like checks each one at its turn.
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'NOT_A_PLAIN_FILE:' + path)
            raw = read(path)
            targets.append((name, which, path, raw, set_key(raw, key, value, add)))
    for _, _, _, raw, _ in targets:
        store_put(raw)
    undo = Undo(step)
    out = {'key': key, 'files': {}, 'generated': generate is not None}
    originals = [(path, raw) for _, _, path, raw, _ in targets]
    try:
        step.change()
        undo.add('env', lambda: restore_files(originals))
        for name, which, path, raw, new in targets:
            write_like(path, new)
            store_put(new)
            out['files'].setdefault(name, {})[which] = {'file': path, 'beforeSha256': sha_bytes(raw),
                                                         'afterSha256': sha_bytes(new)}
        read_back = {parse_env(read(path)).get(key) for _, _, path, _, _ in targets}
        need(len(read_back) == 1 and read_back == {value}, 'ENV_NOT_SAME_IN_ALL')
        out['sameInAll'] = True
        envs = env_shas()
        readers = sorted(s for s, spec in PROFILE['services'].items() if set(spec.get('envFiles', [])) & set(names))
        pending = sorted(set(head.get('pendingRestart') or []) | set(readers))
        base = head['base'] if plan_id and head.get('plan') == plan_id and head['op'] in ('switch', 'env-set') else head['id']
        entry = ledger_append('env-set', run_id, with_env(head['services'], envs), envs, base, plan=plan_id, key=key,
                              files=names, pendingRestart=pending)
        out.update(entry=short(entry), pendingRestart=pending)
    except BaseException as error:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)       # the undo runs to its end whatever arrives now
        code = code_of(error)
        entry = committed(run_id, 'env-set')
        if entry is not None:
            step.event('after-commit', code=code)
            out.update(entry=short(entry), pendingRestart=entry.get('pendingRestart') or [], sameInAll=True)
            step.finish('ENV_SET', warnings=['AFTER_COMMIT:' + code], **out)
            return 0
        step.event('failed', code=code)
        problems = undo.unwind()
        # The verdict is the bytes: ROLLED_BACK when every file holds what it held before, whatever the undo met.
        back = all_back(originals)
        step.finish('ROLLED_BACK' if back else 'ROLLBACK_FAILED', failure=code, problems=problems, **out)
        return 3 if back else 4
    step.finish('ENV_SET', **out)
    return 0


# ------------------------------------------------------------------------------------------------ switch

def pending_plan(head, names):
    """The staged release a plan-less switch would cut short: the head's plan (a release part way through), or a
    plan prepared since the head was written, that still moves one of `names` to a new root. Returns
    '<service>:<planId>' or None."""
    ids = [head['plan']] if head.get('plan') and head['op'] in ('switch', 'env-set') else []
    ids += [r['plan'] for r in results_of('prepare') if r.get('status') == 'PREPARED' and (r.get('finishedNs') or 0) > head['ns']]
    for plan_id in ids:
        try:
            plan, _ = load_plan(plan_id)
        except Refusal:
            continue
        for service in names:
            if (plan['services'].get(service) or {}).get('mode') == 'root' and head['services'][service]['label'] != plan['label']:
                return '%s:%s' % (service, plan_id)
    return None


def switch(run_id, services, plan_id=None):
    """With --plan: each service to the plan's root (or restarted, where the plan says restart). Without one: a restart
    on the same roots, answered RESTARTED, never SWITCHED; refused (PLAN_PENDING) while a staged release would move one
    of the services, so a dropped --plan cannot pass for a release."""
    step = Run('switch', run_id)
    Lock()
    signal.signal(signal.SIGTERM, stop_signal)
    names = [s for s in (services or '').split(',') if s]
    need(names and len(set(names)) == len(names) and all(s in PROFILE['services'] for s in names), 'SERVICES')
    head = ledger_head()
    need(head is not None, 'LEDGER_EMPTY:run adopt first')
    need_current(head)
    drift = check_drift(head)
    need(not drift, 'DRIFT:' + ','.join(drift))
    plan = build = prepared = None
    if plan_id:
        plan, build = load_plan(plan_id)
        need(all(s in plan['services'] for s in names), 'SERVICE_NOT_IN_PLAN')
        if any(plan['services'][s]['mode'] == 'root' for s in names):
            prepared = prepared_for(plan_id)
    else:
        pending = pending_plan(head, names)
        need(pending is None, 'PLAN_PENDING:%s:pass --plan' % pending)
    guards = time_guard()
    done = 'SWITCHED' if plan_id else 'RESTARTED'
    for service in names:
        state = observe(service)
        need(state['ActiveState'] == 'active' and state['cwd'] == head['services'][service]['cwd'],
             'NOT_ON_LEDGER_ROOT:' + service)
    targets, pins = {}, []
    for service in names:
        current = head['services'][service]
        mode = plan['services'][service]['mode'] if plan else 'restart'
        if mode == 'root':
            label = plan['label']
            root = prepared['roots'][service]['root']
            raw, _ = plan_manifest(build, PROFILE['services'][service]['artifact'])
            try:
                verify_root(raw, root)           # the prepared root, checked again as the last thing before a write
            except Exception as error:
                if code_of(error) == 'SIGTERM':
                    raise
                raise Refusal('PREPARED_ROOT_CHANGED:%s:%s' % (service, code_of(error)))
            original = read(current['pinFile'])
            rendered = render_pin(service, original, current['label'], label, current['pinCount'])
            need(sha_bytes(rendered) == prepared['pins'][service]['renderedSha256'], 'PIN_CHANGED_SINCE_PREPARE:' + service)
            missing = [p for p in pin_paths(rendered, label) if not exists(p)]
            need(not missing, 'PIN_PATH_MISSING:%s:%s' % (service, missing[0] if missing else ''))
            pins.append((service, current['pinFile'], original, rendered))
            targets[service] = dict(current, label=label, commit=plan['source'], root=root, cwd=cwd_of(service, root),
                                    pinSha256=sha_bytes(rendered))
        else:
            targets[service] = dict(current)
    undo = Undo(step)
    touched = []
    out = {'services': {s: {'label': t['label'], 'cwd': t['cwd']} for s, t in targets.items()}, 'plan': plan_id,
           'restart': {}, 'guards': guards}
    try:
        if pins:
            step.change()
            for _, _, _, rendered in pins:
                store_put(rendered)

            undo.add('pins', lambda: put_back([(path, original) for _, path, original, _ in pins]))
            for _, path, _, rendered in pins:
                write_like(path, rendered)
            daemon_reload()
            for service, _, _, _ in pins:
                need(show(PROFILE['services'][service]['unit'], ['WorkingDirectory']).get('WorkingDirectory') ==
                     targets[service]['cwd'], 'PIN_NOT_EFFECTIVE:' + service)
            step.event('pins-written', services=[p[0] for p in pins])
        for service in names:
            step.change()
            touched.append(service)
            out['restart'][service] = restart(service, targets[service]['cwd'])
            step.event('restarted', unit=PROFILE['services'][service]['unit'], seconds=out['restart'][service])
        for service in names:
            state = observe(service)
            need(state['cwd'] == targets[service]['cwd'] and state['NRestarts'] in ('0', ''), 'MOVED_AFTER_START:' + service)
        envs = env_shas()
        merged = dict(head['services'], **targets)
        pending = sorted(set(head.get('pendingRestart') or []) - set(names))
        base = head['base'] if plan_id and head.get('plan') == plan_id and head['op'] in ('switch', 'env-set') else head['id']
        entry = ledger_append('switch', run_id, with_env(merged, envs), envs, base, plan=plan_id, restarted=names,
                              pendingRestart=pending)
        out['entry'] = short(entry)
    except BaseException as error:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)       # the undo runs to its end whatever arrives now
        code = code_of(error)
        entry = committed(run_id, 'switch')
        if entry is not None:
            step.event('after-commit', code=code)
            out['entry'] = short(entry)
            step.finish(done, warnings=['AFTER_COMMIT:' + code], **out)
            return 0
        step.event('failed', code=code)
        problems = undo.unwind()
        out['undone'] = {}
        for service in touched:
            try:
                out['undone'][service] = restart(service, head['services'][service]['cwd'])
            except BaseException as second:
                problems.append('%s:%s' % (service, code_of(second)))
        out['exactState'] = exact_state(names)
        status = 'ROLLBACK_FAILED' if problems else 'ROLLED_BACK'
        step.finish(status, failure=code, problems=problems, **out)
        return 4 if problems else 3
    step.finish(done, **out)
    return 0


# ------------------------------------------------------------------------------------------------ rollback

def rollback(run_id, to):
    """Back to the state before the latest release: its base entry. Pins and env files from the store, CAS against
    what the ledger's head says; the services that differ restarted in the profile's order. On a failure part way, the
    head's files come back and the touched services restart on the head's roots.

    Drift refuses only in a file this rollback writes (a pin or env file that differs between head and target). Drift
    elsewhere is a warning: the file is left as it is and stays drift (the new entry records the target's bytes for
    it), so no later rollback writes over an outside change and adopt can still record it once the incident is over.
    A root moved by a release outside this tool refuses: the ledger no longer describes that service."""
    step = Run('rollback', run_id)
    Lock()
    signal.signal(signal.SIGTERM, stop_signal)
    need(to == 'previous', 'ROLLBACK_TO')
    rows = ledger()
    head = ledger_head(rows)
    need(head is not None, 'LEDGER_EMPTY')
    need(head.get('base'), 'NO_PREVIOUS:%s' % ('ADOPT_BARRIER' if head['op'] == 'adopt' else 'NONE'))
    target = ledger_entry(rows, head['base'])
    extra = sorted(set(head['services']) - set(PROFILE['services']))
    need(not extra, 'NOT_IN_PROFILE:' + ','.join(extra))
    moved = moved_roots(head)
    need(not moved, 'ROOT_MOVED:%s:%s' % (','.join(moved), REBASELINE))
    pins, envs_to_write, order, writes = [], [], [], set()
    for service in PROFILE['restartOrder']:
        if service not in head['services']:
            continue
        now, then = head['services'][service], target['services'][service]
        need(now['pinFile'] == then['pinFile'], 'PIN_FILE_MOVED:' + service)
        if now['pinSha256'] != then['pinSha256']:
            pins.append((service, now['pinFile'], then['pinSha256']))
            writes.add('PIN:' + service)
        if now['pinSha256'] != then['pinSha256'] or now['envSha256'] != then['envSha256'] or \
                service in (head.get('pendingRestart') or []):
            need(os.path.isdir(P(then['cwd'])), 'TARGET_ROOT_GONE:' + service)
            order.append(service)
    for name, item in target['envFiles'].items():
        for which, path in env_paths(name):
            if (head['envFiles'].get(name) or {}).get(which) != item.get(which):
                envs_to_write.append((name, which, path, item.get(which)))
                writes.add('ENV:' + name)
    drift = check_drift(head)
    blocking = [d for d in drift if d in writes]
    need(not blocking, 'DRIFT:' + ','.join(blocking))
    warnings = ['DRIFT:' + d for d in drift if d not in writes] + ['NOT_ADOPTED:' + g for g in not_adopted(head)]
    files = [(path, read(path), store_get(sha, 'PIN_VERSION_GONE:' + service)) for service, path, sha in pins]
    files += [(path, read(path), store_get(sha, 'ENV_VERSION_GONE:%s:%s' % (name, which)))
              for name, which, path, sha in envs_to_write]
    written_envs = sorted({name for name, _, _, _ in envs_to_write})
    # What the new entry records: the target's bytes for every file (the ones written are checked to hold them).
    recorded = {n: dict(v) for n, v in head['envFiles'].items()}
    recorded.update({n: dict(v) for n, v in target['envFiles'].items()})
    if not files and not order:
        # Nothing on disk differs (the release was a restart only): the ledger still steps back, so the next
        # rollback --to previous goes on to the release before it.
        entry = ledger_append('rollback', run_id, with_env(target['services'], recorded), recorded, target.get('base'),
                              target=target['id'], restarted=[], pendingRestart=sorted(target.get('pendingRestart') or []))
        step.change()
        step.finish('ROLLED_BACK', target=short(target), entry=short(entry), restart={}, order=[], warnings=warnings)
        return 0
    undo = Undo(step)
    touched = []
    out = {'target': short(target), 'restart': {}, 'order': order, 'warnings': warnings}
    try:
        step.change()
        undo.add('files', lambda: put_back([(p, now) for p, now, _ in files]))
        for path, _, then in files:
            write_like(path, then)
        daemon_reload()
        for service in order:
            touched.append(service)
            out['restart'][service] = restart(service, target['services'][service]['cwd'])
            step.event('restarted', unit=PROFILE['services'][service]['unit'], seconds=out['restart'][service])
        envs = env_shas()
        need(all(envs.get(n) == target['envFiles'][n] for n in written_envs), 'ENV_NOT_RESTORED')
        pending = sorted(set(target.get('pendingRestart') or []) - set(order))
        entry = ledger_append('rollback', run_id, with_env(target['services'], recorded), recorded, target.get('base'),
                              target=target['id'], restarted=order, pendingRestart=pending)
        out['entry'] = short(entry)
    except BaseException as error:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)       # the undo runs to its end whatever arrives now
        code = code_of(error)
        entry = committed(run_id, 'rollback')
        if entry is not None:
            step.event('after-commit', code=code)
            out['entry'] = short(entry)
            step.finish('ROLLED_BACK', **dict(out, warnings=warnings + ['AFTER_COMMIT:' + code]))
            return 0
        step.event('failed', code=code)
        problems = undo.unwind()
        out['undone'] = {}
        for service in touched:
            try:
                out['undone'][service] = restart(service, head['services'][service]['cwd'])
            except BaseException as second:
                problems.append('%s:%s' % (service, code_of(second)))
        out['exactState'] = exact_state(order)
        step.finish('ROLLBACK_FAILED' if problems else 'ROLLED_BACK_TO_HEAD', failure=code, problems=problems, **out)
        return 4 if problems else 3
    step.finish('ROLLED_BACK', **out)
    return 0


# ------------------------------------------------------------------------------------------------ verify

def verify(run_id):
    step = Run('verify', run_id)
    failures, out = [], {'units': {}}
    head = ledger_head()
    need(head is not None, 'LEDGER_EMPTY')
    # A service the head does not hold (added to the profile later) or a root a release outside this tool moved is
    # a failure by name, with the step that fixes it, never a PASS that did not look.
    moved = moved_roots(head)
    gaps = not_adopted(head)
    failures += ['ROOT_MOVED:' + s for s in moved] + ['NOT_ADOPTED:' + g for g in gaps]
    failures += ['NOT_IN_PROFILE:' + s for s in head['services'] if s not in PROFILE['services']]
    if moved or gaps:
        out['hint'] = REBASELINE if moved else 'run adopt'
    for service, item in head['services'].items():
        if service not in PROFILE['services']:
            continue
        state = observe(service)
        out['units'][service] = {k: state.get(k) for k in ('ActiveState', 'NRestarts', 'cwd')}
        if service in moved:
            pass
        elif state['ActiveState'] != 'active' or state['cwd'] != item['cwd']:
            failures.append('UNIT:' + service)
        elif state['NRestarts'] not in ('0', ''):
            failures.append('NRESTARTS:' + service)
        if not probes_ok(PROFILE['services'][service].get('probes') or []):
            failures.append('PROBE:' + service)
    for name, spec in PROFILE.get('untouched', {}).items():
        state = unit_state(spec['unit'])
        out['units'][name] = {k: state.get(k) for k in ('ActiveState', 'cwd')}
        if state.get('ActiveState') != 'active' or state.get('cwd') != spec['cwd']:
            failures.append('UNTOUCHED_MOVED:' + name)
    out['drift'] = check_drift(head)
    failures += ['DRIFT:' + d for d in out['drift']]
    out['pendingRestart'] = head.get('pendingRestart') or []
    failures += ['PENDING_RESTART:' + s for s in out['pendingRestart']]
    checks = PROFILE['checks']
    apex = checks['apex']
    out['pages'] = {p: curl('https://%s%s' % (apex, p), resolve='%s:443:127.0.0.1' % apex, insecure=True)['code']
                    for p in checks.get('pages', [])}
    failures += ['PAGE:' + p for p, c in out['pages'].items() if c != '200']
    door = curl('https://%s%s' % (apex, checks['mcpDoor']), method='POST', resolve='%s:443:127.0.0.1' % apex, insecure=True)
    out['mcpDoor'] = {'code': door['code'], 'resourceMetadata': 'resource_metadata=' in door['headers'].get('www-authenticate', '')}
    if out['mcpDoor'] != {'code': '401', 'resourceMetadata': True}:
        failures.append('MCP_DOOR')
    if checks.get('issuerHost'):
        host = checks['issuerHost']
        health = curl('https://%s/healthz' % host, resolve='%s:443:127.0.0.1' % host)
        meta = curl('https://%s/.well-known/oauth-authorization-server' % host, resolve='%s:443:127.0.0.1' % host)
        doc = body_json(meta) or {}
        out['issuer'] = {'healthz': health['code'], 'metadata': meta['code'],
                         'issuerMatches': doc.get('issuer') == 'https://' + host,
                         'registrationEndpoint': 'registration_endpoint' in doc}
        if out['issuer'] != {'healthz': '200', 'metadata': '200', 'issuerMatches': True, 'registrationEndpoint': False}:
            failures.append('ISSUER')
    queue = checks.get('reportQueue')
    if queue:
        # No query: the queue's query schema is strict, so a query it does not know answers 400.
        token = (env_values(queue['token']['envFile']) or {}).get(queue['token']['key'])
        base = (env_values(queue['base']['envFile']) or {}).get(queue['base']['key']) if queue.get('base') else None
        filler = 'x' * 64
        out['reportQueue'] = {'withToken': curl(queue['url'], token=token)['code'] if token else 'none',
                              'withoutToken': curl(queue['url'])['code'], 'wrongToken': curl(queue['url'], token=filler)['code'],
                              'baseToken': curl(queue['url'], token=base)['code'] if base else None}
        q = out['reportQueue']
        if q['withToken'] != '200' or q['withoutToken'] != '401' or q['wrongToken'] != '401' or q['baseToken'] not in (None, '403'):
            failures.append('REPORT_QUEUE')
    out['equalities'] = {}
    for rule in PROFILE.get('envEqualities', []):
        seen = []
        for name in rule['files']:
            for which, _ in env_paths(name):
                seen.append((env_values(name, which) or {}).get(rule['key']))
        same = len(set(seen)) == 1 and seen[0] is not None
        out['equalities'][rule['key']] = same
        if not same:
            failures.append('NOT_EQUAL:' + rule['key'])
    rows = ledger()
    since = max([e['seq'] for e in rows if e['op'] in ('adopt', 'rollback')] or [0])
    for entry in rows:
        if entry['op'] == 'env-set' and entry['seq'] > since:
            for name in entry['files']:
                values = [(env_values(name, which) or {}).get(entry['key']) for which, _ in env_paths(name)]
                if len(set(values)) != 1:
                    failures.append('STAGED_DIFFERS:%s:%s' % (name, entry['key']))
    out['ledger'] = {'head': short(head)}
    out['failures'] = sorted(set(failures))
    step.finish('PASS' if not failures else 'FAIL', **out)
    return 0 if not failures else 2


# ------------------------------------------------------------------------------------------------ close-out

def absolute_paths(text):
    """Every absolute path on a directive line of a unit file or drop-in (both sides of a bind, prefixes dropped)."""
    found = set()
    for line in text.split('\n'):
        if directive_key(line) is None:
            continue
        for word in line.split('=', 1)[1].split():
            for part in word.lstrip('-+!@:').split(':'):
                if part.startswith('/'):
                    found.add(part.rstrip('/') or '/')
    return found


def paths_in_use():
    """What close-out must never list as removable: the roots the last ledger entries name (rollback targets); every
    managed and untouched unit's working directory as /proc and systemd report it, and the untouched units' profile
    cwds; every absolute path in those units' unit files and <unit>.d drop-ins (an older drop-in's BindPaths or ReadOnlyPaths
    still needs its source at the next start); and the working directory of every running process."""
    used = {item['root'] for e in ledger()[-6:] for item in e['services'].values()}
    specs = list(PROFILE['services'].values()) + list(PROFILE.get('untouched', {}).values())
    used |= {spec['cwd'] for spec in PROFILE.get('untouched', {}).values() if spec.get('cwd')}
    for spec in specs:
        state = unit_state(spec['unit'])
        used |= {v for v in (state.get('cwd'), state.get('WorkingDirectory')) if v}
        for root in UNIT_DIRS:
            folder = '%s/%s.d' % (root, spec['unit'])
            names = [root + '/' + spec['unit']]
            if os.path.isdir(P(folder)):
                names += [folder + '/' + n for n in sorted(os.listdir(P(folder))) if n.endswith('.conf')]
            for path in names:
                if os.path.isfile(P(path)):
                    used |= absolute_paths(read_unit_text(path))
    proc = P('/proc')
    for pid in (os.listdir(proc) if os.path.isdir(proc) else []):
        if pid.isdigit():
            try:
                used.add(os.readlink(os.path.join(proc, pid, 'cwd')))
            except OSError:
                pass
    return used


def close_out(run_id, as_):
    """After acceptance: a PASS verify after the ledger's head. Removes env versions the head does not hold (they hold
    earlier secrets), the inbox, scratch files and payloads other plans used. Pins, roots and the ledger stay; old
    roots are listed, never removed, and a root anything still uses (paths_in_use) is never listed."""
    step = Run('close-out', run_id)
    Lock()
    need(as_ == 'accepted', 'CLOSE_OUT_AS')
    head = ledger_head()
    need(head is not None, 'LEDGER_EMPTY')
    need_current(head)
    passes = [r for r in results_of('verify') if r.get('status') == 'PASS' and (r.get('finishedNs') or 0) > head['ns']]
    need(passes, 'NO_PASS_AFTER_HEAD')
    # Kept: every pin version the ledger names (no secret; rollbacks within the chain still find them) and the env
    # files as they are now. Everything else in the store (earlier env versions, site copies) holds earlier secrets.
    keep = {item['pinSha256'] for e in ledger() for item in e['services'].values()}
    keep |= {sha for item in head['envFiles'].values() for sha in item.values() if sha}
    removed = []
    store = P(state_dir('store'))
    if os.path.isdir(store):
        for name in sorted(os.listdir(store)):
            if name not in keep:
                os.unlink(os.path.join(store, name))
                removed.append('store:' + name[:12])
    for folder in ('inbox', 'tmp'):
        if exists(state_dir(folder)):
            shutil.rmtree(P(state_dir(folder)))
            removed.append(folder)
    payloads = P(state_dir('payloads'))
    used = set()
    if head.get('plan'):
        try:
            used.add(load_plan(head['plan'])[1]['payloadId'])
        except Refusal:
            pass
    if os.path.isdir(payloads):
        for name in sorted(os.listdir(payloads)):
            if name not in used:
                shutil.rmtree(os.path.join(payloads, name))
                removed.append('payload:' + name)
    parts = P(state_dir('upload', 'parts'))
    if os.path.isdir(parts):
        shutil.rmtree(parts)
        removed.append('parts')
    used = paths_in_use()
    removable = []
    runtime = P(PROFILE['paths']['runtime'])
    if os.path.isdir(runtime):
        for label in sorted(os.listdir(runtime)):
            for role in sorted(os.listdir(os.path.join(runtime, label))) if os.path.isdir(os.path.join(runtime, label)) else []:
                path = '%s/%s/%s' % (PROFILE['paths']['runtime'], label, role)
                if role != 'static-compat' and not any(u == path or u.startswith(path + '/') for u in used):
                    removable.append(path)
    step.finish('CLOSED_OUT', accepted=True, removed=removed, removable=removable[:200], ledger={'head': short(head)})
    return 0


# ------------------------------------------------------------------------------------------------ main

def main(argv, env=None, profile_path=None):
    configure(env, profile_path)
    command = argv[1] if len(argv) > 1 else ''
    flags = set(a for a in argv[2:] if a in ('--add', '--rebaseline'))
    for flag in flags:
        argv = [a for a in argv if a != flag]
    options = dict(zip(argv[2::2], argv[3::2]))
    previous = signal.getsignal(signal.SIGTERM)
    steps = {
        'adopt': lambda: adopt(options.get('--run-id'), '--rebaseline' in flags),
        'prepare': lambda: prepare(options.get('--run-id'), options.get('--plan')),
        'env-set': lambda: env_set(options.get('--run-id'), options.get('--files'), options.get('--key'),
                                   options.get('--value-inbox'), options.get('--generate'), '--add' in flags,
                                   options.get('--plan')),
        'switch': lambda: switch(options.get('--run-id'), options.get('--services'), options.get('--plan')),
        'verify': lambda: verify(options.get('--run-id')),
        'rollback': lambda: rollback(options.get('--run-id'), options.get('--to')),
        'close-out': lambda: close_out(options.get('--run-id'), options.get('--as')),
    }
    reads = {'baseline': baseline, 'facts': facts_cmd, 'status': status_cmd,
             'manifest': lambda: manifest_cmd(options.get('--service'))}
    CURRENT[:] = []
    try:
        need(os.geteuid() == 0 or TESTING, 'ROOT_REQUIRED')
        need(not TESTING or os.geteuid() != 0, 'TEST_OVERRIDE_AS_ROOT')
        os.umask(0o077)
        check_profile()
        if command in reads:
            return reads[command]()
        need(command in steps, 'USAGE')
        return steps[command]()
    except BaseException as error:
        code = code_of(error)
        if command in steps:
            try:
                step = CURRENT[0] if CURRENT and CURRENT[0].step == command else None
                # adopt and a rollback with nothing to write append outside an undo: an error after their line is
                # written leaves a done step, reported as done.
                entry = committed(step.run_id, command) if step is not None and command in ('adopt', 'rollback') else None
                if entry is not None:
                    step.finish({'adopt': 'ADOPTED', 'rollback': 'ROLLED_BACK'}[command], entry=short(entry),
                                warnings=['AFTER_COMMIT:' + code])
                    return 0
                if step is not None:
                    step.finish('REFUSED', code=code)
                    return 2
            except BaseException:
                pass
        emit({'status': 'REFUSED', 'code': code, 'step': command})
        return 2
    finally:
        release_locks()
        signal.signal(signal.SIGTERM, previous)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
