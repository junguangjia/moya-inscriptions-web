# Private reporting evidence in COS

This candidate adds an explicitly selected private COS adapter behind the
existing reporting evidence port. It does not provision storage, migrate bytes,
change database schema, deploy, or establish Production acceptance. The database
continues to own reservations, immutable hashes, authorization and legal holds.
No public media URL, direct upload, frontend credential or local spool is added.

A timed-out or otherwise uncertain PUT keeps its pending database reservation:
the provider may commit after the failed response. No immediate compensating
delete or hidden PUT retry runs. An identical later retry may verify the object;
otherwise the existing day-old pending sweep deletes it after the settling
window. A failed retry of an older pending lease preserves that earlier
uncertainty too. Only a first attempt known to have been rejected uses immediate
compensation. Shutdown drains the current bounded evidence operation and starts
no next evidence deletion or case-retention pass.

| Scenario                                  | Development                           | Production                                                                          | Preserved behavior                                                |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| No new storage selection                  | Existing optional filesystem store    | Existing optional filesystem store during staged cutover                            | Existing uploads and retained files stay accessible               |
| Explicit `MOYA_REPORT_EVIDENCE_STORE=cos` | Refused; use synthetic local evidence | Dedicated evidence COS settings required, no directory or media credential fallback | The same service reserves the upload and authorizes every read    |
| Identical retry / conflicting bytes       | Existing immutable file rule          | Conditional private PUT; only exact MIME and byte identity is idempotent            | DB request identity and SHA-256 verification remain authoritative |
| Expiry or legal hold                      | Existing database maintenance         | Same maintenance calls the COS delete implementation                                | No independent object-age expiry bypasses the database hold       |
| COS unavailable or configuration invalid  | No COS access                         | Fail closed; never write or read a substitute local file                            | No silent loss or false successful retention purge                |

## Configuration and permissions

Start with the commented settings in `infra/production/env/backend.env.example`.
Set `MOYA_REPORT_EVIDENCE_STORE=cos` and the independent
`REPORT_EVIDENCE_COS_BUCKET`, `REGION`, `PREFIX`, `SECRET_ID`, `SECRET_KEY`
settings. The prefix is exactly `report-evidence/<lowercase-namespace>/`; only
an existing server-derived `evidence-<32 hex>` identifier may follow it. No
original filename, account identity or arbitrary key is accepted. Set the
request timeout to at most 30000 ms. Temporary credentials require both
`SECURITY_TOKEN` and `CREDENTIAL_EXPIRES_AT` (Unix seconds); each operation also
checks their validity. Configuration is validated before database pools, without
making cloud requests.

Use a distinct restricted identity. Do not reuse Catalog, Admin or UGC media
credentials; no such namespace is read as a fallback, and matching configured
identifiers or keys are refused. Supply credentials through existing protected
Backend configuration only. The object permissions are PutObject, GetObject and
DeleteObject on this prefix only, plus bucket GetBucketVersioning. No list,
public-read grant, CDN, multipart, object ACL management or bucket
administration permission is needed. PUT explicitly selects private ACL, AES256
server-side encryption, no-store and Content-MD5, and forbids overwrite.

The bucket must be private with no public policy and must never have had
versioning enabled. PUT and DELETE verify the unversioned response; enabled,
suspended, missing or malformed state is refused. Otherwise delete markers could
leave retained versions while the database incorrectly records the evidence
purged. Do not install an age-only lifecycle policy for this prefix: legal holds
and reopened cases can extend retention. Database-controlled maintenance is the
deletion authority. Verify actual cloud policy, encryption and anonymous denial
before activation; code configuration does not certify those properties.

## Staged cutover

Keep the current filesystem selection until either no retained evidence exists
or every retained attachment has been copied and verified. No automatic mixed
read or migration runs on Backend startup. Select a private maintenance window
that fences new uploads and retention. Preserve each DB evidence ID, MIME type,
original byte count and SHA-256. The COS object's internal envelope is identical
to the current private file (`MIME + newline + bytes`); the existing DB hash
covers only the attachment bytes. Verify a read of every copied object against
the database metadata, then reconcile the complete retained DB set again before
changing storage selection. Pending reservations and legal holds remain intact.
Do not delete or rewrite metadata to make the copied set appear complete.

Only after that verification, remove `MOYA_REPORT_EVIDENCE_DIRECTORY`, install
the explicit COS selection and restart the Backend through the existing release
procedure. Validate authorized upload/read, same-request retry, tampered bytes,
anonymous/other-account denial, and expiry versus legal hold with synthetic
cases. Observe provider failures and maintenance results. This source candidate
has no real COS credentials and makes no claim those checks ran.

Retire the previous local bytes only after verified cutover and the approved
rollback window. A filesystem rollback requires copying any newly accepted COS
evidence back and verifying the full DB set before switching; pointing an older
binary at the pre-cutover directory alone would lose access to new evidence.
Keep all such copies private and preserve the existing retention clock.

Sensitive evidence still expires 180 days after final closure; ordinary evidence
uses the existing three-year rule, and legal holds prevent expiry. The new
adapter changes no limit, retention rule, case permission, audit fact or public
contract. Deployment archives, development dependencies and build directories
are reproducible outputs and do not belong in this business-evidence prefix.
