"""Rehearsal of the CMS migrate step on a real PostgreSQL 16: the local task container moya-test-r1b-pg16 (published on
127.0.0.1:55437), synthetic data only. Never Production, never the network. Not part of run_all.py.

What runs is release_host.py's own migrate, migrate-check and verify on the fake host, with psql, pg_dump and
pg_restore replaced by wrappers that run the container's PostgreSQL 16 client tools (`docker exec`), so every
statement, dump and privilege read goes to a real server. The roles are laid out like Production's CMS: a migration
login (no superuser, no CREATEROLE) that owns the database and every CMS relation, and a separate runtime login with
CONNECT only; PUBLIC has no CONNECT. The relations are every one the repository's grant file names (plus Payload's
ledger and `users`), and the grant file is the repository's own with the grants for the synthetic tables appended, as a
release that creates them would add.

It shows, on the real server: the grant file's own guard (here: the runtime role given CREATEROLE) stops migrate before
anything changes, through the rehearsal rolled back; the dump holds only what the migrations touch; a migration that
cannot take its lock within 5 s rolls back whole (its table and its ledger row both absent) while the one before it
stays; default privileges that would give the runtime DELETE on a new table (or UPDATE on its sequence) stop migrate
before anything changes; once removed, migrate resumes with the same dump and finishes: the runtime role inserts
through a serial column's sequence (named as the plan named it), updates only the column it was granted, and cannot
DELETE or TRUNCATE; every privilege the grant file gives on what existed reads back (more than the 100 arguments a
function call takes); an extra privilege granted after the fact fails verify and stops migrate again; after a
ledger row written outside the tool, migrate --rebaseline lets verify pass again; the grant file's GRANT EXECUTE on the
trigger function a migration creates stays out of the rehearsal (the function is not there yet) and runs with the
grants; and a table renamed and a column dropped outside the tool read as gone (each privilege read guarded, so the
read itself never fails), until migrate --rebaseline drops them from the baseline.

  docker run -d --name moya-test-r1b-pg16 -p 127.0.0.1:55437:5432 -e POSTGRES_USER=r1b_admin \\
      -e POSTGRES_PASSWORD=<synthetic> -e POSTGRES_DB=r1b_admin postgres:16.15-alpine
  python3 -I -B scripts/release/tests/rehearsal.py
"""
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
sys.dont_write_bytecode = True
import fakehost  # noqa: E402
import release as R  # noqa: E402
import release_host as H  # noqa: E402

CONTAINER, ADMIN, DATABASE = 'moya-test-r1b-pg16', 'r1b_admin', 'r1b_cms'
MIGRATION, RUNTIME = 'r1b_cms_migration', 'r1b_cms_runtime'
NEW = 'cccc3333' + '0123456789abcdef0123456789abcdef'
M1, M2, M3 = fakehost.RUNS, fakehost.TARGETS, fakehost.NOTES
M1_SQL, M3_SQL = fakehost.RUNS_SQL, fakehost.NOTES_SQL
# The second also adds a nullable column to an existing table: an expand that needs that table's ACCESS EXCLUSIVE lock.
M2_SQL = fakehost.TARGETS_SQL + '\n  ALTER TABLE "mcp_control" ADD COLUMN "r1b_note" text;'
GRANT_FILE = HERE.parents[2] / 'infra' / 'development' / 'grant-cms-runtime.sql'
APPENDED = (b'\n-- Rehearsal: the grants a release creating these tables adds.\nGRANT SELECT, INSERT, UPDATE ON TABLE\n'
            b'  public.r1b_runs,\n  public.r1b_run_targets\nTO :"cms_role";\n'
            b'GRANT SELECT, INSERT ON TABLE public.r1b_notes TO :"cms_role";\n'
            b'GRANT UPDATE (note) ON public.r1b_notes TO :"cms_role";\n'
            b'GRANT USAGE ON SEQUENCE public.r1b_notes_id_seq TO :"cms_role";\n'
            b'GRANT EXECUTE ON FUNCTION public.r1b_targets_guard() TO :"cms_role";\n')
DOCKER = shutil.which('docker') or '/usr/local/bin/docker'

WRAPPER = r'''#!@PYTHON@ -I
# Runs this PostgreSQL client tool inside the rehearsal container; the PG* variables the host tool set pass through.
import os, subprocess, sys
name, args = os.path.basename(sys.argv[0]), sys.argv[1:]
passed = [x for k in ('PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGOPTIONS', 'PGAPPNAME',
                      'PGCONNECT_TIMEOUT') if k in os.environ for x in ('-e', k)]
env = dict(os.environ, PATH=@PATH@, HOME=@HOME@)
command = [@DOCKER@, 'exec', '-i'] + passed + [@CONTAINER@, name]
if name == 'pg_dump':
    at = args.index('--file')
    with open(args[at + 1], 'wb') as out:
        sys.exit(subprocess.run(command + args[:at] + args[at + 2:], stdout=out, env=env).returncode)
if name == 'pg_restore':
    with open(args[-1], 'rb') as archive:
        sys.exit(subprocess.run(command + args[:-1], stdin=archive, env=env).returncode)
sys.exit(subprocess.run(command + args, env=env).returncode)
'''


def docker(*args, data=None, env=None, check=True):
    done = subprocess.run([DOCKER] + list(args), input=data, capture_output=True, timeout=120,
                          env=dict(os.environ, **(env or {})))
    if check and done.returncode != 0:
        raise AssertionError('docker %s failed: %s' % (args[:3], done.stderr.decode()[-400:]))
    return done


def admin_sql(sql, database=DATABASE):
    """As the container's superuser over the local socket: setup, independent reads and the lock holder only."""
    return docker('exec', '-i', CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', ADMIN, '-d', database,
                  '-f', '-', data=sql.encode()).stdout.decode()


def login_sql(role, password, sql):
    """As `role` over TCP with its password, the way a service logs in; answers (rc, stdout, stderr)."""
    done = docker('exec', '-i', '-e', 'PGPASSWORD', CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h',
                  '127.0.0.1', '-U', role, '-d', DATABASE, '-v', 'VERBOSITY=sqlstate', '-f', '-', data=sql.encode(),
                  env={'PGPASSWORD': password}, check=False)
    return done.returncode, done.stdout.decode(), done.stderr.decode()


def sqlstate(err):
    found = re.search(r'ERROR:\s+([0-9A-Z]{5})', err)
    return found.group(1) if found else None


class Rehearsal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        state = docker('inspect', '-f', '{{.State.Running}}', CONTAINER, check=False)
        if state.returncode != 0 or state.stdout.strip() != b'true':
            raise unittest.SkipTest('the task container %s is not running; the rehearsal did not run' % CONTAINER)
        cls.passwords = {MIGRATION: secrets.token_hex(16), RUNTIME: secrets.token_hex(16)}
        cls.grants = GRANT_FILE.read_bytes() + APPENDED
        cls.drop()
        admin_sql('CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'%s\';\n'
                  'CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'%s\';\n'
                  'CREATE DATABASE %s OWNER %s;\nREVOKE CONNECT, TEMPORARY ON DATABASE %s FROM PUBLIC;\n'
                  'GRANT CONNECT ON DATABASE %s TO %s;\n'
                  % (MIGRATION, cls.passwords[MIGRATION], RUNTIME, cls.passwords[RUNTIME], DATABASE, MIGRATION, DATABASE,
                     DATABASE, RUNTIME), database=ADMIN)
        # Every relation the grant file names, owned by the migration role, as the CMS migrations left them.
        creates = R.created_relations('\n'.join((M1_SQL, M2_SQL, M3_SQL)))
        section = R.grant_section(cls.grants, R.GRANT_FILES['cms'], creates, R.GRANT_VARIABLES['cms'])
        objects = section['objects']
        columns = {}
        for found in re.finditer(r'GRANT\s+\w+\s*\(([^)]*)\)\s+ON\s+(?:TABLE\s+)?(public\.\w+)', cls.grants.decode()):
            columns.setdefault(found.group(2), []).extend(c.strip() for c in found.group(1).split(','))
        schema = ['CREATE SEQUENCE %s;' % o['name'] for o in objects if o['kind'] == 'sequence']
        schema.append('CREATE TABLE public.payload_migrations (id serial PRIMARY KEY NOT NULL, name varchar, batch numeric, '
                      'updated_at timestamp(3) with time zone DEFAULT now() NOT NULL, created_at timestamp(3) with time '
                      'zone DEFAULT now() NOT NULL);')
        schema.append('CREATE TABLE public.users (id integer PRIMARY KEY, email varchar, role varchar);')
        for item in objects:
            if item['kind'] == 'table' and item['name'] not in ('public.payload_migrations', 'public.users'):
                extra = ''.join(', %s text' % c for c in columns.get(item['name'], []))
                schema.append('CREATE TABLE %s (id integer%s);' % (item['name'], extra))
        cls.names = R.cms_index_names((HERE.parents[2] / R.MIGRATION_SOURCES['cms']).read_bytes())
        schema.append('INSERT INTO public.payload_migrations (name, batch) VALUES %s;'
                      % ','.join("('%s', %d)" % (n, i + 1) for i, n in enumerate(cls.names)))
        schema.append("INSERT INTO public.users (id, email, role) VALUES (1, 'owner@example.invalid', 'owner');")
        rc, _, err = login_sql(MIGRATION, cls.passwords[MIGRATION], 'BEGIN;\n%s\nCOMMIT;\n' % '\n'.join(schema))
        assert rc == 0, err
        cls.relations, cls.present = len(objects), len(section['present'])

    @classmethod
    def tearDownClass(cls):
        cls.drop()

    @classmethod
    def drop(cls):
        admin_sql('DROP DATABASE IF EXISTS %s WITH (FORCE);\nDROP ROLE IF EXISTS %s, %s;' % (DATABASE, MIGRATION, RUNTIME),
                  database=ADMIN)

    def setUp(self):
        self.profile, _ = fakehost.load_profile(fakehost.EXAMPLE_PROFILE)
        self.fake = fakehost.FakeHost(self.profile)
        self.addCleanup(self.fake.close)
        self.h = self.profile['host']
        wrapper = (WRAPPER.replace('@PYTHON@', sys.executable).replace('@PATH@', repr(os.environ.get('PATH', '/usr/bin:/bin')))
                   .replace('@HOME@', repr(os.path.expanduser('~'))).replace('@DOCKER@', repr(DOCKER))
                   .replace('@CONTAINER@', repr(CONTAINER)))
        for name in ('psql', 'pg_dump', 'pg_restore'):
            path = self.fake.bin / name
            path.write_text(wrapper)
            path.chmod(0o755)
        url = 'postgresql://%s:%s@127.0.0.1:5432/%s?sslmode=disable'
        operator = json.loads(self.fake.read(self.h['paths']['operator']))
        operator[self.h['database']['operatorCms']['url']] = url % (MIGRATION, self.passwords[MIGRATION], DATABASE)
        operator[self.h['database']['operatorApp']['url']] = url % (MIGRATION, self.passwords[MIGRATION], DATABASE)
        self.fake.write(self.h['paths']['operator'], json.dumps(operator), 0o600)
        spec = self.h['database']['cmsRuntimeRole']
        env_path = self.h['envFiles'][spec['envFile']]['path']
        text = self.fake.read(env_path).decode()
        text = re.sub(r'(?m)^%s=.*$' % spec['key'], '%s=%s' % (spec['key'], url % (RUNTIME, self.passwords[RUNTIME], DATABASE)), text)
        self.fake.write(env_path, text, 0o600)
        self.fake.set(ledgers={'cms': list(self.names), 'app': []})
        self.runs = 0
        self.outputs = []

    def call(self, *argv):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = H.main(['release_host.py'] + list(argv), env=self.fake.env())
        text = buf.getvalue()
        self.outputs.append(text)
        return rc, json.loads([l for l in text.splitlines() if l.startswith('{')][-1])

    def step(self, command, *argv):
        self.runs += 1
        return self.call(command, '--run-id', 'rehearsal-%s-%d' % (command, self.runs), *argv)

    def migrate(self, plan):
        return self.step('migrate', '--plan', plan, '--family', 'cms', '--pitr', 'confirmed')

    def privileges(self, table):
        rows = admin_sql("SELECT string_agg(p || '=' || has_table_privilege('%s', '%s', p)::text, ',' ORDER BY p) FROM "
                         "unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p;"
                         % (RUNTIME, table)).strip()
        return dict(item.split('=') for item in rows.split(','))

    def test_cms_migrate_on_a_real_postgresql_16(self):
        summary = {'server': admin_sql('SHOW server_version;', database=ADMIN).strip(), 'grantFileRelations': self.relations,
                   'grantFilePresent': self.present, 'ledgerBefore': len(self.names)}
        self.assertEqual(self.step('adopt')[1]['status'], 'ADOPTED')
        plan = self.fake.release(NEW, {'admin': 'root'}, cms=[(M1, fakehost.cms_source(M1_SQL)), (M2, fakehost.cms_source(M2_SQL)),
                                                              (M3, fakehost.cms_source(M3_SQL))], grant=self.grants)
        self.assertEqual(self.step('prepare', '--plan', plan)[1]['status'], 'PREPARED')

        # 0. The grant file's own guard, rehearsed and rolled back: a runtime role with CREATEROLE stops it all first.
        admin_sql('ALTER ROLE %s CREATEROLE;' % RUNTIME, database=ADMIN)
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['grantRehearsal'], check['ready']), ('SQL_FAILED:cms_grant_rehearsal:P0001', False), check)
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['code'], value['applied']), (2, 'GRANT_REHEARSAL:SQL_FAILED:cms_grant_rehearsal:P0001', []))
        self.assertEqual(admin_sql("SELECT count(*) FROM public.payload_migrations;").strip(), str(len(self.names)))
        admin_sql('ALTER ROLE %s NOCREATEROLE;' % RUNTIME, database=ADMIN)
        summary['guard'] = {'code': value['code'], 'applied': value['applied']}
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['status'], check['pending'], check['missing'], check['notOwned'], check['ready'],
                          check['runtimeRole'], check['migrationRole'], check['grantRehearsal'], check['conflicts']),
                         ('MIGRATE_CHECKED', [M1, M2, M3], [], [], True, RUNTIME, MIGRATION, 'ROLLED_BACK_OK', []), check)
        self.assertEqual(check['objects'], ['public.mcp_control', 'public.payload_migrations', 'public.users'])
        summary['check'] = {k: check[k] for k in ('pending', 'objects', 'relationBytes', 'ready', 'grantRehearsal')}

        # 1. Another session holds a lock on mcp_control: M2 cannot take its lock within 5 s and rolls back whole.
        holder = subprocess.Popen([DOCKER, 'exec', '-i', CONTAINER, 'psql', '-X', '-q', '-U', ADMIN, '-d', DATABASE],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        holder.stdin.write(b'BEGIN;\nLOCK TABLE public.mcp_control IN ACCESS SHARE MODE;\nSELECT pg_sleep(60);\n')
        holder.stdin.flush()
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and admin_sql(
                    "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'mcp_control' "
                    "AND l.mode = 'AccessShareLock' AND l.granted;").strip() == '0':
                time.sleep(0.2)
            began = time.monotonic()
            rc, value = self.migrate(plan)
            waited = time.monotonic() - began
        finally:
            holder.kill()
            holder.wait(30)
            admin_sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%s' AND usename = '%s' AND "
                      "pid <> pg_backend_pid();" % (DATABASE, ADMIN))
        self.assertEqual((rc, value['status'], value['code'], value['applied']),
                         (2, 'REFUSED', 'SQL_FAILED:cms_migrate:55P03', [M1]), value)
        ledger = admin_sql('SELECT name FROM public.payload_migrations ORDER BY id;').split()
        self.assertEqual(ledger[-1], M1)
        self.assertNotIn(M2, ledger)
        exists = admin_sql("SELECT to_regclass('public.r1b_runs') IS NOT NULL, to_regclass('public.r1b_run_targets') IS NOT NULL, "
                           "to_regprocedure('r1b_targets_guard()') IS NOT NULL, EXISTS (SELECT 1 FROM information_schema.columns "
                           "WHERE table_name = 'mcp_control' AND column_name = 'r1b_note');").strip()
        self.assertEqual(exists, 't|f|f|f')                 # M1 stayed; M2's table, function and column all rolled back
        dump = value['backup']['dump']
        listing = docker('exec', '-i', CONTAINER, 'pg_restore', '--list', data=pathlib.Path(self.fake.P(dump['file'])).read_bytes()).stdout.decode()
        listed = sorted(set(re.findall(r' TABLE public (\w+) ', listing)))
        self.assertEqual(listed, ['mcp_control', 'payload_migrations', 'users'])
        summary['lockTimeout'] = {'code': value['code'], 'seconds': round(waited, 1), 'applied': value['applied'],
                                  'dumpTables': listed, 'afterFailure': exists}

        # 2. Default privileges that would give the runtime DELETE on new tables and UPDATE on new sequences: stopped
        #    before anything changes, for the objects the remaining migrations create (r1b_runs exists already).
        rc, _, err = login_sql(MIGRATION, self.passwords[MIGRATION],
                               'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO %s;\n'
                               'ALTER DEFAULT PRIVILEGES GRANT UPDATE ON SEQUENCES TO %s;' % (RUNTIME, RUNTIME))
        self.assertEqual(rc, 0, err)
        rc, check = self.call('migrate-check', '--plan', plan, '--family', 'cms')
        self.assertEqual((check['conflicts'], check['ready']), (['public.r1b_run_targets:DELETE', 'public.r1b_notes:DELETE',
                                                                 'public.r1b_notes_id_seq:UPDATE'], False), check)
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['code'], value['applied']), (2, 'DEFAULT_PRIVILEGES:public.r1b_run_targets:DELETE,'
                                                                    'public.r1b_notes:DELETE,public.r1b_notes_id_seq:UPDATE', []))
        self.assertNotIn(M2, admin_sql('SELECT name FROM public.payload_migrations;').split())
        summary['defaultPrivileges'] = {'read': check['defaultPrivileges'], 'code': value['code']}

        # 3. Removed by the migration role: migrate resumes with the same dump and finishes.
        rc, _, err = login_sql(MIGRATION, self.passwords[MIGRATION],
                               'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE DELETE ON TABLES FROM %s;\n'
                               'ALTER DEFAULT PRIVILEGES REVOKE UPDATE ON SEQUENCES FROM %s;' % (RUNTIME, RUNTIME))
        self.assertEqual(rc, 0, err)
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['status'], value['already'], value['applied'], value['privileges']['mismatches']),
                         (0, 'MIGRATED', [M1], [M2, M3], []), value)
        self.assertTrue(value['backup']['dump']['reused'])
        self.assertEqual(value['ledgers'], {'cms': {'count': len(self.names) + 3}})
        self.assertGreater(value['privileges']['checked'], 100)
        self.assertEqual(value['privileges']['sequences'], [{'sequence': 'public.r1b_notes_id_seq', 'granted': ['USAGE'],
                                                             'absent': ['SELECT', 'UPDATE']}])
        for table in ('public.r1b_runs', 'public.r1b_run_targets'):
            self.assertEqual(self.privileges(table), {'SELECT': 'true', 'INSERT': 'true', 'UPDATE': 'true', 'DELETE': 'false',
                                                      'TRUNCATE': 'false', 'REFERENCES': 'false', 'TRIGGER': 'false'}, table)
        counts = admin_sql("SELECT count(*) FILTER (WHERE name IN ('%s', '%s', '%s')), count(*) FROM public.payload_migrations;"
                           % (M1, M2, M3)).strip()
        self.assertEqual(counts, '3|%d' % (len(self.names) + 3))
        # The runtime role, logged in as itself: it writes (through the serial column's sequence), it updates only the
        # column it was granted, it cannot DELETE or TRUNCATE.
        rc, out, err = login_sql(RUNTIME, self.passwords[RUNTIME], "INSERT INTO public.r1b_runs (run_id, user_id, state) "
                                 "VALUES ('00000000-0000-4000-8000-000000000001', 1, 'planning');\n"
                                 "UPDATE public.r1b_runs SET state = 'done';\n"
                                 "INSERT INTO public.r1b_notes (run_id, note) VALUES ('00000000-0000-4000-8000-000000000001', 'a');\n"
                                 "UPDATE public.r1b_notes SET note = 'b';\nSELECT count(*) FROM public.r1b_notes;")
        self.assertEqual((rc, out.strip()), (0, '1'), err)
        refused = {}
        for statement in ('DELETE FROM public.r1b_runs;', 'TRUNCATE public.r1b_run_targets;',
                          'UPDATE public.r1b_notes SET run_id = NULL;', "SELECT setval('public.r1b_notes_id_seq', 100);"):
            rc, _, err = login_sql(RUNTIME, self.passwords[RUNTIME], statement)
            refused[statement.split()[0] + ('' if statement[0] != 'U' else ':run_id')] = sqlstate(err) if rc else 'ALLOWED'
        self.assertEqual(refused, {'DELETE': '42501', 'TRUNCATE': '42501', 'UPDATE:run_id': '42501', 'SELECT': '42501'})
        summary['final'] = {'privileges': self.privileges('public.r1b_runs'), 'runtimeRefused': refused, 'ledger': counts,
                            'checked': value['privileges']['checked']}

        # 4. An extra privilege granted after the fact: verify fails, and migrate again stops (and holds the switch).
        rc, value = self.step('verify')
        self.assertEqual((value['ledgers']['cms'], value['privileges']['cms']['mismatches']),
                         ({'count': len(self.names) + 3}, []), value)
        admin_sql('GRANT DELETE ON public.r1b_runs TO %s;' % RUNTIME)
        rc, value = self.step('verify')
        self.assertIn('PRIVILEGES:cms:public.r1b_runs:DELETE:EXTRA', value['failures'])
        rc, value = self.migrate(plan)
        self.assertEqual((rc, value['code']), (2, 'PRIVILEGES_NOT_AS_EXPECTED:public.r1b_runs:DELETE:EXTRA'), value)
        self.assertEqual(self.step('switch', '--services', 'admin', '--plan', plan)[1]['code'],
                         'MIGRATIONS_NOT_DONE:cms:run migrate --family cms first')
        admin_sql('REVOKE DELETE ON public.r1b_runs FROM %s;' % RUNTIME)
        self.assertEqual(self.migrate(plan)[1]['status'], 'MIGRATED')
        summary['extra'] = {'verify': 'PRIVILEGES:cms:public.r1b_runs:DELETE:EXTRA', 'migrate': value['code']}

        # 5. A ledger row written outside the tool: verify fails until migrate --rebaseline records it.
        admin_sql("INSERT INTO public.payload_migrations (name, batch) VALUES ('20261106_150000_outside', 99);")
        rc, value = self.step('verify')
        self.assertIn('LEDGER_COUNT:cms:%d:%d' % (len(self.names) + 4, len(self.names) + 3), value['failures'])
        rc, value = self.step('migrate', '--family', 'cms', '--rebaseline')
        self.assertEqual((value['status'], value['changes']['count'], value['changes']['privileges']),
                         ('BASELINED', [len(self.names) + 3, len(self.names) + 4], []), value)
        rc, value = self.step('verify')
        self.assertEqual((value['ledgers']['cms'], value['privileges']['cms']['mismatches']),
                         ({'count': len(self.names) + 4}, []), value)
        self.assertFalse([f for f in value['failures'] if f.startswith(('LEDGER', 'PRIVILEGES', 'MIGRATIONS'))], value)
        dumps = sorted(p.name for p in pathlib.Path(self.fake.P(self.h['paths']['state'] + '/backups')).iterdir())
        self.assertEqual(len(dumps), 2)                    # the dump and its sha256 sidecar
        summary['rebaseline'] = {'changes': value.get('ledgers'), 'verifyMigrationFailures': []}
        granted = admin_sql("SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.proname = "
                            "'r1b_targets_guard' AND a.grantee = '%s'::regrole AND a.privilege_type = 'EXECUTE';" % RUNTIME)
        self.assertEqual(granted.strip(), '1')                 # the GRANT EXECUTE ran with the grants, after M2

        # 6. A table renamed and a column dropped outside the tool: each read guarded, they read as gone (no 42P01 for
        #    the whole read), verify names them, and migrate --rebaseline drops them from the baseline.
        rc, _, err = login_sql(MIGRATION, self.passwords[MIGRATION], 'ALTER TABLE public.r1b_run_targets RENAME TO '
                               'r1b_run_targets_old;\nALTER TABLE public.r1b_notes DROP COLUMN note;')
        self.assertEqual(rc, 0, err)
        rc, value = self.step('verify')
        gone = sorted(f for f in value['failures'] if f.startswith('PRIVILEGE'))
        self.assertEqual(gone, ['PRIVILEGE_OBJECT_GONE:public.r1b_notes.note', 'PRIVILEGE_OBJECT_GONE:public.r1b_run_targets'],
                         value)
        self.assertIn('migrate --family cms --rebaseline', value['hint'])
        rc, value = self.step('migrate', '--family', 'cms', '--rebaseline')
        self.assertEqual((value['status'], value['changes']['gone'], value['changes']['privileges']),
                         ('BASELINED', ['public.r1b_notes.note', 'public.r1b_run_targets'], []), value)
        rc, value = self.step('verify')
        self.assertFalse([f for f in value['failures'] if f.startswith(('LEDGER', 'PRIVILEGE', 'MIGRATIONS'))], value)
        summary['gone'] = {'verify': gone, 'rebaselineGone': ['public.r1b_notes.note', 'public.r1b_run_targets']}
        for text in self.outputs:
            for password in self.passwords.values():
                self.assertNotIn(password, text)
        print(json.dumps(summary, sort_keys=True, indent=1))


if __name__ == '__main__':
    unittest.main(verbosity=2)
