"""Stands in for the private builder in the tool's own tests: writes <out>/artifacts/<role>-manifest.json and
<role>-extracted/ from a spec the test wrote (synthetic files only)."""
import argparse
import base64
import json
import os
import pathlib
import sys

parser = argparse.ArgumentParser()
for name in ('--spec', '--commit', '--out', '--roles'):
    parser.add_argument(name, required=True)
args = parser.parse_args()
spec = json.loads(pathlib.Path(args.spec).read_text())
if spec.get('fail'):
    sys.exit(3)
out = pathlib.Path(args.out) / 'artifacts'
out.mkdir(parents=True, exist_ok=True)
for role in args.roles.split(','):
    item = spec['artifacts'][role]
    manifest = json.loads(item['manifest'])
    manifest['source'] = spec.get('source') or args.commit
    (out / ('%s-manifest.json' % role)).write_text(json.dumps(manifest, sort_keys=True))
    for path, b64 in item['files'].items():
        target = out / ('%s-extracted' % role) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(b64))
print(json.dumps({'status': 'COMPILED', 'roles': args.roles}))
