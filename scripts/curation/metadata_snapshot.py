"""Explicit, offline portable curation metadata; never opens images or services.

The inherited photo schema SHA is
2642d793c3e43824862bfb531a746cd79fe4802b2bea07471b4fe4bb73186d1a
(curation-guided-flow-v1, scripts/curation/schemas/photo-annotation-v1.schema.json).
No Registry constructor is used. All paths are explicit CLI inputs, except the
strictly scoped native-review JSON references already contained in that packet.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import uuid

VERSION = 'artvenn-curation-metadata/v1'
PHOTO_SCHEMA = Path(__file__).parent / 'schemas/photo-annotation-v1.schema.json'
SHA = re.compile(r'^[0-9a-f]{64}$')
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$')
SNAPSHOT_NAME = re.compile(r'^review-[A-Za-z0-9_-]+-[0-9]+-[0-9a-f]{64}-annotation\.json$')
PATH_TEXT = re.compile(r'(?:^|[\s"\'])/(?:Users|private|tmp|home|var|Volumes|opt)/')
FORBIDDEN_KEY = re.compile(r'^(?:path|file|filePath|sourcePath|sourceRoot|source_root|relative_path|'
                           r'derivativePath|previewPath|databasePath|config|apiKey|authorization|'
                           r'credentials?|secrets?|tokens?|password|privateKey|objectKey|bucket|url|'
                           r'thumbnailURL|previewURL|downloadURL|baseURL|secretId|secretKey|'
                           r'accessToken|refreshToken)$', re.I)
LIMIT = 32 * 1024 * 1024


class SnapshotError(ValueError):
    """Fixed categories; never expose source content or credentials in errors."""


def require(condition, category):
    if not condition:
        raise SnapshotError(category)


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError):
        raise SnapshotError('NON_CANONICAL_JSON') from None


def sha(value):
    return hashlib.sha256(value).hexdigest()


def digest(value):
    return sha(canonical(value))


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              SnapshotError('NON_FINITE_JSON')))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SnapshotError('INVALID_JSON') from None


def file_identity(path):
    try:
        info = path.lstat()
    except OSError:
        raise SnapshotError('INPUT_UNAVAILABLE') from None
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1 and info.st_size <= LIMIT, 'INPUT_UNSAFE')
    require(not any(parent.is_symlink() for parent in path.parents), 'INPUT_UNSAFE')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def safe_path(value):
    path = Path(value).absolute()
    # macOS exposes /tmp and /var as system aliases. Other symlinks are refused.
    require(not path.is_symlink() and not any(parent.is_symlink()
            and str(parent) not in {'/tmp', '/var'} for parent in path.parents), 'INPUT_UNSAFE')
    return path.resolve()


class Inputs:
    def __init__(self):
        self.files = {}

    def read(self, value):
        path = safe_path(value)
        identity = file_identity(path)
        try:
            raw = path.read_bytes()
        except OSError:
            raise SnapshotError('INPUT_UNAVAILABLE') from None
        require(file_identity(path) == identity, 'SOURCE_CHANGED')
        prior = self.files.get(path)
        require(prior is None or prior == (identity, sha(raw)), 'SOURCE_CHANGED')
        self.files[path] = (identity, sha(raw))
        return parse_json(raw), raw

    def check(self):
        for path, (identity, checksum) in self.files.items():
            require(file_identity(path) == identity and sha(path.read_bytes()) == checksum,
                    'SOURCE_CHANGED')


def assert_portable(value):
    if isinstance(value, dict):
        for key, item in value.items():
            require(not FORBIDDEN_KEY.fullmatch(key), 'NON_PORTABLE_FIELD')
            assert_portable(item)
    elif isinstance(value, list):
        for item in value:
            assert_portable(item)
    elif isinstance(value, str):
        require(not PATH_TEXT.search(value), 'NON_PORTABLE_TEXT')
    elif isinstance(value, float):
        require(math.isfinite(value), 'NON_FINITE_JSON')


ASSET_KEYS = {'asset_id', 'assetId', 'source_asset_id'}
ASSET_LIST_KEYS = {'asset_ids', 'assetIds', 'members'}


def asset_refs(value, *, group_membership=False, evidence_assets=(), strict_evidence=False):
    result = set()
    if group_membership and isinstance(value, list):
        result.update(x for x in value if isinstance(x, str))
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ASSET_KEYS and isinstance(item, str):
                result.add(item)
            elif key in ASSET_LIST_KEYS and isinstance(item, list):
                result.update(x for x in item if isinstance(x, str))
            elif key == 'evidence' and isinstance(item, list):
                result.update(x for x in item if isinstance(x, str)
                              and (strict_evidence or x in evidence_assets))
            result.update(asset_refs(item,
                                     group_membership=(key == 'value' and value.get('kind') == 'group'),
                                     evidence_assets=evidence_assets))
    elif isinstance(value, list):
        for item in value:
            result.update(asset_refs(item, evidence_assets=evidence_assets, strict_evidence=strict_evidence))
    return result


def project(value, selected, *, group_membership=False, evidence_assets=(), strict_evidence=False):
    """Explicit projection. Original record identity/hash remain separate."""
    if isinstance(value, list):
        if group_membership:
            require(all((isinstance(x, str) and ID.fullmatch(x)) or
                        (isinstance(x, dict) and any(isinstance(x.get(k), str) for k in ASSET_KEYS))
                        for x in value), 'GROUP_MEMBERSHIP_INVALID')
        return [project(item, selected, evidence_assets=evidence_assets, strict_evidence=strict_evidence)
                for item in value
                if not (group_membership and isinstance(item, str) and item not in selected)
                and (not isinstance(item, dict) or not any(
                    isinstance(item.get(k), str) and item[k] not in selected
                    for k in ASSET_KEYS))]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in ASSET_LIST_KEYS and isinstance(item, list):
                require(all(isinstance(x, str) and ID.fullmatch(x) for x in item),
                        'ASSET_REFERENCE_INVALID')
                result[key] = [x for x in item if x in selected]
            elif key == 'evidence' and isinstance(item, list):
                if strict_evidence:
                    require(all(isinstance(x, str) and ID.fullmatch(x) for x in item),
                            'LEGACY_EVIDENCE_REFERENCE_INVALID')
                    result[key] = [x for x in item if x in selected]
                else:
                    # Generic evidence also carries words/notes. Only source-
                    # registered or explicitly referenced IDs can be recognized
                    # as old bare references. Normalize those to an explicit key
                    # so consumers never need a naming or token-shape guess.
                    result[key] = project(
                        [{'assetId': x} if isinstance(x, str) and x in evidence_assets else x for x in item],
                        selected, evidence_assets=evidence_assets)
            else:
                result[key] = project(item, selected,
                                      group_membership=(key == 'value' and value.get('kind') == 'group'),
                                      evidence_assets=evidence_assets)
        return result
    return value


def unique(rows, key):
    result = {}
    for row in rows:
        require(row[key] not in result, 'DUPLICATE_RECORD_ID')
        result[row[key]] = row
    return result


def validate_annotation(payload, schema, *, complete_semantics=True):
    """The inherited closed schema uses this small, explicit keyword subset."""
    require(isinstance(payload, dict) and set(payload) == {'kind', 'schema_version', 'values'}
            and payload['schema_version'] == 'artvenn-photo-annotation/v1',
            'ANNOTATION_SCHEMA_INVALID')
    branch = next((b for b in schema['oneOf']
                   if b['properties']['kind']['const'] == payload['kind']), None)
    require(branch is not None, 'ANNOTATION_SCHEMA_INVALID')
    props = branch['properties']['values']['properties']
    values = payload['values']
    require(isinstance(values, dict) and set(values) <= set(props), 'ANNOTATION_SCHEMA_INVALID')
    for key, value in values.items():
        spec = props[key]
        kind = spec.get('type')
        if value is None:
            require(None in spec.get('enum', []) or kind == 'null'
                    or isinstance(kind, list) and 'null' in kind,
                    'ANNOTATION_SCHEMA_INVALID')
            continue
        if isinstance(kind, list):
            kind = next(x for x in kind if x != 'null')
        if kind == 'array':
            require(isinstance(value, list) and len(value) <= spec.get('maxItems', LIMIT)
                    and all(x in spec['items']['enum'] for x in value)
                    and len({canonical(x) for x in value}) == len(value),
                    'ANNOTATION_SCHEMA_INVALID')
            require(not (len(value) > 1 and {'unknown', 'not_applicable'} & set(value)),
                    'ANNOTATION_UNCERTAINTY_CONFLICT')
        elif kind == 'integer':
            require(type(value) in {int, float} and math.isfinite(value)
                    and (type(value) is int or value.is_integer()) and value >= spec.get('minimum', 0),
                    'ANNOTATION_SCHEMA_INVALID')
        else:
            require(isinstance(value, str) and len(value) <= spec.get('maxLength', LIMIT)
                    and all(ord(x) >= 32 and not 127 <= ord(x) < 160 for x in value),
                    'ANNOTATION_SCHEMA_INVALID')
        require('enum' not in spec or value in spec['enum'], 'ANNOTATION_SCHEMA_INVALID')
    if complete_semantics and payload['kind'] == 'photo' and {'left', 'right'} & set(values.get('surfaces', [])):
        require(values.get('side_reference') == 'facing_front', 'ANNOTATION_SIDE_REFERENCE_REQUIRED')
    if complete_semantics and payload['kind'] == 'object_coverage' and 'verified_absent' in values.values():
        require(bool(values.get('coverage_evidence', '').strip()), 'ANNOTATION_COVERAGE_EVIDENCE_REQUIRED')


def validate_frame(frame, asset_id, source_sha):
    require(isinstance(frame, dict) and frame.get('assetId') == asset_id
            and frame.get('sourceSha256') == source_sha, 'FRAME_IDENTITY_MISMATCH')
    common = {'version', 'assetId', 'sourceSha256', 'coordinateSystem', 'orientationApplied'}
    require(frame['version'] == 'artvenn-original-frame/v1'
            and frame['orientationApplied'] is False, 'FRAME_SCHEMA_INVALID')
    if frame['coordinateSystem'] == 'unavailable':
        require(set(frame) == common, 'FRAME_SCHEMA_INVALID')
    else:
        require(frame['coordinateSystem'] == 'original_encoded_pixels_top_left'
                and set(frame) == common | {'width', 'height', 'exifOrientation'}
                and all(type(frame[k]) is int and frame[k] >= 1 for k in ('width', 'height'))
                and type(frame['exifOrientation']) is int and 1 <= frame['exifOrientation'] <= 8,
                'FRAME_SCHEMA_INVALID')


class Database:
    def __init__(self, path):
        self.path = safe_path(path)
        self.identity = file_identity(self.path)
        self.sidecars = [Path(str(self.path) + suffix) for suffix in ('-wal', '-shm')]
        # immutable is safe only with no WAL and a stable source. It avoids
        # SQLite creating a shared-memory file in the live runtime directory.
        require(not any(p.exists() for p in self.sidecars), 'DATABASE_FROZEN_COPY_REQUIRED')
        self.checksum = sha(self.path.read_bytes())
        self.db = sqlite3.connect(self.path.as_uri() + '?mode=ro&immutable=1', uri=True)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA query_only=ON')
        self.db.execute('BEGIN')

    def rows(self, sql, args=()):
        rows = self.db.execute(sql, args).fetchmany(20001)
        require(len(rows) <= 20000, 'ROW_LIMIT_EXCEEDED')
        return [dict(row) for row in rows]

    def close(self):
        self.db.rollback()
        self.db.close()
        require(file_identity(self.path) == self.identity
                and sha(self.path.read_bytes()) == self.checksum
                and not any(p.exists() for p in self.sidecars), 'SOURCE_CHANGED')


def professional(db, selected, object_id, schema, *, allow_sparse=False):
    tables = {r['name'] for r in db.rows("SELECT name FROM sqlite_master WHERE type='table'")}
    annotation_tables = {'photo_annotation_revisions', 'photo_annotation_decisions'}
    require(not (annotation_tables & tables) or annotation_tables <= tables, 'ANNOTATION_SCHEMA_INCOMPLETE')
    if not annotation_tables <= tables:
        require(allow_sparse, 'CURRENT_ANNOTATION_SCOPE_INCOMPLETE')
        return {'current_annotations': [], 'annotation_revisions': [], 'annotation_decisions': []}
    revisions = db.rows('SELECT * FROM photo_annotation_revisions WHERE object_id=? '
                        'ORDER BY context_key,revision', (object_id,))
    revisions = [r for r in revisions if r['asset_id'] is None or r['asset_id'] in selected]
    all_decisions = unique(db.rows('SELECT * FROM photo_annotation_decisions'), 'revision_id')
    membership_decisions = unique(db.rows('SELECT * FROM decisions'), 'id')
    assets = unique(db.rows('SELECT id,sha256 FROM assets'), 'id')
    latest = {}
    decisions = []
    by_id = unique(revisions, 'id')
    for row in revisions:
        for key in ('payload', 'changes'):
            row[key] = parse_json(row[key])
        row['coordinate_frame'] = parse_json(row['coordinate_frame']) if row['coordinate_frame'] else None
        validate_annotation(row['payload'], schema)
        # changes is the stored patch, not the complete merged label set.
        # Cross-field requirements apply to payload; patch shape/vocabulary,
        # duplicate labels and incompatible unknowns still remain checked.
        validate_annotation({**row['payload'], 'values': row['changes']}, schema, complete_semantics=False)
        require(digest(row['payload']) == row['payload_sha256'], 'ANNOTATION_PAYLOAD_HASH_INVALID')
        # Preserve Python's original canonical spelling (notably integer-valued
        # 1.0). A JS consumer hashes this string rather than reserializing numbers.
        row['payloadCanonicalJSON'] = canonical(row['payload']).decode('utf-8')
        if row['asset_id'] is None:
            require(row['payload']['kind'] == 'object_coverage'
                    and row['source_sha256'] is None and row['logical_asset_id'] is None
                    and row['coordinate_frame'] is None, 'OBJECT_COVERAGE_IDENTITY_INVALID')
        else:
            require(row['payload']['kind'] == 'photo'
                    and assets.get(row['asset_id'], {}).get('sha256') == row['source_sha256'],
                    'ANNOTATION_SOURCE_HASH_INVALID')
        previous = by_id.get(row['previous_id']) if row['previous_id'] else None
        require((row['revision'] == 1 and previous is None and row['previous_id'] is None)
                or (previous is not None and previous['context_key'] == row['context_key']
                    and previous['revision'] + 1 == row['revision']), 'ANNOTATION_HISTORY_INVALID')
        frame = row['coordinate_frame']
        if row['asset_id'] is not None:
            validate_frame(frame, row['asset_id'], row['source_sha256'])
        decision = copy.deepcopy(all_decisions.get(row['id']))
        require(decision is not None, 'ANNOTATION_DECISION_MISSING')
        decision['provenance'] = parse_json(decision['provenance'])
        prov = decision['provenance']
        require(decision['payload_sha256'] == row['payload_sha256']
                and decision['confirmation_event'] == row['confirmation_event']
                and prov.get('reviewId') == row['review_id']
                and prov.get('reviewRevision') == row['review_revision']
                and prov.get('draftSha256') == row['review_draft_sha256'], 'ANNOTATION_DECISION_MISMATCH')
        require(prov.get('nativeApprovalScope') == 'membership_and_legacy_role_only'
                and prov.get('kind') == 'explicit_local_confirmation'
                and prov.get('actorSource') == 'native_membership_reviewer', 'REVIEW_SCOPE_UNATTESTED')
        native = membership_decisions.get(decision['membership_decision_id'])
        require(native is not None and native['status'] in {'accepted', 'corrected'},
                'NATIVE_MEMBERSHIP_REVIEW_MISSING')
        # Add a consumer-facing qualification, while preserving source provenance.
        decision['reviewScope'] = {
            'annotationConfirmation': 'explicit_local_confirmation',
            'nativeApprovalScope': 'membership_and_legacy_role_only',
            'independentProfessionalSemanticReview': 'not_attested'}
        decisions.append(decision)
        prior = latest.get(row['context_key'])
        if prior is None or row['revision'] > prior['revision']:
            latest[row['context_key']] = row
    current = []
    for row in latest.values():
        sql = ('SELECT oa.object_id,oa.asset_id,oa.role,oa.decision_id,d.status,d.annotation_hash '
               'FROM object_assets oa JOIN decisions d ON d.id=oa.decision_id WHERE oa.object_id=?')
        args = [object_id]
        if row['asset_id'] is not None:
            sql += ' AND oa.asset_id=?'
            args.append(row['asset_id'])
        links = db.rows(sql + ' ORDER BY oa.asset_id', args)
        aliases = db.rows('SELECT id,object_id,target_object_id,revision,decision_id '
                          'FROM object_alias_events WHERE object_id=? OR target_object_id=? ORDER BY revision',
                          (object_id, object_id))
        membership_hash = digest({'links': [list(x.values()) for x in links],
                                  'aliases': [list(x.values()) for x in aliases]})
        decision = all_decisions[row['id']]
        if membership_hash == row['membership_sha256'] and decision['status'] == 'human_confirmed':
            current.append({'revision_id': row['id'], 'decision_id': decision['id'],
                            'object_id': object_id, 'asset_id': row['asset_id']})
    require(allow_sparse or {r['asset_id'] for r in current if r['asset_id'] is not None} == selected,
            'CURRENT_ANNOTATION_SCOPE_INCOMPLETE')
    return {'current_annotations': sorted(current, key=canonical),
            'annotation_revisions': sorted(revisions, key=canonical),
            'annotation_decisions': sorted(decisions, key=canonical)}


def history_and_groups(db, selected, group_ids, known_assets):
    proposals = db.rows('SELECT id,batch_id,subject,kind,field,value,evidence,input_hash,'
                        'model_revision,prompt_version,created,version FROM proposals')
    chosen = []
    originals = {}
    for row in proposals:
        row['value'], row['evidence'] = parse_json(row['value']), parse_json(row['evidence'])
        require(isinstance(row['evidence'], list) and all(isinstance(x, str) and ID.fullmatch(x)
                for x in row['evidence']), 'LEGACY_EVIDENCE_REFERENCE_INVALID')
        require(set(row['evidence']) <= known_assets | asset_refs(row['value'],
                group_membership=row['kind'] == 'group'), 'LEGACY_EVIDENCE_REFERENCE_INVALID')
        if not (asset_refs(row, strict_evidence=True) & selected):
            continue
        if row['kind'] == 'role' and row['field'] not in selected:
            continue
        if row['kind'] != 'issue' and row['subject'] not in group_ids:
            continue
        source = copy.deepcopy(row)
        originals[row['id']] = source
        row = project(row, selected, evidence_assets=known_assets, strict_evidence=True)
        excluded = asset_refs(source, evidence_assets=known_assets, strict_evidence=True) - selected
        row.update(source_record_sha256=digest(source), excluded_asset_count=len(excluded))
        chosen.append(row)
    original_by_id = unique(chosen, 'id')
    decisions = []
    for row in db.rows('SELECT id,proposal_id,task_key,annotation_id,annotation_hash,status,value,reviewer,created FROM decisions'):
        if row['proposal_id'] not in original_by_id:
            continue
        row['value'] = parse_json(row['value'])
        source = copy.deepcopy(row)
        group = original_by_id[row['proposal_id']]['kind'] == 'group'
        row['value'] = project(row['value'], selected, group_membership=group, evidence_assets=known_assets)
        row = project(row, selected, evidence_assets=known_assets)
        row.update(source_record_sha256=digest(source),
                   excluded_asset_count=len(asset_refs(source['value'], group_membership=group,
                                                       evidence_assets=known_assets) - selected))
        decisions.append(row)
    groups = []
    for gid in sorted(group_ids):
        rows = [r for r in chosen if r['kind'] == 'group' and r['subject'] == gid]
        require(bool(rows), 'SOURCE_GROUP_HISTORY_MISSING')
        first = min(rows, key=lambda r: r['version'])
        original = originals[first['id']]
        require(all(isinstance(x, str) for x in original['value'])
                and len(set(original['value'])) == len(original['value']), 'GROUP_MEMBERSHIP_INVALID')
        groups.append({'id': gid, 'assetIds': sorted(set(first['value'])),
                       'originalRecordSha256': first['source_record_sha256'],
                       'originalMemberCount': len(original['value']),
                       'excludedCount': len(original['value']) - len(first['value']),
                       'provenance': {'origin': 'manual' if first['model_revision'] == 'human-entry/v1' else 'AI',
                                      'proposalId': first['id'], 'version': first['version'],
                                      'inputHash': first['input_hash'], 'modelRevision': first['model_revision'],
                                      'promptVersion': first['prompt_version']}})
    return chosen, decisions, groups


def model_run(value, raw, selected, known_assets=()):
    required_text = {'status': 80, 'engine': 256, 'model_id': 2048,
                     'revision': 256, 'prompt_version': 256}
    require(isinstance(value, dict) and all(isinstance(value.get(k), str)
            and 0 < len(value[k]) <= maximum for k, maximum in required_text.items())
            and isinstance(value.get('weights_sha256'), str) and SHA.fullmatch(value['weights_sha256'])
            and type(value.get('mock')) is bool and type(value.get('cloud')) is bool,
            'MODEL_METADATA_INCOMPLETE')
    allowed = ('status', 'engine', 'model_id', 'revision', 'prompt_version', 'weights_sha256',
               'mock', 'cloud', 'human_review_required', 'load_seconds', 'elapsed_seconds', 'error_category')
    metadata = {k: value[k] for k in allowed if k in value}
    metadata.update(selectionBasis='retained_structured_output_evidence',
                    originalInputImageCount=sum(s.get('input_images', 0) for s in value['segments']),
                    failedInputAssignmentUnknown=any(s['status'] != 'completed' for s in value['segments']))
    segments = []
    original_assets = set()
    for segment in value['segments']:
        proposal = segment.get('proposal')
        evidence_assets = set(known_assets) | selected | asset_refs(proposal)
        original_assets.update(asset_refs(proposal, evidence_assets=evidence_assets))
        if isinstance(proposal, dict):
            proposal = project(proposal, selected, evidence_assets=evidence_assets)
            proposal['groups'] = [g for g in proposal.get('groups', []) if g.get('asset_ids')]
            for group in proposal['groups']:
                group['fields'] = [field for field in group.get('fields', []) if field.get('evidence')]
            proposal['roles'] = [r for r in proposal.get('roles', []) if r.get('asset_id') in selected]
            keys = {g['key'] for g in proposal['groups']}
            proposal['relationships'] = [r for r in proposal.get('relationships', [])
                                         if r['left'] in keys and r['right'] in keys and r.get('evidence')]
            proposal['issues'] = [r for r in proposal.get('issues', []) if r.get('asset_ids')]
        segments.append({**{k: segment[k] for k in ('segment_id', 'status', 'input_images', 'error_category',
                                                   'multi_image_call', 'prompt_tokens', 'generation_tokens',
                                                   'finish_reason', 'elapsed_seconds') if k in segment},
                         'proposal': proposal})
    scope = original_assets & selected
    checksum = sha(raw)
    return {'id': 'model-run-' + checksum, 'assetIds': sorted(scope),
            'originalRecordSha256': checksum, 'originalAssetCount': len(original_assets),
            'excludedAssetCount': len(original_assets - selected), 'metadata': metadata,
            'output': {'segments': segments}}


def build_metadata_snapshot(database, package, review, models, inventory, *, expected_count=None,
                            new_draft=False, allow_unapplied_display_plan=False,
                            allow_sparse_annotations=False):
    inputs = Inputs()
    packet, packet_raw = inputs.read(package)
    review_doc, _ = inputs.read(review)
    live, _ = inputs.read(inventory)
    schema, _ = inputs.read(PHOTO_SCHEMA)
    require(packet.get('synthetic') is False and packet.get('selectionConfirmed') is True
            and len(packet.get('objects', [])) == 1, 'PACKAGE_SCOPE_INVALID')
    obj = packet['objects'][0]
    media = obj['media']
    by_asset = unique(media, 'assetId')
    selected = set(by_asset)
    if expected_count is None:
        expected_count = len(review_doc['assetIds'])
    require(len(selected) == expected_count and selected == set(review_doc['assetIds'])
            and len(review_doc['assetIds']) == expected_count
            and [m['position'] for m in media] == list(range(expected_count))
            and all(ID.fullmatch(a) for a in selected), 'PHOTO_SCOPE_INVALID')
    require(review_doc['draft']['targetId'] == obj['objectId'], 'TARGET_MISMATCH')
    catalog, source, oid = obj['catalogId'], obj['sourceId'], obj['objectId']
    draft, docs = live['draft'], live['inventory']['docs']
    require(live['inventory'].get('hasNextPage') is False
            and live['inventory']['totalDocs'] == len(docs) == expected_count,
            'INVENTORY_INCOMPLETE')
    native = unique(docs, 'mediaId')
    require(len({d['id'] for d in docs}) == expected_count
            and {m['mediaId'] for m in media} == set(native)
            and draft['content']['catalogId'] == catalog
            and draft['content']['sourceId'] == source
            and draft['id'] == obj['cmsDraft']['id']
            and draft['revision'] == obj['cmsDraft']['expectedRevision'], 'INVENTORY_TARGET_MISMATCH')
    local = obj['localAnnotations']
    display = local['archiveUploadPlan']['displayMedia']
    planned_display = [{'assetId': x['assetId'], 'mediaId': by_asset[x['assetId']]['mediaId'],
                        'position': x['position'], 'isRepresentative': x['isRepresentative']} for x in display]
    actual_display = draft['content']['media']
    display_ids = [m['mediaId'] for m in actual_display]
    cover = [m['mediaId'] for m in actual_display if m['isRepresentative']]
    require(set(display_ids) <= set(native) and len(display_ids) == len(set(display_ids))
            and len(cover) <= 1, 'DISPLAY_BASELINE_MISMATCH')
    planned_tuple = [(m['mediaId'], m['position'], m['isRepresentative']) for m in planned_display]
    actual_tuple = [(m['mediaId'], m['position'], m['isRepresentative']) for m in actual_display]
    if allow_unapplied_display_plan:
        require(new_draft is True and actual_display == [], 'UNAPPLIED_DISPLAY_NEW_DRAFT_REQUIRED')
    require(not allow_sparse_annotations or new_draft is True, 'SPARSE_ANNOTATIONS_NEW_DRAFT_REQUIRED')
    display_unapplied = planned_tuple != actual_tuple
    require(not display_unapplied or allow_unapplied_display_plan, 'DISPLAY_BASELINE_MISMATCH')
    db = Database(database)
    try:
        annotations = professional(db, selected, oid, schema, allow_sparse=allow_sparse_annotations)
        group_ids = {v['originObjectId'] for v in local['photoRoles'].values()}
        known_assets = {r['id'] for r in db.rows('SELECT id FROM assets')}
        proposals, decisions, groups = history_and_groups(db, selected, group_ids, known_assets)
        current = {r['asset_id']: r for r in annotations['current_annotations']}
        revisions = unique(annotations['annotation_revisions'], 'id')
        membership = unique(db.rows('SELECT oa.asset_id,oa.role,oa.decision_id,d.status '
                                    'FROM object_assets oa JOIN decisions d ON d.id=oa.decision_id '
                                    'WHERE oa.object_id=?', (oid,)), 'asset_id')
        assets = unique(db.rows('SELECT id,sha256 FROM assets'), 'id')
        require(set(membership) == selected, 'CURRENT_MEMBERSHIP_SCOPE_MISMATCH')
        require(all(r['status'] in {'accepted', 'corrected'} for r in membership.values()),
                'NATIVE_MEMBERSHIP_REVIEW_MISSING')
        photos = []
        for item in media:
            aid = item['assetId']; record = native[item['mediaId']]
            ann = revisions[current[aid]['revision_id']] if aid in current else None
            role = local['photoRoles'][aid]
            require(record['catalogId'] == catalog and record['sha256'] == item['uploadedSha256']
                    and assets.get(aid, {}).get('sha256') == item['sourceSha256']
                    and role['role'] == membership[aid]['role']
                    and role['decisionId'] == membership[aid]['decision_id'], 'PHOTO_IDENTITY_MISMATCH')
            processing = {'source': copy.deepcopy(local['sourceProcessingLineage'].get(aid)),
                          'preview': copy.deepcopy(local['previewProcessingLineage'].get(aid))}
            src = processing['source']
            require(src is not None and src['source_sha256'] == item['sourceSha256']
                    and src['output_sha256'] == item['uploadedSha256'], 'DERIVATION_IDENTITY_MISMATCH')
            frame = ann['coordinate_frame'] if ann is not None else None
            if frame is None:
                historic = [r for r in revisions.values() if r['asset_id'] == aid]
                if historic:
                    frame = max(historic, key=lambda r: r['revision'])['coordinate_frame']
            if frame is None:
                frame = local.get('originalFrames', {}).get(aid) or src.get('originalFrame')
            if frame is None:
                frame = {'version': 'artvenn-original-frame/v1', 'assetId': aid,
                         'sourceSha256': item['sourceSha256'], 'coordinateSystem': 'unavailable',
                         'orientationApplied': False}
            validate_frame(frame, aid, item['sourceSha256'])
            if frame['coordinateSystem'] == 'unavailable':
                src['frameRecordStatus'] = 'FRAME_NOT_RECORDED'
            photos.append({'assetId': aid, 'nativeId': record['id'], 'mediaId': record['mediaId'],
                           'sourceSha256': item['sourceSha256'], 'uploadedSha256': item['uploadedSha256'],
                           'derivativeVersion': item['derivativeVersion'], 'position': item['position'],
                           'role': role['role'], 'frame': frame, 'processing': processing})
    finally:
        db.close()
    inputs.files[db.path] = (db.identity, db.checksum)
    snapshots = []
    packet_parent = safe_path(package).parent
    for reference in local['annotationSnapshots']:
        path = safe_path(reference)
        require(path.parent == packet_parent and SNAPSHOT_NAME.fullmatch(path.name),
                'REVIEW_REFERENCE_UNSAFE')
        saved, raw = inputs.read(path)
        annotation = saved['annotation']
        checksum = path.name.rsplit('-', 2)[1]
        require(digest(annotation) == checksum
                or digest({k: v for k, v in annotation.items() if k != 'created_ago'}) == checksum,
                'NATIVE_SNAPSHOT_HASH_MISMATCH')
        task_key = path.name.split('-' + str(annotation['id']) + '-')[0]
        require(isinstance(saved['normalized'], dict), 'NATIVE_NORMALIZED_INVALID')
        snapshots.append({'id': 'native-snapshot-' + sha(raw), 'sourceRecordSha256': sha(raw),
                          'taskKey': task_key, 'annotationId': annotation['id'], 'annotationHash': checksum,
                          'annotation': project(annotation, selected, evidence_assets=known_assets),
                          'normalized': project(saved['normalized'], selected, evidence_assets=known_assets)})
    review_decisions = []
    for source_decision in local['reviewDecisions']:
        parsed = copy.deepcopy(source_decision)
        if isinstance(parsed['value'], str):
            parsed['value'] = parse_json(parsed['value'])
        proposal_kind = next((p['kind'] for p in proposals if p['id'] == parsed['proposal_id']), None)
        require(proposal_kind is not None, 'REVIEW_PROPOSAL_MISSING')
        group = proposal_kind == 'group'
        parsed_value = parsed['value']
        row = project(parsed, selected, evidence_assets=known_assets)
        row['value'] = project(parsed_value, selected, group_membership=group, evidence_assets=known_assets)
        row.update(source_record_sha256=digest(parsed),
                   excluded_asset_count=len(asset_refs(parsed_value, group_membership=group,
                                                       evidence_assets=known_assets) - selected))
        review_decisions.append(row)
    field_provenance = []
    for field in local['fieldProvenance']:
        field = copy.deepcopy(field)
        if isinstance(field['evidence'], str):
            field['evidence'] = parse_json(field['evidence'])
        projected = project(field, selected, evidence_assets=known_assets, strict_evidence=True)
        excluded = asset_refs(field, evidence_assets=known_assets, strict_evidence=True) - selected
        if excluded:
            projected.update(source_record_sha256=digest(field), excluded_asset_count=len(excluded))
        field_provenance.append(projected)
    model_runs = [model_run(*inputs.read(path), selected, known_assets) for path in models]
    unique(model_runs, 'id')
    result = {'schemaVersion': VERSION, 'sourceHashPolicy': 'registry_recorded_not_reverified',
              'publicationPacketSha256': sha(packet_raw), 'catalogId': catalog, 'sourceId': source,
              'objectId': oid, 'draftBaseline': {'id': draft['id'], 'revision': draft['revision'],
              'fingerprint': draft['fingerprint'], 'status': 'draft', 'displayMediaIds': display_ids,
              'coverMediaId': cover[0] if cover else None}, 'review': {'id': review_doc['id'], 'revision': review_doc['revision']},
              'photos': photos, 'sourceGroups': groups, 'annotations': annotations,
              'history': {'proposals': sorted(proposals, key=canonical), 'decisions': sorted(decisions, key=canonical),
              'reviewDecisions': sorted(review_decisions, key=canonical), 'annotationSnapshots': sorted(snapshots, key=canonical),
              'fieldProvenance': sorted(field_provenance, key=canonical),
              'facts': [{'field': k, 'value': v} for k, v in sorted(local['facts'].items())],
              'relationships': project(local['relationships'], selected)},
              'modelRuns': sorted(model_runs, key=canonical)}
    if display_unapplied:
        result['history']['facts'].append({'field': 'plannedDisplay', 'value': {
            'intentOnly': True, 'status': 'DISPLAY_PLAN_NOT_APPLIED', 'displayMedia': planned_display}})
    assert_portable(result)
    require(asset_refs(result) <= selected, 'OUT_OF_SCOPE_ASSET_REFERENCE')
    inputs.check()
    return result


def _verify_existing_snapshot(path, raw):
    """An atomic publish may have an orphaned second hard link after SIGKILL.

    Link count is therefore not a validity test here. The closed, private file
    must be regular, owned, stable and exactly equal to the requested bytes.
    Conflicting old output requires explicit maintenance; it is never removed.
    """
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size == len(raw),
                'EXISTING_SNAPSHOT_INVALID')
        with os.fdopen(descriptor, 'rb') as handle:
            descriptor = None
            content = handle.read(len(raw) + 1)
            after = os.fstat(handle.fileno())
        visible = path.lstat()
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                                 info.st_mode, info.st_uid)
        require(content == raw and identity(before) == identity(after) == identity(visible),
                'EXISTING_SNAPSHOT_INVALID')
    except OSError:
        raise SnapshotError('EXISTING_SNAPSHOT_INVALID') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _sync_snapshot_directory(root):
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_metadata_snapshot(value, output):
    raw = canonical(value)
    checksum = sha(raw)
    root = safe_path(output)
    require(not root.is_symlink() and not any(p.is_symlink() for p in root.parents), 'OUTPUT_UNSAFE')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(root.is_dir() and root.stat().st_uid == os.getuid()
            and not root.stat().st_mode & 0o077, 'OUTPUT_UNSAFE')
    path = root / ('metadata-' + checksum + '.json')
    descriptor, temporary_name = tempfile.mkstemp(prefix='.metadata-write-', dir=root)
    temporary = Path(temporary_name)
    try:
        handle = os.fdopen(descriptor, 'wb')
        descriptor = None
        with handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Both names are in the same directory/filesystem. Unlike replace,
            # link publishes one complete inode and cannot overwrite evidence.
            os.link(temporary, path, follow_symlinks=False)
            replayed = False
        except FileExistsError:
            _verify_existing_snapshot(path, raw)
            replayed = True
        temporary.unlink()
        temporary = None
        _sync_snapshot_directory(root)
        return {'snapshotSha256': checksum, 'path': str(path), 'replayed': replayed}
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary is not None:
            # Clean only this attempt. A killed process's orphan is not scanned,
            # adopted, deleted or treated as a completed snapshot by retries.
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('database', 'package', 'review', 'inventory', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--model', action='append', default=[])
    parser.add_argument('--new-draft', action='store_true')
    parser.add_argument('--allow-unapplied-display-plan', action='store_true')
    parser.add_argument('--allow-sparse-annotations', action='store_true')
    args = parser.parse_args()
    try:
        value = build_metadata_snapshot(args.database, args.package, args.review, args.model, args.inventory,
                                        new_draft=args.new_draft,
                                        allow_unapplied_display_plan=args.allow_unapplied_display_plan,
                                        allow_sparse_annotations=args.allow_sparse_annotations)
        print(json.dumps(write_metadata_snapshot(value, args.output), sort_keys=True))
    except (SnapshotError, sqlite3.Error, OSError, KeyError, TypeError) as error:
        category = str(error) if isinstance(error, SnapshotError) else 'SNAPSHOT_INPUT_INVALID'
        print(json.dumps({'passed': False, 'category': category}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
