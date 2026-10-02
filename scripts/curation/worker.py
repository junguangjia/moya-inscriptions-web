"""Bounded batch/preannotation, immutable review sync and publication selection."""
import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from registry import Registry, CurationError, canonical, digest, file_hash, private_json, stable_id
from service import CODE, settings
from ls_client import LabelStudioClient, make_mapping, build_group_task, build_field_task, build_relationship_task, validate_annotation, fingerprint


def ls(config):
    return LabelStudioClient(f"http://127.0.0.1:{config['ls_port']}",config['api_token'],deadline=time.monotonic()+180)


def state(registry,status,**values):
    selected=json.loads((registry.root/'state/selection.json').read_text())
    private_json(registry.root/'state'/'worker-status.json',{'status':status,'selection_key':digest({'source':selected['source'],'synthetic':selected['synthetic']}),**values})


def review_tasks(registry,config,batch,proposal_ids=None):
    client=ls(config);projects=client.ensure_projects()
    all_assets={a['id']:a for a in registry.rows("SELECT * FROM assets WHERE status='ready'")}
    objects=registry.rows("SELECT object_id,number FROM object_presentation ORDER BY number")
    targets={f"对象 {obj['number']}":obj['object_id'] for obj in objects}
    for project in projects.values():
        storages=client.request('GET',f'/api/storages/localfiles/?project={project}')
        rows=storages if isinstance(storages,list) else storages.get('results',[])
        preview_root=str(registry.root/'served-previews/photos')
        (registry.root/'served-previews/photos').mkdir(exist_ok=True,mode=0o700)
        if not any(row.get('path')==preview_root for row in rows):
            client.request('POST','/api/storages/localfiles/',{'project':project,'path':preview_root,'use_blob_urls':True,'recursive_scan':False,'regex_filter':'.*\\.jpg$','title':'Dedicated generated previews only'})
    created=0
    for proposal in registry.rows("SELECT * FROM proposals WHERE batch_id=? AND kind IN ('group','field','relationship') ORDER BY kind,id",(batch,)):
        if proposal_ids is not None and proposal['id'] not in proposal_ids:continue
        ids=json.loads(proposal['value']) if proposal['kind']=='group' else json.loads(proposal['evidence'])
        kind=proposal['kind']
        if kind=='relationship':
            # New tasks freeze one latest block per object, in explicit left/right order.
            groups=[]
            for oid in (proposal['subject'],proposal['field']):
                group=registry.db.execute("SELECT subject,value FROM proposals WHERE kind='group' AND subject=? ORDER BY version DESC,created DESC LIMIT 1",(oid,)).fetchone()
                if group:groups.append(dict(group))
            ids=list(dict.fromkeys(aid for group in groups for aid in json.loads(group['value'])))
        # Groups are bounded model windows. Never silently drop image pages.
        key=stable_id('review',proposal['id'],proposal['version'])
        if registry.db.execute("SELECT 1 FROM tasks WHERE task_key=?",(key,)).fetchone(): continue
        latest=registry.db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?",(proposal['subject'],proposal['kind'],proposal['field'])).fetchone()[0]
        if proposal['version'] != latest: continue
        mapping=make_mapping(kind=kind,task_key=key,task_version=proposal['version'],subject_id=proposal['subject'],proposal_ids=[proposal['id']],asset_order=ids,input_hash=proposal['input_hash'],model_version=f"{proposal['model_revision']}:{proposal['prompt_version']}")
        urls=['/data/local-files/?d='+all_assets[aid]['preview'] for aid in ids]
        synthetic=registry.db.execute("SELECT s.synthetic FROM sessions s JOIN batches b ON b.session_id=s.id WHERE b.id=?",(batch,)).fetchone()[0]
        context=('SYNTHETIC FIXTURE / 合成测试。' if synthetic else '本机选定资料。')+'AI 建议；人审不等于上传或公开授权。'
        if proposal['model_revision']=='human-entry/v1':
            context=('SYNTHETIC FIXTURE / 合成测试。' if synthetic else '本机选定资料。')+'人工整理与资料补充；关联照片用作上下文，内容不是新增 AI 推断。人工审核不等于上传或公开授权。'
        if kind=='group':
            role_rows=registry.rows("SELECT field,value FROM proposals WHERE subject=? AND kind='role'",(proposal['subject'],))
            roles={row['field']:json.loads(row['value']) for row in role_rows}
            task=build_group_task(mapping,urls,[roles.get(aid,'unspecified') for aid in ids],context=context,reassign_targets={label:obj for label,obj in targets.items() if obj!=proposal['subject']})
        elif kind=='field':task=build_field_task(mapping,urls,json.loads(proposal['value']),proposal['field'],context=context)
        else:
            counts=[len(json.loads(group['value'])) for group in groups]
            task=build_relationship_task(mapping,urls,json.loads(proposal['value']),context=context+f" 比较候选对象；图像按对象分块排列，各块张数 {counts}。身份关系与照片分组分开审核。")
        # Persist exact pre-import intent. Reconcile crash via task_key, never reordering.
        private_json(registry.root/'state'/f'{key}-task.json',task)
        result=client.import_task(projects[kind],task)
        with registry.db:
            registry.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?)",(key,result['id'],projects[kind],kind,canonical(mapping),fingerprint(task['data'])))
        created+=1
    return created


def recover_completed(registry,batch):
    for file in (registry.root/'state').glob(f'{batch}-*-model.json'):
        output=json.loads(file.read_text())
        for segment in output.get('segments',[]):
            if segment.get('status')=='completed':
                registry.ingest_model(batch,segment['segment_id'],segment['proposal'],output['revision'],output['prompt_version'])
                checkpoint=registry.root/'state'/f"{batch}-{segment['segment_id']}-success.json"
                if not checkpoint.exists():private_json(checkpoint,segment)


def renew_review(registry,config,object_ids=None):
    rows=registry.rows("SELECT * FROM proposals WHERE kind IN ('group','field','relationship')")
    if object_ids is not None:
        selected=set(object_ids)
        rows=[r for r in rows if r['subject'] in selected and (r['kind']!='relationship' or r['field'] in selected)]
    batches=set()
    with registry.db:
        for proposal in rows:
            latest=registry.db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?",(proposal['subject'],proposal['kind'],proposal['field'])).fetchone()[0]
            if proposal['version']!=latest:continue
            values=list(proposal.values());values[0]=stable_id('proposal',proposal['id'],'review-version',latest+1);values[-2]=time.time();values[-1]=latest+1
            registry.db.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",values)
            batches.add(proposal['batch_id'])
    created=sum(review_tasks(registry,config,batch) for batch in batches)
    return {'status':'new_review_version_ready','new_tasks':created,'previous_decisions':'preserved'}


def analyze(registry,config,limit=50):
    selected=json.loads((registry.root/'state'/'selection.json').read_text())
    from synthetic_fixture import certified
    selected['synthetic']=bool(selected['synthetic'] and certified(Path(selected['source'])))
    private_json(registry.root/'state/selection.json',selected)
    state(registry,'inspecting',synthetic=selected['synthetic'])
    batch=registry.inspect(selected['source'],limit,selected['synthetic'])
    selected['batch_id']=batch
    private_json(registry.root/'state/selection.json',selected)
    registry.source_verify(batch)
    recover_completed(registry,batch)
    assets=registry.rows("SELECT * FROM assets WHERE id IN (SELECT asset_id FROM batch_assets WHERE batch_id=?) AND status='ready' ORDER BY capture,relative_path",(batch,))
    if not assets: raise CurationError('NO_DECODABLE_ASSETS')
    segments=[];covered=set();last_segment=0;ready_ids={a['id'] for a in assets}
    # Completed windows freeze membership. A newly decoded photo must not shift
    # those windows or disappear behind an old numeric checkpoint.
    for checkpoint in (registry.root/'state').glob(f'{batch}-segment-*-success.json'):
        completed=json.loads(checkpoint.read_text())
        try:
            ordinal=int(completed['segment_id'].removeprefix('segment-'))
            members={r['asset_id'] for r in completed['proposal']['roles']}
        except (KeyError,TypeError,ValueError):raise CurationError('MODEL_CHECKPOINT_MEMBERSHIP_INVALID') from None
        if ordinal<1 or not members or not members<=ready_ids or covered&members:raise CurationError('MODEL_CHECKPOINT_MEMBERSHIP_CONFLICT')
        covered.update(members);last_segment=max(last_segment,ordinal)
    pending=[a for a in assets if a['id'] not in covered]
    # New windows remain local to this selected capture context, at most eight.
    for i in range(0,len(pending),8):
        segment_id=f'segment-{last_segment+i//8+1}'
        segments.append({'segment_id':segment_id,'batch':[{'asset_id':a['id'],'preview_path':str(registry.root/'served-previews'/a['preview'])} for a in pending[i:i+8]]})
    if segments:
        state(registry,'inferencing',assets=len(assets),segments=len(segments),synthetic=selected['synthetic'])
        run=uuid.uuid4().hex
        input_file=registry.root/'state'/f'{batch}-{run}-input.json'
        output_file=registry.root/'state'/f'{batch}-{run}-model.json'
        private_json(input_file,{'model_path':config['model_path'],'revision':config['model_revision'],'segments':segments,'max_tokens':4096,'segment_timeout_seconds':180})
        environment={k:v for k,v in os.environ.items() if not k.startswith(('HF_','HUGGING_FACE_','OPENAI_','ANTHROPIC_'))}
        environment.update({'HF_HOME':str(registry.root/'models/cache'),'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1','HF_HUB_DISABLE_IMPLICIT_TOKEN':'1'})
        process=subprocess.Popen([str(registry.root/'mlx-env/bin/python'),str(CODE/'model_runner.py'),'--input',str(input_file),'--output',str(output_file)],env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def cancel(*_):
            if process.poll() is None:process.terminate()
            process.wait(timeout=10)
            recover_completed(registry,batch)
            state(registry,'cancelled_checkpoint_retained')
            raise CurationError('CANCELLED')
        previous=signal.signal(signal.SIGTERM,cancel)
        try:process.wait(timeout=60+190*len(segments))
        except subprocess.TimeoutExpired:
            process.kill();process.wait();recover_completed(registry,batch);state(registry,'failed',category='MODEL_TIMEOUT');raise CurationError('MODEL_TIMEOUT')
        finally:signal.signal(signal.SIGTERM,previous)
        if not output_file.exists():raise CurationError('MODEL_PROCESS_FAILED')
        output=json.loads(output_file.read_text())
        failures=[]
        if process.returncode != 0 or output.get('status') != 'completed': failures.append('MODEL_PROCESS_INCOMPLETE')
        if output.get('status') == 'failed' and not output.get('segments'):
            raise CurationError(output.get('error_category','MODEL_PROCESS_FAILED'))
        expected={s['segment_id'] for s in segments}
        actual={s['segment_id'] for s in output.get('segments',[])}
        if actual != expected: failures.append('MODEL_SEGMENT_CHECKPOINT_INCOMPLETE')
        if output.get('revision') != config['model_revision']: raise CurationError('MODEL_REVISION_MISMATCH')
        for segment in output.get('segments',[]):
            if segment['status']!='completed':
                failures.append(segment.get('error_category','MODEL_FAILED'));continue
            registry.ingest_model(batch,segment['segment_id'],segment['proposal'],output['revision'],output['prompt_version'])
            private_json(registry.root/'state'/f"{batch}-{segment['segment_id']}-success.json",segment)
        if failures:
            with registry.db:registry.db.execute("UPDATE batches SET status='model_failed',error=? WHERE id=?",(','.join(failures),batch))
            state(registry,'failed',category=failures[0],successful_segments=sum(s['status']=='completed' for s in output.get('segments',[])))
            raise CurationError(failures[0])
    created=review_tasks(registry,config,batch)
    registry.source_verify(batch)
    with registry.db:registry.db.execute("UPDATE batches SET status='review_ready',error=NULL WHERE id=?",(batch,))
    registry.export();state(registry,'review_ready',assets=len(assets),new_tasks=created,synthetic=selected['synthetic'])
    return {'status':'review_ready','assets':len(assets),'new_tasks':created}


def collect(registry,config,object_ids=None,task_keys=None,expected_annotations=None):
    client=ls(config);count=0;failures=[]
    for stored in registry.rows("SELECT * FROM tasks"):
        if task_keys is not None and stored['task_key'] not in task_keys:continue
        if object_ids is not None:
            mapping=json.loads(stored['mapping'])
            if mapping['subject_id'] not in object_ids:continue
            if stored['kind']=='relationship':
                relation=registry.db.execute('SELECT field FROM proposals WHERE id=?',(mapping['proposal_ids'][0],)).fetchone()
                if not relation or relation['field'] not in object_ids:continue
        try:
            task=client.read_task(stored['task_id']);mapping=json.loads(stored['mapping'])
            if fingerprint(task['data'])!=stored['version_hash']:raise CurationError('STALE_TASK_CONTENT')
            if expected_annotations is not None:
                expected=expected_annotations.get(stored['task_key'])
                submitted=[a for a in task.get('annotations',[]) if not a.get('was_cancelled')]
                if not expected or len(submitted)!=1 or submitted[0]['id']!=expected['id'] or digest({k:v for k,v in submitted[0].items() if k!='created_ago'})!=expected['hash']:
                    raise CurationError('CONFIRMED_NATIVE_ANNOTATION_CHANGED')
            for annotation in task.get('annotations',[]):
                if annotation.get('was_cancelled'):continue
                normalized=validate_annotation(stored['kind'],task,annotation,mapping)
                # Known LS user identity is preserved; test annotations are explicitly marked.
                reviewer=f"label-studio-user:{normalized['completed_by']}"
                is_synthetic=registry.db.execute("SELECT s.synthetic FROM proposals p JOIN batches b ON b.id=p.batch_id JOIN sessions s ON s.id=b.session_id WHERE p.id=?",(mapping['proposal_ids'][0],)).fetchone()[0]
                if is_synthetic:reviewer='test-reviewer:'+reviewer
                pid=mapping['proposal_ids'][0]
                if stored['kind']=='group':
                    items=[{'asset_id':a['asset_id'],'membership':'keep' if a['membership']=='belongs' else a['membership'],'role':a['role'],'target':a['target_object_id'],'split_label':a['split_label']} for a in normalized['assets']]
                    decision='deferred' if all(a['membership']=='unresolved' for a in items) else 'corrected' if any(a['membership']!='keep' for a in items) else 'accepted'
                    value=items
                else:decision=normalized['decision'];value=normalized['value']
                # Snapshot annotation immediately; Community intermediate edits are not claimed.
                snapshot_hash=digest({k:v for k,v in annotation.items() if k!='created_ago'})
                snapshot=registry.root/'state'/f"{stored['task_key']}-{annotation['id']}-{snapshot_hash}-annotation.json"
                if not snapshot.exists():private_json(snapshot,{'annotation':annotation,'normalized':normalized})
                if registry.decision(stored,annotation,pid,decision,value,reviewer):count+=1
        except Exception as exc:
            failures.append(str(exc) if isinstance(exc,(CurationError,ValueError)) else 'REVIEW_COLLECTION_FAILED')
    registry.export()
    return {'status':'collected' if not failures else 'partial','new_decisions':count,'failures':failures}


def selection(registry):
    from presentation import card
    result=[]
    for obj in registry.rows("SELECT DISTINCT o.* FROM objects o JOIN object_assets a ON a.object_id=o.id"):
        identity=card(registry.db,obj['id'])
        fields={f['field']:json.loads(f['value']) for f in registry.rows("SELECT * FROM facts WHERE object_id=?",(obj['id'],))}
        assets=registry.rows("SELECT a.*,l.role FROM assets a JOIN object_assets l ON l.asset_id=a.id WHERE l.object_id=?",(obj['id'],))
        result.append({'id':obj['id'],'code':identity['code'],'name':identity['name'],'title':fields.get('title',''),'assets':[{'id':a['id'],'role':a['role'],'url':'/preview/'+a['preview'],'position':i} for i,a in enumerate(assets)]})
    return {'objects':result}


def synthetic_package_verified(registry,package):
    from synthetic_fixture import certified, CERTIFIED_HASHES
    if not package.get('objects'):return False
    checked=set()
    for obj in package['objects']:
        row=registry.db.execute('SELECT batch_id FROM objects WHERE id=?',(obj.get('objectId'),)).fetchone()
        if not row:return False
        batches={row['batch_id']}
        for media in obj.get('media',[]):
            asset=registry.db.execute('SELECT batch_id FROM assets WHERE id=?',(media.get('assetId'),)).fetchone()
            if not asset:return False
            batches.add(asset['batch_id'])
        from identity import asset_synthetic
        if any(not asset_synthetic(registry,m['assetId']) for m in obj.get('media',[])):return False
        for batch in batches-checked:
            origin=registry.db.execute('SELECT s.source_root,s.synthetic FROM sessions s JOIN batches b ON b.session_id=s.id WHERE b.id=?',(batch,)).fetchone()
            if not origin or not origin['synthetic'] or not certified(Path(origin['source_root'])):return False
            assets=registry.rows('SELECT a.relative_path,a.sha256 FROM assets a JOIN batch_assets b ON b.asset_id=a.id WHERE b.batch_id=?',(batch,))
            if not assets or any(CERTIFIED_HASHES.get(a['relative_path'])!=a['sha256'] for a in assets):return False
            checked.add(batch)
    return True


def prepare(registry,choices):
    if not choices:raise CurationError('EXPLICIT_PUBLIC_SELECTION_REQUIRED')
    objects=[];synthetic_only=True
    for choice in choices:
        obj=registry.db.execute("SELECT o.*,s.synthetic FROM objects o JOIN batches b ON b.id=o.batch_id JOIN sessions s ON s.id=b.session_id WHERE o.id=?",(choice['objectId'],)).fetchone()
        if not obj:raise CurationError('OBJECT_UNKNOWN')
        synthetic_only &= bool(obj['synthetic'])
        if choice.get('kind') not in {'inscription','calligraphy'}:raise CurationError('UNSUPPORTED_CATALOG_KIND')
        if not choice.get('title','').strip():raise CurationError('PUBLIC_TITLE_REQUIRED')
        facts={r['field']:json.loads(r['value']) for r in registry.rows("SELECT * FROM facts WHERE object_id=?",(obj['id'],))}
        group=registry.db.execute("SELECT p.id,d.status FROM proposals p LEFT JOIN decisions d ON d.proposal_id=p.id WHERE p.subject=? AND p.kind='group' ORDER BY p.version DESC LIMIT 1",(obj['id'],)).fetchone()
        if group and group['status'] not in {'accepted','corrected'}:raise CurationError('GROUP_REVIEW_REQUIRED')
        # Every candidate factual field needs an explicit human disposition.
        missing=registry.rows("SELECT p.id FROM proposals p WHERE p.subject=? AND p.kind='field' AND p.version=(SELECT max(p2.version) FROM proposals p2 WHERE p2.subject=p.subject AND p2.kind=p.kind AND p2.field=p.field) AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.proposal_id=p.id AND d.status IN ('accepted','corrected','rejected','deferred'))",(obj['id'],))
        if missing:raise CurationError('KEY_FACT_REVIEW_REQUIRED')
        media=[];preview_lineage={};photo_roles={};media_decisions=set();source_lineage={}
        for item in choice.get('media',[]):
            asset=registry.db.execute("SELECT a.*,l.role FROM assets a JOIN object_assets l ON l.asset_id=a.id WHERE a.id=? AND l.object_id=?",(item['assetId'],obj['id'])).fetchone()
            if not asset:raise CurationError('UNREVIEWED_MEDIA_REFUSED')
            origin=registry.db.execute("SELECT p.subject,p.kind,p.field,p.version,d.status,d.id AS decision_id FROM object_assets a JOIN decisions d ON d.id=a.decision_id JOIN proposals p ON p.id=d.proposal_id WHERE a.asset_id=? AND a.object_id=?",(asset['id'],obj['id'])).fetchone()
            if not origin or origin['status'] not in {'accepted','corrected'}:raise CurationError('CURRENT_MEDIA_REVIEW_REQUIRED')
            version=registry.db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?",(origin['subject'],origin['kind'],origin['field'])).fetchone()[0]
            if origin['version']!=version:raise CurationError('CURRENT_MEDIA_REVIEW_REQUIRED')
            photo_roles[asset['id']]={'role':asset['role'],'decisionId':origin['decision_id'],'originObjectId':origin['subject']}
            media_decisions.add(origin['decision_id'])
            from identity import original_source, asset_synthetic
            from publication_derivatives import render
            source=original_source(registry,asset['id'])
            derivative=render(registry.root,source['path'],asset['sha256'],asset['id'],source_root=source['source_root'])
            source_lineage[asset['id']]={**derivative.pop('lineage'),'occurrenceId':source['id']}
            synthetic_only &= asset_synthetic(registry,asset['id'])
            sha=derivative['uploadedSha256']
            preview_record=registry.root/'state'/f"{asset['id']}-preview.json"
            if preview_record.exists():preview_lineage[asset['id']]=json.loads(preview_record.read_text())
            media.append({**derivative,'mediaId':registry.bind('development',obj['id']+':'+asset['id']+':'+sha,'media'),'alt':choice['title'].strip(),'position':int(item['position']),'isRepresentative':bool(item['isRepresentative'])})
        if len({m['position'] for m in media})!=len(media) or (media and sum(m['isRepresentative'] for m in media)!=1):raise CurationError('PUBLIC_MEDIA_ORDER_OR_REPRESENTATIVE_INVALID')
        fields={}
        if facts.get('period_original'):fields['dateText']={'state':'VALUE','value':facts['period_original']}
        context=[]
        for key,label in [('persons','人物相关资料'),('object_form','对象形制')]:
            if facts.get(key):context.append(label+'：'+facts[key])
        if context:
            note='\n'.join(context)
            if len(note.encode('utf-16-le'))//2>2000:raise CurationError('REVIEWED_CONTEXT_TOO_LONG')
            fields['ownerNote']=note
        decisions=registry.rows("SELECT d.* FROM decisions d JOIN proposals p ON p.id=d.proposal_id WHERE p.subject=? ORDER BY d.created,d.id",(obj['id'],))
        known={d['id'] for d in decisions}
        for did in sorted(media_decisions-known):
            decisions.extend(registry.rows('SELECT * FROM decisions WHERE id=?',(did,)))
        snapshots=[str(registry.root/'state'/f"{d['task_key']}-{d['annotation_id']}-{d['annotation_hash']}-annotation.json") for d in decisions]
        provenance=registry.rows("SELECT p.id,p.field,p.model_revision,p.prompt_version,p.evidence,d.id AS decision_id FROM proposals p JOIN decisions d ON d.proposal_id=p.id WHERE p.subject=? AND p.kind='field' ORDER BY p.field,p.version",(obj['id'],))
        objects.append({'objectId':obj['id'],'catalogId':registry.bind('development',obj['id'],'catalog'),'sourceId':registry.bind('development',obj['id'],'source'),'kind':choice['kind'],'title':choice['title'].strip(),'fields':fields,'media':media,'localAnnotations':{'previewProcessingLineage':preview_lineage,'sourceProcessingLineage':source_lineage,'photoRoles':photo_roles,'fieldProvenance':provenance,'facts':facts,'unsupportedFields':[f for f in facts if f in {'persons','object_form'}],'reviewDecisions':decisions, 'annotationSnapshots':snapshots, 'relationships':registry.rows("SELECT p.*,r.value AS reviewed_value FROM proposals p LEFT JOIN relationships r ON r.proposal_id=p.id WHERE p.subject=? AND p.kind='relationship'",(obj['id'],))}})
    mapping_file=registry.root/'state'/'cms-draft-mappings.json'
    if mapping_file.exists():
        bindings=json.loads(mapping_file.read_text())
        for object_record in objects:
            if object_record['objectId'] in bindings:object_record['cmsDraft']=bindings[object_record['objectId']]
    package={'version':1,'instance':'development','selectionConfirmed':True,'synthetic':synthetic_only,'objects':objects}
    synthetic_only=bool(synthetic_only and synthetic_package_verified(registry,package))
    package['synthetic']=synthetic_only
    file=registry.root/'state'/f'publication-{digest(package)}.json';private_json(file,package)
    repo=CODE.parents[1]
    result=subprocess.run(['/opt/homebrew/bin/mise','exec','--','node',str(CODE/'adapter.mjs'),'validate',str(repo),str(file)],cwd=repo,capture_output=True,text=True,timeout=60)
    receipt=json.loads(result.stdout)
    if result.returncode:raise CurationError(receipt.get('category','OFFLINE_VALIDATION_FAILED'))
    private_json(registry.root/'state'/'prepared-package.json',{'path':str(file),'synthetic':synthetic_only,'validation':receipt})
    return {'status':'package_prepared','objects':len(objects),'media':sum(len(o['media']) for o in objects),'offline_validation':receipt,'unmapped_fields':[],'real_outbound':'EXPLICIT_BOUNDED_AUTHORIZATION_REQUIRED'}


PREVIEW_DERIVATIVE_VERSION='public-jpeg-v1'


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['analyze','collect']);parser.add_argument('--root',required=True);parser.add_argument('--limit',type=int,default=50);args=parser.parse_args()
    registry=Registry(args.root)
    claim=(registry.root/'state'/'analysis.lock').open('a')
    try:fcntl.flock(claim,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'status':'failed','category':'ANALYSIS_ALREADY_RUNNING'}));sys.exit(1)
    birth=subprocess.run(['/bin/ps','-p',str(os.getpid()),'-o','lstart=','-o','command='],capture_output=True,text=True,check=True).stdout.strip()
    private_json(registry.root/'state'/'analysis-process.json',{'pid':os.getpid(),'birth':birth,'pgid':os.getpgid(os.getpid()),'active':True})
    try:
        result=analyze(registry,settings(registry.root),args.limit) if args.action=='analyze' else collect(registry,settings(registry.root))
        print(json.dumps(result))
    except Exception as exc:
        category=str(exc) if isinstance(exc,(CurationError,ValueError)) else type(exc).__name__
        state(registry,'cancelled_checkpoint_retained' if category=='CANCELLED' else 'failed',category=category);print(json.dumps({'status':'failed','category':category}));sys.exit(1)
    finally:
        private_json(registry.root/'state'/'analysis-process.json',{'pid':os.getpid(),'birth':birth,'pgid':os.getpgid(os.getpid()),'active':False})
        fcntl.flock(claim,fcntl.LOCK_UN);claim.close()
