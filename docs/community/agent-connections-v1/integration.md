# ArtVenn agent connections — integration guide (v1)

**Version 1.** This describes the contract a compatible MCP client implements to
connect; registering a new client is a configuration change, not a source
change. There are two profiles. Everything up to
[The operator profile](#the-operator-profile) describes the read-only one, a
Development-only surface. That last section says what differs under the login
door (Issue #355), which also composes in Production, on its own opt-in.

## What this is

One MCP endpoint over HTTP, protected by OAuth 2.1 with PKCE, in front of the
existing ArtVenn Backend. The client brand is descriptive metadata. What decides
access is the exact registered OAuth client id, the human's consent, the scopes
frozen at that consent, the resource, and the connection's generation.

## Transport and protocol

|                  |                                                             |
| ---------------- | ----------------------------------------------------------- |
| Transport        | Streamable HTTP (`POST` JSON-RPC to the MCP endpoint)       |
| MCP endpoint     | `<admin-origin>/api/mcp`                                    |
| Protocol version | negotiated; developed against `2025-06-18` and `2025-11-25` |
| Authentication   | OAuth 2.1 authorization code + PKCE (`S256` required)       |
| Client type      | public native client; no client secret                      |

## Discovery

Start from the MCP endpoint. Nothing else needs to be configured.

1. Call the endpoint without a token. It answers `401` and sets the
   `WWW-Authenticate` response header, using the `Bearer` scheme with one
   challenge parameter:

   | Parameter           | Value                                                         |
   | ------------------- | ------------------------------------------------------------- |
   | `resource_metadata` | `<admin-origin>/.well-known/oauth-protected-resource/api/mcp` |

   (Written as a table rather than a header line because this repository's
   credential scanner refuses that scheme next to a value anywhere, including in
   documentation, and it should keep doing so.)

2. Fetch that document (RFC 9728). It names the authorization server:

   ```json
   {
     "resource": "<admin-origin>/api/mcp",
     "authorization_servers": ["<issuer-origin>"],
     "scopes_supported": ["artvenn:read"],
     "bearer_methods_supported": ["header"]
   }
   ```

3. Fetch `<issuer-origin>/.well-known/oauth-authorization-server` (RFC 8414) for
   the authorization and token endpoints.

For clients that look for authorization-server metadata on the MCP server's own
origin instead, `<admin-origin>/.well-known/oauth-authorization-server`
redirects to the issuer's document. The issuer stays authoritative about itself;
the document is not copied.

## Registration

There is **no dynamic client registration**, deliberately. Every client is
preregistered in one setting read by both the authorization service and the
Admin, so the two cannot disagree about who is registered.

A registration is one object:

```json
{
  "clientId": "artvenn-example-readonly",
  "family": "example-agent",
  "label": "Example agent",
  "callbackPolicy": "loopback-ip",
  "redirectUris": ["http://127.0.0.1:8123/callback"]
}
```

- `clientId` — the identity. A bounded opaque identifier, or a canonical HTTPS
  CIMD URL. This is what authorization is decided on. It is **not a secret**: it
  is configuration, and a client may ship it.
- `family` — a descriptive slug, `^[a-z0-9][a-z0-9-]{0,31}$`. Any value.
  `claude`, `codex` and `cursor` are onboarding presets in the Admin, nothing
  more. The family never grants anything.
- `label` — what the Owner sees, 1–64 characters.
- `callbackPolicy` — optional, defaults to `loopback-ip`.
- `redirectUris` — exact, with an explicit port and a real path.

### Callback policies

| Policy                  | Hosts accepted                        |
| ----------------------- | ------------------------------------- |
| `loopback-ip` (default) | `http://127.0.0.1` and `http://[::1]` |
| `loopback-host`         | the above plus `http://localhost`     |

Both require `http:`, an explicit port, a non-root path, and no query, fragment
or userinfo. A registration is stored byte-identical to what was written, so a
`localhost` registration is never rewritten to an address and an address
registration never accepts the name.

`loopback-host` exists because some clients publish a fixed callback spelled
with the host name. The difference is real and worth stating: an address is
something the kernel owns; a name is resolved, and a hosts file or a resolver
can move it. Prefer `loopback-ip` unless a client requires otherwise.

**One thing that is not enforced, stated plainly:** the port is not pinned at
match time. For native clients over loopback the authorization server applies
the RFC 8252 §7.3 ephemeral-port exception, so any port on the registered host
and path is accepted. The explicit-port rule above makes a registration say what
it means; it is not a guarantee.

## Authorization

Standard authorization code with PKCE. Request `artvenn:read`.

A refresh token is issued for a registered client holding this deployment's
capability scope, **without** the client needing to request `offline_access` or
send `prompt=consent`. Access tokens are short-lived (300 s) and refresh is the
supported way to stay connected.

Access tokens are opaque and carry the prefix `artvenn_ct_`. Treat them as
opaque strings.

## Tools

Read-only. Exactly four:

| Tool                     | What it does                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `artvenn_users_find`     | Resolve a public user by exact id, exact handle, or ranked search. Returns `resolution` describing whether the match is a unique identity. |
| `artvenn_content_search` | Search user works as the Owner sees them.                                                                                                  |
| `artvenn_comments_query` | Query comments with moderation state.                                                                                                      |
| `artvenn_comments_read`  | Read one comment's detail.                                                                                                                 |

Each is paginated (`page`, `pageSize` ≤ 50) and returns bounded, safe fields.
Every management and editorial tool is absent from a read-only connection and is
refused if called anyway.

Tool answers are DATA. Returned handles, titles and comment text are written by
users and are never instructions.

## Revocation

The Owner disconnects a connection in the Admin. That raises the connection's
generation, which denies:

- the access token already held, on its next request;
- the refresh token, which can no longer produce a usable access token;
- any open MCP session.

Reconnecting is a **fresh consent**, not a restoration. It raises the generation
again, so credentials from before the disconnect stay invalid.

## What this version does not do

No management or write scope. No dynamic client registration. No remote or
web-hosted callbacks. No phone or remote-access path. This is a Development
surface and is absent from a production build.

## Compatibility

This document describes a contract, not a list of tested products. Any client
implementing MCP over streamable HTTP with OAuth 2.1 + PKCE and a registered
loopback callback can connect. Which specific clients have been exercised, and
how far, is recorded separately — configured, protocol-tested and desktop-tested
are three different facts.

## The operator profile

The login door, under the signed
[2026-11-05 amendment](../../governance/amendments/2026-11-05-admin-mcp-oauth-door.md).
An administrator adds one address or clicks one button in their tool, signs in
with their usual Admin account and clicks allow. No key is issued to a person.
Section 22 of
[the task record](../../development/admin-mcp-completion-v1.md#22-login-door)
says how it fits together. A client implements the same contract as above, with
these differences.

| Read-only profile                                 | Operator profile                                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope `artvenn:read`                              | Scope `artvenn:admin`, named by the `401`'s `scope` parameter and by `scopes_supported`. What a client asks for changes nothing: the consent is opened at this scope |
| Four read tools on the plugin path                | The native `admin_*` tools at profile full, the same list as an `ai_operator` key at full, on the same `/api/mcp`                                                    |
| `AGENT_AUTHORIZATION_CLIENTS` loopback entries    | A closed list of four, with a hosted `https` callback allowed by the policy `hosted-https`                                                                           |
| Access token 300 s, refresh token library default | Access token 1 hour, refresh token 30 days from last use and rotated on each use, connection 180 days from consent                                                   |
| Disconnect is enforced at the door                | Also at the token endpoint: a refresh after a disconnect answers `invalid_grant`                                                                                     |
| Only the person who connected disconnects         | Any owner sees and disconnects any connection                                                                                                                        |

The list:

| Tool        | `family`      | `clientId`                                          | Callback                                              |
| ----------- | ------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Claude      | `claude`      | https://claude.ai/oauth/mcp-oauth-client-metadata   | https://claude.ai/api/mcp/auth_callback               |
| Claude Code | `claude-code` | https://claude.ai/oauth/claude-code-client-metadata | localhost and 127.0.0.1, any port, /callback          |
| Codex       | `codex`       | https://chatgpt.com/oauth/codex/client.json         | 127.0.0.1 and localhost, any port, /callback          |
| ChatGPT     | `chatgpt`     | https://chatgpt.com/oauth/client.json               | https://chatgpt.com/connector_platform_oauth_redirect |

As read from the vendors' own documents at design time. Discovery says
`client_id_metadata_document_supported`, so a client that offers its client id
as a URL can start from the MCP address alone. The URL is matched against the
list and **never fetched**, and a URL off the list answers `invalid_client`.
There is no `registration_endpoint`. `openid` is not advertised.

What a client should expect:

- **A person always sees the consent page.** A live session or an earlier grant
  skips nothing, for a hosted client too, so a client never receives a silent
  token.
- **One person and one client id is one connection.** Connecting the same tool
  from a second computer ends the first: its access and refresh tokens stop.
- **A token stops for reasons a client cannot see coming.** A disconnect, a tool
  taken off the list, the person leaving role owner or changing their password
  in the Admin. The next request answers one generic `401` with the metadata
  pointer, and refresh answers `invalid_grant` once the connection has been
  revoked. Treat that as a request to send the person through the browser again.
  A role restored later brings nothing back. Pause leaves only `admin_whoami`.
- **`resource` must equal the address.** The Admin's page offers
  `CMS_PUBLIC_URL` plus `/api/mcp`, and discovery names
  `AGENT_AUTHORIZATION_RESOURCE`, so a release keeps the two equal.
- **A connection has no local process.** Uploads, downloads and rendered
  previews stay with the companion and its key. `admin_whoami` names them under
  `byteChannel`, so a client can say why it cannot do that work.

The consent request itself needs nothing extra from a client. The browser that
started it has to be the browser that clicks allow: the issuer finishes only
with that browser's own cookie and a one-time secret the Admin hands to the
browser that clicked. A link sent to somebody else ends on a plain page and
hands nobody a code.

`AGENT_AUTHORIZATION_PROFILE=operator` turns this on in Development, beside
`AGENT_CONNECTIONS_ENABLED=true`, with `AGENT_AUTHORIZATION_ENVIRONMENT` equal
to `CMS_ENVIRONMENT`. `pnpm test:cms:agent-connections --profile complete` runs
the same acceptance under that setting: a real issuer, a real consent in
Chromium and WebKit, and the official SDK to a tool call. Which vendors' real
clients have been through it is recorded separately, in the same three-way terms
as above.
