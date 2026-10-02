"""Selected delta intake, reusing native donor-group review rather than renewing a target."""
import json
import os
from pathlib import Path

from registry import CurationError, digest, private_json, safe_source, stable_id
from presentation import card
from daily import EXTENSIONS, folder_path


def selected_files(source, requested=None):
    source = folder_path(str(source))
    if requested is None:
        requested = []
        for directory, dirs, files in os.walk(source, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not Path(directory, d).is_symlink())
            for name in sorted(files):
                if not name.startswith('.') and Path(name).suffix.lower() in EXTENSIONS:
                    requested.append(str(Path(directory, name).relative_to(source)))
                    if len(requested) > 50:
                        raise CurationError('INTAKE_PHOTO_LIMIT')
    if not isinstance(requested, list) or not 1 <= len(requested) <= 50 or len(set(requested)) != len(requested):
        raise CurationError('INTAKE_SELECTION_INVALID')
    for rel in requested:
        if not isinstance(rel, str) or Path(rel).is_absolute() or '..' in Path(rel).parts or Path(rel).suffix.lower() not in EXTENSIONS:
            raise CurationError('INTAKE_SELECTION_INVALID')
        safe_source(source, source / rel)
    return source, sorted(requested)


def validate_session(registry, session, before_submission=False):
    """The frozen target and selected bytes are checked before any native write."""
    if session.get('mode') != 'incremental/v1':
        return
    from identity import original_path
    from guided_review import snapshot
    intake = session['intake']
    registry.source_verify(intake['batchId'])
    for asset in intake['assetIds']:
        original_path(registry, asset)
    ignored = []
    for row in registry.rows('SELECT a.asset_id,d.task_key FROM object_assets a LEFT JOIN decisions d ON d.id=a.decision_id WHERE a.object_id=?', (intake['targetId'],)):
        if row['asset_id'] in intake['assetIds']:
            if row['task_key'] not in session['taskKeys']:
                raise CurationError('INTAKE_TARGET_STALE')
            ignored.append(row['asset_id'])
    if snapshot(registry, [intake['targetId']], ignored_assets=ignored) != intake['targetBaseline']:
        raise CurationError('INTAKE_TARGET_STALE')


def begin(registry, target_id, source, requested=None, capture_session_id=None):
    from guided_review import FIELDS, persist, project, snapshot, read
    from identity import canonical_asset, asset_synthetic
    from synthetic_fixture import certified
    target = card(registry.db, target_id)
    # A retained candidate code alone is not an already reviewed physical-object identity.
    if not registry.db.execute("SELECT 1 FROM object_assets a JOIN decisions d ON d.id=a.decision_id WHERE a.object_id=? AND d.status IN ('accepted','corrected') LIMIT 1", (target_id,)).fetchone():
        raise CurationError('INTAKE_REVIEWED_TARGET_REQUIRED')
    source, paths = selected_files(source, requested)
    synthetic = certified(source)
    if target['synthetic'] != synthetic:
        raise CurationError('INTAKE_MATERIAL_MISMATCH')
    baseline = snapshot(registry, [target_id])
    batch = registry.inspect(source, limit=50, synthetic=synthetic, incremental=True, selected_paths=paths)
    registry.source_verify(batch)
    selected = [r['asset_id'] for r in registry.rows('SELECT asset_id FROM batch_assets WHERE batch_id=? ORDER BY asset_id', (batch,))]
    if any(not registry.db.execute("SELECT 1 FROM assets WHERE id=? AND status='ready'", (a,)).fetchone() for a in selected):
        raise CurationError('INTAKE_DECODE_INCOMPLETE')
    existing = {canonical_asset(registry, a['asset_id']) for a in registry.rows('SELECT asset_id FROM object_assets WHERE object_id=?', (target_id,))}
    incoming = [a for a in selected if canonical_asset(registry, a) not in existing]
    if capture_session_id:
        from capture_session import read as capture_read, save as capture_save
        from identity import occurrences
        capture = capture_read(registry, capture_session_id)
        ids = [o['id'] for aid in selected for o in occurrences(registry, aid) if o['batch_id'] == batch]
        capture_save(registry, capture_session_id, capture['metadata'], capture['provenance'], expected_revision=capture['revision'], occurrence_ids=ids)
    if not incoming:
        return {'status': 'already_present', 'objectId': target_id, 'occurrencesRetained': len(selected)}
    material = 'synthetic' if all(asset_synthetic(registry, a) for a in incoming) and target['synthetic'] else 'local'
    review_id = digest({'schema': 'incremental/v1', 'target': target_id, 'batch': batch, 'assets': incoming, 'targetBaseline': baseline})[:32]
    file = registry.root / 'state' / ('guided-review-' + review_id + '.json')
    if file.exists():
        session = read(registry, review_id, material)
        validate_session(registry, session, session['state'] == 'draft')
        return project(registry, session)
    donor = stable_id('object', review_id, 'incremental/v1', target_id)
    with registry.db:
        registry.db.execute('INSERT OR IGNORE INTO objects VALUES(?,?,?)', (donor, batch, 'intake:' + review_id))
        registry.propose(batch, donor, 'group', None, incoming, incoming, digest(incoming), 'human-entry/v1', 'incremental/v1')
    donor_card = card(registry.db, donor)
    objects = [target, donor_card]
    photos = [{**a, 'origins': [donor], 'destination': target_id} for a in donor_card['assets']]
    session = {'id': review_id, 'mode': 'incremental/v1', 'material': material, 'objectIds': [target_id, donor],
               'assetIds': incoming, 'objects': [{'id': o['id'], 'code': o['code'], 'name': o['name'], 'photoCount': len(o['assets'])} for o in objects],
               'photos': photos, 'candidates': [], 'baseline': snapshot(registry, [target_id, donor]),
               'draft': {'targetId': target_id, 'workingName': target['workingName'],
                         'fields': {f: {'action': 'skip', 'value': '', 'label': f} for f in FIELDS},
                         'photos': [{'assetId': a['id'], 'destination': target_id, 'role': 'unspecified'} for a in photos]},
               'intake': {'schemaVersion': 1, 'targetId': target_id, 'targetBaseline': baseline, 'batchId': batch,
                          'assetIds': incoming, 'captureSessionId': capture_session_id},
               'revision': 1, 'state': 'draft', 'created': __import__('time').time(), 'taskKeys': []}
    from local_schema import validate
    validate('incremental-intake-v1', session['intake'])
    persist(registry, session)
    private_json(registry.root / 'state' / ('guided-active-' + material + '.json'), {'id': review_id})
    return project(registry, session)
