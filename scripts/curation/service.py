"""Loopback-only native workstation lifecycle. No credentials in argv or logs."""
import argparse
import errno
import fcntl
from contextlib import contextmanager
from functools import wraps
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from registry import CurationError, Registry, private_json

CODE = Path(__file__).resolve().parent
DEFAULT_ROOT = Path.home() / 'Developer/artifacts/moya-inscriptions-web/ai-curation-v1/runtime'


def settings(root):
    root=Path(root)
    config=root/'config'/'local.json'
    if config.exists():
        if config.stat().st_mode & 0o077:
            raise CurationError('CONFIG_PERMISSIONS_INVALID')
        return json.loads(config.read_text())
    value={'username':'curation@localhost.invalid','password':secrets.token_urlsafe(32),'api_token':secrets.token_hex(20),'ui_session':secrets.token_urlsafe(32),'ls_port':3581,'ui_port':3580,'model_revision':'2fd8dacbdb8f1e54b8c005f081ec5bf79c56376b','model_path':str(root/'models'/'qwen3-vl-4b')}
    private_json(config,value)
    return value


def ls_environment(root,config):
    env={k:v for k,v in os.environ.items() if not k.startswith(('LABEL_STUDIO_','HF_'))}
    env.update({'ARTVENN_CURATION_ROOT':str(root),'ARTVENN_CURATION_UI_PORT':str(config['ui_port']),'LABEL_STUDIO_BASE_DATA_DIR':str(root/'label-studio'),'LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED':'true','LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT':str(root/'served-previews'),'LABEL_STUDIO_COLLECT_ANALYTICS':'false','LABEL_STUDIO_LATEST_VERSION_CHECK':'false','LABEL_STUDIO_SENTRY_DSN':'','LABEL_STUDIO_FRONTEND_SENTRY_DSN':'','LABEL_STUDIO_FEATURE_FLAGS_OFFLINE':'true','LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK':'true','LABEL_STUDIO_USERNAME':config['username'],'LABEL_STUDIO_PASSWORD':config['password'],'LABEL_STUDIO_USER_TOKEN':config['api_token'],'LABEL_STUDIO_HOST':f"http://127.0.0.1:{config['ls_port']}",'LABEL_STUDIO_CSRF_TRUSTED_ORIGINS':f"http://127.0.0.1:{config['ls_port']}"})
    return env


def available(port):
    # On macOS a reuse bind can coexist with a wildcard listener. Refuse every
    # active loopback-reachable listener before checking closed-socket reuse.
    with socket.socket() as probe:
        probe.settimeout(.2)
        if probe.connect_ex(('127.0.0.1',port)) != errno.ECONNREFUSED:
            return False
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        try: sock.bind(('127.0.0.1',port))
        except OSError: return False
    return True


def owned_process(record,root,kind):
    pid=record['pid'] if isinstance(record,dict) else record
    try:
        result=subprocess.run(['/bin/ps','-p',str(pid),'-o','lstart=','-o','command='],capture_output=True,text=True,timeout=3)
        command=result.stdout
        expected=str(CODE/'app.py') if kind=='helper' else 'label-studio'
        matched=(expected in command or (kind=='label-studio' and str(CODE/'ls_start.py') in command))
        # LS argv contains its task-owned binary; helper argv contains explicit root.
        return result.returncode==0 and matched and str(root) in command and (not isinstance(record,dict) or result.stdout.strip()[:24]==record['birth'][:24])
    except (OSError,subprocess.TimeoutExpired): return False


@contextmanager
def lifecycle_lock(root):
    directory=Path(root).absolute()/'state'
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (directory/'lifecycle.lock').open('a') as claim:
        os.chmod(directory/'lifecycle.lock',0o600)
        deadline=time.monotonic()+15
        while True:
            try:fcntl.flock(claim,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>=deadline:raise CurationError('LIFECYCLE_BUSY')
                time.sleep(.05)
        try:yield
        finally:fcntl.flock(claim,fcntl.LOCK_UN)


def serialized(function):
    @wraps(function)
    def operation(root,*args,**kwargs):
        with lifecycle_lock(root):return function(root,*args,**kwargs)
    return operation


def http_ready(port,kind):
    path='/' if kind=='helper' else '/user/login/'
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=2) as response:
            return response.status==200 and 'text/html' in response.headers.get('Content-Type','')
    except (OSError,ValueError):return False


@serialized
def start(root,open_ui=False):
    root=Path(root).absolute()
    Registry(root)
    config=settings(root)
    record=root/'state'/'processes.json'
    processes=json.loads(record.read_text()) if record.exists() else {}
    for kind in ('label-studio','helper'):
        if kind in processes and owned_process(processes[kind],root,kind):
            port=config['ls_port' if kind=='label-studio' else 'ui_port']
            if not http_ready(port,kind):raise CurationError(f'{kind.upper()}_OWNED_BUT_NOT_READY')
            continue
        port=config['ls_port' if kind=='label-studio' else 'ui_port']
        if not available(port): raise CurationError(f'{kind.upper()}_PORT_OCCUPIED')
        if kind=='label-studio':
            executable=root/'ls-env'/'bin'/'label-studio'
            env=ls_environment(root,config)
            subprocess.run([str(executable),'init','--no-browser','--enable-legacy-api-token','--data-dir',str(root/'label-studio')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=90,check=True)
            command=[str(root/'ls-env/bin/python'),str(CODE/'ls_start.py'),'start','--no-browser','--enable-legacy-api-token','--internal-host','127.0.0.1','--port',str(port),'--data-dir',str(root/'label-studio'),'--log-level','ERROR']
        else:
            env=os.environ.copy()
            command=[str(root/'ls-env'/'bin'/'python'),str(CODE/'app.py'),'--root',str(root)]
        # Console output may contain untrusted data; do not persist process output.
        child=subprocess.Popen(command,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        birth=subprocess.run(['/bin/ps','-p',str(child.pid),'-o','lstart=','-o','command='],capture_output=True,text=True,check=True,timeout=3).stdout.strip()
        processes[kind]={'pid':child.pid,'birth':birth}
        private_json(record,processes)
        deadline=time.monotonic()+60
        while not http_ready(port,kind) and time.monotonic()<deadline:
            if child.poll() is not None: raise CurationError(f'{kind.upper()}_START_FAILED')
            time.sleep(.3)
        if not http_ready(port,kind): raise CurationError(f'{kind.upper()}_START_TIMEOUT')
    if open_ui: subprocess.run(['/usr/bin/open',f"http://127.0.0.1:{config['ui_port']}"],check=True)
    return {'local_setup':'running','ui_url':f"http://127.0.0.1:{config['ui_port']}",'review_url':f"http://127.0.0.1:{config['ls_port']}"}


def analysis_process(root):
    file=Path(root)/'state'/'analysis-process.json'
    if not file.exists():return None
    record=json.loads(file.read_text())
    if not record.get('active'):return None
    try:
        result=subprocess.run(['/bin/ps','-p',str(record['pid']),'-o','lstart=','-o','command='],capture_output=True,text=True,timeout=3)
        if result.returncode==0 and result.stdout.strip()[:24]==record['birth'][:24] and str(CODE/'worker.py') in result.stdout and str(root) in result.stdout:return record
    except (OSError,subprocess.TimeoutExpired):pass
    return None


def cancel_analysis(root):
    record=analysis_process(root)
    if record:
        if record.get('pgid')==record['pid']:os.killpg(record['pid'],signal.SIGTERM)
        else:os.kill(record['pid'],signal.SIGTERM)
        return True
    return False


@serialized
def stop(root):
    root=Path(root).absolute()
    cancel_analysis(root)
    development=root/'development'
    if (development/'development-processes.json').exists():
        subprocess.run(['/opt/homebrew/bin/mise','exec','--','node',str(CODE/'setup-development.mjs'),'stop',str(development)],cwd=CODE.parents[1],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=True)
    record=root/'state'/'processes.json'
    processes=json.loads(record.read_text()) if record.exists() else {}
    stopped=[]
    for kind,pid in processes.items():
        if owned_process(pid,root,kind):
            os.kill(pid['pid'] if isinstance(pid,dict) else pid,signal.SIGTERM)
            stopped.append(kind)
    deadline=time.monotonic()+15
    while any(owned_process(processes[kind],root,kind) for kind in stopped) and time.monotonic()<deadline:time.sleep(.1)
    if any(owned_process(processes[kind],root,kind) for kind in stopped):raise CurationError('OWNED_STOP_TIMEOUT')
    return {'stopped':stopped,'persistent_data':'retained'}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['start','stop','status'])
    parser.add_argument('--root',default=str(DEFAULT_ROOT))
    parser.add_argument('--open',action='store_true')
    args=parser.parse_args()
    try:
        value=start(args.root,args.open) if args.action=='start' else stop(args.root) if args.action=='stop' else Registry(args.root).status()
        print(json.dumps(value))
    except Exception as exc:
        print(json.dumps({'status':'failed','category':str(exc) if isinstance(exc,CurationError) else type(exc).__name__}))
        sys.exit(1)
