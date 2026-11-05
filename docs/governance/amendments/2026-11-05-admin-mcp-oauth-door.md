# Owner Amendment — Admin MCP login door

- Status: Signed under the Owner's delegation of 2026-11-05, quoted in
  section 1.
- Effective date: 2026-11-05.
- Authority: Owner instruction of 2026-11-05, quoted in section 1, on Issue
  #355.
- Applies to: Admin and the agent authorization service, in Development and
  Production, for the `ai_operator` identity on `/api/mcp`. This amendment
  authorizes code and migrations. Each Production deployment, credential and
  configuration change stays a separate Owner approval under the 2026-08-24
  amendment; the Owner's words in section 1 give that approval for the release
  that opens this door.
- Record: `docs/development/admin-mcp-completion-v1.md`, section 22.

## 1. Owner instruction

> 设计的太麻烦了，成熟的项目都是怎么对接的，难道不是用管理员账号一登录，获得授权就自动对接上就好了，我不想用这么麻烦的方式，很多管理人员都没有电脑知识

On the amendment itself and on the release, when asked to confirm this text and
to carry out the domain, certificate and EdgeOne settings:

> 你自己判断，完整了就直接推

> 这个也你来做

The Owner's accompanying decisions:

1. An administrator connects an AI tool by adding one address or clicking one
   button, signing in with their usual Admin account, and clicking allow. No key
   is issued to a person.
2. Every account with role `owner` may authorize a tool at the full tool
   profile. No lesser role is needed first.
3. Only tools on a closed list in configuration may connect. The first are
   Claude, Codex and ChatGPT. There is no open client registration and no
   outbound fetch of client metadata.
4. A connection lasts 30 days from last use, and 180 days at most, then needs a
   fresh allow.
5. MCP keys remain for automation and the local companion. People are not
   offered them.

## 2. Rule classification (Constitution section 20)

The rationale for every MODERNIZE below is the Owner's instruction in section 1:
people connect by signing in, and do not handle keys.

| Rule                                                                                                                                                                                | Citation                                                                                       | Class                   | Effect                                                                                                                                                                                        | What stays                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential is a key on `/api/mcp` with 30-day expiry                                                                                                                                | 2026-11-03 section 1 item 8                                                                    | MODERNIZE               | People connect by OAuth with the Admin account. Expiry per decision 4. One-click disconnect stops one connection; the global pause, audit and the path rate limit stay                        | Keys work as signed, for automation and the companion. Clients to verify gain Claude on the web and desktop, and ChatGPT                                               |
| Agent boundary and `artvenn_*` compose only under `NODE_ENV=development`, "including `AGENT_CONNECTIONS_ENABLED` and no Production OAuth"                                           | 2026-11-03 section 2 PRESERVE row; 2026-09-16 "Production"; Behavior Matrix row on `artvenn_*` | MODERNIZE, narrow       | The OAuth provider, consent and connection surface compose in Production behind `ADMIN_MCP_OAUTH_ENABLED`, for the `operator` preset only. This is the separate decision 2026-09-16 calls for | `artvenn_*`, `agent_operations`, the operations view, `AGENT_CONNECTIONS_ENABLED` and the plugin connection path stay Development only. `management` stays unreachable |
| `ai_operator` grants authority only when `_strategy` is `mcp-api-key`; the role is valid only with an MCP key                                                                       | 2026-11-03 section 3; section 2 row on Payload users                                           | MODERNIZE               | Also `mcp-connection`, set only by the door after a consented token is admitted                                                                                                               | JWT and REST keys on that row grant nothing. Never Owner identity                                                                                                      |
| No public CMS management API, with the ruling for a bearer-key `/api/mcp`                                                                                                           | 2026-11-03 section 2 row of that name                                                          | MODERNIZE, narrow       | A consented connection token is also authorized on `/api/mcp`, with a public issuer host beside it, under grant expiry, pause, audit and the path rate limit                                  | No anonymous access and no generic CRUD. Native REST surfaces are unchanged                                                                                            |
| Least privilege: key profiles narrow a near-Owner key where the Owner chooses                                                                                                       | 2026-11-03 section 2 row of that name                                                          | MODERNIZE, narrow       | A connection always has the full profile, by decision 2. Nobody chooses a narrower one per connection                                                                                         | Keys keep their profiles. Database runtime roles stay separate, with new ones for the issuer, consent and resource sides                                               |
| Reserved to an Owner browser session                                                                                                                                                | 2026-11-03 section 4                                                                           | PRESERVE, list extended | Approving, denying, listing and disconnecting AI connections join the list                                                                                                                    | Everything already listed                                                                                                                                              |
| AI clients run under the Owner's own client accounts                                                                                                                                | 2026-11-03 section 2, external AI row                                                          | MODERNIZE               | Under the authorizing administrator's own client account                                                                                                                                      | No model call from Admin or Backend. Before a vendor not named in the public policy joins the list, the policy text changes first                                      |
| Migrations approved                                                                                                                                                                 | 2026-11-03 section 10                                                                          | MODERNIZE, narrow       | Section 5 below                                                                                                                                                                               | No other migration                                                                                                                                                     |
| One connection token path                                                                                                                                                           | Behavior Matrix "Automation key or connection token on /api/mcp"                               | MODERNIZE               | Split, see record                                                                                                                                                                             | Automation unchanged. Development read-only connections unchanged                                                                                                      |
| Constitution sections 1, 3, 7, 19; 2026-08-24; 2026-09-07 confidentiality; 2026-11-03 section 1 apart from item 8, sections 5, 6, 7, 8, 9, 11, and its section 2 row on the Backend |                                                                                                | PRESERVE                | Owner parity, thresholds, sensitive switches, outside-parity list, not-tools list, Backend sole writer, no dependency upgrade                                                                 | Unchanged                                                                                                                                                              |

## 3. What a tool can do

After any owner allows it, a tool acts as `ai_operator` at the full profile: the
parity in 2026-11-03 section 1, with no per-item approval. The consent page says
so in plain words before the click, and names the hostname the browser returns
to, a local tool's loopback hostname included. Content it reads reaches that
tool's model provider. The audit names the AI identity and the administrator who
authorized it, on every call.

An allow counts only in the browser that started the request. The issuer
finishes a consent only with both that browser's provider cookie and a one-time
secret handed to the browser that clicked allow. A cookie without the secret is
refused. A secret without the cookie voids the consent, and a plain page says
so. A stranger who starts a request in their own browser and sends an
administrator the page therefore gets no token from the click.

This does not cover a link that starts a new request in the administrator's own
browser. The code then reaches the tool's own callback, and only the tool's own
state check can refuse it. Whether each hosted tool does is unproven until
tested with two vendor accounts, and the record carries the result. The page
says to click allow only after clicking connect in that tool yourself.

One person and one tool is one connection, so connecting the same tool on a
second computer ends the first.

## 4. Who stops it

Any owner may see and disconnect any connection, and the other owners are told
when one is approved. Pause stops all of them at the next request. A connection
stops when the authorizing account leaves role `owner` or changes its password
in the Admin, and when its tool leaves the list. A revoke that fails during a
password change does not block the change: it is logged, and the connection
stays until someone disconnects it.

## 5. Migrations approved (Constitution section 17, item 3)

Community: `operator` on the three preset checks; the read-only milestone check
replaced by one that still excludes `management`; one column on
`agent_connection_consents` holding the digest of the one-time resume secret;
one fixed function reaping undecided expired consent rows; Production grants for
three new roles.

CMS: `mcp_audit_events` columns `connection_id` and `authorized_by`; one seeded
`users` row with role `ai_operator` and no password.

## 6. Delivery

Independent review of the exact HEAD, then pinned merge. PostgreSQL 16. Code
complete, deployment and live acceptance are recorded separately. Live
acceptance is read-only. No dependency is added or upgraded.

## 7. Documents to correct with this work

`infra/production/README.md`:552-554;
`infra/production/nginx/yoyi.conf.template` comment on the key-only path;
`infra/production/env/admin.env.example` comment on the key door;
`docs/community/agent-connections-v1/integration.md`;
`docs/development/admin-mcp-completion-v1.md`; the comments on the
Development-only gate in `apps/admin/src/agent-connections/composition.ts` and
`services/agent-authorization/src/config.ts`; root `AGENTS.md` active list.
