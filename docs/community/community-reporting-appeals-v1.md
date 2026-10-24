# Community reporting and appeals v1 — Issue #326

## Approved behavior

Posts and accounts require a reason. Comments and replies expose only a subtle,
accessible flag; clicking submits immediately without a form or inferred reason.
No automatic sanction follows a report. Authentication is required for every
submission. An interrupted login returns to the target without submitting.
Reports, actions, notifications, appeals and corrections remain Backend-owned.
Admin never receives community database access. Private evidence never enters
published media delivery. All development evidence is synthetic.

A formal rights complaint may follow up an existing own report using its saved
case association, including after the content became hidden. This creates a
separate case whenever the original already has a decision, preserving its
history and appeal. It does not make hidden targets generally reportable.

Current human moderation in the existing pending queues and content/account
controls must carry a reason and record a staff-origin decision, affected-user
notification and appeal. Staff records have no fabricated reporter. Automated
prepared operations retain their separate authorization and receipt boundary.
Overturning a rejected submission returns only the exact unchanged candidate to
its native pending queue; it never publishes it. A later edit, new candidate,
withdrawal, deletion or visibility change refuses restoration. Publication still
requires the existing native approval and media checks. Existing operator body
deletion is irreversible: a correction changes the decision record and notice,
never reconstructs deleted text. Whole-thread removal is a separate access flag;
any restoration preserves author deletion and other active measures. Each
affected author receives a private decision and appeal record.

## Responsibility and escalation

The Owner receives and reviews complaints and appeals, owns urgent on-call
handling, and reviews the necessity of every disclosure. Urgent unlawful-content
cases have a separate priority queue and durable SES notification, including a
visible delivery failure. The Owner preserves necessary evidence, applies
appropriate protective measures, and makes legally required reports to the
competent authority through its official channel. Staff must not publish
complaint evidence or forward identity documents indiscriminately. Ordinary
service targets are not statutory deadlines. Rights-holder disputes require
human judgment, forwarding notices and counter-statements, delivery tracking,
follow-up and a reasoned restoration decision.

## Retention

Case and action records: three years after final closure. Sensitive identity and
ownership attachments: 180 days after final closure. Public uploads are always
classified sensitive by the server; a client flag cannot extend their retention.
Reopening clears the closure clock; legal holds prevent expiry until a
documented release. Deletion preserves minimal non-sensitive audit metadata
until its own expiry. Action identifiers, administrators, timestamps and
decision linkage remain immutable. Controlled expiry redacts private free text
and context, preserving only minimal execution and correction authority for
still-effective measures. Normal traffic diagnostics remain on their existing
short retention. The dedicated `yoyi-security` nginx log is rotated daily with
200 retained daily files; size-triggered rotation is not allowed to reduce that
period. Review disk capacity and restricted access before installation. No
plaintext OTP, credential, query string or complaint body belongs in those logs.

## Official editorial content

Official Catalog and Article content stays owned by its existing editorial
workflow. The reporting Backend must never write CMS tables. The Owner uses the
native editorial interface to withdraw or restore such content first. A report
may then record that the same published read verified it unavailable, or verify
publication before correcting that observation. These are time-stamped
observations, not a new permanent publication authority. Platform responses to
rights claimants are labelled as Owner-authored handling results, never as a
fabricated statement from an unrelated public account.

## Production activation checklist

The Owner-approved Backend App-role plan grants reads and inserts on the nine
reporting relations and coarse-location relation, updates only the named mutable
columns, and deletes only cases, evidence, receipts and restriction heads. Case
deletion uses the existing retention cascades. The plan skips an absent
migration family and refuses partial reporting families; reapply after
migration. The trusted Backend role can read private case data to serve
authorized requests; reporter, affected-user and operator access stay separate
at the service boundary. Schema changes, immutable identity/audit rewrites,
other direct deletion and public-user or Payload SQL access remain outside these
grants. Verify the actual restricted role before activation; template
preparation is not Production rollout.

Implementation is not Production acceptance. Before separately authorized
activation, configure the private evidence directory, an offline IP range
library with documented licensing/update source, the Owner urgent mailbox and
SES template, verify actual reminder delivery, install and inspect security-log
rotation on the actual host, and validate with synthetic cases. Keep signing
keys in existing protected server configuration. No real complaints or identity
documents enter Git, PRs, screenshots or fixtures. Public provider disclosures
must reflect the capabilities actually enabled in that release.

## Delivery

Task-owned database and preview only; no retained Development data. Complete
lint, typecheck, relevant tests, builds, exact candidate CI and independent
review. Owner visual acceptance of phone/desktop entry exposure and end-to-end
handling precedes merge. Production changes remain separately authorized.

Integration note: the unmerged reporting migration is named
`20261025010000_reporting_appeals.sql` to avoid the `20261024020000` identifier
already merged for settings feedback. Its SQL bytes and checksum are unchanged.
Retained synthetic targets carrying the earlier PR-only identifier are
preserved; acceptance uses fresh isolated databases. No deployed migration
ledger is rewritten.
