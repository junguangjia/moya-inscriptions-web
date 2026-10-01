import type {
  ThreadId,
  ThreadListQuery,
  ThreadPage,
  ThreadReadResult,
  ThreadSummary,
  UserWork,
} from "@moya/contracts";
import type {
  CreateThreadCommand,
  OperatorThread,
  OperatorThreadPage,
  UpdateThreadCommand,
} from "@moya/contracts/internal/community-operator";

import type { AuthorListQuery } from "@moya/contracts";
import type { AuthorPage } from "./author-community-port.js";

/**
 * content-community-completion-v1: Threads over Works. Public reads see only
 * unhidden Threads and count only eligible (publicly visible) posts; ranking
 * is evaluated at the caller's anchor instant so a browsing sequence is
 * stable. Read markers are clamped to server-observed activity. Operator
 * commands are receipted and audited through the content-operator tables.
 */
export interface ThreadPort {
  listThreads(
    viewer: string | null,
    query: ThreadListQuery,
  ): Promise<ThreadPage>;
  readThread(id: ThreadId, viewer: string | null): Promise<ThreadSummary>;
  listThreadPosts(
    id: ThreadId,
    viewer: string | null,
    query: AuthorListQuery,
  ): Promise<AuthorPage<UserWork>>;
  /** Records the latest eligible activity as seen by `actor`; never a client instant. */
  markThreadRead(id: ThreadId, actor: string): Promise<ThreadReadResult>;
  /** The Thread a Work belongs to, if any (public read; hidden Threads read as none). */
  threadOfWork(workId: string): Promise<ThreadId | null>;
  // Operator boundary (Owner): audited and receipted.
  operatorListThreads(query: {
    page: number;
    pageSize: number;
    includeHidden: boolean;
  }): Promise<OperatorThreadPage>;
  operatorCreateThread(
    operator: string,
    command: CreateThreadCommand,
  ): Promise<OperatorThread>;
  operatorUpdateThread(
    operator: string,
    id: string,
    command: UpdateThreadCommand,
  ): Promise<OperatorThread>;
}
