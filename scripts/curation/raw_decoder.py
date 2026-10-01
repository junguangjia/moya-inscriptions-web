"""Native RAW preview conversion; bounded child, no source edits/network/content output."""
import argparse
import importlib.metadata
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from registry import CurationError, file_hash, private_json, safe_source

RAW_EXTENSIONS={'.arw','.dng','.cr2','.nef'}
RAW_PREVIEW_VERSION='libraw-camera-wb-half-size-bt709-jpeg-1536-v1'


def render(source,target,source_root,expected_sha):
    """Child-only native conversion. LibRaw applies RAW orientation exactly once."""
    from PIL import Image
    try:
        import rawpy
    except ImportError:
        raise CurationError('RAW_DECODER_UNAVAILABLE') from None
    source=safe_source(source_root,source)
    if file_hash(source)!=expected_sha:raise CurationError('SOURCE_HASH_CHANGED')
    with rawpy.imread(str(source)) as raw:
        sizes=raw.sizes
        if sizes.raw_width*sizes.raw_height>80_000_000:raise CurationError('IMAGE_PIXEL_BOUND_EXCEEDED')
        flip=int(sizes.flip)
        # Explicit reproducible development, not camera-original JPEG colors.
        pixels=raw.postprocess(half_size=True,use_camera_wb=True,use_auto_wb=False,
            output_color=rawpy.ColorSpace.sRGB,output_bps=8,user_flip=None,
            no_auto_bright=True,gamma=(2.222,4.5))
        image=Image.fromarray(pixels).convert('RGB')
        dimensions=[int(sizes.width),int(sizes.height)]
        image.thumbnail((1536,1536))
        preview_dimensions=[image.width,image.height]
        # Check before saving a usable result, then the parent checks again.
        if file_hash(source)!=expected_sha:raise CurationError('SOURCE_HASH_CHANGED')
        image.save(target,'JPEG',quality=92)
    return {'version':RAW_PREVIEW_VERSION,'decoder':'rawpy','decoder_version':importlib.metadata.version('rawpy'),
        'libraw_version':list(rawpy.libraw_version),'source_dimensions':dimensions,
        'preview_dimensions':preview_dimensions,'orientation':{'source':'LibRaw RAW sizes.flip','value':flip,'applied_once':True},
        'recipe':{'half_size':True,'camera_white_balance':True,'auto_white_balance':False,
            'output_primaries':'sRGB','output_bps':8,'gamma':[2.222,4.5],'auto_brightness':False,'max_edge':1536,'jpeg_quality':92},
        'capture':None}


def preview(source,target,source_root,state_directory,expected_sha,timeout=60):
    state_directory=Path(state_directory)
    run=uuid.uuid4().hex;job=state_directory/f'raw-decode-{run}-input.json';result=state_directory/f'raw-decode-{run}-result.json'
    private_json(job,{'source':str(source),'target':str(target),'source_root':str(source_root),'expected_sha':expected_sha,'result':str(result)})
    environment={key:os.environ[key] for key in ('PATH','HOME','LANG','LC_ALL','TMPDIR') if key in os.environ}
    environment.update({'PYTHONDONTWRITEBYTECODE':'1','OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1'})
    try:
        child=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--job',str(job)],env=environment,
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=timeout)
    except subprocess.TimeoutExpired:
        raise CurationError('RAW_DECODE_TIMEOUT') from None
    if not result.exists():raise CurationError('RAW_DECODE_PROCESS_FAILED')
    value=json.loads(result.read_text())
    if child.returncode or value.get('status')!='completed':raise CurationError(value.get('category','RAW_DECODE_PROCESS_FAILED'))
    return value['processing']


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--job',required=True);args=parser.parse_args()
    job_file=Path(args.job)
    if job_file.is_symlink() or job_file.stat().st_mode&0o077:sys.exit(1)
    job=json.loads(job_file.read_text());result=Path(job['result'])
    try:
        processing=render(Path(job['source']),Path(job['target']),Path(job['source_root']),job['expected_sha'])
        private_json(result,{'status':'completed','processing':processing})
    except Exception as exc:
        private_json(result,{'status':'failed','category':str(exc) if isinstance(exc,CurationError) else 'UNSUPPORTED_OR_CORRUPT_MEDIA'})
        sys.exit(1)
