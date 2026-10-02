"""Capture metadata exercises generated assets in private temporary databases."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

import capture_session
from identity import occurrences
from registry import Registry, CurationError, digest


class CaptureSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="curation-capture-generated-")
        self.base = Path(self.temp.name)
        self.registry = Registry(self.base / "runtime")
        self.origins = []
        from PIL import Image
        for i, color in enumerate(("red", "blue")):
            source = self.base / str(i)
            source.mkdir()
            Image.new("RGB", (40, 30), color).save(source / "photo.png")
            batch = self.registry.inspect(source, synthetic=True)
            aid = self.registry.rows("SELECT asset_id FROM batch_assets WHERE batch_id=?", (batch,))[0]["asset_id"]
            self.origins.append(occurrences(self.registry, aid)[0]["id"])

    def tearDown(self):
        self.registry.db.close()
        self.temp.cleanup()

    def test_unknown_metadata_is_not_fabricated_and_research_remains_unchanged(self):
        tables = ("sessions", "batches", "assets", "proposals", "decisions", "facts")
        before = {name: self.registry.rows("SELECT * FROM " + name) for name in tables}
        result = capture_session.create(self.registry, {"label": "Undated visit", "captured_at": None, "timezone": None}, {"kind": "manual"}, occurrence_ids=self.origins)
        self.assertIsNone(result["metadata"]["captured_at"])
        self.assertIsNone(result["metadata"]["timezone"])
        self.assertEqual(len(result["associations"]), 2)
        for name in tables:
            self.assertEqual(self.registry.rows("SELECT * FROM " + name), before[name])

    def test_append_only_revisions_multi_event_multi_batch_and_stale_guard(self):
        first = capture_session.create(self.registry, {"label": "Visit"}, {"kind": "manual", "actor": "synthetic tester"}, occurrence_ids=self.origins[:1])
        second = capture_session.save(self.registry, first["id"], {"label": "Visit corrected", "captured_at": "2026-09-30"}, {"kind": "manual"}, expected_revision=1, occurrence_ids=self.origins)
        self.assertEqual(second["revision"], 2)
        self.assertEqual(second["revisions"][0]["metadata"], {"label": "Visit"})
        self.assertEqual(len(second["associations"]), 2)
        self.assertEqual(len({x["batch_id"] for x in second["associations"]}), 2)
        other = capture_session.create(self.registry, {"label": "Separate explicit event"}, {"kind": "manual"}, occurrence_ids=self.origins[:1])
        self.assertNotEqual(first["id"], other["id"])
        before = digest(self.registry.export()["tables"])
        with self.assertRaisesRegex(CurationError, "CAPTURE_REVISION_STALE"):
            capture_session.save(self.registry, first["id"], {}, {"kind": "unknown"}, expected_revision=1)
        self.assertEqual(digest(self.registry.export()["tables"]), before)
        for table in ("capture_session_revisions", "capture_asset_associations"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute("DELETE FROM " + table)
            self.registry.db.rollback()

    def test_invalid_metadata_or_foreign_occurrence_leaves_no_partial_header(self):
        for metadata, provenance in (({"captured_at": "yesterday"}, {"kind": "manual"}), ({"timezone": "unknown-zone"}, {"kind": "manual"}), ({"reviewed": True}, {"kind": "manual"}), ({}, {"kind": "model-inferred"})):
            with self.assertRaises(CurationError):
                capture_session.create(self.registry, metadata, provenance)
        with self.assertRaisesRegex(CurationError, "CAPTURE_OCCURRENCE_UNKNOWN"):
            capture_session.create(self.registry, occurrence_ids=["foreign"])
        self.assertEqual(self.registry.rows("SELECT * FROM capture_sessions"), [])
        self.assertEqual(self.registry.rows("SELECT * FROM capture_session_revisions"), [])


if __name__ == "__main__":
    unittest.main()
