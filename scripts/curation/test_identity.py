"""Generated-byte and synthetic r4 migration regressions; never a live runtime."""
import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from identity import (asset_synthetic, canonical_asset, occurrences, original_path,
                      record_object_alias, resolve_object, object_conflicts)
from registry import Registry, CurationError, canonical, digest


class StableIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="curation-identity-generated-")
        self.base = Path(self.temp.name)
        self.registry = Registry(self.base / "runtime")
        self.source = self.base / "first"
        self.source.mkdir()
        from PIL import Image
        Image.new("RGB", (60, 40), "blue").save(self.source / "one.png")
        Image.new("RGB", (60, 40), "green").save(self.source / "two.png")
        self.batch = self.registry.inspect(self.source, synthetic=True)
        self.aids = [r["id"] for r in self.registry.rows("SELECT id FROM assets ORDER BY relative_path")]

    def tearDown(self):
        self.registry.db.close()
        self.temp.cleanup()

    def objects(self):
        with self.registry.db:
            for oid in ("source-object", "target-object", "other-object"):
                self.registry.db.execute("INSERT INTO objects VALUES(?,?,?)", (oid, self.batch, oid))

    def reviewed_reassignment(self, source="source-object", target="target-object", aids=None):
        aids = aids or self.aids
        with self.registry.db:
            pid = self.registry.propose(self.batch, source, "group", None, aids, aids, "a" * 64, "human-entry/v1", "test")
            key = "review-" + pid
            mapping = {"subject_id": source, "proposal_ids": [pid], "asset_order": aids}
            self.registry.db.execute("INSERT INTO tasks VALUES(?,?,1,'group',?,'frozen')", (key, len(self.registry.rows("SELECT * FROM tasks")) + 1, canonical(mapping)))
        value = [{"asset_id": aid, "membership": "reassign", "target": target, "role": "detail"} for aid in aids]
        self.registry.decision({"task_key": key}, {"id": 1, "completed_by": 42}, pid, "corrected", value, "test-reviewer:label-studio-user:42")
        return self.registry.db.execute("SELECT id FROM decisions WHERE proposal_id=?", (pid,)).fetchone()[0]

    def test_content_reused_across_paths_but_occurrences_and_objects_are_distinct(self):
        copied = self.base / "second"
        copied.mkdir()
        shutil.copyfile(self.source / "one.png", copied / "renamed.png")
        newer = self.registry.inspect(copied, synthetic=False)
        self.assertNotEqual(newer, self.batch)
        self.assertEqual(len(self.registry.rows("SELECT * FROM assets")), 2)
        self.assertEqual(self.registry.rows("SELECT asset_id FROM batch_assets WHERE batch_id=?", (newer,)), [{"asset_id": self.aids[0]}])
        origins = occurrences(self.registry, self.aids[0])
        self.assertEqual(len(origins), 2)
        self.assertEqual({o["synthetic"] for o in origins}, {True, False})
        self.assertFalse(asset_synthetic(self.registry, self.aids[0]))
        self.assertEqual(canonical_asset(self.registry, self.aids[0]), self.aids[0])
        self.assertEqual(self.registry.inspect(copied), newer)
        self.assertEqual(len(occurrences(self.registry, self.aids[0])), 2)
        self.objects()
        self.assertEqual(resolve_object(self.registry, "source-object"), "source-object")
        self.assertEqual(self.registry.rows("SELECT * FROM object_alias_events"), [])

    def test_selected_delta_does_not_rescan_existing_or_remove_ordinary_guard(self):
        self.objects()
        from PIL import Image
        Image.new("RGB", (70, 40), "orange").save(self.source / "new.png")
        with self.assertRaisesRegex(CurationError, "ANALYZED_FOLDER_CONTENTS_CHANGED"):
            self.registry.inspect(self.source)
        added = self.registry.inspect(self.source, incremental=True, selected_paths=["new.png"])
        self.assertEqual(self.registry.source_verify(added), 1)
        self.assertEqual(len(self.registry.rows("SELECT * FROM batch_assets WHERE batch_id=?", (added,))), 1)
        self.assertEqual(self.registry.inspect(self.source, incremental=True, selected_paths=["new.png"]), added)
        for paths in ([], ["../first/one.png"], [str(self.source / "one.png")], ["one.png", "./one.png"]):
            with self.assertRaises(CurationError):
                self.registry.inspect(self.source, incremental=True, selected_paths=paths)

    def test_changed_same_named_bytes_are_new_asset_and_source_is_verified(self):
        old = self.aids[0]
        from PIL import Image
        Image.new("RGB", (60, 40), "red").save(self.source / "one.png")
        newer = self.registry.inspect(self.source, incremental=True, selected_paths=["one.png"])
        current = self.registry.rows("SELECT asset_id FROM batch_assets WHERE batch_id=?", (newer,))[0]["asset_id"]
        self.assertNotEqual(current, old)
        with self.assertRaisesRegex(CurationError, "SOURCE_HASH_CHANGED"):
            original_path(self.registry, old)
        self.assertEqual(original_path(self.registry, current), self.source / "one.png")
        (self.source / "one.png").unlink()
        with self.assertRaisesRegex(CurationError, "SOURCE_UNAVAILABLE"):
            original_path(self.registry, current)

    def test_reselection_cannot_promote_an_origin_to_synthetic(self):
        self.registry.inspect(self.source, synthetic=False)
        self.registry.inspect(self.source, synthetic=True)
        self.assertFalse(asset_synthetic(self.registry, self.aids[0]))

    def test_explicit_whole_group_alias_preserves_every_review_and_code(self):
        self.objects()
        did = self.reviewed_reassignment()
        before = {n: self.registry.rows("SELECT * FROM " + n) for n in ("objects", "object_presentation", "assets", "tasks", "proposals", "decisions", "bindings", "facts")}
        self.assertEqual(resolve_object(self.registry, "source-object"), "source-object")
        with self.assertRaisesRegex(CurationError, "WHOLE_OBJECT_CONFIRMATION"):
            record_object_alias(self.registry, "source-object", "target-object", did)
        event = record_object_alias(self.registry, "source-object", "target-object", did, whole_object_confirmed=True)
        self.assertEqual(resolve_object(self.registry, "source-object"), "target-object")
        self.assertEqual(record_object_alias(self.registry, "source-object", "target-object", did, whole_object_confirmed=True), event)
        for name, rows in before.items():
            self.assertEqual(self.registry.rows("SELECT * FROM " + name), rows)
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute("DELETE FROM object_alias_events")
        self.registry.db.rollback()
        with self.assertRaisesRegex(CurationError, "OBJECT_ALIAS_CYCLE"):
            record_object_alias(self.registry, "target-object", "source-object", did, whole_object_confirmed=True)

    def test_partial_and_stale_review_cannot_become_an_alias(self):
        self.objects()
        with self.registry.db:
            self.registry.db.execute("INSERT INTO object_assets VALUES(?,?,'overview',NULL)", ("source-object", self.aids[1]))
        did = self.reviewed_reassignment(aids=self.aids[:1])
        with self.assertRaisesRegex(CurationError, "WHOLE_OBJECT_REVIEW_REQUIRED"):
            record_object_alias(self.registry, "source-object", "target-object", did, whole_object_confirmed=True)
        with self.registry.db:
            self.registry.propose(self.batch, "source-object", "group", None, self.aids, self.aids, "b" * 64, "human-entry/v1", "new")
        with self.assertRaisesRegex(CurationError, "OBJECT_ALIAS_SCOPE_STALE"):
            record_object_alias(self.registry, "source-object", "target-object", did, whole_object_confirmed=True)

    def test_fact_and_binding_conflicts_refuse_silent_consolidation(self):
        self.objects()
        did = self.reviewed_reassignment()
        with self.registry.db:
            self.registry.db.execute("INSERT INTO bindings VALUES('development','source-object','catalog','catalog-a')")
            self.registry.db.execute("INSERT INTO bindings VALUES('development','target-object','catalog','catalog-b')")
            self.registry.db.execute("INSERT INTO facts VALUES('source-object','title','\"one\"',?)", (did,))
            self.registry.db.execute("INSERT INTO facts VALUES('target-object','title','\"two\"',?)", (did,))
        conflicts = object_conflicts(self.registry, "source-object", "target-object")
        self.assertEqual(len(conflicts["bindings"]), 1)
        self.assertEqual(len(conflicts["facts"]), 1)
        with self.assertRaisesRegex(CurationError, "BINDING_CONFLICT"):
            record_object_alias(self.registry, "source-object", "target-object", did, whole_object_confirmed=True)
        self.assertEqual(self.registry.rows("SELECT * FROM object_alias_events"), [])

    def test_alias_chain_retains_prior_member_binding_conflict(self):
        self.objects()
        did = self.reviewed_reassignment()
        record_object_alias(self.registry, "source-object", "target-object", did, whole_object_confirmed=True)
        with self.registry.db:
            self.registry.db.execute("INSERT INTO bindings VALUES('development','source-object','catalog','catalog-a')")
            self.registry.db.execute("INSERT INTO bindings VALUES('development','other-object','catalog','catalog-b')")
        next_did = self.reviewed_reassignment("target-object", "other-object")
        with self.assertRaisesRegex(CurationError, "BINDING_CONFLICT"):
            record_object_alias(self.registry, "target-object", "other-object", next_did, whole_object_confirmed=True)
        self.assertEqual(resolve_object(self.registry, "source-object"), "target-object")

    def test_r4_additive_migration_retains_duplicate_legacy_rows_and_history(self):
        self.objects()
        self.reviewed_reassignment()
        with self.registry.db:
            self.registry.db.execute("""INSERT INTO assets SELECT 'legacy-copy',batch_id,'copy.png','copy.png',sha256,preview,capture,status,error
                FROM assets WHERE id=?""", (self.aids[0],))
            self.registry.db.execute("INSERT INTO batch_assets VALUES(?,'legacy-copy')", (self.batch,))
        names = ("sessions", "batches", "batch_assets", "assets", "objects", "object_presentation", "tasks", "proposals", "decisions", "object_assets", "facts", "bindings")
        before = {name: self.registry.rows("SELECT * FROM " + name) for name in names}
        self.registry.db.execute("PRAGMA foreign_keys=OFF")
        self.registry.db.executescript("DROP TABLE capture_asset_associations; DROP TABLE capture_session_revisions; DROP TABLE capture_sessions; DROP TABLE object_alias_events; DROP TABLE asset_occurrences; DROP TABLE asset_aliases; DROP TABLE logical_assets; DELETE FROM schema_version WHERE version>2;")
        self.registry.db.close()
        marker = self.base / "runtime/state/scale-runtime-v1.json"
        marker.unlink()
        database = self.base / "runtime/state/curation.sqlite"
        before_bytes, before_mtime = database.read_bytes(), database.stat().st_mtime_ns
        with self.assertRaisesRegex(CurationError, "EXPLICIT_SCALE_MIGRATION_REQUIRED"):
            Registry(self.base / "runtime")
        self.assertEqual(database.read_bytes(), before_bytes)
        self.assertEqual(database.stat().st_mtime_ns, before_mtime)
        self.registry = Registry(self.base / "runtime", upgrade_scale=True)
        self.assertEqual(canonical_asset(self.registry, "legacy-copy"), self.aids[0])
        self.assertEqual(len(occurrences(self.registry, "legacy-copy")), 2)
        for name in names:
            self.assertEqual(self.registry.rows("SELECT * FROM " + name), before[name])
        frozen = digest(self.registry.export()["tables"])
        self.registry.db.close()
        self.registry = Registry(self.base / "runtime")
        self.assertEqual(digest(self.registry.export()["tables"]), frozen)
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute("UPDATE decisions SET status='rejected'")


if __name__ == "__main__":
    unittest.main()
