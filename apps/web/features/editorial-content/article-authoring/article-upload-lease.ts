import type {
  PublishingHolder,
  PublishingMediaItem,
  PublishingSession,
  RegisterMediaItemCommand,
} from "@moya/contracts";
import type { publishingClient } from "../../../lib/public-api/work-publishing-client";

type LeaseClient = Pick<
  typeof publishingClient,
  "createSession" | "discardSession" | "heartbeatSession" | "registerItem"
>;

/** Registration and retirement share one queue, including the last HTTP await. */
export const createArticleUploadLease = (options: {
  readonly client: LeaseClient;
  readonly signal: AbortSignal;
  readonly requireAccount: () => void;
  readonly requestId: () => string;
  readonly onSession: (session: PublishingSession | null) => void;
}) => {
  let current: PublishingSession | null = null;
  let createId = options.requestId();
  let retirement: {
    readonly id: PublishingSession["id"];
    readonly requestId: string;
  } | null = null;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const registrations = new Map<
    string,
    {
      readonly intent: string;
      readonly command: RegisterMediaItemCommand;
      itemId: string | null;
    }
  >();
  const requireCurrent = () => {
    if (closed || options.signal.aborted)
      throw new Error("article_upload_closed");
    options.requireAccount();
  };
  const serialize = <Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const next = tail.then(() => {
      requireCurrent();
      return operation();
    });
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const finishRetirement = async () => {
    if (retirement === null) return;
    const exact = retirement;
    await options.client.discardSession(
      exact.id,
      { requestId: exact.requestId },
      options.signal,
    );
    requireCurrent();
    if (retirement !== exact)
      throw new Error("article_upload_retirement_changed");
    retirement = null;
    current = null;
    createId = options.requestId();
    options.onSession(null);
  };
  const ensure = async (): Promise<PublishingSession> => {
    requireCurrent();
    // An unknown discard must be reconciled with its original receipt before
    // any new holder or registration can use the retiring session.
    await finishRetirement();
    if (current === null) {
      const created = await options.client.createSession(
        { requestId: createId, workId: null },
        options.signal,
      );
      requireCurrent();
      if (created.workId !== null)
        throw new Error("article_upload_invalid_session");
      current = created;
      options.onSession(created);
    }
    return current;
  };
  return {
    holder: (): Promise<PublishingHolder> =>
      serialize(async () => ({ sessionId: (await ensure()).id })),
    register: (
      command: RegisterMediaItemCommand,
      signal?: AbortSignal,
    ): Promise<PublishingMediaItem> =>
      serialize(async () => {
        if (signal?.aborted) throw signal.reason;
        // A manager may have resolved its holder before a concurrent save's
        // retirement. Bind the first actual registration inside this queue.
        const { holder, ...intent } = command;
        void holder;
        const key = JSON.stringify(intent);
        const previous = registrations.get(command.requestId);
        if (previous !== undefined && previous.intent !== key)
          throw new Error("article_upload_registration_intent_changed");
        await finishRetirement();
        const exact =
          previous?.command ??
          structuredClone({
            ...command,
            holder: { sessionId: (await ensure()).id },
          });
        const receipt = previous ?? {
          intent: key,
          command: exact,
          itemId: null,
        };
        if (previous === undefined)
          registrations.set(command.requestId, receipt);
        const item = await options.client.registerItem(
          exact,
          signal === undefined
            ? options.signal
            : AbortSignal.any([signal, options.signal]),
        );
        requireCurrent();
        receipt.itemId = item.id;
        return item;
      }),
    retireCommitted: (used: ReadonlySet<string>, ready: () => boolean) =>
      serialize(async () => {
        await finishRetirement();
        if (current === null) return true;
        // A registration queued while a content save was in flight must also
        // have a verified item in that durable document before its holder retires.
        const id = current.id;
        if (
          !ready() ||
          [...registrations.values()].some(
            (receipt) =>
              "sessionId" in receipt.command.holder &&
              receipt.command.holder.sessionId === id &&
              (receipt.itemId === null || !used.has(receipt.itemId)),
          )
        )
          return false;
        retirement = { id, requestId: options.requestId() };
        await finishRetirement();
        return true;
      }),
    discard: () =>
      serialize(async () => {
        if (retirement === null && current !== null)
          retirement = { id: current.id, requestId: options.requestId() };
        await finishRetirement();
      }),
    heartbeat: () =>
      serialize(async () => {
        if (current === null || retirement !== null) return;
        const id = current.id;
        const answer = await options.client.heartbeatSession(
          id,
          options.signal,
        );
        requireCurrent();
        if (answer.id !== id)
          throw new Error("article_upload_invalid_heartbeat");
        current = answer;
        options.onSession(answer);
      }),
    dispose: () => {
      closed = true;
      registrations.clear();
      current = null;
      retirement = null;
      options.onSession(null);
    },
  };
};
