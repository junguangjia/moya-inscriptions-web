"""Synthetic identity, frozen-review and authenticated companion regressions."""
import json
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from registry import Registry, CurationError, private_json, canonical, digest
from presentation import card, rename, readonly, object_directory, task_context
from ls_client import make_mapping, build_group_task, choice_result, fingerprint, validate_annotation
import worker


class SyntheticIdentityFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="artvenn-identity-synthetic-")
        self.base = Path(self.temp.name)
        self.registry = Registry(self.base / "runtime")
        self.source = self.base / "synthetic"
        self.source.mkdir()
        from PIL import Image
        for name, color in (("one.png", "blue"), ("two.png", "green")):
            Image.new("RGB", (50, 40), color).save(self.source / name)
        self.batch = self.registry.inspect(self.source, synthetic=True)
        self.aids = [a["id"] for a in self.registry.rows("SELECT id FROM assets ORDER BY relative_path")]
        self.add_object("z-first", self.aids)
        self.add_object("a-second", self.aids[:1])

    def tearDown(self):
        self.registry.db.close()
        self.temp.cleanup()

    def add_object(self, oid, aids):
        with self.registry.db:
            self.registry.db.execute("INSERT INTO objects VALUES(?,?,?)", (oid, self.batch, oid))
            return self.registry.propose(self.batch, oid, "group", None, aids, aids, "a"*64, "synthetic-model", "synthetic-prompt")

    def native_task(self):
        pid = self.registry.db.execute("SELECT id FROM proposals WHERE subject='z-first' AND kind='group'").fetchone()[0]
        mapping = make_mapping(kind="group", task_key="synthetic-review", task_version=1, subject_id="z-first",
            proposal_ids=[pid], asset_order=self.aids, input_hash="a"*64, model_version="synthetic")
        task = build_group_task(mapping, ["/data/local-files/?d=" + a["preview"] for a in self.registry.rows("SELECT preview FROM assets ORDER BY relative_path")],
            ["overview", "detail"], reassign_targets={"对象 2": "a-second"}, context="SYNTHETIC")
        private_json(self.registry.root / "state/synthetic-review-task.json", task)
        with self.registry.db:
            self.registry.db.execute("INSERT INTO tasks VALUES(?,8,1,'group',?,?)", ("synthetic-review", canonical(mapping), fingerprint(task["data"])))
        return pid, mapping, task

class IdentityTests(SyntheticIdentityFixture, unittest.TestCase):
    def test_backfill_follows_original_insertion_not_uuid_sort_and_survives_restart(self):
        with self.registry.db:
            self.registry.db.execute("DROP TRIGGER object_presentation_insert")
            self.registry.db.execute("DROP TABLE object_presentation")
            self.registry.db.execute("DELETE FROM schema_version WHERE version=2")
        second = Registry(self.registry.root)
        try:
            self.assertEqual(card(second.db, "z-first")["code"], "AV-0001")
            self.assertEqual(card(second.db, "a-second")["code"], "AV-0002")
            rename(second.db, "z-first", "North wall")
        finally:
            second.db.close()
        third = Registry(self.registry.root)
        try:
            self.assertEqual(card(third.db, "z-first")["name"], "North wall")
            self.add_object("new", self.aids[:1])
            self.assertEqual(card(third.db, "z-first")["code"], "AV-0001")
            self.assertEqual(card(third.db, "new")["code"], "AV-0003")
        finally:
            third.db.close()

    def test_concurrent_new_objects_receive_distinct_persistent_codes(self):
        def insert(i):
            registry = Registry(self.registry.root)
            try:
                with registry.db:
                    registry.db.execute("INSERT INTO objects VALUES(?,?,?)", (f"new-{i}", self.batch, f"new-{i}"))
                return card(registry.db, f"new-{i}")["code"]
            finally:
                registry.db.close()
        with ThreadPoolExecutor(max_workers=4) as pool:
            codes = list(pool.map(insert, range(6)))
        self.assertEqual(len(set(codes)), 6)
        self.assertEqual(card(self.registry.db, "z-first")["code"], "AV-0001")

    def test_rename_does_not_approve_title_or_change_frozen_task_and_mapping(self):
        pid, mapping, task = self.native_task()
        frozen = digest(self.registry.export()["tables"])
        rename(self.registry.db, "z-first", "<script>SYNTHETIC</script>")
        self.assertEqual(task_context(self.registry.root, self.registry.db, 8, 1)["current"]["name"], "<script>SYNTHETIC</script>")
        self.assertEqual(json.loads((self.registry.root / "state/synthetic-review-task.json").read_text()), task)
        self.assertEqual(json.loads(self.registry.rows("SELECT mapping FROM tasks")[0]["mapping"]), mapping)
        self.assertEqual(self.registry.rows("SELECT * FROM facts"), [])
        self.assertEqual(self.registry.rows("SELECT * FROM decisions"), [])
        # Alias is the only table delta; all research and review rows remain frozen.
        self.registry.db.execute("UPDATE object_presentation SET working_name=''")
        self.registry.db.commit()
        self.assertEqual(digest(self.registry.export()["tables"]), frozen)

    def test_same_names_remain_distinguishable_and_clear_name_uses_labelled_ai_suggestion(self):
        for oid in ("z-first", "a-second"):
            rename(self.registry.db, oid, "same")
        self.assertNotEqual(card(self.registry.db, "z-first")["code"], card(self.registry.db, "a-second")["code"])
        with self.registry.db:
            self.registry.propose(self.batch, "z-first", "field", "title", "Synthetic AI name", self.aids[:1], "a"*64, "synthetic", "synthetic")
        rename(self.registry.db, "z-first", "")
        self.assertEqual(card(self.registry.db, "z-first")["nameSource"], "AI 建议名称 · 待确认")

    def test_name_bounds_controls_and_unknown_object_refused(self):
        for name in (None, "x"*121, "line\nbreak", "bad\x7f"):
            with self.assertRaisesRegex(CurationError, "WORKING_NAME_INVALID"):
                rename(self.registry.db, "z-first", name)
        with self.assertRaisesRegex(CurationError, "OBJECT_UNKNOWN"):
            rename(self.registry.db, "missing", "name")

    def test_frozen_reassign_target_roundtrip_survives_target_rename(self):
        pid, mapping, task = self.native_task()
        rename(self.registry.db, "a-second", "Target working name")
        context = task_context(self.registry.root, self.registry.db, 8, 1)
        self.assertEqual(context["targets"][0]["choice"], "对象 2")
        self.assertEqual(context["targets"][0]["object"]["name"], "Target working name")
        results = []
        for index in range(2):
            results += [choice_result("membership", "images", "reassign" if index == 0 else "belongs", index),
                        choice_result("role", "images", "overview", index)]
            if index == 0:
                results.append(choice_result("reassign_target", "images", "对象 2", index))
        normalized = validate_annotation("group", task, {"id": 99, "result": results, "completed_by": 1}, mapping)
        self.assertEqual(normalized["assets"][0]["target_object_id"], "a-second")
        values = [{"asset_id": row["asset_id"], "membership": "keep" if row["membership"] == "belongs" else row["membership"],
                   "role": row["role"], "target": row["target_object_id"], "split_label": row["split_label"]} for row in normalized["assets"]]
        stored = self.registry.rows("SELECT * FROM tasks")[0]
        annotation = {"id": 99, "result": results}
        self.registry.decision(stored, annotation, pid, "corrected", values, "test-reviewer")
        self.assertFalse(self.registry.decision(stored, annotation, pid, "corrected", values, "test-reviewer"))
        self.assertEqual([a["id"] for a in card(self.registry.db, "z-first")["assets"]], [self.aids[1]])
        self.assertEqual(card(self.registry.db, "a-second")["code"], "AV-0002")

    def test_removed_all_photos_does_not_resurrect_ai_gallery(self):
        pid, mapping, task = self.native_task()
        stored = self.registry.rows("SELECT * FROM tasks")[0]
        self.registry.decision(stored, {"id": 9}, pid, "corrected",
            [{"asset_id": aid, "membership": "remove", "role": "detail"} for aid in self.aids], "test-reviewer")
        self.assertEqual(card(self.registry.db, "z-first")["assets"], [])

    def test_new_pending_group_does_not_resurrect_removed_or_reassigned_photos(self):
        pid, mapping, task = self.native_task()
        stored = self.registry.rows("SELECT * FROM tasks")[0]
        self.registry.decision(stored, {"id": 9}, pid, "corrected",
            [{"asset_id": aid, "membership": "remove", "role": "detail"} for aid in self.aids], "test-reviewer")
        with self.registry.db:
            self.registry.propose(self.batch, "z-first", "group", None, self.aids, self.aids, "a"*64, "new-model", "new-prompt")
        self.assertEqual(card(self.registry.db, "z-first")["assets"], [])
        self.assertEqual(card(self.registry.db, "z-first")["membership"], "已收集的人工分组")

    def test_checked_native_data_can_recover_old_import_intent_without_mutation(self):
        pid, mapping, task = self.native_task()
        path=self.registry.root / "state/synthetic-review-task.json"
        old=json.loads(path.read_text());old["data"]["context"]="Old synthetic import intent"
        private_json(path,old)
        context=task_context(self.registry.root,self.registry.db,8,1,task["data"])
        self.assertEqual(context["current"]["code"],"AV-0001")
        self.assertEqual(json.loads(path.read_text()),old)

    def test_directory_filters_synthetic_and_links_actual_tasks(self):
        self.native_task()
        value = object_directory(self.registry.db, "synthetic")
        self.assertEqual(len(value["objects"]), 2)
        self.assertEqual(value["objects"][0]["tasks"][0]["url"], "/review?task=8")
        self.assertEqual(object_directory(self.registry.db, "local")["objects"], [])
        with self.assertRaises(CurationError):
            object_directory(self.registry.db, "invalid")

    def test_synthetic_filter_excludes_gallery_with_non_synthetic_origin_member(self):
        source=self.base / "second-source";source.mkdir()
        from PIL import Image
        Image.new("RGB",(50,40),"orange").save(source / "test-only.png")
        local_batch=self.registry.inspect(source,synthetic=False)
        asset=self.registry.rows("SELECT id FROM assets WHERE batch_id=?",(local_batch,))[0]["id"]
        with self.registry.db:
            self.registry.db.execute("INSERT INTO object_assets VALUES(?,?,'detail',NULL)",("z-first",asset))
        current=card(self.registry.db,"z-first")
        self.assertFalse(current["synthetic"])
        self.assertEqual(current["materialLabel"],"混合来源 · 包含本机选定资料")
        self.assertNotIn("z-first",[o["id"] for o in object_directory(self.registry.db,"synthetic")["objects"]])
        self.assertEqual([a["id"] for a in current["assets"]],[asset])

    def test_readonly_context_refuses_writes_wrong_project_and_changed_intent(self):
        self.native_task()
        with readonly(self.registry.root) as db:
            self.assertEqual(task_context(self.registry.root, db, 8, 1)["current"]["code"], "AV-0001")
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE object_presentation SET working_name='bad'")
            with self.assertRaises(CurationError):
                task_context(self.registry.root, db, 8, 2)
        file = self.registry.root / "state/synthetic-review-task.json"
        task = json.loads(file.read_text())
        task["data"]["context"] = "changed"
        private_json(file, task)
        with self.assertRaisesRegex(CurationError, "REVIEW_CONTEXT_STALE"):
            task_context(self.registry.root, self.registry.db, 8, 1)

    def test_new_relation_tasks_use_latest_blocks_in_left_right_order(self):
        # Deliberately reverse UUID lexical order and add a newer group version.
        with self.registry.db:
            self.registry.propose(self.batch, "z-first", "group", None, self.aids[1:], self.aids[1:], "a"*64, "synthetic", "next")
            relation = self.registry.propose(self.batch, "z-first", "relationship", "a-second", "different_but_related", self.aids, "a"*64, "synthetic", "next")
        tasks = []
        root = self.registry.root
        class Client:
            def ensure_projects(self): return {"group": 1, "field": 2, "relationship": 3}
            def request(self, *_): return [{"path": str(root / "served-previews/photos")}]
            def import_task(self, project, task):
                tasks.append(task)
                return {"id": len(tasks)}
        with patch.object(worker, "ls", return_value=Client()):
            worker.review_tasks(self.registry, {}, self.batch)
        related = [t for t in tasks if t["data"]["curation"]["proposal_ids"] == [relation]][0]
        self.assertEqual(related["data"]["curation"]["asset_order"], self.aids[::-1])
        self.assertIn("[1, 1]", related["data"]["context"])


class CompanionBoundaryTests(SyntheticIdentityFixture, unittest.TestCase):
    # Inherit the frozen synthetic setup, avoiding any running Label Studio state.
    def setUp(self):
        super().setUp()
        from django.conf import settings
        if not settings.configured:
            settings.configure(DEFAULT_CHARSET="utf-8")
        from django.test import RequestFactory
        self.factory = RequestFactory()
        from companion import ObjectCompanionMiddleware
        from django.http import HttpResponse
        self.middleware = ObjectCompanionMiddleware(lambda request: HttpResponse("<html><body>Native unchanged</body></html>", content_type="text/html"))
        self.environment = patch.dict(os.environ, {"LABEL_STUDIO_HOST": "http://127.0.0.1:3581",
            "ARTVENN_CURATION_ROOT": str(self.registry.root), "ARTVENN_CURATION_UI_PORT": "3580"})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        super().tearDown()

    def request(self, path, authenticated=True, host="127.0.0.1:3581", method="get"):
        request = getattr(self.factory, method)(path, HTTP_HOST=host, REMOTE_ADDR="127.0.0.1")
        request.user = SimpleNamespace(is_authenticated=authenticated)
        return request

    def test_context_anonymous_host_and_post_rejected(self):
        for request in (self.request("/curation/context?task=8&project=1", False),
                        self.request("/curation/context?task=8&project=1", host="evil.invalid"),
                        self.request("/curation/context?task=8&project=1", method="post")):
            self.assertEqual(self.middleware(request).status_code, 403)

    def test_native_html_only_gets_same_origin_companion(self):
        response = self.middleware(self.request("/projects/1/data/"))
        self.assertIn(b'<script defer src="/curation/companion.js">', response.content)
        self.assertIn(b"Native unchanged", response.content)
        self.assertEqual(self.middleware(self.request("/projects/1/data/", False)).content, b"<html><body>Native unchanged</body></html>")
        self.assertEqual(self.middleware(self.request("/user/login/")).content, b"<html><body>Native unchanged</body></html>")

    def test_focused_history_is_empty_before_any_native_view_or_model_read(self):
        from unittest.mock import Mock
        from companion import ObjectCompanionMiddleware
        native=Mock(side_effect=AssertionError('native history queried'))
        middleware=ObjectCompanionMiddleware(native)
        request=self.request('/api/projects/1/label-stream-history/')
        request.COOKIES['artvenn_review_focus']='1:8:s'
        with patch('django.apps.apps.get_model',side_effect=AssertionError('history model queried')):
            response=middleware(request)
        self.assertEqual(response.status_code,200)
        self.assertEqual(json.loads(response.content),[])
        self.assertEqual(response['Cache-Control'],'no-store')
        native.assert_not_called()
        request=self.request('/api/projects/2/label-stream-history/')
        request.COOKIES['artvenn_review_focus']='1:8:s'
        self.assertEqual(middleware(request).status_code,403)
        native.assert_not_called()

    def test_unknown_static_path_refuses_traversal(self):
        self.assertEqual(self.middleware(self.request("/curation/../registry.py")).status_code, 404)

    def test_project_permission_required_then_matching_frozen_context(self):
        self.native_task()
        project = SimpleNamespace(objects=SimpleNamespace(for_user=lambda user: SimpleNamespace(filter=lambda **kw: SimpleNamespace(exists=lambda: False))))
        with patch("django.apps.apps.get_model", return_value=project):
            self.assertEqual(self.middleware(self.request("/curation/context?task=8&project=1")).status_code, 403)
        project.objects.for_user = lambda user: SimpleNamespace(filter=lambda **kw: SimpleNamespace(exists=lambda: True))
        data=json.loads((self.registry.root / "state/synthetic-review-task.json").read_text())["data"]
        task_model=SimpleNamespace(objects=SimpleNamespace(filter=lambda **kw: SimpleNamespace(values_list=lambda *a,**k: SimpleNamespace(first=lambda:data))))
        with patch("django.apps.apps.get_model", side_effect=lambda app,name: project if app=="projects" else task_model):
            response = self.middleware(self.request("/curation/context?task=8&project=1"))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(json.loads(response.content)["current"]["code"], "AV-0001")
            self.assertEqual(self.middleware(self.request("/curation/context?task=8&project=2")).status_code, 404)


if __name__ == "__main__":
    unittest.main()
