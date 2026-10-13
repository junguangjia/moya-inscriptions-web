# Media pipeline increment 3a — profile renditions release

Issue #270 r1 (`profile-media-renditions-v1`) under Issue #206 r21. One
late-night window releases the migration, contracts, Web, Backend, Admin and
media worker from the tag `media-pipeline-inc3a` with both profile switches off.
Rendering is then turned on in the same window; emission follows at least 72 h
later. The design is in
[Profile images (increment 3a)](../development/unified-media-pipeline-v1.md#profile-images-increment-3a)
and the task record in
[profile-media-renditions-v1](../development/profile-media-renditions-v1.md).

Every Production or release operation in this document, numbered or not, is a
separate operation that needs the Owner's per-action "run", confirmed call by
call. That includes the tag and the GitHub Release (one "run" each), the
read-only measurement, the backfill monitoring reads, the coverage query, the
test-account probes and the HAR acceptance probes. Neither this document nor a
review authorizes any of them. Values such as hosts, roles, release paths and
test accounts stay in protected configuration and private operations records;
this document names none of them.

Increment 3a creates no cloud resource, credential, permission or spending
commitment, and changes neither the product-access mode nor Nginx. Private
storage grows by an estimated less than 1 GB.

## What the release changes

- **Database.** One additive, forward-only migration,
  `20261014010000_profile_media_renditions`, plus its manifest entry. It
  rewrites no row and moves no byte. A new release refuses to start until it is
  applied; the previous release starts with it applied and ignores profile rows.
- **Backend.** The profile rendition read route (always on once deployed),
  `renditions` emission behind `MEDIA_PROFILE_RENDITIONS` (off), and the removal
  of the daily avatar limit, which is live at once and has no switch.
- **Media worker.** `profile_render` jobs and the paced profile sweep, which is
  also the backfill, behind `MEDIA_PROFILE_RENDER` (off). The sandbox renderer
  runs from the release's mounted `dist`, so the sandbox image is not rebuilt.
- **Admin.** The `profile_render` job label. Admin and the operator API parse
  job kinds strictly, so Admin goes live from the same release as the Backend
  and the worker.
- **Web.** The rendition relay and the surfaces that use renditions when an
  answer carries them. With emission off every surface keeps the original image.
- **Contracts.** They change too, so every service is released from the one tag
  (decision D9).
- **Unchanged.** Grants, Nginx, the sandbox image and bounds, worker concurrency
  1, the product-access mode, and work, Catalog and Article media.

## Before the window

1. **Tag and Release (two Owner "run"s).** After the Owner's preview gate, the
   independent review, the expected-head squash merge and merged-head
   verification, create the annotated tag `media-pipeline-inc3a` on the verified
   merged `main` commit (its own "run"), then its GitHub Release (another
   "run"). The merge does not authorize either. Record the commit, the tag
   object and the required CI run.
2. **Private confirmations.**
   - The nightly database dump time. The window must end before it: a running
     dump holds `ACCESS SHARE` locks that the migration would wait on.
   - That the Web-only release procedure cannot carry a contracts change, which
     is why every service releases together.
   - The current per-service release bindings.
3. **Rollback steps, written and tested.**
   - A private, reviewed SQL step that neutralizes `profile_render` job rows,
     tested on disposable PostgreSQL 16 and 18.
   - A private roll-forward step that releases the renditions of profile images
     erased while a previous release ran (that code erases without releasing
     them).
4. **Read-only measurement.** One run on the Production database, with an
   Owner-approved read-capable role, inside a `READ ONLY` transaction with short
   statement and lock timeouts that ends in `ROLLBACK`. It returns counts and
   sizes only, never image bytes, ids or content; PNG sizes come from
   `octet_length`, which does not fetch the bytes. It covers:
   - current avatar and cover pointers by owner status: rows, distinct images,
     total and largest PNG size, and size classes (512 × 512 avatars, covers at
     least 1600 px wide, images under 960 px);
   - live `user_media` rows and bytes;
   - publishing jobs by kind and state, and recent durations of `process_item`,
     `derive_edit` and `catalog_render` jobs;
   - upload jobs per hour (Asia/Shanghai) over the last seven days, to confirm
     the window is quiet;
   - row counts and total sizes of `media_renditions`, `media_blobs`,
     `publishing_jobs`, `user_media` and `public_users`.

   The statement stays in the private records. The counts size the backfill (at
   most 120 jobs an hour, a few seconds each) and the migration's lock exposure.

5. **Probes.** Owner-authorized test accounts, and the 2026-10-13 phone HAR
   baseline for the later comparison.

## The window

A weekday, 01:00–02:30 Asia/Shanghai, ending before the nightly dump (decision
D12). Run the steps in this order. When a check fails, stop and report instead
of improvising; the rollback section applies.

1. **Record the per-service release bindings.** Every service's current release
   target (a shared "current" link alone is not enough for a mixed rollback),
   and the current switch values in each environment file and its staged copy.
   This is the rollback point.
2. **Stop the media worker, the Backend and Admin.** Stop the worker first and
   prepare the tagged release with the established procedure while it is stopped
   (an on-host build needs the worker's memory). Then stop the Backend and
   Admin. While the Backend is down, Web shows "temporarily unavailable".
3. **Verify the target, then back up.** Confirm that the migration target is the
   Production PostgreSQL 16 database, then take a fresh backup and verify it.
4. **Apply the migration** with the migration-privileged role through
   `pnpm db:migrate:community`. It runs as one transaction with
   `SET LOCAL lock_timeout = '5s'` and takes all of its locks first:
   `community.user_media` in `SHARE ROW EXCLUSIVE`, then `media_renditions`,
   `media_blobs` and `publishing_jobs` in `ACCESS EXCLUSIVE`. A failure changes
   nothing. On a lock timeout, find the blocking session read-only and report;
   do not retry until the Owner decides. Confirm that the ledger lists the
   migration.
5. **Re-apply the named runtime grants** in their established order, including
   the private copies. Increment 3a changes no grant, so no difference is
   expected.
6. **Start the Backend and Admin with emission off, then Web; check readiness.**
   `MEDIA_PROFILE_RENDITIONS=off` stays in the Backend environment and its
   staged copy. Activate Web on the new release with the established procedure.
   Readiness confirms the migration ledger. Record the activation time: it
   starts the 72 h wait. Content-free checks with test accounts:
   - every service is active, and the product-access mode is unchanged;
   - profile and people answers carry no `renditions` key;
   - the original image route answers as before (`private, no-cache` with an
     `ETag`);
   - a rendition URL of an image not yet rendered answers `404` with
     `private, no-store`;
   - the Admin job list renders;
   - a test account can change its avatar twice in a row.
7. **Start the media worker off, then on.**
   1. Run the sandbox self-check against the release
      (`node services/backend-production/dist/worker-main.js --sandbox-check`
      under the worker's unit properties).
   2. Start the worker with `MEDIA_PROFILE_RENDER=off` in the worker environment
      and its staged copy. Its ready line ends in `profile=off`. Confirm that a
      normal queued job drains, for example a test account's upload.
   3. Set `MEDIA_PROFILE_RENDER=on` in the worker environment and its staged
      copy, and restart the worker (its own "run"). The ready line ends in
      `profile=on`, and the backfill begins.
   4. Watch three to five sweep passes and the coverage count, and confirm that
      a work upload made during the backfill waits behind at most about 2
      profile jobs.

Leave the backfill running. The window ends here; the
[test-account rendition checks](#test-account-rendition-checks) follow once
their image is rendered, usually after the window.

## Backfill monitoring and stop rules

The sweep runs every 60 s and queues at most 2 jobs per pass. It queues nothing
while 2 or more `profile_render` jobs are open, or while any `process_item`,
`derive_edit` or `catalog_render` job is queued or running. That gives at most
120 jobs an hour, one at a time. An owner has at most one open job, and a pass
queues at most one image per owner. Images are queued by their owner's most
recent public work, newest first; images of owners without public work come
last, in media-id order. A test account's avatar is therefore often rendered
near the end of the backfill, possibly hours after the window.

Watch, content-free (each read an Owner "run"):

- the worker's sweep line,
  `[media-worker] profile sweep missing= blocked= enqueued= requeued= paused=`,
  logged when the counts change;
- coverage (below);
- `profile_render` failures by `last_error_code`;
- the oldest queued wait per job kind;
- rendition bytes per role;
- host CPU and memory, and the worker journal for exit statuses 75 and 78 and
  OOM kills.

Content rejections are final until an operator retries the job in Admin.
Exhausted retryable failures (an unavailable sandbox, store or database, a lost
lease) are queued again a day later. Abandoned jobs block until an operator
acts.

**Stop rules.** Turn rendering off (`MEDIA_PROFILE_RENDER=off` in the worker
environment and its staged copy, then a worker restart, Owner "run") when any of
these happens, and resume only once the cause is explained:

- the oldest queued `process_item` or `derive_edit` job waits longer than 60 s
  because of profile jobs;
- more than 5% of profile jobs fail;
- an OOM kill or memory pressure on the host;
- profile-read errors rise above the baseline.

Emission is still off, so stopping changes nothing users see.

## Test-account rendition checks

Run these once a test account's current avatar is rendered, that is when one
owner probe of its `avatar-128` answers `200` (it answers `404` with
`private, no-store` until then). To avoid repeated probes, wait until the sweep
line shows `missing` equal to `blocked`, when nothing is left to queue or
render. The checks may run after the window. An image that is not rendered yet
is not a failed check and never a reason to stop or roll back.

With test accounts, confirm, in this order:

- the `avatar-128` of the test account's current avatar answers
  `200 image/webp`, a blocked viewer gets `404`, and the account's committed
  capacity is unchanged;
- only then, that account replaces the avatar. The old `avatar-128` URL answers
  `404` to another test account and still answers the owner `200` with
  `private, no-store`.

## Coverage and switch-on

Coverage is the share of current avatar and cover pointers of active users whose
family anchor (`avatar-128`, `background-960`) is ready on a committed blob at
its current recipe version or a later one, the sweep's rule. It is measured
read-only, with a private query; each measurement is an Owner "run".

Switch emission on only when all of these hold:

- at least 72 h since the release activation;
- coverage of at least 95%, with every failure explained;
- the Owner's sign-off on the Development preview;
- real-device checks on WeChat iOS, WeChat Android and one mobile browser.

Procedure (Owner "run"; a quiet hour, no window): set
`MEDIA_PROFILE_RENDITIONS=on` in the Backend environment and its staged copy,
then restart the Backend. Record the switch-on on Issue #206, without a tag.

Acceptance, by phone HAR captures (signed in and signed out, cold cache and
reload) with test accounts, each probe an Owner "run":

- no original-PNG request for feed avatars;
- avatar responses of at most about 10 KB;
- a reload answers with `304`s;
- a replaced avatar's old rendition URL answers `404` to other viewers;
- profile-read errors stay at the baseline.

Record the bytes per role and the before/after comparison.

## Rollback

Use the first step that resolves the problem, in this order. Each step is an
Owner "run".

1. **Emission off.** `MEDIA_PROFILE_RENDITIONS=off` in the Backend environment
   and its staged copy, then a Backend restart. The answers carry no
   `renditions` key again and are otherwise identical to the previous release's,
   except that an owner's own `nextAvatarChangeAt` stays `null`, because the
   avatar-limit removal shipped in the same release. Compare owner reads with
   that in mind. The read route does not depend on the switch, so rendition URLs
   that pages already hold keep working; a page that failed to parse profiles
   recovers on reload.
2. **Worker off.** `MEDIA_PROFILE_RENDER=off` in the worker environment and its
   staged copy, then a worker restart. No new jobs are queued or run; existing
   renditions stay.
3. **Code rollback**, only when the first two are not enough:
   1. Both switches are off in each environment and its staged copy, so a later
      roll-forward starts with them off, and the media worker is stopped.
   2. Neutralize the `profile_render` job rows with the private, reviewed and
      tested step. The previous Backend, operator API and Admin cannot parse
      that job kind.
   3. Restore the recorded per-service release bindings and the previous tag.

   Never migrate down. The additive schema stays, and profile rows and blobs are
   inert under the previous release: its readers select renditions by item or
   Catalog asset only, the publication trigger and edge eligibility refuse them,
   their blobs stay recorded and in use, and owner-less blobs count toward no
   capacity. Never roll Web back below the 3a release while emission is on. The
   previous release re-imposes the daily avatar limit, from the
   `avatar_changed_on` values that 3a keeps writing. Before rolling forward
   again, run the private step that releases the renditions of profile images
   erased in the meantime.

4. **Database restore** only when data were damaged. That is a separate Owner
   decision, never a shortcut for a code rollback.

## Evidence

Acceptance records are content-free: status codes, counts, sizes, shapes and
timings. They never contain image ids, rendition URLs, signed or token URLs,
hostnames or content. Probes use only Owner-authorized test accounts. Results
are recorded on the Issues; private details stay in private operations records.
