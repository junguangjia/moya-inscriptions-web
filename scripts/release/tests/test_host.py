"""release_host.py on a fake host generated from the profile (the example profile, or ARTVENN_RELEASE_PROFILE)."""
import contextlib
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
import fakehost  # noqa: E402
import release_host as H  # noqa: E402

NEW = 'cccc3333' + '0123456789abcdef0123456789abcdef'
NEWER = 'dddd4444' + '0123456789abcdef0123456789abcdef'


class HostCase(unittest.TestCase):
    def setUp(self):
        self.profile, _ = fakehost.load_profile()
        self.fake = fakehost.FakeHost(self.profile)
        self.h = self.profile['host']
        self.outputs = []
        self.runs = 0

    def tearDown(self):
        everything = '\n'.join(self.outputs) + self.state_text()
        for value in self.fake.secrets():
            self.assertNotIn(value, everything, 'a synthetic env value reached an output or a journal')
        self.assertEqual(fakehost.secret_shapes(self.outputs + [self.state_text()], H.secret_like), [])
        self.fake.close()

    def state_text(self):
        root = pathlib.Path(self.fake.P(self.h['paths']['state'])) / 'runs'
        return '\n'.join(p.read_text() for p in root.rglob('*') if p.is_file()) if root.exists() else ''

    def call(self, *argv, env=None):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = H.main(['release_host.py'] + list(argv), env=env or self.fake.env())
        text = buf.getvalue()
        self.outputs.append(text)
        lines = [l for l in text.splitlines() if l.startswith('{')]
        return rc, (json.loads(lines[-1]) if lines else None)

    def step(self, command, *argv):
        self.runs += 1
        return self.call(command, '--run-id', '%s-%d' % (command, self.runs), *argv)

    def adopt(self):
        rc, value = self.step('adopt')
        self.assertEqual((rc, value['status']), (0, 'ADOPTED'), value)
        return value

    def release(self, commit=NEW, modes=None):
        modes = modes or {'web': 'root', 'admin': 'root', 'issuer': 'restart'}
        plan = self.fake.release(commit, modes)
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual((rc, value['status']), (0, 'PREPARED'), value)
        return plan

    def ledger(self):
        path = pathlib.Path(self.fake.P(self.h['paths']['state'] + '/ledger.jsonl'))
        return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []

    def cwd(self, service):
        return self.fake.unit(service).get('cwd')

    def live_cwd(self, service):
        live = self.h['live'][service]
        sub = self.h['services'][service].get('cwd')
        return live['root'] + ('/' + sub if sub else '')

    def new_cwd(self, service, label=NEW[:8]):
        sub = self.h['services'][service].get('cwd')
        name = self.h['services'][service].get('rootName') or service
        return '%s/%s/%s' % (self.h['paths']['runtime'], label, name) + ('/' + sub if sub else '')


class Happy(HostCase):
    def test_baseline_reads_everything_and_writes_nothing(self):
        rc, value = self.call('baseline')
        self.assertEqual((rc, value['status']), (0, 'BASELINE'))
        for service in self.h['services']:
            self.assertEqual(value['pins'][service]['status'], 'RENDERS', value['pins'])
            self.assertEqual(value['units'][service]['cwd'], self.live_cwd(service))
        self.assertTrue(value['lockFree'])
        self.assertEqual(value['ledger']['entries'], 0)
        self.assertFalse(pathlib.Path(self.fake.P(self.h['paths']['state'])).exists())

    def test_status_and_facts(self):
        rc, value = self.call('status')
        self.assertEqual(value['status'], 'STATUS')
        rc, value = self.call('facts')
        self.assertEqual(value['status'], 'FACTS')
        self.assertEqual(value['services']['web']['label'], self.h['live']['web']['label'])
        self.assertTrue(value['services']['web']['manifestSha256'])

    def test_manifest_is_the_live_roots_file_list(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = H.main(['x', 'manifest', '--service', 'web'], env=self.fake.env())
        value = json.loads(buf.getvalue().splitlines()[-1])
        import base64
        raw = base64.b64decode(value['b64'])
        self.assertEqual(raw, self.fake.manifests['web'])

    def test_adopt_prepare_switch_verify(self):
        self.adopt()
        plan = self.release()
        rc, value = self.step('switch', '--services', 'issuer,admin,web', '--plan', plan)
        self.assertEqual((rc, value['status']), (0, 'SWITCHED'), value)
        self.assertEqual(self.cwd('admin'), self.new_cwd('admin'))
        self.assertEqual(self.cwd('web'), self.new_cwd('web'))
        self.assertEqual(self.cwd('issuer'), self.live_cwd('issuer'))
        self.assertGreaterEqual(self.fake.unit('issuer')['starts'], 2)        # restart only
        rc, value = self.step('verify')
        self.assertEqual((rc, value['status']), (0, 'PASS'), value)
        entries = self.ledger()
        self.assertEqual([e['op'] for e in entries], ['adopt', 'switch'])
        self.assertEqual(entries[1]['previous'], entries[0]['id'])
        self.assertEqual(entries[1]['base'], entries[0]['id'])
        self.assertEqual(entries[1]['services']['web']['label'], NEW[:8])
        for service, item in entries[1]['services'].items():
            self.assertEqual(H.sha_real(self.fake.P(item['pinFile'])), item['pinSha256'])

    def test_prepare_twice_reuses_and_union_merges(self):
        self.adopt()
        plan = self.release()
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual(value['status'], 'PREPARED')
        self.assertEqual(value['roots']['web']['status'], 'ALREADY')
        union = pathlib.Path(self.fake.P('%s/%s/static-compat/web/chunks' % (self.h['paths']['runtime'], NEW[:8])))
        self.assertEqual(sorted(p.name for p in union.iterdir()), sorted(['older.js', NEW[:8] + '.js',
                                                                          self.h['live']['web']['label'] + '.js']))

    def test_issuer_gets_its_own_root_when_its_code_changes(self):
        self.adopt()
        plan = self.release(modes={'backend': 'root', 'issuer': 'root'})
        rc, value = self.step('switch', '--services', 'backend,issuer', '--plan', plan)
        self.assertEqual(value['status'], 'SWITCHED', value)
        self.assertEqual(self.cwd('issuer'), self.new_cwd('issuer'))
        issuer, backend = self.new_cwd('issuer'), self.new_cwd('backend')
        self.assertNotEqual(issuer, backend)
        a = os.stat(self.fake.P(issuer + '/services/agent-authorization/dist/main.js'))
        b = os.stat(self.fake.P(backend + '/services/agent-authorization/dist/main.js'))
        self.assertEqual(a.st_ino, b.st_ino)                                   # a hard-link copy

    def test_restart_only_needs_no_plan(self):
        self.adopt()
        rc, value = self.step('switch', '--services', 'issuer')
        self.assertEqual((rc, value['status']), (0, 'RESTARTED'), value)            # never SWITCHED without a plan
        self.assertEqual(self.cwd('issuer'), self.live_cwd('issuer'))

    def test_close_out_after_pass(self):
        self.adopt()
        plan = self.release()
        self.step('switch', '--services', 'web', '--plan', plan)
        rc, value = self.step('close-out', '--as', 'accepted')
        self.assertEqual(value['code'], 'NO_PASS_AFTER_HEAD')
        self.step('verify')
        rc, value = self.step('close-out', '--as', 'accepted')
        self.assertEqual((rc, value['status']), (0, 'CLOSED_OUT'), value)
        head = self.ledger()[-1]
        self.assertFalse({i['root'] for i in head['services'].values()} & set(value['removable']))
        self.assertTrue(any(r.startswith('payload:') or r == 'parts' or r.startswith('store:') for r in value['removed']), value)


class Ledger(HostCase):
    def test_rollback_to_previous_after_two_switches(self):
        self.adopt()
        first = self.release(NEW)
        self.step('switch', '--services', 'web,admin', '--plan', first)
        second = self.release(NEWER)
        rc, value = self.step('switch', '--services', 'web,admin', '--plan', second)
        self.assertEqual(value['status'], 'SWITCHED', value)
        self.assertEqual(self.cwd('web'), self.new_cwd('web', NEWER[:8]))
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual((rc, value['status']), (0, 'ROLLED_BACK'), value)
        self.assertEqual(self.cwd('web'), self.new_cwd('web', NEW[:8]))
        self.assertEqual(self.cwd('admin'), self.new_cwd('admin', NEW[:8]))
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual(value['status'], 'ROLLED_BACK', value)
        self.assertEqual(self.cwd('web'), self.live_cwd('web'))
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual(value['code'], 'NO_PREVIOUS:NONE')
        entries = self.ledger()
        self.assertEqual([e['op'] for e in entries], ['adopt', 'switch', 'switch', 'rollback', 'rollback'])
        self.assertEqual(entries[3]['target'], entries[1]['id'])
        self.assertEqual(entries[4]['target'], entries[0]['id'])
        for previous, entry in zip(entries, entries[1:]):
            self.assertEqual(entry['previous'], previous['id'])
        rc, value = self.step('verify')
        self.assertEqual(value['status'], 'PASS', value)

    def test_one_plan_with_env_set_rolls_back_as_one_release(self):
        self.adopt()
        plan = self.release()
        paths = [self.h['envFiles'][n][k] for n in ('admin', 'issuer') for k in ('path', 'staged')]
        originals = {p: self.fake.read(p) for p in paths}
        self.step('switch', '--services', 'web', '--plan', plan)
        inbox = self.inbox('[{"clientId":"https://client.example.invalid/new","family":"cursor"}]')
        rc, value = self.step('env-set', '--files', 'admin,issuer', '--key', 'AGENT_AUTHORIZATION_CLIENTS',
                              '--value-inbox', inbox, '--plan', plan)
        self.assertEqual(value['status'], 'ENV_SET', value)
        self.assertEqual(value['pendingRestart'], ['admin', 'issuer'])
        rc, value = self.step('verify')
        self.assertIn('PENDING_RESTART:admin', value['failures'])
        rc, value = self.step('switch', '--services', 'issuer,admin', '--plan', plan)
        self.assertEqual(value['status'], 'SWITCHED', value)
        rc, value = self.step('verify')
        self.assertEqual(value['status'], 'PASS', value)
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual(value['status'], 'ROLLED_BACK', value)
        self.assertEqual(value['order'], ['issuer', 'admin', 'web'])
        for path, raw in originals.items():
            self.assertEqual(self.fake.read(path), raw, path)
        for service in ('web', 'admin', 'issuer'):
            self.assertEqual(self.cwd(service), self.live_cwd(service))
        rc, value = self.step('verify')
        self.assertEqual(value['status'], 'PASS', value)

    def inbox(self, value):
        path = self.h['paths']['state'] + '/inbox/t%d.value' % time.time_ns()
        self.fake.write(path, value, 0o600)
        return path

    def test_an_outside_change_is_drift_and_adopt_is_a_barrier(self):
        self.adopt()
        plan = self.release()
        self.step('switch', '--services', 'web', '--plan', plan)
        path = self.h['envFiles']['web']['path']
        self.fake.write(path, self.fake.read(path) + b'EXTRA_KEY=1\n', 0o600)
        rc, value = self.step('switch', '--services', 'admin', '--plan', plan)
        self.assertEqual(value['code'], 'DRIFT:ENV:web')
        rc, value = self.step('adopt')
        self.assertEqual(value['status'], 'ADOPTED', value)
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual(value['code'], 'NO_PREVIOUS:ADOPT_BARRIER')
        rc, value = self.step('adopt')
        self.assertEqual(value['code'], 'NOTHING_TO_ADOPT')

    def test_a_broken_chain_refuses_everything_that_writes(self):
        self.adopt()
        path = pathlib.Path(self.fake.P(self.h['paths']['state'] + '/ledger.jsonl'))
        entry = json.loads(path.read_text())
        entry['services']['web']['label'] = 'eeee5555'
        path.write_text(json.dumps(entry) + '\n')
        rc, value = self.step('switch', '--services', 'web')
        self.assertEqual(value['code'], 'LEDGER_CHAIN_BROKEN:1')

    def test_rollback_after_close_out_cannot_bring_back_earlier_env_values(self):
        self.adopt()
        inbox = self.inbox('v' * 20)
        self.step('env-set', '--files', 'web', '--key', self.h['envFiles']['web']['keys'][0], '--value-inbox', inbox)
        self.step('switch', '--services', 'web')
        self.step('verify')
        rc, value = self.step('close-out', '--as', 'accepted')
        self.assertEqual(value['status'], 'CLOSED_OUT', value)
        rc, value = self.step('rollback', '--to', 'previous')          # the restart-only switch: nothing on disk
        self.assertEqual((value['status'], value['order']), ('ROLLED_BACK', []), value)
        rc, value = self.step('rollback', '--to', 'previous')          # the env change: its old value is gone
        self.assertTrue(value['code'].startswith('ENV_VERSION_GONE:web'), value)


class EnvSet(HostCase):
    def files(self):
        out = {}
        for name, spec in self.h['envFiles'].items():
            for which in ('path', 'staged'):
                if spec.get(which):
                    out[spec[which]] = self.fake.read(spec[which])
        return out

    def test_touches_exactly_the_named_files_and_their_staged_copies(self):
        self.adopt()
        before = self.files()
        key = 'AGENT_AUTHORIZATION_CLIENTS'
        value = '[{"clientId":"https://cursor.example.invalid/oauth/mcp-client.json","family":"cursor"}]'
        path = self.h['paths']['state'] + '/inbox/x.value'
        self.fake.write(path, value, 0o600)
        rc, answer = self.step('env-set', '--files', 'admin,issuer', '--key', key, '--value-inbox', path)
        self.assertEqual((rc, answer['status']), (0, 'ENV_SET'), answer)
        self.assertTrue(answer['sameInAll'])
        self.assertFalse(os.path.exists(self.fake.P(path)), 'the inbox file is gone')
        after = self.files()
        named = {self.h['envFiles'][n][w] for n in ('admin', 'issuer') for w in ('path', 'staged')}
        for file in before:
            if file in named:
                self.assertNotEqual(before[file], after[file], file)
                self.assertIn(('%s=%s\n' % (key, value)).encode(), after[file])
                other = lambda raw: [l for l in raw.split(b'\n') if not l.startswith(key.encode() + b'=')]
                self.assertEqual(other(before[file]), other(after[file]))
            else:
                self.assertEqual(before[file], after[file], file)
        self.assertNotIn(value, json.dumps(answer))
        self.assertNotIn(value, '\n'.join(self.outputs) + self.state_text())
        self.assertNotIn(value, self.fake.argv_log())

    def test_staged_copy_differs_from_live_and_is_edited_key_by_key(self):
        self.adopt()
        spec = self.h['envFiles']['backend']
        live, staged = self.fake.read(spec['path']), self.fake.read(spec['staged'])
        self.assertNotEqual(H.parse_env(live).keys(), H.parse_env(staged).keys())
        rc, answer = self.step('env-set', '--files', 'backend', '--key', 'COMMUNITY_OPERATOR_AI_TOKEN', '--generate', 'token64')
        self.assertEqual(answer['status'], 'ENV_SET', answer)
        new_live, new_staged = H.parse_env(self.fake.read(spec['path'])), H.parse_env(self.fake.read(spec['staged']))
        self.assertEqual(new_live['COMMUNITY_OPERATOR_AI_TOKEN'], new_staged['COMMUNITY_OPERATOR_AI_TOKEN'])
        self.assertEqual(len(new_live['COMMUNITY_OPERATOR_AI_TOKEN']), 64)
        self.assertNotIn(new_live['COMMUNITY_OPERATOR_AI_TOKEN'], '\n'.join(self.outputs) + self.state_text())
        self.assertEqual(set(new_live) - {'COMMUNITY_OPERATOR_AI_TOKEN'}, set(H.parse_env(live)) - {'COMMUNITY_OPERATOR_AI_TOKEN'})

    def test_refusals(self):
        self.adopt()
        key = self.h['envFiles']['web']['keys'][0]
        rows = [
            (['--files', 'web', '--key', 'lower', '--generate', 'token64'], 'ENV_KEY_SHAPE'),
            (['--files', 'nope', '--key', key, '--generate', 'token64'], 'ENV_FILES'),
            (['--files', 'web,web', '--key', key, '--generate', 'token64'], 'ENV_FILES'),
            (['--files', 'web', '--key', key], 'ENV_VALUE_SOURCE'),
            (['--files', 'web', '--key', key, '--generate', 'token32'], 'GENERATE_KIND'),
            (['--files', 'web', '--key', 'BRAND_NEW_KEY', '--generate', 'token64'], 'ENV_KEY_ABSENT:BRAND_NEW_KEY'),
            (['--files', 'web', '--key', key, '--value-inbox', '/etc/passwd'], 'INBOX_PATH'),
        ]
        before = self.files()
        for argv, code in rows:
            rc, value = self.step('env-set', *argv)
            self.assertEqual((rc, value['code']), (2, code), argv)
        self.assertEqual(before, self.files())
        for bad in ('two\nlines', '"quoted"', ' padded'):
            path = self.h['paths']['state'] + '/inbox/bad.value'
            self.fake.write(path, bad, 0o600)
            rc, value = self.step('env-set', '--files', 'web', '--key', key, '--value-inbox', path)
            self.assertEqual(value['code'], 'ENV_VALUE_SHAPE')
            self.assertFalse(os.path.exists(self.fake.P(path)))
        path = self.h['paths']['state'] + '/inbox/open.value'
        self.fake.write(path, 'abc', 0o644)
        rc, value = self.step('env-set', '--files', 'web', '--key', key, '--value-inbox', path)
        self.assertEqual(value['code'], 'INBOX_FILE_SHAPE')
        rc, value = self.step('env-set', '--files', 'web', '--key', 'BRAND_NEW_KEY', '--generate', 'token64', '--add')
        self.assertEqual(value['status'], 'ENV_SET')
        self.assertEqual(self.files()[self.h['envFiles']['web']['path']].count(b'BRAND_NEW_KEY='), 1)

    def test_a_repeated_key_refuses(self):
        self.adopt()
        spec = self.h['envFiles']['web']
        key = spec['keys'][0]
        self.fake.write(spec['staged'], self.fake.read(spec['staged']) + ('%s=again\n' % key).encode(), 0o600)
        self.step('adopt')
        rc, value = self.step('env-set', '--files', 'web', '--key', key, '--generate', 'token64')
        self.assertEqual(value['code'], 'ENV_KEY_REPEATED:' + key)


class SwitchFailures(HostCase):
    def assert_back_on_live(self, services):
        for service in services:
            self.assertEqual(self.cwd(service), self.live_cwd(service), service)
            self.assertEqual(self.fake.unit(service)['state'], 'active', service)
        head = self.ledger()[-1]
        self.assertEqual(head['op'], 'adopt')
        for service, item in head['services'].items():
            self.assertEqual(H.sha_real(self.fake.P(item['pinFile'])), item['pinSha256'], service)

    def test_second_service_fails_to_start_both_come_back(self):
        self.adopt()
        plan = self.release()
        self.fake.set(failStart={self.h['services']['web']['unit']: 1})
        rc, value = self.step('switch', '--services', 'admin,web', '--plan', plan)
        self.assertEqual((rc, value['status']), (3, 'ROLLED_BACK'), value)
        self.assertTrue(value['failure'].startswith('DID_NOT_START'), value)
        self.assert_back_on_live(['admin', 'web'])

    def failing_admin(self, knob, code):
        self.adopt()
        plan = self.release()
        self.fake.set(**knob)
        rc, value = self.step('switch', '--services', 'web,admin', '--plan', plan)
        self.assertEqual(value['status'], 'ROLLED_BACK', value)
        self.assertTrue(value['failure'].startswith(code), value)
        self.assert_back_on_live(['web'])

    def test_a_restart_loop_rolls_back(self):
        self.failing_admin({'restartLoop': [self.h['services']['admin']['unit'], NEW[:8]]}, 'RESTARTING')

    def test_a_probe_that_never_answers_rolls_back(self):
        self.failing_admin({'probeFail': {'admin': NEW[:8]}}, 'READY_TIMEOUT')

    def test_daemon_reload_failure_puts_the_pins_back(self):
        self.adopt()
        plan = self.release()
        self.fake.set(daemonReloadFail=True)
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['status'], 'ROLLBACK_FAILED', value)          # the undo's own daemon-reload fails too
        self.assertEqual(value['failure'], 'DAEMON_RELOAD')
        pin = self.h['live']['web']['pinFile']
        self.assertEqual(H.sha_real(self.fake.P(pin)), self.ledger()[-1]['services']['web']['pinSha256'])

    def test_sigterm_mid_switch_rolls_back(self):
        self.adopt()
        plan = self.release()
        self.fake.set(sleepOnStart=self.h['services']['admin']['unit'])
        env = dict(os.environ, **self.fake.env())
        child = subprocess.Popen([sys.executable, '-I', str(HERE.parent / 'release_host.py'), 'switch', '--run-id', 'sig-1',
                                  '--services', 'web,admin', '--plan', plan], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and self.fake.state().get('sleeping') != self.h['services']['admin']['unit']:
            time.sleep(0.05)
        self.assertEqual(self.fake.state().get('sleeping'), self.h['services']['admin']['unit'])
        child.send_signal(signal.SIGTERM)
        out, err = child.communicate(timeout=60)
        value = json.loads(out.decode().splitlines()[-1])
        self.outputs.append(out.decode())
        self.assertEqual((child.returncode, value['status'], value['failure']), (3, 'ROLLED_BACK', 'SIGTERM'), err)
        self.fake.set(sleeping=None)
        self.assert_back_on_live(['web', 'admin'])

    def test_a_start_that_hangs_ends_when_the_unit_is_touched_again(self):
        # What the SIGTERM tests stand on: as systemd, a later job on the unit replaces the pending start job, which
        # answers failure at once, not after the hang.
        unit = self.h['services']['admin']['unit']
        self.fake.set(sleepOnStart=unit)
        began = time.monotonic()
        starter = subprocess.Popen([str(self.fake.bin / 'systemctl'), 'start', unit])
        while time.monotonic() < began + 30 and self.fake.state().get('sleeping') != unit:
            time.sleep(0.05)
        self.fake.systemctl('stop', unit)
        self.assertEqual(starter.wait(timeout=60), 1)
        self.assertLess(time.monotonic() - began, 20)
        self.fake.set(sleeping=None)

    def test_rollback_that_fails_part_way_returns_to_the_head(self):
        self.adopt()
        plan = self.release()
        self.step('switch', '--services', 'web,admin', '--plan', plan)
        self.fake.set(failStart={self.h['services']['web']['unit']: 1})
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual(value['status'], 'ROLLED_BACK_TO_HEAD', value)
        self.assertEqual(self.cwd('web'), self.new_cwd('web'))
        self.assertEqual(self.cwd('admin'), self.new_cwd('admin'))
        rc, value = self.step('verify')
        self.assertEqual(value['status'], 'PASS', value)


class Refusals(HostCase):
    def test_before_any_entry(self):
        for argv in (['switch', '--services', 'web'], ['rollback', '--to', 'previous'], ['verify'],
                     ['close-out', '--as', 'accepted'], ['env-set', '--files', 'web', '--key', 'NODE_ENV', '--generate', 'token64']):
            rc, value = self.step(*argv)
            self.assertEqual(rc, 2, argv)
            self.assertTrue(value['code'].startswith('LEDGER_EMPTY'), (argv, value))

    def test_step_shape_refusals(self):
        self.adopt()
        plan = self.release()
        rows = [
            (['switch', '--run-id', 'bad id', '--services', 'web'], 'RUN_ID'),
            (['switch', '--run-id', 'x1', '--services', 'nope'], 'SERVICES'),
            (['switch', '--run-id', 'x2', '--services', 'web,web'], 'SERVICES'),
            (['switch', '--run-id', 'x3', '--services', 'backend', '--plan', plan], 'SERVICE_NOT_IN_PLAN'),
            (['switch', '--run-id', 'x4', '--services', 'web', '--plan', 'notahexid'], 'PLAN_ID'),
            (['switch', '--run-id', 'x5', '--services', 'web', '--plan', '0123456789abcdef'], 'PLAN_NOT_STAGED:0123456789abcdef'),
            (['rollback', '--run-id', 'x6', '--to', 'yesterday'], 'ROLLBACK_TO'),
            (['close-out', '--run-id', 'x7', '--as', 'maybe'], 'CLOSE_OUT_AS'),
            (['nonsense'], 'USAGE'),
        ]
        for argv, code in rows:
            rc, value = self.call(*argv)
            self.assertEqual((rc, value['code']), (2, code), argv)
        rc, value = self.call('switch', '--run-id', 'x1', '--services', 'web')
        self.assertEqual(value['code'], 'RUN_ID_USED')

    def test_lock_held(self):
        self.adopt()
        import fcntl
        fd = os.open(self.fake.P(self.h['paths']['lock']), os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            rc, value = self.step('switch', '--services', 'web')
            self.assertEqual(value['code'], 'DEPLOY_LOCK_HELD')
        finally:
            os.close(fd)

    def test_reserved_window_and_timer_guards(self):
        self.adopt()
        env = self.fake.env()
        env.pop('RELEASE_TEST_IGNORE_CLOCK')
        now = time.gmtime()
        minute = now.tm_hour * 60 + now.tm_min
        profile = json.loads(self.fake.host_profile.read_text())
        profile['reservedUtc'] = [max(0, minute - 1), min(1439, minute + 1)]
        self.fake.host_profile.write_text(json.dumps(profile))
        rc, value = self.call('switch', '--run-id', 'w1', '--services', 'web', env=env)
        self.assertEqual(value['code'], 'RESERVED_UTC_WINDOW')
        guard = self.h['timerGuards'][0]
        self.fake.set(units=dict(self.fake.state()['units'], **{guard['service']: {'state': 'active', 'pid': 9}}))
        rc, value = self.step('switch', '--services', 'web')
        self.assertEqual(value['code'], 'TIMER_SERVICE_ACTIVE:' + guard['service'])

    def test_not_on_the_ledger_root(self):
        self.adopt()
        self.fake.systemctl('stop', self.h['services']['admin']['unit'])
        rc, value = self.step('switch', '--services', 'admin')
        self.assertEqual(value['code'], 'NOT_ON_LEDGER_ROOT:admin')

    def test_switch_before_prepare_and_after_a_root_changed(self):
        self.adopt()
        plan = self.fake.release(NEW, {'web': 'root'})
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['code'], 'PREPARE_NOT_DONE:' + plan)
        self.step('prepare', '--plan', plan)
        entry = '%s/%s/web/%s/entry.js' % (self.h['paths']['runtime'], NEW[:8], self.h['services']['web']['cwd'])
        os.chmod(self.fake.P(entry), 0o644)
        pathlib.Path(self.fake.P(entry)).write_text('tampered\n')
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertTrue(value['code'].startswith('PREPARED_ROOT_CHANGED:web:ROOT_'), value)
        self.assertEqual(self.cwd('web'), self.live_cwd('web'))

    def test_a_pin_naming_a_path_prepare_did_not_make(self):
        self.adopt()
        plan = self.release()
        union = '%s/%s/static-compat/web' % (self.h['paths']['runtime'], NEW[:8])
        import shutil
        shutil.rmtree(self.fake.P(union))
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['code'], 'PIN_PATH_MISSING:web:' + union)
        self.assertEqual(self.fake.unit('web')['starts'], 1)                    # nothing was stopped

    def test_pin_changed_since_prepare(self):
        self.adopt()
        plan = self.release()
        pin = self.h['live']['web']['pinFile']
        self.fake.write(pin, self.fake.read(pin) + b'# a comment added by hand\n')
        self.step('adopt')
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['code'], 'PIN_CHANGED_SINCE_PREPARE:web')

    def test_adopt_refuses_a_live_state_unlike_the_profile(self):
        self.fake.systemctl('stop', self.h['services']['web']['unit'])
        rc, value = self.step('adopt')
        self.assertEqual(value['code'], 'ADOPT_LIVE_MISMATCH:web')
        self.fake.systemctl('start', self.h['services']['web']['unit'])
        pin = self.h['live']['admin']['pinFile']
        self.fake.write(pin, self.fake.read(pin) + ('ReadOnlyPaths=%s\n' % self.h['live']['admin']['root']).encode())
        rc, value = self.step('adopt')
        self.assertTrue(value['code'].startswith('ADOPT_PIN_COUNT:admin:set profile.live'), value['code'])

    def test_find_pin_refusals(self):
        live = self.h['live']['web']
        folder = os.path.dirname(live['pinFile'])
        cwd = self.live_cwd('web')
        self.fake.write(folder + '/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-late.conf',
                        '[Service]\nWorkingDirectory=/elsewhere\n')
        rc, value = self.step('adopt')
        self.assertEqual(value['code'], 'PIN_NOT_LAST:web:WorkingDirectory')
        os.unlink(self.fake.P(folder + '/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-late.conf'))
        self.fake.write(folder + '/50-copy.conf', '[Service]\nWorkingDirectory=%s\n' % cwd)
        rc, value = self.step('adopt')
        self.assertEqual(value['code'], 'PIN_COUNT:web:2')

    def test_render_pin_is_exact(self):
        H.configure(self.fake.env())
        text = self.fake.pin_text('web', 'aaaa1111', '/srv/x/aaaa1111/web').encode()
        count = H.label_count(text.decode(), 'aaaa1111')
        rendered = H.render_pin('web', text, 'aaaa1111', 'ffff9999', count)
        self.assertEqual(H.label_count(rendered.decode(), 'ffff9999'), count)
        self.assertIn(b'# release pin written at aaaa1111', rendered)            # comments stay
        for bad, code in ((text + b'Environment=X=aaaa1111\n', 'PIN_KEY:Environment'),
                          (text.replace(b'ffff', b'') + b'ReadOnlyPaths=/srv/x/ffff9999\n', 'PIN_ALREADY_NEW:web')):
            with self.assertRaises(H.Refusal) as caught:
                H.render_pin('web', bad, 'aaaa1111', 'ffff9999', H.label_count(text.decode(), 'aaaa1111'))
            self.assertEqual(str(caught.exception), code)
        with self.assertRaises(H.Refusal) as caught:
            H.render_pin('web', text, 'aaaa1111', 'ffff9999', count + 1)
        self.assertEqual(str(caught.exception), 'PIN_TOKEN_COUNT:web:%d' % count)

    def test_payload_refusals(self):
        self.adopt()
        plan = self.fake.release(NEW, {'web': 'root'})
        build = json.loads(self.fake.read(self.h['paths']['state'] + '/plans/%s/build.json' % plan))
        folder = self.h['paths']['state'] + '/payloads/' + build['payloadId']
        blobs = sorted(os.listdir(self.fake.P(folder + '/blobs')))
        os.rename(self.fake.P(folder + '/blobs/' + blobs[0]), self.fake.P(folder + '/blobs/' + blobs[0] + '.x'))
        rc, value = self.step('prepare', '--plan', plan)
        self.assertTrue(value['code'].startswith('BLOB_MISSING:'), value)
        os.rename(self.fake.P(folder + '/blobs/' + blobs[0] + '.x'), self.fake.P(folder + '/blobs/' + blobs[0]))
        manifest = folder + '/manifests/web.json'
        self.fake.write(manifest, self.fake.read(manifest) + b' ', 0o600)
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual(value['code'], 'MANIFEST_SHA:web')
        plan_file = self.h['paths']['state'] + '/plans/%s/plan.json' % plan
        self.fake.write(plan_file, self.fake.read(plan_file) + b'\n', 0o600)
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual(value['code'], 'PLAN_SHA')

    def test_a_live_file_that_moved_is_not_linked(self):
        self.adopt()
        plan = self.fake.release(NEW, {'web': 'root'})
        base = '%s/package.json' % self.h['live']['web']['root']
        os.chmod(self.fake.P(base), 0o644)
        pathlib.Path(self.fake.P(base)).write_text('{"name":"moved"}')
        os.chmod(self.fake.P(base), 0o444)
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual(value['code'], 'BASE_DIFFERS:package.json')

    def test_static_union_collision(self):
        self.adopt()
        plan = self.fake.release(NEW, {'web': 'root'})
        union = '%s/%s/static-compat/web/chunks/%s.js' % (self.h['paths']['runtime'], self.h['live']['web']['label'], NEW[:8])
        self.fake.write(union, 'other bytes\n')
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual(value['code'], 'STATIC_UNION_COLLISION:chunks/%s.js' % NEW[:8])

    def test_a_stop_that_hangs_is_refused_and_undone(self):
        self.adopt()
        plan = self.release()
        self.fake.set(stopHangs=self.h['services']['web']['unit'])
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['failure'], 'DID_NOT_STOP:' + self.h['services']['web']['unit'], value)
        self.fake.set(stopHangs=None)
        pin = self.h['live']['web']['pinFile']
        self.assertEqual(H.sha_real(self.fake.P(pin)), self.ledger()[-1]['services']['web']['pinSha256'])

    def test_timer_times_that_cannot_be_read_refuse(self):
        self.adopt()
        guard = self.h['timerGuards'][0]
        timers = self.fake.state()['timers']
        timers[guard['timer']]['next'] = None
        self.fake.set(timers=timers)
        rc, value = self.step('switch', '--services', 'web')
        self.assertEqual(value['code'], 'TIMER_TIMES_UNKNOWN:' + guard['timer'])

    def test_a_missing_live_union_refuses_prepare(self):
        self.adopt()
        plan = self.fake.release(NEW, {'web': 'root'})
        import shutil
        live = '%s/%s/static-compat/web' % (self.h['paths']['runtime'], self.h['live']['web']['label'])
        shutil.rmtree(self.fake.P(live))
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual(value['code'], 'UNION_SOURCE_MISSING:' + live)

    def test_manifest_service_refusal(self):
        rc, value = self.call('manifest', '--service', 'nope')
        self.assertEqual(value['code'], 'SERVICE')


class HostBehaviours(HostCase):
    """Six host behaviours the tool must handle, each reproduced on the fake host and its handling pinned."""

    def test_app_role_is_read_from_the_profiles_app_role_key(self):
        rc, value = self.call('baseline')
        self.assertEqual(value['appRole'], {'key': self.h['database']['appRole']['key'], 'role': fakehost.APP_ROLE})
        self.assertIn('DATABASE_URL', value['envFiles']['backend']['live']['keys'])       # the decoy is there

    def test_cms_ledger_uses_the_app_migration_ca(self):
        rc, value = self.call('baseline')
        self.assertIn('names', value['ledgers']['cms'], value['ledgers'])
        operator = json.loads(self.fake.read(self.h['paths']['operator']))
        self.assertNotIn(self.h['database']['operatorCms']['ca'], operator)
        log = [json.loads(l) for l in pathlib.Path(self.fake.root, 'stub-psql.log').read_text().splitlines()]
        self.assertTrue(all(r['ca'] == self.fake.P(operator[self.h['database']['caFallback']]) for r in log), log)
        self.assertTrue(all(r['readOnly'] for r in log))
        del operator[self.h['database']['caFallback']]
        self.fake.write(self.h['paths']['operator'], json.dumps(operator), 0o600)
        rc, value = self.call('baseline')
        self.assertEqual(value['ledgers']['cms']['code'], 'DATABASE_CA_MISSING:cms')

    def test_systemd_times_are_read_in_utc(self):
        self.assertIsNone(H.stamp_seconds('Thu 2026-11-05 06:00:00 ZZT'))
        self.assertEqual(H.stamp_seconds('Thu 2026-11-05 06:00:00 UTC'), 1793858400)
        self.adopt()
        guard = self.h['timerGuards'][0]
        timers = self.fake.state()['timers']
        timers[guard['timer']]['next'] = int(time.time()) + 600
        self.fake.set(timers=timers)
        rc, value = self.step('switch', '--services', 'web')
        self.assertEqual(value['code'], 'TIMER_TOO_CLOSE:' + guard['timer'])     # not TIMER_TIMES_UNKNOWN: read in UTC
        rc, value = self.call('baseline')
        self.assertAlmostEqual(value['timers'][0]['minutesAway'], 10, delta=1)

    def test_manifests_leave_parent_directories_implicit(self):
        rows = json.loads(self.fake.manifests['web'])['files']
        paths = {r['path'] for r in rows}
        deep = next(p for p in paths if p.endswith('lib/deep/one.js'))
        self.assertNotIn(os.path.dirname(deep), paths)
        self.adopt()
        self.release(modes={'web': 'root'})
        H.configure(self.fake.env())
        root = '%s/%s/web' % (self.h['paths']['runtime'], NEW[:8])
        raw = self.fake.read(root + '/runtime-manifest.json')
        H.verify_root(raw, root)
        os.makedirs(self.fake.P(root + '/stray'))
        with self.assertRaises(H.Refusal) as caught:
            H.verify_root(raw, root)
        self.assertEqual(str(caught.exception), 'ROOT_EXTRA:stray')

    def test_an_old_nginx_worker_answers_until_the_settle_wait(self):
        H.configure(self.fake.env(RELEASE_TIME_SCALE='0.2'))         # a settle wait of 0.6 s
        apex = self.h['checks']['apex']
        site = self.h['paths']['nginxSite']
        self.fake.set(staleSeconds=0.3)
        new = self.fake.read(site) + b'location = /r1-settle-check { return 200; }\n'
        before = H.nginx_write(new, {H.sha_bytes(self.fake.read(site))})
        self.assertEqual(H.curl('https://%s/r1-settle-check' % apex, resolve='%s:443:127.0.0.1' % apex, insecure=True)['code'],
                         '200')
        # Stale for far longer than any probe takes, however loaded the machine: the old worker is still there.
        self.fake.set(staleSeconds=60)
        H.PROFILE['settleSeconds'] = 0
        H.nginx_write(before, {H.sha_bytes(new)})
        self.assertEqual(H.curl('https://%s/r1-settle-check' % apex, resolve='%s:443:127.0.0.1' % apex, insecure=True)['code'],
                         '200', 'with no wait the old worker still answers from the previous configuration')
        broken = before + b'BROKEN\n'
        with self.assertRaises(H.Refusal) as caught:
            H.nginx_write(broken, {H.sha_bytes(before)})
        self.assertEqual(str(caught.exception), 'NGINX_TEST_FAILED')
        self.assertEqual(self.fake.read(site), before)
        with self.assertRaises(H.Refusal) as caught:
            H.nginx_write(new, {'0' * 64})
        self.assertEqual(str(caught.exception), 'NGINX_FILE_DRIFT')

    def test_the_report_queue_is_asked_without_a_query(self):
        self.adopt()
        rc, value = self.step('verify')
        self.assertEqual(value['reportQueue']['withToken'], '200', value)
        url = self.h['checks']['reportQueue']['url']
        asked = [u for m, u in self.fake.state()['curl'] if u.startswith(url)]
        self.assertTrue(asked and all('?' not in u for u in asked))
        H.configure(self.fake.env())
        self.assertEqual(H.curl(url + '?limit=1')['code'], '400')


OUTSIDE = 'eeee5555' + '0123456789abcdef0123456789abcdef'
REBASELINE = 'run adopt --rebaseline'


class Rebaseline(HostCase):
    def test_a_root_moved_outside_the_tool_is_named_by_every_verb_until_adopt_rebaseline(self):
        self.adopt()
        plan = self.release(modes={'web': 'root'})
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['status'], 'SWITCHED', value)
        root = self.fake.outside_release('backend', OUTSIDE[:8], OUTSIDE)
        staged = self.fake.release(NEWER, {'admin': 'root'})
        code = 'ROOT_MOVED:backend:' + REBASELINE
        for argv in (['switch', '--services', 'admin'], ['prepare', '--plan', staged], ['rollback', '--to', 'previous'],
                     ['env-set', '--files', 'web', '--key', self.h['envFiles']['web']['keys'][0], '--generate', 'token64'],
                     ['close-out', '--as', 'accepted'], ['adopt']):
            rc, value = self.step(*argv)
            self.assertEqual((rc, value.get('code')), (2, code), argv)
        rc, value = self.step('verify')
        self.assertEqual((rc, value['status'], value['hint']), (2, 'FAIL', REBASELINE), value)
        self.assertIn('ROOT_MOVED:backend', value['failures'])
        for command in ('baseline', 'status', 'facts'):
            rc, value = self.call(command)
            self.assertEqual((value['rootMoved'], value['hint']), (['backend'], REBASELINE), command)
        rc, value = self.step('adopt', '--rebaseline')
        self.assertEqual((rc, value['status'], value['rebaselined']), (0, 'ADOPTED', ['backend']), value)
        head = self.ledger()[-1]
        self.assertEqual((head['op'], head['base']), ('adopt', None))                  # stays a rollback barrier
        self.assertEqual({k: head['services']['backend'][k] for k in ('label', 'commit', 'root')},
                         {'label': OUTSIDE[:8], 'commit': OUTSIDE, 'root': root})
        self.assertEqual(head['services']['web']['label'], NEW[:8])
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')
        self.assertEqual(self.step('rollback', '--to', 'previous')[1]['code'], 'NO_PREVIOUS:ADOPT_BARRIER')
        self.assertEqual(self.step('prepare', '--plan', staged)[1]['status'], 'PREPARED')
        rc, value = self.step('switch', '--services', 'admin', '--plan', staged)
        self.assertEqual(value['status'], 'SWITCHED', value)
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual(value['status'], 'ROLLED_BACK', value)
        self.assertEqual(self.cwd('admin'), self.live_cwd('admin'))
        self.assertEqual(self.cwd('backend'), root + ('/' + self.h['services']['backend']['cwd']
                                                     if self.h['services']['backend'].get('cwd') else ''))
        self.assertTrue(self.step('rollback', '--to', 'previous')[1]['code'].startswith('NO_PREVIOUS:'))


class ProfileGrowth(HostCase):
    def test_a_service_and_an_env_file_added_after_the_first_adopt_are_named_then_adopted(self):
        full = json.loads(self.fake.host_profile.read_text())
        small = json.loads(json.dumps(full))
        for key in ('services', 'live', 'envFiles'):
            small[key].pop('web')
        small['restartOrder'] = [s for s in small['restartOrder'] if s != 'web']
        self.fake.host_profile.write_text(json.dumps(small))
        self.adopt()
        self.fake.host_profile.write_text(json.dumps(full))           # the reinstalled, grown profile
        gaps = ['web', 'ENV:web']
        rc, value = self.call('baseline')
        self.assertEqual((value['status'], value['notAdopted']), ('BASELINE', gaps))
        self.assertEqual(value['pins']['web'], {'status': 'REFUSED', 'code': 'NOT_ADOPTED:web:run adopt'})
        self.assertEqual(self.call('facts')[1]['notAdopted'], gaps)
        plan = self.fake.release(NEW, {'web': 'root'})
        for argv in (['switch', '--services', 'web', '--plan', plan], ['switch', '--services', 'admin'],
                     ['prepare', '--plan', plan], ['env-set', '--files', 'admin', '--key', 'NODE_ENV', '--generate', 'token64']):
            rc, value = self.step(*argv)
            self.assertEqual((rc, value.get('code')), (2, 'NOT_ADOPTED:web,ENV:web:run adopt'), argv)
        rc, value = self.step('verify')
        self.assertEqual(value['status'], 'FAIL', value)
        self.assertTrue({'NOT_ADOPTED:web', 'NOT_ADOPTED:ENV:web'} <= set(value['failures']), value)
        rc, value = self.step('adopt')
        self.assertEqual((rc, value['status'], value['added']), (0, 'ADOPTED', gaps), value)
        head = self.ledger()[-1]
        self.assertEqual(head['services']['web']['cwd'], self.live_cwd('web'))
        self.assertIn('web', head['envFiles'])
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')
        self.assertEqual(self.step('prepare', '--plan', plan)[1]['status'], 'PREPARED')
        rc, value = self.step('switch', '--services', 'web', '--plan', plan)
        self.assertEqual(value['status'], 'SWITCHED', value)
        self.assertEqual(self.cwd('web'), self.new_cwd('web'))


class PlanLess(HostCase):
    def test_a_switch_without_its_plan_never_passes_for_the_release(self):
        self.adopt()
        plan = self.release()                                   # web and admin to new roots, the issuer restarted
        code = 'PLAN_PENDING:admin:%s:pass --plan' % plan
        rc, value = self.step('switch', '--services', 'admin')              # prepared since the head
        self.assertEqual((rc, value.get('code')), (2, code), value)
        self.assertEqual(self.step('switch', '--services', 'web', '--plan', plan)[1]['status'], 'SWITCHED')
        rc, value = self.step('switch', '--services', 'issuer,admin')       # the head's plan still moves admin
        self.assertEqual((rc, value.get('code')), (2, code), value)
        self.assertEqual(self.cwd('admin'), self.live_cwd('admin'))
        rc, value = self.step('switch', '--services', 'issuer,admin', '--plan', plan)
        self.assertEqual(value['status'], 'SWITCHED', value)
        self.assertEqual(self.cwd('admin'), self.new_cwd('admin'))
        rc, value = self.step('switch', '--services', 'admin')              # nothing pending: a restart, said so
        self.assertEqual((rc, value['status']), (0, 'RESTARTED'), value)
        self.assertEqual(self.cwd('admin'), self.new_cwd('admin'))


class AfterCommit(HostCase):
    def test_an_error_after_the_ledger_line_is_written_is_not_undone(self):
        self.adopt()
        plan = self.release()
        original = H.ledger_append

        def written_then_failed(op, *args, **kwargs):
            original(op, *args, **kwargs)
            raise OSError(5, 'fsync failed after the write')

        inbox = self.h['paths']['state'] + '/inbox/c.value'
        self.fake.write(inbox, '[{"clientId":"https://client.example.invalid/c","family":"cursor"}]', 0o600)
        H.ledger_append = written_then_failed
        try:
            rc, value = self.step('env-set', '--files', 'admin,issuer', '--key', 'AGENT_AUTHORIZATION_CLIENTS',
                                  '--value-inbox', inbox, '--plan', plan)
            self.assertEqual((rc, value['status'], value.get('warnings')),
                             (0, 'ENV_SET', ['AFTER_COMMIT:UNEXPECTED:OSError']), value)
            rc, value = self.step('switch', '--services', 'web,issuer,admin', '--plan', plan)
            self.assertEqual((rc, value['status'], value.get('warnings')),
                             (0, 'SWITCHED', ['AFTER_COMMIT:UNEXPECTED:OSError']), value)
        finally:
            H.ledger_append = original
        self.assertEqual((self.cwd('web'), self.cwd('admin')), (self.new_cwd('web'), self.new_cwd('admin')))
        self.assertEqual([e['op'] for e in self.ledger()], ['adopt', 'env-set', 'switch'])
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')                  # nothing is wedged
        H.ledger_append = written_then_failed
        try:
            rc, value = self.step('rollback', '--to', 'previous')
        finally:
            H.ledger_append = original
        self.assertEqual((rc, value['status']), (0, 'ROLLED_BACK'), value)
        self.assertEqual(self.cwd('web'), self.live_cwd('web'))
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')


class EnvUndo(HostCase):
    KEY = 'AGENT_AUTHORIZATION_CLIENTS'

    def files(self):
        return {spec[w]: self.fake.read(spec[w]) for spec in self.h['envFiles'].values() for w in ('path', 'staged')
                if spec.get(w)}

    def env_set_with(self, script):
        """env-set admin,issuer with write_like failing as `script` says: {path: [action per call]}, each action ok,
        raise (nothing written) or after (written, then an error)."""
        calls, original = {}, H.write_like

        def scripted(path, raw):
            calls[path] = calls.get(path, 0) + 1
            actions = script.get(path, [])
            action = actions[calls[path] - 1] if calls[path] <= len(actions) else 'ok'
            if action == 'raise':
                raise OSError(5, 'injected before the write')
            original(path, raw)
            if action == 'after':
                raise OSError(5, 'injected after the write')

        H.write_like = scripted
        try:
            return self.step('env-set', '--files', 'admin,issuer', '--key', self.KEY, '--generate', 'token64')
        finally:
            H.write_like = original

    def test_the_verdict_is_the_bytes(self):
        self.adopt()
        before = self.files()
        admin, issuer = self.h['envFiles']['admin'], self.h['envFiles']['issuer']
        # The third write fails; the undo meets an error on a file it did put back: every byte is back.
        rc, value = self.env_set_with({issuer['path']: ['raise'], admin['staged']: ['ok', 'after']})
        self.assertEqual((rc, value['status']), (3, 'ROLLED_BACK'), value)
        self.assertTrue(value['problems'], value)
        self.assertEqual(self.files(), before)
        # The undo cannot put one file back: a byte differs, and only then ROLLBACK_FAILED.
        rc, value = self.env_set_with({issuer['path']: ['raise'], admin['path']: ['ok', 'raise']})
        self.assertEqual((rc, value['status']), (4, 'ROLLBACK_FAILED'), value)
        self.assertNotEqual(self.fake.read(admin['path']), before[admin['path']])
        self.assertEqual(self.ledger()[-1]['op'], 'adopt')

    def test_a_hard_linked_env_file_refuses_before_any_write(self):
        self.adopt()
        before = self.files()
        target = self.h['envFiles']['issuer']['path']
        os.link(self.fake.P(target), self.fake.P(target) + '.second-name')
        rc, value = self.step('env-set', '--files', 'admin,issuer', '--key', self.KEY, '--generate', 'token64')
        self.assertEqual((rc, value.get('code')), (2, 'NOT_A_PLAIN_FILE:' + target), value)
        self.assertEqual(self.files(), before)

    def test_values_are_read_as_systemd_reads_them(self):
        cases = [
            (b'A=plain\n', {'A': 'plain'}),
            (b'A=a\\b\n', {'A': 'ab'}),
            (b'A="a\\"b"\n', {'A': 'a"b'}),
            (b'A="a\\qb"\n', {'A': 'a\\qb'}),
            (b"A='a\\b'\n", {'A': 'a\\b'}),
            (b'A=one\\\ntwo\n', {'A': 'onetwo'}),
            (b'A="x" y  \n', {'A': 'xy'}),
            (b'  A = spaced \t\n', {'A': 'spaced'}),
            (b'export A=1\n', {}),
            (b'# A=1\n;B=2\nC=#3\n', {'C': '#3'}),
            (b'A=1\nA=2\n', {'A': '2'}),
            (b'1A=x\nA-B=y\nNOEQUALS\n', {}),
            (b'A=\nB="unterminated', {'A': '', 'B': 'unterminated'}),
        ]
        for raw, want in cases:
            self.assertEqual(H.parse_env(raw), want, raw)
        self.adopt()
        before = self.files()
        key = self.h['envFiles']['web']['keys'][0]
        for bad in ('a\\b', '{"a":"x\\"y"}', 'C:\\path'):
            path = self.h['paths']['state'] + '/inbox/backslash.value'
            self.fake.write(path, bad, 0o600)
            rc, value = self.step('env-set', '--files', 'web', '--key', key, '--value-inbox', path)
            self.assertEqual((rc, value.get('code')), (2, 'ENV_VALUE_NOT_READ_BACK:' + key), bad)
        self.assertEqual(self.files(), before)


class CloseOutRoots(HostCase):
    def test_close_out_never_lists_a_root_anything_still_uses(self):
        self.adopt()
        for spec in self.h.get('untouched', {}).values():
            os.makedirs(self.fake.P(spec['cwd']), exist_ok=True)
        stale = '%s/zzzz9999/web' % self.h['paths']['runtime']
        os.makedirs(self.fake.P(stale))
        plan = self.release()
        self.assertEqual(self.step('switch', '--services', 'web,admin', '--plan', plan)[1]['status'], 'SWITCHED')
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')
        rc, value = self.step('close-out', '--as', 'accepted')
        self.assertEqual(value['status'], 'CLOSED_OUT', value)
        live = [spec['cwd'] for spec in self.h.get('untouched', {}).values()]
        live += [self.cwd(s) for s in self.h['services']]
        for path in live:
            self.assertEqual([r for r in value['removable'] if path == r or path.startswith(r + '/')], [], path)
        self.assertIn(stale, value['removable'])


class Guards(HostCase):
    def test_the_timer_guard_fails_closed(self):
        self.adopt()
        guard = self.h['timerGuards'][0]
        for knobs, unit in (({'showFails': [guard['timer']]}, guard['timer']),
                            ({'showFails': [guard['service']]}, guard['service'])):
            self.fake.set(**knobs)
            rc, value = self.step('switch', '--services', 'web')
            self.assertEqual((rc, value.get('code')), (2, 'TIMER_STATE_UNKNOWN:' + unit), value)
        timers = self.fake.state()['timers']
        known = timers.pop(guard['timer'])
        self.fake.set(showFails=[], timers=timers)                  # a timer systemd does not know
        rc, value = self.step('switch', '--services', 'web')
        self.assertEqual((rc, value.get('code')), (2, 'TIMER_STATE_UNKNOWN:' + guard['timer']), value)
        self.fake.set(timers=dict(timers, **{guard['timer']: known}))
        self.assertEqual(self.step('switch', '--services', 'web')[1]['status'], 'RESTARTED')

    def test_a_later_drop_in_that_overrides_the_pin_refuses(self):
        pin = self.h['live']['web']['pinFile']
        unit = self.h['services']['web']['unit']
        late = os.path.dirname(pin) + '/' + 'z' * 75 + '-late.conf'
        for body, key in (('[Service]\nExecStart=\nExecStart=/usr/bin/node /elsewhere/entry.js\n', 'ExecStart'),
                          ('[Service]\nBindPaths=/elsewhere:/srv/somewhere\n', 'BindPaths'),
                          ('[Service]\nReadOnlyPaths=/elsewhere\n', 'ReadOnlyPaths')):
            self.fake.write(late, body)
            rc, value = self.step('adopt')
            self.assertEqual((rc, value.get('code')), (2, 'PIN_NOT_LAST:web:' + key), value)
        self.fake.write(late, '[Service]\nLimitNOFILE=4096\n')            # sets nothing the pin sets
        hidden = '/etc/systemd/system.control/%s.d/%s' % (unit, os.path.basename(pin))
        self.fake.write(hidden, '[Service]\nCPUWeight=50\n')
        rc, value = self.step('adopt')
        self.assertEqual((rc, value.get('code')), (2, 'PIN_NOT_LAST:web:HIDDEN'), value)
        os.unlink(self.fake.P(hidden))
        self.adopt()

    def test_a_profile_that_leaves_a_service_out_of_restart_order_refuses(self):
        profile = json.loads(self.fake.host_profile.read_text())
        profile['restartOrder'] = [s for s in profile['restartOrder'] if s != 'web']
        self.fake.host_profile.write_text(json.dumps(profile))
        for argv in (['status'], ['baseline'], ['adopt', '--run-id', 'p1']):
            rc, value = self.call(*argv)
            self.assertEqual((rc, value.get('code')), (2, 'PROFILE_RESTART_ORDER'), argv)


class RollbackDrift(HostCase):
    def test_rollback_refuses_drift_only_in_files_it_writes(self):
        self.adopt()
        plan = self.release()
        self.assertEqual(self.step('switch', '--services', 'web,admin', '--plan', plan)[1]['status'], 'SWITCHED')
        env = self.h['envFiles']['backend']['path']                 # rollback does not write it
        noted = self.fake.read(env) + b'# a note added by hand\n'
        self.fake.write(env, noted, 0o600)
        pin = self.h['live']['web']['pinFile']                       # rollback writes it
        rendered = self.fake.read(pin)
        self.fake.write(pin, rendered + b'# by hand\n')
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual((rc, value.get('code')), (2, 'DRIFT:PIN:web'), value)
        self.fake.write(pin, rendered)
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual((rc, value['status'], value['warnings']), (0, 'ROLLED_BACK', ['DRIFT:ENV:backend']), value)
        self.assertEqual(self.fake.read(env), noted)                 # left as it is
        self.assertEqual((self.cwd('web'), self.cwd('admin')), (self.live_cwd('web'), self.live_cwd('admin')))
        rc, value = self.step('verify')
        self.assertEqual(value['failures'], ['DRIFT:ENV:backend'])   # still drift, for adopt once the incident is over


RUNS, TARGETS, RUNS_SQL, TARGETS_SQL, GRANTS = (fakehost.RUNS, fakehost.TARGETS, fakehost.RUNS_SQL,
                                              fakehost.TARGETS_SQL, fakehost.GRANTS)
FAMILY_ROWS = ['public.r1b_runs', 'public.r1b_run_targets']
# What the synthetic grant file grants on objects that existed before the release: read back after it ran.
PRESENT = 9           # schema public USAGE, users S/I/U, mcp_control S/I/U, payload_migrations.name SELECT, users_id_seq USAGE
LAUNCHER = ('// the release\'s own launcher (synthetic)\nawait import("../services/catalog-postgres/dist/index.js");\n'
            'await import("../services/community-postgres/dist/index.js");\n').encode()


class MigrationCase(HostCase):
    """migrate on the fake host: the plan's CMS migrations each with its ledger row in one transaction, the runtime
    grants read back both ways, the backup rule, resuming after a failure, and switch held until migrate is done."""

    def staged(self, commit=NEW, cms=None, grant=GRANTS, modes=None, **extra):
        cms = cms or [(RUNS, fakehost.cms_source(RUNS_SQL)), (TARGETS, fakehost.cms_source(TARGETS_SQL))]
        plan = self.fake.release(commit, modes or {'backend': 'root', 'admin': 'root'}, cms=cms, grant=grant, **extra)
        rc, value = self.step('prepare', '--plan', plan)
        self.assertEqual((rc, value['status']), (0, 'PREPARED'), value)
        return plan

    def migrate(self, plan, family='cms', pitr=True):
        return self.step('migrate', '--plan', plan, '--family', family, *(['--pitr', 'confirmed'] if pitr else []))

    def writes(self, query=None):
        return [w for w in self.fake.state().get('writes', []) if query in (None, w['query'])]

    def starts(self):
        return {s: self.fake.unit(s).get('starts') for s in self.h['services']}

    def backups(self):
        folder = pathlib.Path(self.fake.P(self.h['paths']['state'] + '/backups'))
        return sorted(p.name for p in folder.iterdir()) if folder.exists() else []

    def acl(self, role=fakehost.CMS_RUNTIME):
        return self.fake.state()['acl'].setdefault(role, {})


class Migrations(MigrationCase):
    def test_each_cms_migration_runs_with_its_ledger_row_in_one_transaction(self):
        self.adopt()
        plan = self.staged()
        before = self.starts()
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status'], value['applied'], value['already']), (0, 'MIGRATED', [RUNS, TARGETS], []),
                         value)
        import release as R
        for write, (name, sql) in zip(self.writes('cms_migrate'), ((RUNS, RUNS_SQL), (TARGETS, TARGETS_SQL))):
            self.assertTrue(write['single'], 'one psql --single-transaction call')
            self.assertEqual(write['user'], 'r1_cms')                          # the CMS migration role
            self.assertIn('-c lock_timeout=5000', write['options'])            # never queued behind the live services
            self.assertIn('-c statement_timeout=', write['options'])
            statement = write['statement']
            self.assertIn(R.cms_sql(name, fakehost.cms_source(sql)), statement)
            self.assertIn("INSERT INTO payload_migrations (name, batch, updated_at, created_at) SELECT '%s'" % name, statement)
            self.assertLess(statement.index("payload_migrations WHERE name = '%s'" % name), statement.index('CREATE TABLE'))
        self.assertEqual(len(self.writes('cms_migrate')), 2)
        grants = self.writes('cms_grants')
        self.assertEqual([(g['single'], g['variables'], g['user']) for g in grants],
                         [(True, {'ON_ERROR_STOP': '1', 'VERBOSITY': 'sqlstate', 'cms_role': fakehost.CMS_RUNTIME}, 'r1_cms')])
        # The grant file was rehearsed first, rolled back, without the statements that name the new tables.
        rehearsal = self.fake.state()['rehearsals'][-1]
        self.assertEqual((rehearsal['single'], rehearsal['variables']['cms_role']), (False, fakehost.CMS_RUNTIME))
        self.assertIn('-c lock_timeout=5000', rehearsal['options'])
        self.assertIn('RAISE EXCEPTION', rehearsal['statement'])
        self.assertNotIn('r1b_runs', rehearsal['statement'])
        self.assertEqual(self.fake.state()['ledgers']['cms'][-2:], [RUNS, TARGETS])
        tables = value['privileges']['tables']
        self.assertEqual([t['table'] for t in tables], FAMILY_ROWS)
        for table in tables:
            self.assertEqual(table['granted'], ['SELECT', 'INSERT', 'UPDATE'])
            self.assertTrue({'DELETE', 'TRUNCATE'} <= set(table['absent']), table)
        self.assertEqual(len(value['privileges']['present']), PRESENT)
        self.assertEqual((value['privileges']['checked'], value['privileges']['mismatches']), (14 + PRESENT, []))
        self.assertEqual(value['ledgers'], {'cms': {'count': 3}})
        self.assertEqual(value['runtimeRole'], fakehost.CMS_RUNTIME)
        self.assertEqual([e['op'] for e in self.ledger()], ['adopt'])           # migrate writes no ledger entry
        self.assertEqual(self.starts(), before)                                 # and touches no service

    def test_a_failed_migration_stops_before_any_switch_and_migrate_again_resumes(self):
        self.adopt()
        plan = self.staged()
        self.fake.set(failSql='r1b_targets_guard')
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status'], value['code'], value['applied']),
                         (2, 'REFUSED', 'SQL_FAILED:cms_migrate:42P07', [RUNS]), value)
        self.assertTrue(value['hint'].startswith('forward only'), value)
        self.assertIn('do not run rollback', value['hint'])
        ledger = self.fake.state()['ledgers']['cms']
        self.assertIn(RUNS, ledger)
        self.assertNotIn(TARGETS, ledger)
        self.assertNotIn('r1b_run_targets', self.fake.state()['tables']['cms'])
        self.assertEqual(self.writes('cms_grants'), [])
        before = self.starts()
        rc, value = self.step('switch', '--services', 'backend,admin', '--plan', plan)
        self.assertEqual((rc, value.get('code')), (2, 'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first'), value)
        self.assertEqual(self.starts(), before)
        self.assertEqual((self.cwd('admin'), self.cwd('backend')), (self.live_cwd('admin'), self.live_cwd('backend')))
        self.fake.set(failSql=None)
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status'], value['already'], value['applied']), (0, 'MIGRATED', [RUNS], [TARGETS]),
                         value)
        self.assertTrue(value['backup']['dump']['reused'], value)                # the dump taken before anything changed
        self.assertEqual(len(self.fake.state()['dumps']), 1)
        self.assertEqual(self.fake.state()['ledgers']['cms'].count(RUNS), 1)
        rc, value = self.step('switch', '--services', 'backend,admin', '--plan', plan)
        self.assertEqual((rc, value['status']), (0, 'SWITCHED'), value)
        rc, value = self.migrate(plan)                                          # again after success: nothing to do
        self.assertEqual((value['status'], value['applied'], value['backup']['dump'][:10]), ('MIGRATED', [], 'NOT_NEEDED'))

    def test_a_failed_grant_or_privilege_check_stops_and_the_latest_run_decides(self):
        self.adopt()
        plan = self.staged()
        self.fake.set(aclExtra={'public.r1b_runs': ['DELETE']})                # e.g. default privileges on new tables
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status']), (2, 'REFUSED'), value)
        self.assertEqual(value['code'], 'PRIVILEGES_NOT_AS_EXPECTED:public.r1b_runs:DELETE:EXTRA')
        self.assertIn('default privileges', value['hint'])
        self.assertEqual(value['applied'], [RUNS, TARGETS])
        self.assertEqual(self.step('switch', '--services', 'admin', '--plan', plan)[1]['code'],
                         'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first')
        self.fake.set(aclExtra={}, acl={}, grantFail=True)
        rc, value = self.migrate(plan)
        self.assertEqual((value['status'], value['code'], value['already'], value['applied']),
                         ('REFUSED', 'SQL_FAILED:cms_grants:42501', [RUNS, TARGETS], []), value)
        self.fake.set(grantFail=False)
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status'], value['privileges']['mismatches']), (0, 'MIGRATED', []), value)
        self.assertEqual(self.step('switch', '--services', 'backend', '--plan', plan)[1]['status'], 'SWITCHED')
        # A later run of the same plan that stops holds it back again: the latest finished run decides, not any.
        self.fake.set(aclExtra={'public.r1b_run_targets': ['TRUNCATE']})
        self.assertEqual(self.migrate(plan)[1]['code'], 'PRIVILEGES_NOT_AS_EXPECTED:public.r1b_run_targets:TRUNCATE:EXTRA')
        self.assertEqual(self.step('switch', '--services', 'admin', '--plan', plan)[1]['code'],
                         'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first')
        rc, value = self.step('verify')
        self.assertIn('MIGRATIONS_NOT_DONE:cms:' + plan, value['failures'])
        acl = self.acl()
        acl['public.r1b_run_targets'].remove('TRUNCATE')
        self.fake.set(aclExtra={}, acl={fakehost.CMS_RUNTIME: acl})
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')
        self.assertEqual(self.step('switch', '--services', 'admin', '--plan', plan)[1]['status'], 'SWITCHED')
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')

    def test_the_backup_rule(self):
        self.adopt()
        plan = self.staged()
        rc, value = self.migrate(plan, pitr=False)
        self.assertTrue(value['code'].startswith('PITR_NOT_CONFIRMED:'), value)
        self.fake.set(relationBytes=1 << 60)
        rc, value = self.migrate(plan)
        self.assertTrue(value['code'].startswith('DISK_FREE:'), value)
        self.fake.set(relationBytes=65536, dumpFail=True)
        rc, value = self.migrate(plan)
        self.assertEqual(value['code'], 'BACKUP_FAILED:cms:1', value)
        self.assertEqual(self.backups(), [])                                    # a failed dump never stays
        self.fake.set(dumpFail=False, restoreDrops=['public.users'])
        rc, value = self.migrate(plan)
        self.assertEqual(value['code'], 'BACKUP_UNREADABLE:cms', value)         # every relation must read back
        self.assertEqual(self.backups(), [])
        self.assertEqual((self.writes(), self.fake.state()['ledgers']['cms'][-1]),
                         ([], '20261105_131739_mcp_connection_identity'))       # nothing applied before a dump
        # Nothing committed yet: a run again takes a new dump, and the one it replaces goes.
        self.fake.set(restoreDrops=[], failSql='r1b_runs_state')
        first = self.migrate(plan)[1]
        self.assertEqual((first['code'], first['applied']), ('SQL_FAILED:cms_migrate:42P07', []))
        again = self.migrate(plan)[1]
        self.assertFalse(again['backup']['dump']['reused'])
        self.assertEqual(again['backup']['dump']['removed'], [first['backup']['dump']['file']])
        # A dump cut off by SIGKILL, one whose sidecar no longer matches and an orphan sidecar are never counted.
        folder = self.h['paths']['state'] + '/backups'
        for name, raw in (('%s-cms-%d.dump.partial' % ('e' * 16, time.time_ns()), b'PGDMP partial'),
                          ('%s-cms-%d.dump' % ('f' * 16, time.time_ns()), b'PGDMP["public.users"]'),
                          ('%s-cms-%d.dump.sha256' % ('d' * 16, time.time_ns()), b'0' * 64)):
            self.fake.write(folder + '/' + name, raw, 0o600)
        self.fake.write(folder + '/%s-cms-%d.dump.sha256' % ('f' * 16, time.time_ns() - 1), b'0' * 64, 0o600)
        self.fake.set(failSql=None)
        rc, value = self.migrate(plan)
        self.assertEqual(value['status'], 'MIGRATED', value)
        dump = value['backup']['dump']
        self.assertEqual(self.backups(), sorted([os.path.basename(dump['file']), os.path.basename(dump['file']) + '.sha256']))
        # Only what the migrations touch: the existing table they name (users) and the ledger, not every CMS table.
        self.assertEqual((dump['tables'], self.fake.state()['dumps'][-1]['tables']),
                         (['public.payload_migrations', 'public.users'],) * 2)
        self.assertEqual(self.fake.state()['dumps'][-1]['user'], 'r1_cms')
        self.assertEqual(value['backup']['primary'], H.PITR_NOTE)
        path = self.fake.P(dump['file'])
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')
        self.assertEqual(pathlib.Path(path + '.sha256').read_text().split()[0], H.sha_real(path))
        kept = []
        for commit, name in ((NEWER, '20261106_130000_r1b_marks'), ('eeee5555' + NEW[8:], '20261106_140000_r1b_flags')):
            table = name.split('_', 2)[2]
            later = self.staged(commit, cms=[(name, fakehost.cms_source(
                'CREATE TABLE "%s" ("id" uuid PRIMARY KEY, "user_id" integer REFERENCES "users"("id"));' % table))],
                grant=GRANTS + ('GRANT SELECT ON TABLE public.%s TO :"cms_role";\n' % table).encode())
            rc, value = self.migrate(later)
            self.assertEqual(value['status'], 'MIGRATED', value)
            kept.append(value['backup']['dump']['file'])
        self.assertEqual([n for n in self.backups() if n.endswith('.dump')],
                         sorted(os.path.basename(k) for k in kept))             # at most two dumps stay
        self.assertEqual(value['backup']['dump']['removed'], [dump['file']])


class MigrationReads(MigrationCase):
    """The App family, and what reads the migrations afterwards: verify, rollback, migrate --check."""

    def test_app_family_runs_the_releases_own_launcher_resumes_and_reads_the_app_roles_grants(self):
        self.adopt()
        files = {'20261105010000_a.sql': b'select 1;\n', '20261105030000_b.sql': b'select 1;\n',
                 '20261107010000_c.sql': b'CREATE TABLE community.r1b_c (id integer PRIMARY KEY);\n',
                 '20261107020000_d.sql': b'ALTER TABLE community.works ADD COLUMN r1b_note text;\n'}
        app = {'pending': ['20261107010000', '20261107020000'], 'files': files, 'launcher': LAUNCHER}
        plan = self.fake.release(NEW, {'backend': 'root', 'issuer': 'restart'}, app=app)
        rc, value = self.migrate(plan, 'app')
        self.assertEqual(value['code'], 'PREPARE_NOT_DONE:' + plan)             # it runs from the new root
        self.assertEqual(self.step('prepare', '--plan', plan)[1]['status'], 'PREPARED')
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'app')
        self.assertEqual((check['status'], check['ready'], check['modulesMissing'], check['appRole']),
                         ('MIGRATE_CHECKED', True, [], fakehost.APP_ROLE), check)
        self.fake.set(appFailAt='20261107020000')
        rc, value = self.migrate(plan, 'app')
        self.assertEqual((rc, value['code'], value['applied']), (2, 'APP_MIGRATION_FAILED', ['20261107010000']), value)
        self.assertIn('names no cause', value['hint'])
        self.assertEqual(value['ledgers']['app'], {'count': 3, 'before': 2})
        run = self.fake.state()['nodeRuns'][-1]
        self.assertEqual(run['launcher'], 'scripts/migrate-community.mjs')
        self.assertEqual(run['services'], self.fake.P(self.new_cwd('backend') + '/services'))
        self.assertEqual(self.step('switch', '--services', 'backend', '--plan', plan)[1]['code'],
                         'MIGRATIONS_NOT_DONE:app:run migrate --family app first')
        self.fake.set(appFailAt=None)
        rc, value = self.migrate(plan, 'app')
        # Applied, but the App role has nothing on the new table yet: the operator runs the App grant file.
        self.assertEqual((rc, value['status'], value['already'], value['applied']),
                         (2, 'REFUSED', ['20261107010000'], ['20261107020000']), value)
        self.assertEqual(value['code'], 'APP_GRANTS_MISSING:community.r1b_c:SELECT:MISSING,community.r1b_c:INSERT:MISSING')
        self.assertIn('does not run the App grant file', value['hint'])
        self.assertTrue(value['backup']['dump']['reused'])
        self.assertEqual(self.fake.state()['dumps'][0]['tables'], ['community.schema_migrations', 'community.works'])
        self.assertEqual(self.step('switch', '--services', 'backend', '--plan', plan)[1]['code'],
                         'MIGRATIONS_NOT_DONE:app:run migrate --family app first')
        self.fake.set(acl={fakehost.APP_ROLE: {'community.r1b_c': ['SELECT', 'INSERT']}})
        rc, value = self.migrate(plan, 'app')
        self.assertEqual((rc, value['status'], value['applied'], value['privileges']['mismatches'], value['appRole']),
                         (0, 'MIGRATED', [], [], fakehost.APP_ROLE), value)
        self.assertEqual(self.step('switch', '--services', 'backend,issuer', '--plan', plan)[1]['status'], 'SWITCHED')
        self.assertEqual(self.step('verify')[1]['privileges']['app']['mismatches'], [])
        self.fake.set(acl={fakehost.APP_ROLE: {'community.r1b_c': ['SELECT', 'INSERT', 'DELETE']}})
        self.assertEqual(self.step('verify')[1]['failures'], ['PRIVILEGES:app:community.r1b_c:DELETE:EXTRA'])

    def test_an_app_grant_a_do_block_makes_counts_for_the_new_table(self):
        # home-timeline-v1's shape (#389): the App file grants its new table in a DO block under a to_regclass guard.
        self.adopt()
        files = {'20261105010000_a.sql': b'select 1;\n', '20261105030000_b.sql': b'select 1;\n',
                 '20261107030000_t.sql': b'CREATE TABLE community.r1b_timeline (entry_id text PRIMARY KEY, title text);\n'}
        plan = self.fake.release(NEW, {'backend': 'root'}, app={'pending': ['20261107030000'], 'files': files,
                                                                 'launcher': LAUNCHER, 'grant': fakehost.APP_DO_GRANTS})
        self.assertEqual(self.step('prepare', '--plan', plan)[1]['status'], 'PREPARED')
        rc, value = self.migrate(plan, 'app')
        self.assertEqual((rc, value['code']), (2, 'APP_GRANTS_MISSING:community.r1b_timeline:SELECT:MISSING'), value)
        self.fake.set(acl={fakehost.APP_ROLE: {'community.r1b_timeline': ['SELECT']}})       # the operator ran the file
        rc, value = self.migrate(plan, 'app')
        self.assertEqual((rc, value['status'], value['privileges']['checked'], value['privileges']['mismatches']),
                         (0, 'MIGRATED', 7, []), value)
        self.assertEqual(value['privileges']['tables'], [{'table': 'community.r1b_timeline', 'granted': ['SELECT'], 'absent': [
            'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'], 'columns': {}}])

    def test_the_app_launchers_modules_must_be_in_the_new_root(self):
        self.adopt()
        files = {'20261107010000_c.sql': b'ALTER TABLE community.works ADD COLUMN r1b_note text;\n'}
        launcher = LAUNCHER + b'await import("../services/elsewhere/dist/index.js");\n'
        plan = self.fake.release(NEW, {'backend': 'root'}, app={'pending': ['20261107010000'], 'files': files,
                                                                 'launcher': launcher})
        self.assertEqual(self.step('prepare', '--plan', plan)[1]['status'], 'PREPARED')
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'app')
        self.assertEqual((check['ready'], check['modulesMissing']), (False, ['services/elsewhere/dist/index.js']))
        self.assertNotIn('appRole', check)                                      # no new table: no App grants to read
        rc, value = self.migrate(plan, 'app')
        self.assertEqual((value['code'], value['applied']), ('APP_RUNNER_MODULE_MISSING:services/elsewhere/dist/index.js', []))
        self.assertEqual((self.fake.state().get('nodeRuns'), self.fake.state()['dumps']), (None, []))

    def test_verify_reads_the_ledger_counts_and_the_privileges(self):
        self.adopt()
        plan = self.staged()
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')
        self.assertEqual(self.step('switch', '--services', 'backend,admin', '--plan', plan)[1]['status'], 'SWITCHED')
        rc, value = self.step('verify')
        self.assertEqual((rc, value['status']), (0, 'PASS'), value)
        self.assertEqual(value['ledgers'], {'app': {'count': 2}, 'cms': {'count': 3}})
        self.assertEqual(value['privileges'], {'cms': {'checked': 14 + PRESENT, 'mismatches': []}})
        acl = self.acl()
        acl['public.r1b_runs'].append('TRUNCATE')
        acl['schema:public'].remove('USAGE')
        self.fake.set(acl={fakehost.CMS_RUNTIME: acl})
        rc, value = self.step('verify')
        self.assertEqual((value['status'], value['failures']),
                         ('FAIL', ['PRIVILEGES:cms:public.r1b_runs:TRUNCATE:EXTRA', 'PRIVILEGES:cms:schema:public:USAGE:MISSING']))
        acl['public.r1b_runs'].remove('TRUNCATE')
        acl['schema:public'].append('USAGE')
        acl['public.r1b_run_targets'].remove('UPDATE')
        ledgers = self.fake.state()['ledgers']
        ledgers['cms'].append('20261106_150000_outside')
        self.fake.set(acl={fakehost.CMS_RUNTIME: acl}, ledgers=ledgers)
        rc, value = self.step('verify')
        self.assertEqual(value['failures'], ['LEDGER_COUNT:cms:4:3', 'PRIVILEGES:cms:public.r1b_run_targets:UPDATE:MISSING'])
        ledgers['cms'] = [n for n in ledgers['cms'] if n != TARGETS]            # the count is right, a row is gone
        acl['public.r1b_run_targets'].append('UPDATE')
        self.fake.set(acl={fakehost.CMS_RUNTIME: acl}, ledgers=ledgers)
        self.assertEqual(self.step('verify')[1]['failures'], ['LEDGER_MISSING:cms:' + TARGETS])

    def test_rollback_never_touches_a_migration(self):
        self.adopt()
        plan = self.staged()
        self.migrate(plan)
        self.step('switch', '--services', 'backend,admin', '--plan', plan)
        writes = len(self.writes())
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual((rc, value['status']), (0, 'ROLLED_BACK'), value)
        self.assertTrue(value['migrations'].startswith('untouched: rollback never runs a down migration'), value)
        self.assertEqual(self.cwd('admin'), self.live_cwd('admin'))
        self.assertEqual(self.fake.state()['ledgers']['cms'][-2:], [RUNS, TARGETS])
        self.assertEqual(len(self.writes()), writes)
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')

    def test_migrate_check_changes_nothing_and_migrate_refuses_before_any_change(self):
        self.adopt()
        plan = self.staged()
        rc, value = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((value['status'], value['pending'], value['already'], value['ready'], value['grantRehearsal']),
                         ('MIGRATE_CHECKED', [RUNS, TARGETS], [], True, 'ROLLED_BACK_OK'), value)
        self.assertEqual((value['objects'], value['runtimeRole'], value['missing'], value['notOwned'], value['conflicts']),
                         (['public.payload_migrations', 'public.users'], fakehost.CMS_RUNTIME, [], [], []))
        self.assertEqual((self.writes(), self.fake.state()['dumps']), ([], []))
        self.assertFalse(pathlib.Path(self.fake.P(self.h['paths']['state'] + '/runs/migrate')).exists())
        self.fake.set(notOwned=['public.users'])
        self.assertFalse(self.call('migrate-check', '--plan', plan, '--family', 'cms')[1]['ready'])
        rc, value = self.migrate(plan)
        self.assertEqual(value['code'], 'GRANT_OBJECTS_NOT_OWNED:public.users')
        self.fake.set(notOwned=[])
        elsewhere = self.staged(NEWER, grant=GRANTS + b'GRANT SELECT ON TABLE public.nowhere TO :"cms_role";\n')
        rc, value = self.migrate(elsewhere)
        self.assertEqual(value['code'], 'GRANT_OBJECTS_MISSING:public.nowhere')
        ledgers = self.fake.state()['ledgers']
        ledgers['cms'].append('20261106_110000_outside')
        self.fake.set(ledgers=ledgers)
        rc, value = self.migrate(plan)
        self.assertEqual(value['code'], 'LEDGER_MOVED_SINCE_PLAN:cms')
        self.assertEqual((self.writes(), self.fake.state()['dumps']), ([], []))
        rc, value = self.call('migrate-check', '--plan', plan, '--family', 'app')
        self.assertEqual(value['code'], 'NO_MIGRATIONS_IN_PLAN:app')


class MigrationGuards(MigrationCase):
    """What stops migrate before anything changes, the objects a release creates beside its tables, rollback while a
    release switched nothing, the baseline verify reads, and the guards no other test reached."""

    def test_the_grant_files_own_guard_and_default_privileges_stop_before_anything_changes(self):
        self.adopt()
        plan = self.staged()
        self.fake.set(guardFail=True)                                           # e.g. the runtime role owns a table
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['grantRehearsal'], check['ready']), ('SQL_FAILED:cms_grant_rehearsal:P0001', False))
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['code'], value['applied']), (2, 'GRANT_REHEARSAL:SQL_FAILED:cms_grant_rehearsal:P0001', []))
        self.fake.set(guardFail=False, defaultAcl={'cms': ['r:DELETE', 'r:SELECT']})
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['defaultPrivileges'], check['conflicts'], check['ready']),
                         (['r:DELETE', 'r:SELECT'], ['public.r1b_runs:DELETE', 'public.r1b_run_targets:DELETE'], False))
        rc, value = self.migrate(plan)
        self.assertEqual(value['code'], 'DEFAULT_PRIVILEGES:public.r1b_runs:DELETE,public.r1b_run_targets:DELETE')
        self.assertIn('nothing was changed', value['hint'])
        self.assertEqual((self.writes(), self.fake.state()['dumps'], self.backups()), ([], [], []))
        self.fake.set(defaultAcl={'cms': ['r:SELECT']})                          # what the file grants anyway
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')

    def test_a_serial_tables_sequence_and_a_column_grant_are_the_releases_own(self):
        self.adopt()
        plan = self.staged(cms=[(RUNS, fakehost.cms_source(RUNS_SQL)), (fakehost.NOTES, fakehost.cms_source(fakehost.NOTES_SQL))],
                           grant=fakehost.NOTES_GRANTS)
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['ready'], check['missing']), (True, []), check)  # its sequence is not a missing object
        rc, value = self.migrate(plan)
        self.assertEqual(value['status'], 'MIGRATED', value)
        notes = [t for t in value['privileges']['tables'] if t['table'] == 'public.r1b_notes'][0]
        self.assertEqual((notes['granted'], notes['columns']), (['SELECT', 'INSERT'], {'UPDATE': ['note']}))
        self.assertEqual(value['privileges']['sequences'], [{'sequence': 'public.r1b_notes_id_seq', 'granted': ['USAGE'],
                                                             'absent': ['SELECT', 'UPDATE']}])
        self.assertEqual(value['privileges']['checked'], 14 + 1 + 3 + PRESENT)
        self.assertEqual(self.step('switch', '--services', 'backend,admin', '--plan', plan)[1]['status'], 'SWITCHED')
        acl = self.acl()
        acl.pop('public.r1b_notes.note')
        acl['public.r1b_notes_id_seq'].append('UPDATE')                        # setval for the runtime: not granted
        self.fake.set(acl={fakehost.CMS_RUNTIME: acl})
        self.assertEqual(self.step('verify')[1]['failures'], ['PRIVILEGES:cms:public.r1b_notes.note:UPDATE:MISSING',
                                                              'PRIVILEGES:cms:public.r1b_notes_id_seq:UPDATE:EXTRA'])

    def test_rollback_while_a_release_switched_nothing_refuses(self):
        self.adopt()
        earlier = self.staged(NEWER, cms=[('20261106_110000_r1b_old', fakehost.cms_source(
            'CREATE TABLE "r1b_old" ("id" integer PRIMARY KEY);'))],
            grant=fakehost.EXISTING_GRANTS + b'GRANT SELECT ON TABLE public.r1b_old TO :"cms_role";\n')
        self.assertEqual(self.migrate(earlier)[1]['status'], 'MIGRATED')
        self.assertEqual(self.step('switch', '--services', 'backend,admin', '--plan', earlier)[1]['status'], 'SWITCHED')
        plan = self.staged()
        self.fake.set(failSql='r1b_runs_state')
        self.assertEqual(self.migrate(plan)[1]['status'], 'REFUSED')
        before = (self.cwd('admin'), self.cwd('backend'))
        rc, value = self.step('rollback', '--to', 'previous')
        self.assertEqual((rc, value['code'].split(':')[:2]), (2, ['UNSWITCHED_PLAN', plan]), value)
        self.assertIn('would undo the release before it', value['code'])
        self.assertEqual((self.cwd('admin'), self.cwd('backend')), before)
        rc, value = self.step('rollback', '--to', 'previous', '--unswitched-ok')
        self.assertEqual((rc, value['status']), (0, 'ROLLED_BACK'), value)
        self.assertEqual((self.cwd('admin'), self.cwd('backend')), (self.live_cwd('admin'), self.live_cwd('backend')))

    def test_rebaseline_after_a_change_made_outside_the_tool(self):
        self.adopt()
        plan = self.staged()
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')
        self.assertEqual(self.step('switch', '--services', 'backend,admin', '--plan', plan)[1]['status'], 'SWITCHED')
        rc, value = self.step('migrate', '--family', 'app', '--rebaseline')
        self.assertEqual(value['code'], 'NOTHING_TO_REBASELINE:app:no migrate of this family finished')
        ledgers, acl = self.fake.state()['ledgers'], self.acl()
        ledgers['cms'].append('20261106_150000_outside')
        acl['public.r1b_runs'].append('DELETE')
        self.fake.set(ledgers=ledgers, acl={fakehost.CMS_RUNTIME: acl})
        self.assertEqual(self.step('verify')[1]['failures'], ['LEDGER_COUNT:cms:4:3', 'PRIVILEGES:cms:public.r1b_runs:DELETE:EXTRA'])
        self.assertEqual(self.step('close-out', '--as', 'accepted')[1]['code'], 'NO_PASS_AFTER_HEAD')
        rc, value = self.step('migrate', '--family', 'cms', '--rebaseline')
        self.assertEqual((rc, value['status'], value['changes']), (0, 'BASELINED', {
            'count': [3, 4], 'gone': [], 'privileges': ['public.r1b_runs:DELETE:GAINED']}), value)
        self.assertEqual(value['ledgers'], {'cms': {'count': 4}})
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')
        self.assertEqual(self.step('close-out', '--as', 'accepted')[1]['status'], 'CLOSED_OUT')
        acl['public.r1b_runs'].remove('DELETE')
        self.fake.set(acl={fakehost.CMS_RUNTIME: acl})
        self.assertEqual(self.step('verify')[1]['failures'], ['PRIVILEGES:cms:public.r1b_runs:DELETE:MISSING'])

    def test_the_grant_rehearsal_leaves_out_every_object_the_release_creates(self):
        self.adopt()
        sql = ('  CREATE TABLE "r1b_rows" ("id" uuid PRIMARY KEY);\n'
               '  CREATE FUNCTION r1b_rows_count() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM r1b_rows $$;')
        grant = fakehost.EXISTING_GRANTS + (b'GRANT SELECT ON TABLE public.r1b_rows TO :"cms_role";\n'
                                            b'GRANT EXECUTE ON FUNCTION public.r1b_rows_count() TO :"cms_role";\n')
        plan = self.staged(cms=[('20261106_150000_r1b_rows', fakehost.cms_source(sql))], grant=grant)
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['grantRehearsal'], check['ready']), ('ROLLED_BACK_OK', True), check)
        rehearsal = self.fake.state()['rehearsals'][-1]['statement']
        self.assertNotIn('r1b_rows', rehearsal)                                # neither the new table nor the function
        self.assertIn('RAISE EXCEPTION', rehearsal)                             # the file's own guard still speaks first
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')

    def test_an_object_gone_outside_the_tool_reads_as_gone_until_rebaseline(self):
        self.adopt()
        plan = self.staged()
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')
        self.assertEqual(self.step('switch', '--services', 'backend,admin', '--plan', plan)[1]['status'], 'SWITCHED')
        tables = self.fake.state()['tables']
        tables['cms'] = [t for t in tables['cms'] if t not in ('r1b_run_targets', 'mcp_control')]  # dropped or renamed
        self.fake.set(tables=tables, droppedColumns=['public.payload_migrations.name'])
        rc, value = self.step('verify')
        self.assertEqual((value['status'], value['failures']), ('FAIL', [
            'PRIVILEGE_OBJECT_GONE:public.mcp_control', 'PRIVILEGE_OBJECT_GONE:public.payload_migrations.name',
            'PRIVILEGE_OBJECT_GONE:public.r1b_run_targets']), value)
        self.assertIn('migrate --family cms --rebaseline', value['hint'])
        rc, value = self.step('migrate', '--family', 'cms', '--rebaseline')
        self.assertEqual((rc, value['status'], value['changes']), (0, 'BASELINED', {'count': [3, 3], 'privileges': [], 'gone': [
            'public.mcp_control', 'public.payload_migrations.name', 'public.r1b_run_targets']}), value)
        self.assertEqual([t['table'] for t in value['privileges']['tables']], ['public.r1b_runs'])
        self.assertEqual([i for i in value['privileges']['present'] if i['name'] in ('public.mcp_control',
                                                                                    'public.payload_migrations')], [])
        self.assertEqual(self.step('verify')[1]['status'], 'PASS')
        tables['cms'].append('mcp_control')
        self.fake.set(tables=tables, droppedColumns=[])
        rc, value = self.migrate(plan)                                          # the plan's own read meets it too
        self.assertEqual((rc, value['code']), (2, 'PRIVILEGE_OBJECT_GONE:public.r1b_run_targets'), value)
        self.assertIn('migrate --family cms --rebaseline', value['hint'])

    def test_a_changed_grant_file_alone_runs_and_is_read_back_before_the_switch(self):
        self.adopt()
        grant = fakehost.EXISTING_GRANTS + b'GRANT SELECT ON TABLE public.catalogs TO :"cms_role";\n'
        plan = self.fake.release(NEW, {'admin': 'root'}, grants_only=True, grant=grant)
        self.assertEqual(self.step('prepare', '--plan', plan)[1]['status'], 'PREPARED')
        self.assertEqual(self.step('switch', '--services', 'admin', '--plan', plan)[1]['code'],
                         'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first')
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status'], value['applied'], value['backup']['dump'][:10]),
                         (0, 'MIGRATED', [], 'NOT_NEEDED'), value)
        self.assertEqual(len(self.writes('cms_grants')), 1)
        self.assertIn({'kind': 'table', 'name': 'public.catalogs', 'privilege': 'SELECT'}, value['privileges']['present'])
        self.assertEqual((value['privileges']['checked'], value['privileges']['tables']), (PRESENT + 1, []))
        self.assertEqual(self.step('switch', '--services', 'admin', '--plan', plan)[1]['status'], 'SWITCHED')

    def test_guards_no_other_test_reaches(self):
        self.adopt()
        plan = self.staged()
        # The runtime login must not be the migration role.
        spec = self.h['database']['cmsRuntimeRole']
        path = self.h['envFiles'][spec['envFile']]['path']
        original = self.fake.read(path)
        self.fake.write(path, original.replace(fakehost.CMS_RUNTIME.encode(), b'r1_cms'), 0o600)
        self.assertEqual(self.migrate(plan)[1]['code'], 'CMS_RUNTIME_IS_MIGRATION_ROLE')
        self.fake.write(path, original, 0o600)
        # A ledger that holds a later planned migration without the earlier one cannot be resumed.
        ledgers = self.fake.state()['ledgers']
        self.fake.set(ledgers=dict(ledgers, cms=ledgers['cms'] + [TARGETS]))
        self.assertEqual(self.migrate(plan)[1]['code'], 'MIGRATION_ORDER:cms')
        self.fake.set(ledgers=ledgers)
        # psql variables are role names only.
        H.configure(self.fake.env())
        with self.assertRaises(H.Refusal) as caught:
            H.database('cms').write('cms_grants', 'SELECT 1', variables={'cms_role': 'Bad-Role'})
        self.assertEqual(str(caught.exception), 'PSQL_VARIABLE')
        # The host checks the SQL against the sha256 the plan pins, whatever wrote the plan.
        for tamper, code in ((lambda p: p['migrations']['cms']['items'][0].update(sql='DROP TABLE "users";\n'), 'CMS_SQL_SHA:' + RUNS),
                             (lambda p: p['grants']['cms'].update(rehearsal='SELECT 2;'), 'GRANT_SQL_SHA')):
            bad = self.fake.release('ffff6666' + NEW[8:], {'admin': 'root'}, cms=[(RUNS, fakehost.cms_source(RUNS_SQL))],
                                    grant=GRANTS.replace(b',\n  public.r1b_run_targets', b''), tamper=tamper)
            self.assertEqual(self.migrate(bad)[1]['code'], code)
        self.assertEqual((self.writes(), self.fake.state()['dumps']), ([], []))
        # Another writer adds a ledger row while migrate runs: nothing else may change.
        self.fake.set(ledgerExtra=['20261106_115959_elsewhere'])
        rc, value = self.migrate(plan)
        self.assertEqual((value['code'], value['applied']), ('LEDGER_AFTER:cms', [RUNS, TARGETS]), value)
        self.assertEqual(self.writes('cms_grants'), [])


if __name__ == '__main__':
    unittest.main()
