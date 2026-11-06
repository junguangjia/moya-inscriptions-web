"""Runs the release tool's own tests: each test class in its own process, a few at a time, once per profile (the
fictional fixture always; also the profile ARTVENN_RELEASE_PROFILE names, when set). Prints `Ran N tests` to stderr
and exits non-zero when anything failed. With a private profile it also refuses when a tracked release file holds one
of that profile's host facts (paths, live labels and commits, roots, pin files, env file paths, host names, timer
names, key file names): those stay in the private profile.

  python3 -I -B scripts/release/tests/run_all.py
  ARTVENN_RELEASE_PROFILE=<private profile.json> python3 -I -B scripts/release/tests/run_all.py
"""
import concurrent.futures
import json
import os
import pathlib
import re
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
sys.dont_write_bytecode = True
MODULES = ('test_host', 'test_client')


def classes():
    loader = unittest.defaultTestLoader
    names = []
    for module in MODULES:
        mod = __import__(module)
        for name in sorted(dir(mod)):
            obj = getattr(mod, name)
            if isinstance(obj, type) and issubclass(obj, unittest.TestCase) and obj.__module__ == module and \
                    loader.getTestCaseNames(obj):
                names.append('%s.%s' % (module, name))
    return names


def one(name):
    suite = unittest.defaultTestLoader.loadTestsFromName(name)
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


def run(name, profile):
    env = dict(os.environ, ARTVENN_RELEASE_PROFILE=profile)
    done = subprocess.run([sys.executable, '-I', '-B', str(HERE / 'run_all.py'), '--one', name], env=env,
                          capture_output=True, text=True, timeout=600)
    ran = re.search(r'Ran (\d+) tests?', done.stderr)
    return name, profile, done.returncode, int(ran.group(1)) if ran else 0, done.stdout + done.stderr


def host_facts(profile_path):
    """The strings of a private profile that describe the live host."""
    value = json.loads(pathlib.Path(profile_path).read_text())
    h, local = value.get('host') or {}, value.get('local') or {}
    found = set(h.get('paths', {}).values())
    for item in (h.get('live') or {}).values():
        found |= {item.get(k) for k in ('label', 'commit', 'root', 'pinFile')}
        found.add(os.path.basename(item.get('pinFile') or ''))
    found |= {item.get('cwd') for item in (h.get('untouched') or {}).values()}
    found |= {item.get(k) for item in (h.get('envFiles') or {}).values() for k in ('path', 'staged')}
    found |= {(h.get('checks') or {}).get(k) for k in ('apex', 'issuerHost')}
    found |= {g.get(k) for g in h.get('timerGuards') or [] for k in ('timer', 'service')}
    found |= {os.path.basename(os.path.expanduser((local.get('ssh') or {}).get(k) or '')) for k in ('identity', 'knownHosts')}
    return sorted(f for f in found if isinstance(f, str) and len(f) >= 6)


def leaks(profile_path):
    """(tracked file, fact) pairs: a host fact from the private profile inside a tracked release file."""
    facts = host_facts(profile_path)
    files = [p for p in HERE.parent.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    files.append(HERE.parent.parent / 'release-tool.test.mjs')
    return [(str(p.relative_to(HERE.parent.parent)), fact) for p in files if p.exists()
            for fact in facts if fact in p.read_text(errors='replace')]


def main(argv):
    if len(argv) == 3 and argv[1] == '--one':
        return one(argv[2])
    profiles = [str(HERE / 'fixtures' / 'profile.example.json')]
    if os.environ.get('ARTVENN_RELEASE_PROFILE'):
        profiles.append(os.environ['ARTVENN_RELEASE_PROFILE'])
        found = leaks(profiles[-1])
        if found:
            for path, _ in found:
                sys.stderr.write('a host fact from the private profile is in %s\n' % path)
            sys.stderr.write('Ran 0 tests: FAILED, tracked files hold %d host fact(s)\n' % len(found))
            return 1
    jobs = [(name, profile) for profile in profiles for name in classes()]
    workers = max(1, min(4, os.cpu_count() or 1))
    total, failed = 0, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for name, profile, code, ran, text in pool.map(lambda job: run(*job), jobs):
            total += ran
            label = 'example' if profile == profiles[0] else 'profile'
            print('%s %-40s %3d tests  %s' % ('ok  ' if code == 0 else 'FAIL', name, ran, label), flush=True)
            if code != 0 or ran == 0:
                failed.append(name)
                sys.stderr.write(text[-6000:] + '\n')
    sys.stderr.write('Ran %d tests in %d classes across %d profile(s)%s\n' % (
        total, len(jobs), len(profiles), (': FAILED ' + ', '.join(failed)) if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
