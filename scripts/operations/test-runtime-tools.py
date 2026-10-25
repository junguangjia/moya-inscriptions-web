"""Synthetic filesystem/archive/catalog regression; no network or production inputs."""
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

BASE = pathlib.Path(__file__).resolve().parent

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, BASE / file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

runtime = module('runtime_artifact', 'runtime-artifact.py')
retention = module('runtime_retention', 'runtime-retention.py')

def put(root, name, content):
    file = root / name; file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(content.encode() if isinstance(content, str) else content); file.chmod(0o644)
    return file

def json_file(root, name, value):
    return put(root, name, json.dumps(value))

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runtime-artifact-synthetic-')
        self.root = pathlib.Path(self.temp.name).resolve() / 'input'; self.root.mkdir()
        self.app = 'services/backend-production'
        json_file(self.root, self.app + '/package.json', {'name': '@fixture/backend', 'dependencies': {'prod': '1'}, 'devDependencies': {'dev': '1'}})
        put(self.root, self.app + '/dist/main.js', 'export const runtime = true;')
        put(self.root, self.app + '/dist/worker-main.js', 'export const worker = true;')
        put(self.root, self.app + '/src/unused.ts', 'development source')
        put(self.root, '.turbo/cache/unused', 'cache')
        self.package('prod', {'dependencies': {'nested': '1'}})
        self.package('nested', {})
        self.package('dev', {})
    def tearDown(self):
        # Extraction is deliberately immutable; only this fixture's trees are made writable.
        for folder, _, _ in os.walk(self.temp.name, followlinks=False):
            os.chmod(folder, 0o700)
        self.temp.cleanup()
    def package(self, name, extra):
        directory = self.root / 'node_modules/.pnpm' / (name + '@1') / 'node_modules' / name
        directory.mkdir(parents=True, exist_ok=True)
        json_file(directory, 'package.json', {'name': name, 'version': '1', 'main': 'index.js', **extra})
        put(directory, 'index.js', 'module.exports={};')
        link = self.root / 'node_modules' / name
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.is_symlink():
            link.symlink_to(os.path.relpath(directory, link.parent), target_is_directory=True)
        return directory
    def plan(self, role='backend'):
        return runtime.RuntimeFiles(self.root).result(role, 'synthetic-current')
    def archive(self, plan):
        output = self.root.parent / 'runtime.tar.gz'
        raw = runtime.encoded(plan)
        runtime.pack(self.root, plan, raw, output)
        return output, runtime.digest(raw)
    def test_production_closure_preserves_pnpm_and_ignores_development(self):
        plan = self.plan(); names = {row['path'] for row in plan['files']}
        self.assertIn('node_modules/prod', names)
        self.assertTrue(any('nested@1' in name for name in names))
        self.assertFalse(any('dev@1' in name or 'unused' in name or '.turbo' in name for name in names))
        self.assertTrue(all(row.get('mode', 0) & 0o222 == 0 for row in plan['files'] if row['type'] == 'file'))
    def test_pack_extract_hashes_new_inodes_and_no_overwrite(self):
        put(self.root, 'node_modules/.pnpm/prod@1/node_modules/prod/' + 'long-'*30 + '.js', 'long traced path')
        plan = self.plan(); archive, checksum = self.archive(plan)
        destination = self.root.parent / 'candidate'
        runtime.extract(archive, destination, checksum)
        source = self.root / self.app / 'dist/main.js'; target = destination / self.app / 'dist/main.js'
        self.assertEqual(source.read_bytes(), target.read_bytes()); self.assertNotEqual(source.stat().st_ino, target.stat().st_ino)
        self.assertTrue((destination / 'node_modules/prod').is_symlink())
        self.assertEqual((destination / 'node_modules/prod/index.js').read_bytes(), b'module.exports={};')
        with self.assertRaisesRegex(runtime.Refused, 'DESTINATION_EXISTS'):
            runtime.extract(archive, destination, checksum)
    def test_changed_source_refuses_pack(self):
        plan = self.plan(); put(self.root, self.app + '/dist/main.js', 'changed')
        with self.assertRaisesRegex(runtime.Refused, 'INPUT_CHANGED'):
            self.archive(plan)
    def test_missing_runtime_dependency_refuses(self):
        (self.root / 'node_modules/nested').unlink()
        with self.assertRaisesRegex(runtime.Refused, 'MISSING_RUNTIME_DEPENDENCY'):
            self.plan()
    def test_optional_escape_is_not_silently_ignored(self):
        directory = self.root / 'node_modules/optional'
        directory.symlink_to('/tmp')
        json_file(self.root, self.app + '/package.json', {'name': '@fixture/backend', 'optionalDependencies': {'optional': '1'}})
        with self.assertRaisesRegex(runtime.Refused, 'PATH_ESCAPES_ROOT'):
            self.plan()
    def test_secret_and_cache_trace_paths_refuse_before_read(self):
        for name in ('.env.production', 'profile.env', '.ssh/private.key', 'apps/admin/.next/cache/item'):
            put(self.root, name, 'synthetic noncredential input')
            with self.assertRaisesRegex(runtime.Refused, 'NON_RUNTIME_PATH'):
                runtime.RuntimeFiles(self.root).add(self.root / name)
    def next_fixture(self, role):
        app = 'apps/' + role
        json_file(self.root, app + '/package.json', {'name': role, 'type': 'module'})
        json_file(self.root, app + '/.next/required-server-files.json', {'config': {'distDir': '.next', 'assetPrefix': '/synthetic-assets'}, 'files': ['.next/BUILD_ID']})
        put(self.root, app + '/.next/BUILD_ID', 'synthetic-build')
        put(self.root, app + '/.next/server/app/page.js', 'unchanged build')
        put(self.root, app + '/.next/static/current.js', 'unchanged browser bytes')
        put(self.root, app + '/public/icon.svg', '<svg/>')
        package = self.package('next', {})
        put(package, 'dist/server/next.js', 'module.exports={};')
        put(package, 'dist/server/lib/start-server.js', 'exports.startServer=()=>{};')
        trace = pathlib.PurePosixPath(app + '/.next')
        name = os.path.relpath(package / 'index.js', self.root / trace)
        json_file(self.root, app + '/.next/next-server.js.nft.json', {'version': 1, 'files': [name]})
        if role == 'web':
            put(self.root, app + '/scripts/start-production.mts', 'export const startProductionWeb=()=>{};')
            put(self.root, app + '/scripts/production-http-server.mts', 'export const preserveLimit=8;')
        return app
    def test_admin_and_web_generated_bootstrap_keep_current_bytes(self):
        for role in ('admin', 'web'):
            app = self.next_fixture(role); plan = self.plan(role)
            names = {row['path'] for row in plan['files']}
            generated = next(row for row in plan['files'] if row['type'] == 'generated')
            self.assertEqual(generated['sha256'], runtime.digest(runtime.launcher(role)))
            self.assertNotIn('content', generated)
            self.assertIn(app + '/.next/server/app/page.js', names)
            self.assertIn(b'__NEXT_PRIVATE_STANDALONE_CONFIG', runtime.launcher(role))
            if role == 'web':
                self.assertIn(app + '/scripts/production-http-server.mts', names)
                self.assertIn(b'startProductionWeb', runtime.launcher(role))
            else:
                self.assertIn(b"port:3002,allowRetry:false", runtime.launcher(role))
    def test_next_missing_trace_or_escape_refuses(self):
        app = self.next_fixture('admin')
        json_file(self.root, app + '/.next/next-server.js.nft.json', {'version': 1, 'files': ['../../../../../../etc/passwd']})
        with self.assertRaisesRegex(runtime.Refused, 'PATH_ESCAPES_ROOT'):
            self.plan('admin')
        (self.root / app / '.next/next-server.js.nft.json').unlink()
        with self.assertRaisesRegex(runtime.Refused, 'NEXT_SERVER_TRACE_MISSING'):
            self.plan('admin')
    def test_issuer_has_separate_current_entry(self):
        json_file(self.root, 'services/agent-authorization/package.json', {'name': '@fixture/issuer'})
        put(self.root, 'services/agent-authorization/dist/main.js', 'issuer-only')
        plan = self.plan('issuer')
        self.assertEqual(plan['entry'], 'services/agent-authorization/dist/main.js')
        self.assertFalse(any(row['path'].startswith(self.app) for row in plan['files']))
    def test_archive_hash_mismatch_leaves_no_candidate(self):
        plan = self.plan(); archive, _ = self.archive(plan); destination = self.root.parent / 'bad'
        with self.assertRaisesRegex(runtime.Refused, 'MANIFEST_HASH'):
            runtime.extract(archive, destination, '0' * 64)
        self.assertFalse(destination.exists())
    def test_manifest_rejects_symlink_parent_write(self):
        plan = self.plan(); plan['fileCount'] += 1; plan['files'].append({'path': 'node_modules/prod/injected.js', 'type': 'file', 'bytes': 0, 'sha256': runtime.digest(b''), 'mode': 0o444})
        with self.assertRaisesRegex(runtime.Refused, 'MANIFEST_PARENT'):
            runtime.validate_manifest(plan)

    def typed_install(self, managed, key, now):
        plan = runtime.RuntimeFiles(self.root).result('backend', key)
        raw = runtime.encoded(plan); archive = self.root.parent/(key+'.tar.gz')
        runtime.pack(self.root, plan, raw, archive)
        checksum = runtime.digest(raw); receipt = runtime.extract(archive, managed/key, checksum)
        return {'id': key, 'path': key, 'kind': 'runtime', 'role': 'backend', 'state': 'candidate', 'createdAt': now, 'expiresAt': now+1000, 'manifestSha256': checksum, 'ownerUid': receipt['ownerUid']}
    def typed_inputs(self, catalog, now):
        catalog_file = self.root.parent/'catalog.json'; catalog_file.write_bytes(retention.encoded(catalog))
        consumers = {'complete': True, 'staticComplete': True, 'observedAt': now, 'bindings': []}
        consumers_file = self.root.parent/'consumers.json'; consumers_file.write_bytes(retention.encoded(consumers))
        return catalog_file, consumers_file, consumers
    def apply_fixture(self, managed, catalog_file, consumer_file, plan, now, checkpoint=None):
        return retention.apply_typed(managed, catalog_file, consumer_file, plan, now, checkpoint,
                                     clock_ms=lambda: now)
    def test_real_execution_rejects_replayed_planner_clock_without_mutating(self):
        managed=self.root.parent/'managed';managed.mkdir()
        row=self.typed_install(managed,'stale-clock',0)
        catalog=retention.empty_catalog();catalog['artifacts']=[row]
        catalog_file,consumer_file,consumers=self.typed_inputs(catalog,2000)
        plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
        with self.assertRaisesRegex(retention.Refused,'PLAN_STALE'):
            retention.apply_typed(managed,catalog_file,consumer_file,plan,2000)
        self.assertTrue((managed/row['path']).is_dir())
        plan_file=self.root.parent/'stale-plan.json';plan_file.write_bytes(retention.encoded(plan))
        child=subprocess.run([sys.executable,'-B',str(BASE/'runtime-retention.py'),'apply','--root',str(managed),'--catalog',str(catalog_file),'--consumers',str(consumer_file),'--plan',str(plan_file),'--plan-sha',retention.sha(plan_file.read_bytes()),'--now','2000','--execute'],capture_output=True,text=True,timeout=5)
        self.assertEqual(child.returncode,1)
        self.assertEqual(json.loads(child.stdout)['category'],'PLAN_STALE')
        self.assertTrue((managed/row['path']).is_dir())
    def test_execution_rechecks_age_before_each_claim_and_finishes_current_commit(self):
        managed=self.root.parent/'managed';managed.mkdir()
        rows=[self.typed_install(managed,'age'+str(i),0) for i in range(2)]
        catalog=retention.empty_catalog();catalog['artifacts']=rows
        catalog_file,consumer_file,consumers=self.typed_inputs(catalog,2000)
        plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
        clock=[2000]
        def checkpoint(phase):
            if phase=='catalog-committed':clock[0]=62001
        with self.assertRaisesRegex(retention.Refused,'PLAN_STALE|CONSUMERS_STALE'):
            retention.apply_typed(managed,catalog_file,consumer_file,plan,2000,checkpoint,clock_ms=lambda:clock[0])
        self.assertFalse((managed/'age0').exists());self.assertTrue((managed/'age1').exists())
    def test_monotonic_elapsed_time_cannot_be_hidden_by_a_backwards_wall_clock(self):
        managed=self.root.parent/'managed';managed.mkdir()
        rows=[self.typed_install(managed,'mono'+str(i),0) for i in range(2)]
        catalog=retention.empty_catalog();catalog['artifacts']=rows
        catalog_file,consumer_file,consumers=self.typed_inputs(catalog,2000)
        plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
        elapsed=[0.0]
        def checkpoint(phase):
            if phase=='catalog-committed':elapsed[0]=61.0
        with patch.object(retention.time,'monotonic',side_effect=lambda:elapsed[0]):
            with self.assertRaisesRegex(retention.Refused,'PLAN_STALE'):
                retention.apply_typed(managed,catalog_file,consumer_file,plan,2000,checkpoint,clock_ms=lambda:2000)
        self.assertFalse((managed/'mono0').exists());self.assertTrue((managed/'mono1').exists())
    def test_initial_verified_snapshot_rejects_a_writable_top_level(self):
        managed=self.root.parent/'managed';managed.mkdir()
        row=self.typed_install(managed,'writable-root',0);folder=managed/row['path'];folder.chmod(0o777)
        with self.assertRaisesRegex(runtime.Refused,'ARTIFACT_ROOT_WRITABLE'):
            runtime.verified_snapshot(folder,row['manifestSha256'])
    def test_typed_executor_five_cycles_reclaim_real_directories_and_interruption(self):
        managed = self.root.parent/'managed'; managed.mkdir()
        catalog = retention.empty_catalog(); first = self.typed_install(managed,'typed0',0); first['state']='ready'
        catalog['artifacts']=[first]; catalog['roles']={'backend':{'current':'typed0','rollback':None}}
        observed=[]
        for cycle in range(1,6):
            now=cycle*10000; key='typed'+str(cycle); row=self.typed_install(managed,key,now)
            space={'observedAt':now,'freeBytes':10**9,'incomingBytes':10**6,'freeFloor':10**6}
            catalog=retention.transition(catalog,{'operation':'stage','artifact':row,'space':space},now)
            catalog=retention.transition(catalog,{'operation':'begin','role':'backend','candidate':key},now)
            previous=catalog['transition']['previous']; old=next(item for item in catalog['artifacts'] if item['id']==previous)
            proof={'verified':True,'dataCompatible':True,'current':row['manifestSha256'],'rollback':old['manifestSha256']}
            catalog=retention.transition(catalog,{'operation':'activate','healthy':True,'compatibility':proof},now)
            catalog_file,consumer_file,consumers=self.typed_inputs(catalog,now+2000)
            plan=retention.typed_plan(managed,catalog,consumers,now+2000,10**9,0,0)
            if cycle==3:
                def killed(phase):
                    if phase=='unlinked':
                        raise RuntimeError('SYNTHETIC_KILLED')
                with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_KILLED'):
                    self.apply_fixture(managed,catalog_file,consumer_file,plan,now+2000,killed)
                # Resume from the durable intent while the original directory is gone.
                plan=retention.typed_plan(managed,catalog,consumers,now+2000,10**9,0,0)
            self.apply_fixture(managed,catalog_file,consumer_file,plan,now+2000)
            catalog=json.loads(catalog_file.read_bytes())
            actual=[item.name for item in managed.iterdir() if item.is_dir() and not item.name.startswith('.')]
            self.assertEqual(len(actual),2); self.assertEqual(len(catalog['artifacts']),2)
            observed.append(sum(file.stat().st_size for item in actual for file in (managed/item).rglob('*') if file.is_file()))
        self.assertLessEqual(max(observed)-min(observed),1024)
    def test_typed_executor_refuses_owner_drift_unknown_files_and_consumer_changes(self):
        managed=self.root.parent/'managed'; managed.mkdir()
        row=self.typed_install(managed,'unreferenced',0)
        catalog=retention.empty_catalog();catalog['artifacts']=[row]
        catalog_file,consumer_file,consumers=self.typed_inputs(catalog,2000)
        plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
        consumers['complete']=False;consumer_file.write_bytes(retention.encoded(consumers))
        with self.assertRaisesRegex(retention.Refused,'PLAN_CHANGED'):
            self.apply_fixture(managed,catalog_file,consumer_file,plan,2000)
        consumers['complete']=True;consumer_file.write_bytes(retention.encoded(consumers))
        folder=managed/'unreferenced';folder.chmod(0o700);put(folder,'unknown.bin','retain useful unknown bytes').chmod(0o444);folder.chmod(0o555)
        with self.assertRaisesRegex(runtime.Refused,'ARTIFACT_CONTENT_CHANGED'):
            runtime.verified_snapshot(folder,row['manifestSha256'])
        self.assertTrue((folder/'unknown.bin').exists())

    def test_retirement_recovers_each_durable_boundary_including_catalog_commit(self):
        for phase in ('claimed','unlinked','catalog-committed'):
            with self.subTest(phase=phase):
                managed=self.root.parent/('managed-'+phase);managed.mkdir()
                row=self.typed_install(managed,'expire-'+phase,0)
                catalog=retention.empty_catalog();catalog['artifacts']=[row]
                catalog_file,consumer_file,consumers=self.typed_inputs(catalog,2000)
                plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
                def interrupted(at):
                    if at==phase:
                        raise RuntimeError('SYNTHETIC_INTERRUPTION')
                with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_INTERRUPTION'):
                    self.apply_fixture(managed,catalog_file,consumer_file,plan,2000,interrupted)
                catalog=json.loads(catalog_file.read_bytes())
                plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
                self.apply_fixture(managed,catalog_file,consumer_file,plan,2000)
                self.assertEqual(json.loads(catalog_file.read_bytes())['artifacts'],[])
                self.assertEqual(list((managed/'.runtime-retired').iterdir()),[])
    def test_archive_extra_member_and_changed_payload_are_not_extracted(self):
        plan=self.plan();raw=runtime.encoded(plan);checksum=runtime.digest(raw)
        for bad in ('extra','hash','hardlink'):
            archive=self.root.parent/(bad+'.tar.gz')
            with tarfile.open(archive,'w:gz') as output:
                member=tarfile.TarInfo('runtime-manifest.json');member.size=len(raw);output.addfile(member,io.BytesIO(raw))
                target=next(row for row in plan['files'] if row['type']=='file')
                member=tarfile.TarInfo('outside-unplanned' if bad=='extra' else target['path'])
                if bad=='hardlink':
                    member.type=tarfile.LNKTYPE;member.linkname='/etc/passwd';output.addfile(member)
                else:
                    payload=b'!'*target['bytes'];member.size=len(payload);output.addfile(member,io.BytesIO(payload))
            destination=self.root.parent/('bad-'+bad)
            with self.assertRaises(runtime.Refused):
                runtime.extract(archive,destination,checksum)
            self.assertFalse(destination.exists())

    def test_next_cache_is_only_a_declared_empty_mount_stub(self):
        app=self.next_fixture('admin')
        put(self.root,app+'/.next/cache/never-ship','regenerable original cache')
        plan=self.plan('admin'); cache=next(row for row in plan['files'] if row['type']=='mount')
        self.assertEqual(cache['path'],app+'/.next/cache')
        self.assertFalse(any(row['path'].endswith('never-ship') for row in plan['files']))
        archive,checksum=self.archive(plan);destination=self.root.parent/'with-cache-stub'
        runtime.extract(archive,destination,checksum)
        runtime.verified_snapshot(destination,checksum)
        stub=destination/cache['path'];stub.chmod(0o700);put(stub,'unexpected','do not delete')
        with self.assertRaisesRegex(runtime.Refused,'MOUNT_STUB_CHANGED'):
            runtime.verified_snapshot(destination,checksum)
        (stub/'unexpected').unlink();stub.parent.chmod(0o700);stub.rmdir();stub.symlink_to(self.root);stub.parent.chmod(0o555)
        with self.assertRaisesRegex(runtime.Refused,'MOUNT_STUB_CHANGED'):
            runtime.verified_snapshot(destination,checksum)
    def test_extract_space_floor_refuses_without_publishing_candidate(self):
        archive,checksum=self.archive(self.plan());destination=self.root.parent/'no-space'
        with self.assertRaisesRegex(runtime.Refused,'PEAK_SPACE_REFUSED'):
            runtime.extract(archive,destination,checksum,free_floor=10**30)
        self.assertFalse(destination.exists())

    def test_typed_backlog_drains_in_bounded_passes_instead_of_refusing_ninth_target(self):
        managed=self.root.parent/'backlog';managed.mkdir();catalog=retention.empty_catalog()
        for index in range(9):catalog['artifacts'].append(self.typed_install(managed,'backlog'+str(index),0))
        catalog_file,consumer_file,consumers=self.typed_inputs(catalog,2000)
        plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
        self.assertEqual(len(plan['targets']),8)
        self.apply_fixture(managed,catalog_file,consumer_file,plan,2000)
        catalog=json.loads(catalog_file.read_bytes());self.assertEqual(len(catalog['artifacts']),1)
        plan=retention.typed_plan(managed,catalog,consumers,2000,10**9,0,0)
        self.apply_fixture(managed,catalog_file,consumer_file,plan,2000)
        self.assertEqual(json.loads(catalog_file.read_bytes())['artifacts'],[])

    def test_first_symlink_epoch_is_not_replaced_by_a_later_target(self):
        planner=runtime.RuntimeFiles(self.root)
        link=self.root/'node_modules/prod';planner.normalize(link)
        link.unlink();link.symlink_to('.pnpm/nested@1/node_modules/nested')
        with self.assertRaisesRegex(runtime.Refused,'INPUT_LINK_CHANGED'):
            planner.normalize(link)

    def test_frozen_older_bootstrap_digest_remains_valid_for_verification_and_retirement(self):
        self.next_fixture('admin');plan=self.plan('admin')
        generated=next(row for row in plan['files'] if row['type']=='generated')
        generated['sha256']='b'*64
        runtime.validate_manifest(plan)  # Frozen archive content, not today's template, is authoritative.

class RetentionTests(unittest.TestCase):
    def row(self, key, now, kind='runtime'):
        return {'id': key, 'path': 'releases/' + key, 'kind': kind, 'role': 'backend', 'state': 'candidate', 'createdAt': now, 'expiresAt': now + 1000, 'manifestSha256': hashlib.sha256(key.encode()).hexdigest()}
    def catalog(self):
        catalog = retention.empty_catalog(); row = self.row('v0', 0); row['state'] = 'ready'
        catalog['artifacts'] = [row]; catalog['roles'] = {'backend': {'current': 'v0', 'rollback': None}}
        return catalog
    def space(self, now):
        return {'observedAt': now, 'freeBytes': 1000000, 'incomingBytes': 10000, 'freeFloor': 100000}
    def consumers(self, now):
        return {'complete': True, 'staticComplete': True, 'observedAt': now, 'bindings': []}
    def plan(self, catalog, now):
        return retention.retirement_plan(catalog, self.consumers(now), now, 1000000, 10000, 100000)
    def test_five_cycles_failure_and_interruption_converge(self):
        catalog = self.catalog(); sizes = []
        with tempfile.TemporaryDirectory(prefix='retention-cycles-synthetic-') as folder:
            root = pathlib.Path(folder); (root / 'releases/v0').mkdir(parents=True); (root / 'releases/v0/runtime').write_bytes(b'x'*4096)
            for cycle in range(1, 6):
                now = cycle * 10000; key = 'v' + str(cycle); row = self.row(key, now)
                catalog = retention.transition(catalog, {'operation': 'stage', 'artifact': row, 'space': self.space(now)}, now)
                (root / row['path']).mkdir(); (root / row['path'] / 'runtime').write_bytes(b'x'*4096)
                catalog = retention.transition(catalog, {'operation': 'begin', 'role': 'backend', 'candidate': key}, now)
                protected = self.plan(catalog, now + 2000)
                self.assertNotIn(key, [item['id'] for item in protected['eligible']])
                previous = catalog['transition']['previous']; old = next(item for item in catalog['artifacts'] if item['id'] == previous)
                proof = {'verified': True, 'dataCompatible': True, 'current': row['manifestSha256'], 'rollback': old['manifestSha256']}
                catalog = retention.transition(catalog, {'operation': 'activate', 'healthy': True, 'compatibility': proof}, now)
                plan = self.plan(catalog, now + 2000); retired = [item['id'] for item in plan['eligible']]
                for item in plan['eligible']:
                    shutil.rmtree(root / item['path'])
                if retired:
                    catalog = retention.transition(catalog, {'operation': 'ack-retired', 'ids': retired, 'deletionReceiptVerified': True}, now + 2000)
                sizes.append(sum(path.stat().st_size for path in root.rglob('runtime')))
                self.assertLessEqual(len(catalog['artifacts']), 2)
            self.assertEqual(sizes, [8192]*5)
        now = 60000; failed = self.row('failed-build', now, 'build')
        catalog = retention.transition(catalog, {'operation': 'stage', 'artifact': failed, 'space': self.space(now)}, now)
        self.assertIn('failed-build', [row['id'] for row in self.plan(catalog, now+2000)['eligible']])
    def test_unknown_consumer_and_maintenance_pin_protect_all(self):
        catalog = self.catalog(); catalog['artifacts'].append(self.row('old-task-scratch', 0, 'scratch'))
        consumers = self.consumers(2000); consumers['bindings'] = [{'artifact': 'old-task-scratch', 'kind': 'maintenance', 'verified': True}]
        self.assertEqual(retention.retirement_plan(catalog, consumers, 2000, 1, 2, 0)['eligible'], [])
        consumers['complete'] = False
        self.assertEqual(retention.retirement_plan(catalog, consumers, 2000, 1, 2, 0)['eligible'], [])
    def test_peak_space_refuses_before_stage(self):
        catalog = self.catalog(); space = self.space(2000); space['freeBytes'] = 1
        with self.assertRaisesRegex(retention.Refused, 'PEAK_SPACE_REFUSED'):
            retention.transition(catalog, {'operation': 'stage', 'artifact': self.row('low', 2000), 'space': space}, 2000)
        self.assertEqual(len(catalog['artifacts']), 1)
    def test_static_window_and_current_consumer_protect_owning_tree(self):
        catalog = self.catalog(); catalog['artifacts'].append(self.row('old', 0))
        catalog['static'] = [{'path': 'releases/old/static/chunk.js', 'sha256': 'a'*64, 'consumers': [], 'retainUntil': 3000}]
        self.assertEqual(self.plan(catalog, 2000)['eligible'], [])
        self.assertEqual(self.plan(catalog, 4000)['eligible'][0]['id'], 'old')
        catalog['static'][0]['consumers'] = ['v0']
        self.assertEqual(self.plan(catalog, 4000)['eligible'], [])
    def test_incompatible_rollback_and_unconfirmed_recovery_refuse(self):
        catalog = self.catalog(); row = self.row('candidate', 2000)
        catalog = retention.transition(catalog, {'operation': 'stage', 'artifact': row, 'space': self.space(2000)}, 2000)
        catalog = retention.transition(catalog, {'operation': 'begin', 'role': 'backend', 'candidate': row['id']}, 2000)
        with self.assertRaisesRegex(retention.Refused, 'ROLLBACK_INVALID'):
            retention.transition(catalog, {'operation': 'activate', 'healthy': True, 'compatibility': {'verified': True, 'dataCompatible': False}}, 3000)
        with self.assertRaisesRegex(retention.Refused, 'RECOVERY_UNVERIFIED'):
            retention.transition(catalog, {'operation': 'fail', 'previousRestored': False}, 3000)
        catalog = retention.transition(catalog, {'operation': 'fail', 'previousRestored': True}, 3000)
        self.assertEqual(catalog['roles']['backend']['current'], 'v0')
        self.assertIn('candidate', [row['id'] for row in self.plan(catalog, 4000)['eligible']])
    def test_last_link_accounting_does_not_promise_external_blocks(self):
        with tempfile.TemporaryDirectory(prefix='retention-links-synthetic-') as folder:
            root = pathlib.Path(folder); (root/'a').mkdir(); (root/'b').mkdir(); (root/'outside').mkdir()
            (root/'a/blob').write_bytes(b'x'*16384); os.link(root/'a/blob', root/'b/blob'); os.link(root/'a/blob', root/'outside/blob')
            amount = retention.allocated_reclaim(root, ['a','b'])
            self.assertEqual(amount['externallyLinkedInodes'], 1)
            self.assertLess(amount['lastLinkAllocatedBytes'], (root/'a/blob').stat().st_blocks*512)
            self.assertGreater(retention.allocated_reclaim(root, ['a','b','outside'])['lastLinkAllocatedBytes'], amount['lastLinkAllocatedBytes'])
    def test_catalog_compare_and_swap_rejects_drift(self):
        with tempfile.TemporaryDirectory(prefix='retention-cas-synthetic-') as folder:
            file = pathlib.Path(folder)/'catalog.json'; file.write_bytes(retention.encoded(self.catalog()))
            original = file.read_bytes()
            with self.assertRaisesRegex(retention.Refused, 'CATALOG_CHANGED'):
                retention.update(file, '0'*64, {}, 0)
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual(stat.S_IMODE(file.with_name('catalog.json.lock').stat().st_mode),0o600)

if __name__ == '__main__':
    unittest.main(verbosity=1)
