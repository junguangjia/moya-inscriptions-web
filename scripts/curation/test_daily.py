"""Synthetic daily scope, stale-stage and immutable review regressions."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from registry import Registry, CurationError, private_json, canonical, digest
from daily import folder_count, overview, selected_objects, missing_reviews, submitted_tasks
from ls_client import make_mapping
import app
import worker


class DailyFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='artvenn-native-synthetic-')
        self.root = Path(self.tmp.name)
        self.registry = Registry(self.root / 'runtime')
        from PIL import Image
        self.sources = []
        self.objects = []
        self.batches = []
        for n, synthetic in enumerate([True, False]):
            source = self.root / f'fixture-{n}'
            source.mkdir()
            Image.new('RGB', (40, 40), (n * 50, 0, 200)).save(source / 'test.png')
            self.sources.append(source)
            batch = self.registry.inspect(source, synthetic=synthetic)
            self.batches.append(batch)
            asset = self.registry.db.execute('SELECT id FROM assets WHERE batch_id=?', (batch,)).fetchone()[0]
            oid = f'synthetic-object-{n}'
            self.objects.append(oid)
            with self.registry.db:
                self.registry.db.execute('INSERT INTO objects VALUES(?,?,?)', (oid, batch, oid))
            pid = self.registry.propose(batch, oid, 'group', None, [asset], [asset], 'a'*64, 'synthetic', 'synthetic')
            mapping = make_mapping(kind='group', task_key=f'review-{n}', task_version=1, subject_id=oid, proposal_ids=[pid], asset_order=[asset], input_hash='a'*64, model_version='synthetic')
            with self.registry.db:
                self.registry.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?)', (f'review-{n}', n+1, 1, 'group', canonical(mapping), 'a'*64))
        self.selected = {'source': str(self.sources[1]), 'synthetic': False}
        self.menu = app.Application.__new__(app.Application)
        self.menu.root = self.registry.root
        self.menu.worker = None
        self.menu.job = {'status': 'idle'}
        self.menu.selected = self.selected
        self.menu.config = {}

    def tearDown(self):
        self.registry.db.close()
        self.tmp.cleanup()

    def test_overview_counts_only_the_chosen_batch_not_all_time_or_fixture(self):
        value = overview(self.registry, self.selected, {'status': 'idle'}, False)
        self.assertEqual(value['totals']['files'], 1)
        self.assertEqual([o['id'] for o in value['objects']], [self.objects[1]])
        self.assertEqual(value['review']['tasks'], 1)
        self.assertEqual(value['draftReady'], 0)

    def test_synthetic_view_does_not_replace_the_real_selection_or_show_real_name(self):
        before = dict(self.selected)
        # A library-level fixture view with no matching default fixture directory is empty.
        value = overview(self.registry, self.selected, {'status':'inferencing'}, True, 'synthetic')
        self.assertTrue(value['viewOnly'])
        self.assertEqual(value['selection']['name'], 'Synthetic 合成测试资料')
        self.assertNotEqual(value['phase'], 'inferencing')
        self.assertEqual(self.selected, before)

    def test_foreign_object_selection_is_refused(self):
        self.assertEqual(selected_objects(self.registry, self.selected, 'current'), [self.objects[1]])
        with self.assertRaisesRegex(CurationError, 'OBJECT_SCOPE_INVALID'):
            selected_objects(self.registry, self.selected, 'current', [self.objects[0]])

    def test_previous_worker_status_is_not_used_for_new_selection(self):
        private_json(self.registry.root/'state/worker-status.json', {'status':'review_ready','selection_key':'old-source'})
        self.assertEqual(self.menu.current_job()['status'], 'idle')
        key = digest({'source': self.selected['source'], 'synthetic': False})
        private_json(self.registry.root/'state/worker-status.json', {'status':'failed','category':'MODEL_TIMEOUT','selection_key':key})
        self.assertEqual(self.menu.current_job()['category'], 'MODEL_TIMEOUT')

    def test_folder_count_is_bounded_and_never_follows_unselected_link(self):
        (self.sources[1]/'external').symlink_to(self.sources[0], target_is_directory=True)
        self.assertEqual(folder_count(self.sources[1], 50), {'count':1,'overLimit':False})
        (self.sources[1]/'more.png').write_bytes((self.sources[1]/'test.png').read_bytes())
        self.assertEqual(folder_count(self.sources[1], 1), {'count':2,'overLimit':True})
        with self.assertRaisesRegex(CurationError, 'EXPLICIT_BATCH_DIRECTORY_REQUIRED'):
            folder_count(Path.home(), 50)

    def test_cancelled_picker_retains_selection(self):
        with patch.object(app.subprocess,'run',return_value=type('Reply',(),{'returncode':1})()):
            result=self.menu.action({'action':'select'})
        self.assertEqual(result['status'],'selection_cancelled')
        self.assertEqual(self.menu.selected,self.selected)

    def test_native_source_choice_counts_but_does_not_decode_or_modify(self):
        source=self.sources[1]
        before=(source/'test.png').read_bytes()
        result=self.menu.action({'action':'select-path','path':str(source),'limit':50})
        self.assertEqual(result['count'],1)
        self.assertEqual((source/'test.png').read_bytes(),before)
        self.assertEqual(self.menu.job['status'],'idle')

    def test_submitted_and_collected_remain_distinct(self):
        native=self.registry.root/'label-studio';native.mkdir()
        db=sqlite3.connect(native/'label_studio.sqlite3')
        db.execute('CREATE TABLE task_completion(task_id INTEGER,was_cancelled INTEGER)')
        db.executemany('INSERT INTO task_completion VALUES(?,?)',[(2,0),(1,0)])
        db.commit();db.close()
        value=overview(self.registry,self.selected,{},False)
        self.assertEqual(value['review']['submitted'],1)
        self.assertEqual(value['review']['collected'],0)
        self.assertEqual(value['review']['waitingCollection'],1)
        self.assertEqual(submitted_tasks(self.registry.root,[]),set())

    def test_missing_reviews_link_to_the_exact_current_task(self):
        missing=missing_reviews(self.registry.db,self.objects[1])
        self.assertEqual(missing,[{'label':'照片分组','status':'pending','url':'/review?task=2'}])

    def test_optional_deferred_history_does_not_block_but_pending_group_does(self):
        oid=self.objects[1]
        pid=self.registry.propose(self.batches[1],oid,'field','period_original','未确定',[],'a'*64,'synthetic','unknown-history')
        with self.registry.db:self.registry.db.execute('INSERT INTO tasks VALUES(?,10,1,?,?,?)',('optional-history','field','{}','a'*64))
        self.registry.decision({'task_key':'optional-history'},{'id':10},pid,'deferred','未确定','test-reviewer')
        before=self.registry.rows('SELECT * FROM decisions')
        self.assertEqual(missing_reviews(self.registry.db,oid),[{'label':'照片分组','status':'pending','url':'/review?task=2'}])
        self.assertEqual(self.registry.rows('SELECT * FROM decisions'),before)
        self.assertFalse(self.registry.rows("SELECT * FROM facts WHERE object_id=? AND field='period_original'",(oid,)))

    def test_real_admin_draft_action_stops_before_any_child_without_authorization(self):
        private_json(self.registry.root/'state/prepared-package.json',{'synthetic':False,'path':'unused'})
        with patch.object(app.subprocess,'run') as child:
            with self.assertRaisesRegex(CurationError,'REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED'):
                self.menu.action({'action':'admin-draft'})
        child.assert_not_called()

    def test_admin_links_only_include_verified_selected_objects_and_no_credentials(self):
        from daily import admin_drafts
        valid={'objectId':self.objects[1],'status':'verified','cmsDraft':{'baseURL':'http://127.0.0.1:43219','id':11,'expectedRevision':3}}
        private_json(self.registry.root/'state/development-result.json',{'drafts':[valid,{**valid,'objectId':self.objects[0]},
            {**valid,'status':'failed'},{**valid,'cmsDraft':{**valid['cmsDraft'],'baseURL':'https://example.invalid'}}]})
        self.assertEqual(admin_drafts(self.registry.root,{self.objects[1]}),[{'objectId':self.objects[1],'id':11,'revision':3,
            'url':'http://127.0.0.1:43219/admin/collections/catalogs/11'}])

    def test_renewal_is_scoped_and_preserves_other_versions(self):
        with patch.object(worker,'review_tasks',return_value=1):
            result=worker.renew_review(self.registry,{},[self.objects[1]])
        self.assertEqual(result['new_tasks'],1)
        self.assertEqual(self.registry.db.execute('SELECT max(version) FROM proposals WHERE subject=?',(self.objects[0],)).fetchone()[0],1)
        self.assertEqual(self.registry.db.execute('SELECT max(version) FROM proposals WHERE subject=?',(self.objects[1],)).fetchone()[0],2)

    def test_collect_does_not_read_other_scope_native_tasks(self):
        seen=[]
        class Client:
            def read_task(_,task_id):
                seen.append(task_id)
                return {'data':{},'annotations':[]}
        with patch.object(worker,'ls',return_value=Client()):
            worker.collect(self.registry,{},[self.objects[1]])
        self.assertEqual(seen,[2])

    def test_reselecting_same_source_clears_old_failure_and_requires_current_inspection(self):
        key=digest({'source':self.selected['source'],'synthetic':False})
        private_json(self.registry.root/'state/worker-status.json',{'status':'failed','category':'MODEL_TIMEOUT','selection_key':key})
        self.menu.action({'action':'select-path','path':str(self.sources[1])})
        self.assertEqual(self.menu.current_job()['status'],'idle')
        value=overview(self.registry,self.menu.selected,self.menu.current_job(),False)
        self.assertEqual(value['phase'],'selected')
        self.assertEqual(value['objects'],[])

    def test_exact_reused_batch_takes_precedence_over_later_created_history(self):
        session=self.registry.db.execute('SELECT session_id FROM batches WHERE id=?',(self.batches[1],)).fetchone()[0]
        with self.registry.db:self.registry.db.execute('INSERT INTO batches VALUES(?,?,?,NULL,?)',('later-history',session,'review_ready',9999999999))
        selected={**self.selected,'batch_id':self.batches[1]}
        private_json(self.registry.root/'state/selection.json',selected)
        value=overview(self.registry,self.selected,{},False)
        self.assertEqual([o['id'] for o in value['objects']],[self.objects[1]])

    def test_collect_refuses_live_startup_worker_before_pid_receipt(self):
        self.menu.worker=type('Child',(),{'poll':lambda _:None})()
        with self.assertRaisesRegex(CurationError,'ANALYSIS_RUNNING'):self.menu.action({'action':'collect'})

    def test_renewed_origin_media_has_actionable_current_review_link(self):
        first=self.registry.db.execute("SELECT * FROM proposals WHERE subject=? AND kind='group'",(self.objects[0],)).fetchone()
        second=self.registry.db.execute("SELECT * FROM proposals WHERE subject=? AND kind='group'",(self.objects[1],)).fetchone()
        a=json.loads(first['value'])[0];b=json.loads(second['value'])[0]
        self.registry.decision({'task_key':'review-1'},{'id':1},second['id'],'accepted',[{'asset_id':b,'membership':'keep','role':'overview'}],'test-reviewer')
        self.registry.decision({'task_key':'review-0'},{'id':2},first['id'],'corrected',[{'asset_id':a,'membership':'reassign','role':'detail','target':self.objects[1]}],'test-reviewer')
        pid=self.registry.propose(self.batches[0],self.objects[0],'group',None,[a],[a],'a'*64,'synthetic','new')
        mapping=make_mapping(kind='group',task_key='origin-new',task_version=2,subject_id=self.objects[0],proposal_ids=[pid],asset_order=[a],input_hash='a'*64,model_version='synthetic')
        with self.registry.db:self.registry.db.execute('INSERT INTO tasks VALUES(?,?,1,?,?,?)',('origin-new',3,'group',canonical(mapping),'hash'))
        missing=missing_reviews(self.registry.db,self.objects[1])
        self.assertTrue(any(m['url']=='/review?task=3' and '照片来源' in m['label'] for m in missing))


if __name__=='__main__':unittest.main()
