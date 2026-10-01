"""A native Review navigation fence; existing LS authentication stays authoritative."""
import json
import re
from urllib.parse import urlsplit,parse_qs
from registry import CurationError

COOKIE = 'artvenn_review_focus'

def parse_focus(value):
    if value is None:return None
    match=re.fullmatch(r'([1-9][0-9]{0,8}):([1-9][0-9]{0,8}):(s|l)',value)
    if not match:raise CurationError('FOCUSED_REVIEW_SCOPE_INVALID')
    return {'project':int(match[1]),'task':int(match[2]),'synthetic':match[3]=='s'}

def focused_list(query,scope):
    result=query.copy()
    result.pop('view',None)
    result['project']=str(scope['project'])
    result['query']=json.dumps({'selectedItems':{'all':False,'included':[scope['task']],'excluded':[]}})
    return result

def allow_request(path,query,method,scope,lookup):
    if path=='/curation/context':
        return query.get('task')==str(scope['task']) and query.get('project')==str(scope['project'])
    page=re.fullmatch(r'/projects/([0-9]+)/(?:data/)?',path)
    if page:return int(page[1])==scope['project'] and query.get('task')==str(scope['task'])
    if path.startswith('/projects/') or path=='/projects':return False
    if path.rstrip('/')=='/api/tasks':return method=='GET'
    task=re.fullmatch(r'/api/tasks/([0-9]+)(?:/(.*))?/?',path)
    if task:
        if int(task[1])!=scope['task']:return False
        annotation=re.search(r'^annotations/([0-9]+)/drafts/?$',task[2] or '')
        return not annotation or lookup('annotation',int(annotation[1]))==scope['task']
    record=re.fullmatch(r'/api/(annotations|drafts|predictions)/([0-9]+)(?:/.*)?/?',path)
    if record:return lookup({'annotations':'annotation','drafts':'draft','predictions':'prediction'}[record[1]],int(record[2]))==scope['task']
    if path.startswith(('/api/annotations','/api/drafts','/api/predictions','/api/dm/tasks','/api/dm/actions')):return False
    project=re.fullmatch(r'/api/projects/([0-9]+)(?:/(.*))?/?',path)
    if project:
        if int(project[1])!=scope['project']:return False
        action=(project[2] or '').strip('/')
        return method=='GET' and action in {'','summary'}
    if path.startswith('/api/projects'):return False
    if path.startswith('/api/dm/'):
        if query.get('project') not in {None,str(scope['project'])}:return False
        return method=='GET' and not any(word in path for word in ('export','sample','next','history'))
    return True

def certified_asset(registry,asset_id):
    from synthetic_fixture import certified,CERTIFIED_HASHES
    from pathlib import Path
    row=registry.db.execute('SELECT a.relative_path,a.sha256,s.source_root FROM assets a JOIN batches b ON b.id=a.batch_id JOIN sessions s ON s.id=b.session_id WHERE a.id=?',(asset_id,)).fetchone()
    return bool(row and CERTIFIED_HASHES.get(row['relative_path'])==row['sha256'] and certified(Path(row['source_root'])))

def certified_task(registry,task_id):
    row=registry.db.execute('SELECT mapping FROM tasks WHERE task_id=?',(task_id,)).fetchone()
    if row is None:return False
    ids=json.loads(row['mapping']).get('asset_order',[])
    return bool(ids and all(certified_asset(registry,x) for x in ids))

def synthetic_preview(root,path,query):
    from pathlib import Path
    from presentation import readonly
    name=query.get('d','') if path=='/data/local-files/' else path.removeprefix('/preview/')
    if not re.fullmatch(r'photos/[a-zA-Z0-9-]+\.jpg',name):return False
    class Reader:pass
    with readonly(root) as db:
        reader=Reader();reader.db=db
        rows=db.execute('SELECT id FROM assets WHERE preview=?',(name,)).fetchall()
        return bool(rows and all(certified_asset(reader,row['id']) for row in rows))
