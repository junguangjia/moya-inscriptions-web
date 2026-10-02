"""Pure Synthetic task-fence checks; no live LS or real materials."""
import json
import unittest
from review_scope import parse_focus,focused_list,allow_request
from registry import CurationError

class ReviewScopeTests(unittest.TestCase):
    def setUp(self):self.scope=parse_focus('2:4:s')
    def allowed(self,path,query=None,method='GET',belongs=4):
        return allow_request(path,query or {},method,self.scope,lambda kind,pk:belongs)
    def test_scope_is_bounded_state_not_an_authentication_grant(self):
        self.assertIsNone(parse_focus(None))
        for x in ('2:0:s','1:4:any','wrong','2:4:s:extra'):
            with self.assertRaises(CurationError):parse_focus(x)
    def test_list_selection_overrides_global_view_before_native_queryset(self):
        query=focused_list({'view':'GLOBAL','project':'99','query':'GLOBAL','page_size':'100'},self.scope)
        self.assertNotIn('view',query);self.assertEqual(query['project'],'2')
        self.assertEqual(json.loads(query['query'])['selectedItems'],{'all':False,'included':[4],'excluded':[]})
    def test_current_task_canvas_and_submit_allowed_other_tasks_denied(self):
        for path in ('/api/tasks/4/','/api/tasks/4/drafts','/api/tasks/4/annotations/'):
            self.assertTrue(self.allowed(path,method='POST' if path.endswith('annotations/') else 'GET'))
        for path in ('/api/tasks/19/','/api/tasks/19/annotations/','/api/tasks/19/drafts'):
            self.assertFalse(self.allowed(path))
        self.assertFalse(self.allowed('/api/tasks/',method='POST'))
    def test_annotation_prediction_and_draft_bind_to_focused_task(self):
        for path in ('/api/annotations/101/','/api/drafts/201/','/api/predictions/301/','/api/tasks/4/annotations/101/drafts'):
            self.assertTrue(self.allowed(path));self.assertFalse(self.allowed(path,belongs=19))
    def test_next_sample_history_export_and_cross_project_refused(self):
        for path in ('/api/dm/actions/','/api/dm/tasks/next','/api/projects/2/next/','/api/projects/2/sample-task/','/api/projects/2/label-stream-history/','/api/projects/2/export/','/api/projects/3/','/projects/2/'):
            self.assertFalse(self.allowed(path))
        self.assertTrue(self.allowed('/projects/2/data/',{'task':'4'}))
        self.assertFalse(self.allowed('/projects/2/data/',{'task':'19'}))
    def test_companion_requires_same_native_task_and_project(self):
        self.assertTrue(self.allowed('/curation/context',{'task':'4','project':'2'}))
        self.assertFalse(self.allowed('/curation/context',{'task':'19','project':'2'}))
        self.assertFalse(self.allowed('/curation/context',{'task':'4','project':'3'}))

    def test_actual_versioned_certified_previews_work_and_unknown_names_fail(self):
        import tempfile
        from pathlib import Path
        from registry import Registry
        from synthetic_fixture import create_fixture
        from review_scope import synthetic_preview
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'synthetic';create_fixture(source)
            registry=Registry(root/'runtime');registry.inspect(source,synthetic=True)
            previews=registry.rows('SELECT preview FROM assets')
            self.assertEqual(len(previews),4)
            for row in previews:
                self.assertIn('-exif-transpose-rgb-jpeg-1536-v1',row['preview'])
                self.assertTrue(synthetic_preview(root/'runtime','/data/local-files/',{'d':row['preview']}))
                self.assertTrue(synthetic_preview(root/'runtime','/preview/'+row['preview'],{}))
            self.assertFalse(synthetic_preview(root/'runtime','/preview/photos/asset-unknown.jpg',{}))
            self.assertFalse(synthetic_preview(root/'runtime','/data/local-files/',{'d':'../synthetic/01.jpg'}))
            registry.db.close()
