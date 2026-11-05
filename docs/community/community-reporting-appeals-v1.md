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

Moderation in the existing pending queues and content/account controls, by a
person or by the operator AI (`ai_operator`, amendment 2026-11-03), must carry a
reason and record a staff-origin decision, affected-user notification and
appeal. Its record names `owner` or `ai-admin`, and nothing else differs. Staff
records have no fabricated reporter. Automated prepared operations retain their
separate authorization and receipt boundary. Overturning a rejected submission
returns only the exact unchanged candidate to its native pending queue; it never
publishes it. A later edit, new candidate, withdrawal, deletion or visibility
change refuses restoration. Publication still requires the existing native
approval and media checks. Existing operator body deletion is irreversible: a
correction changes the decision record and notice, never reconstructs deleted
text. Whole-thread removal is a separate access flag; any restoration preserves
author deletion and other active measures. Each affected author receives a
private decision and appeal record.

## Responsibility and escalation

The Owner and the operator AI receive and review complaints and appeals,
including rights-holder disputes and appeals against the AI's own decisions, and
either may judge the necessity of a forward. The Owner owns urgent on-call
handling. Urgent unlawful-content cases have a separate priority queue and
durable SES notification, including a visible delivery failure. The Owner makes
legally required reports to the competent authority through its official
channel. No tool exists for on-call handling, SES delivery or those reports.
Preserving evidence and protective measures are not the Owner's alone: the
operator AI can set a legal hold and can apply protective measures through a
decision or a moderation write, and the history shows `ai-admin`. Releasing a
legal hold goes through its preview. The AI can set `urgent` and cannot clear
it: `urgent:false` from its credential answers `URGENT_OWNER_ONLY`. Staff must
not publish complaint evidence or forward identity documents indiscriminately.
Ordinary service targets are not statutory deadlines. Rights-holder disputes
require judgment, forwarding notices and counter-statements, delivery tracking,
follow-up and a reasoned restoration decision.

A case on a self-only work or on a comment under one stays with the Owner: the
AI sees that it exists and every write on it answers `SELF_ONLY_OWNER_REVIEW`.
So does a case on a deleted work that still holds its text, which is what the
trash purge leaves. A work erased by its author holds none, and its cases stay
with the AI.

A request to read, correct or delete personal information stays with the Owner,
as the public policy promises. The system treats a report with reason `privacy`
that a user files on their own profile as such a request. The AI may read it,
and every write it attempts on that case, decision, review or metadata, answers
`PERSONAL_INFO_OWNER_REVIEW`, with a fixed hint that it stays in the Owner's
queue. A `privacy` report about someone else is an ordinary case.

This cannot catch a request filed some other way, because nothing else marks
one: under another reason, on someone else's profile, on a work or a comment, as
feedback, or in a description alone. Nor one made while the same user has
another open report on their own profile, which joins that case and keeps its
reason, or one a rights notice later turned into `copyright`. The AI can read
and decide those, and leaving them to the Owner rests on whoever reads the
description. This is an accepted limit, recorded in
`docs/development/admin-mcp-completion-v1.md` section 17.

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
observations, not a new permanent publication authority. A platform response to
a rights claimant is a platform handling result, never a fabricated statement
from an unrelated public account. A person reads no author on it: the record
keeps who sent it, and one sent through the operator AI shows `ai-admin` in the
case's history, never the Owner. Responses the Owner sends keep today's label.

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
