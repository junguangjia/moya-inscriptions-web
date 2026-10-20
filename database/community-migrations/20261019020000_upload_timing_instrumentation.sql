-- Content-free upload and processing timing (upload-timing-instrumentation-v1).
-- Additive and nullable: existing rows keep NULL, which reads as "not
-- recorded"; nothing is backfilled or rewritten. The counter defaults are set
-- after the columns exist, so only new rows start at 0. Code released before
-- this migration never names these columns and keeps working unchanged.

-- Claim time of the job's latest attempt. Lease renewal and completion never
-- change it; `attempts` tells a retried claim apart.
ALTER TABLE community.publishing_jobs
  ADD COLUMN started_at TIMESTAMPTZ;

-- Backend-side transfer facts per component: accepted begins (supersede
-- included), the first begin, the first and last body byte of the committed
-- attempt, and retries refused because the component had already committed
-- (an answer lost after the full send).
ALTER TABLE community.media_components
  ADD COLUMN upload_attempts INTEGER,
  ADD COLUMN upload_first_started_at TIMESTAMPTZ,
  ADD COLUMN upload_first_byte_at TIMESTAMPTZ,
  ADD COLUMN upload_last_byte_at TIMESTAMPTZ,
  ADD COLUMN upload_refusals_after_commit INTEGER,
  ADD COLUMN upload_first_refusal_after_commit_at TIMESTAMPTZ;

ALTER TABLE community.media_components
  ALTER COLUMN upload_attempts SET DEFAULT 0,
  ALTER COLUMN upload_refusals_after_commit SET DEFAULT 0,
  ADD CONSTRAINT media_components_upload_counts_nonnegative CHECK (
    (upload_attempts IS NULL OR upload_attempts >= 0)
    AND (upload_refusals_after_commit IS NULL OR upload_refusals_after_commit >= 0)
  ),
  ADD CONSTRAINT media_components_upload_bytes_ordered CHECK (
    upload_last_byte_at IS NULL
    OR (upload_first_byte_at IS NOT NULL AND upload_last_byte_at >= upload_first_byte_at)
  );
