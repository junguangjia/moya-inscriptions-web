-- upload-timing-summary.sql: count, mean, median, 90th percentile and maximum
-- of every phase over the window (component, item and batch levels). The
-- shared CTE is identical to upload-timing.sql (a test keeps them equal).
--
-- Read-only and content-free (upload-timing-instrumentation-v1, Issue #291).
-- Reads every upload item registered in one UTC window, or one account's.
-- Output has no ids, account names, storage keys, hashes, file names, titles,
-- bodies or metadata values: batches and items are numbered, times are
-- seconds since the batch's first registration, and each batch shows only
-- the UTC minute it started.
--
-- INPUTS (psql variables, all required)
--   window_start  UTC timestamptz, e.g. '2026-10-20 00:00:00+00'
--   window_end    UTC timestamptz (exclusive)
--   user_id       one community.public_users id, or '' for every account
--
-- RUN (inside a read-only transaction; the connection is a placeholder)
--   PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' \
--   psql "$READ_ONLY_DATABASE_URL" -X -v ON_ERROR_STOP=1 --csv \
--     -v window_start='<utc>' -v window_end='<utc>' -v user_id='' \
--     -c 'BEGIN READ ONLY' -f <this file> -c 'ROLLBACK'
--
-- RETENTION
--   Succeeded jobs are deleted 7 days after they finish, so the process and
--   HD columns are NULL for older windows. Component and item times stay.
--   Rows created before the instrumentation migration show NULL for the
--   times it added; nothing is estimated.
--
-- WHAT EACH TIME IS (Backend and worker clocks of one host)
--   registered      media_items.created_at: after the client prepared the item
--   first_start     the first accepted transfer begin of the component
--   first_byte      the committed attempt's first body chunk taken by the
--                   media store (after the store's own preparation)
--   last_byte       the committed attempt's request body end
--   committed       media_blobs.created_at: stored and recorded
--   refusals_after_commit / first_refusal_after_commit
--                   resends refused (409) after the component had committed:
--                   the client lost the answer of a complete upload
--   process_*       the item's process_item job: queued, claimed (started)
--                   and finished; static previews, or every Live role
--   ready           previews recorded (static) or everything (Live)
--   hd_*            the base HD derive_edit job (viewer and full); its wait
--                   includes the up-to-30 s hold for siblings still uploading
--   publish-ready   every item of the batch that still counts is ready
--   submitted       the first submit of a work containing the item
--   Per-role render times inside a job are in the media worker's
--   "[publishing-worker] job timing" log lines, not in the database.
WITH params AS (
  SELECT :'window_start'::timestamptz AS w_start,
         :'window_end'::timestamptz AS w_end,
         NULLIF(:'user_id', '') AS user_id
),
items AS (
  SELECT i.id, i.owner_id, i.kind, i.quality_mode, i.state,
         i.created_at, i.ready_at, i.cancelled_at, i.purged_at
  FROM community.media_items i
  CROSS JOIN params p
  WHERE i.source = 'upload'
    AND i.created_at >= p.w_start
    AND i.created_at < p.w_end
    AND (p.user_id IS NULL OR i.owner_id = p.user_id)
),
links AS (
  SELECT it.id AS item_id,
         (SELECT v.work_id
            FROM community.work_revision_items ri
            JOIN community.work_revisions v ON v.id = ri.revision_id
           WHERE ri.item_id = it.id
           ORDER BY v.submitted_at, v.id
           LIMIT 1) AS work_id,
         (SELECT min(v.submitted_at)
            FROM community.work_revision_items ri
            JOIN community.work_revisions v ON v.id = ri.revision_id
           WHERE ri.item_id = it.id) AS submitted_at,
         (SELECT r.holder_kind || ':' || r.holder_id
            FROM community.media_item_refs r
           WHERE r.item_id = it.id AND r.holder_kind IN ('session', 'draft')
           ORDER BY r.holder_kind, r.holder_id
           LIMIT 1) AS holder_key
  FROM items it
),
bursts AS (
  -- Per account, registrations more than 60 s apart start a new burst.
  SELECT g.id,
         sum(g.starts) OVER (PARTITION BY g.owner_id ORDER BY g.created_at, g.id) AS burst_no
  FROM (
    SELECT it.id, it.owner_id, it.created_at,
           CASE WHEN it.created_at - lag(it.created_at)
                       OVER (PARTITION BY it.owner_id ORDER BY it.created_at, it.id)
                     <= interval '60 seconds'
                THEN 0 ELSE 1 END AS starts
    FROM items it
  ) g
),
batches AS (
  -- A batch is the submitted work, else the attached session or draft, else
  -- the account's registration burst.
  SELECT it.id AS item_id,
         it.owner_id || '|' || COALESCE('work:' || l.work_id, l.holder_key,
                                        'burst:' || b.burst_no) AS batch_key
  FROM items it
  JOIN links l ON l.item_id = it.id
  JOIN bursts b ON b.id = it.id
),
comps AS (
  SELECT c.item_id, bt.batch_key, c.role, c.declared_type, c.declared_bytes,
         c.received_bytes, c.state AS component_state,
         c.upload_attempts, c.upload_first_started_at, c.upload_first_byte_at,
         c.upload_last_byte_at, c.upload_refusals_after_commit,
         c.upload_first_refusal_after_commit_at, bl.created_at AS committed_at
  FROM community.media_components c
  JOIN batches bt ON bt.item_id = c.item_id
  LEFT JOIN community.media_blobs bl ON bl.id = c.blob_id
),
proc AS (
  SELECT DISTINCT ON (j.subject_id)
         j.subject_id AS item_id, j.attempts, j.created_at, j.started_at, j.finished_at
  FROM community.publishing_jobs j
  JOIN items it ON it.id = j.subject_id
  WHERE j.kind = 'process_item'
  ORDER BY j.subject_id, j.created_at DESC, j.id
),
hd AS (
  SELECT DISTINCT ON (j.subject_id)
         j.subject_id AS item_id, j.attempts, j.created_at, j.started_at, j.finished_at
  FROM community.publishing_jobs j
  JOIN items it ON it.id = j.subject_id
  WHERE j.kind = 'derive_edit'
    AND j.payload ->> 'editKey' = 'base'
    AND j.payload -> 'variants' = '["full"]'::jsonb
  ORDER BY j.subject_id, j.created_at, j.id
),
rend AS (
  SELECT r.item_id,
         min(r.created_at) FILTER (WHERE r.role = 'full') AS full_at,
         min(r.created_at) FILTER (WHERE r.role = 'viewer') AS viewer_at,
         min(r.created_at) FILTER (WHERE r.role = 'motion') AS motion_at
  FROM community.media_renditions r
  JOIN items it ON it.id = r.item_id
  WHERE r.edit_key = 'base'
  GROUP BY r.item_id
),
item_frame AS (
  SELECT it.*, bt.batch_key, l.submitted_at,
         row_number() OVER (PARTITION BY bt.batch_key ORDER BY it.created_at, it.id) AS item_no,
         (SELECT max(c.committed_at) FROM comps c WHERE c.item_id = it.id) AS last_commit_at,
         pr.attempts AS process_attempts, pr.created_at AS process_queued_at,
         pr.started_at AS process_started_at, pr.finished_at AS process_finished_at,
         h.attempts AS hd_attempts, h.created_at AS hd_queued_at,
         h.started_at AS hd_started_at, h.finished_at AS hd_finished_at,
         rd.full_at, rd.viewer_at, rd.motion_at
  FROM items it
  JOIN batches bt ON bt.item_id = it.id
  JOIN links l ON l.item_id = it.id
  LEFT JOIN proc pr ON pr.item_id = it.id
  LEFT JOIN hd h ON h.item_id = it.id
  LEFT JOIN rend rd ON rd.item_id = it.id
),
batch_agg AS (
  SELECT f.batch_key,
         dense_rank() OVER (ORDER BY min(f.created_at), f.batch_key) AS batch_no,
         count(*) AS batch_items,
         min(f.created_at) AS t0,
         -- Publish-ready: every item that still counts has its previews.
         CASE WHEN bool_and(f.ready_at IS NOT NULL OR f.state IN ('cancelled', 'purged'))
              THEN max(f.ready_at) END AS publish_ready_at,
         max(f.hd_finished_at) AS last_hd_at,
         min(f.submitted_at) AS submitted_at
  FROM item_frame f
  GROUP BY f.batch_key
),
batch_bytes AS (
  SELECT c.batch_key,
         sum(c.received_bytes) FILTER (WHERE c.committed_at IS NOT NULL) AS bytes,
         sum(c.received_bytes) FILTER (WHERE c.upload_last_byte_at IS NOT NULL) AS timed_bytes,
         min(c.upload_first_byte_at) AS first_byte_at,
         max(c.upload_last_byte_at) AS last_byte_at,
         max(c.committed_at) AS last_commit_at
  FROM comps c
  GROUP BY c.batch_key
),
component_rows AS (
  SELECT
    ba.batch_no,
    f.item_no,
    c.role AS component,
    (f.kind = 'live') AS live,
    f.quality_mode,
    c.declared_type,
    c.declared_bytes,
    c.received_bytes,
    f.state AS item_state,
    c.component_state,
    to_char(date_trunc('minute', ba.t0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS batch_start_minute_utc,
    -- Event times, seconds since the batch's first registration.
    round(extract(epoch FROM (f.created_at - ba.t0)), 3) AS registered_s,
    round(extract(epoch FROM (c.upload_first_started_at - ba.t0)), 3) AS first_start_s,
    round(extract(epoch FROM (c.upload_first_byte_at - ba.t0)), 3) AS first_byte_s,
    round(extract(epoch FROM (c.upload_last_byte_at - ba.t0)), 3) AS last_byte_s,
    round(extract(epoch FROM (c.committed_at - ba.t0)), 3) AS committed_s,
    c.upload_attempts,
    c.upload_refusals_after_commit AS refusals_after_commit,
    round(extract(epoch FROM (c.upload_first_refusal_after_commit_at - ba.t0)), 3) AS first_refusal_after_commit_s,
    round(extract(epoch FROM (f.process_queued_at - ba.t0)), 3) AS process_queued_s,
    round(extract(epoch FROM (f.process_started_at - ba.t0)), 3) AS process_started_s,
    round(extract(epoch FROM (f.process_finished_at - ba.t0)), 3) AS process_finished_s,
    f.process_attempts,
    round(extract(epoch FROM (f.ready_at - ba.t0)), 3) AS ready_s,
    round(extract(epoch FROM (f.motion_at - ba.t0)), 3) AS motion_s,
    round(extract(epoch FROM (f.hd_queued_at - ba.t0)), 3) AS hd_queued_s,
    round(extract(epoch FROM (f.hd_started_at - ba.t0)), 3) AS hd_started_s,
    round(extract(epoch FROM (f.hd_finished_at - ba.t0)), 3) AS hd_finished_s,
    f.hd_attempts,
    round(extract(epoch FROM (f.viewer_at - ba.t0)), 3) AS viewer_s,
    round(extract(epoch FROM (f.full_at - ba.t0)), 3) AS full_s,
    round(extract(epoch FROM (f.submitted_at - ba.t0)), 3) AS submitted_s,
    -- Phases in seconds.
    round(extract(epoch FROM (c.upload_first_started_at - f.created_at)), 3) AS wait_before_transfer_s,
    round(extract(epoch FROM (c.upload_first_byte_at - c.upload_first_started_at)), 3) AS start_to_final_first_byte_s,
    round(extract(epoch FROM (c.upload_last_byte_at - c.upload_first_byte_at)), 3) AS transfer_s,
    round(extract(epoch FROM (c.committed_at - c.upload_last_byte_at)), 3) AS store_commit_s,
    round(8 * c.received_bytes
          / NULLIF(extract(epoch FROM (c.upload_last_byte_at - c.upload_first_byte_at)), 0) / 1e6, 2)
      AS transfer_mbps,
    round(extract(epoch FROM (c.upload_first_refusal_after_commit_at - c.committed_at)), 3) AS commit_to_refused_resend_s,
    round(extract(epoch FROM (f.process_started_at - f.process_queued_at)), 3) AS process_wait_s,
    round(extract(epoch FROM (f.process_finished_at - f.process_started_at)), 3) AS process_run_s,
    round(extract(epoch FROM (f.ready_at - f.last_commit_at)), 3) AS commit_to_ready_s,
    round(extract(epoch FROM (f.hd_started_at - f.hd_queued_at)), 3) AS hd_wait_s,
    round(extract(epoch FROM (f.hd_finished_at - f.hd_started_at)), 3) AS hd_run_s,
    round(extract(epoch FROM (f.full_at - f.ready_at)), 3) AS ready_to_hd_s,
    -- Batch milestones and rates.
    ba.batch_items,
    bb.bytes AS batch_bytes,
    round(extract(epoch FROM (bb.first_byte_at - ba.t0)), 3) AS batch_first_byte_s,
    round(extract(epoch FROM (bb.last_byte_at - ba.t0)), 3) AS batch_last_byte_s,
    round(extract(epoch FROM (bb.last_commit_at - ba.t0)), 3) AS batch_last_commit_s,
    round(extract(epoch FROM (ba.publish_ready_at - ba.t0)), 3) AS batch_publish_ready_s,
    round(extract(epoch FROM (ba.last_hd_at - ba.t0)), 3) AS batch_last_hd_s,
    round(extract(epoch FROM (ba.submitted_at - ba.t0)), 3) AS batch_submitted_s,
    round(8 * bb.timed_bytes
          / NULLIF(extract(epoch FROM (bb.last_byte_at - bb.first_byte_at)), 0) / 1e6, 2)
      AS batch_transfer_mbps
  FROM item_frame f
  JOIN comps c ON c.item_id = f.id
  JOIN batch_agg ba ON ba.batch_key = f.batch_key
  JOIN batch_bytes bb ON bb.batch_key = f.batch_key
)
-- END OF SHARED TIMING CTE
, item_rows AS (
  SELECT DISTINCT ON (batch_no, item_no) *
  FROM component_rows
  ORDER BY batch_no, item_no
),
batch_rows AS (
  SELECT DISTINCT ON (batch_no) *
  FROM component_rows
  ORDER BY batch_no
),
phases AS (
  SELECT 1 AS level_order, 'component' AS level, v.phase_order, v.phase, v.value
  FROM component_rows r
  CROSS JOIN LATERAL (VALUES
    (1, 'wait_before_transfer_s', r.wait_before_transfer_s),
    (2, 'start_to_final_first_byte_s', r.start_to_final_first_byte_s),
    (3, 'transfer_s', r.transfer_s),
    (4, 'store_commit_s', r.store_commit_s),
    (5, 'transfer_mbps', r.transfer_mbps),
    (6, 'resent_share', (r.upload_attempts > 1)::int::numeric),
    (7, 'refused_after_commit_share', (r.refusals_after_commit > 0)::int::numeric),
    (8, 'commit_to_refused_resend_s', r.commit_to_refused_resend_s)
  ) AS v(phase_order, phase, value)
  UNION ALL
  SELECT 2, 'item', v.phase_order, v.phase, v.value
  FROM item_rows r
  CROSS JOIN LATERAL (VALUES
    (1, 'process_wait_s', r.process_wait_s),
    (2, 'process_run_s', r.process_run_s),
    (3, 'commit_to_ready_s', r.commit_to_ready_s),
    (4, 'hd_wait_s', r.hd_wait_s),
    (5, 'hd_run_s', r.hd_run_s),
    (6, 'ready_to_hd_s', r.ready_to_hd_s),
    (7, 'process_retried_share', (r.process_attempts > 1)::int::numeric)
  ) AS v(phase_order, phase, value)
  UNION ALL
  SELECT 3, 'batch', v.phase_order, v.phase, v.value
  FROM batch_rows r
  CROSS JOIN LATERAL (VALUES
    (1, 'batch_items', r.batch_items::numeric),
    (2, 'batch_mib', round(r.batch_bytes / 1048576.0, 1)),
    (3, 'batch_first_byte_s', r.batch_first_byte_s),
    (4, 'batch_last_byte_s', r.batch_last_byte_s),
    (5, 'batch_last_commit_s', r.batch_last_commit_s),
    (6, 'batch_publish_ready_s', r.batch_publish_ready_s),
    (7, 'batch_last_hd_s', r.batch_last_hd_s),
    (8, 'batch_submitted_s', r.batch_submitted_s),
    (9, 'batch_transfer_mbps', r.batch_transfer_mbps)
  ) AS v(phase_order, phase, value)
)
SELECT level,
       phase,
       count(value) AS n,
       round(avg(value), 3) AS mean,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY value))::numeric, 3) AS p50,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY value))::numeric, 3) AS p90,
       max(value) AS max
FROM phases
GROUP BY level_order, level, phase_order, phase
ORDER BY level_order, phase_order;
