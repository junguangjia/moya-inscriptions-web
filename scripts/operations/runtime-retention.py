#!/usr/bin/env python3
"""Deployment catalog and typed immutable-artifact retirement; never application data."""
import argparse
import hashlib
import importlib.util
import fcntl
import time
import json
import os
import pathlib
import re
import stat
import signal
import sys
import tempfile

ROLES = {'backend', 'worker', 'issuer', 'admin', 'web'}
KINDS = {'runtime', 'build', 'migration', 'scratch', 'recovery'}

class Refused(Exception):
    pass

def need(value, category):
    if not value:
        raise Refused(category)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def identifier(value):
    need(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,127}', value), 'ID_INVALID')
    return value

def relative(value):
    need(isinstance(value, str) and value and '\\' not in value, 'PATH_INVALID')
    path = pathlib.PurePosixPath(value)
    need(not path.is_absolute() and '..' not in path.parts and str(path) == value and value != '.', 'PATH_INVALID')
    return value

def fingerprint(value):
    need(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'DIGEST_INVALID')
    return value

def empty_catalog():
    return {'schema': 1, 'generation': 0, 'artifacts': [], 'roles': {}, 'transition': None, 'static': []}

def validate(catalog):
    need(catalog.get('schema') == 1 and isinstance(catalog.get('generation'), int) and catalog['generation'] >= 0, 'CATALOG_INVALID')
    rows = {}
    paths = set()
    need(len(catalog.get('artifacts', [])) <= 4096 and len(catalog.get('static', [])) <= 100000, 'CATALOG_LIMIT')
    for row in catalog['artifacts']:
        key = identifier(row['id']); name = relative(row['path'])
        need(key not in rows and name not in paths and row['kind'] in KINDS and row['state'] in ('candidate', 'failed', 'ready'), 'CATALOG_INVALID')
        fingerprint(row['manifestSha256'])
        need(isinstance(row['expiresAt'], int) and isinstance(row['createdAt'], int) and row['expiresAt'] > row['createdAt'], 'CATALOG_INVALID')
        need(row['kind'] not in ('runtime','recovery') or row.get('role') in ROLES, 'ROLE_INVALID')
        rows[key] = row; paths.add(name)
    need(not any(a != b and pathlib.PurePosixPath(a) in pathlib.PurePosixPath(b).parents for a in paths for b in paths), 'TARGET_OVERLAP')
    static_paths = set()
    for role, binding in catalog['roles'].items():
        need(role in ROLES and binding['current'] in rows and rows[binding['current']]['kind'] == 'runtime' and rows[binding['current']]['role'] == role, 'ROLE_INVALID')
        rollback = binding.get('rollback')
        if rollback is not None:
            need(rollback in rows and rollback != binding['current'], 'ROLLBACK_INVALID')
            proof = binding.get('compatibility', {})
            need(proof.get('verified') is True and proof.get('dataCompatible') is True and proof.get('current') == rows[binding['current']]['manifestSha256'] and proof.get('rollback') == rows[rollback]['manifestSha256'], 'ROLLBACK_INVALID')
    transition = catalog.get('transition')
    if transition is not None:
        need(transition['role'] in ROLES and transition['candidate'] in rows and transition['previous'] in rows, 'TRANSITION_INVALID')
    for item in catalog['static']:
        relative(item['path']); fingerprint(item['sha256'])
        need(item['path'] not in static_paths, 'STATIC_MANIFEST_INVALID'); static_paths.add(item['path'])
        need(isinstance(item['retainUntil'], int) and isinstance(item['consumers'], list) and all(key in rows for key in item['consumers']), 'STATIC_MANIFEST_INVALID')
    return rows

def transition(catalog, event, now):
    # Pure deterministic transition; caller persists with compare-and-swap below.
    catalog = json.loads(json.dumps(catalog)); rows = validate(catalog)
    kind = event['operation']
    if kind == 'stage':
        row = event['artifact']; key = identifier(row['id'])
        need(key not in rows and row['createdAt'] == now and now < row['expiresAt'] <= now + 7*86400000, 'CANDIDATE_INVALID')
        space = event.get('space', {})
        need(space.get('observedAt') == now and all(isinstance(space.get(key), int) and space[key] >= 0 for key in ('freeBytes', 'incomingBytes', 'freeFloor')) and space['freeBytes'] >= space['incomingBytes'] + space['freeFloor'], 'PEAK_SPACE_REFUSED')
        catalog['artifacts'].append(row)
    elif kind == 'begin':
        role, candidate = event['role'], event['candidate']
        need(catalog['transition'] is None and role in catalog['roles'] and candidate in rows and rows[candidate]['state'] == 'candidate', 'TRANSITION_INVALID')
        catalog['transition'] = {'role': role, 'candidate': candidate, 'previous': catalog['roles'][role]['current']}
    elif kind == 'activate':
        pending = catalog['transition']; need(pending is not None and event.get('healthy') is True, 'ACTIVATION_UNVERIFIED')
        current, previous = pending['candidate'], pending['previous']
        proof = event.get('compatibility')
        if proof is not None:
            need(proof.get('verified') is True and proof.get('dataCompatible') is True and proof.get('current') == rows[current]['manifestSha256'] and proof.get('rollback') == rows[previous]['manifestSha256'], 'ROLLBACK_INVALID')
        catalog['roles'][pending['role']] = {'current': current, 'rollback': previous if proof is not None else None, 'compatibility': proof}
        rows[current]['state'] = 'ready'; catalog['transition'] = None
    elif kind == 'fail':
        need(catalog['transition'] is not None and event.get('previousRestored') is True, 'RECOVERY_UNVERIFIED')
        rows[catalog['transition']['candidate']]['state'] = 'failed'; catalog['transition'] = None
    elif kind == 'ack-retired':
        selected = set(event['ids'])
        protected = {value for binding in catalog['roles'].values() for value in (binding['current'], binding.get('rollback')) if value}
        if catalog['transition']:
            protected.update((catalog['transition']['candidate'], catalog['transition']['previous']))
        need(not selected & protected and selected <= set(rows), 'ARTIFACT_PROTECTED')
        need(event.get('deletionReceiptVerified') is True, 'RETIREMENT_UNVERIFIED')
        catalog['artifacts'] = [row for row in catalog['artifacts'] if row['id'] not in selected]
        removed_paths = [pathlib.PurePosixPath(rows[key]['path']) for key in selected]
        catalog['static'] = [dict(item, consumers=[key for key in item['consumers'] if key not in selected]) for item in catalog['static'] if not any(path in pathlib.PurePosixPath(item['path']).parents for path in removed_paths)]
    else:
        raise Refused('EVENT_INVALID')
    catalog['generation'] += 1; validate(catalog)
    return catalog

def retirement_plan(catalog, consumers, now, free_bytes, incoming_bytes, free_floor):
    rows = validate(catalog)
    need(all(isinstance(value, int) and value >= 0 for value in (now, free_bytes, incoming_bytes, free_floor)), 'SPACE_INPUT')
    peak = {'allowed': free_bytes >= incoming_bytes + free_floor, 'incomingBytes': incoming_bytes, 'freeBytes': free_bytes, 'freeFloor': free_floor}
    protected = {}
    for role, binding in catalog['roles'].items():
        protected.setdefault(binding['current'], []).append(role + ':current')
        if binding.get('rollback'):
            protected.setdefault(binding['rollback'], []).append(role + ':compatible-rollback')
    if catalog.get('transition'):
        for key in ('candidate', 'previous'):
            protected.setdefault(catalog['transition'][key], []).append('transition-incomplete')
    complete = (consumers.get('complete') is True and isinstance(consumers.get('observedAt'), int) and
                0 <= now - consumers['observedAt'] <= 60000 and isinstance(consumers.get('bindings'), list))
    for binding in consumers.get('bindings', []):
        if binding.get('artifact') not in rows or binding.get('verified') is not True or binding.get('kind') not in ('process', 'startup', 'maintenance', 'hold'):
            complete = False
        elif binding['artifact'] in rows:
            protected.setdefault(binding['artifact'], []).append(binding['kind'])
    # A retained static file protects the whole owning tree until the producer
    # provides an independently owned compatibility copy. Never delete its parent.
    for item in catalog['static']:
        if now < item['retainUntil'] or any(key in protected for key in item['consumers']):
            for key, row in rows.items():
                if pathlib.PurePosixPath(row['path']) in pathlib.PurePosixPath(item['path']).parents:
                    protected.setdefault(key, []).append('static-compatibility')
    eligible, retained = [], []
    for key, row in sorted(rows.items()):
        reasons = protected.get(key, []).copy()
        if not complete:
            reasons.append('unknown-or-stale-consumers')
        if row['expiresAt'] > now:
            reasons.append('retention-window')
        if reasons:
            retained.append({'id': key, 'reasons': reasons})
        else:
            eligible.append({'id': key, 'path': row['path'], 'manifestSha256': row['manifestSha256']})
    static = []
    for row in catalog['static']:
        if complete and consumers.get('staticComplete') is True and now >= row['retainUntil'] and not any(key in protected for key in row['consumers']):
            static.append({'path': row['path'], 'sha256': row['sha256']})
    return {'schema': 1, 'status': 'RETIREMENT_PLAN', 'catalogSha256': sha(encoded(catalog)), 'consumerSha256': sha(encoded(consumers)), 'observedAt': now,
            'peakGate': peak, 'eligible': eligible, 'retained': retained, 'staticEligible': static, 'credentialValuesPrinted': False}

def allocated_reclaim(root, selected):
    """Exact selected directory trees; count regular blocks only at the final selected link."""
    root = pathlib.Path(root).resolve(strict=True)
    paths = [root / relative(name) for name in selected]
    need(len(set(paths)) == len(paths) and not any(a != b and a in b.parents for a in paths for b in paths), 'TARGET_OVERLAP')
    inodes, directories = {}, 0
    for path in paths:
        need(path.parent.resolve().is_relative_to(root) and not path.is_symlink(), 'TARGET_UNSAFE')
        need(path.is_dir(), 'TARGET_UNSAFE')
        for folder, dirs, files in os.walk(path, followlinks=False):
            info = pathlib.Path(folder).lstat(); directories += info.st_blocks * 512
            for name in dirs + files:
                file = pathlib.Path(folder) / name; info = file.lstat()
                if stat.S_ISDIR(info.st_mode):
                    continue
                need(stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode), 'SPECIAL_FILE')
                key = (info.st_dev, info.st_ino)
                row = inodes.setdefault(key, {'links': info.st_nlink, 'selected': 0, 'blocks': info.st_blocks * 512})
                need(row['links'] == info.st_nlink and row['blocks'] == info.st_blocks * 512, 'INPUT_CHANGED')
                row['selected'] += 1
    return {'lastLinkAllocatedBytes': directories + sum(row['blocks'] for row in inodes.values() if row['selected'] == row['links']),
            'externallyLinkedInodes': sum(row['selected'] < row['links'] for row in inodes.values())}

def update(file, expected, event, now):
    file = pathlib.Path(file)
    lock = file.with_name(file.name + '.lock')
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    temporary = file.with_name(file.name + '.pending')
    try:
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'CATALOG_LOCK_UNSAFE')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        need(not file.is_symlink(), 'CATALOG_UNSAFE')
        raw = file.read_bytes(); need(sha(raw) == expected, 'CATALOG_CHANGED')
        result = transition(json.loads(raw), event, now)
        # This reserved, private metadata slot is reused under the crash-released
        # advisory lock; an interrupted write cannot leave an eternal O_EXCL lock.
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(fd, 'wb') as output:
            info = os.fstat(output.fileno())
            need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'CATALOG_PENDING_UNSAFE')
            output.truncate(0); output.write(encoded(result)); output.flush(); os.fsync(output.fileno())
        need(file.read_bytes() == raw, 'CATALOG_CHANGED')
        os.replace(temporary, file); sync_directory(file.parent)
        return result
    finally:
        os.close(descriptor)

def runtime_module():
    spec = importlib.util.spec_from_file_location('retirement_runtime_files', pathlib.Path(__file__).with_name('runtime-artifact.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    module.Refused = Refused
    return module

def sync_directory(file):
    descriptor = os.open(file, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def private_json(file, value):
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(encoded(value)); output.flush(); os.fsync(output.fileno())
    sync_directory(file.parent)

def trusted_intent(file):
    info = file.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 48*1024**2, 'INTENT_UNSAFE')
    return json.loads(file.read_bytes())

def unchanged_file(file, expected, runtime):
    info = file.lstat()
    need((info.st_dev, info.st_ino, info.st_uid) == (expected['device'], expected['inode'], expected['uid']), 'ARTIFACT_IDENTITY_CHANGED')
    if expected['type'] == 'directory':
        need(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) in (0o555, 0o700), 'ARTIFACT_IDENTITY_CHANGED')
    elif expected['type'] == 'symlink':
        need(stat.S_ISLNK(info.st_mode) and os.readlink(file) == expected['target'], 'ARTIFACT_IDENTITY_CHANGED')
    else:
        need(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o222 and info.st_size == expected['size'] and info.st_mtime_ns == expected['mtime'], 'ARTIFACT_IDENTITY_CHANGED')
        # Removing a different selected hard link legitimately changes ctime/nlink.
        # Content is rehashed instead of weakening the byte-identity check.
        need(runtime.digest(runtime.read_regular(file)[0]) == expected['sha256'], 'ARTIFACT_CONTENT_CHANGED')

def remaining_snapshot(folder, snapshot, runtime):
    info = folder.lstat()
    need(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino, info.st_uid) == (snapshot['device'], snapshot['inode'], snapshot['uid']), 'ARTIFACT_IDENTITY_CHANGED')
    expected = {row['path']: row for row in snapshot['files']}
    present = []
    for current, dirs, files in os.walk(folder, followlinks=False):
        for name in dirs + files:
            file = pathlib.Path(current)/name; key = file.relative_to(folder).as_posix()
            need(key in expected, 'ARTIFACT_EXTRA_PATH')
            unchanged_file(file, expected[key], runtime); present.append(expected[key])
    return present

def typed_plan(root, catalog, consumers, now, free_bytes, incoming_bytes, free_floor):
    root = pathlib.Path(root).resolve(strict=True); runtime = runtime_module()
    result = retirement_plan(catalog, consumers, now, free_bytes, incoming_bytes, free_floor)
    records = validate(catalog); targets = []
    trash = root/'.runtime-retired'
    if trash.exists() or trash.is_symlink():
        info = trash.lstat()
        need(stat.S_ISDIR(info.st_mode) and trash.resolve() == trash and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700 and info.st_dev == root.stat().st_dev, 'RETIREMENT_DIRECTORY_UNSAFE')
    for item in result['eligible']:
        row = records[item['id']]
        if row['kind'] not in ('runtime', 'recovery') or 'ownerUid' not in row:
            result['retained'].append({'id': row['id'], 'reasons': ['legacy-requires-private-reviewed-controller']}); continue
        if len(targets) >= 8:
            result['retained'].append({'id': row['id'], 'reasons': ['run-limit-next-pass']}); continue
        source = root/row['path']; quarantine = root/'.runtime-retired'/row['id']
        intent_path = quarantine.with_name(quarantine.name + '.json')
        if intent_path.exists() or intent_path.is_symlink():
            intent = trusted_intent(intent_path)
            need(intent['id'] == row['id'] and intent['path'] == row['path'] and intent['manifestSha256'] == row['manifestSha256'], 'INTENT_CHANGED')
            snapshot = intent['snapshot']
            need(not (source.exists() and quarantine.exists()), 'RETIREMENT_PATH_CONFLICT')
            if quarantine.exists():
                remaining_snapshot(quarantine, snapshot, runtime)
            elif source.exists():
                remaining_snapshot(source, snapshot, runtime)
        else:
            need(source.parent.resolve().is_relative_to(root), 'TARGET_UNSAFE')
            snapshot = runtime.verified_snapshot(source, row['manifestSha256'])
        need(snapshot['uid'] == row['ownerUid'] and snapshot['role'] == row.get('role'), 'ARTIFACT_OWNER_CHANGED')
        targets.append({**item, 'snapshot': snapshot})
    result['targets'] = targets; result['eligible'] = [{key: row[key] for key in ('id','path','manifestSha256')} for row in targets]
    result['executor'] = 'typed-artifacts-only'
    need(sum(len(target['snapshot']['files']) for target in targets) <= 150000 and len(encoded(result)) <= 48*1024**2, 'RETIREMENT_RUN_LIMIT')
    return result

def apply_typed(root, catalog_file, consumers_file, plan, now, checkpoint=None, lock_fd=None, *, clock_ms=None):
    """Root-only lifecycle caller must serialize service/pin changes with this same lock.

    Fresh collectors remain operator-specific; incomplete/stale projections retain data.
    Only typed immutable artifacts are unlinked. No wildcard/age-only/legacy adoption.
    """
    root = pathlib.Path(root).resolve(strict=True); runtime = runtime_module()
    # Caller-provided --now is a planner input, never execution freshness evidence.
    # Clock injection is a library-only isolated-fixture hook, not a CLI option.
    wall_clock = clock_ms or (lambda: int(time.time()*1000))
    started = time.monotonic(); started_wall = wall_clock()
    def actual_now():
        value = wall_clock()
        need(type(value) is int and value >= 0, 'CLOCK_INVALID')
        return max(value, started_wall + int((time.monotonic()-started)*1000))
    def fresh_now(consumers=None):
        current = actual_now()
        need(plan.get('executor') == 'typed-artifacts-only' and type(plan.get('observedAt')) is int and
             0 <= current-plan['observedAt'] <= 60000, 'PLAN_STALE')
        if consumers is not None:
            need(consumers.get('complete') is True and type(consumers.get('observedAt')) is int and
                 0 <= current-consumers['observedAt'] <= 60000, 'CONSUMERS_STALE')
        return current
    fresh_now()
    lock_path = root/'.runtime-lifecycle.lock'
    descriptor = os.dup(lock_fd) if lock_fd is not None else os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    lock_info = os.fstat(descriptor)
    need((lock_info.st_dev, lock_info.st_ino) == (lock_path.stat().st_dev, lock_path.stat().st_ino) and stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1 and lock_info.st_uid == os.getuid() and stat.S_IMODE(lock_info.st_mode) == 0o600, 'LIFECYCLE_LOCK_UNSAFE')
    trash = root/'.runtime-retired'
    deadline = time.monotonic()+120
    deleted = []
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        catalog_raw = pathlib.Path(catalog_file).read_bytes(); consumer_raw = pathlib.Path(consumers_file).read_bytes()
        catalog = json.loads(catalog_raw); consumers = json.loads(consumer_raw)
        need(sha(encoded(catalog)) == plan['catalogSha256'] and sha(encoded(consumers)) == plan['consumerSha256'], 'PLAN_CHANGED')
        fresh = typed_plan(root, catalog, consumers, fresh_now(consumers), plan['peakGate']['freeBytes'], plan['peakGate']['incomingBytes'], plan['peakGate']['freeFloor'])
        need(fresh['targets'] == plan['targets'], 'PLAN_CHANGED')
        trash.mkdir(mode=0o700, exist_ok=True)
        info = trash.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700 and info.st_dev == root.stat().st_dev, 'RETIREMENT_DIRECTORY_UNSAFE')
        for target in plan['targets']:
            fresh_now(consumers)
            need(time.monotonic() < deadline, 'DEADLINE')
            # Protect against catalog/probe drift before each claim, not just before the batch.
            need(pathlib.Path(catalog_file).read_bytes() == catalog_raw and pathlib.Path(consumers_file).read_bytes() == consumer_raw, 'PLAN_CHANGED')
            source, pending = root/target['path'], trash/target['id']
            journal = trash/(target['id']+'.json')
            if not journal.exists():
                private_json(journal, target)
            else:
                recorded = trusted_intent(journal)
                need(recorded == target or recorded == {**target, 'completed': True}, 'INTENT_CHANGED')
            if source.exists():
                need(not pending.exists(), 'RETIREMENT_PATH_CONFLICT')
                remaining_snapshot(source, target['snapshot'], runtime)
                fresh_now(consumers)
                source.chmod(0o700)  # Required for moving immutable directories on BSD/macOS.
                os.rename(source, pending); sync_directory(source.parent); sync_directory(trash)
                if checkpoint:
                    checkpoint('claimed')
            if pending.exists():
                present = remaining_snapshot(pending, target['snapshot'], runtime)
                for item in present:
                    if item['type'] == 'directory':
                        (pending/item['path']).chmod(0o700)
                pending.chmod(0o700)
                for item in present:
                    if item['type'] != 'directory':
                        need(time.monotonic() < deadline, 'DEADLINE')
                        file = pending/item['path']; unchanged_file(file, item, runtime); file.unlink()
                        if checkpoint:
                            checkpoint('unlinked')
                for item in sorted((row for row in present if row['type']=='directory'), key=lambda row: row['path'].count('/'), reverse=True):
                    (pending/item['path']).rmdir()
                pending.rmdir(); sync_directory(trash)
            # Keep durable evidence through the catalog CAS; a crash in either
            # order can resume without guessing that an absent tree was deleted.
            completion = journal.with_name(journal.name+'.pending')
            if completion.exists() or completion.is_symlink():
                info = completion.lstat()
                need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'COMPLETION_PENDING_UNSAFE')
                completion.unlink()
            private_json(completion, {**target, 'completed': True})
            os.replace(completion, journal); sync_directory(trash)
            catalog = update(catalog_file, sha(catalog_raw), {'operation': 'ack-retired', 'ids': [target['id']], 'deletionReceiptVerified': True}, actual_now())
            catalog_raw = pathlib.Path(catalog_file).read_bytes()
            if checkpoint:
                checkpoint('catalog-committed')
            journal.unlink(); sync_directory(trash); deleted.append(target['id'])
        # An interruption after catalog commit may leave only its completed receipt.
        known = set(validate(catalog))
        for journal in trash.glob('*.json'):
            record = trusted_intent(journal)
            if record.get('completed') is True and record.get('id') not in known and not (trash/identifier(record['id'])).exists():
                journal.unlink(); sync_directory(trash)
        return {'status': 'RETIRED', 'ids': deleted, 'catalogSha256': sha(encoded(catalog)), 'consumerSha256': plan['consumerSha256'], 'credentialValuesPrinted': False}
    finally:
        os.close(descriptor)

def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan'); plan.add_argument('--catalog', required=True); plan.add_argument('--consumers', required=True); plan.add_argument('--now', type=int, required=True); plan.add_argument('--free-bytes', type=int, required=True); plan.add_argument('--incoming-bytes', type=int, required=True); plan.add_argument('--free-floor', type=int, required=True)
    typed = commands.add_parser('typed-plan'); typed.add_argument('--root', required=True); typed.add_argument('--catalog', required=True); typed.add_argument('--consumers', required=True); typed.add_argument('--now', type=int, required=True); typed.add_argument('--free-bytes', type=int, required=True); typed.add_argument('--incoming-bytes', type=int, required=True); typed.add_argument('--free-floor', type=int, required=True)
    apply = commands.add_parser('apply'); apply.add_argument('--root', required=True); apply.add_argument('--catalog', required=True); apply.add_argument('--consumers', required=True); apply.add_argument('--plan', required=True); apply.add_argument('--plan-sha', required=True); apply.add_argument('--now', type=int, required=True); apply.add_argument('--execute', action='store_true'); apply.add_argument('--lifecycle-lock-fd', type=int)
    change = commands.add_parser('update'); change.add_argument('--catalog', required=True); change.add_argument('--expected-sha', required=True); change.add_argument('--event', required=True); change.add_argument('--now', type=int, required=True)
    args = parser.parse_args()
    if args.command == 'apply':
        raw = pathlib.Path(args.plan).read_bytes(); need(sha(raw) == args.plan_sha, 'PLAN_HASH')
        need(args.execute, 'EXECUTE_REQUIRED')
        result = apply_typed(args.root, args.catalog, args.consumers, json.loads(raw), args.now, lock_fd=args.lifecycle_lock_fd)
    elif args.command == 'typed-plan':
        result = typed_plan(args.root, json.loads(pathlib.Path(args.catalog).read_bytes()), json.loads(pathlib.Path(args.consumers).read_bytes()), args.now, args.free_bytes, args.incoming_bytes, args.free_floor)
    elif args.command == 'plan':
        result = retirement_plan(json.loads(pathlib.Path(args.catalog).read_bytes()), json.loads(pathlib.Path(args.consumers).read_bytes()), args.now, args.free_bytes, args.incoming_bytes, args.free_floor)
    else:
        catalog = update(args.catalog, args.expected_sha, json.loads(pathlib.Path(args.event).read_bytes()), args.now)
        result = {'status': 'CATALOG_UPDATED', 'generation': catalog['generation'], 'sha256': sha(encoded(catalog)), 'credentialValuesPrinted': False}
    print(json.dumps(result, sort_keys=True))

if __name__ == '__main__':
    try:
        def expired(*_):
            raise Refused('DEADLINE')
        signal.signal(signal.SIGALRM, expired); signal.alarm(120)
        main()
    except Exception as error:
        print(json.dumps({'status': 'REFUSED', 'category': str(error) if isinstance(error, Refused) else type(error).__name__, 'credentialValuesPrinted': False})); sys.exit(1)
