#!/usr/bin/env python3
"""Select, hash and package existing runtime bytes. No install, build or activation."""
import argparse
import fcntl
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import sys
import tarfile
import tempfile
import time

MAX_FILES = 150000
MAX_BYTES = 8 * 1024**3
MAX_FILE = 256 * 1024**2
MAX_MANIFEST = 48 * 1024**2
ROLES = {
    'backend': ('services/backend-production', 'dist/main.js'),
    'worker': ('services/backend-production', 'dist/worker-main.js'),
    'issuer': ('services/agent-authorization', 'dist/main.js'),
}

class Refused(Exception):
    pass

def need(value, category):
    if not value:
        raise Refused(category)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def relative_name(value):
    need(isinstance(value, str) and value and '\\' not in value and '\x00' not in value, 'PATH_INVALID')
    p = pathlib.PurePosixPath(value)
    need(not p.is_absolute() and '..' not in p.parts and str(p) == value and value != '.', 'PATH_INVALID')
    return value

def runtime_name(name):
    parts = pathlib.PurePosixPath(relative_name(name)).parts
    need(not any(p in ('.git', '.turbo', '.cache', '.aws', '.ssh', '.pgpass', '.npmrc') or
                 p == '.env' or p.startswith('.env.') or p.endswith('.env') or
                 p.endswith(('.key', '.p12', '.pfx')) for p in parts), 'NON_RUNTIME_PATH')
    need(not any(parts[i:i+2] in (('.next', 'cache'), ('.next', 'standalone')) for i in range(len(parts)-1)), 'NON_RUNTIME_PATH')
    return name

def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)

def read_regular(file, limit=MAX_FILE):
    before = file.lstat()
    need(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o022 and before.st_size <= limit, 'INPUT_FILE_UNSAFE')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        need(identity(before) == identity(os.fstat(fd)), 'INPUT_CHANGED')
        chunks = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        need(identity(before) == identity(os.fstat(fd)), 'INPUT_CHANGED')
        raw = b''.join(chunks)
        need(len(raw) == before.st_size, 'INPUT_CHANGED')
        return raw, before
    finally:
        os.close(fd)

def read_json(file):
    try:
        return json.loads(read_regular(file, MAX_MANIFEST)[0])
    except (ValueError, UnicodeError):
        raise Refused('JSON_INVALID') from None

def sync_directory(file):
    descriptor = os.open(file, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def launcher(role):
    if role == 'admin':
        return b'''// Generated framework bootstrap; application bytes are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname,'.next/required-server-files.json'),'utf8')).config;
config.distDir = './.next';
process.env.NODE_ENV = 'production';
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
process.chdir(__dirname);
require('next');
require('next/dist/server/lib/start-server').startServer({dir:__dirname,isDev:false,config,hostname:'127.0.0.1',port:3002,allowRetry:false}).catch(()=>{process.stderr.write('Runtime startup refused\\n');process.exitCode=1;});
'''
    return b'''// Generated config bootstrap; preserve the current custom HTTP server.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('.',import.meta.url));
const config=JSON.parse(fs.readFileSync(new URL('.next/required-server-files.json',import.meta.url),'utf8')).config;
config.distDir='./.next';
process.env.NODE_ENV='production';
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG=JSON.stringify(config);
process.chdir(dir);
const {startProductionWeb}=await import('./scripts/start-production.mts');
startProductionWeb(['--hostname','127.0.0.1','--port','3000']).catch(()=>{process.stderr.write('Runtime startup refused\\n');process.exitCode=1;});
'''

class RuntimeFiles:
    def __init__(self, root, seconds=120):
        self.root = pathlib.Path(root).resolve(strict=True)
        need(self.root.is_dir(), 'INPUT_ROOT')
        self.rows, self.packages, self.workspaces = {}, set(), {}
        self.link_epochs = {}
        self.deadline = time.monotonic() + seconds
        self.bytes = 0
        for family in ('apps', 'services', 'packages'):
            directory = self.root / family
            if directory.is_dir():
                for child in sorted(directory.iterdir()):
                    child = self.normalize(child)
                    if (child / 'package.json').is_file():
                        value = read_json(child / 'package.json')
                        need(isinstance(value.get('name'), str), 'PACKAGE_NAME')
                        need(value['name'] not in self.workspaces, 'DUPLICATE_WORKSPACE')
                        self.workspaces[value['name']] = child
    def active(self):
        need(time.monotonic() < self.deadline, 'DEADLINE')
        need(len(self.rows) <= MAX_FILES and self.bytes <= MAX_BYTES, 'INPUT_LIMIT')
    def relative(self, file):
        need(file.is_relative_to(self.root), 'PATH_ESCAPES_ROOT')
        return file.relative_to(self.root).as_posix()
    def normalize(self, file):
        self.active()
        file = pathlib.Path(os.path.normpath(file))
        relative = self.relative(file)
        runtime_name(relative)
        current = self.root
        for part in pathlib.PurePosixPath(relative).parts:
            current /= part
            if current.is_symlink():
                before = current.lstat(); link = os.readlink(current); key = self.relative(current)
                epoch = (identity(before), link)
                need(key not in self.link_epochs or self.link_epochs[key] == epoch, 'INPUT_LINK_CHANGED')
                self.link_epochs.setdefault(key, epoch)
                try:
                    target = current.resolve(strict=True)
                except (RuntimeError, FileNotFoundError):
                    raise Refused('SYMLINK_INVALID') from None
                need(identity(current.lstat()) == identity(before) and os.readlink(current) == link, 'INPUT_LINK_CHANGED')
                target_name = self.relative(target)
                runtime_name(target_name)
                row = {'path': key, 'type': 'symlink', 'target': os.path.relpath(target, current.parent)}
                need(key not in self.rows or self.rows[key] == row, 'INPUT_LINK_CHANGED')
                self.rows[key] = row
                current = target
        return current
    def verify_links(self):
        for name, (before, link) in self.link_epochs.items():
            file = self.root/name
            need(identity(file.lstat()) == before and os.readlink(file) == link, 'INPUT_LINK_CHANGED')
            need(os.path.relpath(file.resolve(strict=True), file.parent) == self.rows[name]['target'], 'INPUT_LINK_CHANGED')
    def add(self, file):
        file = self.normalize(file)
        name = self.relative(file)
        if name in self.rows:
            return
        try:
            info = file.lstat()
        except FileNotFoundError:
            raise Refused('REQUIRED_FILE_MISSING') from None
        need(not info.st_mode & 0o022, 'WRITABLE_SOURCE')
        if stat.S_ISDIR(info.st_mode):
            self.rows[name] = {'path': name, 'type': 'directory'}
            for child in sorted(file.iterdir()):
                self.add(child)
        else:
            need(stat.S_ISREG(info.st_mode), 'SPECIAL_FILE')
            raw, info = read_regular(file)
            self.bytes += len(raw)
            self.rows[name] = {'path': name, 'type': 'file', 'bytes': len(raw), 'sha256': digest(raw), 'mode': stat.S_IMODE(info.st_mode) & 0o555}
        self.active()
    def resolve_package(self, name, from_dir):
        need(isinstance(name, str) and re.fullmatch(r'(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+', name), 'PACKAGE_NAME')
        for directory in (from_dir, *from_dir.parents):
            if not directory.is_relative_to(self.root):
                break
            link = directory / 'node_modules' / name
            if link.exists() or link.is_symlink():
                resolved = self.normalize(link)
                need(resolved.is_dir(), 'PACKAGE_DIRECTORY')
                return resolved
        raise Refused('MISSING_RUNTIME_DEPENDENCY')
    def package(self, name, from_dir, optional=False):
        try:
            directory = self.workspaces[name] if self.workspaces.get(name) == from_dir else self.resolve_package(name, from_dir)
        except Refused as error:
            if optional and str(error) == 'MISSING_RUNTIME_DEPENDENCY':
                return
            raise
        key = self.relative(directory)
        if key in self.packages:
            return
        self.packages.add(key)
        value = read_json(directory / 'package.json')
        need(value.get('name') == name, 'PACKAGE_NAME_MISMATCH')
        if directory in self.workspaces.values():
            need((directory / 'dist').is_dir(), 'WORKSPACE_DIST_MISSING')
            self.add(directory / 'package.json')
            self.add(directory / 'dist')
        else:
            self.add(directory)
        for dep in sorted(value.get('dependencies', {})):
            self.package(dep, directory)
        for dep in sorted(value.get('optionalDependencies', {})):
            self.package(dep, directory, optional=True)
        for dep in sorted(value.get('peerDependencies', {})):
            if not value.get('peerDependenciesMeta', {}).get(dep, {}).get('optional'):
                self.package(dep, directory)
    def next_traces(self, role):
        app = self.root / 'apps' / role
        nxt = app / '.next'
        required = read_json(nxt / 'required-server-files.json')
        need(isinstance(required.get('config'), dict) and isinstance(required.get('files'), list), 'NEXT_REQUIRED_FILES')
        need((nxt / 'next-server.js.nft.json').is_file(), 'NEXT_SERVER_TRACE_MISSING')
        self.add(app / 'package.json')
        traces = sorted(nxt.rglob('*.nft.json'))
        for trace in traces:
            if any(part in ('cache', 'standalone') for part in trace.relative_to(nxt).parts):
                continue
            value = read_json(trace)
            need(value.get('version') == 1 and isinstance(value.get('files'), list), 'NFT_FILES')
            for name in value['files']:
                need(isinstance(name, str) and not pathlib.PurePosixPath(name).is_absolute() and '\\' not in name, 'NFT_PATH')
                self.add(trace.parent / name)
            self.add(trace)
        for name in required['files']:
            relative_name(name)
            self.add(app / name)
        for name in ('server', 'static'):
            need((nxt / name).is_dir(), 'NEXT_COMPONENT_MISSING')
            self.add(nxt / name)
        self.add(nxt / 'required-server-files.json')
        for name in ('BUILD_ID', 'build-manifest.json', 'app-build-manifest.json', 'prerender-manifest.json', 'routes-manifest.json', 'react-loadable-manifest.json'):
            if (nxt / name).is_file():
                self.add(nxt / name)
        need((nxt / 'BUILD_ID').is_file(), 'NEXT_BUILD_ID_MISSING')
        if (app / 'public').is_dir():
            self.add(app / 'public')
        # Trace the extra bootstrap's explicit imports as well as the Next build traces.
        next_dir = self.resolve_package('next', app)
        self.add(next_dir / 'package.json')
        self.add(next_dir / 'dist/server/next.js')
        if role == 'admin':
            self.add(next_dir / 'dist/server/lib/start-server.js')
        if role == 'web':
            self.add(app / 'scripts/start-production.mts')
            self.add(app / 'scripts/production-http-server.mts')
        for name in required['config'].get('serverExternalPackages', []):
            directory = self.resolve_package(name, app)
            self.add(directory / 'package.json')
            # Dynamic native files must already be in the build's explicit nft includes.
            value = read_json(directory / 'package.json')
            main = value.get('main', 'index.js')
            relative_name(main.removeprefix('./'))
            self.add(directory / main)
        entry = f'apps/{role}/runtime-server.' + ('cjs' if role == 'admin' else 'mjs')
        need(not (self.root / entry).exists(), 'GENERATED_FILE_COLLISION')
        content = launcher(role)
        self.rows[f'apps/{role}/.next/cache'] = {'path': f'apps/{role}/.next/cache', 'type': 'mount', 'mode': 0o555}
        self.rows[entry] = {'path': entry, 'type': 'generated', 'generator': role, 'bytes': len(content), 'sha256': digest(content), 'mode': 0o444}
        self.bytes += len(content)
        return entry
    def result(self, role, source):
        need(isinstance(source, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,127}', source), 'SOURCE_ID')
        if role in ROLES:
            project, start = ROLES[role]
            directory = self.root / project
            value = read_json(directory / 'package.json')
            self.package(value['name'], directory)
            entry = project + '/' + start
            self.add(self.root / entry)
        else:
            entry = self.next_traces(role)
        self.verify_links()
        files = sorted(self.rows.values(), key=lambda value: value['path'])
        return {'schema': 1, 'role': role, 'source': source, 'status': 'RUNTIME_FILE_PLAN', 'entry': entry, 'files': files, 'fileCount': sum(row['type'] in ('file', 'generated') for row in files), 'bytes': self.bytes, 'packages': sorted(self.packages), 'credentialValuesPrinted': False}

def validate_manifest(value):
    need(isinstance(value, dict) and set(value) == {'schema','role','source','status','entry','files','fileCount','bytes','packages','credentialValuesPrinted'}, 'MANIFEST_INVALID')
    need(isinstance(value, dict) and value.get('schema') == 1 and value.get('role') in (*ROLES, 'admin', 'web') and value.get('status') == 'RUNTIME_FILE_PLAN', 'MANIFEST_INVALID')
    need(isinstance(value.get('files'), list) and len(value['files']) <= MAX_FILES, 'MANIFEST_INVALID')
    need(value.get('credentialValuesPrinted') is False and isinstance(value.get('packages'), list), 'MANIFEST_INVALID')
    expected_entry = ROLES[value['role']][0]+'/'+ROLES[value['role']][1] if value['role'] in ROLES else f"apps/{value['role']}/runtime-server."+('cjs' if value['role']=='admin' else 'mjs')
    need(value.get('entry') == expected_entry, 'ENTRY_INVALID')
    rows = {}
    total = 0
    for row in value['files']:
        name = relative_name(row['path'])
        if row.get('type') == 'mount':
            need(value['role'] in ('admin','web') and name == f"apps/{value['role']}/.next/cache" and row.get('mode') == 0o555, 'MOUNT_STUB_INVALID')
        else:
            runtime_name(name)
        need(name not in ('runtime-manifest.json', 'runtime-installation.json', 'runtime-extraction.json'), 'MANIFEST_RESERVED_PATH')
        need(name not in rows and row.get('type') in ('file', 'generated', 'directory', 'symlink', 'mount'), 'MANIFEST_INVALID')
        if row['type'] in ('file', 'generated'):
            need(isinstance(row.get('bytes'), int) and 0 <= row['bytes'] <= MAX_FILE and re.fullmatch('[a-f0-9]{64}', row.get('sha256', '')), 'MANIFEST_INVALID')
            need(isinstance(row.get('mode'), int) and not row['mode'] & ~0o755 and not row['mode'] & 0o022, 'MANIFEST_MODE')
            total += row['bytes']
            if row['type'] == 'generated':
                need(row.get('generator') == value['role'] and name == value['entry'] and value['role'] in ('admin','web'), 'GENERATOR_INVALID')
        elif row['type'] == 'symlink':
            target = row.get('target')
            need(isinstance(target, str) and not os.path.isabs(target) and '\\' not in target, 'SYMLINK_INVALID')
            resolved = os.path.normpath(str(pathlib.PurePosixPath(name).parent / target))
            runtime_name(resolved)
        rows[name] = row
    need(value.get('fileCount') == sum(row['type'] in ('file','generated') for row in rows.values()), 'MANIFEST_INVALID')
    need(total == value.get('bytes') and total <= MAX_BYTES and value.get('entry') in rows, 'MANIFEST_INVALID')
    # No archive member may be nested under a symlink or a regular file.
    for name in rows:
        for ancestor in pathlib.PurePosixPath(name).parents:
            if str(ancestor) in rows:
                need(rows[str(ancestor)]['type'] == 'directory', 'MANIFEST_PARENT')
    return rows

def load_manifest(file, expected):
    raw, _ = read_regular(pathlib.Path(file), MAX_MANIFEST)
    need(digest(raw) == expected, 'MANIFEST_HASH')
    value = json.loads(raw)
    validate_manifest(value)
    return value, raw

def pack(root, manifest, raw_manifest, destination):
    root = pathlib.Path(root).resolve(strict=True)
    destination = pathlib.Path(destination)
    need(not destination.exists() and not destination.is_symlink(), 'DESTINATION_EXISTS')
    rows = validate_manifest(manifest)
    need(not destination.absolute().is_relative_to(root), 'OUTPUT_INSIDE_INPUT')
    planner = RuntimeFiles(root)
    need(planner.result(manifest['role'], manifest['source']) == manifest, 'INPUT_CHANGED')
    fd, temporary = tempfile.mkstemp(prefix='.runtime-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as output, tarfile.open(fileobj=output, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
            header = tarfile.TarInfo('runtime-manifest.json'); header.size = len(raw_manifest); header.mode = 0o444
            archive.addfile(header, io.BytesIO(raw_manifest))
            for name, row in sorted(rows.items()):
                planner.active()
                member = tarfile.TarInfo(name); member.mode = 0o555 if row['type'] == 'directory' else row.get('mode', 0o777)
                if row['type'] == 'mount':
                    member.type = tarfile.DIRTYPE; archive.addfile(member)
                elif row['type'] == 'directory':
                    need(planner.normalize(root / name).is_dir(), 'INPUT_CHANGED')
                    member.type = tarfile.DIRTYPE; archive.addfile(member)
                elif row['type'] == 'symlink':
                    source = root / name
                    need(source.is_symlink(), 'INPUT_CHANGED')
                    planner.normalize(source)
                    need(planner.rows[name]['target'] == row['target'], 'INPUT_CHANGED')
                    member.type = tarfile.SYMTYPE; member.linkname = row['target']; archive.addfile(member)
                else:
                    content = launcher(row['generator']) if row['type'] == 'generated' else read_regular(planner.normalize(root / name))[0]
                    need(len(content) == row['bytes'] and digest(content) == row['sha256'], 'INPUT_CHANGED')
                    member.size = len(content); archive.addfile(member, io.BytesIO(content))
        planner.verify_links()
        with open(temporary, 'rb') as output:
            os.fsync(output.fileno())
        # Hard-link publication is exclusive; an existing output is never replaced.
        os.link(temporary, destination)
        return {'status': 'PACKED', 'bytes': destination.stat().st_size, 'credentialValuesPrinted': False}
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)

def extract(archive_path, destination, manifest_hash, free_floor=0, progress=None):
    destination = pathlib.Path(destination).absolute()
    need(not destination.exists() and not destination.is_symlink(), 'DESTINATION_EXISTS')
    need(destination.parent.is_dir() and destination.parent.resolve() == destination.parent, 'DESTINATION_PARENT')
    lock = destination.parent/'.runtime-extract.lock'
    lock_fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    lock_info = os.fstat(lock_fd)
    need(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.getuid() and lock_info.st_nlink == 1 and stat.S_IMODE(lock_info.st_mode) == 0o600, 'EXTRACT_LOCK_UNSAFE')
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.runtime-', dir=destination.parent))
    sync_directory(destination.parent)
    deadline = time.monotonic() + 120
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            first = archive.next()
            need(first is not None and first.name == 'runtime-manifest.json' and first.isfile() and first.size <= MAX_MANIFEST, 'ARCHIVE_MANIFEST')
            raw = archive.extractfile(first).read()
            need(digest(raw) == manifest_hash, 'MANIFEST_HASH')
            value = json.loads(raw); rows = validate_manifest(value)
            need(isinstance(free_floor, int) and free_floor >= 0, 'SPACE_INPUT')
            required_space = value['bytes'] + len(rows)*8192 + free_floor
            need(shutil.disk_usage(destination.parent).free >= required_space, 'PEAK_SPACE_REFUSED')
            metadata = temporary / 'runtime-manifest.json'
            with open(metadata, 'xb') as output:
                output.write(raw); output.flush(); os.fsync(output.fileno())
            metadata.chmod(0o444)
            info = temporary.stat()
            intent = {'schema': 1, 'kind': 'runtime-extraction', 'manifestSha256': manifest_hash, 'role': value['role'], 'destination': destination.name, 'pending': temporary.name, 'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid}
            with open(temporary/'runtime-extraction.json', 'xb') as output:
                output.write(encoded(intent)); output.flush(); os.fsync(output.fileno())
            sync_directory(temporary)
            if progress:
                progress({'status': 'EXTRACTION_PREPARED', **intent, 'credentialValuesPrinted': False})
            seen, links = set(), []
            for member in iter(archive.next, None):
                need(time.monotonic() < deadline, 'DEADLINE')
                name = relative_name(member.name)
                need(name in rows and name not in seen and set(member.pax_headers) <= {'path', 'linkpath'}, 'ARCHIVE_MEMBER')
                seen.add(name); row = rows[name]; target = temporary / name
                target.parent.mkdir(parents=True, exist_ok=True)
                if row['type'] in ('directory', 'mount'):
                    need(member.isdir(), 'ARCHIVE_TYPE'); target.mkdir(exist_ok=True)
                elif row['type'] == 'symlink':
                    need(member.issym() and member.linkname == row['target'], 'ARCHIVE_TYPE'); links.append((target, row['target']))
                else:
                    need(member.isfile() and member.size == row['bytes'], 'ARCHIVE_TYPE')
                    content = archive.extractfile(member).read()
                    need(digest(content) == row['sha256'], 'ARCHIVE_HASH')
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, row['mode'] & 0o555)
                    with os.fdopen(fd, 'wb') as output:
                        output.write(content); output.flush(); os.fsync(output.fileno())
            need(seen == set(rows), 'ARCHIVE_INCOMPLETE')
            # Symlinks are materialized only after all writes; no extraction can traverse one.
            for target, link in links:
                target.symlink_to(link)
            for target, _ in links:
                need(target.resolve(strict=True).is_relative_to(temporary), 'SYMLINK_INVALID')
            (temporary/'runtime-extraction.json').unlink()
            root_info = temporary.stat()
            mounts = {}
            for name, row in rows.items():
                if row['type'] == 'mount':
                    info = (temporary/name).stat()
                    need(not list((temporary/name).iterdir()), 'MOUNT_STUB_NOT_EMPTY')
                    mounts[name] = {'device': info.st_dev, 'inode': info.st_ino}
            installation = encoded({'schema': 1, 'manifestSha256': manifest_hash, 'device': root_info.st_dev, 'inode': root_info.st_ino, 'uid': root_info.st_uid, 'mounts': mounts})
            with open(temporary/'runtime-installation.json', 'xb') as output:
                output.write(installation); output.flush(); os.fsync(output.fileno())
            (temporary/'runtime-installation.json').chmod(0o444)
            for folder, dirs, _ in os.walk(temporary, topdown=False, followlinks=False):
                os.chmod(folder, 0o555); sync_directory(folder)
            need(not destination.exists() and not destination.is_symlink(), 'DESTINATION_EXISTS')
            os.rename(temporary, destination); sync_directory(destination.parent)
        info = destination.stat()
        return {'status': 'EXTRACTED', 'files': value['fileCount'], 'manifestSha256': manifest_hash, 'role': value['role'], 'ownerUid': info.st_uid, 'device': info.st_dev, 'inode': info.st_ino, 'credentialValuesPrinted': False}
    finally:
        if temporary.exists():
            for folder, _, _ in os.walk(temporary, followlinks=False):
                os.chmod(folder, 0o700)
            shutil.rmtree(temporary)
        os.close(lock_fd)

def verified_snapshot(root, expected_hash):
    """Only a newly extracted, exact immutable artifact is eligible for typed retirement."""
    root = pathlib.Path(root)
    need(root.is_dir() and not root.is_symlink() and root.resolve() == root, 'ARTIFACT_ROOT_UNSAFE')
    value, _ = load_manifest(root / 'runtime-manifest.json', expected_hash)
    rows = validate_manifest(value)
    installation = read_json(root/'runtime-installation.json')
    root_info = root.stat()
    need(stat.S_IMODE(root_info.st_mode) == 0o555, 'ARTIFACT_ROOT_WRITABLE')
    need(installation.get('schema') == 1 and installation.get('manifestSha256') == expected_hash and (installation.get('device'), installation.get('inode'), installation.get('uid')) == (root_info.st_dev, root_info.st_ino, root_info.st_uid), 'INSTALLATION_IDENTITY_CHANGED')
    mounts = {name for name, row in rows.items() if row['type'] == 'mount'}
    need(set(installation.get('mounts', {})) == mounts, 'MOUNT_STUB_INVALID')
    for name in mounts:
        file = root/name; info = file.lstat(); original = installation['mounts'][name]
        need(stat.S_ISDIR(info.st_mode) and not file.is_symlink() and (info.st_dev, info.st_ino) == (original['device'], original['inode']) and not list(file.iterdir()), 'MOUNT_STUB_CHANGED')
    allowed_dirs = set()
    for name in rows:
        allowed_dirs.update(str(parent) for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.')
        if rows[name]['type'] in ('directory', 'mount'):
            allowed_dirs.add(name)
    snapshots = []
    root_info = root.stat()
    for folder, dirs, files in os.walk(root, followlinks=False):
        folder_path = pathlib.Path(folder)
        for name in dirs + files:
            file = folder_path / name; key = file.relative_to(root).as_posix(); info = file.lstat()
            need(info.st_uid == root_info.st_uid, 'ARTIFACT_OWNER_CHANGED')
            if stat.S_ISDIR(info.st_mode):
                need(key in allowed_dirs and not info.st_mode & 0o222, 'ARTIFACT_EXTRA_PATH')
                kind = 'directory'
            elif stat.S_ISLNK(info.st_mode):
                need(key in rows and rows[key]['type'] == 'symlink' and os.readlink(file) == rows[key]['target'], 'ARTIFACT_LINK_CHANGED')
                need(file.resolve(strict=True).is_relative_to(root), 'SYMLINK_INVALID')
                kind = 'symlink'
            else:
                need(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o222, 'ARTIFACT_FILE_UNSAFE')
                raw, _ = read_regular(file)
                if key == 'runtime-manifest.json':
                    need(digest(raw) == expected_hash, 'MANIFEST_HASH')
                elif key == 'runtime-installation.json':
                    need(json.loads(raw) == installation, 'INSTALLATION_IDENTITY_CHANGED')
                else:
                    need(key in rows and rows[key]['type'] in ('file', 'generated') and digest(raw) == rows[key]['sha256'], 'ARTIFACT_CONTENT_CHANGED')
                kind = 'file'
            snapshots.append({'path': key, 'type': kind, 'sha256': digest(raw) if kind == 'file' else None, 'target': os.readlink(file) if kind == 'symlink' else None, 'device': info.st_dev, 'inode': info.st_ino, 'size': info.st_size, 'mtime': info.st_mtime_ns, 'ctime': info.st_ctime_ns, 'mode': info.st_mode, 'links': info.st_nlink, 'uid': info.st_uid})
    present = {row['path'] for row in snapshots}
    need(set(rows) <= present, 'ARTIFACT_INCOMPLETE')
    return {'role': value['role'], 'device': root_info.st_dev, 'inode': root_info.st_ino, 'uid': root_info.st_uid, 'files': sorted(snapshots, key=lambda row: row['path'])}

def main():
    arguments = sys.argv[1:]
    if not arguments or arguments[0] not in ('plan', 'pack', 'extract'):
        arguments.insert(0, 'plan')
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan'); plan.add_argument('--input', required=True); plan.add_argument('--role', choices=[*ROLES, 'admin', 'web'], required=True); plan.add_argument('--source', required=True)
    build = commands.add_parser('pack'); build.add_argument('--input', required=True); build.add_argument('--manifest', required=True); build.add_argument('--manifest-sha', required=True); build.add_argument('--output', required=True)
    unpack = commands.add_parser('extract'); unpack.add_argument('--archive', required=True); unpack.add_argument('--destination', required=True); unpack.add_argument('--manifest-sha', required=True); unpack.add_argument('--free-floor', type=int, required=True)
    args = parser.parse_args(arguments)
    if args.command == 'plan':
        result = RuntimeFiles(args.input).result(args.role, args.source)
    elif args.command == 'pack':
        value, raw = load_manifest(args.manifest, args.manifest_sha)
        result = pack(args.input, value, raw, args.output)
    else:
        result = extract(args.archive, args.destination, args.manifest_sha, args.free_floor, lambda value: print(json.dumps(value, sort_keys=True), flush=True))
    print(json.dumps(result, sort_keys=True))

if __name__ == '__main__':
    try:
        def expired(*_):
            raise Refused('DEADLINE')
        signal.signal(signal.SIGALRM, expired); signal.alarm(120)
        main()
    except Exception as error:
        print(json.dumps({'status': 'REFUSED', 'category': str(error) if isinstance(error, Refused) else type(error).__name__, 'credentialValuesPrinted': False}))
        sys.exit(1)
