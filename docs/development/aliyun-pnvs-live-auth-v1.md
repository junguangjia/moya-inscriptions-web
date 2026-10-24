# Aliyun PNVS phone authentication

Task `aliyun-pnvs-live-auth-v1` completes the existing Backend-owned identity,
challenge and Session path. The Tencent-hosted Backend calls Dypnsapi
`2017-05-25`; the browser never receives provider credentials. No migration or
new public profile is introduced.

## Configuration

Keep the existing protected authentication lookup, encryption and OTP keys and
their version. Changing them is not part of enabling SMS. For SMS-only:

```dotenv
AUTH_PUBLIC_ENABLED=true
AUTH_PROFILE=email-first
AUTH_EMAIL_PROVIDER=disabled
AUTH_PHONE_PROVIDER=aliyun-dypns
ALIYUN_SMS_SIGN_NAME=REPLACE_ME_CURRENT_AVAILABLE_SIGNATURE
ALIYUN_SMS_TEMPLATE_CODE=100001
ALIYUN_SMS_SCHEME_NAME=artvenn-auth-v1
```

Inject `ALIYUN_ACCESS_KEY_ID` and `ALIYUN_ACCESS_KEY_SECRET` privately on the
Backend. Use a dedicated RAM runtime identity with only
`dypns:SendSmsVerifyCode` and `dypns:CheckSmsVerifyCode` on `Resource: "*"`.
Development MCP permissions belong to a separate identity. Do not put keys,
OTPs, request bodies, signed headers or Session credentials in logs, Git or
browser bundles.

`AUTH_EMAIL_PROVIDER=tencent-ses` enables the existing SES configuration and
delivery. `disabled` skips SES configuration and initialization entirely. An
enabled incomplete provider refuses startup; there is no capture/simulation
fallback. The legacy `email-first` public profile name is retained, while
capabilities and password identifiers reflect the enabled channels.
`password-only` retains its existing disabled-provider/no-delivery-input rule.

Registration remains `closed` unless the existing approved deployment sets
`AUTH_REGISTRATION_MODE=invite-only` and supplies a valid private
`AUTH_REGISTRATION_AGREEMENT_FILE`. Phone registration requires the same
invitation, current agreement version and atomic beta grant as email. Do not
change the product-access allowlist or invitation rules to demonstrate delivery.

| Purpose                | Template setting                          | Default                     |
| ---------------------- | ----------------------------------------- | --------------------------- |
| Sign-in / registration | `ALIYUN_SMS_TEMPLATE_CODE`                | Required; normally `100001` |
| Replace bound phone    | `ALIYUN_SMS_REPLACE_TEMPLATE_CODE`        | `100002`                    |
| Password recovery      | `ALIYUN_SMS_PASSWORD_RESET_TEMPLATE_CODE` | `100003`                    |
| Link new phone         | `ALIYUN_SMS_LINK_TEMPLATE_CODE`           | `100004`                    |
| Verify existing phone  | `ALIYUN_SMS_REAUTH_TEMPLATE_CODE`         | `100005`                    |

Confirm these templates and the current signature in the account before live
use. Explicit empty/invalid overrides refuse startup. The system signature
change notice means an old screenshot alone is not availability evidence.

`ALIYUN_SMS_SCHEME_NAME` is a 1–20 character namespace, not a legacy client-SDK
scheme. The Backend hashes that namespace and its immutable challenge ID into a
20-character provider SchemeName for both send and check. PNVS cannot use a code
issued for another challenge or purpose merely because the phone matches.
`OutId` and provider BizId remain correlation metadata. Keep the namespace
stable during an outstanding challenge; changing it requires new codes.

The wire request uses national phone digits and `CountryCode=86`, JSON string
`{"code":"##code##","min":"5"}`, `CodeType=1`, `CodeLength=6`, `ValidTime=300`,
`Interval=60`, `DuplicatePolicy=1`, `ReturnVerifyCode=false`, and `AutoRetry=0`.
The application enforces cooldown, attempts, expiry, supersession and atomic
consumption. Only the exact response field `Model.VerifyResult === "PASS"`
verifies ownership. HTTP success, `Code=OK`, `Success=true`, OutId or a request
ID never suffices. Unknown transmission is not automatically retried.

## Acceptance and deployment

The release record must distinguish controlled fixtures from live operations. At
source preparation time, real provider/application/Production checks below are
**NOT TESTED**; update the task's release evidence only after execution.

| Check                     | Evidence required                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| Service prerequisites     | Account shows SMS Authentication and Fusion Authentication enabled                            |
| Signature/templates/quota | Current available lists and balance/package quota before sending                              |
| Runtime identity          | Dedicated RAM identity and the two business actions, separate from MCP                        |
| Live provider             | Actual configured integration send, Owner receipt, private OTP entry, Check PASS              |
| Registration/sign-in      | Actual routes/UI, invitation/agreement retained, same user ID and valid Session               |
| Link phone                | Existing usable-factor reauthentication, same user ID, conflicting owner refused              |
| SMS-only                  | Startup and actual phone flow with SES inputs absent                                          |
| Production                | Approved exact tag, configuration delta, deployed revision, health and auth capability checks |

Use at most five initial real sends to the authorized test number. Resolve a
failure before another send. Purchases/recharges require the Owner. Wrong,
expired, cross-purpose, replay, concurrency, rate-limit and network branches use
controlled fixtures rather than repeated chargeable sends. A console send alone
is not application acceptance.

An email-only existing account needs its usable email factor to link its first
phone. Run that acceptance with email+PNVS enabled; test SMS-only separately.
Disabling SES does not authorize bypassing reauthentication or transferring a
phone from another user.

Release steps, after required review/CI and concrete Production authorization:

1. Record the running release/tag, service configuration identities and current
   auth capabilities privately. Prepare the approved annotated tag from merged
   main and the existing verified-release package. No schema change is needed.
2. Verify current services, signature, templates, quota and runtime RAM policy.
   Install only the approved protected Backend configuration delta: enable
   `AUTH_PHONE_PROVIDER=aliyun-dypns` and the verified Aliyun inputs, keeping
   Tencent SES and the existing authentication keys enabled and unchanged.
   Update the agreement only with the Owner-approved revision; otherwise close
   registration during the cutover. Do not change account ownership data.
3. Deploy using the existing protected Production release procedure; restart the
   Backend using its existing service unit. Startup must fail clearly if an
   enabled provider is incomplete. Do not switch the frontend to direct PNVS.
4. Check `/health`, `/v1/community/auth/capabilities` through the normal backend
   boundary, and `/api/community/auth/capabilities` through Web. Confirm only
   the enabled channels, truthful registration availability and the expected
   release.
5. Perform the finite Owner-assisted real acceptance through the existing Web
   routes, recording environment, outcomes and correlation IDs without codes or
   secrets. Confirm linked account ID, verified factor and session behavior.

Rollback: restore the recorded previous release and its protected email-enabled
settings, including `AUTH_PHONE_PROVIDER=disabled`, then restart the existing
Backend unit and recheck health/capabilities. Restore the prior approved
agreement and invitation-only registration only when that original email flow is
verified; keep registration `closed` while uncertain. This deployment does not
roll back to `password-only`. Never delete phone identities, reset keys, rewrite
verification provenance or bypass invitations during rollback. A SMS-only
isolated acceptance configuration must instead restore its own valid prior
settings; disabling its only provider is not a valid OTP configuration.

## Official sources

- [OpenAPI MCP Server and Codex connection](https://help.aliyun.com/zh/openapi/user-guide/openapi-mcp-server-guide)
- [PNVS quickstart](https://help.aliyun.com/zh/pnvs/getting-started/sms-authentication-service-novice-guide)
- [Signature and template console guide](https://help.aliyun.com/zh/pnvs/user-guide/sms-authentication-service)
- [SendSmsVerifyCode](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)
- [CheckSmsVerifyCode](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)
- [System signature change notice](https://help.aliyun.com/zh/pnvs/product-overview/sms-authentication-signature-change-notification)
