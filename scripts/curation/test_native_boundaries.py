"""Controlled synthetic lifecycle, provenance and crash-replay regressions."""
import copy
import json
import subprocess
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from registry import Registry, CurationError, private_json, canonical
from daily import overview, missing_reviews
from synthetic_fixture import create_fixture, certified
from ls_client import LabelStudioClient, ReviewError, build_field_task
from test_ls_client import mapping, urls
import service
import worker


class LifecycleTests(unittest.TestCase):
    def test_two_start_controllers_serialize_one_owned_service_pair(self):
        with tempfile.TemporaryDirectory(prefix='artvenn-lifecycle-synthetic-') as tmp:
            root=Path(tmp);launched=[];live={};guard=threading.Lock()
            config={'ls_port':49081,'ui_port':49080,'username':'synthetic@localhost.invalid','password':'SYNTHETIC_TEST_ONLY','api_token':'SYNTHETIC_TEST_ONLY'}
            class Child:
                def __init__(self,args,**kwargs):
                    kind='helper' if 'app.py' in args[1] else 'label-studio'
                    with guard:
                        self.pid=7000+len(launched);launched.append(kind);live[self.pid]=kind
                def poll(self):return None
            def run(args,**kwargs):
                if args[0]=='/bin/ps':return subprocess.CompletedProcess(args,0,stdout='SYNTHETIC PROCESS BIRTH',stderr='')
                time.sleep(.03)
                return subprocess.CompletedProcess(args,0,stdout='',stderr='')
            with patch.object(service,'Registry'),patch.object(service,'settings',return_value=config),patch.object(service,'available',return_value=True),patch.object(service,'owned_process',side_effect=lambda record,*_:record['pid'] in live),patch.object(service,'http_ready',side_effect=lambda port,kind:kind in live.values()),patch.object(service.subprocess,'Popen',Child),patch.object(service.subprocess,'run',side_effect=run):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results=list(pool.map(lambda _:service.start(root),range(2)))
            self.assertEqual(launched,['label-studio','helper'])
            self.assertTrue(all(r['local_setup']=='running' for r in results))
            self.assertEqual(len(json.loads((root/'state/processes.json').read_text())),2)

    def test_owned_but_unready_is_reported_without_spawn_or_kill(self):
        with tempfile.TemporaryDirectory(prefix='artvenn-unready-synthetic-') as tmp:
            root=Path(tmp);private_json(root/'state/processes.json',{'label-studio':{'pid':7,'birth':'SYNTHETIC'}})
            with patch.object(service,'Registry'),patch.object(service,'settings',return_value={'ls_port':49181,'ui_port':49180}),patch.object(service,'owned_process',return_value=True),patch.object(service,'http_ready',return_value=False),patch.object(service.subprocess,'Popen') as child:
                with self.assertRaisesRegex(CurationError,'OWNED_BUT_NOT_READY'):service.start(root)
                child.assert_not_called()


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='artvenn-certified-synthetic-')
        self.base=Path(self.tmp.name);self.source=self.base/'synthetic';create_fixture(self.source)
        self.registry=Registry(self.base/'runtime')
    def tearDown(self):self.registry.db.close();self.tmp.cleanup()

    def test_generated_fixture_is_certified_but_extra_or_replaced_bytes_are_not(self):
        self.assertTrue(certified(self.source))
        extra=self.source/'extra.png';extra.write_bytes((self.source/'01-overview.png').read_bytes())
        self.assertFalse(certified(self.source))
        with self.assertRaisesRegex(ValueError,'NOT_CERTIFIED'):create_fixture(self.source)

    def test_forged_adjacent_manifest_does_not_certify_replaced_photo(self):
        import hashlib
        path=self.source/'01-overview.png';path.write_bytes(b'SYNTHETIC_REPLACED_UNTRUSTED_BYTES')
        manifest=json.loads((self.source/'fixture-manifest.json').read_text())
        manifest['assets'][0]['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        (self.source/'fixture-manifest.json').write_text(json.dumps(manifest))
        self.assertFalse(certified(self.source))

    def test_session_downgrades_and_cannot_be_promoted_by_inspection(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        self.registry.inspect(self.source,synthetic=False)
        self.registry.inspect(self.source,synthetic=True)
        self.assertEqual(self.registry.db.execute('SELECT synthetic FROM sessions').fetchone()[0],0)
        self.assertEqual(self.registry.source_verify(batch),4)

    def test_package_proof_refuses_unknown_records_and_later_extra_source(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        with self.registry.db:self.registry.db.execute('INSERT INTO objects VALUES(?,?,?)',('fixture-object',batch,'g'))
        package={'objects':[{'objectId':'fixture-object','media':[]}]}
        self.assertTrue(worker.synthetic_package_verified(self.registry,package))
        self.assertFalse(worker.synthetic_package_verified(self.registry,{'objects':[{'objectId':'unknown','media':[]}]}))
        (self.source/'extra.png').write_bytes((self.source/'01-overview.png').read_bytes())
        self.assertFalse(worker.synthetic_package_verified(self.registry,package))

    def test_changed_analyzed_folder_refused_before_new_batch_or_objects(self):
        batch=self.registry.inspect(self.source,synthetic=True)
        with self.registry.db:self.registry.db.execute('INSERT INTO objects VALUES(?,?,?)',('fixture-object',batch,'g'))
        before=self.registry.rows('SELECT * FROM batches')
        (self.source/'added.png').write_bytes((self.source/'01-overview.png').read_bytes())
        with self.assertRaisesRegex(CurationError,'ANALYZED_FOLDER_CONTENTS_CHANGED'):self.registry.inspect(self.source,synthetic=False)
        self.assertEqual(self.registry.rows('SELECT * FROM batches'),before)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM objects').fetchone()[0],1)
        self.assertEqual(self.registry.db.execute('SELECT synthetic FROM sessions').fetchone()[0],0)


class PredictionReplayTests(unittest.TestCase):
    def test_crash_replay_with_missing_prediction_still_fails_without_post(self):
        task=build_field_task(mapping('field',['a3']),urls(1),'SYNTHETIC','title')
        found={'id':3,'data':copy.deepcopy(task['data']),'predictions':[],'annotations':[]}
        client=LabelStudioClient.__new__(LabelStudioClient)
        client.list_tasks=lambda _: [found]
        client.read_task=lambda _:found
        client.request=lambda *_:self.fail('Replay may not modify native task')
        with self.assertRaisesRegex(ReviewError,'IMPORT_READBACK_MISMATCH'):client.import_task(1,task)
        found['predictions']=copy.deepcopy(task['predictions'])
        self.assertTrue(client.import_task(1,task)['replayed'])
        found['predictions'][0]['result'][0]['value']={'text':['DRIFT']}
        with self.assertRaisesRegex(ReviewError,'PREDICTION_READBACK_MISMATCH'):client.import_task(1,task)


class ProjectionTests(unittest.TestCase):
    def test_partial_receipt_is_never_verified(self):
        with tempfile.TemporaryDirectory(prefix='artvenn-partial-synthetic-') as tmp:
            registry=Registry(Path(tmp))
            try:
                for status,failed,expected in [('PASS',0,'verified'),('PARTIAL',1,'partial'),('FAILED',1,'failed'),('PASS',1,'failed')]:
                    private_json(registry.root/'state/development-result.json',{'developmentIntegration':status,'succeeded':1,'failed':failed})
                    actual=overview(registry,None,{},False)['integration']
                    self.assertEqual(actual['status'],expected)
                    self.assertEqual(actual['failed'],failed)
            finally:registry.db.close()


if __name__=='__main__':unittest.main()
