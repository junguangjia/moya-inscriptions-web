"""Independent synthetic fault-injection regressions; no LS/network/model calls."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from registry import Registry, CurationError, private_json, digest, canonical
import worker


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='artvenn-rereview-')
        self.base = Path(self.tmp.name)
        self.registry = Registry(self.base/'runtime')
        self.source = self.make_source('source', 9)
        self.config = {'model_path':str(self.base/'unused-model'), 'model_revision':'synthetic-pin'}
        private_json(self.registry.root/'state/selection.json', {'source':str(self.source), 'synthetic':True})

    def tearDown(self):
        self.registry.db.close()
        self.tmp.cleanup()

    def make_source(self, name, count):
        from PIL import Image
        source = self.base/name
        source.mkdir()
        for i in range(count):
            Image.new('RGB', (60,40), (i*13 % 256,50,80)).save(source/f'{i}.png')
        return source

    def task(self, kind, key):
        with self.registry.db:
            n = len(self.registry.rows('SELECT * FROM tasks'))+1
            self.registry.db.execute('INSERT INTO tasks VALUES(?,?,1,?,?,?)',(key,n,kind,'{}','hash'))
        return {'task_key':key}

    def obj_proposal(self, batch, asset, key, kind='group', value=None):
        from registry import stable_id
        obj = stable_id('object',batch,key)
        with self.registry.db:
            self.registry.db.execute('INSERT OR IGNORE INTO objects VALUES(?,?,?)',(obj,batch,key))
            pid = self.registry.propose(batch,obj,kind,None if kind=='group' else 'title',value if value is not None else [asset], [asset], 'input','synthetic-pin','synthetic-prompt')
        return obj,pid

    @staticmethod
    def proposal(segment):
        ids = [x['asset_id'] for x in segment['batch']]
        return {'groups':[{'key':'g','asset_ids':ids,'fields':[]}],
                'roles':[{'asset_id':a,'role':'unspecified','evidence':[a]} for a in ids],
                'relationships':[], 'issues':[]}

    def fake_process(self, mode, observed):
        test = self
        class FakeProcess:
            def __init__(self, args, **kwargs):
                supplied=json.loads(Path(args[args.index('--input')+1]).read_text())
                observed.extend(s['segment_id'] for s in supplied['segments'])
                out=Path(args[args.index('--output')+1]); self.dead=False; self.calls=0
                segments=supplied['segments']
                if mode=='empty_failure':
                    output={'status':'failed','error_category':'SYNTHETIC_MODEL_FAILURE','segments':[]}
                    self.returncode=2
                else:
                    chosen=segments[:1] if mode in {'missing','timeout'} else segments
                    output={'status':'running' if mode in {'missing','timeout'} else 'completed',
                            'revision':'synthetic-pin','prompt_version':'synthetic-prompt',
                            'segments':[{'segment_id':s['segment_id'],'status':'completed','proposal':test.proposal(s)} for s in chosen]}
                    self.returncode=2 if mode=='missing' else None if mode=='timeout' else 0
                private_json(out,output)
            def wait(self, timeout=None):
                self.calls+=1
                if mode=='timeout' and self.calls==1:
                    raise subprocess.TimeoutExpired('synthetic-model-process',timeout)
                return self.returncode
            def kill(self):self.dead=True;self.returncode=-9
            def terminate(self):self.dead=True;self.returncode=-15
            def poll(self):return self.returncode
        return FakeProcess

    def run_analyze(self, mode, observed):
        with patch.object(worker.subprocess,'Popen',self.fake_process(mode,observed)), patch.object(worker,'review_tasks',return_value=0):
            return worker.analyze(self.registry,self.config)

    def test_model_empty_failure_is_failure(self):
        with self.assertRaisesRegex(CurationError,'SYNTHETIC_MODEL_FAILURE'):
            self.run_analyze('empty_failure',[])
        self.assertEqual(self.registry.rows("SELECT * FROM batches WHERE status='review_ready'"),[])

    def test_missing_segment_stays_failed_and_retains_completed(self):
        with self.assertRaises(CurationError):self.run_analyze('missing',[])
        self.assertEqual(len(list((self.registry.root/'state').glob('*-segment-1-success.json'))),1)
        self.assertEqual(json.loads((self.registry.root/'state/worker-status.json').read_text())['successful_segments'],1)
        self.assertEqual(self.registry.rows("SELECT * FROM batches WHERE status='review_ready'"),[])
        seen=[]
        self.assertEqual(self.run_analyze('completed',seen)['status'],'review_ready')
        self.assertEqual(seen,['segment-2'])

    def test_timeout_retains_completed_checkpoint_and_resume_only_unfinished(self):
        with self.assertRaisesRegex(CurationError,'MODEL_TIMEOUT'):self.run_analyze('timeout',[])
        self.assertEqual(len(list((self.registry.root/'state').glob('*-segment-1-success.json'))),1)
        seen=[]
        self.assertEqual(self.run_analyze('completed',seen)['status'],'review_ready')
        self.assertEqual(seen,['segment-2'])

    def test_recovered_raw_appends_window_without_skipping_or_rewriting_completed(self):
        import raw_decoder
        from PIL import Image
        raw=self.source/'recovered.arw';raw.write_bytes(b'SYNTHETIC_RAW_PLACEHOLDER')
        with patch.object(raw_decoder,'preview',side_effect=CurationError('RAW_DECODER_UNAVAILABLE')):
            self.run_analyze('completed',[])
        old_checkpoints={p.name:p.read_bytes() for p in (self.registry.root/'state').glob('*-success.json')}
        def ready(source,target,*_):Image.new('RGB',(60,40)).save(target,'JPEG');return {'version':raw_decoder.RAW_PREVIEW_VERSION}
        seen=[]
        with patch.object(raw_decoder,'preview',side_effect=ready):result=self.run_analyze('completed',seen)
        self.assertEqual(result['assets'],10);self.assertEqual(seen,['segment-3'])
        assets={a['id'] for a in self.registry.rows("SELECT * FROM assets WHERE status='ready'")}
        proposed={p['field'] for p in self.registry.rows("SELECT * FROM proposals WHERE kind='role'")}
        self.assertEqual(assets,proposed)
        for name,content in old_checkpoints.items():self.assertEqual((self.registry.root/'state'/name).read_bytes(),content)
        self.assertEqual(self.run_analyze('completed',[])['assets'],10)

    def test_legacy_created_ago_replay_uses_frozen_snapshot(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        aid=self.registry.rows('SELECT id FROM assets')[0]['id']
        obj,pid=self.obj_proposal(batch,aid,'g','field','old')
        task=self.task('field','legacy');old={'id':1,'result':['old'],'created_ago':'just now'}
        # Seed a pre-fix immutable row, with its exact raw snapshot, for compatibility.
        oldhash=digest(old)
        private_json(self.registry.root/'state'/f'legacy-1-{oldhash}-annotation.json',{'annotation':old})
        with self.registry.db:
            self.registry.db.execute('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)',('legacy-d',pid,'legacy',1,oldhash,'accepted',canonical('old'),'test-reviewer',0))
        self.assertFalse(self.registry.decision(task,{**old,'created_ago':'one minute ago'},pid,'accepted','old','test-reviewer'))
        self.assertEqual(self.registry.rows('SELECT annotation_hash FROM decisions')[0]['annotation_hash'],oldhash)
        with self.assertRaisesRegex(CurationError,'SYNCED_ANNOTATION_CHANGED'):
            self.registry.decision(task,{**old,'result':['edited']},pid,'corrected','edited','test-reviewer')

    def test_new_deferred_field_removes_prior_projection_keeps_decisions(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        aid=self.registry.rows('SELECT id FROM assets')[0]['id']
        obj,old=self.obj_proposal(batch,aid,'g','field','old')
        self.registry.decision(self.task('field','old'),{'id':1},old,'accepted','old','test-reviewer')
        obj,new=self.obj_proposal(batch,aid,'g','field','new')
        self.registry.decision(self.task('field','new'),{'id':2},new,'deferred',None,'test-reviewer')
        self.assertEqual(self.registry.rows('SELECT * FROM facts'),[])
        self.assertEqual(len(self.registry.rows('SELECT * FROM decisions')),2)

    def test_prepare_verifies_reassigned_asset_original_source(self):
        source_a=self.make_source('source-a',1);source_b=self.make_source('source-b',1)
        ba=self.registry.inspect(source_a,synthetic=True);bb=self.registry.inspect(source_b,synthetic=True)
        aa=self.registry.rows('SELECT id FROM assets WHERE batch_id=?',(ba,))[0]['id']
        ab=self.registry.rows('SELECT id FROM assets WHERE batch_id=?',(bb,))[0]['id']
        oa,pa=self.obj_proposal(ba,aa,'a');ob,pb=self.obj_proposal(bb,ab,'b')
        self.registry.decision(self.task('group','b'),{'id':2},pb,'accepted',[{'asset_id':ab,'membership':'keep','role':'overview'}],'test-reviewer')
        self.registry.decision(self.task('group','a'),{'id':1},pa,'corrected',[{'asset_id':aa,'membership':'reassign','role':'detail','target':ob}],'test-reviewer')
        (source_a/'0.png').write_bytes(b'mutated source bytes')
        choice={'objectId':ob,'kind':'inscription','title':'Synthetic title','media':[{'assetId':aa,'position':0,'isRepresentative':True}]}
        # Stub only downstream Node validation; source verification must fail before it.
        receipt=subprocess.CompletedProcess([],0,stdout='{"status":"PASS"}',stderr='')
        with patch.object(worker.subprocess,'run',return_value=receipt):
            with self.assertRaisesRegex(CurationError,'SOURCE_HASH_CHANGED'):
                worker.prepare(self.registry,[choice])

    def test_export_retains_many_batch_asset_memberships(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        from PIL import Image
        Image.new('RGB',(20,20),'white').save(self.source/'new.png')
        newer=self.registry.inspect(self.source,synthetic=True)
        data=self.registry.export()['tables']
        self.assertIn('batch_assets',data)
        self.assertEqual(len([r for r in data['batch_assets'] if r['batch_id']==newer]),10)
        self.assertEqual(len([r for r in data['batch_assets'] if r['batch_id']==batch]),9)

    def test_split_name_is_scoped_to_original_object(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        aids=[r['id'] for r in self.registry.rows('SELECT id FROM assets')]
        oa,pa=self.obj_proposal(batch,aids[0],'a');ob,pb=self.obj_proposal(batch,aids[1],'b')
        for i,(pid,aid,key) in enumerate(((pa,aids[0],'a'),(pb,aids[1],'b'))):
            self.registry.decision(self.task('group',key),{'id':i+1},pid,'corrected',[{'asset_id':aid,'membership':'split','role':'overview','split_label':'New group'}],'test-reviewer')
        targets=self.registry.rows('SELECT DISTINCT object_id FROM object_assets')
        self.assertEqual(len(targets),2,'Separate original objects using the same new group label must not implicitly merge')

    def test_new_same_task_deferred_annotation_cannot_leave_publishable_old_group(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        aid=self.registry.rows('SELECT id FROM assets')[0]['id']
        obj,pid=self.obj_proposal(batch,aid,'a');task=self.task('group','a')
        self.registry.decision(task,{'id':1},pid,'accepted',[{'asset_id':aid,'membership':'keep','role':'overview'}],'test-reviewer')
        try:
            self.registry.decision(task,{'id':2},pid,'deferred',[{'asset_id':aid,'membership':'unresolved','role':'unspecified'}],'test-reviewer')
        except CurationError:
            return  # Refusing a second annotation until a new version is also safe.
        choice={'objectId':obj,'kind':'inscription','title':'Synthetic title','media':[{'assetId':aid,'position':0,'isRepresentative':True}]}
        receipt=subprocess.CompletedProcess([],0,stdout='{"status":"PASS"}',stderr='')
        with patch.object(worker.subprocess,'run',return_value=receipt):
            with self.assertRaises(CurationError):worker.prepare(self.registry,[choice])

    def test_non_synthetic_reassigned_asset_marks_package_non_synthetic(self):
        # All bytes generated here; only the session label is deliberately non-synthetic.
        source_a=self.make_source('classification-a',1);source_b=self.make_source('classification-b',1)
        ba=self.registry.inspect(source_a,synthetic=False);bb=self.registry.inspect(source_b,synthetic=True)
        aa=self.registry.rows('SELECT id FROM assets WHERE batch_id=?',(ba,))[0]['id']
        ab=self.registry.rows('SELECT id FROM assets WHERE batch_id=?',(bb,))[0]['id']
        oa,pa=self.obj_proposal(ba,aa,'a');ob,pb=self.obj_proposal(bb,ab,'b')
        self.registry.decision(self.task('group','b'),{'id':2},pb,'accepted',[{'asset_id':ab,'membership':'keep','role':'overview'}],'test-reviewer')
        self.registry.decision(self.task('group','a'),{'id':1},pa,'corrected',[{'asset_id':aa,'membership':'reassign','role':'detail','target':ob}],'test-reviewer')
        choice={'objectId':ob,'kind':'inscription','title':'Synthetic title','media':[{'assetId':aa,'position':0,'isRepresentative':True}]}
        receipt=subprocess.CompletedProcess([],0,stdout='{"status":"PASS"}',stderr='')
        with patch.object(worker.subprocess,'run',return_value=receipt):worker.prepare(self.registry,[choice])
        prepared=json.loads((self.registry.root/'state/prepared-package.json').read_text())
        self.assertIs(prepared['synthetic'],False)
        self.assertIs(json.loads(Path(prepared['path']).read_text())['synthetic'],False)


if __name__=='__main__':unittest.main()
