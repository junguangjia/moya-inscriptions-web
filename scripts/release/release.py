#!/usr/bin/env python3
"""Standing release tool, local side (phase A). Python standard library only.

  python3 -I scripts/release/release.py --profile <private profile.json> <verb> [options]

  install                         the host tool and the host part of the profile, versioned and sha-pinned (idempotent)
  baseline | status               read-only host facts
  plan <40-hex commit> --services web,admin,issuer [--env FILES:KEY ...] [--force-root S] [--unit-applied S]
                                  local git checks and read-only host facts; refuses a release phase A cannot finish
  build [--plan ID]               local only: compile (the profile's builder), delta against the live manifests,
                                  a content-addressed payload in parts
  stage [--plan ID]               the plan, the missing parts, the payload assembled on the host
  adopt [--rebaseline]            the ledger's first entry: the live state as found (again after an outside change;
                                  --rebaseline also records roots a release outside this tool moved)
  prepare [--plan ID]             new roots, static unions, caches, rendered pins; no service change
  env set FILES KEY (--value-file PATH | --generate token64) [--add] [--plan ID]
                                  one key in the named env files and their staged copies; prints no value
  switch SERVICES [--plan ID] --outage-ok    in the order given; undoes itself on any failure or SIGTERM; without
                                  --plan a restart on the same roots (RESTARTED), refused while a staged plan is pending
  verify                          read-only checks on the host
  rollback --to previous --outage-ok         the state before the latest release, from the host's ledger
  close-out --accepted            after a PASS verify: earlier env versions and payloads removed; roots listed
  migrate | dns | cert | edgeone | nginx | unit    not in phase A: refused, with the next step in plain words

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
        'close-out': (300, 30)}            # RuntimeMaxSec, TimeoutStopSec floors; see limits()
STUBS = ('migrate', 'dns', 'cert', 'edgeone', 'nginx', 'unit')
# The next step for what phase A does not do, in plain words. {toolkit} is the profile's login-door toolkit pointer.
NEXT_STEP = {
    'migrate': 'Phase A applies no migration. Until phase B, apply it with the login-door toolkit ({toolkit}), its '
               'migration steps, reviewed for this release. If that release moves a root, run `adopt --rebaseline` '
               'here afterwards, then plan again.',
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
LONG = ('adopt', 'prepare', 'env-set', 'switch', 'rollback', 'close-out')
READS = ('baseline', 'facts', 'status', 'verify', 'manifest')
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
           'DRY_RUN')


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
        'removed', 'removable', 'guards', 'ledger', 'unit', 'unitState', 'rebaselined', 'added', 'hint')


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
    kinds = {'MIGRATIONS_PENDING': 'migrate', 'UNIT_TEMPLATE_CHANGED': 'unit', 'LEDGER_UNREADABLE': 'ledger',
             'NOT_ADOPTED': 'adopt', 'ROOT_MOVED': 'rebaseline'}
    steps = []
    for code in refusals:
        step = NEXT_STEP[kinds[code.split(':', 1)[0]]].format(toolkit=toolkit)
        if step not in steps:
            steps.append(step)
    say({'status': 'REFUSED', 'code': refusals[0], 'refusals': refusals, 'pointer': steps[0], 'next': steps})
    return EXIT['refused']


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
    # Migrations: phase A cannot apply any, so a commit that carries one the host's ledgers lack is refused.
    ledgers = facts.get('ledgers') or {}
    listing = git('ls-tree', '--name-only', commit, local['migrationSources']['app'] + '/').stdout.decode().split('\n')
    app_ids = sorted({os.path.basename(l)[:14] for l in listing if re.match(r'.*/[0-9]{14}_[^/]*\.sql$', l)})
    index = (git_show(commit, local['migrationSources']['cms']) or b'').decode()
    cms_names = sorted(set(re.findall(r'name: "(20[0-9]{6}_[0-9]{6}_[a-z0-9_]+)"', index)))
    for which, wanted in (('app', app_ids), ('cms', cms_names)):
        have = (ledgers.get(which) or {}).get('names')
        if not isinstance(have, list):
            refusals.append('LEDGER_UNREADABLE:' + which)
            continue
        missing = [m for m in wanted if m not in have]
        if missing:
            refusals.append('MIGRATIONS_PENDING:%s:%s' % (which, ','.join(missing[:10])))
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
    categories = sorted({'code' if s['mode'] == 'root' else 'restart' for s in services.values()} |
                        ({'+env'} if declared else set()))
    plan = {'kind': 'artvenn-release-plan', 'schema': 1, 'source': commit, 'label': commit[:8],
            'order': [s for s in h.get('restartOrder', sorted(h['services'])) if s in services],
            'services': {s: {'mode': v['mode'], 'artifact': v['artifact'], 'dependsOn': v['dependsOn']}
                         for s, v in services.items()},
            'live': {s: {'label': facts['services'][s]['label'], 'commit': facts['services'][s]['commit'],
                         'manifestSha256': facts['services'][s].get('manifestSha256')} for s in facts['services']},
            'env': declared, 'categories': categories, 'warnings': warnings,
            'ledgerHead': (facts.get('ledger') or {}).get('head'), 'createdAt': stamp()}
    raw = json.dumps(plan, indent=1, sort_keys=True).encode()
    plan_id = sha_bytes(raw)[:16]
    write_private(work('plans', plan_id, 'plan.json'), raw)
    write_private(work('plans', 'latest'), plan_id.encode())
    say({'status': 'PLANNED', 'plan': plan_id, 'source': commit, 'services': services, 'categories': categories,
         'warnings': warnings, 'env': declared})
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
    return outcome(run_step(args, 'rollback', ['--to', 'previous']), 'rollback')


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
    p.add_argument('--force-root', action='append')
    p.add_argument('--unit-applied', action='append', metavar='SERVICE')
    p.add_argument('--dry-run', action='store_true')
    p = sub.add_parser('build')
    p.add_argument('--plan')
    for name in ('install', 'baseline', 'status', 'stage', 'adopt', 'prepare', 'switch', 'verify', 'rollback', 'close-out',
                 'env') + STUBS:
        s = sub.add_parser(name)
        s.add_argument('--dry-run', action='store_true')
        if name in ('stage', 'prepare', 'switch'):
            s.add_argument('--plan')
        if name in ('adopt', 'prepare', 'switch', 'rollback', 'close-out', 'env'):
            s.add_argument('--attach', metavar='UNIT|last')
        if name == 'adopt':
            s.add_argument('--rebaseline', action='store_true')
        if name == 'switch':
            s.add_argument('services')
            s.add_argument('--outage-ok', action='store_true')
        if name == 'rollback':
            s.add_argument('--to', required=True)
            s.add_argument('--outage-ok', action='store_true')
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
                    'switch': cmd_switch, 'verify': cmd_verify, 'rollback': cmd_rollback, 'close-out': cmd_close_out,
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
