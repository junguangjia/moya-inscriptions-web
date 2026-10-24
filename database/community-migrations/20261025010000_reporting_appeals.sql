-- community-reporting-appeals-v1. No historical cases or reasons are fabricated.
CREATE TABLE community.report_cases (
 id text PRIMARY KEY CHECK(id ~ '^report-[0-9a-f]{32}$'), reporter_id text REFERENCES community.public_users(id),
 target_type text NOT NULL CHECK(target_type IN ('work','comment','user','article','thread','catalog')), target_id text NOT NULL,
 canonical_path text NOT NULL, affected_user_id text REFERENCES community.public_users(id), snapshot jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN ('standard','quick_comment','rights_notice','moderation')), reason text CHECK(reason IN ('illegal_harmful','spam_scam','harassment','privacy','impersonation','copyright','other')),
 description text NOT NULL DEFAULT '', claimant jsonb, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','appealed')),
 urgent boolean NOT NULL DEFAULT false, legal_hold boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 decision_id text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at timestamptz,
 CHECK ((kind='moderation' AND reporter_id IS NULL AND reason IS NULL)
   OR (reporter_id IS NOT NULL AND ((kind='quick_comment' AND target_type='comment' AND reason IS NULL)
   OR (kind='standard' AND target_type<>'comment' AND reason IS NOT NULL)
   OR (kind='rights_notice' AND reason IS NOT NULL AND reason='copyright')))),
 CHECK ((kind='rights_notice')=(claimant IS NOT NULL))
);
-- Create commands serialize and deduplicate by reporter/target. An appeal or
-- rights statement may reopen an older case alongside a newer open report.
CREATE INDEX report_cases_open_target ON community.report_cases(reporter_id,target_type,target_id,created_at DESC,id DESC) WHERE status IN ('open','reviewing','appealed');
CREATE INDEX report_cases_queue ON community.report_cases(urgent DESC,created_at,id);
CREATE TABLE community.report_decisions (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES community.report_cases(id) ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN ('retain','hide','warn','restrict_comments','suspend','approve','reject','restore','delete_body','remove_thread')), reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 2000),
 operator_label text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, reversed_at timestamptz, review_reason text,
 appeal_text text, appeal_at timestamptz, appeal_status text CHECK(appeal_status IN ('pending','upheld','overturned')),
 restriction_key text
);
CREATE TABLE community.report_restriction_heads (
 restriction_key text PRIMARY KEY, subject_kind text NOT NULL, subject_id text NOT NULL, prior_state jsonb NOT NULL, applied_revision bigint NOT NULL
);
CREATE TABLE community.report_materials (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES community.report_cases(id) ON DELETE CASCADE,
 author_id text NOT NULL REFERENCES community.public_users(id), kind text NOT NULL CHECK(kind IN ('supplement','statement')), text text NOT NULL CHECK(char_length(text) BETWEEN 1 AND 10000), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE community.report_evidence (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES community.report_cases(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES community.public_users(id), file_name text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready')), upload_lease text, lease_until timestamptz,
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608), sensitive boolean NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE community.report_messages (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES community.report_cases(id) ON DELETE CASCADE,
 recipient_id text NOT NULL REFERENCES community.public_users(id), kind text NOT NULL CHECK(kind IN ('notice','statement','result')), text text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at timestamptz
);
CREATE TABLE community.report_audit (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES community.report_cases(id) ON DELETE CASCADE,
 operator_label text NOT NULL, action text NOT NULL, reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE community.report_receipts (
 actor_id text NOT NULL, request_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(actor_id,request_id)
);
CREATE TABLE community.report_urgent_outbox (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES community.report_cases(id) ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, lease_until timestamptz, delivered_at timestamptz, last_error text CHECK(last_error IS NULL OR last_error='delivery_failed'), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX report_urgent_ready ON community.report_urgent_outbox(next_attempt_at) WHERE delivered_at IS NULL;
ALTER TABLE community.public_users ADD COLUMN reporting_comments_restricted boolean NOT NULL DEFAULT false, ADD COLUMN reporting_revision bigint NOT NULL DEFAULT 0, ADD COLUMN reporting_comment_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE community.works ADD COLUMN reporting_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE community.catalog_comments ADD COLUMN reporting_revision bigint NOT NULL DEFAULT 0, ADD COLUMN reporting_thread_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE community.catalog_comment_replies ADD COLUMN reporting_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE community.threads ADD COLUMN reporting_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE community.article_documents ADD COLUMN reporting_revision bigint NOT NULL DEFAULT 0, ADD COLUMN reporting_hidden boolean NOT NULL DEFAULT false;
-- Every later write to a moderated state invalidates an earlier restoration lease.
CREATE FUNCTION community.bump_reporting_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.reporting_revision:=OLD.reporting_revision+1; RETURN NEW; END $$;
CREATE TRIGGER reporting_user_revision BEFORE UPDATE OF status ON community.public_users FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_revision();
CREATE FUNCTION community.bump_reporting_comment_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.reporting_comment_revision:=OLD.reporting_comment_revision+1; RETURN NEW; END $$;
CREATE TRIGGER reporting_user_comment_revision BEFORE UPDATE OF reporting_comments_restricted ON community.public_users FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_comment_revision();
CREATE TRIGGER reporting_work_revision BEFORE UPDATE OF operator_state,deleted_at ON community.works FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_revision();
CREATE TRIGGER reporting_comment_revision BEFORE UPDATE OF moderation,body_deleted_at,thread_removed_at ON community.catalog_comments FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_revision();
-- Thread visibility restoration is independent from later body erasure/moderation.
CREATE FUNCTION community.bump_reporting_thread_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.reporting_thread_revision:=OLD.reporting_thread_revision+1; RETURN NEW; END $$;
CREATE TRIGGER reporting_comment_thread_revision BEFORE UPDATE OF thread_removed_at ON community.catalog_comments FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_thread_revision();
CREATE TRIGGER reporting_reply_revision BEFORE UPDATE OF moderation,body_deleted_at ON community.catalog_comment_replies FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_revision();
CREATE TRIGGER reporting_thread_revision BEFORE UPDATE OF hidden_at ON community.threads FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_revision();
CREATE TRIGGER reporting_article_revision BEFORE UPDATE OF reporting_hidden,published_version ON community.article_documents FOR EACH ROW EXECUTE FUNCTION community.bump_reporting_revision();
CREATE FUNCTION community.enforce_reporting_comment_restriction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM community.public_users WHERE id=NEW.author_id AND reporting_comments_restricted) THEN RAISE EXCEPTION 'comment_restricted' USING ERRCODE='23514', CONSTRAINT='report_comments_restricted'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER reporting_comment_write BEFORE INSERT ON community.catalog_comments FOR EACH ROW EXECUTE FUNCTION community.enforce_reporting_comment_restriction();
CREATE TRIGGER reporting_reply_write BEFORE INSERT ON community.catalog_comment_replies FOR EACH ROW EXECUTE FUNCTION community.enforce_reporting_comment_restriction();

-- Keep the canonical public read view authoritative for API, lists and media.
CREATE OR REPLACE VIEW community.published_authored_articles WITH (security_barrier=true) AS
SELECT r.article_id, r.owner_id, r.version, r.title, r.cover_ref_id,
  r.document, r.document->'references'->r.cover_ref_id AS cover_reference,
  r.fingerprint, u.display_name AS byline,
  a.first_published_at, a.published_at, a.published_at AS updated_at
FROM community.article_documents a
JOIN community.article_revisions r ON r.article_id=a.id AND r.version=a.published_version
JOIN community.public_users u ON u.id=a.owner_id AND u.status='active'
WHERE a.published_version IS NOT NULL AND a.status<>'withdrawn' AND NOT a.reporting_hidden;

-- Independent moderation may add restrictions, but cannot silently clear a
-- still-effective report decision. Reversal through the case closes its own
-- decision first, so the last effective restriction is the only one released.
CREATE FUNCTION community.guard_reporting_restriction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; restores boolean := false;
BEGIN
 k:=TG_ARGV[0]||':'||NEW.id;
 CASE TG_ARGV[0]
 WHEN 'work' THEN restores:=OLD.operator_state<>'visible' AND NEW.operator_state='visible';
 WHEN 'comment' THEN restores:=OLD.moderation<>'visible' AND NEW.moderation='visible';
 WHEN 'reply' THEN restores:=OLD.moderation<>'visible' AND NEW.moderation='visible';
 WHEN 'thread' THEN restores:=OLD.hidden_at IS NOT NULL AND NEW.hidden_at IS NULL;
 WHEN 'comment_thread' THEN restores:=OLD.thread_removed_at IS NOT NULL AND NEW.thread_removed_at IS NULL;
 WHEN 'article' THEN restores:=OLD.reporting_hidden AND NOT NEW.reporting_hidden;
 WHEN 'user_status' THEN restores:=OLD.status='suspended' AND NEW.status='active';
 WHEN 'user_comments' THEN restores:=OLD.reporting_comments_restricted AND NOT NEW.reporting_comments_restricted;
 END CASE;
 IF restores AND EXISTS(SELECT 1 FROM community.report_decisions d WHERE d.restriction_key=k AND d.reversed_at IS NULL) THEN
  RAISE EXCEPTION 'active_report_restriction' USING ERRCODE='23514', CONSTRAINT='active_report_restriction';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reporting_work_guard BEFORE UPDATE OF operator_state ON community.works FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('work');
CREATE TRIGGER reporting_comment_guard BEFORE UPDATE OF moderation ON community.catalog_comments FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('comment');
CREATE TRIGGER reporting_reply_guard BEFORE UPDATE OF moderation ON community.catalog_comment_replies FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('reply');
CREATE TRIGGER reporting_thread_guard BEFORE UPDATE OF hidden_at ON community.threads FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('thread');
CREATE TRIGGER reporting_article_guard BEFORE UPDATE OF reporting_hidden ON community.article_documents FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('article');
CREATE TRIGGER reporting_status_guard BEFORE UPDATE OF status ON community.public_users FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('user_status');
CREATE TRIGGER reporting_comments_guard BEFORE UPDATE OF reporting_comments_restricted ON community.public_users FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('user_comments');

CREATE TRIGGER reporting_comment_thread_guard BEFORE UPDATE OF thread_removed_at ON community.catalog_comments FOR EACH ROW EXECUTE FUNCTION community.guard_reporting_restriction('comment_thread');
