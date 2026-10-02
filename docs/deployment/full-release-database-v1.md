# Full-release database preparation

This is the database handoff for `full-release-runtime-v1` and
`full-release-media-v1`. Commands below require a separately authorized target
and protected connection configuration. This task executed only disposable
synthetic databases; retained Development, Owner-QA, staging and Production
state remain unchecked. Merging this code does not authorize applying SQL.

## Schema and runtime inventory

The release uses the existing PostgreSQL families. Legacy and Payload are
alternative content sources with overlapping physical names; never install both
in the same content database. Community is independent of that choice.

| Domain                                                   | Migration family and principal objects                                                                                     | Runtime configuration                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Legacy Catalog/import/search                             | 7 `database/migrations` files; Catalog tables/search and legacy ledger                                                     | `DATABASE_URL` for published reads; separate controlled migration/import identity                                              |
| Payload Catalog/media, editorial Articles/collections    | 10 official `apps/admin/src/migrations` entries; native tables/versions/child arrays, approvals, receipts, published views | `CMS_DATABASE_URL` for CMS DML; `DATABASE_URL` for published projections                                                       |
| Public users, sessions, email/phone identities/passwords | Community identity/session, auth and password migrations                                                                   | `APP_DATABASE_URL`; immutable identity/provenance and named mutable fields                                                     |
| Profiles, follows, blocks, favorites, likes, discovery   | Community foundations, profile media, featured and studio migrations                                                       | Same App role                                                                                                                  |
| Comments/replies/moderation                              | Community comments, discussion lifecycle and Article target migrations                                                     | Same App role; append-only audit                                                                                               |
| Works/revisions/media/jobs/capacity                      | Community work-publishing storage, revision, backfill/bridge and authorship migrations                                     | Same App role for existing Backend and media worker operations                                                                 |
| Notifications, Threads, direct messages                  | Community `20260922020000`, `20260922030000`, `20260922032000`                                                             | Same App role; existing immutable bodies and narrow delivery/read/moderation columns                                           |
| Native Article authoring/publication/deletion            | Community `20260930020000` through consent corrections and `20261001020000`                                                | App DML; public role reads only `community.published_authored_articles`                                                        |
| Article human control and delegation                     | Community Article connection/consent/approval/provider objects                                                             | Distinct `ARTICLE_AUTHORING_CONTROL_DATABASE_URL`, `ARTICLE_AUTHORIZATION_DATABASE_URL` and App/resource identity              |
| Existing Agent administration/delegation                 | Existing Community Agent migration range through `20260921010000`                                                          | App plus separately configured `AGENT_AUTHORIZATION_DATABASE_URL`, `AGENT_CONSENT_DATABASE_URL`, `AGENT_RESOURCE_DATABASE_URL` |

Community now contains 44 forward files, ending at
`20261002020000_article_connection_environments.sql`. The manifest pins exact
SHA-256 bytes; no historical migration or ledger row was rewritten. Current
sibling records require the existing queue, media references, business tables
and human Article paths. A additionally requires Production Article connections;
the new forward file permits only `development` and `production`, preserving
existing connection rows, immutable environment/identity and per-environment
uniqueness. It adds no objects or grants and does not activate a runtime. Agent
and external Article protocol activation remains governed by their runtime
tasks.

## Exact preparation order

Use the intended checkout and its pinned toolchain. Shell variables below are
role **names** or private environment-file paths, never connection strings or
credential literals. The operator supplies protected files directly to the
process; do not echo, record or publish their contents.

1. Provision distinct migration/setup, CMS runtime, public-read and Community
   App logins for the authorized database. Runtime roles must have no superuser,
   BYPASSRLS, CREATEDB, CREATEROLE, replication, persistent schema CREATE or
   migration-owner membership. Provision `CONNECT` explicitly. An existing
   schema-owning `yoyi_dev_payload` cannot become a limited runtime by applying
   grants: use a distinct runtime identity. This task performs no retained
   ownership transfer or credential change.
2. Build the existing packages; install required extensions with setup
   authority. Payload search requires `pg_trgm`; the new Community forward
   migration explicitly installs bundled `btree_gist`. Runtime does no DDL.
3. Apply exactly the chosen content family through the existing dispatcher. For
   Payload, the one-shot protected migration environment supplies migration
   authority under the dispatcher's existing `CMS_DATABASE_URL` key. The Admin
   service environment instead supplies its limited runtime login under that
   key. The legacy dispatcher's migration key is `DATABASE_URL`; it is also
   replaced with the limited read login in the Backend service environment.
4. Apply Community through its independent `APP_MIGRATION_DATABASE_URL`.
5. Apply named grants after **both** required schemas exist, then verify with
   independent runtime connections before starting listeners.

```sh
/opt/homebrew/bin/mise exec -- pnpm exec turbo run build --filter=admin^... --filter=@moya/community-postgres
# CONTENT_MIGRATION_ENV privately sets MOYA_CONTENT_SOURCE and migration settings.
/opt/homebrew/bin/mise exec -- node --env-file="$CONTENT_MIGRATION_ENV" scripts/migrate.mjs --expect=payload
# For an explicitly selected legacy target, use --expect=legacy instead.
/opt/homebrew/bin/mise exec -- node --env-file="$COMMUNITY_MIGRATION_ENV" scripts/migrate-community.mjs
```

In a protected setup-role `psql` session (credentials provided through the
approved environment/service configuration), execute the following named files.
Do not use these Payload grants on a legacy-only target.

```sh
psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -v cms_role="$CMS_RUNTIME_ROLE" \
  -f infra/development/grant-cms-runtime.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -v public_read_role="$PUBLIC_READ_ROLE" \
  -f infra/development/grant-public-read.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -v app_role="$APP_RUNTIME_ROLE" \
  -f infra/development/work-publishing/grant-runtime.sql
psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -v public_read_role="$PUBLIC_READ_ROLE" \
  -f infra/development/article-authoring/grant-public-read.sql
```

`grant-public-read.sql` preserves the existing `yoyi_dev_public` default for the
Development caller. Native authored Article reading is a separate **post-
Community** phase; the early Payload read grant does not grant that view. The
consolidated App grant already replaces the older Community baseline grant; keep
its named columns, receipt privileges and function permissions intact.

CMS grants name current native tables, child/version tables, sequences and
published views. They permit native child replacement and version retention,
without primary content/user hard deletion, ledger mutation, sequence reset,
persistent DDL or Community access. Reapplying grants is idempotent and extends
an existing non-owner role with an older subset. Unknown inherited/excess
privileges require an explicit operational disposition; additive grants do not
prove arbitrary old roles least-privileged.

The current Article catalog-reference check is the named SECURITY DEFINER
function `community.article_catalog_references_published(TEXT[],TEXT[],TEXT[])`;
its fixed search path and revoked PUBLIC execution remain unchanged. App gets
only its named EXECUTE grant. For a separately enabled Article control/issuer
surface, use `infra/development/article-authoring/grant-delegation.sql` with
transaction-local `article_authoring.issuer_role`, `.control_role` and
`.resource_role` set to three distinct pre-provisioned roles. Agent protocol
roles use `infra/development/agent-connections/grant-authorization.sql` under
that surface's separate authority. These scripts are not activation permission.
No Production-specific database privilege is needed for the Article environment
correction; the existing named issuer/control/resource grants apply. Runtime
must use its actual environment, with separately configured issuer, resource and
consent/token fences. Native Catalog editorial MCP is already enabled in Payload
and uses the CMS role and native API-key authorization. Agent/external Article
activation and their final Production composition remain the runtime task's
responsibility.

## Identity rotation correction

The old row trigger rejects a multi-identity whole-table version update, yet
allows racing first writes to commit different versions. The forward migration
replaces it with a deferrable GiST exclusion constraint enforcing one version,
including across READ COMMITTED and REPEATABLE READ transactions. Existing
`(kind, lookup_digest)` and `(user_id, kind)` uniqueness, last-factor
protection, verification provenance and identity IDs remain intact. The database
adapter maps only the new named exclusion error to the existing conflict result.

A controlled rotation is an explicit offline data migration, not startup work:

1. Stop/drain identity writes and old-version challenge/handoff/reset-proof
   issuance; resolve or invalidate outstanding proofs using the existing
   lifecycle. Do not run two active lookup versions side by side.
2. Under migration authority, begin a transaction and lock
   `community.user_login_identities` against writes. Verify the source key
   version and immutable identity/provenance set before writing.
3. For multiple update statements, explicitly defer only
   `community.user_login_identities_one_lookup_key_version`. Recompute every
   normalized contact digest and **re-encrypt its ciphertext** using the new
   version: AES-GCM associated data includes the version, even when the
   encryption key itself is unchanged. Preserve IDs, ownership, verification
   mode/environment and verified timestamps. No rotation program is added by
   this task; it must receive an exact authorized target and keys privately.
4. Set that constraint `IMMEDIATE`, verify complete counts, unique contacts and
   decryptability, then commit. A partial rotation or existing mixed-version
   dataset fails closed. The forward schema migration never silently repairs
   such rows; prepare a separate controlled data correction if encountered.
5. Start the existing runtime with the selected `AUTH_KEY_VERSION`,
   `AUTH_LOOKUP_KEY`, `AUTH_ENCRYPTION_KEY`, `AUTH_OTP_KEY` only after the data
   transaction succeeds. Keep provider verification provenance and environment
   distinctions unchanged.

The owner-level user DELETE/CASCADE hypothesis reproduces a last-identity
rejection, but there is no implemented account-closing/hard-delete path. The
existing account lifecycle is suspension/reinstatement and session revocation.
No account-delete feature, broad cascade or last-factor relaxation is added.

## Readiness and verification

Community startup validates every required ledger filename/checksum read-only;
legacy startup checks its own ledger; Payload readiness checks published views
and required migration names. A matching ledger is necessary but not sufficient:
run actual published Catalog queries, CMS edits/publications, App DML and
expected denials. `/health` database readiness does not install extensions,
migrate, grant or establish permission for live operations.

Disposable preparation and cumulative verification use existing tooling:

```sh
/opt/homebrew/bin/mise exec -- pnpm dev:task:prepare --task full-release-database-v1 --manifest "$RESOURCE_MANIFEST"
/opt/homebrew/bin/mise exec -- pnpm dev:task:inspect --task full-release-database-v1 --manifest "$RESOURCE_MANIFEST"
/opt/homebrew/bin/mise exec -- node scripts/verify-task.mjs --base origin/main --resources "$RESOURCE_MANIFEST" --output "$PRIVATE_OUTPUT"
```

With that verified resource environment loaded privately:

```sh
/opt/homebrew/bin/mise exec -- pnpm test:postgres
/opt/homebrew/bin/mise exec -- pnpm test:cms --profile complete
```

The dedicated `login-identity-rotation.test.ts` covers old failure reproduction,
upgrade/repeat/checksum preservation, complete/deferred/partial rotation,
concurrent snapshot isolation, invalid-data migration rollback and last-factor
behavior. `tests/cms/runtime-role.test.ts` exercises fresh and pre-existing
non-owner CMS roles with real Payload writes and published reads, plus DDL,
ledger, Community and private-content denials. This role-creation suite is local
only and skips the existing remote synthetic CMS mode; remote role provisioning
is not exercised. Existing PostgreSQL suites cover Work/publication/media
ownership, capacity races/reconciliation, retained Article snapshots/media,
notifications, Threads/DM, blocking/suspension and distinct Article
control/issuer roles. `article-connection-migration.test.ts` reproduces the old
Production rejection and verifies upgrade/repeat, retained rows/checksums, exact
environment values, uniqueness and immutable environment. The limited-role
Article suite verifies Production connection DML and issuer/resource denials.
These database checks do not establish final mounted Production OAuth/MCP. Final
acceptance must bind A/B and all enabled MCP paths to one frozen candidate and
execute actual business operations and refusals, including native Catalog MCP
key/tool calls. Exact command outcomes, skipped live-only cases, commit and
migration hashes are recorded in the task's private handoff and PR.
