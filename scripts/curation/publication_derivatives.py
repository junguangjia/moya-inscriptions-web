"""Explicit, immutable publication JPEGs from retained originals, never previews."""
from __future__ import annotations

import argparse
import errno
import importlib.metadata
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile

from registry import CurationError, canonical, digest, file_hash, safe_source
from raw_decoder import RAW_EXTENSIONS

VERSION = 'source-srgb-jpeg-4096-q92-444-v1'
MAX_PIXELS = 80_000_000
MAX_BYTES = 40 * 1024 * 1024
RECIPE = {
    'version': VERSION, 'source': 'original-full-decode', 'format': 'JPEG',
    'max_edge': 4096, 'upscale': False, 'resample': 'LANCZOS',
    'quality': 92, 'subsampling': 0, 'optimize': True, 'progressive': False,
    'output_color': 'sRGB', 'embed_icc': True, 'strip_exif': True,
    'untagged_rgb_gray': 'assume-sRGB', 'untagged_cmyk': 'refuse',
    'alpha': 'composite-white', 'rendering_intent': 'relative-colorimetric',
    'raw': {'half_size': False, 'camera_white_balance': True,
            'auto_white_balance': False, 'output_bps': 8,
            'gamma': [2.4, 12.92], 'auto_brightness': False,
            'orientation': 'LibRaw-applied-once'},
}


def srgb_profile():
    """Normalize LCMS creation time so repeated renders have stable ICC bytes."""
    from PIL import ImageCms
    value = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
    value[24:36] = struct.pack('>6H', 2000, 1, 1, 0, 0, 0)
    return bytes(value)


def recipe_for(source):
    from PIL import features
    import PIL
    recipe = json.loads(canonical(RECIPE))
    recipe['implementation'] = {
        'Pillow': PIL.__version__, 'jpeg': features.version('jpg'),
        'littlecms': features.version('littlecms2'),
        'libjpeg_turbo': features.version_feature('libjpeg_turbo') if features.check_feature('libjpeg_turbo') else None,
        'output_icc_sha256': digest(srgb_profile()),
    }
    recipe['decoder'] = 'rawpy' if Path(source).suffix.lower() in RAW_EXTENSIONS else 'Pillow'
    if recipe['decoder'] == 'rawpy':
        try:
            recipe['implementation']['rawpy'] = importlib.metadata.version('rawpy')
            import rawpy
            recipe['implementation']['libraw'] = list(rawpy.libraw_version)
        except (importlib.metadata.PackageNotFoundError, ImportError):
            raise CurationError('RAW_DECODER_UNAVAILABLE') from None
    return recipe


def _rgb_original(source, recipe):
    from PIL import Image, ImageCms, ImageOps
    if recipe['decoder'] == 'rawpy':
        try:
            import rawpy
        except ImportError:
            raise CurationError('RAW_DECODER_UNAVAILABLE') from None
        with rawpy.imread(str(source)) as raw:
            sizes = raw.sizes
            if sizes.raw_width * sizes.raw_height > MAX_PIXELS:
                raise CurationError('IMAGE_PIXEL_BOUND_EXCEEDED')
            pixels = raw.postprocess(half_size=False, use_camera_wb=True, use_auto_wb=False,
                                    output_color=rawpy.ColorSpace.sRGB, output_bps=8,
                                    user_flip=None, no_auto_bright=True, gamma=(2.4, 12.92))
            image = Image.fromarray(pixels).convert('RGB')
            return image, {
                'decoder': 'rawpy', 'decoder_version': recipe['implementation']['rawpy'],
                'libraw_version': list(rawpy.libraw_version),
                'source_dimensions': [int(sizes.width), int(sizes.height)],
                'orientation': {'source': 'LibRaw RAW sizes.flip', 'value': int(sizes.flip), 'applied_once': True},
                'source_icc_sha256': None, 'color_handling': 'RAW-developed-to-sRGB',
            }
    with Image.open(source) as original:
        if original.width * original.height > MAX_PIXELS:
            raise CurationError('IMAGE_PIXEL_BOUND_EXCEEDED')
        if getattr(original, 'n_frames', 1) != 1:
            raise CurationError('MULTIFRAME_SOURCE_REFUSED')
        dimensions = list(original.size)
        orientation = original.getexif().get(274, 1)
        if not isinstance(orientation, int) or orientation not in range(1, 9):
            raise CurationError('SOURCE_ORIENTATION_INVALID')
        icc = original.info.get('icc_profile')
        image = ImageOps.exif_transpose(original)
        # Preserve alpha through color conversion, then flatten in output sRGB.
        alpha = image.convert('RGBA').getchannel('A') if ('A' in image.getbands() or 'transparency' in image.info) else None
        if icc:
            try:
                profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
                color_image = image if image.mode in {'RGB', 'CMYK', 'LAB', 'L'} else image.convert('RGB')
                image = ImageCms.profileToProfile(color_image, profile,
                    ImageCms.ImageCmsProfile(io.BytesIO(srgb_profile())),
                    renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode='RGB')
            except (ValueError, OSError, ImageCms.PyCMSError):
                raise CurationError('SOURCE_ICC_INVALID_OR_UNSUPPORTED') from None
            color_handling = 'embedded-profile-converted-to-sRGB'
        else:
            if image.mode not in {'RGB', 'RGBA', 'L', 'LA', 'P', '1'}:
                raise CurationError('UNTAGGED_COLOR_MODE_UNSUPPORTED')
            image = image.convert('RGB')
            color_handling = 'untagged-RGB-gray-assumed-sRGB'
        if alpha is not None:
            background = Image.new('RGB', image.size, 'white')
            background.paste(image, mask=alpha)
            image = background
        image.load()
        return image, {
            'decoder': 'Pillow', 'decoder_version': recipe['implementation']['Pillow'],
            'source_dimensions': dimensions,
            'orientation': {'source': 'EXIF orientation', 'value': orientation, 'applied_once': True},
            'source_icc_sha256': digest(icc) if icc else None, 'color_handling': color_handling,
        }


def _render_file(source, target, source_root, expected_sha, recipe):
    """Bounded child entry; caller owns the staging directory and timeout."""
    from PIL import Image
    source = safe_source(source_root, source)
    if not source.is_file() or file_hash(source) != expected_sha:
        raise CurationError('SOURCE_HASH_CHANGED')
    if recipe != recipe_for(source):
        raise CurationError('PUBLICATION_RECIPE_CHANGED')
    image, processing = _rgb_original(source, recipe)
    try:
        if image.width * image.height > MAX_PIXELS:
            raise CurationError('IMAGE_PIXEL_BOUND_EXCEEDED')
        processing['decoded_dimensions'] = list(image.size)
        image.thumbnail((recipe['max_edge'], recipe['max_edge']), Image.Resampling.LANCZOS)
        image.save(target, 'JPEG', quality=recipe['quality'], subsampling=recipe['subsampling'],
                   optimize=recipe['optimize'], progressive=recipe['progressive'], icc_profile=srgb_profile(), exif=b'')
        if Path(target).stat().st_size > MAX_BYTES:
            raise CurationError('PUBLICATION_DERIVATIVE_TOO_LARGE')
        source = safe_source(source_root, source)
        if file_hash(source) != expected_sha:
            raise CurationError('SOURCE_HASH_CHANGED')
        return {
            'version': VERSION, 'source_sha256': expected_sha,
            'output_sha256': file_hash(target), 'output_dimensions': list(image.size),
            'recipe_sha256': digest(recipe), 'recipe': recipe, 'processing': processing,
        }
    finally:
        image.close()


def _private_write(path, value):
    with Path(path).open('x', encoding='utf-8') as handle:
        os.chmod(path, 0o600)
        handle.write(canonical(value))
        handle.flush()
        os.fsync(handle.fileno())


def _validated_existing(directory, filename, expected_sha, recipe):
    from PIL import Image
    target, sidecar = directory / filename, directory / 'lineage.json'
    if directory.is_symlink() or target.is_symlink() or sidecar.is_symlink():
        raise CurationError('PUBLICATION_DERIVATIVE_TAMPERED')
    try:
        lineage = json.loads(sidecar.read_text())
        if (lineage['version'] != VERSION or lineage['source_sha256'] != expected_sha
                or lineage['recipe'] != recipe or lineage['recipe_sha256'] != digest(recipe)
                or target.stat().st_size > MAX_BYTES or file_hash(target) != lineage['output_sha256']):
            raise ValueError()
        with Image.open(target) as image:
            if (image.format != 'JPEG' or list(image.size) != lineage['output_dimensions']
                    or max(image.size) > recipe['max_edge'] or image.getexif()
                    or digest(image.info.get('icc_profile', b'')) != recipe['implementation']['output_icc_sha256']):
                raise ValueError()
            image.verify()
    except (OSError, ValueError, KeyError, TypeError):
        raise CurationError('PUBLICATION_DERIVATIVE_TAMPERED') from None
    return target, lineage


def render(root, source, expected_sha, asset_id, *, source_root=None, timeout=60):
    """Render one explicitly selected original; asset origin is resolved by caller.

    source_root should be its retained origin selection root. No source path enters
    returned provenance. Existing preview/derivative records are never overwritten.
    """
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha or ''):
        raise CurationError('SOURCE_DIGEST_INVALID')
    if not isinstance(asset_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}', asset_id):
        raise CurationError('ASSET_ID_INVALID')
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 60:
        raise CurationError('PUBLICATION_TIMEOUT_INVALID')
    source = Path(source).absolute()
    source_root = Path(source_root).absolute() if source_root is not None else source.parent
    source = safe_source(source_root, source)
    if not source.is_file():
        raise CurationError('SOURCE_UNAVAILABLE_OR_OUTSIDE_SELECTION')
    if file_hash(source) != expected_sha:
        raise CurationError('SOURCE_HASH_CHANGED')
    recipe = recipe_for(source)
    base = Path(root) / 'derivatives'
    if Path(root).is_symlink() or base.is_symlink():
        raise CurationError('DERIVATIVE_ROOT_UNSAFE')
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = f'original-{expected_sha}-{digest(recipe)}'
    directory, filename = base / name, f'{name}.jpg'
    if not directory.exists():
        with tempfile.TemporaryDirectory(prefix='.publication-', dir=base) as temporary:
            staging = Path(temporary)
            target, job_file, result_file = staging / filename, staging / 'job.json', staging / 'result.json'
            _private_write(job_file, {'source': str(source), 'source_root': str(source_root),
                'target': str(target), 'expected_sha': expected_sha, 'recipe': recipe, 'result': str(result_file)})
            env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ}
            env.update({'PYTHONDONTWRITEBYTECODE': '1', 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'})
            try:
                child = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), '--job', str(job_file)],
                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
            except subprocess.TimeoutExpired:
                raise CurationError('PUBLICATION_DECODE_TIMEOUT') from None
            if not result_file.exists():
                raise CurationError('PUBLICATION_DECODE_PROCESS_FAILED')
            result = json.loads(result_file.read_text())
            if child.returncode or result.get('status') != 'completed':
                raise CurationError(result.get('category', 'PUBLICATION_DECODE_PROCESS_FAILED'))
            if file_hash(safe_source(source_root, source)) != expected_sha:
                raise CurationError('SOURCE_HASH_CHANGED')
            _private_write(staging / 'lineage.json', result['lineage'])
            os.chmod(target, 0o600)
            with target.open('rb') as handle:
                os.fsync(handle.fileno())
            job_file.unlink(); result_file.unlink()
            _validated_existing(staging, filename, expected_sha, recipe)
            # Atomic bundle publication; never replace another completed bundle.
            try:
                os.rename(staging, directory)
            except OSError as exc:
                if exc.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                    raise
    target, lineage = _validated_existing(directory, filename, expected_sha, recipe)
    if file_hash(safe_source(source_root, source)) != expected_sha:
        raise CurationError('SOURCE_HASH_CHANGED')
    return {'assetId': asset_id, 'derivativePath': str(target), 'sourceSha256': expected_sha,
            'uploadedSha256': lineage['output_sha256'], 'derivativeVersion': VERSION, 'lineage': lineage}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--job', required=True); args = parser.parse_args()
    job_file = Path(args.job)
    if job_file.is_symlink() or job_file.stat().st_mode & 0o077:
        sys.exit(1)
    job = json.loads(job_file.read_text())
    try:
        lineage = _render_file(Path(job['source']), Path(job['target']), Path(job['source_root']),
                               job['expected_sha'], job['recipe'])
        _private_write(job['result'], {'status': 'completed', 'lineage': lineage})
    except Exception as exc:
        category = str(exc) if isinstance(exc, CurationError) else 'UNSUPPORTED_OR_CORRUPT_MEDIA'
        _private_write(job['result'], {'status': 'failed', 'category': category})
        sys.exit(1)
