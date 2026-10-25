# Private operations archive candidate

This document describes the source tool and deployment contract; it does not
establish deployment, archive completion or source deletion. Runtime is Node 24
and built-in modules only. The three modules in a runtime bundle are copied from
the repository's compiled COS signer, bounded HTTPS transport and traffic
summarizer. Build the standalone bundle with
`node scripts/build-ops-archive-bundle.mjs --output <new-directory>` after the
Backend build. Its provenance and manifest bind the exact copied bytes.

Install a root-owned read-only bundle at `/usr/local/lib/yoyi-ops-archive/`
containing `ops_archive.mjs` and `runtime-bundle/`. It does not depend on any
application release, node_modules, package manager or repository checkout.
Validate the actual Node binary path in the candidate service before installing.
The service and timer are candidates and have not been enabled.

## Configuration and private destinations

The explicitly named `/etc/yoyi/ops-archive.env` must be a root-owned regular
file with mode 0600, one link, no symlink, and exactly these four fields:

```dotenv
OPS_ARCHIVE_COS_BUCKET=REPLACE_ME_PRIVATE_OPERATIONS_BUCKET
OPS_ARCHIVE_COS_REGION=REPLACE_ME_REGION
OPS_ARCHIVE_COS_SECRET_ID=REPLACE_ME_DISTINCT_OPERATIONS_ID
OPS_ARCHIVE_COS_SECRET_KEY=REPLACE_ME_DISTINCT_OPERATIONS_KEY
```

Use the dedicated operations identity, not a media, publishing, Admin or report
identity. No ambient environment variable, URL, endpoint or media credential
fallback is accepted. The hostname is derived from the validated bucket/region.
The deployment administrator must verify private bucket policy and the never-
versioned bucket before activation. Runtime needs only PutObject, HeadObject and
GetObject on `ops/*`; no list, delete, public-read, ACL management or bucket
administration operation is called. Every PUT explicitly selects private ACL,
AES256 encryption, Content-MD5, no-store and forbid-overwrite. The only network
methods are single-attempt HTTPS HEAD/PUT/GET with CA/hostname validation; no
redirect or implicit retry is followed. Credentials, signed headers/URLs,
provider bodies and raw errors are not printed or stored in receipts.

Fixed keys match the deployment's approved IAM/lifecycle namespaces:

- Daily backups: `ops/backups/daily/<UTCdate>/<sha256>.pgdump`.
- Other retained migration backups: `ops/backups/milestones/<sha256>.pgdump`.
- Security records: `ops/logs/security/<UTCdate>/<sha256>.jsonl.gz`.
- Traffic summaries: `ops/metrics/traffic/<UTCdate>/<sha256>.json.gz`.

Daily filename dates come from the existing daily backup naming convention;
security/traffic dates come from source mtime in UTC. Hashes cover the actual
uploaded bytes. Source filenames and fingerprints stay only in private local
receipts. The expected remote rules are daily backups 14 days and security 200
days, with milestone backups/aggregate metrics handled separately. COS lifecycle
age starts at object upload, not the source event time; uploading historical
logs is not a claim of exact event-age deletion. No new lifecycle is configured
by this tool. Evaluate historical source dates when retiring old copies.

## Exact inputs and data handling

Only regular, non-symlink, single-link files beneath these exact directories are
considered, with protected ancestors and no group/world-write mode:

- `/var/backups/artvenn-db/*.pgdump`: require the matching `.pgdump.sha256`
  file, validate its exact filename and SHA-256, and require the PGDMP header.
  Sidecars are read as integrity evidence; the verified dump itself is archived
  under its content hash. No operator configuration is included.
- `/var/log/nginx/yoyi-security/yoyi-security.log.1` and numbered `.gz`
  rotations up to 200. Output is a fixed JSONL projection of timestamp, status,
  duration, bytes, method, classified route/client, device exclusion and IP.
  Arbitrary extra fields, raw URI/query, headers, credentials and complaint
  content are discarded. An unrecognized security format is refused. Malformed
  or extension HTTP methods are classified as `OTHER`; their arbitrary method
  text is not copied. Original files are preserved unchanged.
- `/var/log/nginx/yoyi-analytics/yoyi-{access,article-status}.log` plus
  rotations 1–6. Only the existing aggregate function's counts, time range, hour
  buckets, fixed classifications and qualification text are compressed and
  uploaded. No raw IP, UA, path, query, account text or log line enters that
  object.

The current security log is excluded by default. An explicitly invoked
`--security-snapshot` reads a bounded prefix snapshot while retaining its local
canonical file. Active traffic is also a prefix snapshot. Snapshots may overlap;
do not sum cumulative snapshot objects as disjoint intervals or interpret HTTP
requests as page views/people. Appends are allowed during a snapshot;
truncation, inode replacement and changes to a closed input are refused. There
is no source, release, build, dependency, credential-config, directory-recursion
or arbitrary attachment archive operation.

## Verification, bounds and resumption

One file is at most 64 MiB, total input read per run at most 256 MiB (expanded
gzip data is also charged), total runtime 240 seconds and each request at most
15 seconds clamped to the remaining deadline. Backups are processed first in
descending modification time, so the newest recovery point precedes historical
backlog and log work. Inputs/expanded data and upload payloads are bounded. The
CLI has a hard 240-second exit and the service adds an independent 245-second
containment timeout. No subprocess or daemon is launched. Files exceeding a
bound remain intact and produce a category-only partial result; a later run can
process other files after successful receipts are reused.

HEAD precedes PUT. After PUT, HEAD checks size/encryption/hash metadata and a
complete GET verifies the actual content SHA-256 and byte count. Metadata alone
is never treated as content verification. The checksum metadata accepts the
archive writer's `x-cos-meta-archive-sha256` or the reviewed earlier backup
writer's `x-cos-meta-sha256`; either must match the expected content hash, and
the complete GET remains mandatory. Existing objects are never rewritten to
rename metadata. A lost PUT response writes no success receipt and never
triggers source cleanup; the next scheduled run can verify the content-addressed
object with HEAD/GET without another PUT. A matching, previously verified local
fingerprint skips all network operations.

Private receipts live under `/var/lib/yoyi-ops-archive/`, mode 0700 with a 0600
atomic `state.json`. At most 1024 receipts and 1 MiB are retained. Old receipt
eviction can cause re-verification, never a destructive action. Run only one
instance through the oneshot service; a private PID lock refuses concurrent
execution and reaps a complete stale lock only when its PID is absent. A
malformed lock or PID reuse requires operator review rather than guessing. Avoid
concurrent manual invocations. Source-file deletion is always zero.

Run fixtures without network:

```sh
pnpm exec node --test scripts/archive-runtime-data.test.mjs
```

The code-only fixture root and injected transport are unavailable through the
CLI, and a fixture cannot fall through to a real transport. Deployment requires
independent review, actual IAM/private-access checks, host unit validation and a
separately authorized first run. Passing fixtures do not establish those checks.

## Server storage boundaries

Canonical user/product/algorithm events and business metadata stay in remote
PostgreSQL. Private evidence and media bytes belong in independently scoped COS
stores. HTTP traffic summaries are operational observations, never a substitute
for canonical analytics or a claim of eligible users. Existing Owner/test/device
analytics exclusions are unchanged.

The server retains executable runtime, bounded processing files and a small
resumption index. Completed build, migration and failed deployment trees are
regenerable artifacts, not business archives. Retire them only after checking
running/startup/rollback references and shared inodes. Keep current and required
rollback releases; directory size is not reclaimed disk space. Future releases
should use off-host builds and role-specific production dependency closures,
with a recorded retirement policy for failed/superseded trees and old static
chunks. The archiver intentionally never packages source/release trees.

With an empty capability set, the root archive service joins the existing
operations-reader group to read the named private log files. Nginx workers also
need execute/traversal permission on their private log directories for reopen; a
named execute-only ACL can preserve the directory's owner/group/mode. Do not
make private logs world-readable or broadly change system log directory modes.
Archive verification alone does not authorize reducing local or remote
retention.
