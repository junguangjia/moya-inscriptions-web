"""release.py end to end: a synthetic git repository, the fake host, ssh replaced by a local runner, the private builder
replaced by fake_compile.py. Every verb's happy path and the client's refusals."""
import base64
import contextlib
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
        self.assertIn('login-door toolkit', pointer)
        self.assertIn('adopt --rebaseline', pointer)
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
            if verb in ('migrate', 'cert'):
                self.assertIn('login-door toolkit (%s)' % toolkit, value['pointer'])
            else:
                self.assertNotIn('login-door', value['pointer'])
        self.assertIn('adopt --rebaseline', self.last(self.client('migrate')[1])['pointer'])

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


if __name__ == '__main__':
    unittest.main()
