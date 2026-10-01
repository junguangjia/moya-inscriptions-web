"""Build one task-local AppKit application using the already installed SDK."""
import argparse
import json
import os
import plistlib
import subprocess
from pathlib import Path


def build(source, root, destination):
    source, root, destination = (Path(p).absolute() for p in (source, root, destination))
    if destination.suffix != '.app' or destination.is_symlink() or not (root / 'ls-env/bin/python').is_file():
        raise ValueError('TASK_APP_CONFIGURATION_INVALID')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    contents = destination / 'Contents'
    executable = contents / 'MacOS/ArtVennCuration'
    executable.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    (contents / 'Resources').mkdir(exist_ok=True, mode=0o700)
    info = {'CFBundleExecutable': executable.name, 'CFBundleIdentifier': 'local.artvenn.curation',
            'CFBundleName': 'ArtVenn Curation', 'CFBundleDisplayName': 'ArtVenn 本地整理',
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': '3', 'CFBundleShortVersionString': '1.0.3',
            'CFBundleIconFile': 'ArtVenn.icns', 'LSMinimumSystemVersion': '14.0', 'NSHighResolutionCapable': True,
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
            'ArtVennSourceDirectory': str(source), 'ArtVennRuntimeDirectory': str(root)}
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    from PIL import Image, ImageDraw, ImageFont
    image=Image.new('RGBA',(1024,1024),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    draw.rounded_rectangle((24,24,1000,1000),radius=212,fill='#34644c')
    draw.rounded_rectangle((128,144,896,880),radius=86,fill='#f4f6ed')
    font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf',320)
    draw.text((512,502),'AV',font=font,fill='#34644c',anchor='mm',stroke_width=2)
    draw.rounded_rectangle((344,720,680,744),radius=12,fill='#a8b39c')
    image.save(contents/'Resources/ArtVenn.icns',format='ICNS')
    env = os.environ.copy()
    # Compiler/module cache stays in this task's private build output.
    cache = destination.parent / 'native-build-cache'
    cache.mkdir(exist_ok=True, mode=0o700)
    env['CLANG_MODULE_CACHE_PATH'] = str(cache)
    subprocess.run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-target', 'arm64-apple-macos14.0', '-O', '-framework', 'AppKit', '-framework', 'WebKit',
                    '-module-cache-path', str(cache), str(source / 'native/ArtVennCuration.swift'), '-o', str(executable)],
                   env=env, check=True, timeout=120)
    os.chmod(executable, 0o700)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', info['CFBundleIdentifier'], str(destination)], check=True, timeout=20)
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(destination)], check=True, timeout=20)
    return {'localApp': 'built_and_locally_signed', 'bundle': str(destination), 'runtime': 'existing_task_environment', 'production': 'NOT AUTHORIZED'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--root', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.root, args.destination)))
