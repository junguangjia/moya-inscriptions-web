import type { MentionReference } from "@moya/contracts";
import type {
  DiscussionTarget,
  DiscussionPage,
  DiscussionReply,
  DiscussionReplyPage,
  OwnComment,
} from "@moya/contracts";
import type { AuthorPage } from "./author-community-port.js";
export interface DiscussionQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly pinned?: readonly string[];
}
export interface DiscussionPort {
  discussionTarget(id: string): Promise<DiscussionTarget>;
  readDiscussion(
    target: DiscussionTarget,
    viewer: string | null,
    query: DiscussionQuery,
  ): Promise<DiscussionPage>;
  readDiscussionReplies(
    target: DiscussionTarget,
    rootId: string,
    viewer: string | null,
    query: DiscussionQuery,
  ): Promise<DiscussionReplyPage>;
  submitDiscussion(
    target: DiscussionTarget,
    actor: string,
    text: string,
    rootId?: string,
    replyTo?: string,
    mentions?: readonly MentionReference[],
  ): Promise<{
    id: string;
    rootId: string;
    item: DiscussionReply;
    awaitingApproval: boolean;
  }>;
  setDiscussionLike(
    actor: string,
    id: string,
    enabled: boolean,
    requestId: string,
  ): Promise<void>;
  deleteDiscussionBody(
    actor: string,
    id: string,
    requestId: string,
  ): Promise<void>;
  removeDiscussionThread(
    operator: string,
    rootId: string,
    requestId: string,
    expectedCount: number,
  ): Promise<{ removed: number }>;
  operatorDeleteBody(
    operator: string,
    id: string,
    requestId: string,
  ): Promise<void>;
  ownComments(
    actor: string,
    query: DiscussionQuery,
  ): Promise<AuthorPage<OwnComment>>;
  locateDiscussion(
    target: DiscussionTarget,
    id: string,
    viewer: string,
    query: DiscussionQuery,
  ): Promise<{ rootId: string; page: number; replyPage: number }>;
}
