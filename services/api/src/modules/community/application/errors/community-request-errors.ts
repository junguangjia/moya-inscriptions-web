/** The submitted body failed a Contract or domain rule (maps to INVALID_INPUT). */
export class CommunityInputError extends Error {
  override readonly name = "CommunityInputError";

  constructor(message = "Community input is invalid") {
    super(message);
  }
}

export const isCommunityInputError = (
  error: unknown,
): error is CommunityInputError => error instanceof CommunityInputError;

/**
 * The Catalog record is unknown or not currently published, or the root comment
 * is unknown or not visible (maps to ITEM_NOT_FOUND).
 */
export class CommunityNotFoundError extends Error {
  override readonly name = "CommunityNotFoundError";

  constructor(message = "Community subject was not found") {
    super(message);
  }
}

export const isCommunityNotFoundError = (
  error: unknown,
): error is CommunityNotFoundError => error instanceof CommunityNotFoundError;

/**
 * The subject exists but is not in a state the requested transition may leave
 * (someone else moderated it first, or the queue was stale). Maps to 409 on
 * the operator boundary; nothing was changed and nothing was recorded.
 */
export class CommunityConflictError extends Error {
  override readonly name = "CommunityConflictError";

  constructor(message = "Community subject is in a different state") {
    super(message);
  }
}

export const isCommunityConflictError = (
  error: unknown,
): error is CommunityConflictError => error instanceof CommunityConflictError;

/**
 * A read that ran out of its statement limit: no answer, and not an empty one. Maps to
 * READ_TIMED_OUT on the operator boundary.
 */
export class CommunityReadTimedOutError extends Error {
  override readonly name = "CommunityReadTimedOutError";

  constructor(message = "Community read ran out of time") {
    super(message);
  }
}

export const isCommunityReadTimedOutError = (
  error: unknown,
): error is CommunityReadTimedOutError =>
  error instanceof CommunityReadTimedOutError;

/**
 * The mutation was refused because the caller had lost the right to execute,
 * not because the subject moved on.
 *
 * It is a conflict, so every existing caller keeps treating it as one, but it
 * is a distinguishable conflict, because the two say different things: a
 * business conflict proves that nothing was written under this identity, while
 * losing the fence says nothing at all about whether an EARLIER attempt already
 * committed. A caller that confuses them can send an operation terminal while
 * its rows are live.
 */
export class ExecutionFenceLostError extends CommunityConflictError {
  // `name` stays the base's literal: it is narrowed there, and every caller
  // that treats this as a conflict should keep doing so. The distinguishing
  // signal is the type, which `isExecutionFenceLostError` reads.
  constructor(
    message = "Execution right was lost before this mutation could commit",
  ) {
    super(message);
  }
}

export const isExecutionFenceLostError = (
  error: unknown,
): error is ExecutionFenceLostError => error instanceof ExecutionFenceLostError;

/**
 * A command's identity was used before with other content. It is a conflict, so every
 * caller keeps treating it as one, and a distinguishable one: the subject did not move,
 * and reading it again would not help.
 */
export class CommunityIdempotencyConflictError extends CommunityConflictError {
  constructor(message = "Command identity was used with other content") {
    super(message);
  }
}

export const isCommunityIdempotencyConflictError = (
  error: unknown,
): error is CommunityIdempotencyConflictError =>
  error instanceof CommunityIdempotencyConflictError;
