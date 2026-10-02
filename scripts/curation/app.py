"""Small local action menu; source content stays on this workstation."""
import argparse
import http.cookies
import html
import json
import os
import secrets
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from registry import Registry, CurationError, private_json
from service import CODE, settings, analysis_process, cancel_analysis
from presentation import object_directory, rename
from daily import folder_path, folder_count, overview, selected_objects




class Application:
    def __init__(self,root):
        self.root=Path(root)
        self.config=settings(self.root)
        self.config["ui_session"]=secrets.token_urlsafe(32)
        self.csrf=secrets.token_urlsafe(32)
        self.lock=threading.Lock()
        self.worker=None
        self.job={'status':'idle'}
        self.selected=None
        saved=self.root/'state'/'selection.json'
        if saved.exists(): self.selected=json.loads(saved.read_text())

    def registry(self): return Registry(self.root)

    def execute_editorial(self,args,timeout=180,allow_partial=False):
        result=subprocess.run(['/opt/homebrew/bin/mise','exec','--','node',*args],cwd=CODE.parents[1],capture_output=True,text=True,timeout=timeout)
        try:receipt=json.loads(result.stdout)
        except ValueError:raise CurationError('DEVELOPMENT_CHILD_FAILED') from None
        if result.returncode and not (allow_partial and receipt.get('developmentIntegration')=='PARTIAL'):raise CurationError(receipt.get('category','DEVELOPMENT_CHILD_FAILED'))
        return receipt

    def remember_drafts(self,batch_dir,result,synthetic):
        summary=json.loads((batch_dir/'integration-summary.json').read_text())
        mapping_file=self.root/'state/cms-draft-mappings.json'
        bindings=json.loads(mapping_file.read_text()) if mapping_file.exists() else {}
        drafts=[row for row in summary['results'] if row['status']=='verified']
        for row in drafts:bindings[row['objectId']]=row['cmsDraft']
        private_json(mapping_file,bindings)
        private_json(self.root/'state/development-result.json',{**result,'synthetic':synthetic,'packageHash':summary['packageHash'],'drafts':drafts})
        from daily import admin_drafts
        return {'status':('development_draft_verified' if synthetic else 'admin_draft_verified') if not summary['failed'] else 'development_partial',
                'succeeded':summary['succeeded'],'failed':summary['failed'],
                'drafts':admin_drafts(self.root,{r['objectId'] for r in drafts}),'production_publication':'NOT AUTHORIZED'}

    def current_job(self):
        from registry import digest
        selection=self.root/'state/selection.json'
        if selection.exists() and self.selected:
            saved=json.loads(selection.read_text())
            if saved.get('source')==self.selected.get('source') and saved.get('generation')==self.selected.get('generation'):
                self.selected.clear();self.selected.update(saved)
        file=self.root/'state/worker-status.json'
        if file.exists() and self.selected:
            value=json.loads(file.read_text())
            key=digest({'source':self.selected['source'],'synthetic':self.selected['synthetic']})
            if value.get('selection_key')==key:return value
        return self.job

    def action(self,value):
        action=value.get('action')
        if action in {'select','select-path','synthetic'}:
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None): raise CurationError('ANALYSIS_RUNNING')
            limit=int(value.get('limit',50))
            if not 1<=limit<=1000:raise CurationError('BATCH_LIMIT_INVALID')
            if action=='select':
                result=subprocess.run(['/usr/bin/osascript','-e','POSIX path of (choose folder with prompt "选择一小批 ArtVenn 照片（只在本机处理，建议20–50张）")'],capture_output=True,text=True,timeout=300)
                if result.returncode: return {'status':'selection_cancelled'}
                source=str(folder_path(result.stdout.strip()));synthetic=False
            elif action=='select-path':
                source=str(folder_path(value.get('path')))
                from synthetic_fixture import certified
                synthetic=certified(Path(source))
                if value.get('syntheticOnly') is True and not synthetic:raise CurationError('SYNTHETIC_PROVENANCE_REQUIRED')
            else:
                from synthetic_fixture import create_fixture
                source=str(self.root/'synthetic')
                try:create_fixture(Path(source))
                except ValueError as exc:raise CurationError(str(exc)) from None
                synthetic=True
            counted=folder_count(source,limit)
            if not counted['count']:raise CurationError('NO_SUPPORTED_CANDIDATE_FILES')
            self.selected={'source':source,'synthetic':synthetic,'generation':secrets.token_hex(8),**counted}
            private_json(self.root/'state'/'selection.json',self.selected)
            self.job={'status':'idle'}
            from registry import digest
            private_json(self.root/'state/worker-status.json',{'status':'idle','selection_key':digest({'source':source,'synthetic':synthetic})})
            return {'status':'selected_synthetic' if synthetic else 'selected_local_folder',**counted}
        if action=='analyze':
            if not self.selected: raise CurationError('SELECT_FOLDER_FIRST')
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None): raise CurationError('ANALYSIS_RUNNING')
            limit=int(value.get('limit',50))
            if not 1<=limit<=1000:raise CurationError('BATCH_LIMIT_INVALID')
            from registry import digest
            private_json(self.root/'state/worker-status.json',{'status':'running','selection_key':digest({'source':self.selected['source'],'synthetic':self.selected['synthetic']})})
            # Worker owns its SQLite connection; HTTP remains responsive.
            self.worker=subprocess.Popen([str(self.root/'ls-env/bin/python'),str(CODE/'worker.py'),'analyze','--root',str(self.root),'--limit',str(limit)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            self.job={'status':'running'}
            return self.job
        if action=='cancel':
            cancel_analysis(self.root)
            if self.worker and self.worker.poll() is None:
                try:os.killpg(self.worker.pid,15)
                except ProcessLookupError:pass
            self.job={'status':'cancelled_checkpoint_retained'}
            from registry import digest
            if self.selected:private_json(self.root/'state/worker-status.json',{**self.job,'selection_key':digest({'source':self.selected['source'],'synthetic':self.selected['synthetic']})})
            return self.job
        if action in {'save-capture', 'resolve-object-alias'}:
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None):raise CurationError('ANALYSIS_RUNNING')
            if value.get('confirmed') is not True:raise CurationError('EXPLICIT_CONFIRMATION_REQUIRED')
            registry=self.registry()
            try:
                oid=value.get('objectId')
                obj=__import__('presentation').card(registry.db,oid)
                if action=='resolve-object-alias':
                    from identity import record_object_alias
                    decision=registry.db.execute("SELECT d.id FROM decisions d JOIN proposals p ON p.id=d.proposal_id WHERE p.subject=? AND p.kind='group' AND d.status IN ('accepted','corrected') ORDER BY p.version DESC,d.created DESC LIMIT 1",(oid,)).fetchone()
                    if not decision:raise CurationError('OBJECT_ALIAS_REVIEW_REQUIRED')
                    return record_object_alias(registry,oid,value.get('targetId'),decision[0],whole_object_confirmed=True,expected_revision=value.get('revision',0))
                from identity import occurrences
                allowed={o['id'] for a in obj['assets'] for o in occurrences(registry,a['id'])}
                requested=value.get('occurrenceIds',[])
                if not isinstance(requested,list) or any(not isinstance(oid,str) for oid in requested) or not set(requested)<=allowed:raise CurationError('CAPTURE_OCCURRENCE_SCOPE_INVALID')
                from capture_session import create,save
                provenance={'kind':'manual','actor':'local-form'}
                if value.get('captureId'):
                    return save(registry,value['captureId'],value.get('metadata',{}),provenance,expected_revision=value.get('revision'),occurrence_ids=requested)
                return create(registry,value.get('metadata',{}),provenance,occurrence_ids=requested)
            finally:registry.db.close()
        if action in {'begin-intake', 'export-dataset'}:
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None):raise CurationError('ANALYSIS_RUNNING')
            registry=self.registry()
            try:
                if action=='export-dataset':
                    if value.get('confirmed') is not True:raise CurationError('EXPLICIT_DATASET_SELECTION_REQUIRED')
                    ids=value.get('objectIds')
                    if not isinstance(ids,list) or not 1<=len(ids)<=12 or any(not isinstance(oid,str) for oid in ids) or len(set(ids))!=len(ids):raise CurationError('DATASET_SELECTION_INVALID')
                    for oid in ids:__import__('presentation').card(registry.db,oid)
                    registry.db.close()
                    from dataset_export import export_dataset
                    return export_dataset(self.root/'state/curation.sqlite',ids,self.root/'state/datasets')
                source=value.get('path')
                if source is None:
                    chosen=subprocess.run(['/usr/bin/osascript','-e','POSIX path of (choose folder with prompt "选择要增补的一小批照片（最多50张）")'],capture_output=True,text=True,timeout=300)
                    if chosen.returncode:return {'status':'selection_cancelled'}
                    source=chosen.stdout.strip()
                from intake import begin
                return begin(registry,value.get('objectId'),source,value.get('paths'),value.get('captureSessionId'))
            finally:registry.db.close()
        if action=='rename-object':
            registry=self.registry()
            try:return rename(registry.db,value.get('objectId'),value.get('name'))
            finally:registry.db.close()
        if action in {'begin-review','save-review-draft','confirm-review','prepare-reviewed-package'}:
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None):raise CurationError('ANALYSIS_RUNNING')
            import guided_review
            registry=self.registry()
            try:
                material=value.get('material')
                if material not in {'local','synthetic'}:raise CurationError('MATERIAL_FILTER_INVALID')
                if action=='begin-review':
                    requested=value.get('objectIds')
                    if not isinstance(requested,list) or not requested:raise CurationError('EXPLICIT_REVIEW_SCOPE_REQUIRED')
                    ids=selected_objects(registry,self.selected,material,requested)
                    return guided_review.begin(registry,ids,material)
                session=guided_review.read(registry,value.get('reviewId'),material)
                if session.get('mode') != 'incremental/v1':selected_objects(registry,self.selected,material,session['objectIds'])
                if action=='save-review-draft':return guided_review.save(registry,session,value.get('draft'),value.get('revision'))
                if action=='confirm-review':return guided_review.confirm(registry,self.config,session,value.get('draft'),value.get('revision'),value.get('confirmed'))
                return guided_review.prepare_package(registry,session,value.get('choice',{}),value.get('confirmed'))
            finally:registry.db.close()
        if action in {'collect','renew-review','prepare'}:
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None):raise CurationError('ANALYSIS_RUNNING')
            registry=self.registry()
            try:
                requested=value.get('objectIds')
                if action=='prepare':requested=[c.get('objectId') for c in value.get('objects',[])]
                ids=selected_objects(registry,self.selected,value.get('material','current'),requested)
                if action=='collect':
                    from worker import collect
                    return collect(registry,self.config,ids)
                if action=='renew-review':
                    if value.get('confirmed') is not True:raise CurationError('EXPLICIT_RENEW_CONFIRMATION_REQUIRED')
                    from worker import renew_review
                    return renew_review(registry,self.config,ids)
                from worker import prepare
                return prepare(registry,value.get('objects',[]))
            finally:registry.db.close()
        if action=='admin-draft':
            if analysis_process(self.root) or (self.worker and self.worker.poll() is None):raise CurationError('ANALYSIS_RUNNING')
            saved=self.root/'state/prepared-package.json'
            if not saved.exists():raise CurationError('PREPARE_PACKAGE_FIRST')
            prepared=json.loads(saved.read_text())
            if value.get('reviewId'):
                import guided_review
                registry=self.registry()
                try:
                    session=guided_review.read(registry,value['reviewId'],value.get('material'))
                    expected=session.get('package',{}).get('offline_validation',{}).get('packageHash')
                    if (session.get('state')!='package_prepared' or not expected
                        or expected!=prepared.get('validation',{}).get('packageHash')
                        or session.get('revision')!=value.get('revision')
                        or session.get('collectedSnapshot')!=guided_review.snapshot(registry,session['objectIds'])):
                        raise CurationError('REVIEW_PREVIEW_STALE')
                finally:registry.db.close()
            if prepared.get('synthetic') is True:return self.action({**value,'action':'development'})
            authorization=self.root/'state/real-draft-authorization.json'
            target=self.root/'config/editorial-target.json'
            if not authorization.is_file():raise CurationError('REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED')
            if not target.is_file():raise CurationError('EDITORIAL_TARGET_NOT_CONFIGURED')
            package=Path(prepared['path'])
            data=json.loads(package.read_text())
            registry=self.registry()
            try:selected_objects(registry,self.selected,value.get('material','current'),[o['objectId'] for o in data['objects']])
            finally:registry.db.close()
            batch_dir=self.root/'receipts'/('authorized-draft-'+__import__('hashlib').sha256(package.read_bytes()).hexdigest())
            result=self.execute_editorial([str(CODE/'adapter.mjs'),'draft',str(CODE.parents[1]),str(package),str(target),str(batch_dir),str(authorization)],allow_partial=True)
            return self.remember_drafts(batch_dir,result,False)
        if action=='development':
            prepared_file=self.root/'state'/'prepared-package.json'
            if not prepared_file.exists():raise CurationError('PREPARE_PACKAGE_FIRST')
            prepared=json.loads(prepared_file.read_text())
            if prepared['synthetic'] is not True:raise CurationError('REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED')
            from worker import synthetic_package_verified
            registry=self.registry()
            try:
                if not synthetic_package_verified(registry,json.loads(Path(prepared['path']).read_text())):raise CurationError('SYNTHETIC_PROVENANCE_REQUIRED')
            finally:registry.db.close()
            state_dir=self.root/'development';state_dir.mkdir(exist_ok=True,mode=0o700)
            package=Path(prepared['path']);repo=CODE.parents[1]
            execute=self.execute_editorial
            lifecycle=CODE/'setup-development.mjs'
            if (state_dir/'development-processes.json').exists():
                execute([str(lifecycle),'restart',str(state_dir)],180)
            else:
                execute([str(lifecycle),'setup',str(repo),str(package),str(state_dir),'postgres:18.4'],330)
            batch_dir=self.root/'receipts'/('development-'+__import__('hashlib').sha256(package.read_bytes()).hexdigest())
            result=execute([str(CODE/'adapter.mjs'),'draft',str(repo),str(package),str(state_dir/'cms-config.json'),str(batch_dir)],180,allow_partial=True)
            return self.remember_drafts(batch_dir,result,True)
        if action=='stop':
            self.action({'action':'cancel'})
            state_dir=self.root/'development'
            if (state_dir/'development-processes.json').exists():
                subprocess.run(['/opt/homebrew/bin/mise','exec','--','node',str(CODE/'setup-development.mjs'),'stop',str(state_dir)],cwd=CODE.parents[1],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=True)
            # A separate controller can stop this helper without killing its own
            # shutdown loop before Label Studio has received SIGTERM.
            threading.Timer(.5,lambda:subprocess.Popen([str(self.root/'ls-env/bin/python'),str(CODE/'service.py'),'stop','--root',str(self.root)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)).start()
            return {'status':'stopping_persistent_data_retained'}
        raise CurationError('ACTION_NOT_ALLOWED')


def run(root):
    app=Application(root)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def valid(self):
            host=self.headers.get('Host','')
            return host==f"127.0.0.1:{app.config['ui_port']}" and self.client_address[0]=='127.0.0.1'
        def send(self,status,value,content_type='application/json',cookies=()):
            data=value.encode() if isinstance(value,str) else json.dumps(value,ensure_ascii=False).encode()
            self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'")
            for cookie in cookies:self.send_header('Set-Cookie',cookie)
            self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if not self.valid(): return self.send(403,{'category':'LOOPBACK_HOST_REQUIRED'})
            parsed=urllib.parse.urlsplit(self.path)
            if parsed.path in {'/','/objects'}:
                page=(CODE/('ui/home.html' if parsed.path=='/' else 'ui/objects.html')).read_text()
                headers=[f"curation_session={app.config['ui_session']}; HttpOnly; SameSite=Strict; Path=/",f"curation_csrf={app.csrf}; SameSite=Strict; Path=/"]
                if urllib.parse.parse_qs(parsed.query).get('material')!=['synthetic']:
                    headers.append("artvenn_review_focus=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/")
                return self.send(200,page,'text/html; charset=utf-8',headers)
            cookies=http.cookies.SimpleCookie(self.headers.get('Cookie',''))
            if cookies.get('curation_session') is None or cookies['curation_session'].value!=app.config['ui_session']:
                return self.send(403,{'category':'LOCAL_SESSION_REQUIRED'})
            if parsed.path in {'/assets/objects.js','/assets/objects.css','/assets/home.js','/assets/home.css','/assets/guided-review.js','/assets/capture.js'}:
                name=parsed.path.rsplit('/',1)[1]
                return self.send(200,(CODE/'ui'/name).read_text(),'text/javascript; charset=utf-8' if name.endswith('.js') else 'text/css; charset=utf-8')
            if parsed.path=='/guided-review':
                import guided_review
                registry=app.registry()
                try:
                    query=urllib.parse.parse_qs(parsed.query)
                    material=query.get('material',[''])[0]
                    session=guided_review.read(registry,query.get('id',[''])[0],material)
                    if session.get('mode') != 'incremental/v1':selected_objects(registry,app.selected,material,session['objectIds'])
                    return self.send(200,guided_review.project(registry,session))
                except CurationError as exc:return self.send(400,{'category':str(exc)})
                finally:registry.db.close()
            if parsed.path=='/capture-data':
                registry=app.registry()
                try:
                    query=urllib.parse.parse_qs(parsed.query)
                    obj=__import__('presentation').card(registry.db,query.get('objectId',[''])[0])
                    from capture_session import read
                    from identity import occurrences
                    origins=[{'id':o['id'],'assetId':a['id'],'filename':o['relative_path'],'batchId':o['batch_id']} for a in obj['assets'] for o in occurrences(registry,a['id'])]
                    captures=[read(registry,r['id']) for r in registry.rows('SELECT id FROM capture_sessions ORDER BY created,id')]
                    return self.send(200,{'occurrences':origins,'captures':captures})
                except CurationError as exc:return self.send(400,{'category':str(exc)})
                finally:registry.db.close()
            if parsed.path=='/object-data':
                registry=app.registry()
                try:
                    query=urllib.parse.parse_qs(parsed.query)
                    material=query.get('material',['all'])[0]
                    if query.get('scope',['library'])[0]=='current':
                        allowed=set(selected_objects(registry,app.selected,material))
                        from daily import material_scope
                        effective=material_scope(registry,app.selected,material)[0]
                        value=object_directory(registry.db,effective)
                        value['objects']=[o for o in value['objects'] if o['id'] in allowed]
                        return self.send(200,value)
                    return self.send(200,object_directory(registry.db,material))
                except CurationError as exc:return self.send(400,{'category':str(exc)})
                finally:registry.db.close()
            if parsed.path=='/dashboard':
                registry=app.registry()
                try:
                    material=urllib.parse.parse_qs(parsed.query).get('material',['current'])[0]
                    return self.send(200,overview(registry,app.selected,app.current_job(),bool(analysis_process(app.root)),material))
                except CurationError as exc:return self.send(400,{'category':str(exc)})
                finally:registry.db.close()
            if parsed.path=='/status':
                value=app.registry().status();value.update({'selection':'Synthetic fixture' if app.selected and app.selected['synthetic'] else 'local folder selected' if app.selected else 'none','job':app.job,'ai_inference':'local model only','artvenn_integration':'offline package; isolated synthetic Development validation','production_publication':'NOT AUTHORIZED'})
                latest=app.root/'state'/'worker-status.json'
                value['job']=app.current_job()
                prepared=app.root/'state'/'prepared-package.json'
                if prepared.exists():value['publication_package']=json.loads(prepared.read_text())['validation']
                integration=app.root/'state'/'development-result.json'
                if integration.exists():value['artvenn_integration']=json.loads(integration.read_text())
                return self.send(200,value)
            if parsed.path=='/selection':
                from worker import selection
                registry=app.registry()
                try:
                    material=urllib.parse.parse_qs(parsed.query).get('material',['current'])[0]
                    allowed=set(selected_objects(registry,app.selected,material))
                    value=selection(registry)
                    value['objects']=[o for o in value['objects'] if o['id'] in allowed]
                    from daily import missing_reviews
                    for obj in value['objects']:obj['missing']=missing_reviews(registry.db,obj['id'])
                    return self.send(200,value)
                finally:registry.db.close()
            if parsed.path.startswith('/preview/'):
                from review_scope import COOKIE,parse_focus,synthetic_preview
                try:focus=parse_focus(cookies[COOKIE].value if cookies.get(COOKIE) else None)
                except CurationError:return self.send(403,{'category':'FOCUSED_REVIEW_SCOPE_INVALID'})
                if focus and focus['synthetic'] and not synthetic_preview(app.root,parsed.path,{}):return self.send(403,{'category':'SYNTHETIC_PROVENANCE_REQUIRED'})
                name=parsed.path.removeprefix('/preview/')
                if not name.startswith('photos/') or name.count('/') != 1 or '..' in name or not name.endswith('.jpg'): return self.send(404,{})
                from preview_guard import preview_path
                try:file=preview_path(app.root/'served-previews',name)
                except (ValueError,OSError):return self.send(403,{})
                self.send_response(200);self.send_header('Content-Type','image/jpeg');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(file.read_bytes());return
            if parsed.path=='/review':
                query=urllib.parse.parse_qs(parsed.query)
                if 'task' not in query:
                    self.send_response(302);self.send_header('Location','/objects');self.end_headers();return
                try:task_id=int(query['task'][0])
                except (ValueError,TypeError):return self.send(404,{})
                registry=app.registry()
                try:stored=registry.db.execute('SELECT project,task_id FROM tasks WHERE task_id=?',(task_id,)).fetchone()
                finally:registry.db.close()
                if stored is None:return self.send(404,{})
                from review_scope import COOKIE,certified_task
                synthetic=query.get('synthetic')==['1']
                if synthetic:
                    registry=app.registry()
                    try:
                        if not certified_task(registry,task_id):return self.send(403,{'category':'SYNTHETIC_PROVENANCE_REQUIRED'})
                    finally:registry.db.close()
                focus=f"{stored['project']}:{stored['task_id']}:{'s' if synthetic else 'l'}"
                target=f"/projects/{stored['project']}/data/?task={stored['task_id']}"
                # Exchange protected local credentials server-side; only HttpOnly session goes to browser.
                jar=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
                base=f"http://127.0.0.1:{app.config['ls_port']}"
                client.open(base+'/user/login/',timeout=15).read()
                csrf=next(c.value for c in jar if c.name=='csrftoken')
                body=urllib.parse.urlencode({'email':app.config['username'],'password':app.config['password'],'csrfmiddlewaretoken':csrf,'next':'/'}).encode()
                client.open(urllib.request.Request(base+'/user/login/',data=body,headers={'Referer':base+'/user/login/'}),timeout=15).read()
                self.send_response(302)
                for cookie in jar:
                    self.send_header('Set-Cookie',f"{cookie.name}={cookie.value}; Path=/; SameSite=Strict"+('; HttpOnly' if cookie.name=='sessionid' else ''))
                self.send_header('Set-Cookie',f'{COOKIE}={focus}; Path=/; HttpOnly; SameSite=Strict');self.send_header('Location',base+target);self.end_headers();return
            return self.send(404,{})
        def do_POST(self):
            if not self.valid() or self.path!='/action': return self.send(403,{})
            cookies=http.cookies.SimpleCookie(self.headers.get('Cookie',''))
            if cookies.get('curation_session') is None or cookies['curation_session'].value!=app.config['ui_session'] or self.headers.get('X-CSRF-Token')!=app.csrf or self.headers.get('Origin')!=f"http://127.0.0.1:{app.config['ui_port']}": return self.send(403,{'category':'LOCAL_SESSION_OR_CSRF_REQUIRED'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=100000: raise CurationError('REQUEST_BOUND_EXCEEDED')
                value=json.loads(self.rfile.read(length))
                with app.lock: result=app.action(value)
                self.send(200,result)
            except Exception as exc:self.send(400,{'status':'failed','category':str(exc) if isinstance(exc,CurationError) else type(exc).__name__})
    ThreadingHTTPServer(('127.0.0.1',app.config['ui_port']),Handler).serve_forever()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);run(parser.parse_args().root)
