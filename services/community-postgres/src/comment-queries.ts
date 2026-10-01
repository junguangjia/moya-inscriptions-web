/**
 * Every statement is parameterized and confined to the community namespace.
 * Root comments read newest-first and replies oldest-first; both orders are
 * total, so pagination never repeats or drops a row.
 */

const commentAuthorJoin = `
  JOIN community.public_users u ON u.id = c.author_id
`;

/**
 * The hot section: visible roots that have at least one visible reply, most
 * replies first, then newer, then greater id. Pending and hidden replies never
 * count, and a pending or hidden root never qualifies. Provisional Owner
 * defaults (scope amendment 2026-09-12); the limit comes from the contract.
 */
export const selectHotCommentsSql = `
  SELECT c.id, c.catalog_id, c.text, c.created_at, c.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name
  FROM community.catalog_comments c
  ${commentAuthorJoin}
  JOIN community.catalog_comment_replies r
    ON r.root_comment_id = c.id AND r.moderation = 'visible'
  WHERE c.catalog_id = $1::text AND c.moderation = 'visible'
  GROUP BY c.id, c.catalog_id, c.text, c.created_at, c.moderation,
           u.id, u.display_name
  ORDER BY COUNT(r.id) DESC, c.created_at DESC, c.id DESC
  LIMIT $2::integer
`;

/** `$2` / `$4` carry the roots the latest list leaves out (hot and pinned). */
export const countVisibleCommentsSql = `
  SELECT COUNT(*)::text AS total
  FROM community.catalog_comments c
  WHERE c.catalog_id = $1::text AND c.moderation = 'visible'
    AND c.id <> ALL($2::text[])
`;

export const listVisibleCommentsSql = `
  SELECT c.id, c.catalog_id, c.text, c.created_at, c.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name
  FROM community.catalog_comments c
  ${commentAuthorJoin}
  WHERE c.catalog_id = $1::text AND c.moderation = 'visible'
    AND c.id <> ALL($4::text[])
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT $2::integer OFFSET $3::bigint
`;

/** Visible reply totals for the roots on a page; absent rows mean zero. */
export const countVisibleRepliesByRootSql = `
  SELECT r.root_comment_id, COUNT(*)::text AS total
  FROM community.catalog_comment_replies r
  WHERE r.root_comment_id = ANY($1::text[]) AND r.moderation = 'visible'
  GROUP BY r.root_comment_id
`;

/** The bounded first page of visible replies for each root on the page. */
export const listEmbeddedRepliesSql = `
  SELECT id, root_comment_id, text, created_at, moderation,
         author_id, author_display_name, author_studio_name,
         reply_to_author_id, reply_to_display_name, reply_to_studio_name
  FROM (
    SELECT r.id, r.root_comment_id, r.text, r.created_at, r.moderation,
           u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name,
           ru.id AS reply_to_author_id,
           ru.display_name AS reply_to_display_name, ru.studio_name AS reply_to_studio_name,
           ROW_NUMBER() OVER (
             PARTITION BY r.root_comment_id
             ORDER BY r.created_at ASC, r.id ASC
           ) AS position
    FROM community.catalog_comment_replies r
    JOIN community.public_users u ON u.id = r.author_id
    LEFT JOIN community.catalog_comment_replies t
      ON t.id = r.reply_to_reply_id AND t.moderation = 'visible'
    LEFT JOIN community.public_users ru ON ru.id = t.author_id
    WHERE r.root_comment_id = ANY($1::text[]) AND r.moderation = 'visible'
  ) ranked
  WHERE position <= $2::integer
  ORDER BY root_comment_id ASC, created_at ASC, id ASC
`;

export const countVisibleRepliesSql = `
  SELECT COUNT(*)::text AS total
  FROM community.catalog_comment_replies r
  WHERE r.root_comment_id = $1::text AND r.moderation = 'visible'
`;

export const listVisibleRepliesSql = `
  SELECT r.id, r.root_comment_id, r.text, r.created_at, r.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name,
         ru.id AS reply_to_author_id, ru.display_name AS reply_to_display_name, ru.studio_name AS reply_to_studio_name
  FROM community.catalog_comment_replies r
  JOIN community.public_users u ON u.id = r.author_id
  LEFT JOIN community.catalog_comment_replies t
    ON t.id = r.reply_to_reply_id AND t.moderation = 'visible'
  LEFT JOIN community.public_users ru ON ru.id = t.author_id
  WHERE r.root_comment_id = $1::text AND r.moderation = 'visible'
  ORDER BY r.created_at ASC, r.id ASC
  LIMIT $2::integer OFFSET $3::bigint
`;

export const findCommentSql = `
  SELECT c.id, c.catalog_id, c.text, c.created_at, c.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name
  FROM community.catalog_comments c
  ${commentAuthorJoin}
  WHERE c.id = $1::text
`;

export const findReplySql = `
  SELECT r.id, r.root_comment_id, r.text, r.created_at, r.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name,
         ru.id AS reply_to_author_id, ru.display_name AS reply_to_display_name, ru.studio_name AS reply_to_studio_name
  FROM community.catalog_comment_replies r
  JOIN community.public_users u ON u.id = r.author_id
  LEFT JOIN community.catalog_comment_replies t ON t.id = r.reply_to_reply_id
  LEFT JOIN community.public_users ru ON ru.id = t.author_id
  WHERE r.id = $1::text
`;

export const insertCommentSql = `
  WITH inserted AS (
    INSERT INTO community.catalog_comments
      (id, catalog_id, author_id, text, moderation, created_at)
    VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz)
    RETURNING id, catalog_id, author_id, text, moderation, created_at
  )
  SELECT c.id, c.catalog_id, c.text, c.created_at, c.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name
  FROM inserted c
  ${commentAuthorJoin}
`;

export const insertReplySql = `
  WITH inserted AS (
    INSERT INTO community.catalog_comment_replies
      (id, root_comment_id, author_id, text, moderation, created_at,
       reply_to_reply_id)
    VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz,
            $7::text)
    RETURNING id, root_comment_id, author_id, text, moderation, created_at,
              reply_to_reply_id
  )
  SELECT r.id, r.root_comment_id, r.text, r.created_at, r.moderation,
         u.id AS author_id, u.display_name AS author_display_name, u.studio_name AS author_studio_name,
         ru.id AS reply_to_author_id, ru.display_name AS reply_to_display_name, ru.studio_name AS reply_to_studio_name
  FROM inserted r
  JOIN community.public_users u ON u.id = r.author_id
  LEFT JOIN community.catalog_comment_replies t ON t.id = r.reply_to_reply_id
  LEFT JOIN community.public_users ru ON ru.id = t.author_id
`;

/**
 * Comment ids are unique across both tables, so at most one branch matches.
 * `$5` carries the states the requested transition may leave, so an
 * out-of-machine edge (approving a hidden item, hiding a pending one) matches
 * no row: the service then answers 409 for a known subject and 404 for an
 * unknown one, and never silently rewrites the state.
 */
export const applyCommentModerationSql = `
  WITH root AS (
    UPDATE community.catalog_comments
    SET moderation = $2::text, moderated_by = $3::text,
        moderated_at = $4::timestamptz
    WHERE id = $1::text AND moderation = ANY($5::text[]) AND body_deleted_at IS NULL AND thread_removed_at IS NULL
    RETURNING id, moderation
  ), reply AS (
    UPDATE community.catalog_comment_replies
    SET moderation = $2::text, moderated_by = $3::text,
        moderated_at = $4::timestamptz
    WHERE id = $1::text AND moderation = ANY($5::text[]) AND body_deleted_at IS NULL AND EXISTS(SELECT 1 FROM community.catalog_comments parent WHERE parent.id=root_comment_id AND parent.thread_removed_at IS NULL)
    RETURNING id, moderation
  )
  SELECT id, moderation, 'comment' AS kind FROM root
  UNION ALL
  SELECT id, moderation, 'reply' AS kind FROM reply
`;

const operatorCommentUnion = `
  SELECT c.id, 'comment' AS kind, c.catalog_id,c.target_type,c.body_deleted_at,c.thread_removed_at, NULL::text AS root_comment_id,
         NULL::text AS reply_to_reply_id,
         c.text, c.created_at, c.moderation,
         u.id AS author_id, u.handle AS author_handle,
         u.display_name AS author_display_name, u.status AS author_status
  FROM community.catalog_comments c
  JOIN community.public_users u ON u.id = c.author_id
  UNION ALL
  SELECT r.id, 'reply' AS kind, c.catalog_id,c.target_type,r.body_deleted_at,c.thread_removed_at,r.root_comment_id,
         r.reply_to_reply_id,
         r.text, r.created_at, r.moderation,
         u.id AS author_id, u.handle AS author_handle,
         u.display_name AS author_display_name, u.status AS author_status
  FROM community.catalog_comment_replies r
  JOIN community.catalog_comments c ON c.id = r.root_comment_id
  JOIN community.public_users u ON u.id = r.author_id
`;

/**
 * The thread size (root plus every reply) is added to the rows of one page
 * only, after ORDER BY/LIMIT, so a queue page costs the ordered scan plus at
 * most a page of sibling counts rather than one count per stored comment.
 */
const withThreadAffectedCount = (pageSql: string): string => `
  SELECT page.*,
         (1 + (SELECT COUNT(*) FROM community.catalog_comment_replies siblings
               WHERE siblings.root_comment_id = COALESCE(page.root_comment_id, page.id)))::integer
           AS thread_affected_count
  FROM (${pageSql}) page
`;

/**
 * The review filters: `$1` state (NULL = every state), `$2` kind, `$3`
 * Catalog record, `$4` a pre-escaped substring pattern matched against the
 * text and the author's handle and display name. Nothing here is the public
 * hot ordering; the Owner reviews newest or oldest first.
 */
const operatorFilter = `
  WHERE ($1::text IS NULL OR entries.moderation = $1::text)
    AND ($2::text IS NULL OR entries.kind = $2::text)
    AND ($3::text IS NULL OR entries.catalog_id = $3::text)
    AND (
      $4::text IS NULL
      OR entries.text ILIKE $4::text ESCAPE '\\'
      OR entries.author_handle ILIKE $4::text ESCAPE '\\'
      OR entries.author_display_name ILIKE $4::text ESCAPE '\\'
    )
`;

export const countOperatorCommentsSql = `
  SELECT COUNT(*)::text AS total
  FROM (${operatorCommentUnion}) entries
  ${operatorFilter}
`;

/** Counts per state under the non-state filters, for the status tabs. */
export const countOperatorCommentsByStateSql = `
  SELECT entries.moderation, COUNT(*)::text AS total
  FROM (${operatorCommentUnion}) entries
  ${operatorFilter}
  GROUP BY entries.moderation
`;

export const listOperatorCommentsNewestSql = `
  ${withThreadAffectedCount(`
    SELECT * FROM (${operatorCommentUnion}) entries
    ${operatorFilter}
    ORDER BY entries.created_at DESC, entries.id DESC
    LIMIT $5::integer OFFSET $6::bigint
  `)}
  ORDER BY page.created_at DESC, page.id DESC
`;

export const listOperatorCommentsOldestSql = `
  ${withThreadAffectedCount(`
    SELECT * FROM (${operatorCommentUnion}) entries
    ${operatorFilter}
    ORDER BY entries.created_at ASC, entries.id ASC
    LIMIT $5::integer OFFSET $6::bigint
  `)}
  ORDER BY page.created_at ASC, page.id ASC
`;

export const findOperatorCommentSql = withThreadAffectedCount(`
  SELECT * FROM (${operatorCommentUnion}) entries
  WHERE entries.id = $1::text
`);

/** Turns free text into a bounded substring pattern for ILIKE ... ESCAPE '\\'. */
export const toSearchPattern = (search: string): string =>
  `%${search.replaceAll(/[\\%_]/g, (character) => `\\${character}`)}%`;

const moderationEventColumns = `
  id, occurred_at, operator_label, action, subject_kind, subject_id, detail
`;

export const countModerationEventsSql = `
  SELECT COUNT(*)::text AS total
  FROM community.moderation_events
  WHERE ($1::text IS NULL OR subject_id = $1::text)
    AND ($2::text IS NULL OR action = $2::text)
`;

export const listModerationEventsSql = `
  SELECT ${moderationEventColumns}
  FROM community.moderation_events
  WHERE ($1::text IS NULL OR subject_id = $1::text)
    AND ($2::text IS NULL OR action = $2::text)
  ORDER BY occurred_at DESC, id DESC
  LIMIT $3::integer OFFSET $4::bigint
`;

export const countModerationActionsInRangeSql = `
  SELECT action, COUNT(*)::text AS total
  FROM community.moderation_events
  WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
  GROUP BY action
`;

export const recentModerationEventsSql = `
  SELECT ${moderationEventColumns}
  FROM community.moderation_events
  ORDER BY occurred_at DESC, id DESC
  LIMIT $1::integer
`;

export const readPublicationSettingSql = `
  SELECT policy, updated_at, updated_by
  FROM community.publication_setting
  WHERE id = 'publication'
`;

/** A switch to the mode already in force matches no row and records nothing. */
export const writePublicationSettingSql = `
  UPDATE community.publication_setting
  SET policy = $1::text, updated_by = $2::text, updated_at = $3::timestamptz
  WHERE id = 'publication' AND policy <> $1::text
  RETURNING policy
`;

export const insertModerationEventSql = `
  INSERT INTO community.moderation_events
    (id, occurred_at, operator_label, action, subject_kind, subject_id, detail)
  VALUES ($1::text, $2::timestamptz, $3::text, $4::text, $5::text, $6::text,
          $7::text)
`;

/**
 * Only a real transition updates the row (`status <> $2`), so the audit row a
 * caller writes beside it exists exactly when the status changed. The second
 * branch reads the table as of the statement start and yields the unchanged
 * user when nothing was updated; an unknown id yields no row at all.
 */
export const setUserStatusSql = `
  WITH changed AS (
    UPDATE community.public_users
    SET status = $2::text, updated_at = $3::timestamptz
    WHERE id = $1::text AND status <> $2::text
    RETURNING id, handle, display_name, status
  )
  SELECT id, handle, display_name, status, TRUE AS changed FROM changed
  UNION ALL
  SELECT u.id, u.handle, u.display_name, u.status, FALSE AS changed
  FROM community.public_users u
  WHERE u.id = $1::text AND NOT EXISTS (SELECT 1 FROM changed)
`;

export const revokeUserSessionsSql = `
  UPDATE community.sessions
  SET revoked_at = $2::timestamptz
  WHERE user_id = $1::text
    AND revoked_at IS NULL
    AND expires_at > $2::timestamptz
`;

/**
 * The execution receipt of one agent-operation target (Issue #141 r4). It is
 * written in the same transaction as the transition and its audit row, so a
 * committed moderation is always recoverable by its exact identity instead of
 * being inferred from the actor, the clock or the current state.
 */
export const findCommandReceiptSql = `
  SELECT fingerprint, result
  FROM community.discussion_command_receipts
  WHERE actor_label = $1 AND request_id = $2
`;

export const insertCommandReceiptSql = `
  INSERT INTO community.discussion_command_receipts
    (actor_label, request_id, fingerprint, result, created_at)
  VALUES ($1, $2, $3, $4::jsonb, $5)
`;
