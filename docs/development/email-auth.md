# Email-first authentication

Task `email-auth-v1`. Email is the primary login channel. Phone stays on the
same public user, challenge and session system. Payload operator users and Agent
Connection identities are not public accounts.

## Status

| Gate                     | State                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| SOFTWARE IMPLEMENTED     | Yes, in this Draft                                                                        |
| LOCAL FLOW VERIFIED      | Automated service and HTTP tests. Owner visual and device acceptance are pending          |
| PROVIDER CONTRACT TESTED | Tencent SendEmail and Aliyun check mapping, including non-PASS failure, with no live call |
| LIVE DELIVERY NOT TESTED | No Tencent or Aliyun request is made                                                      |
| PRODUCTION NOT ENABLED   | Production refuses local capture, simulation and public auth exposure                     |

## Profiles

`AUTH_PROFILE=full-local` enables local email capture and simulated SMS.
`AUTH_PROFILE=email-first` enables local email and disables phone sending and
completion. Unset leaves the routes unmounted, which is the existing Development
default.

Both profiles use loopback Mailpit. A client header, query or body cannot select
the provider.

## Keys

Three 32-byte keys, base64, versioned by `AUTH_KEY_VERSION`:

- `AUTH_LOOKUP_KEY` — HMAC for identifier lookup and idempotency
- `AUTH_ENCRYPTION_KEY` — AES-256-GCM contact storage
- `AUTH_OTP_KEY` — HMAC for application-generated email and simulated SMS codes

The unique database key is `(kind, lookup_digest)`. Key version is not part of
that key. A trigger refuses mixed lookup-key versions. Rotation rewrites every
digest under the new key in one migration-privileged transaction before the new
key accepts writes. Do not run two versions side by side.

Email lookup lowercases the local-part and the ASCII domain. Delivery keeps the
original local-part, including dots and plus suffixes. Phone storage is E.164.
The live SMS adapter accepts +86 only.

`verification_mode` is `local_capture`, `simulated` or `provider`, stored with
`environment`. Those columns are not updated. A local proof cannot become a
provider verification by changing configuration or `NODE_ENV`.

## Local acceptance

Suggested ports: Web 3460, Backend 3461, Mailpit UI/SMTP 3463/3464,
PostgreSQL 54370. The launcher is `node scripts/email-auth-acceptance.mjs`. It
does not start another task's services.

Open Mailpit, register with an email, read the code from the inbox, and finish
in the UI. Simulated SMS is labeled `SIMULATED SMS — NOT SENT` and is delivered
to `sms@localhost` in the same inbox. Codes are not returned by the API and must
not be copied into Issues, PRs or screenshots.

## Providers, not yet live

Tencent Cloud SES `SendEmail` uses one recipient, `Template.TemplateID` and
`Template.TemplateData` (`code`, `minutes`). The application generates and
checks the email OTP. `MessageId` is delivery metadata only. No CC, BCC or
attachments. SMTP is not the production path.

Aliyun Number Authentication `SendSmsVerifyCode` / `CheckSmsVerifyCode` uses
provider-generated codes (`##code##`), six digits, 300 seconds, resend interval
60 seconds, and `ReturnVerifyCode=false`. Verification succeeds only when
`Model.VerifyResult` is `PASS`. `OutId` is correlation, not an authorization
key. A response that echoes the code is a failure.

Configure later, outside this task:

- `TENCENT_SES_SECRET_ID`, `TENCENT_SES_SECRET_KEY`, `TENCENT_SES_REGION`,
  `TENCENT_SES_FROM`, `TENCENT_SES_TEMPLATE_ID`
- `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, `ALIYUN_SMS_SIGN_NAME`,
  `ALIYUN_SMS_TEMPLATE_CODE`, `ALIYUN_SMS_SCHEME_NAME`

SDK retries stay at one attempt. An unknown timeout is not retried and does not
verify the contact.

## Sessions

`CommunitySessionService.identify` remains the current-user check. Revocation
sets `community.sessions.revoked_at`. Factor replacement and unlinking revoke
other sessions and issue a fresh one for the current device. Ordinary sign-in
does not. Logout revokes the presented session, closes the verify receipt for
that session lineage, and clears the `yoyi-session` cookie. A closed receipt
cannot mint another session. A lost response can still be recovered before
logout, while that session is live. A browser whose session the Backend no
longer accepts (logged out or factor-replaced on another device, expired or
unknown) is treated as signed out: when the Backend refuses that session itself,
the current-user check (`/api/community/me`) and the same-origin community relay
clear the `yoyi-session` cookie, and the relay answers a read as it would for a
signed-out browser, so public content stays readable; a write is refused and not
repeated. A check that cannot reach the Backend never signs out. The login,
registration and account-security pages also work on the plain-HTTP Development
LAN origin used for phone QA, which is not a secure context: their idempotency
keys come from `crypto.getRandomValues`, not `crypto.randomUUID`. Notification
streams and DM admission must treat a failed `identify` as logged out. That
combined check is pending until tracks N and C integrate.

## Database

Migrations `20260922010000` and `20260922011000`. Apply with the community
migration role, then re-apply
`infra/development/work-publishing/grant-runtime.sql` as the database owner.
`20260922011000` gives each failed attempt its own row and records when logout
closes a receipt. Do not apply this to a retained Development database or
TencentDB until a separate instruction. New accounts use ordinary privacy
defaults and do not receive the owner publishing class.

## Rollback

Leave `AUTH_PROFILE` unset and do not set auth variables in production. The new
routes stay unmounted. A forward migration can be corrected only by another
forward migration after it has been applied.
