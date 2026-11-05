-- admin-mcp-completion-v1 section 6: acting on what was found needs no scan.
-- report_cases_open_target leads with reporter_id and is partial, so neither target
-- nor affected user could use it. The runner wraps each file in a transaction, so
-- CONCURRENTLY is unavailable; expect a brief write lock on both tables at release.
CREATE INDEX report_cases_target_created ON community.report_cases(target_type,target_id,created_at DESC);
CREATE INDEX report_cases_affected_created ON community.report_cases(affected_user_id,created_at DESC);
CREATE INDEX feedback_user_created ON community.feedback(user_id,created_at DESC);
