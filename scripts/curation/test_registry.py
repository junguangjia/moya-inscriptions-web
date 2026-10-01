import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from registry import Registry,CurationError,digest,canonical,private_json,stable_id
from preview_guard import preview_path


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.registry=Registry(self.root/'runtime');self.source=self.root/'chosen';self.source.mkdir()
        from PIL import Image
        for i in range(2):Image.new('RGB',(60,40),(i*50,100,100)).save(self.source/f'{i}.png')
        self.batch=self.registry.inspect(self.source,synthetic=True)
        self.assets=self.registry.rows('SELECT * FROM assets')
    def tearDown(self):self.registry.db.close();self.temp.cleanup()
    def proposal(self,value='old'):
        obj='object-test'
        with self.registry.db:
            self.registry.db.execute('INSERT OR IGNORE INTO objects VALUES(?,?,?)',(obj,self.batch,'g1'))
            pid=self.registry.propose(self.batch,obj,'field','title',value,[self.assets[0]['id']],'a'*64,'model-pin','prompt')
        return pid
    def task(self,pid,key):
        with self.registry.db:self.registry.db.execute('INSERT INTO tasks VALUES(?, ?,1,\'field\',\'{}\',\'hash\')',(key,len(self.registry.rows('SELECT * FROM tasks'))+1))
        return {'task_key':key}
    def test_repeat_import_identity_source_hash_and_selection(self):
        self.assertEqual(self.registry.inspect(self.source,synthetic=True),self.batch)
        self.assertEqual(len(self.registry.rows('SELECT * FROM assets')),2)
        self.assertEqual(self.registry.source_verify(self.batch),2)
        with self.assertRaises(CurationError):self.registry.inspect(self.source,limit=1)
    def test_reused_assets_link_to_new_batch(self):
        from PIL import Image
        Image.new('RGB',(50,50),'red').save(self.source/'new.png')
        new=self.registry.inspect(self.source,synthetic=True)
        self.assertNotEqual(new,self.batch)
        self.assertEqual(len(self.registry.rows('SELECT * FROM batch_assets WHERE batch_id=?',(new,))),3)
        self.assertEqual(self.registry.source_verify(new),3)
    def test_changed_and_missing_source_are_errors(self):
        file=self.source/'0.png';file.write_bytes(b'changed')
        with self.assertRaisesRegex(CurationError,'SOURCE_HASH_CHANGED'):self.registry.source_verify(self.batch)
        self.source.rename(self.root/'unmounted')
        with self.assertRaisesRegex(CurationError,'SOURCE_UNAVAILABLE'):self.registry.source_verify(self.batch)
    def test_decision_replay_immutable_and_stale_annotation(self):
        pid=self.proposal();task=self.task(pid,'task1');annotation={'id':1,'result':[{'value':'old'}]}
        self.assertTrue(self.registry.decision(task,annotation,pid,'accepted','old','test-reviewer'))
        self.assertFalse(self.registry.decision(task,annotation,pid,'accepted','old','test-reviewer'))
        with self.assertRaisesRegex(CurationError,'SYNCED_ANNOTATION_CHANGED'):self.registry.decision(task,{'id':1,'result':['changed']},pid,'corrected','changed','test-reviewer')
        with self.assertRaises(sqlite3.IntegrityError):self.registry.db.execute("UPDATE decisions SET value='overwrite'")
    def test_stale_proposal_cannot_replace_new_review(self):
        old=self.proposal();new=self.proposal('new');old_task=self.task(old,'old');new_task=self.task(new,'new')
        self.registry.decision(new_task,{'id':2},new,'accepted','new','test-reviewer')
        with self.assertRaisesRegex(CurationError,'STALE_REVIEW'):self.registry.decision(old_task,{'id':1},old,'accepted','old','test-reviewer')
        self.assertEqual(json.loads(self.registry.rows('SELECT * FROM facts')[0]['value']),'new')
    def test_deferred_does_not_become_authoritative(self):
        pid=self.proposal();task=self.task(pid,'defer')
        self.registry.decision(task,{'id':1},pid,'deferred',None,'test-reviewer')
        self.assertEqual(self.registry.rows('SELECT * FROM facts'),[])
    def test_display_age_replay_and_old_version_replay(self):
        old=self.proposal();task=self.task(old,'old')
        annotation={'id':1,'result':['kept'],'created_ago':'just now'}
        self.registry.decision(task,annotation,old,'accepted','old','test-reviewer')
        new=self.proposal('new')
        self.assertFalse(self.registry.decision(task,{**annotation,'created_ago':'1 minute ago'},old,'accepted','old','test-reviewer'))
        self.registry.decision(self.task(new,'new'),{'id':2},new,'rejected',None,'test-reviewer')
        self.assertEqual(self.registry.rows('SELECT * FROM facts'),[])

    def test_preview_traversal_and_parent_symlink(self):
        previews=self.registry.root/'served-previews';outside=self.root/'outside';outside.mkdir();(outside/'p.jpg').write_bytes(b'x')
        (previews/'escape').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(ValueError):preview_path(previews,'escape/p.jpg')
        with self.assertRaises(ValueError):preview_path(previews,'../../outside/p.jpg')
    def test_instance_and_many_to_many_media_bindings(self):
        a=self.registry.bind('development','object1:asset1:sha','media')
        self.assertEqual(a,self.registry.bind('development','object1:asset1:sha','media'))
        self.assertNotEqual(a,self.registry.bind('development','object2:asset1:sha','media'))
        self.assertNotEqual(a,self.registry.bind('production','object1:asset1:sha','media'))


if __name__=='__main__':unittest.main()
