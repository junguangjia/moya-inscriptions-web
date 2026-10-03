-- Development App role after Phase 4 and work-publishing community migrations.
-- Apply explicitly as the setup/migration role; never from Backend startup.
-- The caller creates a non-owner NOSUPERUSER NOBYPASSRLS role first.
-- psql variable app_role is an identifier, not credential material.
-- Only runtime statements and invoker-trigger columns are granted. No DDL,
-- TRUNCATE, ownership, default privileges or ledger/identity rewrites.
-- Only receipt results and content-bearing event detail may be erased by
-- permanent deletion; event identity, action, actor and time stay immutable.
-- The Backend, authenticated operator bridge and worker share this SQL role;
-- public-user and Payload/operator authentication remain separate boundaries.

GRANT USAGE ON SCHEMA public, community TO :"app_role";

-- Convergence of an earlier, broader grant path. A role that was first set up by
-- infra/development/grant-community-app.sql (Mission 2A/2B: table-level UPDATE on
-- sessions, both comment tables and publication_setting) or by a private Phase 4
-- plan keeps those table-level privileges, because GRANT only adds and the
-- column lists below never narrow a table-level grant. Revoke exactly the
-- table-level privileges this plan grants at column level, then grant the
-- columns again below in this same run: PostgreSQL drops the column-level
-- entries together with the table-level one, so the re-grant is required.
-- Revoking an absent privilege is a no-op, so repeated application converges
-- to the same effective set. Nothing else is revoked here; any other residue on
-- a retained role is listed for an Owner decision, never removed blindly.
REVOKE UPDATE ON TABLE
  community.public_users,
  community.sessions,
  community.catalog_comments,
  community.catalog_comment_replies,
  community.publication_setting,
  community.featured_users,
  community.featured_content,
  community.featured_settings,
  community.works,
  community.work_revisions,
  community.work_drafts,
  community.work_draft_snapshots,
  community.publishing_sessions,
  community.work_publishing_settings,
  community.account_publishing_capacity,
  community.daily_new_work_submissions,
  community.media_items,
  community.media_components,
  community.media_blobs,
  community.publishing_jobs,
  community.agent_principals,
  community.agent_delegations,
  community.agent_operations,
  community.agent_connections,
  community.agent_connection_grants
FROM :"app_role";
REVOKE INSERT ON TABLE
  community.author_events,
  community.content_operator_events,
  community.featured_users,
  community.featured_content
FROM :"app_role";

-- Discovery and the featured operator read published Catalog projections only.
GRANT SELECT ON TABLE public.catalog_discovery, public.catalog_media TO :"app_role";
GRANT SELECT (catalog_id, province, province_state) ON TABLE public.catalog_entries TO :"app_role";
-- parallel-community-integration-qa: the notification source query checks Article
-- visibility against C's published-only projection. Only the identifier column is
-- needed for the existence test, so no Article body, byline or draft state is
-- readable by the App role.
GRANT SELECT (article_id) ON TABLE public.article_entries TO :"app_role";

-- Startup readiness verifies the community ledger read-only.
GRANT SELECT ON TABLE community.schema_migrations TO :"app_role";

-- Identity, sessions and development sign-in.
GRANT SELECT ON TABLE community.public_users, community.development_accounts TO :"app_role";
GRANT UPDATE (
  display_name, bio, status, updated_at,
  following_privacy, followers_privacy, favorites_privacy, likes_privacy,
  avatar_media_id, avatar_changed_on, background_media_id
) ON TABLE community.public_users TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.sessions TO :"app_role";
GRANT UPDATE (revoked_at) ON TABLE community.sessions TO :"app_role";

-- Discussion, likes, moderation and receipts.
GRANT SELECT, INSERT ON TABLE
  community.catalog_comments, community.catalog_comment_replies
TO :"app_role";
GRANT UPDATE (
  text, moderation, moderated_by, moderated_at, body_deleted_at, thread_removed_at
) ON TABLE community.catalog_comments TO :"app_role";
-- was_public is written by the remember_thread_publication trigger (invoker).
GRANT UPDATE (
  text, moderation, moderated_by, moderated_at, body_deleted_at, was_public
) ON TABLE community.catalog_comment_replies TO :"app_role";
GRANT SELECT, INSERT, DELETE ON TABLE community.comment_likes TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.discussion_command_receipts TO :"app_role";
GRANT SELECT ON TABLE community.publication_setting TO :"app_role";
GRANT UPDATE (policy, updated_by, updated_at) ON TABLE community.publication_setting TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.moderation_events TO :"app_role";

-- Author community: relations, blocks, favorites, legacy PNG media, receipts.
GRANT SELECT, INSERT, DELETE ON TABLE
  community.follows, community.blocks, community.content_relations
TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.user_media, community.author_command_receipts TO :"app_role";
GRANT UPDATE (bytes, deleted_at) ON TABLE community.user_media TO :"app_role";
GRANT UPDATE (result) ON TABLE community.author_command_receipts TO :"app_role";
GRANT INSERT (id, actor_id, action, subject_id, occurred_at) ON TABLE community.author_events TO :"app_role";

-- Featured content and discovery sequences.
GRANT SELECT ON TABLE community.featured_users TO :"app_role";
GRANT INSERT (user_id, enabled) ON TABLE community.featured_users TO :"app_role";
GRANT UPDATE (enabled, version) ON TABLE community.featured_users TO :"app_role";
GRANT SELECT ON TABLE community.featured_content, community.featured_settings TO :"app_role";
GRANT INSERT (content_type, content_id, enabled, position) ON TABLE community.featured_content TO :"app_role";
GRANT UPDATE (enabled, position, version) ON TABLE community.featured_content TO :"app_role";
GRANT UPDATE (enabled_quantity, version) ON TABLE community.featured_settings TO :"app_role";
-- Expired sequence deletion cascades to items through the existing foreign key.
GRANT SELECT, INSERT, DELETE ON TABLE community.discovery_sequences TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.discovery_sequence_items TO :"app_role";
GRANT INSERT (id, operator_label, action, content_type, content_id, occurred_at, detail)
ON TABLE community.content_operator_events TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.content_operator_receipts TO :"app_role";
GRANT UPDATE (result) ON TABLE community.content_operator_receipts TO :"app_role";
GRANT SELECT (content_type, content_id, detail), UPDATE (detail)
ON TABLE community.content_operator_events TO :"app_role";

-- Works and revisions (publishing submissions, visibility, permanent deletion, moderation).
GRANT SELECT, INSERT ON TABLE community.works TO :"app_role";
GRANT UPDATE (
  title, text, media_ids, version, updated_at, deleted_at, operator_state,
  public_revision_id, author_revision_id, visibility, first_published_at,
  edited_at, trashed_at, trash_purge_after
) ON TABLE community.works TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.work_revisions, community.work_revision_items TO :"app_role";
GRANT DELETE ON TABLE community.work_revisions, community.work_revision_items TO :"app_role";
GRANT SELECT, DELETE ON TABLE community.work_edit_drafts TO :"app_role";
GRANT UPDATE (disposition, decided_at, decided_by, version) ON TABLE community.work_revisions TO :"app_role";

-- Publishing drafts, snapshots and sessions (drafts/snapshots are deleted by cleanup).
GRANT SELECT, INSERT, DELETE ON TABLE community.work_drafts, community.work_draft_snapshots TO :"app_role";
GRANT UPDATE (
  content, content_sha256, revision, device_class, state, submitted_at,
  resolved_at, updated_at, work_id
) ON TABLE community.work_drafts TO :"app_role";
GRANT UPDATE (content, work_id, kind, pinned, source_revision, created_at) ON TABLE community.work_draft_snapshots TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.publishing_sessions TO :"app_role";
GRANT UPDATE (state, ended_at, lease_expires_at, draft_id) ON TABLE community.publishing_sessions TO :"app_role";

-- Settings, capacity and daily limits.
GRANT SELECT ON TABLE community.work_publishing_settings TO :"app_role";
GRANT UPDATE (
  publication_policy, max_items_per_work, original_item_max_bytes,
  standard_component_max_bytes, ordinary_account_capacity_bytes,
  owner_account_capacity_bytes, max_active_drafts, daily_new_work_limit,
  history_limit, trash_retention_days, orphan_grace_days,
  unsaved_session_lease_minutes, version, updated_at, updated_by
) ON TABLE community.work_publishing_settings TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.account_publishing_capacity TO :"app_role";
GRANT UPDATE (capacity_class, committed_bytes, reserved_bytes, version, updated_at)
ON TABLE community.account_publishing_capacity TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.daily_new_work_submissions TO :"app_role";
GRANT UPDATE (count) ON TABLE community.daily_new_work_submissions TO :"app_role";

-- Media items, components, blobs, derivatives, references and jobs.
GRANT SELECT, INSERT ON TABLE community.media_items TO :"app_role";
GRANT UPDATE (
  state, failure_code, cancelled_at, purged_at, ready_at, received_total_bytes,
  presentation, pairing, private_metadata, updated_at, version
) ON TABLE community.media_items TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.media_components TO :"app_role";
GRANT UPDATE (
  state, upload_attempt, received_bytes, reserved_bytes, sha256, blob_id,
  detected_type, updated_at
) ON TABLE community.media_components TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.media_blobs TO :"app_role";
GRANT UPDATE (state, tombstoned_at, purged_at) ON TABLE community.media_blobs TO :"app_role";
GRANT SELECT, INSERT, DELETE ON TABLE community.media_derivatives, community.media_item_refs TO :"app_role";
GRANT SELECT, INSERT, DELETE ON TABLE community.publishing_jobs TO :"app_role";
GRANT UPDATE (
  state, attempts, run_after, lease_owner, lease_expires_at, last_error_code,
  finished_at, updated_at
) ON TABLE community.publishing_jobs TO :"app_role";

-- SQL functions the adapters call (EXECUTE is also the PostgreSQL default for
-- PUBLIC; granted explicitly so the plan stays correct if that default is revoked).
GRANT EXECUTE ON FUNCTION
  community.accounts_can_interact(TEXT, TEXT),
  community.work_is_public(community.works),
  community.media_edit_key(JSONB, JSONB),
  community.media_required_derivatives(TEXT, JSONB, BOOLEAN, JSONB),
  community.work_content_sha256(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB)
TO :"app_role";

-- Agent administration (Issue #141 r3/r4): principals, delegations and durable
-- prepared operations. A prepared operation is frozen: the App role receives no
-- UPDATE on targets, criteria, kind, action, fingerprint or request_id, so
-- neither the membership nor the keyword manifest it was built from can be
-- rewritten after preparation. Only lifecycle columns change, and nothing is
-- ever deleted.
GRANT SELECT, INSERT ON TABLE
  community.agent_principals, community.agent_delegations, community.agent_operations
TO :"app_role";
GRANT UPDATE (display_name, scopes, enabled, version, updated_at, revoked_at)
ON TABLE community.agent_principals TO :"app_role";
GRANT UPDATE (revoked_at, revoked_by) ON TABLE community.agent_delegations TO :"app_role";
GRANT UPDATE (
  state, approval, next_index, results, lease_owner, lease_expires_at, version,
  approved_at, started_at, finished_at, cancel_requested_at
) ON TABLE community.agent_operations TO :"app_role";

-- Agent connections (Issue #141 r13): the canonical connection authority.
--
-- The App role reads connections, grants and wrappers, and may record that a
-- request was verified -- but it may NOT move a connection's lifecycle. Opening,
-- consenting, revoking and reconnecting belong to the connection-management
-- path, not to the resource server that merely authorizes a request with them.
-- So no UPDATE on status, generation, preset, principal_label or
-- current_grant_id, and no INSERT on connections at all.
--
-- A grant is an immutable consent snapshot. The App role receives no UPDATE on
-- generation_at_consent, the client, the subject, the issuer, the resource, the
-- scopes or the preset: the whole point is that an old grant keeps resolving to
-- the generation its human consented at, so nothing that would let it be
-- rewritten is granted. Only the provider-destruction columns move.
--
-- Wrappers are written and reaped by the provider path, not by the App role,
-- which only needs to resolve a presented token. Nothing is ever deleted here
-- by this role.
--
-- DELIBERATELY ABSENT: community.agent_connection_provider_artifacts gets no
-- grant at all in this file. The r13 review was right that this is a decision
-- and not an oversight, so it is written down. That table holds the OAuth
-- protocol's own bookkeeping, and its plaintext columns (grant_id,
-- consumed_at) sit outside the authenticated payload -- so who may write it
-- decides how exposed those columns are. The intent is a SECOND SQL role owned
-- by the authorization service, not this shared App role, which would widen
-- the blast radius of any injection in the resource-server path to the whole
-- token store. That role does not exist yet because the service does not, and
-- the day it lands this file stops being the whole grant plan. Until then the
-- adapter is exercised only by tests connecting as the database owner.
--
-- The same decision covers community.agent_connection_wrappers, which the App
-- role may SELECT and nothing more. A wrapper row is minted when a token is
-- issued and reaped when it expires -- both of which happen on the
-- authorization path, not the resource-server path -- so its writer is that
-- same future role. This role only has to resolve a token somebody presents.
GRANT SELECT ON TABLE
  community.agent_connections,
  community.agent_connection_grants,
  community.agent_connection_wrappers
TO :"app_role";
GRANT UPDATE (last_verified_at) ON TABLE community.agent_connections TO :"app_role";
GRANT UPDATE (destroy_status, destroyed_at)
ON TABLE community.agent_connection_grants TO :"app_role";

-- email-auth-v1: public registration and verified login identities.
-- No table-level UPDATE. Identity user_id, kind, verification_mode and
-- environment are not updatable, so a local proof cannot be relabeled.
-- public_users INSERT is limited to the columns a new ordinary account needs.
GRANT INSERT (id, handle, display_name) ON TABLE community.public_users TO :"app_role";
GRANT SELECT, DELETE ON TABLE community.user_login_identities TO :"app_role";
GRANT INSERT (
  id, user_id, kind, lookup_digest, ciphertext, lookup_key_version,
  verification_mode, environment, version, verified_at
) ON TABLE community.user_login_identities TO :"app_role";
GRANT UPDATE (
  lookup_digest, ciphertext, lookup_key_version, version, verified_at, updated_at
) ON TABLE community.user_login_identities TO :"app_role";
GRANT SELECT ON TABLE community.auth_challenges TO :"app_role";
GRANT INSERT (
  id, channel, purpose, target_digest, ciphertext, code_verifier,
  verification_strategy, provider_mode, environment, user_id, session_hash,
  continuation_hash, expected_version, reauth_hash, provider_correlation,
  expires_at, attempts, resend_available_at, superseded_at, completed_at,
  invalidated_at, delivery_state, idempotency_hash, created_at
) ON TABLE community.auth_challenges TO :"app_role";
GRANT UPDATE (
  attempts, resend_available_at, superseded_at, completed_at, invalidated_at,
  delivery_state, provider_correlation
) ON TABLE community.auth_challenges TO :"app_role";
GRANT SELECT ON TABLE community.auth_handoffs TO :"app_role";
GRANT INSERT (
  id, token_hash, purpose, channel, target_digest, ciphertext, provider_mode,
  environment, user_id, session_hash, expected_version, expires_at, consumed_at
) ON TABLE community.auth_handoffs TO :"app_role";
GRANT UPDATE (consumed_at) ON TABLE community.auth_handoffs TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.auth_receipts TO :"app_role";
GRANT UPDATE (session_id, session_token_hash, closed_at) ON TABLE community.auth_receipts TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.auth_send_counters TO :"app_role";
GRANT UPDATE (count) ON TABLE community.auth_send_counters TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.auth_target_failures TO :"app_role";
GRANT INSERT (id, user_id, action, occurred_at) ON TABLE community.auth_audit_events TO :"app_role";
GRANT INSERT (issuer, auth_environment, auth_channel) ON TABLE community.sessions TO :"app_role";
-- messaging-notification-foundation-v1: transaction effects and private inbox.
GRANT SELECT, INSERT ON community.notification_sources, community.notification_recipient_versions,
  community.notification_groups, community.notification_deliveries TO :"app_role";
GRANT UPDATE (generation,completed_generation,attempts,run_after,lease_owner,lease_until,error_code)
  ON community.notification_sources TO :"app_role";
GRANT UPDATE (revision) ON community.notification_recipient_versions TO :"app_role";
GRANT UPDATE (read_through) ON community.notification_groups TO :"app_role";
-- content-community-completion-v1 (track C): Threads over Works. The App role
-- reads Threads, associates a Work in the submission transaction, keeps the
-- per-user observed marker, and applies the Owner's operator commands (which
-- run through the same Backend role). Nothing here deletes.
GRANT SELECT, INSERT ON TABLE community.threads TO :"app_role";
GRANT UPDATE (title, description, tags, status, hidden_at, position, version, updated_at)
ON TABLE community.threads TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.thread_works TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.thread_read_state TO :"app_role";
GRANT UPDATE (observed_activity_at, updated_at) ON TABLE community.thread_read_state TO :"app_role";

-- content-community-completion-v1 (track C): direct messages. The App role
-- creates conversations, appends immutable messages, keeps participant state
-- and receipts, and writes content-free moderation audit rows. Removal is a
-- column update by the moderation path; nothing is deleted.
GRANT SELECT, INSERT ON TABLE community.dm_conversations TO :"app_role";
GRANT UPDATE (state, next_sequence, last_message_at, updated_at) ON TABLE community.dm_conversations TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.dm_participants TO :"app_role";
GRANT UPDATE (hidden_at, hidden_before_sequence, muted, read_sequence, updated_at) ON TABLE community.dm_participants TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.dm_messages TO :"app_role";
GRANT UPDATE (removed_at, removed_by) ON TABLE community.dm_messages TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.dm_command_receipts TO :"app_role";
-- Owner moderation removal redacts the sender's send receipt so removed text
-- keeps no second copy (direct-message-adapter operatorRemoveMessage). Only the
-- stored result is rewritten; actor, request, fingerprint and time stay
-- write-once, and nothing is deleted.
GRANT UPDATE (result) ON TABLE community.dm_command_receipts TO :"app_role";
GRANT SELECT, INSERT ON TABLE community.dm_moderation_events TO :"app_role";

-- special-article-editor-v1: public-user Article commands. Identity/owner and
-- immutable publication snapshots are never updated or deleted by this role.
GRANT SELECT, INSERT ON TABLE community.article_documents,
  community.article_revisions TO :"app_role";
-- Existing comment and notification eligibility reuse the current public
-- Article projection; this adds no Payload CRUD or owner reassignment.
GRANT SELECT ON TABLE community.published_authored_articles TO :"app_role";
GRANT UPDATE (version, title, cover_ref_id, document, fingerprint, status,
  published_version, pending_version, first_published_at, published_at, updated_at, deleted_at)
ON TABLE community.article_documents TO :"app_role";
GRANT EXECUTE ON FUNCTION
  community.article_catalog_references_published(TEXT[], TEXT[], TEXT[])
TO :"app_role";
-- Password auth: exact mutable credential fields, no DDL or delete authority.
GRANT SELECT ON TABLE community.user_password_credentials TO :"app_role";
GRANT INSERT (user_id, verifier, version, updated_at) ON TABLE community.user_password_credentials TO :"app_role";
GRANT UPDATE (verifier, version, updated_at) ON TABLE community.user_password_credentials TO :"app_role";
GRANT SELECT ON TABLE community.auth_password_reset_receipts TO :"app_role";
GRANT INSERT (key_hash, user_id, payload_hash, credential_version) ON TABLE community.auth_password_reset_receipts TO :"app_role";
GRANT UPDATE (closed_at) ON TABLE community.auth_password_reset_receipts TO :"app_role";
GRANT INSERT (studio_name, studio_name_suffix) ON TABLE community.public_users TO :"app_role";
GRANT UPDATE (studio_name, studio_name_suffix) ON TABLE community.public_users TO :"app_role";
GRANT INSERT (identity_id, credential_version) ON TABLE community.auth_challenges TO :"app_role";
GRANT INSERT (identity_id, credential_version) ON TABLE community.auth_handoffs TO :"app_role";

-- production-deployment-v3: offline operator authority, never runtime provisionable.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE community.operator_password_accounts FROM :"app_role";
GRANT SELECT ON TABLE community.operator_password_accounts TO :"app_role";
