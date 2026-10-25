# Email invitation registration

This rollout reuses the existing public-user, verification and Session system.
Implementation and local verification do not establish real inbox delivery or
Production activation. Record those results separately in the private rollout
evidence.

## Configuration

Production registration is closed by default. To enable the approved invitation
rollout, configure the private Backend environment:

```dotenv
AUTH_PUBLIC_ENABLED=true
AUTH_PROFILE=email-first
AUTH_EMAIL_PROVIDER=tencent-ses
AUTH_PHONE_PROVIDER=disabled
AUTH_REGISTRATION_MODE=invite-only
AUTH_LEGACY_HANDLE_LOGIN_ENABLED=true
AUTH_REGISTRATION_AGREEMENT_FILE=/etc/yoyi/registration-agreement.json
PRODUCT_ACCESS_MODE=closed-beta
```

Retain the existing authentication keys and their version, access allowlist,
source-relay tokens and ingress configuration. Do not generate replacement keys
as part of this rollout. The agreement is approved plain-text JSON containing
`version`, `title` and `body`, installed as a protected regular file. A draft is
not approved Production material. Missing agreement closes registration; invalid
configured material refuses startup.

Set `TENCENT_SES_ENDPOINT`, `TENCENT_SES_REGION`, `TENCENT_SES_FROM`,
`TENCENT_SES_TEMPLATE_ID`, `TENCENT_SES_SECRET_ID` and `TENCENT_SES_SECRET_KEY`
in protected server configuration. Use the China endpoint and the region of the
actual SES resources. Server delivery identity receives `ses:SendEmail` only;
the setup operator separately manages domains, templates and DNS. Keep all
credentials out of commands, logs, frontend code and tracked files.

## SES preparation

1. Confirm the intended China account, subaccount permissions, service status,
   region and sending quota. Open SES only within the approved account scope.
   Complete any required service agreement or service-role approval at its
   native confirmation boundary.
2. Verify the approved dedicated sender subdomain using the actual MX, SPF, DKIM
   and DMARC values from SES. Preserve unrelated DNS records and retain the
   authentication records after verification.
3. Create the sender address on that domain. Submit the existing
   `docs/development/email-auth/verification.html` or `.txt` template and wait
   for approval. The API substitutes `code` and `minutes` as strings.
4. The application sends one recipient through `SendEmail`, using the approved
   template and `TriggerType: 1`. It does not use SMTP or unreviewed Simple
   content. A MessageId records acceptance, not inbox receipt or ownership.

Official references:
[CAM actions](https://cloud.tencent.com/document/product/598/70009),
[sender configuration](https://cloud.tencent.com/document/product/1288/47454),
[templates](https://cloud.tencent.com/document/product/1288/77251),
[SendEmail](https://cloud.tencent.com/document/api/1288/51034).

## Invitations and access

Use `scripts/manage-registration-invitations.mjs` with a separate operator
environment containing `APP_INVITATION_DATABASE_URL` and, in Production,
`APP_INVITATION_DATABASE_SSL_CA_FILE`. The App runtime role cannot create or
revoke invitations or arbitrarily grant access. Never put the operator database
credential in the Backend runtime environment.

The CLI supports `create`, `status`, `revoke`, `revoke-access` and
`restore-access`. Creation defaults to 20 successful registrations and seven
days; `--max-uses` and `--expires-in-days` override those defaults. Use
`--output-file` for a new private output file. The plaintext code is written
there exclusively with mode `0600`; it is not printed and cannot be recovered
from the database. Share it privately, outside repository records.

Sending, verifying, resending or abandoning a challenge does not reserve a slot.
The registration transaction locks the invitation and commits the account,
redemption, quota and beta grant together. If another user consumes the last
slot first, registration refuses without creating an account. Exact successful
request recovery does not consume another slot.

Code expiry or revocation only stops later registrations. Revoke an account's
access explicitly to remove its existing eligibility. Account revocation wins
over both a file allowlist entry and an invitation grant. An invalid allowlist
file denies everyone; an unavailable database returns unavailable and does not
clear a valid login cookie. All HTTP, notification and Article MCP admission
uses the same policy. Notification streams recheck on the existing heartbeat;
revocation does not recall bytes or signed media links already issued.

## Acceptance and rollback

Before rollout, apply only the missing forward migrations with the independent
migration role and the named App grants. The forward correction
`20261023020000_registration_invitation_xid_cast.sql` replaces the invitation
redemption function so nonzero transaction epochs compare correctly with 32-bit
row `xmin`. Apply it even when the initial invitation migration is already
recorded; keep that original migration and its checksum unchanged. The
replacement preserves the function owner and existing grants. Verify the
migration ledger, effective runtime configuration and Nginx -> Web -> Backend
source-proof chain. The migration runner performs DDL; it is not a read-only
inventory command.

Use task-owned disposable databases for automated quota, concurrency,
transaction rollback, idempotency, invalid invitation and admission-failure
tests. Rate-limit pressure tests use a simulated delivery port. In a narrow
browser or on a phone, complete real QQ and Gmail receipt, verification,
registration, cookie/current-user, product access, logout, password/OTP sign-in
and password-reset journeys. Verify a provisioned handle still signs in. Record
provider acceptance, actual inbox receipt and application outcomes as distinct
evidence. Never save live OTPs or Session credentials in screenshots, logs or
reports.

For routine rollback set `AUTH_REGISTRATION_MODE=closed` and restart the
Backend. Keep email and provisioned-handle login, existing accounts,
invitations, redemptions, keys and schema. Do not use
`AUTH_PUBLIC_ENABLED=false` as the registration stop: it removes all public auth
routes. Reverting to the older password-only deployment also removes email login
and is a separate disruptive recovery operation.
