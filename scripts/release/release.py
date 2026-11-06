#!/usr/bin/env python3
"""Standing release tool, local side (phase A, plus phase B's migrate). Python standard library only.

  python3 -I scripts/release/release.py --profile <private profile.json> <verb> [options]

  install                         the host tool and the host part of the profile, versioned and sha-pinned (idempotent)
  baseline | status               read-only host facts
  plan <40-hex commit> --services web,admin,issuer [--env FILES:KEY ...] [--migrations FAMILY:NAME ...]
       [--ungranted FAMILY:SCHEMA.TABLE ...] [--force-root S] [--unit-applied S]
                                  local git checks and read-only host facts; refuses a release this tool cannot finish;
                                  a declared migration is checked (expand only, CMS SQL extractable) and pinned, with
                                  what the runtime grant file means for each table it creates
  build [--plan ID]               local only: compile (the profile's builder), delta against the live manifests,
                                  a content-addressed payload in parts
  stage [--plan ID]               the plan, the missing parts, the payload assembled on the host
  adopt [--rebaseline]            the ledger's first entry: the live state as found (again after an outside change;
                                  --rebaseline also records roots a release outside this tool moved)
  prepare [--plan ID]             new roots, static unions, caches, rendered pins; no service change
  migrate --family cms|app [--plan ID] --pitr-confirmed   the plan's migrations of one family, forward only: a dump of
                                  the objects they touch, each migration with its ledger row, then (cms) the runtime
                                  grants and their check; run it again after a failure and it resumes
  migrate --family cms|app [--plan ID] --check            the same checks, nothing changed (the CMS grant file is
                                  rehearsed in a transaction that is rolled back)
  migrate --family cms|app --rebaseline                   verify's migration baseline as it is now
  env set FILES KEY (--value-file PATH | --generate token64) [--add] [--plan ID]
                                  one key in the named env files and their staged copies; prints no value
  switch SERVICES [--plan ID] --outage-ok    in the order given; undoes itself on any failure or SIGTERM; without
                                  --plan a restart on the same roots (RESTARTED), refused while a staged plan is pending;
                                  refused while the plan's migrations are not done
  verify                          read-only checks on the host
  rollback --to previous --outage-ok [--unswitched-ok]   the state before the latest release, from the host's ledger
                                  (never a migration: the schema stays); refused while a later plan was prepared or
                                  migrated but never switched, unless --unswitched-ok
  close-out --accepted            after a PASS verify: earlier env versions and payloads removed; roots listed
  dns | cert | edgeone | nginx | unit    not built yet: refused, with the next step in plain words
  check-migrations [--base REF]   no profile: the repository's new migrations sort after REF's latest, only expand, and
                                  each new CMS migration's SQL can be extracted (a CI check)

Every host verb takes --dry-run (prints the ssh argv and stores the script; no network). Long steps run as transient
systemd units on the host, so an ssh drop never stops them; the client polls their journal. Nothing printed or
stored here holds a password, key, token or env value.
"""
import argparse
import base64
import concurrent.futures
import datetime
import fnmatch
import gzip
import hashlib
import io
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tarfile
import time

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
HOST_TOOL = HERE / 'release_host.py'
TEST = None          # set by main() from RELEASE_CLIENT_TEST: the tool's own tests only
EXIT = {'ok': 0, 'local': 1, 'refused': 2, 'rolled_back': 3, 'rollback_failed': 4, 'no_result': 5, 'transport': 6}
LONG = {'adopt': (600, 60), 'prepare': (3600, 120), 'env-set': (300, 60), 'switch': (1800, 600), 'rollback': (1800, 600),
        'close-out': (300, 30), 'migrate': (3600, 120)}   # RuntimeMaxSec, TimeoutStopSec floors; see limits()
STUBS = ('dns', 'cert', 'edgeone', 'nginx', 'unit')
# The next step for what this tool does not do, in plain words. {toolkit} is the profile's login-door toolkit pointer.
NEXT_STEP = {
    'migrate': 'Declare each pending migration: plan again with --migrations <family>:<name> for each one (expand '
               'only; the plan pins each CMS migration\'s SQL). Then, after prepare and before switch, run '
               '`migrate --family <family> --pitr-confirmed`. A migration that must do more than expand needs the '
               'Owner\'s approval written into its SQL (`-- release: contraction-ok KIND:object`, see the README).',
    'order': 'A pending migration sorts before one the database already holds, so it cannot be applied forward: give '
             'it a later id in the repository, then plan again.',
    'cert': 'Phase A installs or renews no certificate. Until phase B, use the login-door toolkit ({toolkit}), its '
            'certificate steps. This tool records no certificate, so nothing here needs re-recording.',
    'dns': 'Phase A changes no DNS record. Until phase B, make the change with a toolkit written and reviewed for that '
           'release. This tool records no DNS, so nothing here needs re-recording.',
    'edgeone': 'Phase A changes no EdgeOne rule. Until phase B, make the change with a toolkit written and reviewed for '
               'that release. This tool records no EdgeOne rule, so nothing here needs re-recording.',
    'nginx': 'Phase A writes no Nginx site. Until phase B, make the change with a toolkit written and reviewed for that '
             'release, then run `baseline` here to see that nothing this tool records moved.',
    'unit': 'Phase A changes no systemd unit. Until phase B, apply the unit change with a toolkit written and reviewed '
            'for it, run `adopt --rebaseline` here if it moved a root, then plan again. If the host\'s unit already '
            'carries the change, plan again with --unit-applied <service>.',
    'ledger': 'The host\'s migration ledgers could not be read: run `baseline` and look at `ledgers` before planning.',
    'adopt': 'The ledger does not hold everything the profile names: run `adopt`, then plan again.',
    'rebaseline': 'A release made outside this tool moved a root: run `adopt --rebaseline`, then plan again.',
}
SECRET_MARK = re.compile(r'://[^\s/@]*:[^\s/@]*@|-----BEGIN|SCRAM-SHA-256\$|PRIVATE KEY')
POLL_LOST_AFTER = 24
PROFILE = {}
PROFILE_PATH = None


class ClientError(Exception):
    """A local refusal; str(error) is the code."""


def need(ok, code):
    if not ok:
        raise ClientError(code)


# ------------------------------------------------------------------------------------------------ output

def secret_like(text):
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


def scrub(value, key=None):
    """Defence in depth on top of the host's allowlist: a hex digest passes only in a *Sha256 field, a commit only in
    commit/source; anything else shaped like a secret is withheld before it is printed or stored."""
    if isinstance(value, dict):
        return {k: scrub(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(v, key) for v in value]
    if isinstance(value, str):
        if key and str(key).lower().endswith('sha256') and re.fullmatch(r'[0-9a-f]{64}', value):
            return value
        if key in ('commit', 'source') and re.fullmatch(r'[0-9a-f]{40}', value):
            return value
        return '[withheld]' if secret_like(value) else value
    return value


def say(value):
    if isinstance(value, str):
        print('[withheld]' if secret_like(value) else value, flush=True)
    else:
        print(json.dumps(scrub(value), sort_keys=True, ensure_ascii=False), flush=True)


def private_dir(path):
    path = pathlib.Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def stamp():
    return time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())


def sha_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def work(*parts):
    base = pathlib.Path(TEST['work']) if TEST and TEST.get('work') else pathlib.Path(os.path.expanduser(PROFILE['local']['work']))
    return base.joinpath(*parts)


_SEQ = [0]


def store(label, value):
    _SEQ[0] += 1
    folder = private_dir(work('logs', 'answers'))
    path = folder / ('%s-%d-%03d-%s.json' % (stamp(), os.getpid(), _SEQ[0], label))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(scrub(value), handle, indent=1, sort_keys=True)
    return path


def append(path, value):
    private_dir(pathlib.Path(path).parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as handle:
        handle.write(json.dumps(scrub(value), sort_keys=True, ensure_ascii=False) + '\n')


def write_private(path, raw):
    private_dir(pathlib.Path(path).parent)
    tmp = pathlib.Path(str(path) + '.%d.tmp' % os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
    os.replace(tmp, path)


# ------------------------------------------------------------------------------------------------ profile and tool

def load_profile(path):
    global PROFILE, PROFILE_PATH
    need(path, 'PROFILE_REQUIRED:pass --profile or set ARTVENN_RELEASE_PROFILE')
    PROFILE_PATH = pathlib.Path(os.path.expanduser(path))
    need(PROFILE_PATH.is_file(), 'PROFILE_MISSING')
    PROFILE = json.loads(PROFILE_PATH.read_text())
    need(PROFILE.get('kind') == 'artvenn-release-profile' and PROFILE.get('schema') == 1, 'PROFILE_KIND')
    for key in ('paths', 'tools', 'services', 'envFiles', 'live', 'checks', 'unitPrefix', 'restartOrder'):
        need(key in PROFILE['host'], 'PROFILE_HOST_KEY:' + key)
    h, local = PROFILE['host'], PROFILE.get('local') or {}
    order = h['restartOrder']
    # Every service in restartOrder exactly once: rollback and the plan's order walk it, so a missing one would be
    # left on its new root while rollback reports ROLLED_BACK.
    need(isinstance(order, list) and len(set(order)) == len(order) and set(order) == set(h['services']),
         'PROFILE_RESTART_ORDER')
    for service, spec in h['services'].items():
        need(service in h['live'], 'PROFILE_LIVE_MISSING:' + service)
        need(all(f in h['envFiles'] for f in spec.get('envFiles', [])), 'PROFILE_ENV_FILE:' + service)
        paths = (local.get('codePaths') or {}).get(service)
        need(isinstance(paths, list) and paths and all(isinstance(x, str) and x for x in paths),
             'PROFILE_CODE_PATHS:' + service)
    need(all(h['checks'].get(k) for k in ('apex', 'mcpDoor')), 'PROFILE_CHECKS')
    # The remote command that runs a script on the host comes from the private profile only: no tracked default.
    need(isinstance(local.get('remote'), str) and local['remote'].endswith(' -'), 'PROFILE_LOCAL_KEY:remote')


def host_profile_bytes():
    return json.dumps(PROFILE['host'], indent=1, sort_keys=True).encode() + b'\n'


def tool_identity():
    raw = HOST_TOOL.read_bytes()
    version = re.search(rb"^VERSION = '([A-Za-z0-9._-]+)'$", raw, re.M).group(1).decode()
    tool_sha, profile_sha = sha_bytes(raw), sha_bytes(host_profile_bytes())
    return {'version': version, 'sha256': tool_sha, 'profileSha256': profile_sha,
            'dir': '%s/host-tool/%s-%s-%s' % (PROFILE['host']['paths']['state'], version, tool_sha[:12], profile_sha[:12])}


# ------------------------------------------------------------------------------------------------ transport

def ssh_argv():
    """ssh options from the private profile; the host alias is read at run time from the file the profile names."""
    if TEST and TEST.get('ssh'):
        return list(TEST['ssh'])
    local = PROFILE['local']
    source = pathlib.Path(os.path.expanduser(local['hostAlias']['file']))
    need(source.is_file(), 'HOST_ALIAS_SOURCE_MISSING')
    found = re.search(local['hostAlias']['pattern'], source.read_text(), re.M)
    need(found is not None, 'HOST_ALIAS_UNKNOWN')
    ssh = local['ssh']
    return [ssh.get('binary', '/usr/bin/ssh'), '-T', '-F', '/dev/null', '-o', 'ConnectionAttempts=1', '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o',
            'UserKnownHostsFile=' + os.path.expanduser(ssh['knownHosts']), '-o', 'ConnectTimeout=%d' % ssh.get('connectTimeout', 12),
            '-o', 'ServerAliveInterval=15', '-i', os.path.expanduser(ssh['identity']), found.group(1)]


def remote_stdin():
    return PROFILE['local']['remote']


class Remote:
    def __init__(self, dry_run):
        self.dry_run = dry_run

    def script(self, label, text, timeout, quiet=False, redacted=None):
        argv = ssh_argv() + [remote_stdin()]
        raw = text.encode()
        path = None
        if self.dry_run or not quiet:
            _SEQ[0] += 1
            path = private_dir(work('logs', 'scripts')) / ('%s-%d-%03d-%s.py' % (stamp(), os.getpid(), _SEQ[0], label))
            # A script that carries a value (env set) is stored with the value withheld; the value is never logged.
            write_private(path, (redacted if redacted is not None else text).encode())
        if self.dry_run:
            say('DRY-RUN %s: %s < %s (sha256 %s..., %d bytes, timeout %ds)' % (label, shlex.join(argv), path,
                                                                              sha_bytes(raw)[:16], len(raw), timeout))
            return {'status': 'DRY_RUN'}
        try:
            done = subprocess.run(argv, input=raw, capture_output=True, timeout=timeout)
            lines = [l for l in done.stdout.decode('utf-8', 'replace').splitlines() if l.startswith('{')]
            value = json.loads(lines[-1]) if lines else {'status': 'NO_JSON'}
            value['transportExitCode'] = done.returncode
            if done.returncode == 255 or not lines:
                value.setdefault('transport', 'SSH_FAILED' if done.returncode == 255 else 'NO_JSON')
        except subprocess.TimeoutExpired:
            value = {'status': 'TRANSPORT_FAILED', 'category': 'TIMEOUT'}
        except (OSError, ValueError) as error:
            value = {'status': 'TRANSPORT_FAILED', 'category': type(error).__name__}
        if not quiet:
            store(label, {k: v for k, v in value.items() if k != 'b64'})
        return value if label.startswith('manifest') else scrub(value)

    def dispatch(self, label, params, timeout, quiet=False):
        redacted = None
        if 'value' in params:
            redacted = dispatcher(dict(params, value='[withheld]'))
        return self.script(label, dispatcher(params), timeout, quiet, redacted)


def transport_failed(answer):
    return answer.get('status') in ('TRANSPORT_FAILED', 'NO_JSON') or answer.get('transport') is not None


DISPATCHER = r'''# Standing release tool dispatcher, generated by scripts/release/release.py; runs as root through the
# profile's remote command. One action, one JSON line. Checks the installed host tool by sha256 before running it.
import base64, fcntl, hashlib, json, os, re, signal, stat, subprocess, sys, tarfile, time
P = json.loads(base64.b64decode('@PARAMS@').decode())
signal.alarm(int(P.get('alarm', 120)))
ROOT = P.get('root') or ''
BIN = P.get('bin') or {}
TESTING = bool(ROOT)
STATE = P['state']
PREFIX = P['prefix']
LOCK = P['lock']
PY = P.get('python') if TESTING else P['hostPython']
LONG = ('adopt', 'prepare', 'env-set', 'switch', 'rollback', 'close-out', 'migrate')
READS = ('baseline', 'facts', 'status', 'verify', 'manifest', 'migrate-check')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'SYSTEMD_PAGER': '', 'SYSTEMD_COLORS': '0'}
TEST_ENV = P.get('testEnv') or {}


class Refused(Exception):
    pass


def need(ok, code):
    if not ok:
        raise Refused(code)


def host(path):
    return ROOT + path if ROOT else path


def binary(name):
    return BIN.get(name) or P['tools'][name]


def run(args, seconds, env=None):
    done = subprocess.run(args, capture_output=True, timeout=seconds, env=env or ENV, stdin=subprocess.DEVNULL, cwd='/')
    return done.returncode, done.stdout.decode('utf-8', 'replace'), done.stderr.decode('utf-8', 'replace')


def sha(path):
    digest = hashlib.sha256()
    with open(host(path), 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def secure(path):
    info = os.lstat(host(path))
    need(not stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022, 'UNSAFE:' + path)


def mkdirs(path):
    for part in [path[:i] for i in range(len(path)) if path[i] == '/' and i > 0] + [path]:
        if not os.path.isdir(host(part)):
            os.mkdir(host(part), 0o700)


def write_new(path, raw, mode=0o600):
    tmp = host(path) + '.%d.partial' % os.getpid()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    os.rename(tmp, host(path))


def lock_free():
    if not os.path.exists(host(LOCK)):
        return True
    fd = os.open(host(LOCK), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


def show(unit, props):
    rc, out, _ = run([binary('systemctl'), 'show', unit, '--no-pager'] + ['--property=' + p for p in props], 15)
    return dict(l.split('=', 1) for l in out.splitlines() if '=' in l)


def release_units():
    rc, out, _ = run([binary('systemctl'), 'list-units', '--all', '--plain', '--no-legend', '--no-pager', PREFIX + '*'], 15)
    return [{'unit': p[0], 'active': p[2]} for p in (l.split() for l in out.splitlines()) if len(p) >= 3 and p[0].startswith(PREFIX)]


def tool_path():
    folder = P['tool']['dir']
    for item in (STATE, STATE + '/host-tool', folder, folder + '/release_host.py', folder + '/profile.json'):
        secure(item)
    need(sha(folder + '/release_host.py') == P['tool']['sha256'], 'HOST_TOOL_SHA:run install')
    need(sha(folder + '/profile.json') == P['tool']['profileSha256'], 'HOST_PROFILE_SHA:run install')
    return folder + '/release_host.py'


def child_env():
    return dict(ENV, **TEST_ENV) if TESTING else ENV


def argv_of(command, args):
    need(command in LONG + READS, 'COMMAND')
    need(all(re.fullmatch(r'[A-Za-z0-9_./:=@+,-]{1,200}', a) for a in args), 'ARGS')
    return [PY, '-I', host(tool_path()), command] + list(args)


def last_json(text):
    for line in reversed(text.splitlines()):
        if line.startswith('{'):
            try:
                return json.loads(line)
            except ValueError:
                return {'status': 'UNPARSED'}
    return None


def action_install():
    folder = P['tool']['dir']
    raw_tool, raw_profile = base64.b64decode(P['toolB64']), base64.b64decode(P['profileB64'])
    need(hashlib.sha256(raw_tool).hexdigest() == P['tool']['sha256'], 'TOOL_BYTES')
    need(hashlib.sha256(raw_profile).hexdigest() == P['tool']['profileSha256'], 'PROFILE_BYTES')
    if os.path.isdir(host(folder)):
        tool_path()
        return {'status': 'ALREADY_INSTALLED', 'dir': folder}
    mkdirs(STATE + '/host-tool')
    partial = folder + '.partial'
    if os.path.isdir(host(partial)):
        for name in os.listdir(host(partial)):
            os.unlink(os.path.join(host(partial), name))
        os.rmdir(host(partial))
    os.mkdir(host(partial), 0o700)
    write_new(partial + '/release_host.py', raw_tool, 0o600)
    write_new(partial + '/profile.json', raw_profile, 0o600)
    os.rename(host(partial), host(folder))
    tool_path()
    return {'status': 'INSTALLED', 'dir': folder}


def action_put_plan():
    raw_plan, raw_build = base64.b64decode(P['planB64']), base64.b64decode(P['buildB64'])
    plan_id = P['planId']
    need(re.fullmatch(r'[0-9a-f]{16}', plan_id) and hashlib.sha256(raw_plan).hexdigest()[:16] == plan_id, 'PLAN_SHA')
    need(json.loads(raw_build).get('planId') == plan_id, 'BUILD_NOT_THIS_PLAN')
    folder = STATE + '/plans/' + plan_id
    if os.path.isdir(host(folder)):
        same = open(host(folder + '/plan.json'), 'rb').read() == raw_plan and open(host(folder + '/build.json'), 'rb').read() == raw_build
        need(same, 'DIFFERENT_PLAN_STAGED')
        return {'status': 'ALREADY'}
    mkdirs(STATE + '/plans')
    os.mkdir(host(folder + '.partial'), 0o700)
    write_new(folder + '.partial/plan.json', raw_plan)
    write_new(folder + '.partial/build.json', raw_build)
    os.rename(host(folder + '.partial'), host(folder))
    return {'status': 'PUT'}


def action_inventory():
    folder = host(STATE + '/upload/parts')
    found = {}
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if re.fullmatch(r'part-[0-9a-f]{64}', name):
                found[name] = os.path.getsize(os.path.join(folder, name))
    return {'status': 'INVENTORY', 'parts': found, 'assembled': os.path.isfile(host(STATE + '/payloads/' + P['payloadId'] + '/assembled.json'))}


def action_assemble():
    folder = STATE + '/payloads/' + P['payloadId']
    if os.path.isfile(host(folder + '/assembled.json')):
        need(json.load(open(host(folder + '/assembled.json'))).get('payloadSha256') == P['payloadSha256'], 'PAYLOAD_SHA')
        return {'status': 'ALREADY_ASSEMBLED'}
    mkdirs(STATE + '/payloads')
    archive = host(STATE + '/payloads/' + P['payloadId'] + '.tgz')
    digest = hashlib.sha256()
    with open(archive + '.partial', 'wb') as out:
        for part in P['parts']:
            path = STATE + '/upload/parts/' + part['name']
            need(re.fullmatch(r'part-[0-9a-f]{64}', part['name']) and sha(path) == part['name'][5:] == part['sha256'], 'PART_SHA')
            with open(host(path), 'rb') as handle:
                data = handle.read()
            digest.update(data)
            out.write(data)
    need(digest.hexdigest() == P['payloadSha256'], 'PAYLOAD_SHA')
    os.replace(archive + '.partial', archive)
    partial = host(folder + '.partial')
    if os.path.exists(partial):
        import shutil
        shutil.rmtree(partial)
    os.makedirs(partial, mode=0o700)
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            name = member.name
            need(not name.startswith('/') and '..' not in name.split('/') and (member.isfile() or member.isdir()) and
                 re.fullmatch(r'(manifests/[a-z0-9-]{1,40}\.json|blobs/[0-9a-f]{64}|manifests|blobs)', name), 'MEMBER')
            target = os.path.join(partial, name)
            if member.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            with open(target, 'wb') as handle:
                handle.write(tar.extractfile(member).read())
            os.chmod(target, 0o600)
    with open(os.path.join(partial, 'assembled.json'), 'w') as handle:
        json.dump({'payloadSha256': P['payloadSha256']}, handle)
    os.rename(partial, host(folder))
    os.unlink(archive)
    return {'status': 'ASSEMBLED'}


def action_run():
    command = P['command']
    need(command in READS, 'READ_ONLY_COMMANDS_ONLY')
    args = list(P.get('args') or [])
    if command == 'verify':
        args = ['--run-id', P['unit']] + args
    rc, out, err = run(argv_of(command, args), int(P.get('seconds', 110)), child_env())
    if command == 'manifest':
        value = last_json(out) or {'status': 'NO_JSON'}
        return value
    return {'status': 'RAN', 'rc': rc, 'answer': last_json(out), 'stderrLines': len(err.splitlines())}


def action_launch():
    unit, step = P['unit'], P['step']
    need(re.fullmatch(re.escape(PREFIX) + r'[a-z-]+-[0-9]{8}T[0-9]{6}Z', unit) and step in LONG, 'UNIT_NAME')
    busy = [r['unit'] for r in release_units() if r['active'] in ('active', 'activating', 'deactivating', 'reloading')]
    need(not busy, 'RELEASE_UNIT_ACTIVE:' + ','.join(busy))
    need(show(unit, ['LoadState']).get('LoadState') in ('not-found', '', None), 'UNIT_EXISTS')
    need(lock_free(), 'DEPLOY_LOCK_HELD')
    args = ['--run-id', unit] + list(P.get('args') or [])
    if 'value' in P:
        # The value goes to the host tool through a 0600 file it reads and deletes, never through an argv.
        mkdirs(STATE + '/inbox')
        path = STATE + '/inbox/' + unit + '.value'
        write_new(path, base64.b64decode(P['value']), 0o600)
        args += ['--value-inbox', path]
    argv = argv_of(step, args)
    cmd = [binary('systemd-run'), '--unit=' + unit, '--collect', '--quiet', '--description=' + PREFIX + step,
           '--property=RuntimeMaxSec=%d' % int(P['runtimeMax']), '--property=TimeoutStopSec=%d' % int(P['stopTimeout']),
           '--property=KillMode=mixed']
    if TESTING:
        cmd += ['--setenv=%s=%s' % kv for kv in sorted(TEST_ENV.items())]
    rc, _, _ = run(cmd + argv, 30, child_env())
    need(rc == 0, 'SYSTEMD_RUN_FAILED:%d' % rc)
    return {'status': 'LAUNCHED', 'unit': unit, 'step': step}


def action_poll():
    step, run_id, offset = P['step'], P['unit'], int(P.get('offset', 0))
    need(step in LONG + ('verify',), 'STEP')
    path = host(STATE + '/runs/' + step + '/' + run_id + '.events.jsonl')
    events, new_offset = [], offset
    if os.path.exists(path):
        with open(path, 'rb') as handle:
            handle.seek(offset)
            data = handle.read(256 * 1024)
        cut = data.rfind(b'\n') + 1
        new_offset = offset + cut
        for line in data[:cut].decode('utf-8', 'replace').splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    result = None
    result_path = host(STATE + '/runs/' + step + '/' + run_id + '.result.json')
    if os.path.exists(result_path):
        try:
            result = json.load(open(result_path))
        except ValueError:
            result = None
    return {'status': 'POLLED', 'events': events[-200:], 'offset': new_offset, 'result': result,
            'unitState': show(run_id, ['LoadState', 'ActiveState', 'Result'])}


def action_probe():
    return {'status': 'PROBED', 'hostEpoch': int(time.time()), 'lockFree': lock_free(), 'releaseUnits': release_units()}


def main():
    if TESTING:
        need(os.geteuid() != 0, 'TEST_OVERRIDE_AS_ROOT')
    else:
        need(os.geteuid() == 0 and sys.platform.startswith('linux') and not TEST_ENV, 'ROOT_REQUIRED')
    actions = {'install': action_install, 'put-plan': action_put_plan, 'inventory': action_inventory,
               'assemble': action_assemble, 'run': action_run, 'launch': action_launch, 'poll': action_poll,
               'probe': action_probe}
    need(P.get('action') in actions, 'ACTION')
    return actions[P['action']]()


os.umask(0o077)
try:
    VALUE = main()
except Refused as error:
    VALUE = {'status': 'REFUSED', 'code': str(error)}
except subprocess.TimeoutExpired:
    VALUE = {'status': 'FAILED', 'code': 'SUBPROCESS_TIMEOUT'}
except Exception as error:
    VALUE = {'status': 'FAILED', 'code': type(error).__name__}
print(json.dumps(VALUE, sort_keys=True), flush=True)
'''

RECEIVER = r'''import hashlib, json, os, re, sys
root, state, name, size = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def say(v):
    sys.stdout.write(json.dumps(v) + "\n"); sys.stdout.flush()
assert re.fullmatch(r"part-[0-9a-f]{64}", name) and 0 < size <= 16 << 20
want = name[5:]
folder = (root or "") + state + "/upload/parts"
for d in (state, state + "/upload", state + "/upload/parts"):
    os.makedirs((root or "") + d, mode=0o700, exist_ok=True)
final = folder + "/" + name
if os.path.exists(final):
    if hashlib.sha256(open(final, "rb").read()).hexdigest() == want:
        say({"status": "ALREADY_PRESENT"}); sys.exit(0)
    os.unlink(final)
data = sys.stdin.buffer.read(size + 1)
if len(data) != size or hashlib.sha256(data).hexdigest() != want:
    say({"status": "REFUSED", "code": "PART_MISMATCH"}); sys.exit(2)
partial = final + ".%d.partial" % os.getpid()
fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "wb") as out:
    out.write(data); out.flush(); os.fsync(out.fileno())
os.rename(partial, final)
say({"status": "RECEIVED"})
'''


def dispatcher(params):
    h = PROFILE['host']
    params = dict(params, state=h['paths']['state'], prefix=h['unitPrefix'], lock=h['paths']['lock'], tools=h['tools'],
                  hostPython=h['tools'].get('python', '/usr/bin/python3'), tool=tool_identity())
    if TEST and TEST.get('root'):
        params.update(root=TEST['root'], bin=TEST.get('bin') or {}, python=TEST.get('python', sys.executable),
                      testEnv=TEST.get('testEnv') or {})
    return DISPATCHER.replace('@PARAMS@', base64.b64encode(json.dumps(params, sort_keys=True).encode()).decode())


# ------------------------------------------------------------------------------------------------ runs

def undo_seconds():
    """The worst case of a switch's or rollback's own undo after a SIGTERM (a `systemctl stop` of the release unit, or
    RuntimeMaxSec): the files back and a daemon-reload, then every service the step may have touched stopped and
    started again on its previous root, each at the host tool's own limits: stop 120 s, show 15 s, reset-failed 15 s,
    start 120 s, the readiness wait (readySeconds), two state reads of 15 s and 25 s per probe."""
    h = PROFILE['host']
    total = 60 + 60
    for service, spec in h['services'].items():
        ready = int((h.get('readySeconds') or {}).get(service, 180))
        total += 120 + 15 + 15 + 120 + ready + 15 + 15 + 25 * len(spec.get('probes') or [])
    return total


def limits(step):
    """(RuntimeMaxSec, TimeoutStopSec, how long the client polls) for a step's transient unit. A step that undoes
    itself on SIGTERM gets a stop timeout longer than the worst case of that undo, so systemd's SIGKILL (KillMode=mixed)
    can never cut it off half way, and room for the same work forward; the client polls past both."""
    runtime, stop = LONG[step]
    if step in ('switch', 'rollback'):
        undo = undo_seconds()
        stop = max(stop, undo + 120)
        runtime = max(runtime, undo + 300)
    return runtime, stop, runtime + stop + 120


def unit_name(step):
    path = work('logs', 'runs.json')
    last = (json.loads(path.read_text()).get(step) or [{}])[-1].get('unit') if path.exists() else None
    for _ in range(30):
        name = PROFILE['host']['unitPrefix'] + step + '-' + stamp()
        if name != last:
            return name
        time.sleep(0.2)
    return name


def remember(step, unit, extra=None):
    path = work('logs', 'runs.json')
    value = json.loads(path.read_text()) if path.exists() else {}
    value.setdefault(step, []).append(dict(extra or {}, unit=unit, launchedAt=stamp()))
    write_private(path, json.dumps(value, indent=1, sort_keys=True).encode())


def last_unit(step):
    path = work('logs', 'runs.json')
    runs = json.loads(path.read_text()).get(step, []) if path.exists() else []
    need(runs, 'NO_RUN_RECORDED:' + step)
    return runs[-1]['unit']


def short_event(row):
    facts = {k: v for k, v in row.items() if k not in ('at', 'runId', 'step', 'status')}
    return '%s %s %s' % (row.get('at', ''), row.get('status'), json.dumps(scrub(facts), sort_keys=True,
                                                                          separators=(',', ':'), ensure_ascii=False)[:400])


def follow(remote, step, unit):
    limit = limits(step)[2]
    poll_seconds = (TEST or {}).get('pollSeconds', 5)
    folder = private_dir(work('logs', 'runs', unit))
    offset, lost, ended = 0, 0, 0
    end = time.monotonic() + limit
    try:
        while True:
            answer = remote.dispatch('poll-' + step, {'action': 'poll', 'step': step, 'unit': unit, 'offset': offset,
                                                      'alarm': 60}, 75, quiet=True)
            append(folder / 'polls.jsonl', {k: v for k, v in answer.items() if k != 'events'})
            if answer.get('status') != 'POLLED':
                lost += 1
                say('[%s] poll failed (%d/%d): %s' % (step, lost, POLL_LOST_AFTER, answer.get('code') or answer.get('status')))
                if lost >= POLL_LOST_AFTER:
                    return {'status': 'POLL_LOST', 'unit': unit}
            else:
                lost = 0
                for row in answer.get('events') or []:
                    append(folder / 'events.jsonl', row)
                    say('[%s] %s' % (step, short_event(row)))
                offset = answer.get('offset', offset)
                if answer.get('result'):
                    store('result-' + step, answer['result'])
                    return answer['result']
                state = answer.get('unitState') or {}
                if state.get('LoadState') == 'not-found' or state.get('ActiveState') in ('inactive', 'failed'):
                    ended += 1
                    if ended >= 3:
                        return {'status': 'NO_RESULT', 'unit': unit, 'unitState': state}
            if time.monotonic() > end:
                return {'status': 'POLL_TIMEOUT', 'unit': unit}
            time.sleep(poll_seconds)
    except KeyboardInterrupt:
        say('[%s] polling stopped by you; the host unit keeps running. Resume with --attach %s' % (step, unit))
        return {'status': 'POLL_STOPPED', 'unit': unit}


SUCCESS = ('ADOPTED', 'PREPARED', 'ENV_SET', 'SWITCHED', 'RESTARTED', 'PASS', 'ROLLED_BACK', 'ALREADY', 'CLOSED_OUT',
           'MIGRATED', 'BASELINED', 'DRY_RUN')


def outcome(result, step=None):
    status = result.get('status')
    if status == 'ROLLED_BACK' and step == 'rollback':
        return EXIT['ok']
    if status in SUCCESS and status != 'ROLLED_BACK':
        return EXIT['ok']
    if status in ('REFUSED', 'FAIL'):
        return EXIT['refused']
    if status in ('ROLLED_BACK', 'ROLLED_BACK_TO_HEAD'):
        return EXIT['rolled_back']
    if status in ('ROLLBACK_FAILED', 'FAILED'):
        return EXIT['rollback_failed']
    if status in ('POLL_LOST', 'POLL_TIMEOUT', 'POLL_STOPPED', 'TRANSPORT_FAILED'):
        return EXIT['transport']
    return EXIT['no_result']


KEEP = ('status', 'code', 'failure', 'problems', 'runId', 'failures', 'warnings', 'exactState', 'undone', 'entry', 'plan',
        'label', 'services', 'restart', 'order', 'target', 'roots', 'pins', 'union', 'cache', 'key', 'files', 'sameInAll',
        'generated', 'pendingRestart', 'drift', 'units', 'pages', 'mcpDoor', 'issuer', 'reportQueue', 'equalities',
        'removed', 'removable', 'guards', 'ledger', 'unit', 'unitState', 'rebaselined', 'added', 'hint', 'family',
        'applied', 'already', 'backup', 'privileges', 'ledgers', 'migrations', 'backups', 'changes', 'conflicts',
        'grantRehearsal', 'appRole', 'runtimeRole')


def print_result(step, result):
    print('[%s] RESULT %s' % (step, json.dumps(scrub({k: result[k] for k in KEEP if k in result}), sort_keys=True,
                                               ensure_ascii=False)), flush=True)


def run_step(args, step, extra=None, value=None):
    remote = Remote(args.dry_run)
    if getattr(args, 'attach', None):
        unit = last_unit(step) if args.attach == 'last' else args.attach
        need(re.fullmatch(re.escape(PROFILE['host']['unitPrefix'] + step) + r'-[0-9]{8}T[0-9]{6}Z', unit) is not None, 'ATTACH_UNIT')
    else:
        unit = unit_name(step)
        runtime, stop, _ = limits(step)
        params = {'action': 'launch', 'step': step, 'unit': unit, 'args': extra or [], 'runtimeMax': runtime,
                  'stopTimeout': stop, 'alarm': 120}
        if value is not None:
            params['value'] = base64.b64encode(value.encode()).decode()
        answer = remote.dispatch('launch-' + step, params, 150)
        if args.dry_run:
            return {'status': 'DRY_RUN'}
        if answer.get('status') != 'LAUNCHED':
            if transport_failed(answer):
                remember(step, unit, {'launchAnswerLost': True})
                say('[%s] the launch answer was lost; %s may be running. Run `status`, then attach.' % (step, unit))
                return {'status': 'TRANSPORT_FAILED', 'unit': unit}
            say('[%s] not launched: %s' % (step, json.dumps(scrub({k: answer.get(k) for k in ('status', 'code')}))))
            return {'status': 'REFUSED', 'code': answer.get('code')}
        remember(step, unit)
        say('[%s] launched %s (attach again with --attach %s)' % (step, unit, unit))
    result = follow(remote, step, unit)
    print_result(step, result)
    return result


def run_read(args, command, extra=None, seconds=170):
    remote = Remote(args.dry_run)
    params = {'action': 'run', 'command': command, 'args': extra or [], 'seconds': seconds, 'alarm': seconds + 30}
    if command == 'verify':
        params['unit'] = unit_name('verify')
    answer = remote.dispatch(command, params, seconds + 60)
    if args.dry_run:
        return {'status': 'DRY_RUN'}
    if command == 'verify' and answer.get('status') == 'RAN':
        remember('verify', params['unit'])
    return answer


# ------------------------------------------------------------------------------------------------ git (local)

def repo():
    return (TEST or {}).get('repo') or os.path.expanduser(PROFILE['local']['repo'])


def git(*args, timeout=120, check=True):
    done = subprocess.run(['git', '-C', repo()] + list(args), capture_output=True, timeout=timeout)
    if check:
        need(done.returncode == 0, 'GIT_FAILED:' + ' '.join(args[:2]))
    return done


def git_show(commit, path):
    done = git('show', '%s:%s' % (commit, path), check=False)
    return done.stdout if done.returncode == 0 else None


def changed(base, commit, paths):
    done = git('diff', '--name-only', base, commit, '--', *paths)
    return [p for p in done.stdout.decode().split('\n') if p]


def env_template(raw):
    rows = {}
    for line in (raw or b'').decode('utf-8', 'replace').split('\n'):
        stripped = line.strip()
        if stripped and not stripped.startswith('#') and '=' in stripped:
            key, value = stripped.split('=', 1)
            rows[key.strip()] = value.strip()
    return rows


def placeholder(value):
    return 'REPLACE_ME' in value or 'example.invalid' in value or value == ''


# Root files every workspace build reads; a change to one is a change to every service.
ROOT_BUILD_FILES = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', 'tsconfig.json',
                    'tsconfig.base.json', '.npmrc', '.nvmrc', '.node-version')
DEPENDENCY_FIELDS = ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies')
_WORKSPACE = {}


def workspace_globs(raw):
    """The `packages:` list of a pnpm-workspace.yaml (None when there is no such file)."""
    if raw is None:
        return None
    globs, inside = [], False
    for line in raw.decode('utf-8', 'replace').split('\n'):
        if re.match(r'^packages\s*:', line):
            inside = True
            continue
        if inside:
            item = re.match(r'^\s+-\s*(["\']?)([^"\'#\s]+)\1', line)
            if item:
                globs.append(item.group(2))
            elif line.strip() and not line.startswith((' ', '\t', '#')):
                inside = False
    return globs


def in_workspace(folder, globs):
    if globs is None:
        return folder.count('/') <= 2
    for glob in globs:
        if '**' in glob:
            if fnmatch.fnmatchcase(folder, glob.replace('/**', '*').replace('**', '*')):
                return True
        elif glob.count('/') == folder.count('/') and \
                all(fnmatch.fnmatchcase(a, b) for a, b in zip(folder.split('/'), glob.split('/'))):
            return True
    return False


def workspace(commit):
    """{package folder: folders of the workspace packages it depends on} at a commit, from the package.json files
    under the pnpm workspace globs (every dependency field: a build reads them all)."""
    if commit in _WORKSPACE:
        return _WORKSPACE[commit]
    listing = git('ls-tree', '-r', '--name-only', commit).stdout.decode().split('\n')
    globs = workspace_globs(git_show(commit, 'pnpm-workspace.yaml'))
    folders = [p[:-len('/package.json')] for p in listing if p.endswith('/package.json') and
               'node_modules' not in p.split('/') and in_workspace(p[:-len('/package.json')], globs)]
    names, wants = {}, {}
    for folder in folders:
        try:
            value = json.loads(git_show(commit, folder + '/package.json') or b'{}')
        except ValueError:
            value = {}
        value = value if isinstance(value, dict) else {}
        if isinstance(value.get('name'), str):
            names.setdefault(value['name'], set()).add(folder)
        wants[folder] = {n for field in DEPENDENCY_FIELDS for n in (value.get(field) or {}) if isinstance(n, str)}
    graph = {f: set().union(*[names.get(n, set()) for n in wants[f]]) - {f} for f in folders}
    _WORKSPACE[commit] = graph
    return graph


def code_closure(commit, roots):
    """The workspace packages a service's code paths reach at a commit: every package inside (or holding) one of the
    profile's paths, and everything those depend on, transitively."""
    graph = workspace(commit)
    todo = [f for f in graph for r in roots if f == r or f.startswith(r + '/') or r.startswith(f + '/')]
    seen = set()
    while todo:
        folder = todo.pop()
        if folder not in seen:
            seen.add(folder)
            todo += sorted(graph.get(folder, ()))
    return seen


def code_paths(service, live_commit, commit):
    """What decides root against restart for a service: the profile's code paths (roots, not a full list), the
    workspace packages they depend on at the live commit and at the release commit, and the root build files."""
    roots = list(PROFILE['local']['codePaths'][service])
    depends = (code_closure(live_commit, roots) | code_closure(commit, roots)) - set(roots)
    files = PROFILE['local'].get('rootBuildFiles', ROOT_BUILD_FILES)
    return sorted(set(roots) | depends | set(files)), sorted(depends)


def refuse(refusals):
    """A plan refusal with the next step for each kind, in plain words."""
    toolkit = PROFILE['local'].get('pointers', {}).get('loginDoorToolkit', 'named in the profile')
    kinds = {'MIGRATIONS_PENDING': 'migrate', 'MIGRATION_ORDER': 'order', 'UNIT_TEMPLATE_CHANGED': 'unit',
             'LEDGER_UNREADABLE': 'ledger', 'NOT_ADOPTED': 'adopt', 'ROOT_MOVED': 'rebaseline'}
    steps = []
    for code in refusals:
        step = NEXT_STEP[kinds[code.split(':', 1)[0]]].format(toolkit=toolkit)
        if step not in steps:
            steps.append(step)
    say({'status': 'REFUSED', 'code': refusals[0], 'refusals': refusals, 'pointer': steps[0], 'next': steps})
    return EXIT['refused']


# ------------------------------------------------------------------------------------------------ migrations (local)

# Where the repository keeps its migrations, the App migration launcher and the runtime grant files (the CMS one this
# tool runs; the App one it only reads). A profile may name other paths (local.migrationSources, local.grantFiles).
MIGRATION_SOURCES = {'app': 'database/community-migrations', 'cms': 'apps/admin/src/migrations/index.ts',
                     'appLauncher': 'scripts/migrate-community.mjs'}
GRANT_FILES = {'cms': 'infra/development/grant-cms-runtime.sql', 'app': 'infra/development/work-publishing/grant-runtime.sql'}
GRANT_VARIABLES = {'cms': 'cms_role', 'app': 'app_role'}
FAMILIES = ('app', 'cms')
CMS_NAME = re.compile(r'20[0-9]{6}_[0-9]{6}_[a-z0-9_]{1,80}')
APP_ID = re.compile(r'[0-9]{14}')
APP_FILE = re.compile(r'[0-9]{14}_[a-z0-9_]{1,80}\.sql')
IDENT = re.compile(r'[a-z_][a-z0-9_]{0,62}')
RELATION = re.compile(r'[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}')
TABLE_PRIVILEGES = ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
SEQUENCE_PRIVILEGES = ('USAGE', 'SELECT', 'UPDATE')
COLUMN_PRIVILEGES = ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
SCHEMA_PRIVILEGES = ('USAGE', 'CREATE')
KINDS = r'TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TRIGGER|TYPE|SEQUENCE|SCHEMA|POLICY|DOMAIN|RULE'
TRANSACTION_CONTROL = r'(?:BEGIN|COMMIT|ROLLBACK|ABORT|END|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b'
# A statement that is more than an expand, when its object is not one the same SQL created before it. The first
# pattern a statement matches names it. DROP, TRUNCATE, DELETE, REVOKE and a dynamic EXECUTE count as statements (at
# the start, or a PL/pgSQL statement inside a DO block) or, for DROP, as an ALTER's clause: `ON COMMIT DROP`, a
# `BEFORE TRUNCATE` trigger and a trigger's `EXECUTE FUNCTION` are not. A function body runs when it is called, not
# when the migration runs, and is not read.
STATEMENT_START = r'(?:^|\b(?:BEGIN|THEN|ELSE|LOOP)\s+)'
CONTRACT = (('DROP', STATEMENT_START + r'DROP\b|\bALTER\s+(?:%s)\b.*\bDROP\b' % KINDS),
            ('RENAME', r'\bALTER\b.*\bRENAME\b'), ('TRUNCATE', STATEMENT_START + r'TRUNCATE\b'),
            ('TYPE', r'\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b'), ('SET_NOT_NULL', r'\bSET\s+NOT\s+NULL\b'),
            ('ADD_CONSTRAINT', r'\bALTER\s+TABLE\b.*\bADD\s+(?:CONSTRAINT|CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b'),
            ('ADD_NOT_NULL', r'\bALTER\s+TABLE\b.*\bADD\b.*\bNOT\s+NULL\b'), ('UNIQUE_INDEX', r'\bCREATE\s+UNIQUE\s+INDEX\b'),
            ('DELETE', STATEMENT_START + r'DELETE\s+FROM\b'), ('REVOKE', STATEMENT_START + r'REVOKE\b'),
            ('OWNER', r'\bOWNER\s+TO\b'), ('RLS', r'\b(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b'),
            ('DYNAMIC', STATEMENT_START + r'EXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)'))
# What an expand may do that still changes what the earlier code meets: reported with the plan, never refused.
NOTES = (('UPDATE', STATEMENT_START + r'UPDATE\s+(?:ONLY\s+)?([^\s(,]+)'),
         ('REPLACE', r'\bCREATE\s+OR\s+REPLACE\s+(?:%s)\s+([^\s(]+)' % KINDS),
         ('TRIGGER', r'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b.*?\bON\s+(?:ONLY\s+)?([^\s(]+)'))
# The words a CHECK expression may hold besides its columns, functions and types.
CHECK_WORDS = frozenset('''is not null and or in any all some array true false between symmetric like ilike similar to
escape case when then else end distinct from value collate at time zone interval date timestamp timestamptz with
without varying character precision double unknown overlaps current_date current_timestamp localtimestamp'''.split())
# An exception the Owner approved, written in the migration's SQL: `-- release: contraction-ok KIND:object ...`.
MARK = re.compile(r'^[ \t]*--[ \t]*release:[ \t]*contraction-ok\b(.*)$', re.M | re.I)
SERIAL = r'(?:small|big)?serial[248]?'
# What, after a column's name in ALTER TABLE ... ADD, gives it a value where the earlier code writes none.
VALUED = r'\b(?:DEFAULT|NOT\s+NULL|GENERATED|PRIMARY\s+KEY)\b|^\s*%s\b' % SERIAL


def names_sha(names):
    """A ledger's names as one digest (sorted, compact JSON): the host computes the same to see the ledger the plan
    saw, besides the plan's own migrations."""
    return sha_bytes(json.dumps(sorted(names), separators=(',', ':')).encode())


def sql_code(text, bodies=True):
    """SQL with comments removed and every single-quoted string emptied. Dollar-quote delimiters go; the body of a DO
    block stays and is read the same way (it runs now), a function's or procedure's body goes (it runs when called);
    with bodies=False every body goes."""
    def keep(match):
        token = match.group(0)
        if token.startswith(('--', '/*')):
            return ' '
        if match.group(1) is None:
            return "''"
        now = bodies and re.search(r'\bDO\s*(?:LANGUAGE\s+\w+\s*)?\Z', match.string[:match.start()], re.I)
        return ' %s ' % (sql_code(match.group(2)) if now else '')
    return re.sub(r"--[^\n]*|/\*.*?\*/|(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)(.*?)\1|[Ee]?'(?:[^']|'')*'", keep, text,
                  flags=re.S)


def sql_split(text):
    """The statements of SQL text as written (comments, strings, quoted names and dollar-quoted bodies kept whole), each
    with its ';'; pieces that hold only comments are left out."""
    pieces, start = [], 0
    for match in re.finditer(r"--[^\n]*|/\*.*?\*/|(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$).*?\1|[Ee]?'(?:[^']|'')*'|"
                             r"\"(?:[^\"]|\"\")*\"|;", text, re.S):
        if match.group(0) == ';':
            pieces.append(text[start:match.end()])
            start = match.end()
    pieces.append(text[start:])
    return [p.strip('\n') for p in pieces if sql_code(p, bodies=False).strip(' \t\n;')]


def statements(code):
    return [' '.join(part.split()) for part in code.split(';') if part.strip()]


def object_name(raw):
    """public.x and "x" are x; another schema stays named."""
    name = raw.strip().strip(',').split('(')[0].replace('"', '').lower()
    return name[len('public.'):] if name.startswith('public.') else name


def qualified(name):
    return name if '.' in name else 'public.' + name


def created_in(chunk):
    found = re.search(r'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:UNLOGGED\s+)?(?:TEMP(?:ORARY)?\s+)?'
                      r'(?:CONSTRAINT\s+)?(?:%s)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)' % KINDS,
                      chunk, re.I)
    return {object_name(found.group(1))} if found else set()


def target_of(chunk, label=None):
    patterns = {'DELETE': (r'\bDELETE\s+FROM\s+(?:ONLY\s+)?([^\s(,]+)',), 'DYNAMIC': ()}.get(label, (
        r'\bDROP\s+(?:%s)\s+(?:IF\s+EXISTS\s+)?([^\s(,]+)' % KINDS,
        r'\bALTER\s+(?:%s)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s(,]+)' % KINDS,
        r'\bCREATE\s+UNIQUE\s+INDEX\b.*?\bON\s+(?:ONLY\s+)?([^\s(]+)'))
    for pattern in patterns:
        found = re.search(pattern, chunk, re.I)
        if found:
            return object_name(found.group(1))
    return None


def revoke_targets(chunk):
    """Every object a REVOKE names (function argument lists left out); [None] for ALL ... IN SCHEMA or a shape this
    cannot read."""
    found = re.search(r'\bREVOKE\b.*?\bON\s+(?:(?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|SCHEMA|TYPE|DOMAIN)\s+)?(.+?)'
                      r'\s+FROM\b', chunk, re.I)
    names = re.sub(r'\([^)]*\)', '', found.group(1)) if found else ''
    if not names.strip() or re.match(r'ALL\s', names, re.I):
        return [None]
    return [object_name(n) for n in names.split(',') if n.strip()]


def keyed_columns(chunk):
    """The columns a unique index covers; None when this cannot read them."""
    found = re.findall(r'\bON\s+(?:ONLY\s+)?[^\s(]+\s*(?:USING\s+\w+\s*)?\(([^)]*)\)', chunk, re.I)
    return {object_name(c) for group in found for c in group.split(',')} if found else None


def check_expressions(chunk):
    """The expression of every `ADD [CONSTRAINT n] CHECK (...)` clause in a statement, its parentheses balanced."""
    out = []
    for found in re.finditer(r'\bADD\s+(?:CONSTRAINT\s+\S+\s+)?CHECK\s*\(', chunk, re.I):
        depth = 1
        for at in range(found.end(), len(chunk)):
            depth += {'(': 1, ')': -1}.get(chunk[at], 0)
            if depth == 0:
                out.append(chunk[found.end():at])
                break
        else:
            out.append(None)
    return out


def expression_columns(expression):
    """The names an expression reads: identifiers that are not a function called, a type after ::, a keyword, or a
    part of a qualified name."""
    names = set()
    for token in re.finditer(r'(::\s*|\.\s*)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(\s*[(.])?', expression):
        word = token.group(2)
        if token.group(1) or token.group(3) or word.lower() in CHECK_WORDS:
            continue
        names.add(object_name(word))
    return names


def top_level(text, separator):
    """`text` split at each match of the regex `separator` outside parentheses."""
    parts, depth, start = [], 0, 0
    for found in re.finditer(r'[()]|' + separator, text, re.I):
        if found.group(0) in ('(', ')'):
            depth += 1 if found.group(0) == '(' else -1
        elif depth == 0:
            parts.append(text[start:found.start()])
            start = found.end()
    return parts + [text[start:]]


def unwrapped(text):
    """`text` without the parentheses that enclose all of it."""
    text = text.strip()
    while text.startswith('(') and text.endswith(')'):
        depth = 0
        for at, char in enumerate(text):
            depth += {'(': 1, ')': -1}.get(char, 0)
            if depth == 0:
                break
        if at != len(text) - 1:
            break
        text = text[1:-1].strip()
    return text


def null_passes(expression, valued):
    """A CHECK on columns the same SQL added that the earlier code's rows pass: it reads no column the SQL gives a value
    (VALUED: a DEFAULT, NOT NULL, ...), and it is a top-level OR with a `<column> IS NULL` branch for every column it
    reads (`kind IS NULL OR kind IN (...)`). `kind IS NOT NULL`, `coalesce(n, 0) > 0` or `n > 0` are not."""
    branches = [unwrapped(b) for b in top_level(unwrapped(expression), r'\bOR\b')]
    nulls = {object_name(hit.group(1)) for hit in (re.fullmatch(r'("?[A-Za-z_][A-Za-z0-9_]*"?)\s+IS\s+NULL', b, re.I)
                                                   for b in branches) if hit}
    columns = expression_columns(expression)
    return len(branches) > 1 and columns <= nulls and not columns & valued


def constraint_columns(chunk, valued=frozenset()):
    """The columns every constraint an ALTER TABLE adds covers: a key's, a unique or a foreign key's column list, the
    columns a CHECK expression reads (null_passes for `valued`, the columns the SQL gives a value). None when one of
    them cannot be read (an EXCLUDE, a USING INDEX, ...) or a CHECK binds the earlier code's rows."""
    kinds = re.findall(r'\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b', chunk, re.I)
    keyed = re.findall(r'\bADD\s+(?:CONSTRAINT\s+\S+\s+)?(?:FOREIGN\s+KEY|UNIQUE|PRIMARY\s+KEY)\s*\(([^)]*)\)', chunk, re.I)
    checks = check_expressions(chunk)
    if not (kinds or checks) or None in checks or len(keyed) != len(kinds) or \
            not all(null_passes(e, valued) for e in checks):
        return None
    columns = {object_name(c) for group in keyed for c in group.split(',')}
    for expression in checks:
        columns |= expression_columns(expression)
    return columns


def expand_review(sql):
    """(problems, notes) for a migration's SQL. A problem makes it more than an expand: a DROP, RENAME, TRUNCATE, a
    column type change, a tightened constraint (SET NOT NULL, an added constraint, an added NOT NULL column without a
    default, a unique index), a DELETE, a REVOKE, an ownership change, row level security switched on, or a dynamic
    EXECUTE whose text cannot be read, on an object the same SQL did not create before it. A key, unique or foreign-key
    constraint or a unique index that covers only columns the same SQL added (what Payload writes for a new collection)
    binds nothing the earlier code writes; nor does a CHECK on such columns when the SQL gives them no DEFAULT and no
    NOT NULL and it reads `<column> IS NULL OR ...` for each (null_passes): the earlier code leaves them NULL. A
    statement's accepted constraint hides nothing else it does. A note is what an expand may still change for the
    earlier code (an UPDATE of existing rows, a CREATE OR REPLACE, a trigger on an existing table). Comments and string
    contents are not read; DO block bodies are, function bodies are not. Each answers 'KIND:object'."""
    created, added, valued, problems, notes = set(), {}, {}, [], []
    for chunk in statements(sql_code(sql)):
        upper = chunk.upper()
        if re.match(r'ALTER\s+TABLE\b', chunk, re.I):
            table = target_of(chunk)
            for clause in top_level(chunk, ','):
                found = re.search(r'\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:CONSTRAINT|CHECK|UNIQUE|PRIMARY|'
                                  r'FOREIGN|EXCLUDE)\b)("?[A-Za-z_][A-Za-z0-9_]*"?)(.*)', clause, re.I | re.S)
                if found:
                    added.setdefault(table, set()).add(object_name(found.group(1)))
                given = re.search(r'\bALTER\s+(?:COLUMN\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)\s+SET\s+DEFAULT\b', clause, re.I)
                if given or (found and re.search(VALUED, found.group(2), re.I)):
                    valued.setdefault(table, set()).add(object_name((given or found).group(1)))
        for label, pattern in CONTRACT:
            if re.search(pattern, upper) and not (label == 'ADD_NOT_NULL' and re.search(r'\bDEFAULT\b', upper)):
                columns = constraint_columns(chunk, valued.get(target_of(chunk), set())) if label == 'ADD_CONSTRAINT' else \
                    keyed_columns(chunk) if label == 'UNIQUE_INDEX' else None
                hits = [t for t in (revoke_targets(chunk) if label == 'REVOKE' else [target_of(chunk, label)])
                        if not (t in created or (columns is not None and t and columns <= added.get(t, set())))]
                problems += ['%s:%s' % (label, t or '?') for t in hits]
                if hits:
                    break
        for label, pattern in NOTES:
            found = re.search(pattern, chunk, re.I)
            if found and object_name(found.group(1)) not in created:
                notes.append('%s:%s' % (label, object_name(found.group(1))))
        created |= created_in(chunk)
    return problems, notes


def expand_problems(sql):
    return expand_review(sql)[0]


def expand_verdict(sql):
    """A migration judged with the exceptions written in it: `-- release: contraction-ok KIND:object ...` lines name
    problems the Owner approved (accepted). Every other problem stands, and so does a mark that names none
    (MARK_UNUSED), so a mark covers exactly what was approved."""
    problems, notes = expand_review(sql)
    marked = {t for found in MARK.finditer(sql) for t in re.split(r'[\s,]+', found.group(1))
              if re.fullmatch(r'[A-Z_]+:[^\s,]+', t)}
    return {'problems': [p for p in problems if p not in marked] + ['MARK_UNUSED:' + m for m in sorted(marked - set(problems))],
            'accepted': sorted(set(problems) & marked), 'notes': notes}


def pg_object_name(name1, name2, label):
    """PostgreSQL's own name for an implicit object (makeObjectName): name1_name2_label in 63 bytes at most, the
    longer of the two names shortened first."""
    while len(name1) + len(name2) + len(label) + 2 > 63:
        if len(name1) > len(name2):
            name1 = name1[:-1]
        else:
            name2 = name2[:-1]
    return '%s_%s_%s' % (name1, name2, label)


def owned_sequences(body, create):
    """[(column, serial?)] for the serial and identity columns a CREATE TABLE's column list, or an ALTER TABLE's ADD
    COLUMN and ADD GENERATED clauses, define: each comes with a sequence PostgreSQL creates and names itself."""
    lead = r'(?:\(|,)\s*' if create else r'\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?'
    column = r'("?[A-Za-z_][A-Za-z0-9_]*"?)'
    found = [(object_name(h.group(1)), True) for h in re.finditer(lead + column + r'\s+%s\b' % SERIAL, body, re.I)]
    found += [(object_name(h.group(1)), False) for h in re.finditer(
        lead + column + r'\s+[^,()]*?\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b', body, re.I)]
    if not create:
        found += [(object_name(h.group(1)), False) for h in re.finditer(
            r'\bALTER\s+(?:COLUMN\s+)?' + column + r'\s+ADD\s+GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b', body, re.I)]
    return found


def created_relations(sql):
    """The tables, views and sequences the SQL creates at its top level, in order; a serial or identity column's
    sequence (named as PostgreSQL names it) among them, with its table."""
    found = []
    for chunk in statements(sql_code(sql, bodies=False)):
        hit = re.match(r'CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\s+'
                       r'(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)', chunk, re.I)
        table = None
        if hit:
            name = qualified(object_name(hit.group(2)))
            found.append({'name': name, 'kind': 'sequence' if hit.group(1).upper() == 'SEQUENCE' else 'table'})
            if hit.group(1).upper() == 'TABLE':
                table, body, create = name, chunk[hit.end():], True
        else:
            hit = re.match(r'ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s(,]+)', chunk, re.I)
            if hit:
                table, body, create = qualified(object_name(hit.group(1))), chunk[hit.end():], False
        if table:
            schema, bare = table.split('.', 1)
            for column, serial in owned_sequences(body, create):
                found.append({'name': '%s.%s' % (schema, pg_object_name(bare, column, 'seq')), 'kind': 'sequence',
                              'table': table, 'column': column, 'serial': serial})
    return found


def created_names(sql):
    """Every object the SQL creates, of any kind (a function, view, type or schema as much as a table; a DO block's
    too, and the sequences PostgreSQL makes for it): 'schema.name', a schema as its bare name."""
    names = {c['name'] for c in created_relations(sql)}
    for chunk in statements(sql_code(sql)):
        schema = re.match(r'CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;]+)', chunk, re.I)
        names |= {schema.group(1).replace('"', '').lower()} if schema else {qualified(n) for n in created_in(chunk)}
    return sorted(names)


def mentions(piece, names):
    """Whether SQL text names one of `names` (created_names) or anything in a schema among them: any name in its own
    code, a schema-qualified one inside a string or a DO block's body (`format('GRANT ... ON TABLE community.t ...')`,
    `to_regclass('community.t')`); comments are not read."""
    schemas = {n for n in names if '.' not in n}
    words = r'[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?'
    inner = ' '.join(body + ' ' + string for _, body, string in re.findall(
        r"--[^\n]*|/\*.*?\*/|(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)(.*?)\1|[Ee]?'((?:[^']|'')*)'", piece, re.S))
    found = re.findall(words, sql_code(piece, bodies=False).lower().replace('"', ''))
    found += [w for w in re.findall(words, inner.lower().replace('"', '')) if '.' in w]
    return any(qualified(w) in names or w.split('.')[0] in schemas for w in found)


TS_COMMENTS = r'(?:(?://[^\n]*|/\*.*?\*/)\s*)*'
UP_BODY = re.compile(r'export\s+async\s+function\s+up\s*\([^)]*\)\s*(?::\s*Promise<void>\s*)?\{\s*' + TS_COMMENTS +
                     r'await\s+db\.execute\(\s*sql`([^`]*)`\s*\)\s*;?\s*' + TS_COMMENTS + r'\}\s*' + TS_COMMENTS, re.S)


def cms_sql(name, source):
    """A CMS migration's own up() SQL: up()'s whole body is one `await db.execute(sql`...`)`, with no sql.raw, no ${}
    interpolation and no backslash (so the template's text is exactly what Payload runs, and psql reads no meta-command
    in it), no psql variable (`:name` outside quotes: psql would put its own value in), no transaction control (the
    tool runs it in one transaction with its ledger row), and nothing that changes the session it runs in (SET, RESET,
    set_config: the tool's lock and statement timeouts and its role stay)."""
    text = source.decode('utf-8') if isinstance(source, bytes) else source
    start = re.search(r'export\s+async\s+function\s+up\s*\(', text)
    need(start is not None, 'CMS_MIGRATION_NOT_EXTRACTABLE:%s:NO_UP' % name)
    end = re.search(r'export\s+async\s+function\s+down\s*\(', text[start.end():])
    region = text[start.start():start.end() + end.start()] if end else text[start.start():]
    body = UP_BODY.fullmatch(region)
    reason = ('SQL_RAW' if 'sql.raw' in region else
              'SHAPE' if region.count('db.execute(') != 1 or body is None else
              'INTERPOLATION' if '${' in body.group(1) else
              'BACKSLASH' if '\\' in body.group(1) else
              'EMPTY' if not body.group(1).strip() else None)
    need(reason is None, 'CMS_MIGRATION_NOT_EXTRACTABLE:%s:%s' % (name, reason))
    sql = body.group(1).strip() + '\n'
    control = [s for s in statements(sql_code(sql, bodies=False)) if re.match(TRANSACTION_CONTROL, s, re.I)]
    need(not control, 'CMS_MIGRATION_NOT_EXTRACTABLE:%s:TRANSACTION_CONTROL' % name)
    code = sql_code(sql)
    session = [s for s in statements(code) if re.search(STATEMENT_START + r'(?:SET|RESET)\b', s, re.I)]
    need(not session and not re.search(r'\bset_config\s*\(', code, re.I), 'CMS_MIGRATION_NOT_EXTRACTABLE:%s:SESSION' % name)
    bare = re.sub(r'(?<!:)"(?:[^"]|"")*"', ' ', sql_code(sql, bodies=False))
    need(re.search(r"(?<!:):(?![:=])[A-Za-z_'\"{]", bare) is None, 'CMS_MIGRATION_NOT_EXTRACTABLE:%s:PSQL_VARIABLE' % name)
    return sql


def cms_index_names(raw):
    """The CMS migration names in the index, in its order."""
    found = re.findall(r'name: "(20[0-9]{6}_[0-9]{6}_[a-z0-9_]+)"', (raw or b'').decode('utf-8', 'replace'))
    return list(dict.fromkeys(found))


def judged(family, name, sql):
    """A pending migration's verdict, refused unless it only expands (or the Owner's marks cover what does not)."""
    verdict = expand_verdict(sql)
    need(not verdict['problems'], 'MIGRATION_NOT_EXPAND_ONLY:%s:%s:%s' % (family, name, ','.join(verdict['problems'][:3])))
    return {'contractions': verdict['accepted'], 'notes': verdict['notes']}


def cms_section(entries):
    """entries: [(name, migration source)] in apply order. Each migration's SQL is extracted, checked to only expand
    and pinned by sha256; the plan carries it to the host."""
    items = []
    for name, source in entries:
        sql = cms_sql(name, source)
        items.append(dict(judged('cms', name, sql), name=name, sha256=sha_bytes(sql.encode()), sql=sql,
                          creates=created_relations(sql), made=created_names(sql)))
    return {'names': [i['name'] for i in items], 'items': items}


def privilege_items(text, kind):
    """'SELECT, UPDATE (a, b)' as [('SELECT', []), ('UPDATE', ['a', 'b'])]; ALL as every privilege of the kind."""
    allowed = {'TABLE': TABLE_PRIVILEGES, 'SEQUENCE': SEQUENCE_PRIVILEGES, 'SCHEMA': SCHEMA_PRIVILEGES}[kind]
    items, rest = [], text.strip()
    while rest:
        found = re.match(r'(ALL(?:\s+PRIVILEGES)?|[A-Za-z]+)\s*(?:\(([^)]*)\))?\s*(?:,\s*|$)', rest)
        need(found is not None and found.end() > 0, 'GRANT_FILE_SHAPE:' + text[:60])
        word = ' '.join(found.group(1).upper().split())
        columns = [object_name(c) for c in (found.group(2) or '').split(',') if c.strip()]
        need(all(IDENT.fullmatch(c) for c in columns) and (not columns or (kind == 'TABLE' and word in COLUMN_PRIVILEGES)),
             'GRANT_FILE_SHAPE:' + word)
        need(word.startswith('ALL') or word in allowed, 'GRANT_FILE_SHAPE:' + word)
        items += [(p, []) for p in allowed] if word.startswith('ALL') else [(word, columns)]
        rest = rest[found.end():]
    return items


# A grant file's DO block whose every statement is EXECUTE format('GRANT <privileges> ON TABLE|SEQUENCE <objects> TO
# %I', current_setting('<setting>')), the text a constant, under at most one `IF to_regclass('<relation>') IS NOT NULL`
# guard: the App file's way to grant on a table an earlier migration phase may lack. Each counts as that GRANT to the
# file's role when the file bound the setting to the role's psql variable before (`SET LOCAL <setting> = :"app_role"`
# or `SELECT set_config('<setting>', :'app_role', true)`).
SETTING = r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*'
DYNAMIC_GRANT = (r"EXECUTE\s+format\(\s*'(GRANT\s[^'%%]+?\sON\s+(?:TABLE|SEQUENCE)\s[^'%%]+?\sTO\s+%%I)'\s*,\s*"
                 r"current_setting\(\s*'(%s)'\s*\)\s*\)\s*;" % SETTING)
DYNAMIC_BLOCK = re.compile(r"\s*BEGIN\s+(?:IF\s+to_regclass\(\s*'%s'\s*\)\s+IS\s+NOT\s+NULL\s+THEN\s+(?:%s\s*)+END\s+IF\s*;"
                           r"|(?:%s\s*)+)\s*END\s*;?\s*" % (SETTING, DYNAMIC_GRANT, DYNAMIC_GRANT), re.I)


def grant_statements(text, variable):
    """[(statement, dynamic)] of a grant file in order: its own statements (comments out, strings emptied, DO bodies
    gone) and each grant a DO block of the DYNAMIC_BLOCK shape makes, written as the GRANT it runs (dynamic)."""
    mark, bound, out = ':"%s"' % variable, set(), []
    for piece in sql_split(text):
        plain = re.sub(r"--[^\n]*|/\*.*?\*/|(?P<keep>(?P<tag>\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$).*?(?P=tag)|[Ee]?'(?:[^']|'')*')",
                       lambda m: m.group('keep') or ' ', piece, flags=re.S).strip()
        setting = re.fullmatch(r"SET\s+(?:LOCAL\s+)?(%s)\s*(?:=|TO)\s*(.*?)\s*;?" % SETTING, plain, re.I | re.S) or \
            re.fullmatch(r"SELECT\s+set_config\(\s*'(%s)'\s*,\s*(.*?)\s*,\s*(?:true|false)\s*\)\s*;?" % SETTING, plain, re.I | re.S)
        if setting:
            (bound.add if setting.group(2) in (mark, ":'%s'" % variable) else bound.discard)(setting.group(1).lower())
        block = re.fullmatch(r"DO\s+(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)(.*)\1\s*;?", plain, re.I | re.S)
        body = re.sub(r"--[^\n]*|('(?:[^']|'')*')", lambda m: m.group(1) or ' ', block.group(2)) if block else ''
        if block and DYNAMIC_BLOCK.fullmatch(body):
            out += [(' '.join(grant[:-2].split()) + ' ' + mark, True) for grant, name in re.findall(DYNAMIC_GRANT, body, re.I)
                    if name.lower() in bound]
        out += [(chunk, False) for chunk in statements(sql_code(piece, bodies=False))]
    return out


def grant_section(raw, path, creates, variable, ungranted=(), made=()):
    """A runtime grant file read for one release (statements GRANT ... TO :"<variable>" and REVOKE ... FROM it, in
    order, and the grants of a DO block of the DYNAMIC_BLOCK shape). For each table this release creates: the table
    privileges the file grants and the ones that must stay absent (DELETE and TRUNCATE among them unless granted), and
    the columns it grants privileges on; for each sequence it creates (a serial or identity column's among them), the
    same. A new table the file grants nothing on refuses (GRANT_FILE_MISSES_NEW_TABLE) unless declared --ungranted,
    and a serial column's sequence must be usable wherever its table takes INSERT. For what exists already: every
    relation the file's own statements name (the host checks each exists and is the migration role's before anything
    changes) and every privilege they grant (there once the file ran, schema USAGE among them); a DO block's grant
    counts for a new object only (its guard may skip what is not there). `rehearsal` is the file without every
    statement that names an object the release creates, of any kind (`made`, created_names): the host runs it in a
    transaction it rolls back, before anything changes, so the file's own guards speak first."""
    text = raw.decode('utf-8')
    need('\\' not in text, 'GRANT_FILE_SHAPE:backslash')
    mark = ':"%s"' % variable
    need(mark in text, 'GRANT_FILE_SHAPE:variable')
    tables = [c['name'] for c in creates if c['kind'] == 'table']
    sequences = [c for c in creates if c['kind'] == 'sequence']
    kind_of = dict({t: 'TABLE' for t in tables}, **{s['name']: 'SEQUENCE' for s in sequences})
    granted, columns, present, objects = {n: set() for n in kind_of}, {t: {} for t in tables}, {}, {}
    for chunk, dynamic in grant_statements(text, variable):
        need(not re.match(TRANSACTION_CONTROL, chunk, re.I), 'GRANT_FILE_SHAPE:transaction control')
        grant = re.match(r'GRANT\b', chunk, re.I) is not None
        if not grant and not re.match(r'REVOKE\b', chunk, re.I):
            continue
        found = re.match(r'GRANT\s+(.+?)\s+ON\s+(?:(TABLE|SEQUENCE|SCHEMA|FUNCTION)\s+)?(.+?)\s+TO\s+(\S+)$' if grant else
                         r'REVOKE\s+(.+?)\s+ON\s+(?:(TABLE|SEQUENCE|SCHEMA|FUNCTION)\s+)?(.+?)\s+FROM\s+(\S+)'
                         r'(?:\s+(?:CASCADE|RESTRICT))?$', chunk, re.I)
        need(found is not None and found.group(4) == mark, 'GRANT_FILE_SHAPE:' + chunk[:60])
        kind = (found.group(2) or 'TABLE').upper()
        if kind == 'FUNCTION':
            continue
        items = privilege_items(found.group(1), kind)
        for raw_name in found.group(3).split(','):
            if kind == 'SCHEMA':
                name = raw_name.strip().replace('"', '').lower()
                need(IDENT.fullmatch(name) is not None, 'GRANT_FILE_SHAPE:' + name)
                keys = [('schema', name, '', p) for p, _ in items]
            else:
                name = qualified(object_name(raw_name))
                need(RELATION.fullmatch(name) is not None, 'GRANT_FILE_SHAPE:' + name)
                if name in kind_of:
                    need(kind == kind_of[name], 'GRANT_KIND:' + name)
                    for privilege, cols in items:
                        if cols and grant:
                            columns[name].setdefault(privilege, set()).update(cols)
                        elif cols:
                            columns[name].get(privilege, set()).difference_update(cols)
                        elif grant:
                            granted[name].add(privilege)
                        else:
                            granted[name].discard(privilege)
                            columns.get(name, {}).pop(privilege, None)
                    continue
                if dynamic:
                    continue
                objects[name] = kind.lower()
                keys = [k for p, cols in items for k in ([('column', name, c, p) for c in cols] or [(kind.lower(), name, '', p)])]
                if not grant and kind == 'TABLE':      # a table-level REVOKE takes that privilege's column grants too
                    keys += [k for k in present if k[:2] == ('column', name) and k[3] in [p for p, c in items if not c]]
            for key in keys:
                if grant:
                    present[key] = True
                else:
                    present.pop(key, None)
    ungranted = sorted(set(ungranted))
    for name in ungranted:
        need(name in tables, 'UNGRANTED_NOT_NEW:' + name)
        need(not granted[name] and not any(columns[name].values()), 'UNGRANTED_BUT_GRANTED:' + name)
    for name in tables:
        need(granted[name] or any(columns[name].values()) or name in ungranted,
             'GRANT_FILE_MISSES_NEW_TABLE:%s:grant it in %s (a GRANT, or a DO block of EXECUTE format(\'GRANT ... ON TABLE '
             '%s TO %%I\', current_setting(<a setting the file binds to %s>)) under at most one to_regclass guard); '
             '--ungranted only when the role is to have nothing' % (name, path, name, mark))
    for item in sequences:
        table = item.get('table')
        if item.get('serial') and table in granted and ('INSERT' in granted[table] or columns[table].get('INSERT')):
            need(granted[item['name']] & {'USAGE', 'UPDATE'}, 'GRANT_FILE_MISSES_SEQUENCE:' + item['name'])
    rehearsal = '\n'.join(p for p in sql_split(text) if not mentions(p, set(kind_of) | set(made)))
    return {'file': path, 'sha256': sha_bytes(raw), 'sql': text, 'variable': variable, 'ungranted': ungranted,
            'tables': [{'table': t, 'granted': [p for p in TABLE_PRIVILEGES if p in granted[t]],
                        'absent': [p for p in TABLE_PRIVILEGES if p not in granted[t]],
                        'columns': {p: sorted(c) for p, c in sorted(columns[t].items()) if c}} for t in tables],
            'sequences': [{'sequence': s['name'], 'granted': [p for p in SEQUENCE_PRIVILEGES if p in granted[s['name']]],
                           'absent': [p for p in SEQUENCE_PRIVILEGES if p not in granted[s['name']]]} for s in sequences],
            'objects': [{'name': n, 'kind': k} for n, k in sorted(objects.items())],
            'present': [dict({'kind': k, 'name': n, 'privilege': p}, **({'column': c} if c else {}))
                        for k, n, c, p in sorted(present)],
            'rehearsal': rehearsal, 'rehearsalSha256': sha_bytes(rehearsal.encode())}


def app_section(pending, files, directory, launcher, launcher_raw, service):
    """files: {file name: bytes} for every SQL file of the App migration directory at the release commit (the
    release's own runner checks the whole set against its compiled manifest). The release's own launcher runs them
    on the host from the new root of `service`; build carries the files as payload blobs, pinned here, and the host
    checks the modules the launcher imports from that root are there."""
    items = []
    for migration_id in pending:
        hits = [f for f in files if f[:15] == migration_id + '_']
        need(len(hits) == 1 and APP_FILE.fullmatch(hits[0]) is not None, 'MIGRATION_SOURCE:app:' + migration_id)
        sql = files[hits[0]].decode('utf-8')
        items.append(dict(judged('app', migration_id, sql), name=migration_id, file=hits[0], creates=created_relations(sql),
                          made=created_names(sql)))
    need(re.fullmatch(r'[a-z0-9_-]+(?:/[a-z0-9_-]+)*\.mjs', launcher) is not None and
         re.fullmatch(r'[a-z0-9_-]+(?:/[a-z0-9_-]+)*', directory) is not None, 'MIGRATION_SOURCE_PATHS')
    modules = sorted(set(re.findall(r'import\(\s*["\']\.\./(services/[A-Za-z0-9_./-]+\.m?js)["\']\s*\)',
                                    launcher_raw.decode('utf-8', 'replace'))))
    need(all('..' not in m.split('/') for m in modules), 'MIGRATION_SOURCE_PATHS')
    return {'names': list(pending), 'items': items, 'directory': directory, 'service': service, 'modules': modules,
            'files': [{'name': f, 'sha256': sha_bytes(files[f])} for f in sorted(files)],
            'launcher': {'path': launcher, 'sha256': sha_bytes(launcher_raw)}}


def parse_migrations(items):
    declared = {f: [] for f in FAMILIES}
    for item in [x for arg in items or [] for x in arg.split(',') if x]:
        family, _, name = item.partition(':')
        shape = CMS_NAME if family == 'cms' else APP_ID
        need(family in FAMILIES and shape.fullmatch(name) is not None and name not in declared[family],
             'MIGRATION_DECLARATION:%s' % item[:100])
        declared[family].append(name)
    return declared


def parse_ungranted(items):
    """--ungranted FAMILY:SCHEMA.TABLE: a new table the runtime role is meant to have no privilege on."""
    declared = {f: [] for f in FAMILIES}
    for item in [x for arg in items or [] for x in arg.split(',') if x]:
        family, _, name = item.partition(':')
        need(family in FAMILIES and RELATION.fullmatch(name) is not None, 'UNGRANTED_DECLARATION:%s' % item[:100])
        declared[family].append(name)
    return declared


def migration_check(root, base):
    """The CI check, no profile and no host: against `base` (main), every new App migration file and every new CMS
    migration name sorts after the latest one there, the CMS index stays in name order, each new migration only
    expands (or carries the Owner's contraction-ok marks for exactly what does not), and each new CMS migration's SQL
    can be extracted. The new side is the working tree at `root`. Accepted marks and notes are reported."""
    def run_git(*args):
        return subprocess.run(['git', '-C', root] + list(args), capture_output=True, timeout=60)
    found = run_git('rev-parse', '--verify', '-q', base + '^{commit}')
    need(found.returncode == 0, 'BASE_UNKNOWN:' + base)
    commit = found.stdout.decode().strip()
    app_dir, index = MIGRATION_SOURCES['app'], MIGRATION_SOURCES['cms']
    listing = run_git('ls-tree', '--name-only', commit, app_dir + '/').stdout.decode().split('\n')
    old_app = sorted(os.path.basename(l) for l in listing if l.endswith('.sql'))
    folder = os.path.join(root, app_dir)
    new_app = sorted(f for f in (os.listdir(folder) if os.path.isdir(folder) else []) if f.endswith('.sql') and f not in old_app)
    shown = run_git('show', '%s:%s' % (commit, index))
    old_cms = cms_index_names(shown.stdout if shown.returncode == 0 else b'')
    index_path = os.path.join(root, index)
    cms = cms_index_names(open(index_path, 'rb').read() if os.path.isfile(index_path) else b'')
    new_cms = [n for n in cms if n not in old_cms]
    problems, accepted, notes = [], [], []

    def judge(prefix, name, sql):
        verdict = expand_verdict(sql)
        accepted.extend('%s:%s' % (name, p) for p in verdict['accepted'])
        notes.extend('%s:%s' % (name, p) for p in verdict['notes'])
        return ['%s_NOT_EXPAND_ONLY:%s:%s' % (prefix, name, p) for p in verdict['problems']]
    latest = max([f[:14] for f in old_app] or [''])
    for name in new_app:
        if APP_FILE.fullmatch(name) is None:
            problems.append('APP_NAME:' + name)
            continue
        if name[:14] <= latest:
            problems.append('APP_NOT_AFTER_MAIN:%s:%s' % (name, latest))
        problems += judge('APP', name, open(os.path.join(folder, name), 'rb').read().decode('utf-8', 'replace'))
    if cms != sorted(cms):
        problems.append('CMS_INDEX_ORDER')
    latest = max(old_cms or [''])
    for name in new_cms:
        if CMS_NAME.fullmatch(name) is None:
            problems.append('CMS_NAME:' + name)
            continue
        if name <= latest:
            problems.append('CMS_NOT_AFTER_MAIN:%s:%s' % (name, latest))
        path = os.path.join(root, os.path.dirname(index), name + '.ts')
        if not os.path.isfile(path):
            problems.append('CMS_SOURCE_MISSING:' + name)
            continue
        try:
            problems += judge('CMS', name, cms_sql(name, open(path, 'rb').read()))
        except ClientError as error:
            problems.append(str(error))
    return {'status': 'FAIL' if problems else 'PASS', 'base': base, 'commit': commit,
            'new': {'app': new_app, 'cms': new_cms}, 'problems': problems, 'accepted': accepted, 'notes': notes}


def cmd_check_migrations(args):
    root = args.repo or str(HERE.parent.parent)
    try:
        value = migration_check(root, args.base)
    except ClientError as error:
        say({'status': 'REFUSED', 'code': str(error)})
        return EXIT['local']
    say(value)
    return EXIT['ok'] if value['status'] == 'PASS' else EXIT['refused']


def migration_sources():
    return dict(MIGRATION_SOURCES, **((PROFILE.get('local') or {}).get('migrationSources') or {}))


def grant_files():
    return dict(GRANT_FILES, **((PROFILE.get('local') or {}).get('grantFiles') or {}))


# ------------------------------------------------------------------------------------------------ plan

def latest_plan():
    path = work('plans', 'latest')
    need(path.exists(), 'NO_PLAN:run plan first')
    return path.read_text().strip()


def load_local_plan(plan_id):
    plan_id = plan_id or latest_plan()
    need(re.fullmatch(r'[0-9a-f]{16}', plan_id) is not None, 'PLAN_ID')
    raw = work('plans', plan_id, 'plan.json').read_bytes()
    need(sha_bytes(raw)[:16] == plan_id, 'PLAN_SHA')
    return plan_id, raw, json.loads(raw)


def host_facts(dry_run=False):
    answer = run_read(argparse.Namespace(dry_run=dry_run), 'facts')
    need(answer.get('status') == 'RAN' and (answer.get('answer') or {}).get('status') == 'FACTS',
         'HOST_FACTS:%s' % ((answer.get('answer') or {}).get('code') or answer.get('code') or answer.get('status')))
    return answer['answer']


def cmd_plan(args):
    h, local = PROFILE['host'], PROFILE['local']
    commit = args.commit
    need(re.fullmatch(r'[0-9a-f]{40}', commit or '') is not None, 'COMMIT_MUST_BE_40_HEX')
    names = [s for s in (args.services or '').split(',') if s]
    need(names and len(set(names)) == len(names) and all(s in h['services'] for s in names), 'SERVICES')
    need(git('cat-file', '-e', commit + '^{commit}', check=False).returncode == 0, 'COMMIT_UNKNOWN')
    main_ref = (TEST or {}).get('mainRef') or local.get('mainRef', 'origin/main')
    if not (TEST or {}).get('offline'):
        git('fetch', '-q', 'origin', 'main', timeout=180)
    need(git('merge-base', '--is-ancestor', commit, main_ref, check=False).returncode == 0, 'NOT_ON_MAIN')
    if local.get('requiredAncestor'):
        need(git('merge-base', '--is-ancestor', local['requiredAncestor'], commit, check=False).returncode == 0,
             'LACKS_REQUIRED_ANCESTOR')
    facts = host_facts()
    # The ledger must hold every service and env file the profile names and still match the host's roots.
    gaps = list(facts.get('notAdopted') or []) + [s for s in names if s not in (facts.get('services') or {})]
    if facts.get('rootMoved'):
        return refuse(['ROOT_MOVED:' + ','.join(facts['rootMoved'])])
    if gaps:
        return refuse(['NOT_ADOPTED:' + ','.join(sorted(set(gaps)))])
    refusals, warnings = [], []
    services, live_commits = {}, {}
    for service in names:
        live = facts['services'][service]
        live_commits[service] = live['commit']
        need(git('cat-file', '-e', live['commit'] + '^{commit}', check=False).returncode == 0, 'LIVE_COMMIT_UNKNOWN:' + service)
        paths, depends = code_paths(service, live['commit'], commit)
        moved = changed(live['commit'], commit, paths)
        mode = 'root' if moved or service in (args.force_root or []) else 'restart'
        if mode == 'root' and live['commit'] == commit:
            mode = 'restart'
        services[service] = {'mode': mode, 'artifact': h['services'][service]['artifact'], 'from': live['label'],
                             'changedFiles': len(moved), 'dependsOn': depends}
        if mode == 'root':
            need(facts['services'][service].get('manifestSha256'), 'LIVE_MANIFEST_MISSING:' + service)
        if mode == 'root' and h['services'][service].get('cloneOf'):
            base = h['services'][service]['cloneOf']
            need(facts['services'][base].get('manifestSha256'), 'LIVE_MANIFEST_MISSING:' + base)
    # Migrations: each one the commit carries and the host's ledgers lack must be declared (--migrations), sort after
    # the ledger's latest (forward only) and only expand; an undeclared one refuses the plan.
    ledgers = facts.get('ledgers') or {}
    sources = migration_sources()
    listing = git('ls-tree', '--name-only', commit, sources['app'] + '/').stdout.decode().split('\n')
    app_files = sorted(os.path.basename(l) for l in listing if re.match(r'.*/[0-9]{14}_[^/]*\.sql$', l))
    wanted = {'app': sorted({f[:14] for f in app_files}), 'cms': cms_index_names(git_show(commit, sources['cms']))}
    asked = parse_migrations(args.migrations)
    pending = {}
    for which in FAMILIES:
        have = (ledgers.get(which) or {}).get('names')
        if not isinstance(have, list):
            refusals.append('LEDGER_UNREADABLE:' + which)
            continue
        missing = [m for m in wanted[which] if m not in have]
        for name in asked[which]:
            need(name in wanted[which], 'MIGRATION_UNKNOWN:%s:%s' % (which, name))
            if name in have:
                warnings.append('MIGRATION_ALREADY_APPLIED:%s:%s' % (which, name))
        late = [m for m in missing if have and m < max(have)]
        undeclared = [m for m in missing if m not in asked[which]]
        if late:
            refusals.append('MIGRATION_ORDER:%s:%s' % (which, ','.join(late[:10])))
        if undeclared:
            refusals.append('MIGRATIONS_PENDING:%s:%s' % (which, ','.join(undeclared[:10])))
        if missing and not late and not undeclared:
            pending[which] = missing
    declared = []
    for item in args.env or []:
        files, _, key = item.partition(':')
        need(re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', key) and all(f in h['envFiles'] for f in files.split(',')), 'ENV_DECLARATION')
        declared.append({'files': sorted(files.split(',')), 'key': key})
    declared_keys = {(f, d['key']) for d in declared for f in d['files']}
    oldest = {}
    for service in names:
        for name in h['services'][service].get('envFiles', []):
            oldest.setdefault(name, live_commits[service])
    for name, base in sorted(oldest.items()):
        path = local.get('envTemplates', {}).get(name)
        if not path:
            continue
        old, new = env_template(git_show(base, path)), env_template(git_show(commit, path))
        have = set((facts['envFiles'].get(name) or {}).get('keys') or [])
        for key in sorted(set(new) - set(old)):
            if key not in have and (name, key) not in declared_keys:
                warnings.append('ENV_KEY_ADDED:%s:%s' % (name, key))
        for key in sorted(set(new) & set(old)):
            if new[key] != old[key] and not placeholder(new[key]) and (name, key) not in declared_keys:
                warnings.append('ENV_TEMPLATE_VALUE_CHANGED:%s:%s' % (name, key))
    # Phase A changes no unit: a unit template that changed since the service's live commit refuses, unless the
    # operator states that the host's unit already carries the change.
    for service in names:
        unit = local.get('unitTemplates', {}).get(service)
        if unit and changed(live_commits[service], commit, [unit]) and service not in (args.unit_applied or []):
            refusals.append('UNIT_TEMPLATE_CHANGED:' + service)
    if local.get('nginxTemplate') and any(changed(c, commit, [local['nginxTemplate']]) for c in set(live_commits.values())):
        warnings.append('NGINX_TEMPLATE_CHANGED')
    if refusals:
        return refuse(refusals)
    migrations, grants = {}, {}
    ungranted = parse_ungranted(args.ungranted)
    paths = grant_files()
    # The services that log in as the CMS runtime role: a CMS grant file changed since their live commit is run (and
    # checked) before they switch, migration or not.
    cms_runtime = [s for s in names if (h.get('database', {}).get('cmsRuntimeRole') or {}).get('envFile') in
                   h['services'][s].get('envFiles', [])]
    if pending.get('cms'):
        folder = os.path.dirname(sources['cms'])
        entries = [(name, git_show(commit, '%s/%s.ts' % (folder, name))) for name in pending['cms']]
        missing = [name for name, source in entries if source is None]
        need(not missing, 'MIGRATION_SOURCE:cms:' + ','.join(missing))
        migrations['cms'] = cms_section(entries)
    elif any(changed(live_commits[s], commit, [paths['cms']]) for s in cms_runtime):
        migrations['cms'] = {'names': [], 'items': [], 'grantsOnly': True}
        warnings.append('GRANT_FILE_CHANGED:cms')
    if 'cms' in migrations:
        raw = git_show(commit, paths['cms'])
        need(raw is not None, 'GRANT_FILE_MISSING:' + paths['cms'])
        items = migrations['cms']['items']
        grants['cms'] = grant_section(raw, paths['cms'], [c for i in items for c in i['creates']], GRANT_VARIABLES['cms'],
                                      ungranted['cms'], [n for i in items for n in i['made']])
    if pending.get('app'):
        # The release's own runner applies them from the new root of this service (its compiled manifest names them).
        runner = h.get('database', {}).get('appMigrationService')
        need(runner in services and services[runner]['mode'] == 'root', 'MIGRATION_NEEDS_ROOT:app:%s' % runner)
        launcher = git_show(commit, sources['appLauncher'])
        need(launcher is not None, 'MIGRATION_SOURCE:app:' + sources['appLauncher'])
        files = {f: git_show(commit, '%s/%s' % (sources['app'], f)) for f in app_files}
        migrations['app'] = app_section(pending['app'], files, sources['app'], sources['appLauncher'], launcher, runner)
        creates = [c for i in migrations['app']['items'] for c in i['creates']]
        if creates:
            # The App grant file is the operator's to run; the plan carries only what it means for the new objects,
            # which migrate and verify read back for the App role.
            raw = git_show(commit, paths['app'])
            need(raw is not None, 'GRANT_FILE_MISSING:' + paths['app'])
            section = grant_section(raw, paths['app'], creates, GRANT_VARIABLES['app'], ungranted['app'],
                                    [n for i in migrations['app']['items'] for n in i['made']])
            grants['app'] = {k: section[k] for k in ('file', 'sha256', 'variable', 'ungranted', 'tables', 'sequences')}
    for family in FAMILIES:
        need(not ungranted[family] or family in grants, 'UNGRANTED_NOT_NEW:' + ','.join(ungranted[family]))
        for item in (migrations.get(family) or {}).get('items') or []:
            warnings += ['MIGRATION_CONTRACTION_OK:%s:%s:%s' % (family, item['name'], p) for p in item['contractions']]
            warnings += ['MIGRATION_NOTE:%s:%s:%s' % (family, item['name'], p) for p in item['notes']]
    order = [s for s in h.get('restartOrder', sorted(h['services'])) if s in services]
    # The order the release takes: every migration (and a changed CMS grant file) before any service starts on code
    # that reads it.
    sequence = ['migrate --family ' + f for f in FAMILIES if f in migrations] + ['switch ' + ','.join(order)]
    categories = sorted({'code' if s['mode'] == 'root' else 'restart' for s in services.values()} |
                        ({'+env'} if declared else set()) |
                        ({'+migration'} if any(m['names'] for m in migrations.values()) else set()) |
                        ({'+grants'} if (migrations.get('cms') or {}).get('grantsOnly') else set()))
    plan = {'kind': 'artvenn-release-plan', 'schema': 1, 'source': commit, 'label': commit[:8], 'order': order,
            'services': {s: {'mode': v['mode'], 'artifact': v['artifact'], 'dependsOn': v['dependsOn']}
                         for s, v in services.items()},
            'live': {s: {'label': facts['services'][s]['label'], 'commit': facts['services'][s]['commit'],
                         'manifestSha256': facts['services'][s].get('manifestSha256')} for s in facts['services']},
            'env': declared, 'categories': categories, 'warnings': warnings,
            'ledgerHead': (facts.get('ledger') or {}).get('head'), 'createdAt': stamp()}
    if migrations:
        plan.update(migrations=migrations, grants=grants, sequence=sequence,
                    ledgers={f: {'count': len(ledgers[f]['names']), 'namesSha256': names_sha(ledgers[f]['names'])}
                             for f in migrations})
    raw = json.dumps(plan, indent=1, sort_keys=True).encode()
    plan_id = sha_bytes(raw)[:16]
    write_private(work('plans', plan_id, 'plan.json'), raw)
    write_private(work('plans', 'latest'), plan_id.encode())
    say({'status': 'PLANNED', 'plan': plan_id, 'source': commit, 'services': services, 'categories': categories,
         'warnings': warnings, 'env': declared, 'sequence': sequence,
         'migrations': {f: v['names'] for f, v in migrations.items()},
         'privileges': {f: {'tables': v['tables'], 'sequences': v['sequences']} for f, v in grants.items()}})
    return EXIT['ok']


# ------------------------------------------------------------------------------------------------ build

def compile_argv(commit, out, roles):
    template = (TEST or {}).get('compile') or PROFILE['local']['compile']['argv']
    return [a.replace('{commit}', commit).replace('{out}', str(out)).replace('{roles}', ','.join(roles)) for a in template]


def fetch_manifest(service, want):
    answer = run_read(argparse.Namespace(dry_run=False), 'manifest', ['--service', service])
    need(answer.get('status') == 'MANIFEST', 'MANIFEST_FETCH:%s:%s' % (service, answer.get('code') or answer.get('status')))
    raw = base64.b64decode(answer['b64'])
    need(sha_bytes(raw) == answer['sha256'] == want, 'LIVE_MANIFEST_MOVED:' + service)
    return raw


def tar_payload(stage):
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', mtime=0, compresslevel=6) as zipped:
        with tarfile.open(fileobj=zipped, mode='w', format=tarfile.PAX_FORMAT) as tar:
            for path in sorted(p for p in stage.rglob('*') if p.is_file()):
                info = tarfile.TarInfo(path.relative_to(stage).as_posix())
                info.size, info.mtime, info.mode, info.uid, info.gid = path.stat().st_size, 0, 0o600, 0, 0
                with open(path, 'rb') as handle:
                    tar.addfile(info, handle)
    return buffer.getvalue()


def cmd_build(args):
    plan_id, _, plan = load_local_plan(args.plan)
    h = PROFILE['host']
    commit = plan['source']
    artifacts = sorted({v['artifact'] for v in plan['services'].values() if v['mode'] == 'root'})
    need(artifacts, 'NOTHING_TO_BUILD:a restart-only plan needs no build; stage and switch directly')
    out = work('builds', plan_id)
    compiled = out / 'compile'
    private_dir(compiled)
    timeout = PROFILE['local']['compile'].get('timeoutSeconds', 3600)
    say({'phase': 'compile', 'state': 'start', 'artifacts': artifacts})
    done = subprocess.run(compile_argv(commit, compiled, artifacts), capture_output=True, timeout=timeout)
    (out / 'compile.log').write_bytes(done.stdout[-200000:] + b'\n--- stderr ---\n' + done.stderr[-200000:])
    need(done.returncode == 0, 'COMPILE_FAILED:%d' % done.returncode)
    stage = out / 'stage'
    if stage.exists():
        import shutil
        shutil.rmtree(stage)
    (stage / 'manifests').mkdir(parents=True)
    (stage / 'blobs').mkdir()
    manifests, counts = {}, {}
    for artifact in artifacts:
        raw = (compiled / 'artifacts' / ('%s-manifest.json' % artifact)).read_bytes()
        value = json.loads(raw)
        need(value.get('role') == artifact and value.get('source') == commit, 'MANIFEST_SOURCE:' + artifact)
        base_service = next(s for s in sorted(h['services']) if h['services'][s]['artifact'] == artifact and
                            not h['services'][s].get('cloneOf'))
        live = {r['path']: r for r in json.loads(fetch_manifest(base_service, plan['live'][base_service]['manifestSha256']))['files']}
        extracted = compiled / 'artifacts' / ('%s-extracted' % artifact)
        linked = blobs = 0
        for row in value['files']:
            if row['type'] not in ('file', 'generated'):
                continue
            old = live.get(row['path'])
            if old and old.get('type') in ('file', 'generated') and old.get('sha256') == row['sha256'] and \
                    (old.get('mode', 0) & 0o555) == (row['mode'] & 0o555):
                row['src'] = 'base'
                linked += 1
            else:
                row['src'] = 'blob'
                source = extracted / row['path']
                need(source.is_file() and sha_file(source) == row['sha256'], 'EXTRACTED_SHA:' + row['path'])
                target = stage / 'blobs' / row['sha256']
                if not target.exists():
                    target.write_bytes(source.read_bytes())
                    blobs += 1
        annotated = json.dumps(value, sort_keys=True).encode()
        (stage / 'manifests' / ('%s.json' % artifact)).write_bytes(annotated)
        manifests[artifact] = sha_bytes(annotated)
        counts[artifact] = {'linked': linked, 'blobs': blobs}
    app = (plan.get('migrations') or {}).get('app')
    if app:
        # The App migration directory and the release's own launcher, as blobs named by the sha256 the plan pins.
        rows = [('%s/%s' % (app['directory'], f['name']), f['sha256']) for f in app['files']]
        rows.append((app['launcher']['path'], app['launcher']['sha256']))
        for path, digest in rows:
            raw = git_show(commit, path)
            need(raw is not None and sha_bytes(raw) == digest, 'MIGRATION_SOURCE_CHANGED:' + path)
            target = stage / 'blobs' / digest
            if not target.exists():
                target.write_bytes(raw)
        counts['migrations'] = {'blobs': len(rows)}
    payload = tar_payload(stage)
    part_bytes = PROFILE['local'].get('partBytes', 4 << 20)
    parts_dir = out / 'parts'
    private_dir(parts_dir)
    parts = []
    for offset in range(0, len(payload), part_bytes):
        chunk = payload[offset:offset + part_bytes]
        name = 'part-' + sha_bytes(chunk)           # content-addressed: a rebuild never meets a different same-named part
        if not (parts_dir / name).exists():
            write_private(parts_dir / name, chunk)
        parts.append({'name': name, 'sha256': sha_bytes(chunk), 'bytes': len(chunk)})
    payload_sha = sha_bytes(payload)
    build = {'kind': 'artvenn-release-build', 'planId': plan_id, 'source': commit, 'payloadSha256': payload_sha,
             'payloadId': payload_sha[:16], 'manifests': manifests, 'parts': parts, 'bytes': len(payload), 'counts': counts}
    write_private(work('plans', plan_id, 'build.json'), json.dumps(build, indent=1, sort_keys=True).encode())
    say({'status': 'BUILT', 'plan': plan_id, 'payloadSha256': payload_sha, 'parts': len(parts), 'bytes': len(payload),
         'counts': counts})
    return EXIT['ok']


def restart_only_build(plan_id, plan):
    """A plan with no new root still goes to the host (switch reads it): an empty build record, no payload."""
    build = {'kind': 'artvenn-release-build', 'planId': plan_id, 'source': plan['source'], 'payloadSha256': None,
             'payloadId': None, 'manifests': {}, 'parts': [], 'bytes': 0, 'counts': {}}
    raw = json.dumps(build, indent=1, sort_keys=True).encode()
    write_private(work('plans', plan_id, 'build.json'), raw)
    return raw


# ------------------------------------------------------------------------------------------------ stage

def cmd_stage(args):
    plan_id, plan_raw, plan = load_local_plan(args.plan)
    build_path = work('plans', plan_id, 'build.json')
    if not build_path.exists():
        need(all(v['mode'] == 'restart' for v in plan['services'].values()), 'NO_BUILD:run build first')
        restart_only_build(plan_id, plan)
    build_raw = build_path.read_bytes()
    build = json.loads(build_raw)
    need(build.get('planId') == plan_id and build.get('source') == plan['source'], 'BUILD_NOT_THIS_PLAN')
    remote = Remote(args.dry_run)
    answer = remote.dispatch('put-plan', {'action': 'put-plan', 'planId': plan_id, 'planB64': base64.b64encode(plan_raw).decode(),
                                          'buildB64': base64.b64encode(build_raw).decode()}, 60)
    if not args.dry_run:
        need(answer.get('status') in ('PUT', 'ALREADY'), 'PUT_PLAN:%s' % (answer.get('code') or answer.get('status')))
    if not build['parts']:
        say({'status': 'STAGED', 'plan': plan_id, 'parts': 0})
        return EXIT['ok']
    folder = work('builds', plan_id, 'parts')
    for part in build['parts']:
        need(sha_file(folder / part['name']) == part['sha256'] == part['name'][5:], 'LOCAL_PART_CHANGED:' + part['name'][:17])
    have = {}
    if not args.dry_run:
        inventory = remote.dispatch('inventory', {'action': 'inventory', 'payloadId': build['payloadId']}, 60)
        need(inventory.get('status') == 'INVENTORY', 'INVENTORY:%s' % (inventory.get('code') or inventory.get('status')))
        have = inventory.get('parts') or {}
    todo = [p for p in build['parts'] if have.get(p['name']) != p['bytes']]
    say('stage: %d of %d parts already on the host; sending %d (%d bytes)' % (len(build['parts']) - len(todo),
                                                                                len(build['parts']), len(todo),
                                                                                sum(p['bytes'] for p in todo)))
    root = (TEST or {}).get('root') or ''
    state = PROFILE['host']['paths']['state']

    def send(part):
        command = '%s -c %s %s %s %s %d' % (remote_stdin()[:-2].strip(), shlex.quote(RECEIVER), shlex.quote(root),
                                            shlex.quote(state), part['name'], part['bytes'])
        argv = ssh_argv() + [command]
        if args.dry_run:
            say('DRY-RUN upload %s: %s <receiver> ...' % (part['name'][:17], shlex.join(ssh_argv())))
            return {'status': 'DRY_RUN'}
        answer = {'status': 'TRANSPORT_FAILED'}
        for attempt in range(1, 4):
            try:
                done = subprocess.run(argv, input=(folder / part['name']).read_bytes(), capture_output=True, timeout=1800)
                lines = [l for l in done.stdout.decode().splitlines() if l.startswith('{')]
                answer = json.loads(lines[-1]) if lines else {'status': 'NO_JSON'}
            except (subprocess.TimeoutExpired, OSError, ValueError) as error:
                answer = {'status': 'TRANSPORT_FAILED', 'category': type(error).__name__}
            if answer.get('status') in ('RECEIVED', 'ALREADY_PRESENT', 'REFUSED'):
                return answer
            time.sleep(0 if TEST else min(10, 2 * attempt))
        return answer

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        answers = dict(zip([p['name'] for p in todo], pool.map(send, todo)))
    store('stage-upload', {k[:17]: v for k, v in answers.items()})
    if args.dry_run:
        return EXIT['ok']
    bad = {n[:17]: a.get('code') or a.get('status') for n, a in answers.items() if a.get('status') not in ('RECEIVED', 'ALREADY_PRESENT')}
    if bad:
        say('stage: parts not received: %s' % json.dumps(bad, sort_keys=True))
        return EXIT['transport'] if any(v in ('TRANSPORT_FAILED', 'NO_JSON') for v in bad.values()) else EXIT['refused']
    answer = remote.dispatch('assemble', {'action': 'assemble', 'parts': build['parts'], 'payloadId': build['payloadId'],
                                          'payloadSha256': build['payloadSha256'], 'alarm': 600}, 660)
    say({'status': 'STAGED' if answer.get('status') in ('ASSEMBLED', 'ALREADY_ASSEMBLED') else 'REFUSED',
         'plan': plan_id, 'assemble': answer.get('status'), 'code': answer.get('code')})
    return EXIT['ok'] if answer.get('status') in ('ASSEMBLED', 'ALREADY_ASSEMBLED') else EXIT['refused']


# ------------------------------------------------------------------------------------------------ verbs

def cmd_install(args):
    identity = tool_identity()
    params = {'action': 'install', 'toolB64': base64.b64encode(HOST_TOOL.read_bytes()).decode(),
              'profileB64': base64.b64encode(host_profile_bytes()).decode(), 'alarm': 60}
    answer = Remote(args.dry_run).dispatch('install', params, 90)
    if args.dry_run:
        return EXIT['ok']
    say({'status': answer.get('status'), 'code': answer.get('code'), 'version': identity['version'],
         'toolSha256': identity['sha256'], 'profileSha256': identity['profileSha256']})
    return EXIT['ok'] if answer.get('status') in ('INSTALLED', 'ALREADY_INSTALLED') else EXIT['refused']


def cmd_read(command):
    def handler(args):
        answer = run_read(args, command)
        if args.dry_run:
            return EXIT['ok']
        inner = answer.get('answer') or answer
        say(inner)
        if transport_failed(answer):
            return EXIT['transport']
        wanted = {'baseline': 'BASELINE', 'status': 'STATUS', 'verify': 'PASS'}[command]
        return EXIT['ok'] if inner.get('status') == wanted else EXIT['refused']
    return handler


def cmd_long(step, extra_of=lambda args: [], guard=None):
    def handler(args):
        if guard:
            guard(args)
        result = run_step(args, step, extra_of(args))
        return outcome(result, step)
    return handler


def outage_ok(args):
    need(args.outage_ok or args.dry_run, 'NEEDS_--outage-ok')


def cmd_switch(args):
    outage_ok(args)
    need(re.fullmatch(r'[a-z][a-z0-9,-]{1,120}', args.services or '') is not None, 'SERVICES')
    extra = ['--services', args.services]
    if args.plan:
        plan_id, _, plan = load_local_plan(args.plan)
        need(all(s in plan['services'] for s in args.services.split(',')), 'SERVICE_NOT_IN_PLAN')
        extra += ['--plan', plan_id]
    return outcome(run_step(args, 'switch', extra), 'switch')


def cmd_rollback(args):
    outage_ok(args)
    need(args.to == 'previous', 'ROLLBACK_TO:only --to previous')
    return outcome(run_step(args, 'rollback', ['--to', 'previous'] + (['--unswitched-ok'] if args.unswitched_ok else [])),
                   'rollback')


def cmd_close_out(args):
    need(args.accepted or args.dry_run, 'CLOSE_OUT_NEEDS_--accepted')
    return outcome(run_step(args, 'close-out', ['--as', 'accepted']), 'close-out')


def read_value_file(path):
    """A private local file: a regular file of ours, mode 0600 or 0400, one line. Its content never leaves this process
    except inside the ssh stdin script."""
    p = pathlib.Path(os.path.expanduser(path))
    info = os.lstat(p)
    need(not os.path.islink(p) and p.is_file() and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'VALUE_FILE_SHAPE')
    raw = p.read_bytes()
    need(len(raw) <= 32768, 'VALUE_FILE_SIZE')
    text = raw.decode('utf-8')
    text = text[:-1] if text.endswith('\n') else text
    need(text and '\n' not in text and '\r' not in text and '\0' not in text, 'VALUE_FILE_ONE_LINE')
    return text


def cmd_env(args):
    need(args.env_action == 'set', 'ENV_ACTION:only `env set`')
    h = PROFILE['host']
    files = [f for f in (args.files or '').split(',') if f]
    need(files and all(f in h['envFiles'] for f in files), 'ENV_FILES')
    need(re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', args.key or '') is not None, 'ENV_KEY_SHAPE')
    need(bool(args.value_file) != bool(args.generate), 'ENV_VALUE_SOURCE:--value-file or --generate')
    extra = ['--files', ','.join(files), '--key', args.key]
    value = None
    if args.generate:
        need(args.generate == 'token64', 'GENERATE_KIND')
        extra += ['--generate', 'token64']
    else:
        value = read_value_file(args.value_file)
    if args.add:
        extra.append('--add')
    if args.plan:
        extra += ['--plan', load_local_plan(args.plan)[0]]
    return outcome(run_step(args, 'env-set', extra, value=value), 'env-set')


def cmd_status(args):
    answer = run_read(args, 'status')
    if args.dry_run:
        return EXIT['ok']
    inner = answer.get('answer') or answer
    say(inner)
    return EXIT['ok'] if inner.get('status') == 'STATUS' else EXIT['transport'] if transport_failed(answer) else EXIT['refused']


def cmd_verify(args):
    answer = run_read(args, 'verify', seconds=300)
    if args.dry_run:
        return EXIT['ok']
    inner = answer.get('answer') or answer
    print_result('verify', inner)
    return EXIT['ok'] if inner.get('status') == 'PASS' else EXIT['transport'] if transport_failed(answer) else EXIT['refused']


def cmd_migrate(args):
    """One family of the plan's migrations, after prepare and before switch. The primary backup is TencentDB's
    automatic backup and point-in-time recovery: the operator confirms it is on (--pitr-confirmed); the host then dumps
    only the objects these migrations touch. --check runs the same checks on the host and changes nothing.
    --rebaseline records the family's ledger count and the new objects' privileges as they are now (after a change
    made outside this tool), for verify to read from then on."""
    need(args.family in FAMILIES, 'FAMILY:--family cms or --family app')
    if args.rebaseline:
        need(not args.check and not args.plan, 'REBASELINE_ALONE:--rebaseline takes no plan and no --check')
        return outcome(run_step(args, 'migrate', ['--family', args.family, '--rebaseline']), 'migrate')
    plan_id, _, plan = load_local_plan(args.plan)
    section = (plan.get('migrations') or {}).get(args.family) or {}
    need(section.get('names') or section.get('grantsOnly'), 'NO_MIGRATIONS_IN_PLAN:' + args.family)
    extra = ['--plan', plan_id, '--family', args.family]
    if args.check:
        answer = run_read(args, 'migrate-check', extra)
        if args.dry_run:
            return EXIT['ok']
        inner = answer.get('answer') or answer
        say(inner)
        if inner.get('status') == 'MIGRATE_CHECKED':
            return EXIT['ok']
        return EXIT['transport'] if transport_failed(answer) else EXIT['refused']
    need(args.pitr_confirmed or args.dry_run or args.attach, 'NEEDS_--pitr-confirmed:confirm in the TencentDB console '
         'that automatic backup and point-in-time recovery are on for this instance, then pass --pitr-confirmed')
    return outcome(run_step(args, 'migrate', extra + ['--pitr', 'confirmed']), 'migrate')


def cmd_stub(verb):
    def handler(args):
        toolkit = PROFILE['local'].get('pointers', {}).get('loginDoorToolkit', 'named in the profile')
        say({'status': 'REFUSED', 'code': 'NOT_IN_PHASE_A:' + verb, 'pointer': NEXT_STEP[verb].format(toolkit=toolkit)})
        return EXIT['refused']
    return handler


def main(argv=None):
    parser = argparse.ArgumentParser(description='standing release tool (see scripts/release/README.md)')
    parser.add_argument('--profile', default=os.environ.get('ARTVENN_RELEASE_PROFILE'))
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan')
    p.add_argument('commit')
    p.add_argument('--services', required=True)
    p.add_argument('--env', action='append', metavar='FILES:KEY')
    p.add_argument('--migrations', action='append', metavar='FAMILY:NAME')
    p.add_argument('--ungranted', action='append', metavar='FAMILY:SCHEMA.TABLE')
    p.add_argument('--force-root', action='append')
    p.add_argument('--unit-applied', action='append', metavar='SERVICE')
    p.add_argument('--dry-run', action='store_true')
    p = sub.add_parser('build')
    p.add_argument('--plan')
    p = sub.add_parser('check-migrations')
    p.add_argument('--base', default='origin/main')
    p.add_argument('--repo')
    for name in ('install', 'baseline', 'status', 'stage', 'adopt', 'prepare', 'migrate', 'switch', 'verify', 'rollback',
                 'close-out', 'env') + STUBS:
        s = sub.add_parser(name)
        s.add_argument('--dry-run', action='store_true')
        if name in ('stage', 'prepare', 'switch', 'migrate'):
            s.add_argument('--plan')
        if name in ('adopt', 'prepare', 'switch', 'rollback', 'close-out', 'env', 'migrate'):
            s.add_argument('--attach', metavar='UNIT|last')
        if name == 'migrate':
            s.add_argument('--family', required=True)
            s.add_argument('--pitr-confirmed', action='store_true')
            s.add_argument('--check', action='store_true')
            s.add_argument('--rebaseline', action='store_true')
        if name == 'adopt':
            s.add_argument('--rebaseline', action='store_true')
        if name == 'switch':
            s.add_argument('services')
            s.add_argument('--outage-ok', action='store_true')
        if name == 'rollback':
            s.add_argument('--to', required=True)
            s.add_argument('--outage-ok', action='store_true')
            s.add_argument('--unswitched-ok', action='store_true')
        if name == 'close-out':
            s.add_argument('--accepted', action='store_true')
        if name == 'env':
            s.add_argument('env_action')
            s.add_argument('files')
            s.add_argument('key')
            s.add_argument('--value-file')
            s.add_argument('--generate')
            s.add_argument('--add', action='store_true')
            s.add_argument('--plan')
    args = parser.parse_args(argv)
    if args.command == 'check-migrations':
        return cmd_check_migrations(args)          # CI: the repository alone, no profile, no host
    global TEST
    TEST = json.loads(pathlib.Path(os.environ['RELEASE_CLIENT_TEST']).read_text()) if os.environ.get('RELEASE_CLIENT_TEST') else None
    os.umask(0o077)
    try:
        load_profile(args.profile)
        private_dir(work('logs'))
        append(work('logs', 'client.jsonl'), {'at': stamp(), 'command': args.command,
                                              'dryRun': bool(getattr(args, 'dry_run', False))})
        commands = {'install': cmd_install, 'baseline': cmd_read('baseline'), 'status': cmd_status, 'plan': cmd_plan,
                    'build': cmd_build, 'stage': cmd_stage,
                    'adopt': cmd_long('adopt', lambda a: ['--rebaseline'] if a.rebaseline else []),
                    'prepare': lambda a: outcome(run_step(a, 'prepare', ['--plan', load_local_plan(a.plan)[0]]), 'prepare'),
                    'migrate': cmd_migrate, 'switch': cmd_switch, 'verify': cmd_verify, 'rollback': cmd_rollback, 'close-out': cmd_close_out,
                    'env': cmd_env}
        commands.update({verb: cmd_stub(verb) for verb in STUBS})
        code = commands[args.command](args)
    except ClientError as error:
        say('%s: REFUSED locally: %s' % (args.command, error))
        code = EXIT['local']
    if PROFILE:
        append(work('logs', 'client.jsonl'), {'at': stamp(), 'command': args.command, 'exit': code})
    return code


if __name__ == '__main__':
    sys.exit(main())
