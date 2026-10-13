"""Offline producer tests: real SQL/JSON fixtures, no image or service access."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from metadata_snapshot import (SnapshotError, build_metadata_snapshot,
                               canonical, digest, main, model_run, parse_json,
                               validate_annotation, validate_frame, write_metadata_snapshot, PHOTO_SCHEMA)


class MetadataSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='metadata-snapshot-test-',
                                                dir=Path(__file__).resolve().parents[2])
        self.root = Path(self.temp.name).resolve()
        self.database = self.root / 'fixture.sqlite'
        self.package = self.root / 'publication.json'
        self.review = self.root / 'review.json'
        self.inventory = self.root / 'inventory.json'
        self.model = self.root / 'model.json'
        self.oid, self.other_group = 'object-main', 'object-manual'
        self.aids = ['asset-one', 'asset-two']
        self.outside = 'asset-excluded'
        self.source_hashes = ['1' * 64, '2' * 64]
        self.output_hashes = ['3' * 64, '4' * 64]
        self.media_ids = ['media-one', 'media-two']
        self.frames = [{'version': 'artvenn-original-frame/v1', 'assetId': aid,
                        'sourceSha256': source, 'coordinateSystem': 'original_encoded_pixels_top_left',
                        'width': 1000, 'height': 800, 'exifOrientation': 1, 'orientationApplied': False}
                       for aid, source in zip(self.aids, self.source_hashes)]
        db = sqlite3.connect(self.database)
        db.executescript('''
        CREATE TABLE assets(id TEXT, sha256 TEXT);
        CREATE TABLE proposals(id TEXT,batch_id TEXT,subject TEXT,kind TEXT,field TEXT,value TEXT,
          evidence TEXT,input_hash TEXT,model_revision TEXT,prompt_version TEXT,created REAL,version INTEGER);
        CREATE TABLE decisions(id TEXT,proposal_id TEXT,task_key TEXT,annotation_id INTEGER,
          annotation_hash TEXT,status TEXT,value TEXT,reviewer TEXT,created REAL);
        CREATE TABLE object_assets(object_id TEXT,asset_id TEXT,role TEXT,decision_id TEXT);
        CREATE TABLE object_alias_events(id TEXT,object_id TEXT,target_object_id TEXT,revision INTEGER,decision_id TEXT);
        CREATE TABLE photo_annotation_revisions(id TEXT,context_key TEXT,object_id TEXT,asset_id TEXT,
          logical_asset_id TEXT,source_sha256 TEXT,revision INTEGER,previous_id TEXT,payload TEXT,
          payload_sha256 TEXT,changes TEXT,coordinate_frame TEXT,review_id TEXT,review_revision INTEGER,
          review_draft_sha256 TEXT,membership_sha256 TEXT,confirmation_event TEXT,created REAL);
        CREATE TABLE photo_annotation_decisions(id TEXT,revision_id TEXT,status TEXT,payload_sha256 TEXT,
          confirmation_event TEXT,membership_decision_id TEXT,reviewer TEXT,provenance TEXT,created REAL);
        ''')
        self.review_decisions = []
        for index, aid in enumerate(self.aids):
            group = self.oid if index == 0 else self.other_group
            members = [aid, self.outside] if index == 0 else [aid]
            pid, did = 'proposal-' + str(index), 'decision-' + str(index)
            proposal = {'id': pid, 'batch_id': 'batch-one', 'subject': group, 'kind': 'group',
                        'field': None, 'value': members, 'evidence': members, 'input_hash': '5' * 64,
                        'model_revision': 'model-revision' if index == 0 else 'human-entry/v1',
                        'prompt_version': 'AI/v1' if index == 0 else 'manual-selection-source/v1',
                        'created': 100.0, 'version': 1}
            db.execute('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       tuple(json.dumps(v) if k in {'value', 'evidence'} else v for k, v in proposal.items()))
            value = [{'asset_id': aid, 'membership': 'reassign', 'target': self.oid, 'role': 'detail'}]
            decision = {'id': did, 'proposal_id': pid, 'task_key': 'review-native-' + str(index),
                        'annotation_id': index + 1, 'annotation_hash': '6' * 64, 'status': 'corrected',
                        'value': value, 'reviewer': '7', 'created': 101.0}
            self.review_decisions.append(decision)
            db.execute('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)',
                       tuple(json.dumps(v) if k == 'value' else v for k, v in decision.items()))
            db.execute('INSERT INTO assets VALUES(?,?)', (aid, self.source_hashes[index]))
            db.execute('INSERT INTO object_assets VALUES(?,?,?,?)', (self.oid, aid, 'detail', did))
            payload = {'kind': 'photo', 'schema_version': 'artvenn-photo-annotation/v1',
                       'values': {'representation': 'stone'} if index == 0 else
                       {'representation': 'stone', 'coverage': 'context', 'surfaces': ['unknown'], 'content': ['unknown']}}
            ph = digest(payload); event = '8' * 64
            membership = digest({'links': [[self.oid, aid, 'detail', did, 'corrected', '6' * 64]], 'aliases': []})
            rid = 'annotation-' + str(index)
            db.execute('INSERT INTO photo_annotation_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (rid, digest({'object': self.oid, 'asset': aid}), self.oid, aid, aid,
                        self.source_hashes[index], 1, None, json.dumps(payload), ph, json.dumps(payload['values']),
                        json.dumps(self.frames[index]), 'review-current', 15, '9' * 64, membership, event, 102.0))
            provenance = {'kind': 'explicit_local_confirmation', 'reviewId': 'review-current', 'reviewRevision': 15,
                          'draftSha256': '9' * 64, 'actorSource': 'native_membership_reviewer',
                          'nativeApprovalScope': 'membership_and_legacy_role_only'}
            db.execute('INSERT INTO photo_annotation_decisions VALUES(?,?,?,?,?,?,?,?,?)',
                       ('annotation-decision-' + str(index), rid, 'human_confirmed', ph, event, did, '7', json.dumps(provenance), 102.0))
        db.commit(); db.close()
        media = [{'assetId': aid, 'mediaId': self.media_ids[i], 'sourceSha256': self.source_hashes[i],
                  'uploadedSha256': self.output_hashes[i], 'derivativeVersion': 'publication/v1',
                  'position': i, 'isRepresentative': i == 0} for i, aid in enumerate(self.aids)]
        local = {'photoRoles': {aid: {'role': 'detail', 'decisionId': 'decision-' + str(i),
                                    'originObjectId': self.oid if i == 0 else self.other_group}
                               for i, aid in enumerate(self.aids)},
                 'sourceProcessingLineage': {aid: {'source_sha256': self.source_hashes[i],
                     'output_sha256': self.output_hashes[i], 'recipe': {'version': 'publication/v1'},
                     'output_dimensions': {'width': 20, 'height': 16}} for i, aid in enumerate(self.aids)},
                 'previewProcessingLineage': {}, 'annotationSnapshots': [],
                 'reviewDecisions': self.review_decisions, 'fieldProvenance': [],
                 'facts': {'title': '测试碑刻'}, 'relationships': [],
                 'archiveUploadPlan': {'version': 1, 'displayMedia': [{'assetId': self.aids[0],
                                                   'position': 0, 'isRepresentative': True}]}}
        self.packet = {'version': 1, 'synthetic': False, 'selectionConfirmed': True,
                       'objects': [{'objectId': self.oid, 'catalogId': 'catalog-one', 'sourceId': 'source-one',
                                    'cmsDraft': {'id': 5, 'expectedRevision': 2}, 'media': media, 'localAnnotations': local}]}
        self.live = {'draft': {'id': 5, 'revision': 2, 'fingerprint': 'a' * 64,
                              'content': {'catalogId': 'catalog-one', 'sourceId': 'source-one',
                                          'media': [{'mediaId': self.media_ids[0], 'position': 0,
                                                     'isRepresentative': True}]}},
                     'inventory': {'hasNextPage': False, 'totalDocs': 2,
                                   'docs': [{'id': i + 53, 'mediaId': self.media_ids[i], 'catalogId': 'catalog-one',
                                             'sha256': self.output_hashes[i], 'width': 20, 'height': 16}
                                            for i in range(2)]}}
        self.model_value = {'status': 'partial', 'engine': 'mlx-vlm', 'model_id': 'local-model',
                            'revision': 'model-revision', 'prompt_version': 'AI/v1', 'weights_sha256': 'b' * 64,
                            'cloud': False, 'mock': False, 'human_review_required': True,
                            'error_category': 'segment_failed', 'segments': [
                            {'segment_id': 'segment-1', 'status': 'completed', 'input_images': 2,
                             'proposal': {'groups': [{'key': 'group-1', 'asset_ids': [self.aids[0], self.outside], 'fields': []}],
                                          'roles': [{'asset_id': x, 'role': 'detail', 'evidence': [x]}
                                                    for x in [self.aids[0], self.outside]], 'relationships': [], 'issues': []}},
                            {'segment_id': 'segment-2', 'status': 'failed', 'input_images': 1,
                             'error_category': 'incomplete_role_coverage', 'proposal': None}]}
        self.write(self.package, self.packet)
        self.write(self.review, {'id': 'review-current', 'revision': 15, 'assetIds': self.aids,
                                 'draft': {'targetId': self.oid}})
        self.write(self.inventory, self.live)
        self.write(self.model, self.model_value)

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def write(path, value):
        path.write_bytes(canonical(value))

    def build(self, **options):
        return build_metadata_snapshot(self.database, self.package, self.review,
                                       [self.model], self.inventory, expected_count=2, **options)

    def sql(self, sql, args=()):
        with sqlite3.connect(self.database) as db:
            db.execute(sql, args)

    def add_object_coverage(self):
        payload = {'kind': 'object_coverage', 'schema_version': 'artvenn-photo-annotation/v1',
                   'values': {'front': 'captured', 'back': 'unknown'}}
        checksum = digest(payload)
        provenance = {'kind': 'explicit_local_confirmation', 'reviewId': 'review-current',
                      'reviewRevision': 15, 'draftSha256': '9' * 64,
                      'actorSource': 'native_membership_reviewer',
                      'nativeApprovalScope': 'membership_and_legacy_role_only'}
        with sqlite3.connect(self.database) as db:
            links = [list(row) for row in db.execute(
                'SELECT oa.object_id,oa.asset_id,oa.role,oa.decision_id,d.status,d.annotation_hash '
                'FROM object_assets oa JOIN decisions d ON d.id=oa.decision_id '
                'WHERE oa.object_id=? ORDER BY oa.asset_id', (self.oid,))]
            membership = digest({'links': links, 'aliases': []})
            db.execute('INSERT INTO photo_annotation_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       ('annotation-object-coverage', digest({'object': self.oid, 'asset': None}), self.oid,
                        None, None, None, 1, None, json.dumps(payload), checksum,
                        json.dumps({'front': 'captured'}), None, 'review-current', 15,
                        '9' * 64, membership, '8' * 64, 102.0))
            db.execute('INSERT INTO photo_annotation_decisions VALUES(?,?,?,?,?,?,?,?,?)',
                       ('decision-object-coverage', 'annotation-object-coverage', 'human_confirmed', checksum,
                        '8' * 64, 'decision-0', '7', json.dumps(provenance), 102.0))
        return payload

    def test_real_producer_scope_history_and_sparse_labels(self):
        before = self.database.read_bytes()
        value = self.build()
        self.assertEqual(before, self.database.read_bytes())
        self.assertFalse(Path(str(self.database) + '-shm').exists())
        self.assertEqual([p['position'] for p in value['photos']], [0, 1])
        self.assertEqual(value['draftBaseline']['displayMediaIds'], ['media-one'])
        self.assertEqual(value['draftBaseline']['coverMediaId'], 'media-one')
        self.assertEqual(value['photos'][0]['frame'], self.frames[0])
        self.assertEqual(value['annotations']['annotation_revisions'][0]['payload']['values'], {'representation': 'stone'})
        self.assertEqual(value['annotations']['annotation_decisions'][0]['reviewScope']['independentProfessionalSemanticReview'], 'not_attested')
        self.assertEqual(value['sourceGroups'][0]['excludedCount'], 1)
        proposal = next(p for p in value['history']['proposals'] if p['id'] == 'proposal-0')
        self.assertEqual(proposal['value'], ['asset-one'])
        self.assertEqual(proposal['input_hash'], '5' * 64)
        self.assertEqual(proposal['version'], 1)
        run = value['modelRuns'][0]
        self.assertEqual((run['originalAssetCount'], len(run['assetIds']), run['excludedAssetCount']), (2, 1, 1))
        self.assertTrue(run['metadata']['failedInputAssignmentUnknown'])
        self.assertEqual(run['output']['segments'][1]['status'], 'failed')
        self.assertNotIn(self.outside, canonical(value).decode())

    def test_deterministic_bytes_and_private_content_address(self):
        first, second = self.build(), self.build()
        self.assertEqual(canonical(first), canonical(second))
        result = write_metadata_snapshot(first, self.root / 'output')
        path = Path(result['path'])
        self.assertEqual(path.read_bytes(), canonical(first))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertTrue(write_metadata_snapshot(second, self.root / 'output')['replayed'])
        path.write_bytes(b'{}')
        with self.assertRaisesRegex(SnapshotError, 'EXISTING_SNAPSHOT_INVALID'):
            write_metadata_snapshot(second, self.root / 'output')

    def test_atomic_write_failure_has_no_partial_final_and_same_input_can_retry(self):
        value = self.build()
        output = self.root / 'failed-write'
        output.mkdir(mode=0o700)
        foreign = output / '.metadata-write-other-attempt'
        foreign.write_bytes(b'leave this unrelated attempt alone')
        original_fdopen = os.fdopen
        class BrokenWriter:
            def __init__(self, handle): self.handle = handle
            def __enter__(self): self.handle.__enter__(); return self
            def __exit__(self, *args): return self.handle.__exit__(*args)
            def write(self, raw):
                self.handle.write(raw[:len(raw) // 2])
                self.handle.flush()
                raise OSError('injected partial write')
        def faulty_open(fd, mode):
            handle = original_fdopen(fd, mode)
            return BrokenWriter(handle) if mode == 'wb' else handle
        with mock.patch('metadata_snapshot.os.fdopen', side_effect=faulty_open):
            with self.assertRaises(OSError): write_metadata_snapshot(value, output)
        self.assertEqual(list(output.iterdir()), [foreign])
        result = write_metadata_snapshot(value, output)
        self.assertEqual(Path(result['path']).read_bytes(), canonical(value))
        self.assertEqual(foreign.read_bytes(), b'leave this unrelated attempt alone')

    def test_hard_interruption_leaves_only_temp_then_new_attempt_succeeds(self):
        value = self.build()
        input_path = self.root / 'child-value.json'
        self.write(input_path, value)
        output = self.root / 'interrupted-output'
        code = '''
import json, os, sys
from pathlib import Path
import metadata_snapshot as m
original = os.fdopen
class InterruptedWriter:
    def __init__(self, handle): self.handle = handle
    def __enter__(self): self.handle.__enter__(); return self
    def __exit__(self, *args): return self.handle.__exit__(*args)
    def write(self, raw):
        self.handle.write(raw[:len(raw)//2]); self.handle.flush()
        os.fsync(self.handle.fileno()); os._exit(91)
def interrupt(fd, mode):
    handle = original(fd, mode)
    return InterruptedWriter(handle) if mode == 'wb' else handle
m.os.fdopen = interrupt
m.write_metadata_snapshot(json.loads(Path(sys.argv[1]).read_bytes()), sys.argv[2])
'''
        child = subprocess.run([sys.executable, '-B', '-c', code, str(input_path), str(output)],
                               cwd=Path(__file__).parent, capture_output=True, timeout=10)
        self.assertEqual(child.returncode, 91)
        self.assertEqual(list(output.glob('metadata-*.json')), [])
        orphans = list(output.glob('.metadata-write-*'))
        self.assertEqual(len(orphans), 1)
        orphan_bytes = orphans[0].read_bytes()
        self.assertNotEqual(orphan_bytes, canonical(value))
        result = write_metadata_snapshot(value, output)
        self.assertEqual(Path(result['path']).read_bytes(), canonical(value))
        self.assertEqual(orphans[0].read_bytes(), orphan_bytes)

    def test_concurrent_same_content_publishes_one_complete_private_final(self):
        value = self.build()
        output = self.root / 'concurrent-output'
        barrier = threading.Barrier(6)
        def publish(_):
            barrier.wait(timeout=10)
            return write_metadata_snapshot(value, output)
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(publish, range(6)))
        self.assertEqual(len({r['path'] for r in results}), 1)
        self.assertEqual(sum(not r['replayed'] for r in results), 1)
        self.assertEqual(len(list(output.iterdir())), 1)
        final = Path(results[0]['path'])
        self.assertEqual(final.read_bytes(), canonical(value))
        self.assertEqual(stat.S_IMODE(final.stat().st_mode), 0o600)

    def test_conflicting_or_nonprivate_final_is_preserved_for_explicit_maintenance(self):
        value = self.build()
        raw = canonical(value)
        for name, existing, mode in [('partial', raw[:len(raw)//2], 0o600),
                                     ('different', b'{"different":true}', 0o600),
                                     ('nonprivate', raw, 0o644)]:
            output = self.root / name
            output.mkdir(mode=0o700)
            final = output / ('metadata-' + digest(value) + '.json')
            final.write_bytes(existing); final.chmod(mode)
            before = final.stat()
            with self.assertRaisesRegex(SnapshotError, 'EXISTING_SNAPSHOT_INVALID'):
                write_metadata_snapshot(value, output)
            after = final.stat()
            self.assertEqual(final.read_bytes(), existing)
            self.assertEqual((before.st_ino, before.st_mtime_ns, before.st_mode),
                             (after.st_ino, after.st_mtime_ns, after.st_mode))
            self.assertEqual(list(output.iterdir()), [final])

    def test_complete_publish_with_orphan_hard_link_is_reused_without_sweeping(self):
        value = self.build()
        output = self.root / 'published-before-kill'
        output.mkdir(mode=0o700)
        orphan = output / '.metadata-write-killed-after-link'
        orphan.write_bytes(canonical(value)); orphan.chmod(0o600)
        final = output / ('metadata-' + digest(value) + '.json')
        os.link(orphan, final)
        result = write_metadata_snapshot(value, output)
        self.assertTrue(result['replayed'])
        self.assertEqual(final.read_bytes(), canonical(value))
        self.assertTrue(orphan.is_file())
        self.assertEqual(final.stat().st_nlink, 2)

    def test_cli_manual_only_without_model_keeps_empty_results(self):
        self.sql('UPDATE proposals SET model_revision=?,prompt_version=?',
                 ('human-entry/v1', 'manual-selection-source/v1'))
        self.model.unlink()  # No implicit model-directory lookup may occur.
        output = self.root / 'manual-cli'
        argv = ['metadata_snapshot.py', '--database', str(self.database), '--package', str(self.package),
                '--review', str(self.review), '--inventory', str(self.inventory), '--output', str(output)]
        with mock.patch('sys.argv', argv), redirect_stdout(io.StringIO()) as capture:
            self.assertEqual(main(), 0)
        receipt = json.loads(capture.getvalue())
        value = json.loads(Path(receipt['path']).read_bytes())
        self.assertEqual(value['modelRuns'], [])
        self.assertTrue(all(g['provenance']['origin'] == 'manual' for g in value['sourceGroups']))

    def test_inventory_wrong_hash_and_incomplete_page(self):
        for mutate, error in [(lambda d: d['inventory']['docs'][0].update(sha256='0' * 64), 'PHOTO_IDENTITY_MISMATCH'),
                              (lambda d: d['inventory'].update(hasNextPage=True), 'INVENTORY_INCOMPLETE')]:
            live = copy.deepcopy(self.live); mutate(live); self.write(self.inventory, live)
            with self.assertRaisesRegex(SnapshotError, error): self.build()

    def test_duplicate_or_missing_photo_scope(self):
        self.packet['objects'][0]['media'][1]['assetId'] = self.aids[0]
        self.write(self.package, self.packet)
        with self.assertRaisesRegex(SnapshotError, 'DUPLICATE_RECORD_ID'): self.build()

    def test_wrong_target_revision_and_display(self):
        for mutate, error in [(lambda d: d['draft'].update(revision=3), 'INVENTORY_TARGET_MISMATCH'),
                              (lambda d: d['draft']['content'].update(media=[]), 'DISPLAY_BASELINE_MISMATCH')]:
            live = copy.deepcopy(self.live); mutate(live); self.write(self.inventory, live)
            with self.assertRaisesRegex(SnapshotError, error): self.build()

    def test_empty_display_requires_explicit_new_draft_opt_in(self):
        self.live['draft']['content']['media'] = []
        self.write(self.inventory, self.live)
        with self.assertRaisesRegex(SnapshotError, 'DISPLAY_BASELINE_MISMATCH'): self.build()
        with self.assertRaisesRegex(SnapshotError, 'UNAPPLIED_DISPLAY_NEW_DRAFT_REQUIRED'):
            self.build(allow_unapplied_display_plan=True)
        value = self.build(new_draft=True, allow_unapplied_display_plan=True)
        self.assertEqual(value['draftBaseline']['displayMediaIds'], [])
        self.assertIsNone(value['draftBaseline']['coverMediaId'])
        intent = next(x for x in value['history']['facts'] if x['field'] == 'plannedDisplay')['value']
        self.assertTrue(intent['intentOnly'])
        self.assertEqual(intent['status'], 'DISPLAY_PLAN_NOT_APPLIED')
        self.assertEqual(intent['displayMedia'][0]['mediaId'], self.media_ids[0])

    def test_nonempty_display_position_drift_or_false_opt_in_is_rejected(self):
        with self.assertRaisesRegex(SnapshotError, 'UNAPPLIED_DISPLAY_NEW_DRAFT_REQUIRED'):
            self.build(new_draft=True, allow_unapplied_display_plan=True)
        self.live['draft']['content']['media'][0]['position'] = 1
        self.write(self.inventory, self.live)
        with self.assertRaisesRegex(SnapshotError, 'DISPLAY_BASELINE_MISMATCH'): self.build()

    def test_integer_valued_decimal_preserves_original_python_canonical_sha(self):
        with sqlite3.connect(self.database) as db:
            payload = json.loads(db.execute('SELECT payload FROM photo_annotation_revisions WHERE id=?',
                                            ('annotation-0',)).fetchone()[0])
            payload['values']['position_index'] = 1.0
            checksum = digest(payload)
            db.execute('UPDATE photo_annotation_revisions SET payload=?,payload_sha256=?,changes=? WHERE id=?',
                       (json.dumps(payload), checksum, json.dumps(payload['values']), 'annotation-0'))
            db.execute('UPDATE photo_annotation_decisions SET payload_sha256=? WHERE revision_id=?',
                       (checksum, 'annotation-0'))
        value = self.build()
        row = next(r for r in value['annotations']['annotation_revisions'] if r['id'] == 'annotation-0')
        self.assertIn('"position_index":1.0', row['payloadCanonicalJSON'])
        self.assertEqual(digest(row['payload']), checksum)
        self.assertEqual(row['payload_sha256'], checksum)
        self.assertEqual(canonical(row['payload']).decode(), row['payloadCanonicalJSON'])

    def test_delta_can_inherit_existing_facing_front_without_repeating_it(self):
        with sqlite3.connect(self.database) as db:
            payload = json.loads(db.execute('SELECT payload FROM photo_annotation_revisions WHERE id=?',
                                            ('annotation-0',)).fetchone()[0])
            payload['values'].update(surfaces=['left'], side_reference='facing_front')
            checksum = digest(payload)
            db.execute('UPDATE photo_annotation_revisions SET payload=?,payload_sha256=?,changes=? WHERE id=?',
                       (json.dumps(payload), checksum, json.dumps({'surfaces': ['left']}), 'annotation-0'))
            db.execute('UPDATE photo_annotation_decisions SET payload_sha256=? WHERE revision_id=?',
                       (checksum, 'annotation-0'))
        value = self.build()
        row = next(r for r in value['annotations']['annotation_revisions'] if r['id'] == 'annotation-0')
        self.assertEqual(row['payload']['values']['side_reference'], 'facing_front')
        self.assertEqual(row['changes'], {'surfaces': ['left']})

    def test_delta_still_rejects_invalid_duplicate_and_conflicting_unknown_labels(self):
        for values in [{'surfaces': ['front', 'front']}, {'surfaces': ['front', 'unknown']},
                       {'representation': 'invented_kind'}]:
            self.sql('UPDATE photo_annotation_revisions SET changes=? WHERE id=?',
                     (json.dumps(values), 'annotation-0'))
            with self.assertRaises(SnapshotError): self.build()

    def test_new_draft_can_have_zero_annotations_without_fabricating_review_or_frame(self):
        self.sql('DELETE FROM photo_annotation_decisions')
        self.sql('DELETE FROM photo_annotation_revisions')
        self.live['draft']['content']['media'] = []
        self.write(self.inventory, self.live)
        with self.assertRaisesRegex(SnapshotError, 'SPARSE_ANNOTATIONS_NEW_DRAFT_REQUIRED'):
            self.build(allow_sparse_annotations=True)
        value = self.build(new_draft=True, allow_unapplied_display_plan=True,
                           allow_sparse_annotations=True)
        self.assertEqual(value['annotations'], {'current_annotations': [],
                                               'annotation_revisions': [], 'annotation_decisions': []})
        for photo in value['photos']:
            self.assertEqual(photo['frame']['coordinateSystem'], 'unavailable')
            self.assertNotIn('width', photo['frame'])
            self.assertNotIn('exifOrientation', photo['frame'])
            self.assertEqual(photo['processing']['source']['frameRecordStatus'], 'FRAME_NOT_RECORDED')
        self.live['inventory']['docs'][0]['sha256'] = '0' * 64
        self.write(self.inventory, self.live)
        with self.assertRaisesRegex(SnapshotError, 'PHOTO_IDENTITY_MISMATCH'):
            self.build(new_draft=True, allow_unapplied_display_plan=True,
                       allow_sparse_annotations=True)
        self.live['inventory']['docs'][0]['sha256'] = self.output_hashes[0]
        self.write(self.inventory, self.live)
        self.sql("UPDATE decisions SET status='rejected' WHERE id=?", ('decision-0',))
        with self.assertRaisesRegex(SnapshotError, 'NATIVE_MEMBERSHIP_REVIEW_MISSING'):
            self.build(new_draft=True, allow_unapplied_display_plan=True,
                       allow_sparse_annotations=True)

    def test_default_missing_one_annotation_blocks_and_sparse_does_not_invent_payload(self):
        self.sql('DELETE FROM photo_annotation_decisions WHERE revision_id=?', ('annotation-0',))
        self.sql('DELETE FROM photo_annotation_revisions WHERE id=?', ('annotation-0',))
        with self.assertRaisesRegex(SnapshotError, 'CURRENT_ANNOTATION_SCOPE_INCOMPLETE'): self.build()
        value = self.build(new_draft=True, allow_sparse_annotations=True)
        self.assertEqual(len(value['annotations']['annotation_revisions']), 1)
        self.assertEqual(len(value['annotations']['current_annotations']), 1)
        self.assertEqual(value['photos'][0]['frame']['coordinateSystem'], 'unavailable')
        self.assertEqual(value['photos'][1]['frame'], self.frames[1])

    def test_explicit_existing_original_frame_is_used_for_unannotated_photo(self):
        self.sql('DELETE FROM photo_annotation_decisions WHERE revision_id=?', ('annotation-0',))
        self.sql('DELETE FROM photo_annotation_revisions WHERE id=?', ('annotation-0',))
        self.packet['objects'][0]['localAnnotations']['originalFrames'] = {self.aids[0]: self.frames[0]}
        self.write(self.package, self.packet)
        value = self.build(new_draft=True, allow_sparse_annotations=True)
        self.assertEqual(value['photos'][0]['frame'], self.frames[0])
        self.assertNotIn('frameRecordStatus', value['photos'][0]['processing']['source'])

    def test_object_coverage_revision_decision_and_current_are_preserved(self):
        payload = self.add_object_coverage()
        value = self.build()
        row = next(r for r in value['annotations']['annotation_revisions']
                   if r['id'] == 'annotation-object-coverage')
        self.assertEqual(row['payload'], payload)
        self.assertEqual(row['payloadCanonicalJSON'], canonical(payload).decode())
        for key in ['asset_id', 'logical_asset_id', 'source_sha256', 'coordinate_frame']:
            self.assertIsNone(row[key])
        current = next(r for r in value['annotations']['current_annotations'] if r['asset_id'] is None)
        self.assertEqual(current['revision_id'], row['id'])
        self.assertEqual(current['decision_id'], 'decision-object-coverage')
        decision = next(d for d in value['annotations']['annotation_decisions']
                        if d['id'] == current['decision_id'])
        self.assertIn(decision['membership_decision_id'], {d['id'] for d in value['history']['decisions']})
        self.assertEqual(len(value['annotations']['current_annotations']), 3)

    def test_object_coverage_uses_entire_object_membership_and_keeps_stale_history(self):
        self.add_object_coverage()
        self.sql('UPDATE photo_annotation_revisions SET membership_sha256=? WHERE id=?',
                 ('0' * 64, 'annotation-object-coverage'))
        value = self.build()
        self.assertTrue(any(r['asset_id'] is None for r in value['annotations']['annotation_revisions']))
        self.assertFalse(any(r['asset_id'] is None for r in value['annotations']['current_annotations']))
        self.assertEqual(len(value['annotations']['current_annotations']), 2)

    def test_sparse_object_coverage_does_not_fabricate_photo_annotations(self):
        self.sql('DELETE FROM photo_annotation_decisions')
        self.sql('DELETE FROM photo_annotation_revisions')
        self.add_object_coverage()
        with self.assertRaisesRegex(SnapshotError, 'CURRENT_ANNOTATION_SCOPE_INCOMPLETE'): self.build()
        value = self.build(new_draft=True, allow_sparse_annotations=True)
        self.assertEqual(len(value['annotations']['current_annotations']), 1)
        self.assertIsNone(value['annotations']['current_annotations'][0]['asset_id'])
        self.assertEqual(len(value['annotations']['annotation_revisions']), 1)
        self.assertEqual(len(value['annotations']['annotation_decisions']), 1)
        self.assertTrue(all(p['frame']['coordinateSystem'] == 'unavailable' for p in value['photos']))

    def test_object_coverage_cannot_carry_photo_identity_or_frame(self):
        self.add_object_coverage()
        self.sql('UPDATE photo_annotation_revisions SET source_sha256=? WHERE id=?',
                 (self.source_hashes[0], 'annotation-object-coverage'))
        with self.assertRaisesRegex(SnapshotError, 'OBJECT_COVERAGE_IDENTITY_INVALID'): self.build()

    def test_payload_hash_and_frame_identity(self):
        self.sql("UPDATE photo_annotation_revisions SET payload_sha256=? WHERE asset_id=?", ('0' * 64, self.aids[0]))
        with self.assertRaisesRegex(SnapshotError, 'ANNOTATION_PAYLOAD_HASH_INVALID'): self.build()

    def test_frame_identity_mismatch(self):
        frame = {**self.frames[0], 'assetId': self.aids[1]}
        self.sql('UPDATE photo_annotation_revisions SET coordinate_frame=? WHERE asset_id=?', (json.dumps(frame), self.aids[0]))
        with self.assertRaisesRegex(SnapshotError, 'FRAME_IDENTITY_MISMATCH'): self.build()

    def test_frame_shape_and_unavailable_preserve_original_semantics(self):
        frame = {**self.frames[0], 'width': -1}
        self.sql('UPDATE photo_annotation_revisions SET coordinate_frame=? WHERE asset_id=?',
                 (json.dumps(frame), self.aids[0]))
        with self.assertRaisesRegex(SnapshotError, 'FRAME_SCHEMA_INVALID'): self.build()
        unavailable = {k: v for k, v in self.frames[0].items() if k not in {'width', 'height', 'exifOrientation'}}
        unavailable['coordinateSystem'] = 'unavailable'
        validate_frame(unavailable, self.aids[0], self.source_hashes[0])

    def test_model_field_without_selected_evidence_is_excluded(self):
        group = self.model_value['segments'][0]['proposal']['groups'][0]
        group['fields'] = [{'field': 'title', 'value': '外部图片推测', 'evidence': [self.outside]},
                           {'field': 'object_form', 'value': '碑刻', 'evidence': [self.aids[0]]}]
        self.write(self.model, self.model_value)
        value = self.build()
        fields = value['modelRuns'][0]['output']['segments'][0]['proposal']['groups'][0]['fields']
        self.assertEqual(fields, [{'field': 'object_form', 'value': '碑刻', 'evidence': [self.aids[0]]}])

    def test_missing_decision_and_cross_revision_event(self):
        self.sql('UPDATE photo_annotation_decisions SET confirmation_event=? WHERE revision_id=?', ('0' * 64, 'annotation-0'))
        with self.assertRaisesRegex(SnapshotError, 'ANNOTATION_DECISION_MISMATCH'): self.build()

    def test_membership_change_is_not_current(self):
        self.sql("UPDATE object_assets SET role='overview' WHERE asset_id=?", (self.aids[0],))
        with self.assertRaisesRegex(SnapshotError, 'CURRENT_ANNOTATION_SCOPE_INCOMPLETE'): self.build()

    def test_scope_cannot_be_promoted_to_professional_review(self):
        with sqlite3.connect(self.database) as db:
            value = json.loads(db.execute('SELECT provenance FROM photo_annotation_decisions LIMIT 1').fetchone()[0])
        value['nativeApprovalScope'] = 'all_professional_labels'
        self.sql('UPDATE photo_annotation_decisions SET provenance=?', (json.dumps(value),))
        with self.assertRaisesRegex(SnapshotError, 'REVIEW_SCOPE_UNATTESTED'): self.build()

    def test_untrusted_path_reference_is_not_opened(self):
        self.packet['objects'][0]['localAnnotations']['annotationSnapshots'] = ['/etc/passwd']
        self.write(self.package, self.packet)
        with self.assertRaisesRegex(SnapshotError, 'INPUT_UNSAFE|REVIEW_REFERENCE_UNSAFE'):
            self.build()

    def test_materializes_review_json_without_paths(self):
        annotation = {'id': 1, 'result': [], 'completed_by': 7}
        checksum = digest(annotation)
        path = self.root / ('review-native-1-' + checksum + '-annotation.json')
        self.write(path, {'annotation': annotation, 'normalized': {'accepted': True}})
        self.packet['objects'][0]['localAnnotations']['annotationSnapshots'] = [str(path)]
        self.write(self.package, self.packet)
        value = self.build()
        self.assertEqual(value['history']['annotationSnapshots'][0]['annotation'], annotation)
        self.assertNotIn(str(self.root), canonical(value).decode())

    def test_source_changed_during_read_is_rejected(self):
        original = model_run
        def mutate(*args):
            result = original(*args)
            self.inventory.write_bytes(self.inventory.read_bytes() + b' ')
            return result
        with mock.patch('metadata_snapshot.model_run', side_effect=mutate):
            with self.assertRaisesRegex(SnapshotError, 'SOURCE_CHANGED'): self.build()

    def test_wal_requires_frozen_copy(self):
        Path(str(self.database) + '-wal').write_bytes(b'not-a-valid-wal')
        with self.assertRaisesRegex(SnapshotError, 'DATABASE_FROZEN_COPY_REQUIRED'): self.build()

    def test_unknown_null_absent_and_conflicting_labels(self):
        schema = json.loads(PHOTO_SCHEMA.read_text())
        for values in [{}, {'representation': None}, {'surfaces': ['unknown']}, {'content': []}]:
            validate_annotation({'schema_version': 'artvenn-photo-annotation/v1', 'kind': 'photo', 'values': values}, schema)
        with self.assertRaisesRegex(SnapshotError, 'ANNOTATION_UNCERTAINTY_CONFLICT'):
            validate_annotation({'schema_version': 'artvenn-photo-annotation/v1', 'kind': 'photo',
                                 'values': {'surfaces': ['front', 'unknown']}}, schema)

    def test_json_ambiguity_and_nonportable_processing(self):
        for raw in ['{"x":1,"x":2}', '{"x":NaN}']:
            with self.assertRaises(SnapshotError): parse_json(raw)
        self.packet['objects'][0]['localAnnotations']['sourceProcessingLineage'][self.aids[0]]['path'] = '/Users/private/image.jpg'
        self.write(self.package, self.packet)
        with self.assertRaisesRegex(SnapshotError, 'NON_PORTABLE_FIELD'): self.build()


if __name__ == '__main__':
    unittest.main()
