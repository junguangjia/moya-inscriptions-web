"""Private, bounded daily-work projections over the existing curation state."""
import json
import os
import sqlite3
from pathlib import Path
from registry import CurationError, safe_source, stable_id
from presentation import object_directory, FIELD_LABELS

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.dng', '.cr2', '.nef', '.arw'}


def folder_path(value):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise CurationError('EXPLICIT_BATCH_DIRECTORY_REQUIRED')
    path = Path(value).absolute()
    if path in {Path('/'), Path.home(), Path('/Volumes'), Path('/Users')} or not path.is_dir():
        raise CurationError('EXPLICIT_BATCH_DIRECTORY_REQUIRED')
    safe_source(path, path)
    return path


def folder_count(source, limit):
    source = folder_path(str(source))
    count = 0
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not Path(directory, d).is_symlink())
        for name in sorted(files):
            path = Path(directory, name)
            if name.startswith('.') or path.suffix.lower() not in EXTENSIONS:
                continue
            safe_source(source, path)
            count += 1
            if count > limit:
                return {'count': count, 'overLimit': True}
    return {'count': count, 'overLimit': False}


def material_scope(registry, selected, material='current'):
    if material not in {'current', 'local', 'synthetic'}:
        raise CurationError('MATERIAL_FILTER_INVALID')
    effective = ('synthetic' if selected and selected['synthetic'] else 'local') if material == 'current' else material
    same = bool(selected and selected['synthetic'] == (effective == 'synthetic'))
    source = selected['source'] if same else str(registry.root / 'synthetic') if effective == 'synthetic' else None
    cards = object_directory(registry.db, effective)['objects']
    batch = None
    if source:
        selection_file=registry.root/'state/selection.json'
        if same and selection_file.exists():
            saved=json.loads(selection_file.read_text())
            if saved.get('source')==source and saved.get('synthetic')==selected['synthetic']:selected=saved
        newly_selected=same and selected.get('generation') and not selected.get('batch_id')
        if same and selected.get('batch_id'):
            batch=registry.db.execute('SELECT * FROM batches WHERE id=? AND session_id=?',(selected['batch_id'],stable_id('session',str(Path(source).absolute())))).fetchone()
        if batch is None and not newly_selected:batch = registry.db.execute('SELECT * FROM batches WHERE session_id=? ORDER BY created DESC LIMIT 1',
                                    (stable_id('session', str(Path(source).absolute())),)).fetchone()
    if batch:
        ids = {r['id'] for r in registry.db.execute('SELECT id FROM objects WHERE batch_id=?', (batch['id'],))}
        cards = [c for c in cards if c['id'] in ids]
    elif source:
        cards = []
    return effective, same, source, batch, cards


def missing_reviews(db, object_id):
    missing = []
    for row in db.execute("""SELECT p.id,p.kind,p.field FROM proposals p WHERE p.subject=?
        AND p.kind IN ('group','field') AND p.version=(SELECT max(q.version) FROM proposals q
        WHERE q.subject=p.subject AND q.kind=p.kind AND q.field IS p.field)""", (object_id,)):
        status = db.execute('SELECT status FROM decisions WHERE proposal_id=? ORDER BY created DESC LIMIT 1', (row['id'],)).fetchone()
        accepted = {'accepted', 'corrected'} if row['kind'] == 'group' else {'accepted', 'corrected', 'rejected', 'deferred'}
        if status and status['status'] in accepted:
            continue
        task = db.execute('SELECT task_id,mapping FROM tasks WHERE kind=? ORDER BY task_id DESC', (row['kind'],)).fetchall()
        tid = next((t['task_id'] for t in task if row['id'] in json.loads(t['mapping'])['proposal_ids']), None)
        label = '照片分组' if row['kind'] == 'group' else FIELD_LABELS.get(row['field'], row['field'])
        missing.append({'label': label, 'status': 'deferred' if status and status['status'] == 'deferred' else 'pending',
                        'url': '/review?task=' + str(tid) if tid else None})
    # Reassigned/split media must retain a current accepted originating review.
    for origin in db.execute("""SELECT p.id,p.subject,p.kind,p.field,p.version,d.status FROM object_assets a
        LEFT JOIN decisions d ON d.id=a.decision_id LEFT JOIN proposals p ON p.id=d.proposal_id WHERE a.object_id=?""",(object_id,)):
        latest=db.execute('SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?',
                          (origin['subject'],origin['kind'],origin['field'])).fetchone()[0] if origin['id'] else None
        if origin['status'] in {'accepted','corrected'} and origin['version']==latest:continue
        current=db.execute('SELECT id FROM proposals WHERE subject=? AND kind=? AND field IS ? ORDER BY version DESC LIMIT 1',
                           (origin['subject'],origin['kind'],origin['field'])).fetchone() if origin['id'] else None
        tid=None
        if current:
            for task in db.execute('SELECT task_id,mapping FROM tasks ORDER BY task_id DESC'):
                if current['id'] in json.loads(task['mapping'])['proposal_ids']:tid=task['task_id'];break
        item={'label':'照片来源分组 · 需要当前审核','status':'pending','url':'/review?task='+str(tid) if tid else None}
        if item not in missing:missing.append(item)
    return missing


def submitted_tasks(root, task_ids):
    if not task_ids:
        return set()
    path = Path(root) / 'label-studio/label_studio.sqlite3'
    if not path.exists():
        return None
    try:
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            db.execute('PRAGMA query_only=ON')
            placeholders = ','.join('?' for _ in task_ids)
            return {r[0] for r in db.execute('SELECT DISTINCT task_id FROM task_completion WHERE was_cancelled=0 AND task_id IN (' + placeholders + ')', task_ids)}
        finally:
            db.close()
    except sqlite3.Error:
        return None


def admin_drafts(root, object_ids):
    """Expose only verified, non-authorizing Admin edit links for these objects."""
    from urllib.parse import urlsplit
    path = Path(root) / 'state/development-result.json'
    if not path.exists():return []
    receipt=json.loads(path.read_text())
    result=[]
    for row in receipt.get('drafts',[]):
        mapping=row.get('cmsDraft',{})
        if row.get('status')!='verified' or row.get('objectId') not in object_ids:continue
        origin=urlsplit(mapping.get('baseURL',''))
        if (origin.scheme!='http' or origin.hostname not in {'127.0.0.1','localhost','::1'}
                or not origin.port or origin.username or origin.password or origin.query or origin.fragment
                or origin.path not in {'','/'} or type(mapping.get('id')) is not int or mapping['id']<1):continue
        result.append({'objectId':row['objectId'],'id':mapping['id'],'revision':mapping['expectedRevision'],
                       'url':origin.scheme+'://'+origin.netloc+'/admin/collections/catalogs/'+str(mapping['id'])})
    return result


def overview(registry, selected, job, running, material='current'):
    effective, same, source, batch, cards = material_scope(registry, selected, material)
    task_ids = sorted({t['id'] for c in cards for t in c['tasks']})
    submitted = submitted_tasks(registry.root, task_ids)
    collected = {t['id'] for c in cards for t in c['tasks'] if t['collected']}
    pending_collect = set() if submitted is None else submitted - collected
    totals = {'files': 0, 'ready': 0, 'failed': 0}
    failures = []
    if batch:
        for row in registry.db.execute('SELECT a.status,a.error,count(*) AS n FROM assets a JOIN batch_assets b ON b.asset_id=a.id WHERE b.batch_id=? GROUP BY a.status,a.error', (batch['id'],)):
            totals['files'] += row['n']
            totals['ready' if row['status'] == 'ready' else 'failed'] += row['n']
            if row['error']:
                failures.append({'category': row['error'], 'count': row['n']})
    phase = 'unselected' if not source else 'selected'
    if batch:
        phase = batch['status']
    if same and running:
        phase = job.get('status') if job.get('status') in {'inspecting', 'inferencing'} else 'running'
    elif same and job.get('status') in {'failed', 'cancelled_checkpoint_retained'}:
        phase = job['status']
    projected = []
    for card in cards:
        missing = missing_reviews(registry.db, card['id'])
        projected.append({'id': card['id'], 'code': card['code'], 'name': card['name'], 'photos': len(card['assets']),
                          'missing': missing, 'ready': not missing and bool(card['assets']),
                          'url': '/objects?material=' + effective + '&focus=' + card['id']})
    package = registry.root / 'state/prepared-package.json'
    prepared = None
    if package.exists():
        saved = json.loads(package.read_text())
        if bool(saved['synthetic']) == (effective == 'synthetic'):
            data = json.loads(Path(saved['path']).read_text())
            ids = {c['id'] for c in cards}
            if {o['objectId'] for o in data['objects']} <= ids:
                prepared = {'objects': len(data['objects']), 'media': sum(len(o['media']) for o in data['objects']), 'synthetic': saved['synthetic']}
    integration_path=registry.root/'state/development-result.json'
    integration={'status':'not_connected','label':'尚未连接 Development','succeeded':0,'failed':0}
    if integration_path.exists():
        receipt=json.loads(integration_path.read_text())
        status=receipt.get('developmentIntegration')
        if receipt.get('synthetic',True)==(effective=='synthetic'):
            integration={'status':'verified' if status=='PASS' and not receipt.get('failed',0) else 'partial' if status=='PARTIAL' else 'failed',
                         'label':'Admin Draft 已保存并回读' if status=='PASS' and not receipt.get('failed',0) else 'Admin Draft 部分未完成' if status=='PARTIAL' else 'Admin Draft 尚未验证成功',
                         'succeeded':receipt.get('succeeded',0),'failed':receipt.get('failed',0)}
    drafts=admin_drafts(registry.root,{c['id'] for c in cards})
    integration['drafts']=drafts
    from guided_review import active
    active_review=active(registry,effective,[c['id'] for c in cards])
    return {'activeReview':active_review,'material': effective, 'viewOnly': not same, 'selection': {'present': bool(source),
            'name': 'Synthetic 合成测试资料' if effective == 'synthetic' else Path(source).name if source else '',
            'available': bool(source and Path(source).is_dir()), 'synthetic': effective == 'synthetic',
            'count': selected.get('count') if same else None, 'overLimit': selected.get('overLimit', False) if same else False},
            'phase': phase, 'running': running, 'totals': totals, 'failures': failures,
            'error': job.get('category') if same and phase == 'failed' else batch['error'] if batch else None,
            'review': {'tasks': len(task_ids), 'submitted': len(submitted) if submitted is not None else None,
                       'collected': len(collected), 'waitingCollection': len(pending_collect)},
            'objects': projected, 'draftReady': sum(c['ready'] for c in projected), 'prepared': prepared,
            'integration': integration,
            'realDraftAuthorized':(registry.root/'state/real-draft-authorization.json').is_file(),
            'production': '本轮未授权、未执行'}


def selected_objects(registry, selected, material, requested=None):
    _, _, _, _, cards = material_scope(registry, selected, material)
    allowed = {c['id'] for c in cards}
    if requested is not None:
        if not isinstance(requested, list) or not requested or any(not isinstance(x, str) for x in requested) or not set(requested) <= allowed:
            raise CurationError('OBJECT_SCOPE_INVALID')
        return list(dict.fromkeys(requested))
    return sorted(allowed)
