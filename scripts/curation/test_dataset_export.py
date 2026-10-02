"""Synthetic SQLite-only exporter tests; no retained runtime or native service."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import dataset_export as dataset


DDL = """
CREATE TABLE schema_version(version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES(1),(2);
CREATE TABLE sessions(id TEXT PRIMARY KEY,source_root TEXT,synthetic INTEGER);
CREATE TABLE batches(id TEXT PRIMARY KEY,session_id TEXT,status TEXT,error TEXT,created REAL);
CREATE TABLE assets(id TEXT PRIMARY KEY,batch_id TEXT,relative_path TEXT,filename TEXT,sha256 TEXT,preview TEXT,capture TEXT,status TEXT,error TEXT);
CREATE TABLE batch_assets(batch_id TEXT,asset_id TEXT);
CREATE TABLE objects(id TEXT PRIMARY KEY,batch_id TEXT,candidate_key TEXT);
CREATE TABLE object_presentation(number INTEGER PRIMARY KEY,object_id TEXT,working_name TEXT);
CREATE TABLE proposals(id TEXT PRIMARY KEY,batch_id TEXT,subject TEXT,kind TEXT,field TEXT,value TEXT,evidence TEXT,input_hash TEXT,model_revision TEXT,prompt_version TEXT,created REAL,version INTEGER);
CREATE TABLE tasks(task_key TEXT PRIMARY KEY,task_id INTEGER,project INTEGER,kind TEXT,mapping TEXT,version_hash TEXT);
CREATE TABLE decisions(id TEXT PRIMARY KEY,proposal_id TEXT,task_key TEXT,annotation_id INTEGER,annotation_hash TEXT,status TEXT,value TEXT,reviewer TEXT,created REAL);
CREATE TABLE object_assets(object_id TEXT,asset_id TEXT,role TEXT,decision_id TEXT);
CREATE TABLE facts(object_id TEXT,field TEXT,value TEXT,decision_id TEXT);
CREATE TABLE relationships(proposal_id TEXT,value TEXT,decision_id TEXT);
CREATE TABLE bindings(instance TEXT,local_id TEXT,kind TEXT,server_id TEXT);
"""
IDENTITY_DDL = """
CREATE TABLE logical_assets(id TEXT PRIMARY KEY,sha256 TEXT UNIQUE);
CREATE TABLE asset_aliases(asset_id TEXT PRIMARY KEY,logical_asset_id TEXT);
CREATE TABLE asset_occurrences(id TEXT PRIMARY KEY,logical_asset_id TEXT,source_asset_id TEXT,batch_id TEXT,session_id TEXT,relative_path TEXT,sha256 TEXT,synthetic INTEGER,created REAL);
CREATE TABLE object_alias_events(id TEXT PRIMARY KEY,object_id TEXT,target_object_id TEXT,decision_id TEXT,revision INTEGER,scope_hash TEXT,created REAL);
CREATE TABLE capture_sessions(id TEXT PRIMARY KEY,created REAL);
CREATE TABLE capture_session_revisions(id TEXT PRIMARY KEY,capture_session_id TEXT,revision INTEGER,metadata TEXT,provenance TEXT,created REAL);
CREATE TABLE capture_asset_associations(id TEXT PRIMARY KEY,capture_session_id TEXT,occurrence_id TEXT,revision_id TEXT,created REAL);
INSERT INTO schema_version VALUES(3),(4);
"""


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="artvenn-dataset-synthetic-")
        self.root = Path(self.temp.name)
        self.database = self.root / "synthetic.sqlite"
        self.output = self.root / "datasets"
        self.db = sqlite3.connect(self.database)
        self.db.executescript(DDL)
        for index, suffix in enumerate(("a", "b", "c"), 1):
            self.db.execute("INSERT INTO sessions VALUES(?,?,?)", ("session-" + suffix, "/synthetic/private/source-" + suffix, 1))
            self.db.execute("INSERT INTO batches VALUES(?,?,?,NULL,?)", ("batch-" + suffix, "session-" + suffix, "inspected", index))
            self.db.execute("INSERT INTO assets VALUES(?,?,?,?,?,?,?,? ,NULL)",
                ("asset-" + suffix, "batch-" + suffix, "PRIVATE_SOURCE_" + suffix, "PRIVATE_FILENAME_" + suffix,
                 str(index) * 64, "/private/preview/" + suffix, None, "ready"))
            self.db.execute("INSERT INTO batch_assets VALUES(?,?)", ("batch-" + suffix, "asset-" + suffix))
        for index, (oid, batch) in enumerate((("target", "a"), ("donor", "b"), ("unselected", "c")), 1):
            self.db.execute("INSERT INTO objects VALUES(?,?,?)", (oid, "batch-" + batch, "candidate-" + oid))
            self.db.execute("INSERT INTO object_presentation VALUES(?,?,?)", (index, oid, "PRIVATE_WORKING_NAME"))
        self.proposal("group-a", "target", "group", None, ["asset-a"], ["asset-a"])
        self.decision("group-a", "accepted", [{"asset_id": "asset-a", "membership": "keep", "role": "overview"}])
        self.db.execute("INSERT INTO object_assets VALUES('target','asset-a','overview','decision-group-a')")
        self.proposal("group-b", "donor", "group", None, ["asset-b"], ["asset-b"], batch="batch-b")
        self.decision("group-b", "corrected", [{"asset_id": "asset-b", "membership": "reassign", "target": "target", "role": "detail"}])
        self.db.execute("INSERT INTO object_assets VALUES('target','asset-b','detail','decision-group-b')")
        self.proposal("title-old", "target", "field", "title", "Title before", ["asset-a"])
        self.decision("title-old", "accepted", "Title before")
        self.proposal("title-new", "target", "field", "title", "Candidate title", ["asset-a"], version=2)
        self.decision("title-new", "corrected", "Title now")
        self.db.execute("INSERT INTO facts VALUES('target','title',?,'decision-title-new')", (json.dumps("Title now"),))
        self.proposal("persons-no", "target", "field", "persons", "Rejected person", ["asset-a"])
        self.decision("persons-no", "rejected", None)
        self.proposal("date-later", "target", "field", "period_original", "Uncertain date", ["asset-b"])
        self.decision("date-later", "deferred", None)
        self.proposal("pending", "target", "field", "object_form", "Pending candidate", ["asset-a"])
        self.proposal("unrelated", "unselected", "field", "title", "UNSELECTED_CONTENT", ["asset-c"], batch="batch-c")
        self.proposal("donor-unrelated", "donor", "field", "title", "UNRELATED_DONOR_CONTENT", ["asset-b"], batch="batch-b")
        self.db.execute("INSERT INTO bindings VALUES('development','target','catalog','catalog-target')")
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def proposal(self, pid, subject, kind, field, value, evidence, batch="batch-a", version=1):
        self.db.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
            pid, batch, subject, kind, field, json.dumps(value), json.dumps(evidence), "a" * 64,
            "synthetic-model-pin", "synthetic-prompt/v1", 1.0, version))

    def decision(self, pid, state, value):
        number = self.db.execute("SELECT count(*) FROM tasks").fetchone()[0] + 1
        kind = self.db.execute("SELECT kind FROM proposals WHERE id=?", (pid,)).fetchone()[0]
        self.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?)", ("task-" + pid, number, 1, kind,
            json.dumps({"UNEXPORTED_NATIVE_CONFIG": "SYNTHETIC_TEST_ONLY"}), "b" * 64))
        self.db.execute("INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)", (
            "decision-" + pid, pid, "task-" + pid, number, "c" * 64, state,
            json.dumps(value), "synthetic-native-reviewer", 2.0))

    def export(self):
        self.db.commit()
        return dataset.export_dataset(self.database, ["target"], self.output)

    def rows(self, result, name):
        return [json.loads(line) for line in (Path(result["path"]) / (name + ".jsonl")).read_text().splitlines()]

    def identity(self):
        self.db.executescript(IDENTITY_DDL)
        for suffix in ("a", "b", "c"):
            digest = str(ord(suffix) - ord("a") + 1) * 64
            self.db.execute("INSERT INTO logical_assets VALUES(?,?)", ("asset-" + suffix, digest))
            self.db.execute("INSERT INTO asset_aliases VALUES(?,?)", ("asset-" + suffix, "asset-" + suffix))
            self.db.execute("INSERT INTO asset_occurrences VALUES(?,?,?,?,?,?,?,?,?)", (
                "occurrence-" + suffix, "asset-" + suffix, "asset-" + suffix, "batch-" + suffix,
                "session-" + suffix, "PRIVATE_OCCURRENCE_PATH", digest, 1, 3.0))

    def test_legacy_snapshot_scope_history_and_current_projection(self):
        result = self.export()
        self.assertEqual({r["id"] for r in self.rows(result, "objects")}, {"target", "donor"})
        self.assertEqual(next(r["scope"] for r in self.rows(result, "objects") if r["id"] == "donor"), "provenance_reference")
        self.assertEqual([r["value"] for r in self.rows(result, "current_facts")], ["Title now"])
        decisions = self.rows(result, "review_decisions")
        self.assertEqual({r["status"] for r in decisions}, {"accepted", "corrected", "rejected", "deferred"})
        self.assertIn("Title before", [r["value"] for r in decisions])
        self.assertEqual({r["asset_id"] for r in self.rows(result, "current_memberships")}, {"asset-a", "asset-b"})
        self.assertIn("pending", {r["id"] for r in self.rows(result, "proposals")})
        self.assertEqual(self.rows(result, "logical_assets"), [])

    def test_no_source_paths_media_native_payload_or_unselected_content(self):
        result = self.export()
        combined = b"".join(p.read_bytes() for p in Path(result["path"]).iterdir())
        for forbidden in (b"/synthetic/private", b"PRIVATE_SOURCE", b"PRIVATE_FILENAME", b"/private/preview", b"PRIVATE_WORKING_NAME", b"UNEXPORTED_NATIVE_CONFIG", b"UNSELECTED_CONTENT", b"UNRELATED_DONOR_CONTENT"):
            self.assertNotIn(forbidden, combined)

    def test_database_bytes_unchanged_and_no_registry_import(self):
        before = self.database.read_bytes()
        self.export()
        self.assertEqual(self.database.read_bytes(), before)
        self.assertNotIn("from registry import", Path(dataset.__file__).read_text())

    def test_deterministic_identity_checksums_and_creation_outside_identity(self):
        first = self.export()
        before = {p.name: p.read_bytes() for p in Path(first["path"]).iterdir()}
        with patch.object(dataset.time, "time", return_value=999999.0):
            second = self.export()
        self.assertTrue(second["reused"])
        self.assertEqual(first["datasetId"], second["datasetId"])
        self.assertEqual(before, {p.name: p.read_bytes() for p in Path(second["path"]).iterdir()})
        for line in before["checksums.sha256"].decode().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256(before[name]).hexdigest())
        manifest = json.loads(before["manifest.json"])
        self.assertNotIn("created_at", manifest)

    def test_new_decision_makes_new_dataset_without_overwriting_old(self):
        first = self.export()
        self.proposal("new-version", "target", "field", "title", "Next title", ["asset-a"], version=3)
        self.decision("new-version", "corrected", "Next title")
        self.db.execute("UPDATE facts SET value=?,decision_id='decision-new-version'", (json.dumps("Next title"),))
        second = self.export()
        self.assertNotEqual(first["datasetId"], second["datasetId"])
        self.assertEqual(self.rows(first, "current_facts")[0]["value"], "Title now")

    def test_tampered_output_refuses_overwrite(self):
        first = self.export()
        target = Path(first["path"]) / "current_facts.jsonl"
        self.assertEqual(target.stat().st_mode & 0o777, 0o400)
        target.chmod(0o600)
        target.write_text("tampered")
        with self.assertRaisesRegex(dataset.DatasetError, "EXISTING_OUTPUT_INVALID"):
            self.export()
        self.assertEqual(target.read_text(), "tampered")

    def test_interrupted_export_never_presents_partial_dataset(self):
        real_write = dataset._write
        def interrupt(directory, name, content):
            real_write(directory, name, content)
            if name == "assets.jsonl":
                raise OSError("synthetic interrupted write")
        with patch.object(dataset, "_write", side_effect=interrupt):
            with self.assertRaises(OSError):
                self.export()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertFalse(self.export()["reused"])

    def test_missing_reference_fails_before_creating_output(self):
        self.db.execute("DELETE FROM assets WHERE id='asset-b'")
        with self.assertRaisesRegex(dataset.DatasetError, "REFERENCE_MISSING"):
            self.export()
        self.assertFalse(self.output.exists())

    def test_rejected_decision_cannot_be_current_fact(self):
        self.db.execute("INSERT INTO facts VALUES('target','persons',?,'decision-persons-no')", (json.dumps("Rejected person"),))
        with self.assertRaisesRegex(dataset.DatasetError, "UNREVIEWED_CURRENT_PROJECTION"):
            self.export()

    def test_mismatched_current_fact_is_not_exported_as_truth(self):
        self.db.execute("UPDATE facts SET value=?", (json.dumps("unsupported change"),))
        with self.assertRaisesRegex(dataset.DatasetError, "CURRENT_FACT_MISMATCH"):
            self.export()

    def test_row_limit_and_explicit_selection(self):
        for values in (None, "target", [], ["target", "target"], ["missing"], ["../escape"]):
            with self.assertRaises(dataset.DatasetError):
                dataset.export_dataset(self.database, values, self.output)
        with self.assertRaisesRegex(dataset.DatasetError, "ROW_LIMIT_EXCEEDED"):
            dataset.export_dataset(self.database, ["target"], self.output, max_rows=2)

    def test_consistent_snapshot_excludes_mid_read_decision(self):
        self.db.execute("PRAGMA journal_mode=WAL")
        original = dataset._selected_history
        def change_after_snapshot(snapshot, selection):
            self.proposal("concurrent", "target", "field", "title", "Concurrent title", ["asset-a"], version=3)
            self.decision("concurrent", "accepted", "Concurrent title")
            self.db.execute("UPDATE facts SET value=?,decision_id='decision-concurrent'", (json.dumps("Concurrent title"),))
            self.db.commit()
            return original(snapshot, selection)
        with patch.object(dataset, "_selected_history", side_effect=change_after_snapshot):
            first = self.export()
        second = self.export()
        self.assertEqual(self.rows(first, "current_facts")[0]["value"], "Title now")
        self.assertEqual(self.rows(second, "current_facts")[0]["value"], "Concurrent title")
        self.assertNotEqual(first["datasetId"], second["datasetId"])

    def test_identity_conflicts_and_capture_revision_history(self):
        self.identity()
        self.decision("donor-unrelated", "accepted", "Conflicting donor title")
        self.db.execute("INSERT INTO facts VALUES('donor','title',?,'decision-donor-unrelated')", (json.dumps("Conflicting donor title"),))
        self.db.execute("INSERT INTO object_alias_events VALUES('alias','donor','target','decision-group-b',1,?,4)", ("d" * 64,))
        self.db.execute("INSERT INTO bindings VALUES('development','donor','catalog','catalog-donor')")
        self.db.execute("INSERT INTO capture_sessions VALUES('capture',3)")
        for revision in (1, 2):
            self.db.execute("INSERT INTO capture_session_revisions VALUES(?,?,?,?,?,?)", (
                "capture-rev-" + str(revision), "capture", revision,
                json.dumps({"label": "Generated visit", "timezone": None, "captured_at": None}),
                json.dumps({"kind": "manual", "actor": "synthetic-reviewer", "source": "/private/capture/source"}), revision + 3))
        self.db.execute("INSERT INTO capture_asset_associations VALUES('association','capture','occurrence-a','capture-rev-1',5)")
        self.db.execute("UPDATE sessions SET synthetic=0 WHERE id='session-a'")
        result = self.export()
        self.assertEqual(len(self.rows(result, "current_facts")), 2)
        self.assertEqual({r["server_id"] for r in self.rows(result, "bindings")}, {"catalog-target", "catalog-donor"})
        self.assertEqual(len(self.rows(result, "capture_session_revisions")), 2)
        occurrence = next(r for r in self.rows(result, "asset_occurrences") if r["id"] == "occurrence-a")
        self.assertEqual(occurrence["synthetic"], 1)
        self.assertFalse(occurrence["effective_synthetic"])
        for row in self.rows(result, "capture_session_revisions"):
            self.assertNotIn("source", row["provenance"])
            self.assertIn("source_reference_sha256", row["provenance"])
        self.assertNotIn(b"PRIVATE_OCCURRENCE_PATH", (Path(result["path"]) / "asset_occurrences.jsonl").read_bytes())

    def test_nested_unapproved_metadata_rejected_by_schema(self):
        self.db.execute("UPDATE decisions SET value=? WHERE id='decision-group-b'", (json.dumps([{
            "asset_id": "asset-b", "membership": "reassign", "target": "target", "role": "detail", "unexpected_config": "SYNTHETIC_TEST_ONLY"}]),))
        with self.assertRaisesRegex(dataset.DatasetError, "SCHEMA_INVALID"):
            self.export()
        self.assertFalse(self.output.exists())

    def test_read_only_connection_refuses_writes(self):
        original = dataset._collect
        def inspect_connection(snapshot, selection):
            with self.assertRaises(sqlite3.OperationalError):
                snapshot.db.execute("DELETE FROM facts")
            return original(snapshot, selection)
        with patch.object(dataset, "_collect", side_effect=inspect_connection):
            self.export()
        self.assertEqual(self.db.execute("SELECT count(*) FROM facts").fetchone()[0], 1)

    def test_issue_hypotheses_keep_scoped_evidence_without_becoming_facts(self):
        self.proposal("issue-selected", "batch-a", "issue", "uncertain", "Inspect source", ["asset-a"])
        self.proposal("issue-unrelated", "batch-c", "issue", "uncertain", "UNSELECTED_ISSUE", ["asset-c"], batch="batch-c")
        result = self.export()
        self.assertIn("issue-selected", {r["id"] for r in self.rows(result, "proposals")})
        self.assertNotIn("issue-unrelated", {r["id"] for r in self.rows(result, "proposals")})
        self.assertEqual(len(self.rows(result, "current_facts")), 1)

    def test_same_logical_asset_retains_other_source_occurrence_without_paths(self):
        self.identity()
        self.db.execute("INSERT INTO assets VALUES('asset-copy','batch-c','PRIVATE_COPY','PRIVATE_COPY',?,NULL,NULL,'ready',NULL)", ("1" * 64,))
        self.db.execute("INSERT INTO batch_assets VALUES('batch-c','asset-copy')")
        self.db.execute("INSERT INTO asset_aliases VALUES('asset-copy','asset-a')")
        self.db.execute("INSERT INTO asset_occurrences VALUES('occurrence-copy','asset-a','asset-copy','batch-c','session-c','PRIVATE_COPY',?,1,6)", ("1" * 64,))
        result = self.export()
        self.assertIn("asset-copy", {r["id"] for r in self.rows(result, "assets")})
        self.assertNotIn("asset-c", {r["id"] for r in self.rows(result, "assets")})
        self.assertIn("occurrence-copy", {r["id"] for r in self.rows(result, "asset_occurrences")})
        self.assertNotIn("unselected", {r["id"] for r in self.rows(result, "objects")})

    def test_identity_hash_conflict_fails_closed(self):
        self.identity()
        self.db.execute("UPDATE logical_assets SET sha256=? WHERE id='asset-a'", ("f" * 64,))
        with self.assertRaisesRegex(dataset.DatasetError, "IDENTITY_HASH_MISMATCH"):
            self.export()

    def test_legacy_human_split_derived_target_resolves(self):
        row = {"batch_id": "batch-b", "subject": "donor"}
        item = {"asset_id": "asset-b", "membership": "split", "role": "detail", "split_label": "generated-split"}
        target = dataset._split_target(row, item)
        self.db.execute("INSERT INTO objects VALUES(?,?,?)", (target, "batch-b", "human-split"))
        self.db.execute("INSERT INTO object_presentation VALUES(4,?,'')", (target,))
        self.db.execute("UPDATE decisions SET value=? WHERE id='decision-group-b'", (json.dumps([item]),))
        self.db.execute("UPDATE object_assets SET object_id=? WHERE asset_id='asset-b'", (target,))
        self.db.commit()
        result = dataset.export_dataset(self.database, [target], self.output)
        self.assertEqual(self.rows(result, "current_memberships")[0]["object_id"], target)
        self.assertIn("donor", {r["id"] for r in self.rows(result, "objects")})

    def test_export_lock_is_not_removed_or_reused_by_another_writer(self):
        first = self.export()
        other_output = self.root / "other-datasets"
        other_output.mkdir(mode=0o700)
        lock = other_output / ("." + first["datasetId"] + ".lock")
        lock.mkdir(mode=0o700)
        with self.assertRaisesRegex(dataset.DatasetError, "EXPORT_IN_PROGRESS"):
            dataset.export_dataset(self.database, ["target"], other_output)
        self.assertTrue(lock.exists())

    def test_relationship_current_projection_uses_only_latest_decided_version(self):
        for version, relation in ((1, "same_physical_object"), (2, "unrelated")):
            pid = "relation-" + str(version)
            self.proposal(pid, "target", "relationship", "donor", relation, ["asset-a", "asset-b"], version=version)
            self.decision(pid, "accepted", relation)
            self.db.execute("INSERT INTO relationships VALUES(?,?,?)", (pid, json.dumps(relation), "decision-" + pid))
        result = self.export()
        self.assertEqual([r["proposal_id"] for r in self.rows(result, "current_relationships")], ["relation-2"])
        self.assertTrue({"relation-1", "relation-2"} <= {r["proposal_id"] for r in self.rows(result, "review_decisions")})
        for version, state in ((3, "pending"), (4, "rejected"), (5, "deferred")):
            pid = "relation-" + str(version)
            self.proposal(pid, "target", "relationship", "donor", "uncertain", ["asset-a"], version=version)
            if state != "pending":
                self.decision(pid, state, None)
            latest = self.export()
            self.assertEqual(self.rows(latest, "current_relationships"), [], state)
            self.assertTrue({"relation-1", "relation-2"} <= {r["proposal_id"] for r in self.rows(latest, "review_decisions")})
        self.assertEqual([r["value"] for r in self.rows(result, "current_relationships")], ["unrelated"])

    def test_donor_media_bindings_cannot_expand_or_dangle_outside_asset_closure(self):
        for aid in ("asset-b", "asset-c", "missing-asset"):
            self.db.execute("INSERT INTO bindings VALUES('development',?,'media',?)",
                ("donor:" + aid + ":" + "3" * 64, "media-" + aid))
        self.db.execute("INSERT INTO bindings VALUES('development','donor','source','source-donor')")
        result = self.export()
        bindings = self.rows(result, "bindings")
        self.assertEqual({r["server_id"] for r in bindings}, {"catalog-target", "source-donor", "media-asset-b"})
        self.assertEqual({r["id"] for r in self.rows(result, "assets")}, {"asset-a", "asset-b"})


if __name__ == "__main__":
    unittest.main()
