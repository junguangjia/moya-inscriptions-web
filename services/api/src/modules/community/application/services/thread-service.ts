import {
  createThreadCommandSchema,
  operatorThreadsQuerySchema,
  updateThreadCommandSchema,
} from "@moya/contracts/internal/community-operator";

import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../errors/community-request-errors.js";
import { parseThreadId } from "../mappers/thread-contract-mapper.js";

import type { ThreadPort } from "../ports/thread-port.js";
import type {
  AuthorListQuery,
  ThreadId,
  ThreadListQuery,
} from "@moya/contracts";

const command = <T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  input: unknown,
): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new CommunityInputError();
  return result.data;
};

/** Application boundary for Threads; the adapter enforces eligibility and transactions. */
export class ThreadService {
  constructor(private readonly port: ThreadPort) {}

  private id(value: string): ThreadId {
    const parsed = parseThreadId(value);
    if (parsed === null) throw new CommunityNotFoundError();
    return parsed;
  }

  list(viewer: string | null, query: ThreadListQuery) {
    return this.port.listThreads(viewer, query);
  }

  read(id: string, viewer: string | null) {
    return this.port.readThread(this.id(id), viewer);
  }

  posts(id: string, viewer: string | null, query: AuthorListQuery) {
    return this.port.listThreadPosts(this.id(id), viewer, query);
  }

  markRead(id: string, actor: string) {
    return this.port.markThreadRead(this.id(id), actor);
  }

  threadOfWork(workId: string) {
    return this.port.threadOfWork(workId);
  }

  /** Operator inputs arrive untrusted; the Contracts decide what is a command. */
  operatorList(query: unknown) {
    return this.port.operatorListThreads(
      command(operatorThreadsQuerySchema, query),
    );
  }

  operatorCreate(operator: string, input: unknown) {
    return this.port.operatorCreateThread(
      operator,
      command(createThreadCommandSchema, input),
    );
  }

  operatorUpdate(operator: string, id: string, input: unknown) {
    const parsed = command(updateThreadCommandSchema, input);
    return this.port.operatorUpdateThread(operator, this.id(id), parsed);
  }
}
