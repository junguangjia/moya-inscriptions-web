# Media publication Increment 2 — public-mode preparation

Issue #206 r15 records the Owner's choice A. Prepare the publication pipeline
with `MEDIA_PUBLICATION=off` and `MEDIA_PUBLIC_DELIVERY=relay` in Closed Beta.
An intentional public-mode transition is a separate activation step.

The Backend and media worker both enforce the product mode in code. Setting the
two switches to `on`/`edge` while `PRODUCT_ACCESS_MODE=closed-beta` does not
permit new public copies or published URL emission. Existing Work/Article relays
and Catalog's short-lived signed URLs keep their current behavior. Catalog URLs
remain bearer links until expiry; this preparation does not turn them into
per-request session authorization.

The public-mode switches are independent. Publication off stops new copies;
eligible existing copies may still serve when delivery is edge. Withdrawal
continues for ineligible references, and Closed Beta drains any previously
registered public generations. Turning a configuration flag off does not recall
bytes already cached: verify the drain before treating formerly public images as
protected again.

## Release preparation

1. Review the exact candidate diff, migration and App-role grants. Complete
   applicable local validation, required exact-head CI and independent review
   through the existing Cursor Actions question/result workflow.
2. Merge through the existing review gate. Build from that reviewed merged
   `main`, then create the approved annotated `media-pipeline-inc2` milestone
   and GitHub Release. Record the commit, tag object and required CI run.
3. Inventory the live release bindings again immediately before deployment.
   Preserve the later Web output and record each service's release target;
   `/srv/yoyi/current` alone is insufficient for a mixed-release rollback.
4. Obtain a fresh verified database backup and apply only the forward community
   migration and its narrow runtime grants. Keep the old migration checksums
   unchanged. The Public/CMS roles gain no access to publication state. Existing
   Catalog projection read access is reused.
5. Prepare the new release using the existing clone/overlay/build process.
   Rebuild every impacted workspace and app dependency; verify reused outputs
   against the live inventory. Keep sandbox image/isolation settings intact.
6. Activate the reviewed prepared code with Closed Beta and off/relay settings.
   Check all five services, migration-ledger readiness, current admission,
   representative authorized reads and anonymous/expired/revoked behavior.
   Record actual results; a local test is not deployed acceptance.

This preparation creates no publisher credentials, DNS record, permission
expansion or new spending commitment. Such changes require the Owner's specific
approval. Publisher construction is lazy and performs no STS or cloud I/O;
publication is guarded again before source iteration and writes. Prior
registered generations can use configured cleanup access after rollback.

## Publication and withdrawal

Every destination has an immutable database row before any copy. A publication
INSERT trigger admits only ready committed derivative/catalog_derivative
renditions of WebP, JPEG or MP4 bytes. Originals and masters never qualify. Keys
contain random asset and generation identifiers; no source hash or owner
identity enters a public URL.

The worker uses the existing durable queue with independent bounded publication
and withdrawal lanes. Live job/asset leases and `desired_seq` fence each copy
and the final eligibility transaction. Work/Article/user mutations enqueue
reference changes in their existing transaction. Catalog eligibility rejoins the
current published projection; a 60-second reconciler provides its backstop. An
active removal hold excludes the asset across shared references. A hidden
reference alone does not remove another eligible copy.

Copies stream from the existing private rendition store through a separate STS
publisher role into the dedicated private bucket. Single PUT forbids overwrite,
sets the rendition MIME and
`Cache-Control: public, max-age=300, must-revalidate`, and sets no ACL. Source
SHA-256 and destination HEAD length/MD5 ETag are checked before publication.
Readers switch a parent and all its candidates/motion together; incomplete
groups retain their current path.

Withdrawal deletes registered origin objects, submits guarded EdgeOne file
purges, persists task identifiers, waits for completion, and verifies denial
using a bounded GET with `Range: bytes=0-0`. A pre-DNS connect host changes only
the TCP destination: Host, SNI and certificate validation use the configured
published origin. Redirects and unsupported responses fail verification. Only
verified denial marks a generation withdrawn. Three bounded purge attempts
precede an explicit failure record and content-free alert; the one-hour edge TTL
is the documented fallback, not a ten-minute success.

The sweep operates on registered historical generations with Head/Delete. The
approved role cannot list a bucket, so it cannot inventory foreign, unregistered
objects. No bucket-list/versioning permission is added. Daily request usage uses
the existing EdgeOne zone metric, host filter and Beijing plan-month start on
the fourth. Two million requests records a warning; native pacing alarms are
separate and are not changed by this code release.

Beta/off preparation without registered generations schedules no publication
maintenance jobs. Cleanup remains scheduled when any registered generation,
including historical state, exists. Before activating the initial Beta release,
record zero publication generations and zero jobs of the five new kinds.

## Public activation acceptance — deferred during Closed Beta

Use the existing approved published bucket, keyless publisher role and EdgeOne
site configuration only after their access and cost settings are verified.
Before creating public DNS or switching reads, complete A1–A7: eligible-content
cold/warm/conditional reads, warm-cache withdrawal within ten minutes, shared
references, in-flight/restart races, private-path denial, purge-target
rejection, and recorded traffic/request budgets. Test direct hosts, alternate
origins and fallback paths, including GET, HEAD, Range and conditional requests.
Measure the same representative content before and after; report image
performance separately from homepage HTML/JavaScript.

Unsigned CDN delivery is deliberately public. Do not describe it as session
enforcement or perform public-copy acceptance using protected Beta content. Only
after these checks and the intentional public-mode approval may DNS and direct
reads be activated.

## Rollback

Set delivery to relay to restore previous DTO paths, stop new publication and
keep withdrawal/drain running with approved cleanup access. Verify the same
content on the previous path before restoring the recorded service bindings. For
a public-to-Beta transition, verify origin deletion and edge denial for the
previously public generations. Do not claim that a flag revokes cached unsigned
URLs immediately.

Restore exact recorded per-service release bindings; preserve the later Web
release. Keep the additive publication schema and audit state unless a
separately reviewed database rollback is required. Never drop private media,
rewrite old migration checksums or redeploy Increment 1 as a shortcut.

The pre-Increment-2 operator cannot parse the new publication job kinds. Exact
old-code rollback of this initial Beta preparation therefore requires the
recorded empty publication/job state. After public publication has begun, read
rollback uses the reviewed Increment 2 code in off/relay mode while retaining
cleanup and audit state; restoring older code requires a separately reviewed
queue compatibility procedure.

Development uses a task-owned filesystem store and loopback origin. Production
never composes its local byte handler. Production templates default off/relay;
the Web receives fully formed URLs and no provider credentials.
