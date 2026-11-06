"""release.py end to end: a synthetic git repository, the fake host, ssh replaced by a local runner, the private builder
replaced by fake_compile.py. Every verb's happy path and the client's refusals."""
import base64
import contextlib
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
import fakehost  # noqa: E402
import release as R  # noqa: E402

GIT = ['git', '-c', 'user.name=release-test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false',
       '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main']
OLD_CLIENTS = '[{"clientId":"https://client.test/meta","family":"claude"}]'
# A small pnpm workspace: folder -> (package name, workspace packages it depends on).
PACKAGES = {'apps/web': ('@t/web', ['@t/ui', '@t/contracts']), 'apps/admin': ('@t/admin', ['@t/api', '@t/contracts']),
            'packages/ui': ('@t/ui', []), 'packages/contracts': ('@t/contracts', []),
            'services/agent-authorization': ('@t/agent-authorization', ['@t/catalog-postgres', '@t/contracts']),
            'services/catalog-postgres': ('@t/catalog-postgres', ['@t/api']), 'services/api': ('@t/api', ['@t/contracts']),
            'services/backend-runtime': ('@t/backend-runtime', ['@t/api'])}
NEW_CLIENTS = '[{"clientId":"https://client.test/meta","family":"claude"},{"clientId":"https://cursor.test/m","family":"cursor"}]'


def git(repo, *args):
    done = subprocess.run(GIT + ['-C', repo] + list(args), capture_output=True, timeout=60)
    assert done.returncode == 0, done.stderr
    return done.stdout.decode().strip()


def commit(repo, files, message):
    for path, text in files.items():
        target = pathlib.Path(repo, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')


class ClientCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix='release-client-'))
        self.repo = str(self.tmp / 'repo')
        os.makedirs(self.repo)
        git(self.repo, 'init', '-q', '-b', 'main')
        env_line = 'AGENT_AUTHORIZATION_CLIENTS=%s\nCMS_SECRET=REPLACE_ME\n'
        base = {'apps/web/page.txt': 'v1', 'apps/admin/page.txt': 'v1', 'services/agent-authorization/main.txt': 'v1',
                'services/backend-runtime/main.txt': 'v1', 'packages/contracts/x.txt': 'v1',
                'database/community-migrations/20261105010000_a.sql': 'select 1;',
                'database/community-migrations/20261105030000_b.sql': 'select 1;',
                'apps/admin/src/migrations/index.ts': 'export const migrations = [{ name: "20261105_131739_mcp_connection_identity" }]\n',
                'infra/production/env/admin.env.example': env_line % OLD_CLIENTS,
                'infra/production/env/admin-authorization.env.example': env_line % OLD_CLIENTS,
                'infra/production/env/web.env.example': 'NODE_ENV=production\n',
                'infra/production/env/backend.env.example': 'NODE_ENV=production\n',
                'infra/production/nginx/yoyi.conf.template': '# template\n',
                'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - "services/*"\n  - packages/*\n'}
        for folder, (name, deps) in PACKAGES.items():
            base[folder + '/package.json'] = json.dumps({'name': name, 'dependencies': {d: 'workspace:*' for d in deps}})
        # Outside the workspace globs, so never mistaken for the package of the same name.
        base['docs/examples/old/package.json'] = json.dumps({'name': '@t/api', 'dependencies': {'@t/web': '1'}})
        self.c1 = commit(self.repo, base, 'live web')
        self.c2 = commit(self.repo, {'apps/admin/page.txt': 'v2'}, 'live admin')
        self.c3 = commit(self.repo, {'apps/web/page.txt': 'v3', 'apps/admin/page.txt': 'v3',
                                     'infra/production/env/admin.env.example': env_line % NEW_CLIENTS,
                                     'infra/production/env/admin-authorization.env.example': env_line % NEW_CLIENTS},
                         'new release')
        profile, _ = fakehost.load_profile()
        h = profile['host']
        for service, item in h['live'].items():
            sha = self.c1 if service == 'web' else self.c2
            name = h['services'][service].get('rootName') or service
            item.update(commit=sha, label=sha[:8], root='%s/%s/%s' % (h['paths']['runtime'], sha[:8], name))
        profile['local'].update(requiredAncestor=self.c1, work=str(self.tmp / 'work'), partBytes=256)
        self.profile, self.h = profile, h
        self.fake = fakehost.FakeHost(profile, scratch=str(self.tmp))
        self.profile_path = self.tmp / 'profile.json'
        self.profile_path.write_text(json.dumps(profile))
        spec = {'source': None, 'artifacts': {}}
        for service in ('web', 'admin', 'backend'):
            raw, files = self.fake.manifest(h['services'][service]['artifact'], self.c3[:8], service, self.c3)
            spec['artifacts'][h['services'][service]['artifact']] = {
                'manifest': raw.decode(), 'files': {p: base64.b64encode(b).decode() for p, b in files.items()}}
        self.spec = self.tmp / 'spec.json'
        self.spec.write_text(json.dumps(spec))
        env = self.fake.env()
        test = {'ssh': [sys.executable, '-I', str(HERE / 'fake_ssh.py')], 'root': self.fake.root,
                'bin': json.loads(env['RELEASE_TEST_BIN']), 'python': sys.executable,
                'testEnv': {k: env[k] for k in ('RELEASE_TEST_ROOT', 'RELEASE_TEST_BIN', 'RELEASE_TIME_SCALE',
                                                'RELEASE_TEST_IGNORE_CLOCK')},
                'work': str(self.tmp / 'work'), 'pollSeconds': 0.05, 'repo': self.repo, 'mainRef': 'main', 'offline': True,
                'compile': [sys.executable, '-I', str(HERE / 'fake_compile.py'), '--spec', str(self.spec), '--commit',
                            '{commit}', '--out', '{out}', '--roles', '{roles}']}
        self.test_json = self.tmp / 'client-test.json'
        self.test_json.write_text(json.dumps(test))
        os.environ['RELEASE_CLIENT_TEST'] = str(self.test_json)
        self.outputs = []

    def tearDown(self):
        os.environ.pop('RELEASE_CLIENT_TEST', None)
        everything = '\n'.join(self.outputs) + self.files_text()
        for value in self.fake.secrets():
            self.assertNotIn(value, everything, 'a synthetic env value reached an output or a log')
        self.assertEqual(fakehost.secret_shapes(self.outputs, R.secret_like), [])
        self.fake.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def files_text(self):
        texts = []
        for folder in (self.tmp / 'work', pathlib.Path(self.fake.P(self.h['paths']['state'])) / 'runs'):
            if folder.exists():
                for path in folder.rglob('*'):
                    if path.is_file() and 'parts' not in path.parts and 'compile' not in path.parts and 'stage' not in path.parts:
                        texts.append(path.read_text(errors='replace'))
        return '\n'.join(texts) + self.fake.argv_log()

    def client(self, *argv, profile=True):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = R.main((['--profile', str(self.profile_path)] if profile else []) + list(argv))
        text = buf.getvalue()
        self.outputs.append(text)
        return rc, text

    def ok(self, *argv):
        rc, text = self.client(*argv)
        self.assertEqual(rc, 0, text)
        return text

    def last(self, text):
        return json.loads([l for l in text.splitlines() if l.startswith('{')][-1])

    def result(self, text):
        line = [l for l in text.splitlines() if '] RESULT ' in l][-1]
        return json.loads(line.split('] RESULT ', 1)[1])

    def cwd(self, service):
        return self.fake.unit(service).get('cwd')

    def plan(self, *extra):
        text = self.ok('plan', self.c3, '--services', 'web,admin,issuer', *extra)
        return self.last(text)

    def staged_release(self):
        self.ok('install')
        plan = self.plan('--env', 'admin,issuer:AGENT_AUTHORIZATION_CLIENTS')
        self.ok('build')
        self.ok('stage')
        self.ok('adopt')
        self.ok('prepare')
        return plan

    def value_file(self, text, mode=0o600):
        path = self.tmp / ('value-%d' % time.time_ns())
        path.write_text(text)
        os.chmod(path, mode)
        return str(path)


class Flow(ClientCase):
    def test_every_verb_in_order_then_rollback_and_close_out(self):
        text = self.ok('install')
        self.assertEqual(self.last(text)['status'], 'INSTALLED')
        self.assertEqual(self.last(self.ok('install'))['status'], 'ALREADY_INSTALLED')
        self.assertEqual(self.last(self.ok('baseline'))['status'], 'BASELINE')
        self.assertEqual(self.last(self.ok('status'))['status'], 'STATUS')
        plan = self.plan()
        self.assertEqual({s: v['mode'] for s, v in plan['services'].items()},
                         {'web': 'root', 'admin': 'root', 'issuer': 'restart'})
        self.assertIn('ENV_TEMPLATE_VALUE_CHANGED:admin:AGENT_AUTHORIZATION_CLIENTS', plan['warnings'])
        self.assertIn('ENV_TEMPLATE_VALUE_CHANGED:issuer:AGENT_AUTHORIZATION_CLIENTS', plan['warnings'])
        plan = self.plan('--env', 'admin,issuer:AGENT_AUTHORIZATION_CLIENTS')
        self.assertEqual(plan['warnings'], [])
        self.assertEqual(plan['categories'], ['+env', 'code', 'restart'])
        built = self.last(self.ok('build'))
        self.assertEqual(built['status'], 'BUILT')
        build = json.loads((self.tmp / 'work' / 'plans' / plan['plan'] / 'build.json').read_text())
        self.assertGreater(len(build['parts']), 1)
        self.assertTrue(all(re.fullmatch(r'part-[0-9a-f]{64}', p['name']) and p['name'][5:] == p['sha256'] for p in build['parts']))
        self.assertEqual(json.loads((self.tmp / 'work' / 'plans' / plan['plan'] / 'build.json').read_text())['parts'],
                         json.loads((self.ok('build'), (self.tmp / 'work' / 'plans' / plan['plan'] / 'build.json').read_text())[1])['parts'])
        text = self.ok('stage')
        self.assertIn('sending %d' % len(build['parts']), text)
        self.assertIn('sending 0', self.ok('stage'))
        self.assertEqual(self.result(self.ok('adopt'))['status'], 'ADOPTED')
        self.assertEqual(self.result(self.ok('prepare'))['status'], 'PREPARED')
        secret = NEW_CLIENTS
        text = self.ok('env', 'set', 'admin,issuer', 'AGENT_AUTHORIZATION_CLIENTS', '--value-file', self.value_file(secret),
                       '--plan', plan['plan'])
        self.assertEqual(self.result(text)['status'], 'ENV_SET')
        self.assertEqual(self.result(self.ok('switch', 'web', '--plan', plan['plan'], '--outage-ok'))['status'], 'SWITCHED')
        self.assertEqual(self.result(self.ok('switch', 'issuer,admin', '--plan', plan['plan'], '--outage-ok'))['status'], 'SWITCHED')
        self.assertEqual(self.cwd('web'), '%s/%s/web/%s' % (self.h['paths']['runtime'], self.c3[:8], self.h['services']['web']['cwd']))
        self.assertEqual(self.result(self.ok('verify'))['status'], 'PASS')
        self.assertNotIn(secret, '\n'.join(self.outputs) + self.files_text())
        self.assertEqual(self.result(self.ok('rollback', '--to', 'previous', '--outage-ok'))['status'], 'ROLLED_BACK')
        self.assertEqual(self.cwd('web'), '%s/%s/web/%s' % (self.h['paths']['runtime'], self.c1[:8], self.h['services']['web']['cwd']))
        for name in ('admin', 'issuer'):
            live = self.fake.read(self.h['envFiles'][name]['path']).decode()
            self.assertNotIn(secret, live)
        self.assertEqual(self.result(self.ok('verify'))['status'], 'PASS')
        self.assertEqual(self.result(self.ok('close-out', '--accepted'))['status'], 'CLOSED_OUT')

    def test_sigterm_from_systemd_stop_rolls_the_switch_back(self):
        plan = self.staged_release()
        self.fake.set(sleepOnStart=self.h['services']['admin']['unit'])

        def stopper():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                state = self.fake.state()
                if state.get('sleeping'):
                    for unit in state.get('transient', {}):
                        if '-switch-' in unit:
                            self.fake.systemctl('stop', unit)
                    return
                time.sleep(0.05)

        thread = threading.Thread(target=stopper)
        thread.start()
        rc, text = self.client('switch', 'web,admin', '--plan', plan['plan'], '--outage-ok')
        thread.join()
        result = self.result(text)
        self.assertEqual((rc, result['status'], result['failure']), (3, 'ROLLED_BACK', 'SIGTERM'), text)
        self.assertEqual(self.cwd('admin'), self.h['live']['admin']['root'] + '/' + self.h['services']['admin']['cwd'])
        self.fake.set(sleeping=None)
        self.assertEqual(self.result(self.ok('verify'))['status'], 'PASS')

    def test_dry_run_sends_nothing(self):
        self.ok('install')
        before = self.fake.state().get('transient', {})
        rc, text = self.client('adopt', '--dry-run')
        self.assertEqual(rc, 0, text)
        self.assertIn('DRY-RUN launch-adopt', text)
        self.assertEqual(self.fake.state().get('transient', {}), before)

    def test_restart_only_plan_needs_no_build(self):
        self.ok('install')
        text = self.ok('plan', self.c3, '--services', 'issuer')
        plan = self.last(text)
        self.assertEqual(plan['services']['issuer']['mode'], 'restart')
        rc, text = self.client('build')
        self.assertIn('NOTHING_TO_BUILD', text)
        self.ok('stage')
        self.ok('adopt')
        self.assertEqual(self.result(self.ok('switch', 'issuer', '--plan', plan['plan'], '--outage-ok'))['status'], 'SWITCHED')


class Refusals(ClientCase):
    def test_profile_and_shape_refusals(self):
        saved = os.environ.pop('ARTVENN_RELEASE_PROFILE', None)
        try:
            rc, text = self.client('status', profile=False)
        finally:
            if saved is not None:
                os.environ['ARTVENN_RELEASE_PROFILE'] = saved
        self.assertEqual(rc, 1)
        self.assertIn('PROFILE_REQUIRED', text)
        rows = [
            (['plan', 'abc', '--services', 'web'], 'COMMIT_MUST_BE_40_HEX'),
            (['plan', '0' * 40, '--services', 'web'], 'COMMIT_UNKNOWN'),
            (['plan', self.c3, '--services', 'nope'], 'SERVICES'),
            (['plan', self.c3, '--services', 'web', '--env', 'admin:lower'], 'ENV_DECLARATION'),
            (['switch', 'web'], 'NEEDS_--outage-ok'),
            (['rollback', '--to', 'yesterday', '--outage-ok'], 'ROLLBACK_TO'),
            (['close-out'], 'CLOSE_OUT_NEEDS_--accepted'),
            (['build'], 'NO_PLAN'),
            (['env', 'get', 'web', 'NODE_ENV'], 'ENV_ACTION'),
            (['env', 'set', 'nope', 'NODE_ENV', '--generate', 'token64'], 'ENV_FILES'),
            (['env', 'set', 'web', 'NODE_ENV'], 'ENV_VALUE_SOURCE'),
            (['env', 'set', 'web', 'NODE_ENV', '--generate', 'token64', '--value-file', '/dev/null'], 'ENV_VALUE_SOURCE'),
        ]
        self.ok('install')
        for argv, code in rows:
            rc, text = self.client(*argv)
            self.assertEqual(rc, 1, (argv, text))
            self.assertIn(code, text, argv)

    def test_value_files_must_be_private_single_lines(self):
        self.ok('install')
        self.ok('adopt')
        for path, code in ((self.value_file('x' * 20, 0o644), 'VALUE_FILE_SHAPE'),
                           (self.value_file('one\ntwo\n'), 'VALUE_FILE_ONE_LINE')):
            rc, text = self.client('env', 'set', 'web', self.h['envFiles']['web']['keys'][0], '--value-file', path)
            self.assertEqual(rc, 1)
            self.assertIn(code, text)

    def test_not_on_main_and_pending_migrations(self):
        self.ok('install')
        git(self.repo, 'checkout', '-q', '-b', 'side')
        side = commit(self.repo, {'apps/web/page.txt': 'side'}, 'side')
        git(self.repo, 'checkout', '-q', 'main')
        rc, text = self.client('plan', side, '--services', 'web')
        self.assertIn('NOT_ON_MAIN', text)
        app = commit(self.repo, {'database/community-migrations/20261107010000_c.sql': 'select 1;'}, 'migration')
        rc, text = self.client('plan', app, '--services', 'web')
        self.assertEqual(rc, 2, text)
        self.assertIn('MIGRATIONS_PENDING:app:20261107010000', text)
        pointer = self.last(text)['pointer']
        self.assertIn('--migrations <family>:<name>', pointer)
        self.assertIn('migrate --family <family> --pitr-confirmed', pointer)
        cms = commit(self.repo, {'apps/admin/src/migrations/index.ts':
                                 'export const migrations = [{ name: "20261105_131739_mcp_connection_identity" }, '
                                 '{ name: "20261107_010000_new_table" }]\n'}, 'cms')
        rc, text = self.client('plan', cms, '--services', 'web')
        self.assertIn('MIGRATIONS_PENDING:cms:20261107_010000_new_table', text)

    def test_unreadable_ledger_refuses_the_plan(self):
        self.ok('install')
        operator = json.loads(self.fake.read(self.h['paths']['operator']))
        operator.pop(self.h['database']['caFallback'])
        self.fake.write(self.h['paths']['operator'], json.dumps(operator), 0o600)
        rc, text = self.client('plan', self.c3, '--services', 'web')
        self.assertEqual(rc, 2, text)
        self.assertIn('LEDGER_UNREADABLE', text)

    def test_stubs_refuse_with_the_next_step_in_plain_words(self):
        toolkit = self.profile['local']['pointers']['loginDoorToolkit']
        for verb in R.STUBS:
            rc, text = self.client(verb)
            self.assertEqual(rc, 2, verb)
            value = self.last(text)
            self.assertEqual(value['code'], 'NOT_IN_PHASE_A:' + verb)
            self.assertIn('Until phase B', value['pointer'])
            if verb == 'cert':
                self.assertIn('login-door toolkit (%s)' % toolkit, value['pointer'])
            else:
                self.assertNotIn('login-door', value['pointer'])
        self.assertNotIn('migrate', R.STUBS)

    def test_host_tool_changed_after_install(self):
        self.ok('install')
        identity = R.tool_identity()
        path = self.fake.P(identity['dir'] + '/release_host.py')
        os.chmod(path, 0o600)
        with open(path, 'a') as handle:
            handle.write('# changed\n')
        rc, text = self.client('baseline')
        self.assertEqual(rc, 2, text)
        self.assertIn('HOST_TOOL_SHA', text)

    def test_build_refusals(self):
        self.ok('install')
        self.plan()
        spec = json.loads(self.spec.read_text())
        self.spec.write_text(json.dumps(dict(spec, fail=True)))
        rc, text = self.client('build')
        self.assertIn('COMPILE_FAILED:3', text)
        self.spec.write_text(json.dumps(dict(spec, source='f' * 40)))
        rc, text = self.client('build')
        self.assertIn('MANIFEST_SOURCE', text)
        self.spec.write_text(json.dumps(spec))
        manifest = self.h['live']['web']['root'] + '/runtime-manifest.json'
        os.chmod(self.fake.P(manifest), 0o644)
        self.fake.write(manifest, self.fake.read(manifest) + b' ', 0o444)
        rc, text = self.client('build')
        self.assertIn('LIVE_MANIFEST_MOVED:web', text)

    def test_stage_refuses_a_changed_local_part(self):
        self.ok('install')
        plan = self.plan()
        self.ok('build')
        build = json.loads((self.tmp / 'work' / 'plans' / plan['plan'] / 'build.json').read_text())
        part = self.tmp / 'work' / 'builds' / plan['plan'] / 'parts' / build['parts'][0]['name']
        part.write_bytes(part.read_bytes() + b'x')
        rc, text = self.client('stage')
        self.assertIn('LOCAL_PART_CHANGED', text)

    def test_a_running_release_unit_blocks_a_launch(self):
        self.ok('install')
        state = self.fake.state()
        state['transient'][self.h['unitPrefix'] + 'switch-20261106T000000Z'] = os.getpid()
        self.fake.set(transient=state['transient'])
        try:
            rc, text = self.client('adopt')
        finally:
            self.fake.set(transient={})
        self.assertEqual(rc, 2, text)
        self.assertIn('RELEASE_UNIT_ACTIVE', text)

    def test_ssh_alias_is_read_from_the_named_file(self):
        os.environ.pop('RELEASE_CLIENT_TEST')
        R.TEST = None
        R.load_profile(str(self.profile_path))
        source = self.tmp / 'client.py'
        source.write_text("x = 1\nHOST = 'operator@host.example.invalid'\n")
        R.PROFILE['local']['hostAlias']['file'] = str(source)
        argv = R.ssh_argv()
        self.assertEqual(argv[-1], 'operator@host.example.invalid')
        self.assertIn('BatchMode=yes', argv)
        source.write_text('nothing here\n')
        with self.assertRaises(R.ClientError) as caught:
            R.ssh_argv()
        self.assertEqual(str(caught.exception), 'HOST_ALIAS_UNKNOWN')
        os.environ['RELEASE_CLIENT_TEST'] = str(self.test_json)



class Planning(ClientCase):
    """What the plan decides and what the profile must hold; the launch limits of self-undoing steps."""

    def test_a_unit_template_change_refuses_the_plan(self):
        self.ok('install')
        unit = self.profile['local']['unitTemplates']['web']
        c4 = commit(self.repo, {unit: '[Service]\nExecStart=/x\n', 'apps/web/page.txt': 'v4'}, 'unit template')
        rc, text = self.client('plan', c4, '--services', 'web')
        self.assertEqual(rc, 2, text)
        value = self.last(text)
        self.assertEqual((value['status'], value['code']), ('REFUSED', 'UNIT_TEMPLATE_CHANGED:web'), value)
        self.assertIn('--unit-applied', value['pointer'])
        plan = self.last(self.ok('plan', c4, '--services', 'web', '--unit-applied', 'web'))
        self.assertEqual(plan['status'], 'PLANNED')

    def test_code_paths_follow_workspace_dependencies(self):
        self.ok('install')
        docs = commit(self.repo, {'docs/notes.md': 'x'}, 'docs only')
        plan = self.last(self.ok('plan', docs, '--services', 'issuer'))
        self.assertEqual(plan['services']['issuer']['mode'], 'restart')
        api = commit(self.repo, {'services/api/index.txt': 'v4'}, 'api only')
        plan = self.last(self.ok('plan', api, '--services', 'issuer,admin'))
        # The issuer's profile paths do not name services/api; its workspace dependencies reach it.
        self.assertEqual({s: v['mode'] for s, v in plan['services'].items()}, {'issuer': 'root', 'admin': 'root'})
        self.assertIn('services/api', plan['services']['issuer']['dependsOn'])

    def test_a_profile_the_verbs_would_misread_refuses_at_load(self):
        rows = [(lambda p: p['host'].update(restartOrder=[s for s in p['host']['restartOrder'] if s != 'web']),
                 'PROFILE_RESTART_ORDER'),
                (lambda p: p['local']['codePaths'].pop('issuer'), 'PROFILE_CODE_PATHS:issuer'),
                (lambda p: p['host']['checks'].pop('mcpDoor'), 'PROFILE_CHECKS'),
                (lambda p: p['local'].pop('remote'), 'PROFILE_LOCAL_KEY:remote')]
        self.ok('install')
        try:
            for change, code in rows:
                profile = json.loads(json.dumps(self.profile))
                change(profile)
                self.profile_path.write_text(json.dumps(profile))
                rc, text = self.client('status')
                self.assertEqual(rc, 1, text)
                self.assertIn(code, text)
        finally:
            self.profile_path.write_text(json.dumps(self.profile))
        self.assertEqual(self.last(self.ok('status'))['status'], 'STATUS')

    def test_a_root_moved_outside_the_tool_refuses_the_plan_until_adopt_rebaseline(self):
        self.ok('install')
        self.ok('adopt')
        outside = 'eeee5555' + '0123456789abcdef0123456789abcdef'
        self.fake.outside_release('backend', outside[:8], outside)
        rc, text = self.client('plan', self.c3, '--services', 'web')
        value = self.last(text)
        self.assertEqual((rc, value['code']), (2, 'ROOT_MOVED:backend'), text)
        self.assertIn('adopt --rebaseline', value['pointer'])
        rc, text = self.client('adopt')
        self.assertEqual((rc, self.result(text)['code']), (2, 'ROOT_MOVED:backend:run adopt --rebaseline'), text)
        result = self.result(self.ok('adopt', '--rebaseline'))
        self.assertEqual((result['status'], result['rebaselined']), ('ADOPTED', ['backend']), result)
        self.assertEqual(self.last(self.ok('plan', self.c3, '--services', 'web'))['status'], 'PLANNED')

    def test_a_self_undoing_step_gets_a_stop_timeout_longer_than_its_undo(self):
        self.ok('install')
        self.ok('adopt')
        self.assertEqual(self.result(self.ok('switch', 'issuer', '--outage-ok'))['status'], 'RESTARTED')
        self.ok('rollback', '--to', 'previous', '--outage-ok')
        # The host tool's own limits per service: stop 120 s, start 120 s, then the readiness wait.
        worst = sum(120 + 120 + self.h['readySeconds'].get(s, 180) for s in self.h['services'])
        launched = {}
        for line in self.fake.argv_log().splitlines():
            argv = json.loads(line)
            if argv[0] == 'systemd-run':
                unit = next(a.split('=', 1)[1] for a in argv if a.startswith('--unit='))
                step = unit[len(self.h['unitPrefix']):].rsplit('-', 1)[0]
                launched[step] = dict(a[len('--property='):].split('=', 1) for a in argv if a.startswith('--property='))
        for step in ('switch', 'rollback'):
            stop, runtime = int(launched[step]['TimeoutStopSec']), int(launched[step]['RuntimeMaxSec'])
            self.assertGreater(stop, worst, step)
            self.assertGreaterEqual(R.limits(step)[2], runtime + stop, step)


CMS_INDEX = 'apps/admin/src/migrations/index.ts'
IDENTITY = '20261105_131739_mcp_connection_identity'
GRANT_FILE = 'infra/development/grant-cms-runtime.sql'
APP_GRANT_FILE = 'infra/development/work-publishing/grant-runtime.sql'
RUNS, TARGETS = fakehost.RUNS, fakehost.TARGETS
SYNTHETIC_SQL = {RUNS: fakehost.RUNS_SQL, TARGETS: fakehost.TARGETS_SQL}
LAUNCHER = ('// the release\'s own launcher (synthetic)\nawait import("../services/catalog-postgres/dist/index.js");\n'
            'await import("../services/community-postgres/dist/index.js");\n')


def cms_index(*names):
    return 'export const migrations = [%s]\n' % ', '.join('{ name: "%s" }' % n for n in names)


def up_only(body):
    return 'export async function up({ db }: MigrateUpArgs): Promise<void> {\n%s\n}\n' % body


class MigrationFlow(ClientCase):
    """plan --migrations, migrate and the switch it holds back, end to end through the client."""

    def cms_commit(self, names=(RUNS, TARGETS), sources=None, extra=None, grant=fakehost.GRANTS):
        files = {CMS_INDEX: cms_index(IDENTITY, *names), GRANT_FILE: grant.decode()}
        for name in names:
            files['apps/admin/src/migrations/%s.ts' % name] = (sources or {}).get(name) or \
                fakehost.cms_source(SYNTHETIC_SQL[name]).decode()
        files.update(extra or {})
        return commit(self.repo, files, 'cms migrations')

    def test_a_cms_migration_from_plan_to_rollback(self):
        # The grant file also grants on the trigger function the migrations create: never in the rehearsal.
        c4 = self.cms_commit(extra={'apps/admin/page.txt': 'v4'}, grant=fakehost.GRANTS + (
            b'GRANT EXECUTE ON FUNCTION public.r1b_targets_guard() TO :"cms_role";\n'))
        self.ok('install')
        rc, text = self.client('plan', c4, '--services', 'backend,admin')
        self.assertEqual((rc, self.last(text)['code']), (2, 'MIGRATIONS_PENDING:cms:%s,%s' % (RUNS, TARGETS)), text)
        plan = self.last(self.ok('plan', c4, '--services', 'backend,admin', '--migrations', 'cms:%s,cms:%s' % (RUNS, TARGETS)))
        self.assertEqual((plan['categories'], plan['sequence'], plan['migrations']),
                         (['+migration', 'code', 'restart'], ['migrate --family cms', 'switch backend,admin'],
                          {'cms': [RUNS, TARGETS]}))
        self.assertEqual(plan['privileges']['cms']['tables'][0],
                         {'table': 'public.r1b_runs', 'granted': ['SELECT', 'INSERT', 'UPDATE'],
                          'absent': ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'], 'columns': {}})
        stored = json.loads((self.tmp / 'work' / 'plans' / plan['plan'] / 'plan.json').read_text())
        pinned = R.cms_sql(RUNS, fakehost.cms_source(fakehost.RUNS_SQL))
        self.assertEqual(stored['migrations']['cms']['items'][0]['sha256'], hashlib.sha256(pinned.encode()).hexdigest())
        self.assertEqual((stored['sequence'], stored['ledgers']['cms']['count']), (plan['sequence'], 1))
        self.assertEqual(stored['grants']['cms']['file'], GRANT_FILE)
        self.assertNotIn('r1b_runs', stored['grants']['cms']['rehearsal'])
        self.assertNotIn('r1b_targets_guard', stored['grants']['cms']['rehearsal'])
        self.ok('build')
        self.ok('stage')
        self.ok('adopt')
        self.ok('prepare')
        rc, text = self.client('switch', 'backend,admin', '--plan', plan['plan'], '--outage-ok')
        self.assertEqual((rc, self.result(text)['code']), (2, 'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first'))
        rc, text = self.client('migrate', '--family', 'cms')
        self.assertEqual(rc, 1, text)
        self.assertIn('NEEDS_--pitr-confirmed', text)
        check = self.last(self.ok('migrate', '--family', 'cms', '--check'))
        self.assertEqual((check['status'], check['pending'], check['ready'], check['grantRehearsal']),
                         ('MIGRATE_CHECKED', [RUNS, TARGETS], True, 'ROLLED_BACK_OK'))
        self.assertIn('DRY-RUN launch-migrate', self.ok('migrate', '--family', 'cms', '--dry-run'))
        self.assertEqual((self.fake.state()['writes'], self.fake.state()['dumps']), ([], []))
        result = self.result(self.ok('migrate', '--family', 'cms', '--pitr-confirmed'))
        self.assertEqual((result['status'], result['applied'], result['privileges']['mismatches']),
                         ('MIGRATED', [RUNS, TARGETS], []), result)
        self.assertEqual(self.result(self.ok('switch', 'backend,admin', '--plan', plan['plan'], '--outage-ok'))['status'],
                         'SWITCHED')
        verified = self.result(self.ok('verify'))
        self.assertEqual((verified['status'], verified['ledgers']['cms']), ('PASS', {'count': 3}), verified)
        # A ledger row written outside the tool: verify fails until the baseline is recorded again.
        ledgers = self.fake.state()['ledgers']
        ledgers['cms'].append('20261106_150000_outside')
        self.fake.set(ledgers=ledgers)
        rc, text = self.client('verify')
        self.assertEqual((rc, self.result(text)['failures']), (2, ['LEDGER_COUNT:cms:4:3']))
        self.assertEqual(self.client('migrate', '--family', 'cms', '--rebaseline', '--check')[0], 1)
        rebaselined = self.result(self.ok('migrate', '--family', 'cms', '--rebaseline'))
        self.assertEqual((rebaselined['status'], rebaselined['changes']['count']), ('BASELINED', [3, 4]), rebaselined)
        self.assertEqual(self.result(self.ok('verify'))['status'], 'PASS')
        rolled = self.result(self.ok('rollback', '--to', 'previous', '--outage-ok'))
        self.assertEqual(rolled['status'], 'ROLLED_BACK')
        self.assertTrue(rolled['migrations'].startswith('untouched'), rolled)
        self.assertEqual(self.fake.state()['ledgers']['cms'], [IDENTITY, RUNS, TARGETS, '20261106_150000_outside'])
        # --unswitched-ok reaches the host as its own flag.
        self.ok('rollback', '--to', 'previous', '--outage-ok', '--unswitched-ok', '--dry-run')
        script = sorted((self.tmp / 'work' / 'logs' / 'scripts').glob('*-launch-rollback.py'))[-1].read_text()
        params = json.loads(base64.b64decode(re.search(r"b64decode\('([A-Za-z0-9+/=]+)'\)", script).group(1)))
        self.assertEqual(params['args'], ['--to', 'previous', '--unswitched-ok'])

    def test_an_app_migration_runs_through_the_releases_own_launcher(self):
        c4 = commit(self.repo, {'database/community-migrations/20261107010000_c.sql':
                                'CREATE TABLE community.r1b_c (id integer PRIMARY KEY);\n',
                                'scripts/migrate-community.mjs': LAUNCHER}, 'app migration')
        self.ok('install')
        rc, text = self.client('plan', c4, '--services', 'web', '--migrations', 'app:20261107010000')
        self.assertEqual(rc, 1, text)
        self.assertIn('MIGRATION_NEEDS_ROOT:app:backend', text)
        rc, text = self.client('plan', c4, '--services', 'backend,issuer', '--migrations', 'app:20261107010000')
        self.assertIn('GRANT_FILE_MISSING:' + APP_GRANT_FILE, text)
        c5 = commit(self.repo, {APP_GRANT_FILE: fakehost.APP_GRANTS.decode()}, 'app grants')
        plan = self.last(self.ok('plan', c5, '--services', 'backend,issuer', '--migrations', 'app:20261107010000'))
        self.assertEqual((plan['sequence'], plan['migrations'], plan['privileges']['app']['tables']),
                         (['migrate --family app', 'switch backend,issuer'], {'app': ['20261107010000']},
                          [{'table': 'community.r1b_c', 'granted': ['SELECT', 'INSERT'],
                            'absent': ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'], 'columns': {}}]))
        stored = json.loads((self.tmp / 'work' / 'plans' / plan['plan'] / 'plan.json').read_text())
        self.assertNotIn('sql', stored['grants']['app'])                       # the tool never runs the App grant file
        self.assertEqual(stored['migrations']['app']['modules'], fakehost.APP_MODULES)
        self.ok('build')
        self.ok('stage')
        self.ok('adopt')
        self.ok('prepare')
        rc, text = self.client('migrate', '--family', 'app', '--pitr-confirmed')
        result = self.result(text)
        self.assertEqual((rc, result['code'], result['applied']),
                         (2, 'APP_GRANTS_MISSING:community.r1b_c:SELECT:MISSING,community.r1b_c:INSERT:MISSING',
                          ['20261107010000']), text)
        self.assertEqual(self.fake.state()['ledgers']['app'][-1], '20261107010000')
        self.fake.set(acl={fakehost.APP_ROLE: {'community.r1b_c': ['SELECT', 'INSERT']}})   # the operator ran the file
        result = self.result(self.ok('migrate', '--family', 'app', '--pitr-confirmed'))
        self.assertEqual((result['status'], result['applied'], result['appRole']), ('MIGRATED', [], fakehost.APP_ROLE), result)
        self.assertEqual(self.result(self.ok('switch', 'backend,issuer', '--plan', plan['plan'], '--outage-ok'))['status'],
                         'SWITCHED')

    def test_what_the_plan_refuses_about_migrations(self):
        self.ok('install')
        c4 = self.cms_commit()
        rc, text = self.client('plan', c4, '--services', 'admin', '--migrations', 'cms:' + RUNS)
        value = self.last(text)
        self.assertEqual((rc, value['refusals']), (2, ['MIGRATIONS_PENDING:cms:' + TARGETS]), text)   # only the undeclared
        both = '--migrations', 'cms:%s,cms:%s' % (RUNS, TARGETS)
        for argv, code in ((['--migrations', 'cms:20261106_235959_unknown'], 'MIGRATION_UNKNOWN:cms:20261106_235959_unknown'),
                           (['--migrations', 'cms:nope'], 'MIGRATION_DECLARATION'),
                           (['--migrations', 'sql:%s' % RUNS], 'MIGRATION_DECLARATION'),
                           (list(both) + ['--ungranted', 'cms:public.r1b_runs'], 'UNGRANTED_BUT_GRANTED:public.r1b_runs'),
                           (list(both) + ['--ungranted', 'app:community.works'], 'UNGRANTED_NOT_NEW:community.works'),
                           (list(both) + ['--ungranted', 'cms:users'], 'UNGRANTED_DECLARATION')):
            rc, text = self.client('plan', c4, '--services', 'admin', *argv)
            self.assertEqual(rc, 1, (argv, text))
            self.assertIn(code, text, argv)
        raw = up_only('  await db.execute(sql.raw(upgradeSql));')
        for sources, code in (({RUNS: raw}, 'CMS_MIGRATION_NOT_EXTRACTABLE:%s:SQL_RAW' % RUNS),
                              ({RUNS: fakehost.cms_source('ALTER TABLE "users" DROP COLUMN "email";').decode()},
                               'MIGRATION_NOT_EXPAND_ONLY:cms:%s:DROP:users' % RUNS)):
            bad = self.cms_commit((RUNS,), sources=sources)
            rc, text = self.client('plan', bad, '--services', 'admin', '--migrations', 'cms:' + RUNS)
            self.assertEqual(rc, 1, text)
            self.assertIn(code, text)
        # A grant file that gives a new table nothing refuses, unless the table is declared ungranted.
        missing = self.cms_commit(grant=fakehost.GRANTS.replace(b',\n  public.r1b_run_targets', b''))
        rc, text = self.client('plan', missing, '--services', 'admin', *both)
        self.assertIn('GRANT_FILE_MISSES_NEW_TABLE:public.r1b_run_targets', text)
        plan = self.last(self.ok('plan', missing, '--services', 'admin', *both, '--ungranted', 'cms:public.r1b_run_targets'))
        self.assertEqual(plan['privileges']['cms']['tables'][1], {'table': 'public.r1b_run_targets', 'granted': [],
                                                                  'absent': list(R.TABLE_PRIVILEGES), 'columns': {}})
        # A contraction the Owner approved, written into the migration: accepted, and named in the plan.
        marked = self.cms_commit((RUNS,), sources={RUNS: fakehost.cms_source(
            '-- release: contraction-ok DROP:users (the column was never read; Owner, 2026-11-06)\n'
            '  ALTER TABLE "users" DROP COLUMN "legacy_note";\n' + fakehost.RUNS_SQL).decode()},
            grant=fakehost.GRANTS.replace(b',\n  public.r1b_run_targets', b''))
        plan = self.last(self.ok('plan', marked, '--services', 'admin', '--migrations', 'cms:' + RUNS))
        self.assertIn('MIGRATION_CONTRACTION_OK:cms:%s:DROP:users' % RUNS, plan['warnings'])
        old = '20261104_000000_r1b_old'
        late = commit(self.repo, {CMS_INDEX: cms_index(IDENTITY, old), 'apps/admin/src/migrations/%s.ts' % old:
                                  fakehost.cms_source('CREATE TABLE "r1b_old" ("id" integer);').decode()}, 'late')
        rc, text = self.client('plan', late, '--services', 'admin', '--migrations', 'cms:' + old)
        value = self.last(text)
        self.assertEqual((rc, value['code']), (2, 'MIGRATION_ORDER:cms:' + old), text)
        self.assertIn('later id', value['pointer'])

    def test_a_changed_grant_file_alone_is_run_before_the_switch(self):
        self.ok('install')
        c4 = commit(self.repo, {GRANT_FILE: fakehost.EXISTING_GRANTS.decode(), 'apps/admin/page.txt': 'v4'}, 'grants')
        plan = self.last(self.ok('plan', c4, '--services', 'admin'))
        self.assertEqual((plan['categories'], plan['sequence'], plan['migrations']),
                         (['+grants', 'code'], ['migrate --family cms', 'switch admin'], {'cms': []}))
        self.assertIn('GRANT_FILE_CHANGED:cms', plan['warnings'])
        web = self.last(self.ok('plan', c4, '--services', 'web'))          # no CMS runtime service: nothing to run
        self.assertEqual((web['categories'], web['migrations'], web['sequence']), (['code'], {}, ['switch web']))
        plan = self.last(self.ok('plan', c4, '--services', 'admin'))
        self.ok('build')
        self.ok('stage')
        self.ok('adopt')
        self.ok('prepare')
        rc, text = self.client('switch', 'admin', '--plan', plan['plan'], '--outage-ok')
        self.assertEqual((rc, self.result(text)['code']), (2, 'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first'))
        result = self.result(self.ok('migrate', '--family', 'cms', '--pitr-confirmed'))
        self.assertEqual((result['status'], result['applied'], result['privileges']['mismatches']), ('MIGRATED', [], []))
        self.assertEqual(len(self.fake.state()['writes']), 1)
        self.assertEqual(self.result(self.ok('switch', 'admin', '--plan', plan['plan'], '--outage-ok'))['status'], 'SWITCHED')


class MigrationRules(unittest.TestCase):
    """The rules plan and the CI check share: CMS SQL extraction, expand only, the Owner's marks, the grant file, the
    sequences PostgreSQL creates, the order against main."""

    def test_cms_sql_is_extracted_only_from_up_s_own_plain_template(self):
        sql = R.cms_sql('n', fakehost.cms_source(fakehost.RUNS_SQL))
        self.assertEqual(sql, fakehost.RUNS_SQL.strip() + '\n')
        self.assertTrue(R.cms_sql('n', fakehost.cms_source(fakehost.TARGETS_SQL)))     # a plpgsql BEGIN is no transaction
        down_raw = fakehost.cms_source(fakehost.RUNS_SQL).decode().replace('await db.execute(sql`\n  DROP', 'await db.execute(sql.raw(`DROP')
        self.assertIn('sql.raw', down_raw)
        self.assertEqual(R.cms_sql('n', down_raw), sql)                                  # only up() is read
        commented = fakehost.cms_source(fakehost.RUNS_SQL).decode().replace(
            '\nexport async function down', '\n// The rows stay: a lock may name them.\nexport async function down')
        self.assertEqual(R.cms_sql('n', commented), sql)                                 # comments between are fine
        self.assertTrue(R.cms_sql('n', fakehost.cms_source('CREATE TABLE "x" ("n" integer DEFAULT 0::integer, '
                                                          '"m" text DEFAULT \':not_a_variable\');')))
        two = up_only('  await db.execute(sql`CREATE TABLE a (id int);`);\n  await db.execute(sql`CREATE TABLE b (id int);`);')
        nested = up_only('  if (process.env.X) { await db.execute(sql`CREATE TABLE a (id int);`) }\n'
                         '  await payload.update({ collection: "users", where: {}, data: {} })')
        rows = [(up_only('  await db.execute(sql.raw(x));'), 'SQL_RAW'), (two, 'SHAPE'), (nested, 'SHAPE'),
                (up_only('  try { await db.execute(sql`CREATE TABLE a (id int);`) } catch (e) {}'), 'SHAPE'),
                ('export const nothing = 1;\n', 'NO_UP'),
                (fakehost.cms_source('CREATE TABLE "x" ("n" integer DEFAULT ${value});'), 'INTERPOLATION'),
                (fakehost.cms_source('CREATE TABLE "x" ("v" text CHECK ("v" ~ \'^\\d+$\'));'), 'BACKSLASH'),
                (fakehost.cms_source('BEGIN;\nCREATE TABLE "x" ("id" integer);\nCOMMIT;'), 'TRANSACTION_CONTROL'),
                (fakehost.cms_source('SET lock_timeout = 0;\nALTER TABLE "users" ADD COLUMN "y" text;'), 'SESSION'),
                (fakehost.cms_source('SELECT set_config(\'statement_timeout\', \'0\', false);'), 'SESSION'),
                (fakehost.cms_source('DO $$ BEGIN SET ROLE someone; END $$;'), 'SESSION'),
                (fakehost.cms_source('CREATE TABLE "x" ("n" integer DEFAULT :VERSION_NUM);'), 'PSQL_VARIABLE'),
                (fakehost.cms_source('GRANT SELECT ON "x" TO :"role";'), 'PSQL_VARIABLE'),
                (fakehost.cms_source('  '), 'EMPTY')]
        for source, reason in rows:
            with self.assertRaises(R.ClientError) as caught:
                R.cms_sql('n', source)
            self.assertEqual(str(caught.exception), 'CMS_MIGRATION_NOT_EXTRACTABLE:n:' + reason)

    def test_only_expand(self):
        rows = [('ALTER TABLE "users" DROP COLUMN "email";', ['DROP:users']),
                ('DROP TABLE public.users;', ['DROP:users']),
                ('ALTER TABLE users RENAME COLUMN a TO b;', ['RENAME:users']),
                ('TRUNCATE users;', ['TRUNCATE:?']),
                ('ALTER TABLE users ALTER COLUMN role TYPE text;', ['TYPE:users']),
                ('ALTER TABLE users ALTER COLUMN role SET NOT NULL;', ['SET_NOT_NULL:users']),
                ('ALTER TABLE users ADD CONSTRAINT c CHECK (id > 0);', ['ADD_CONSTRAINT:users']),
                ('ALTER TABLE users ADD COLUMN x integer NOT NULL;', ['ADD_NOT_NULL:users']),
                ('CREATE UNIQUE INDEX u ON users (email);', ['UNIQUE_INDEX:users']),
                ('DO $$ BEGIN DROP TABLE users; END $$;', ['DROP:users']),
                ('ALTER TABLE users ADD COLUMN x integer NOT NULL DEFAULT 0;', []),
                ('ALTER TABLE "mcp_audit_events" ADD COLUMN "connection_id" varchar;', []),
                ('ALTER TYPE "public"."enum_users_role" ADD VALUE \'ai_operator\';', []),
                ("-- DROP TABLE users\nCREATE TABLE t (note text DEFAULT 'DROP TABLE users; RENAME');", []),
                ('CREATE TABLE t (id int); ALTER TABLE t DROP COLUMN id; CREATE UNIQUE INDEX ti ON t (id); DROP TABLE t;', []),
                ('DROP TABLE t; CREATE TABLE t (id int);', ['DROP:t']),
                ('DO $$ BEGIN IF true THEN TRUNCATE users; END IF; END $$;', ['TRUNCATE:?']),
                ('CREATE TEMP TABLE b ON COMMIT DROP AS SELECT 1;', []),
                ('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON t2 FOR EACH STATEMENT EXECUTE FUNCTION refuse();', []),
                ('ALTER TABLE users ALTER COLUMN role DROP DEFAULT;', ['DROP:users']),
                # What changes rows, privileges or ownership of what exists, or hides its SQL in a string.
                ('DELETE FROM "users" WHERE true;', ['DELETE:users']),
                ('CREATE TABLE t (id int); DELETE FROM t;', []),
                ('REVOKE SELECT ON "users" FROM PUBLIC;', ['REVOKE:users']),
                ('CREATE TABLE community.t (id int); REVOKE ALL ON community.t FROM PUBLIC;', []),
                ('CREATE FUNCTION community.f(integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n'
                 'REVOKE ALL ON FUNCTION community.f(INTEGER), community.g(text) FROM PUBLIC;', ['REVOKE:community.g']),
                ('ALTER TABLE "users" OWNER TO someone;', ['OWNER:users']),
                ('ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;', ['RLS:users']),
                ("DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;", ['DYNAMIC:?']),
                # A function body runs when it is called, not when the migration runs.
                ('CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM users; '
                 "EXECUTE 'x'; RETURN NULL; END $$;", []),
                # What Payload writes for a new collection: a key on a column the same SQL added binds no old write.
                ('ALTER TABLE "rels" ADD COLUMN "runs_id" integer;\nALTER TABLE "rels" ADD CONSTRAINT "rels_runs_fk" '
                 'FOREIGN KEY ("runs_id") REFERENCES "public"."runs"("id") ON DELETE cascade;\n'
                 'CREATE UNIQUE INDEX "rels_runs_idx" ON "rels" USING btree ("runs_id");', []),
                ('ALTER TABLE "rels" ADD COLUMN "runs_id" integer;\n'
                 'ALTER TABLE "rels" ADD CONSTRAINT "rels_pair" UNIQUE ("runs_id", "path");', ['ADD_CONSTRAINT:rels']),
                # A CHECK on columns the same SQL added, with no DEFAULT and no NOT NULL, that reads `<col> IS NULL OR`
                # for each: the earlier code leaves them NULL, which passes. Any other CHECK binds what it writes.
                ('ALTER TABLE "rels" ADD COLUMN "n" integer;\nALTER TABLE "rels" ADD CONSTRAINT c CHECK ("n" IS NULL OR "n" > 0);', []),
                ('ALTER TABLE "rels" ADD COLUMN "n" integer;\nALTER TABLE "rels" ADD CONSTRAINT c CHECK (("n" IS NULL) OR ("n" > 0));', []),
                ('ALTER TABLE community.sessions ADD COLUMN kind text, ADD CONSTRAINT sessions_kind CHECK '
                 "(kind IS NULL OR kind IN ('a', 'b') AND char_length(kind::text) < 9);", []),
                ('ALTER TABLE "rels" ADD COLUMN "n" integer;\nALTER TABLE "rels" ADD CONSTRAINT c CHECK ("n" > 0);',
                 ['ADD_CONSTRAINT:rels']),
                ('ALTER TABLE community.sessions ADD COLUMN kind text;\nALTER TABLE community.sessions ADD CONSTRAINT '
                 'sessions_kind_present CHECK (kind IS NOT NULL) NOT VALID;', ['ADD_CONSTRAINT:community.sessions']),
                ('ALTER TABLE community.sessions ADD COLUMN n integer;\n'
                 'ALTER TABLE community.sessions ADD CONSTRAINT c CHECK (coalesce(n, 0) > 0) NOT VALID;',
                 ['ADD_CONSTRAINT:community.sessions']),
                ('ALTER TABLE community.sessions ADD COLUMN n integer DEFAULT 0;\n'
                 'ALTER TABLE community.sessions ADD CONSTRAINT c CHECK (n > 0) NOT VALID;', ['ADD_CONSTRAINT:community.sessions']),
                ('ALTER TABLE community.sessions ADD COLUMN n integer DEFAULT 0, ADD CONSTRAINT c CHECK (n IS NULL OR n > 0);',
                 ['ADD_CONSTRAINT:community.sessions']),
                ('ALTER TABLE t ADD COLUMN n integer;\nALTER TABLE t ALTER COLUMN n SET DEFAULT 0;\n'
                 'ALTER TABLE t ADD CONSTRAINT c CHECK (n IS NULL OR n > 0);', ['ADD_CONSTRAINT:t']),
                ('ALTER TABLE t ADD COLUMN a int, ADD COLUMN b int, ADD CONSTRAINT c CHECK (a IS NULL OR b > 0);',
                 ['ADD_CONSTRAINT:t']),
                # The same shape on a column that was there already binds the rows the earlier code writes.
                ("ALTER TABLE community.works ADD CONSTRAINT works_state CHECK (state IS NULL OR state IN ('a', 'b'));",
                 ['ADD_CONSTRAINT:community.works']),
                ('ALTER TABLE "rels" ADD COLUMN "n" integer;\nALTER TABLE "rels" ADD CONSTRAINT c CHECK '
                 '("n" IS NULL OR "old" IS NULL OR "n" > "old");', ['ADD_CONSTRAINT:rels']),
                # A constraint accepted in a statement hides nothing else the statement does.
                ('ALTER TABLE t ADD COLUMN y int, ADD CONSTRAINT c CHECK (y IS NULL OR y > 0), ADD COLUMN x int NOT NULL;',
                 ['ADD_NOT_NULL:t']),
                ('ALTER TABLE "rels" ADD COLUMN "n" integer;\nALTER TABLE "rels" ADD CONSTRAINT c CHECK ("n" > "old");',
                 ['ADD_CONSTRAINT:rels']),
                ('ALTER TABLE "rels" ADD COLUMN "n" integer;\nALTER TABLE "rels" ADD CONSTRAINT x EXCLUDE USING gist (n WITH =);',
                 ['ADD_CONSTRAINT:rels']),
                (fakehost.RUNS_SQL, []), (fakehost.TARGETS_SQL, []), (fakehost.NOTES_SQL, [])]
        for sql, problems in rows:
            self.assertEqual(R.expand_problems(sql), problems, sql)
        # What an expand may still change for the earlier code is a note, never a refusal.
        self.assertEqual(R.expand_review('UPDATE "users" SET "role" = NULL WHERE false;\n'
                                         'CREATE OR REPLACE FUNCTION existing_fn() RETURNS trigger LANGUAGE plpgsql AS '
                                         '$$ BEGIN RETURN NULL; END $$;\n'
                                         'CREATE TRIGGER t BEFORE INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION f();\n'
                                         'CREATE TABLE n (id int); UPDATE n SET id = 1; CREATE TRIGGER u BEFORE INSERT ON n '
                                         'FOR EACH ROW EXECUTE FUNCTION f();'),
                         ([], ['UPDATE:users', 'REPLACE:existing_fn', 'TRIGGER:users']))

    def test_marks_name_exactly_what_the_owner_approved(self):
        sql = ('-- release: contraction-ok DROP:community.works ADD_CONSTRAINT:community.works, widened CHECK (Owner)\n'
               'ALTER TABLE community.works DROP CONSTRAINT works_state;\n'
               "ALTER TABLE community.works ADD CONSTRAINT works_state CHECK (state IN ('a', 'b', 'c'));\n")
        self.assertEqual(R.expand_verdict(sql), {'problems': [], 'notes': [],
                                                 'accepted': ['ADD_CONSTRAINT:community.works', 'DROP:community.works']})
        self.assertEqual(R.expand_verdict(sql + 'ALTER TABLE community.users RENAME COLUMN a TO b;\n')['problems'],
                         ['RENAME:community.users'])
        self.assertEqual(R.expand_verdict('-- release: contraction-ok DROP:users\nCREATE TABLE t (id int);\n')['problems'],
                         ['MARK_UNUSED:DROP:users'])
        self.assertEqual(R.expand_verdict("CREATE TABLE t (note text DEFAULT '-- release: contraction-ok DROP:users');\n"
                                          'DROP TABLE users;')['problems'], ['DROP:users'])

    def test_created_relations_name_the_sequences_postgresql_creates(self):
        self.assertEqual(R.created_relations(fakehost.NOTES_SQL + '\nALTER TABLE "users" ADD COLUMN "seq_no" bigserial;\n'
                                             'CREATE TABLE community.k (id integer GENERATED ALWAYS AS IDENTITY, n int);'), [
            {'name': 'public.r1b_notes', 'kind': 'table'},
            {'name': 'public.r1b_notes_id_seq', 'kind': 'sequence', 'table': 'public.r1b_notes', 'column': 'id', 'serial': True},
            {'name': 'public.users_seq_no_seq', 'kind': 'sequence', 'table': 'public.users', 'column': 'seq_no', 'serial': True},
            {'name': 'community.k', 'kind': 'table'},
            {'name': 'community.k_id_seq', 'kind': 'sequence', 'table': 'community.k', 'column': 'id', 'serial': False}])
        # PostgreSQL's own shortening past 63 bytes (makeObjectName): the longer name loses characters first.
        self.assertEqual(R.pg_object_name('_catalogs_v_version_source_citations_applies_to', 'id', 'seq'),
                         '_catalogs_v_version_source_citations_applies_to_id_seq')
        self.assertEqual(R.pg_object_name('t' * 70, 'id', 'seq'), 't' * 56 + '_id_seq')
        self.assertEqual(len(R.pg_object_name('a' * 40, 'b' * 40, 'seq')), 63)

    def test_the_grant_file_gives_both_sides_of_each_new_object(self):
        creates = R.created_relations(fakehost.RUNS_SQL + '\n' + fakehost.TARGETS_SQL)
        self.assertEqual(creates, [{'name': 'public.r1b_runs', 'kind': 'table'}, {'name': 'public.r1b_run_targets', 'kind': 'table'}])
        section = R.grant_section(fakehost.GRANTS, GRANT_FILE, creates, 'cms_role')
        self.assertEqual([t['table'] for t in section['tables']], ['public.r1b_runs', 'public.r1b_run_targets'])
        self.assertEqual(section['tables'][0]['absent'], ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        self.assertEqual(section['objects'], [{'name': 'public.mcp_control', 'kind': 'table'},
                                              {'name': 'public.payload_migrations', 'kind': 'table'},
                                              {'name': 'public.users', 'kind': 'table'},
                                              {'name': 'public.users_id_seq', 'kind': 'sequence'}])
        self.assertEqual(section['present'], [
            {'kind': 'column', 'name': 'public.payload_migrations', 'column': 'name', 'privilege': 'SELECT'},
            {'kind': 'schema', 'name': 'public', 'privilege': 'USAGE'},
            {'kind': 'sequence', 'name': 'public.users_id_seq', 'privilege': 'USAGE'},
            {'kind': 'table', 'name': 'public.mcp_control', 'privilege': 'INSERT'},
            {'kind': 'table', 'name': 'public.mcp_control', 'privilege': 'SELECT'},
            {'kind': 'table', 'name': 'public.mcp_control', 'privilege': 'UPDATE'},
            {'kind': 'table', 'name': 'public.users', 'privilege': 'INSERT'},
            {'kind': 'table', 'name': 'public.users', 'privilege': 'SELECT'},
            {'kind': 'table', 'name': 'public.users', 'privilege': 'UPDATE'}])
        # The rehearsal is the file without what names a new table: its guard and the grants on what exists.
        self.assertIn('RAISE EXCEPTION', section['rehearsal'])
        self.assertIn('GRANT USAGE ON SEQUENCE public.users_id_seq', section['rehearsal'])
        self.assertNotIn('r1b_run', section['rehearsal'])
        everything = R.grant_section(b'GRANT ALL ON TABLE public.r1b_runs TO :"cms_role";\n', GRANT_FILE, creates, 'cms_role',
                                     ['public.r1b_run_targets'])
        self.assertEqual((everything['tables'][0]['absent'], everything['tables'][1]['granted']), ([], []))
        # A column grant on a new table (catalog_delivery_intents did one): table-level absent, the columns there.
        notes = R.grant_section(fakehost.NOTES_GRANTS, GRANT_FILE, R.created_relations(fakehost.NOTES_SQL), 'cms_role')
        self.assertEqual(notes['tables'], [{'table': 'public.r1b_notes', 'granted': ['SELECT', 'INSERT'],
                                            'absent': ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
                                            'columns': {'UPDATE': ['note']}}])
        self.assertEqual(notes['sequences'], [{'sequence': 'public.r1b_notes_id_seq', 'granted': ['USAGE'],
                                               'absent': ['SELECT', 'UPDATE']}])
        self.assertNotIn('public.r1b_notes_id_seq', [o['name'] for o in notes['objects']])    # it comes with its table
        # REVOKE, in order: a table-level REVOKE takes that privilege's column grants too (the App file converges so).
        app = R.grant_section(b'GRANT SELECT, UPDATE ON TABLE community.t, community.old TO :"app_role";\n'
                              b'GRANT UPDATE (a) ON TABLE community.old TO :"app_role";\n'
                              b'REVOKE UPDATE ON TABLE community.t, community.old FROM :"app_role";\n'
                              b'GRANT UPDATE (b, c) ON TABLE community.t TO :"app_role";\n',
                              'x', [{'name': 'community.t', 'kind': 'table'}], 'app_role')
        self.assertEqual(app['tables'][0], {'table': 'community.t', 'granted': ['SELECT'],
                                            'absent': ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
                                            'columns': {'UPDATE': ['b', 'c']}})
        self.assertEqual(app['present'], [{'kind': 'table', 'name': 'community.old', 'privilege': 'SELECT'}])
        serial = R.created_relations(fakehost.NOTES_SQL)
        for raw, made, ungranted, code in (
                (b'GRANT SELECT ON TABLE public.users TO :"cms_role";\n', creates, (), 'GRANT_FILE_MISSES_NEW_TABLE:public.r1b_runs'),
                (fakehost.GRANTS, creates, ['public.r1b_runs'], 'UNGRANTED_BUT_GRANTED:public.r1b_runs'),
                (fakehost.GRANTS, creates, ['public.users'], 'UNGRANTED_NOT_NEW:public.users'),
                (b'GRANT SELECT, INSERT ON TABLE public.r1b_notes TO :"cms_role";\n', serial, (),
                 'GRANT_FILE_MISSES_SEQUENCE:public.r1b_notes_id_seq'),
                (b'GRANT USAGE ON SEQUENCE public.r1b_notes TO :"cms_role";\n', serial, (), 'GRANT_KIND:public.r1b_notes'),
                (b'GRANT SELECT ON TABLE public.users TO someone_else;\nSELECT :"cms_role";\n', creates, (), 'GRANT_FILE_SHAPE:GRANT'),
                (b'GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"cms_role";\n', creates, (), 'GRANT_FILE_SHAPE'),
                (b'GRANT SELECT ON TABLE public.users TO :"cms_role" WITH GRANT OPTION;\n', creates, (), 'GRANT_FILE_SHAPE'),
                (b'BEGIN;\nGRANT SELECT ON TABLE public.r1b_runs TO :"cms_role";\nCOMMIT;\n', creates, (),
                 'GRANT_FILE_SHAPE:transaction control'),
                (b'\\i elsewhere.sql\n:"cms_role"', creates, (), 'GRANT_FILE_SHAPE:backslash'),
                (b'GRANT SELECT ON TABLE public.users TO PUBLIC;\n', creates, (), 'GRANT_FILE_SHAPE:variable')):
            with self.assertRaises(R.ClientError) as caught:
                R.grant_section(raw, GRANT_FILE, made, 'cms_role', ungranted)
            self.assertTrue(str(caught.exception).startswith(code), (raw, str(caught.exception)))
        # The repository's own grant files are ones the tool reads.
        real = (HERE.parents[2] / GRANT_FILE).read_bytes()
        self.assertTrue(R.grant_section(real, GRANT_FILE, [], 'cms_role')['objects'])
        self.assertTrue(R.grant_section((HERE.parents[2] / APP_GRANT_FILE).read_bytes(), APP_GRANT_FILE, [], 'app_role')['present'])

    def test_a_do_blocks_grant_and_a_rehearsal_without_any_new_object(self):
        # The App file's DO block (home-timeline-v1's shape): a grant on the new table through the bound setting.
        timeline = [{'name': 'community.r1b_timeline', 'kind': 'table'}]
        section = R.grant_section(fakehost.APP_DO_GRANTS, APP_GRANT_FILE, timeline, 'app_role')
        self.assertEqual(section['tables'], [{'table': 'community.r1b_timeline', 'granted': ['SELECT'], 'absent': [
            'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'], 'columns': {}}])
        self.assertEqual(R.grant_section(fakehost.APP_DO_GRANTS, APP_GRANT_FILE, [], 'app_role')['present'],
                         R.grant_section(fakehost.APP_GRANTS, APP_GRANT_FILE, [], 'app_role')['present'])  # new objects only
        bind = b'SET LOCAL moya.runtime_app_role = :"app_role";\n'
        guard = b"IF to_regclass('community.r1b_timeline') IS NOT NULL THEN"
        for raw in (fakehost.APP_DO_GRANTS.replace(bind, b''),                                      # never bound
                    fakehost.APP_DO_GRANTS.replace(bind, b"SET LOCAL moya.runtime_app_role = 'someone';\n"),
                    fakehost.APP_DO_GRANTS.replace(guard, b'IF (SELECT count(*) FROM pg_class) > 0 THEN'),
                    fakehost.APP_DO_GRANTS.replace(b'  END IF;', b"  RAISE NOTICE 'x';\n  END IF;"),
                    fakehost.APP_DO_GRANTS.replace(b"'GRANT SELECT ON TABLE community.r1b_timeline TO %I',",
                                                   b"'GRANT SELECT ON TABLE %s TO %I', 'community.r1b_timeline',")):
            with self.assertRaises(R.ClientError) as caught:
                R.grant_section(raw, APP_GRANT_FILE, timeline, 'app_role')
            self.assertTrue(str(caught.exception).startswith('GRANT_FILE_MISSES_NEW_TABLE:community.r1b_timeline:'), raw)
        # The rehearsal leaves out every statement that names something the release creates, of any kind.
        sql = ('CREATE SCHEMA r1b_ops;\nCREATE TABLE public.r1b_rows (id uuid PRIMARY KEY);\nCREATE VIEW r1b_rows_v AS '
               'SELECT id FROM r1b_rows;\nCREATE TYPE r1b_kind AS ENUM (\'a\');\nCREATE FUNCTION public.r1b_count() '
               'RETURNS bigint LANGUAGE sql AS $$ SELECT 1 $$;\n')
        self.assertEqual(R.created_names(sql), ['public.r1b_count', 'public.r1b_kind', 'public.r1b_rows', 'public.r1b_rows_v',
                                                'r1b_ops'])
        grant = fakehost.EXISTING_GRANTS + b'\n'.join([
            b'GRANT SELECT ON TABLE public.r1b_rows TO :"cms_role";', b'GRANT SELECT ON r1b_rows_v TO :"cms_role";',
            b'GRANT EXECUTE ON FUNCTION public.r1b_count() TO :"cms_role";', b'GRANT USAGE ON SCHEMA r1b_ops TO :"cms_role";',
            b"DO $$ BEGIN IF to_regclass('r1b_ops.t') IS NULL THEN RAISE NOTICE 'none'; END IF; END $$;", b''])
        rehearsal = R.grant_section(grant, GRANT_FILE, R.created_relations(sql), 'cms_role', (), R.created_names(sql))['rehearsal']
        self.assertNotIn('r1b_', rehearsal)
        self.assertIn('RAISE EXCEPTION', rehearsal)
        self.assertIn('GRANT USAGE ON SEQUENCE public.users_id_seq', rehearsal)

    def test_check_migrations_against_main(self):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix='release-check-'))
        self.addCleanup(shutil.rmtree, tmp, True)
        repo = str(tmp / 'repo')
        os.makedirs(repo)
        git(repo, 'init', '-q', '-b', 'main')
        old_raw = up_only('  await db.execute(sql.raw(x));')
        commit(repo, {'database/community-migrations/20261105010000_a.sql': 'select 1;\n', CMS_INDEX: cms_index(IDENTITY),
                      'apps/admin/src/migrations/%s.ts' % IDENTITY: old_raw}, 'main')

        def check(files, base='main'):
            for path, text in files.items():
                target = pathlib.Path(repo, path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = R.main(['check-migrations', '--base', base, '--repo', repo])
            git(repo, 'checkout', '-q', '--', '.')
            git(repo, 'clean', '-qfd')
            return rc, json.loads(buf.getvalue().splitlines()[-1])

        rc, value = check({})
        self.assertEqual((rc, value['status'], value['new']), (0, 'PASS', {'app': [], 'cms': []}), value)   # old ones never
        good = {CMS_INDEX: cms_index(IDENTITY, RUNS), 'apps/admin/src/migrations/%s.ts' % RUNS:
                fakehost.cms_source(fakehost.RUNS_SQL).decode(),
                'database/community-migrations/20261107010000_c.sql': 'CREATE TABLE community.r1b_c (id integer);\n'
                                                                      'UPDATE community.works SET title = title;\n'}
        rc, value = check(good)
        self.assertEqual((rc, value['status'], value['new'], value['notes']),
                         (0, 'PASS', {'app': ['20261107010000_c.sql'], 'cms': [RUNS]},
                          ['20261107010000_c.sql:UPDATE:community.works']))
        widened = ('-- release: contraction-ok DROP:community.works ADD_CONSTRAINT:community.works (Owner)\n'
                   'ALTER TABLE community.works DROP CONSTRAINT works_state;\n'
                   "ALTER TABLE community.works ADD CONSTRAINT works_state CHECK (state IN ('a', 'b'));\n")
        rc, value = check({'database/community-migrations/20261107010000_w.sql': widened})
        self.assertEqual((rc, value['accepted']), (0, ['20261107010000_w.sql:ADD_CONSTRAINT:community.works',
                                                       '20261107010000_w.sql:DROP:community.works']))
        rows = [({'database/community-migrations/20261101000000_old.sql': 'select 1;\n'},
                 ['APP_NOT_AFTER_MAIN:20261101000000_old.sql:20261105010000']),
                ({'database/community-migrations/20261107010000_d.sql': 'ALTER TABLE community.works DROP COLUMN title;\n'},
                 ['APP_NOT_EXPAND_ONLY:20261107010000_d.sql:DROP:community.works']),
                ({'database/community-migrations/20261107010000_m.sql': '-- release: contraction-ok DROP:community.users\n'
                                                                       'ALTER TABLE community.works DROP COLUMN title;\n'},
                 ['APP_NOT_EXPAND_ONLY:20261107010000_m.sql:DROP:community.works',
                  'APP_NOT_EXPAND_ONLY:20261107010000_m.sql:MARK_UNUSED:DROP:community.users']),
                (dict(good, **{'apps/admin/src/migrations/%s.ts' % RUNS: fakehost.cms_source('DROP TABLE "users";').decode()}),
                 ['CMS_NOT_EXPAND_ONLY:%s:DROP:users' % RUNS]),
                (dict(good, **{'apps/admin/src/migrations/%s.ts' % RUNS: old_raw}),
                 ['CMS_MIGRATION_NOT_EXTRACTABLE:%s:SQL_RAW' % RUNS]),
                ({CMS_INDEX: cms_index(IDENTITY, '20261104_000000_r1b_old'),
                  'apps/admin/src/migrations/20261104_000000_r1b_old.ts': fakehost.cms_source('SELECT 1;').decode()},
                 ['CMS_INDEX_ORDER', 'CMS_NOT_AFTER_MAIN:20261104_000000_r1b_old:%s' % IDENTITY]),
                ({CMS_INDEX: cms_index(IDENTITY, RUNS)}, ['CMS_SOURCE_MISSING:' + RUNS])]
        for files, problems in rows:
            rc, value = check(files)
            self.assertEqual((rc, value['status'], value['problems']), (2, 'FAIL', problems), files)
        rc, value = check({}, base='no-such-ref')
        self.assertEqual((rc, value['code']), (1, 'BASE_UNKNOWN:no-such-ref'))


if __name__ == '__main__':
    unittest.main()
