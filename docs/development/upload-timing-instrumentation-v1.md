# Upload timing instrumentation v1

Task `upload-timing-instrumentation-v1`, Issue #291 r1 (Owner-approved
2026-10-18). Every real upload records the server-side times needed to split it
into phases, so no manual measurement session is needed. Nothing here changes
upload, processing, queue order, retention, outputs, responses or any interface.
All of it is content-free: no ids, names, titles, storage keys, URLs, tokens,
metadata values or bytes.

## What is recorded

### Database (migration `20261019020000`)

| Column                                                  | Written by   | Meaning                                                                                                                      |
| ------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `publishing_jobs.started_at`                            | claim        | claim time of the job's latest attempt; renewal and completion keep it; `attempts` > 1 marks a retried claim                 |
| `media_components.upload_attempts`                      | begin        | accepted transfer begins, supersede included (0 for new rows, NULL before the migration)                                     |
| `media_components.upload_first_started_at`              | first begin  | when the first attempt was accepted                                                                                          |
| `media_components.upload_first_byte_at`                 | commit       | when the media store took the committed attempt's first body chunk (after its own preparation, e.g. the COS multipart start) |
| `media_components.upload_last_byte_at`                  | commit       | when the committed attempt's request body ended                                                                              |
| `media_components.upload_refusals_after_commit`         | refusal note | resends refused (409) after the component had committed: the client lost the answer of a complete upload                     |
| `media_components.upload_first_refusal_after_commit_at` | refusal note | the first such refusal                                                                                                       |

Existing columns provide the remaining times: registration
(`media_items.created_at`), commit (`media_blobs.created_at`), job queued
(`publishing_jobs.created_at`), job finished (`finished_at`), previews ready
(`media_items.ready_at`), HD renditions (`media_renditions.created_at`) and
submit (`work_revisions.submitted_at`). All of them come from the Backend or
worker clock of the same host.

The refusal note is a separate single-row write, made only after
`beginComponentUpload` refused a transfer. It never changes the 409, takes no
actor, holder or item lock, and leaves `updated_at` unchanged. A note failure is
ignored. The note is awaited, so the 409 goes out one small update later; that
keeps the count in step with the answer.

### Backend log line (one per upload attempt that reached the fence)

```text
[publishing-upload] attempt outcome=<committed|cancelled|superseded|too_large|incomplete|aborted|stalled|error|commit_unknown> role=<still|motion|package> mib=<size> first_byte_ms=<ms> last_byte_ms=<ms> store_ms=<ms> commit_ms=<ms>
[publishing-upload] attempt outcome=refused reason=<after_commit since_commit_ms=<ms>|busy|conflict>
```

Milliseconds count from the opened fence (`first_byte_ms`, `last_byte_ms`), from
the last byte to the finished store write (`store_ms`), and from the store write
to the recorded commit (`commit_ms`). `-` means the step was not reached. `busy`
means another transfer of the same component was still streaming in this process
(the 120 s takeover window).

### Media worker log line (one per processed or derived Work job)

```text
[publishing-worker] job timing kind=<process_item|derive_edit> lane=<preview|live|hd|edit> attempt=<n> outcome=<processed|derived> source_mib=<size> input_mp=<megapixels> read_ms=<ms> sandbox_ms=<ms> prepare_ms=<ms> <role>_ms=<ms>... store_ms=<ms> commit_ms=<ms> total_ms=<ms>
```

- `read_ms`: staging the source from the media store into the job directory.
- `sandbox_ms`: the whole container run. This is start-up, decode and render,
  plus the framed transfer back.
- `prepare_ms` and each `<role>_ms`: measured inside the sandbox and carried in
  the optional, strictly validated `timings` field of the manifest. The protocol
  version is unchanged.
  - `prepare_ms` covers container checks, pairing and the decode.
  - Each role covers its render and its file write.
  - `sandbox_ms` minus `prepare_ms` and the roles is container start-up and
    transfer.
- `store_ms`: output probes and derivative uploads.
- `commit_ms`: recording the renditions.
- `total_ms`: the whole handler.

`lane=hd` marks the background `["full"]` derive (the claim's HD priority).
`lane=edit` marks any other derive. Catalog, profile, purge and maintenance jobs
log nothing new.

### nginx upload log (template only)

`infra/production/nginx/yoyi.conf.template` adds the `yoyi_upload` format. The
upload location writes it to `/var/log/nginx/yoyi-upload.log` and keeps its
`yoyi_status` line in the main log. Each upload line has these fields:

- end time, plus `$msec` for millisecond precision;
- `$status` (499: the client closed);
- `$request_completion`;
- request and response bytes;
- `$request_time`;
- upstream status and connect, header and response times.

A test pins the `yoyi_upload` format to times, sizes and outcomes only. The
upload log is not in the `yoyi-traffic` logrotate policy, which names only the
two IP-bearing logs; the host's default nginx rotation covers it.

## Reading the data (Owner-run, read-only)

`infra/production/sql/upload-timing.sql` returns one row per uploaded component
in a UTC window. `upload-timing-summary.sql` returns n, mean, p50, p90 and max
of every phase at the component, static item, Live item and batch levels. Set
`user_id=''` to cover every account, or pass one account to line the rows up
with a screen recording. The run commands are in each file's header.

- The output numbers batches and items and carries no ids.
- Sizes are rounded to 0.1 MiB.
- Each batch's start shows only to the minute.

A Live item renders `full` in its process job and has no HD job, so its
`ready_to_hd_s` is NULL. Each item uses its newest process and HD job row. When
a job was retried, its start is the latest claim, so its wait includes the
earlier attempts and their backoff.

To read the per-role split, read the worker lines for the same window, for
example:

```sh
journalctl -u yoyi-media-worker --since '<utc>' --until '<utc>' -o cat | grep ' job timing '
```

Retention:

- Succeeded job rows are deleted after 7 days (unchanged), so run the report
  within a week.
- Component, item and rendition times stay.
- Rows from before the migration show NULL; nothing is estimated.
- journald retention on the host is not recorded. Check it once with
  `journalctl --disk-usage`.

Lost answers after a full send show up as `refusals_after_commit > 0`, with
`commit_to_refused_resend_s` giving the delay between the commit and the
client's resend. To match the original request, use the nginx upload line at its
end time (status 499 or a short `$request_time` after the upload) and the
Backend `outcome=refused reason=after_commit` line.

## Release (separate, Owner-run)

Order matters: new code writes the new columns, and the App role updates them
only through column grants.

1. Back up the database, verify the backup, and stop the media worker and the
   Backend.
2. Apply community migration `20261019020000` with the migration role. It is
   additive and nullable, with no backfill or rewrite.
   `pnpm db:migrate:community` applies every pending migration in order, so a
   release from `main` also applies any earlier unapplied one (for example
   #299's `20261019010000`) first.
3. Re-apply the runtime grants in their established order, including the private
   copies. `grant-runtime.sql` adds `UPDATE` on the seven new columns.
4. Start the Backend and the media worker from the same tag. Smoke-test one
   upload, and check that both new log lines appear without ids.
5. Optionally render the nginx template privately, then run `nginx -t` and a
   reload, so the upload log starts.

Rollback: the previous release runs unchanged on the migrated schema. It never
names the new columns, so no down-migration is needed. Until this release ships,
a merged `main` carries the unapplied migration. Any Backend or worker release
from `main` must apply it and the grants first.

## Verification

- PostgreSQL integration covers:
  - claim, renew and complete timing;
  - begin, abort, commit and refusal timing;
  - unordered timing being dropped;
  - the App-role grants;
  - the report against a hand-computed fixture.
- Unit tests cover:
  - service timing and log lines (content-free);
  - the manifest timings validator;
  - renderer and processor timings;
  - the worker timing line;
  - the nginx log format pin.
