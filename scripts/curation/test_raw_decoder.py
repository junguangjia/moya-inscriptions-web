"""Synthetic RAW boundary tests; real source images never enter test output."""
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock,patch
import numpy as np
from PIL import Image
import raw_decoder
from registry import Registry,CurationError,file_hash


class RawTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.source=self.root/'chosen';self.source.mkdir()
        self.raw=self.source/'synthetic.arw';self.raw.write_bytes(b'EXPLICIT_SYNTHETIC_RAW_NOT_A_CAMERA_FILE')
        self.target=self.root/'preview.jpg';self.sha=file_hash(self.raw)
        self.camera=Mock();self.camera.sizes=types.SimpleNamespace(raw_width=6000,raw_height=4000,width=5980,height=3990,flip=6)
        self.camera.postprocess.return_value=np.zeros((60,40,3),dtype=np.uint8)
        self.context=Mock();self.context.__enter__=Mock(return_value=self.camera);self.context.__exit__=Mock(return_value=False)
        self.lib=types.SimpleNamespace(imread=Mock(return_value=self.context),ColorSpace=types.SimpleNamespace(sRGB='sRGB'),libraw_version=(0,22,1))
    def tearDown(self):self.tmp.cleanup()
    def render(self):
        with patch.dict(sys.modules,{'rawpy':self.lib}),patch.object(raw_decoder.importlib.metadata,'version',return_value='0.27.1'):
            return raw_decoder.render(self.raw,self.target,self.source,self.sha)
    def test_orientation_applied_once_and_recipe_recorded(self):
        result=self.render()
        self.assertEqual(result['orientation'],{'source':'LibRaw RAW sizes.flip','value':6,'applied_once':True})
        with Image.open(self.target) as image:self.assertEqual(image.size,(40,60))
        args=self.camera.postprocess.call_args.kwargs
        self.assertIsNone(args['user_flip']);self.assertTrue(args['half_size']);self.assertTrue(args['no_auto_bright'])
        self.assertEqual(result['recipe']['gamma'],[2.222,4.5])
    def test_pixel_bound_before_native_postprocess(self):
        self.camera.sizes.raw_width=100_000
        with self.assertRaisesRegex(CurationError,'IMAGE_PIXEL_BOUND_EXCEEDED'):self.render()
        self.camera.postprocess.assert_not_called();self.assertFalse(self.target.exists())
    def test_changed_source_during_decode_has_no_usable_result(self):
        def mutate(**_):self.raw.write_bytes(b'changed');return np.zeros((40,60,3),dtype=np.uint8)
        self.camera.postprocess.side_effect=mutate
        with self.assertRaisesRegex(CurationError,'SOURCE_HASH_CHANGED'):self.render()
        self.assertFalse(self.target.exists())
    def test_missing_decoder_explicit(self):
        with patch.dict(sys.modules,{'rawpy':None}):
            with self.assertRaisesRegex(CurationError,'RAW_DECODER_UNAVAILABLE'):raw_decoder.render(self.raw,self.target,self.source,self.sha)
    def test_real_native_corrupt_synthetic_raw_has_fixed_category(self):
        with self.assertRaisesRegex(CurationError,'UNSUPPORTED_OR_CORRUPT_MEDIA'):
            raw_decoder.preview(self.raw,self.target,self.source,self.root,self.sha)
        self.assertFalse(self.target.exists())
    def test_native_child_deadline_and_credentials_excluded(self):
        with patch.object(raw_decoder.subprocess,'run',side_effect=subprocess.TimeoutExpired(['synthetic'],60)) as child,patch.dict(raw_decoder.os.environ,{'OPENAI_API_KEY':'SYNTHETIC_NOT_REAL','LABEL_STUDIO_PASSWORD':'SYNTHETIC_NOT_REAL'}):
            with self.assertRaisesRegex(CurationError,'RAW_DECODE_TIMEOUT'):raw_decoder.preview(self.raw,self.target,self.source,self.root,self.sha)
        self.assertEqual(child.call_args.kwargs['timeout'],60)
        self.assertNotIn('OPENAI_API_KEY',child.call_args.kwargs['env']);self.assertNotIn('LABEL_STUDIO_PASSWORD',child.call_args.kwargs['env'])
    def test_failed_registry_asset_retries_same_identity_and_retains_failure(self):
        registry=Registry(self.root/'runtime')
        try:
            with patch.object(raw_decoder,'preview',side_effect=CurationError('RAW_DECODER_UNAVAILABLE')):batch=registry.inspect(self.source,synthetic=True)
            original=registry.rows('SELECT * FROM assets')[0]
            def ready(source,target,*_):Image.new('RGB',(30,20),'red').save(target,'JPEG');return {'version':raw_decoder.RAW_PREVIEW_VERSION}
            with patch.object(raw_decoder,'preview',side_effect=ready):self.assertEqual(registry.inspect(self.source,synthetic=True),batch)
            current=registry.rows('SELECT * FROM assets')[0]
            self.assertEqual(current['id'],original['id']);self.assertEqual(current['sha256'],original['sha256']);self.assertEqual(current['status'],'ready')
            self.assertEqual(len(registry.rows('SELECT * FROM assets')),1)
            failures=list((registry.root/'state').glob('*-decode-failure-*.json'))
            self.assertEqual(len(failures),1);self.assertEqual(json.loads(failures[0].read_text())['error'],'RAW_DECODER_UNAVAILABLE')
            with patch.object(raw_decoder,'preview') as decoder:registry.inspect(self.source,synthetic=True);decoder.assert_not_called()
            self.assertEqual(registry.source_verify(batch),1)
        finally:registry.db.close()
    def test_raster_exif_orientation_unchanged(self):
        self.raw.rename(self.source/'ignored.txt')
        raster=self.source/'synthetic.jpg';image=Image.new('RGB',(60,40));exif=Image.Exif();exif[274]=6;image.save(raster,exif=exif)
        registry=Registry(self.root/'runtime')
        try:
            registry.inspect(self.source,synthetic=True);asset=registry.rows('SELECT * FROM assets')[0]
            with Image.open(registry.root/'served-previews'/asset['preview']) as preview:self.assertEqual(preview.size,(40,60))
        finally:registry.db.close()


if __name__=='__main__':unittest.main()
