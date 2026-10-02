"""Generated-only source renderer tests; no retained runtime or LS/model calls."""
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from PIL import Image, ImageCms
import numpy as np

from registry import CurationError, file_hash, digest
import publication_derivatives as renderer


class PublicationDerivativeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='artvenn-source-derivatives-')
        self.root = Path(self.tmp.name)
        self.source_root = self.root / 'originals'
        self.source_root.mkdir()
        self.runtime = self.root / 'runtime'

    def tearDown(self):
        self.tmp.cleanup()

    def source(self, name='photo.png', size=(100, 60), color='red', **save):
        path = self.source_root / name
        with Image.new('RGB', size, color) as image:
            image.save(path, **save)
        return path

    def render(self, source, **options):
        return renderer.render(self.runtime, source, file_hash(source), 'asset-test',
                               source_root=self.source_root, **options)

    def test_full_resolution_source_not_preview_and_repeat_immutable(self):
        source = self.source(size=(5000, 2000))
        sha = file_hash(source)
        # Deliberately unreadable preview is irrelevant to publication rendering.
        previews = self.runtime / 'served-previews'; previews.mkdir(parents=True)
        (previews / 'asset-test.jpg').write_bytes(b'not an image')
        result = self.render(source)
        self.assertEqual(result['lineage']['output_dimensions'], [4096, 1638])
        self.assertEqual(result['lineage']['processing']['source_dimensions'], [5000, 2000])
        self.assertEqual(result['sourceSha256'], sha)
        self.assertEqual(file_hash(source), sha)
        self.assertNotIn(str(source), json.dumps(result['lineage']))
        target = Path(result['derivativePath']); old = target.stat().st_mtime_ns
        with patch.object(renderer.subprocess, 'run', side_effect=AssertionError('must reuse bytes')):
            replay = self.render(source)
        self.assertEqual(result, replay)
        self.assertEqual(target.stat().st_mtime_ns, old)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertFalse(any(p.name.startswith('.publication-') for p in target.parent.parent.iterdir()))

    def test_orientation_icc_no_upscale_and_exif_stripping(self):
        exif = Image.Exif(); exif[274] = 6; exif[315] = 'synthetic-test'
        source = self.source('oriented.jpg', (100, 60), exif=exif, icc_profile=renderer.srgb_profile())
        result = self.render(source)
        with Image.open(result['derivativePath']) as output:
            self.assertEqual(output.size, (60, 100))
            self.assertFalse(output.getexif())
            self.assertEqual(output.info['icc_profile'], renderer.srgb_profile())
        processing = result['lineage']['processing']
        self.assertEqual(processing['orientation']['value'], 6)
        self.assertEqual(processing['color_handling'], 'embedded-profile-converted-to-sRGB')
        self.assertEqual(processing['source_icc_sha256'], digest(renderer.srgb_profile()))

    def test_alpha_composites_on_white(self):
        source = self.source_root / 'alpha.png'
        Image.new('RGBA', (40, 40), (255, 0, 0, 0)).save(source)
        result = self.render(source)
        with Image.open(result['derivativePath']) as output:
            self.assertEqual(output.getpixel((20, 20)), (255, 255, 255))

    def test_missing_original_never_uses_existing_derivative(self):
        source = self.source(); sha = file_hash(source); self.render(source); source.unlink()
        with self.assertRaisesRegex(CurationError, 'SOURCE_UNAVAILABLE'):
            renderer.render(self.runtime, source, sha, 'asset-test', source_root=self.source_root)

    def test_source_change_before_or_during_decode_refused(self):
        source = self.source(); original_sha = file_hash(source)
        source.write_bytes(b'changed')
        with self.assertRaisesRegex(CurationError, 'SOURCE_HASH_CHANGED'):
            renderer.render(self.runtime, source, original_sha, 'asset-test', source_root=self.source_root)
        source = self.source(); sha = file_hash(source); recipe = renderer.recipe_for(source)
        original = renderer._rgb_original
        def mutate(*args):
            value = original(*args); source.write_bytes(b'changed-during-decode'); return value
        with patch.object(renderer, '_rgb_original', side_effect=mutate):
            with self.assertRaisesRegex(CurationError, 'SOURCE_HASH_CHANGED'):
                renderer._render_file(source, self.root / 'partial.jpg', self.source_root, sha, recipe)
        self.assertFalse((self.runtime / 'derivatives').exists())

    def test_tampered_bundle_refused_and_not_replaced(self):
        source = self.source(); result = self.render(source)
        target = Path(result['derivativePath']); target.write_bytes(b'tampered')
        with self.assertRaisesRegex(CurationError, 'PUBLICATION_DERIVATIVE_TAMPERED'):
            self.render(source)
        self.assertEqual(target.read_bytes(), b'tampered')

    def test_tampered_lineage_recipe_refused(self):
        source = self.source(); result = self.render(source)
        sidecar = Path(result['derivativePath']).parent / 'lineage.json'
        value = json.loads(sidecar.read_text()); value['recipe']['quality'] = 20
        sidecar.write_text(json.dumps(value))
        with self.assertRaisesRegex(CurationError, 'PUBLICATION_DERIVATIVE_TAMPERED'):
            self.render(source)

    def test_outside_or_symlink_source_refused(self):
        outside = self.root / 'outside.png'; Image.new('RGB', (10, 10)).save(outside)
        with self.assertRaisesRegex(CurationError, 'OUTSIDE_SELECTION'):
            self.render(outside)
        link = self.source_root / 'link.png'; link.symlink_to(outside)
        with self.assertRaisesRegex(CurationError, 'SYMLINK_REFUSED'):
            self.render(link)

    def test_corrupt_source_and_bad_icc_atomic_cleanup(self):
        source = self.source_root / 'bad.png'; source.write_bytes(b'explicit-synthetic-invalid-image')
        with self.assertRaisesRegex(CurationError, 'UNSUPPORTED_OR_CORRUPT_MEDIA'):
            self.render(source)
        self.assertEqual(list((self.runtime / 'derivatives').iterdir()), [])
        source = self.source(icc_profile=b'explicit-synthetic-invalid-icc')
        with self.assertRaisesRegex(CurationError, 'SOURCE_ICC_INVALID_OR_UNSUPPORTED'):
            self.render(source)
        self.assertEqual(list((self.runtime / 'derivatives').iterdir()), [])

    def test_native_child_deadline_and_private_environment(self):
        source = self.source()
        with patch.object(renderer.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 1)) as child:
            with patch.dict(renderer.os.environ, {'OPENAI_API_KEY': 'SYNTHETIC_NOT_REAL'}):
                with self.assertRaisesRegex(CurationError, 'PUBLICATION_DECODE_TIMEOUT'):
                    self.render(source, timeout=1)
        self.assertEqual(child.call_args.kwargs['timeout'], 1)
        self.assertNotIn('OPENAI_API_KEY', child.call_args.kwargs['env'])
        self.assertEqual(list((self.runtime / 'derivatives').iterdir()), [])

    def test_pixel_and_output_byte_limits(self):
        source = self.source(size=(100, 60)); recipe = renderer.recipe_for(source)
        with patch.object(renderer, 'MAX_PIXELS', 100):
            with self.assertRaisesRegex(CurationError, 'IMAGE_PIXEL_BOUND_EXCEEDED'):
                renderer._render_file(source, self.root / 'large.jpg', self.source_root, file_hash(source), recipe)
        with patch.object(renderer, 'MAX_BYTES', 1):
            with self.assertRaisesRegex(CurationError, 'PUBLICATION_DERIVATIVE_TOO_LARGE'):
                renderer._render_file(source, self.root / 'large.jpg', self.source_root, file_hash(source), recipe)

    def test_untagged_cmyk_and_multiframe_refused(self):
        source = self.source_root / 'cmyk.jpg'; Image.new('CMYK', (20, 20)).save(source)
        with self.assertRaisesRegex(CurationError, 'UNTAGGED_COLOR_MODE_UNSUPPORTED'):
            self.render(source)
        source = self.source_root / 'frames.tiff'
        Image.new('RGB', (20, 20), 'red').save(source, save_all=True, append_images=[Image.new('RGB', (20, 20), 'blue')])
        with self.assertRaisesRegex(CurationError, 'MULTIFRAME_SOURCE_REFUSED'):
            self.render(source)

    def test_raw_full_decode_orientation_recipe_and_lineage(self):
        source = self.source_root / 'synthetic.arw'; source.write_bytes(b'EXPLICIT_SYNTHETIC_RAW_PLACEHOLDER')
        camera = Mock(); camera.sizes = types.SimpleNamespace(raw_width=6000, raw_height=4000, width=5980, height=3990, flip=6)
        camera.postprocess.return_value = np.zeros((60, 40, 3), dtype=np.uint8)
        context = Mock(); context.__enter__ = Mock(return_value=camera); context.__exit__ = Mock(return_value=False)
        library = types.SimpleNamespace(imread=Mock(return_value=context), ColorSpace=types.SimpleNamespace(sRGB='sRGB'), libraw_version=(0, 22, 1))
        recipe = renderer.recipe_for(source)
        with patch.dict('sys.modules', {'rawpy': library}):
            lineage = renderer._render_file(source, self.root / 'raw.jpg', self.source_root, file_hash(source), recipe)
        options = camera.postprocess.call_args.kwargs
        self.assertFalse(options['half_size']); self.assertIsNone(options['user_flip'])
        self.assertEqual(options['gamma'], (2.4, 12.92)); self.assertTrue(options['no_auto_bright'])
        self.assertEqual(lineage['output_dimensions'], [40, 60])
        self.assertEqual(lineage['processing']['orientation']['value'], 6)
        self.assertEqual(lineage['processing']['libraw_version'], [0, 22, 1])
        # Not a real-camera decoder or visual acceptance claim.

    def test_same_bytes_different_asset_reuses_bundle(self):
        source = self.source(); first = self.render(source)
        second = renderer.render(self.runtime, source, file_hash(source), 'asset-alias', source_root=self.source_root)
        self.assertEqual(first['derivativePath'], second['derivativePath'])
        self.assertEqual(first['lineage'], second['lineage'])
        self.assertNotEqual(first['assetId'], second['assetId'])


if __name__ == '__main__':
    unittest.main()
