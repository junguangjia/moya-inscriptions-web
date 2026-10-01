export interface CommentUserPresentation {
  readonly avatarSrc?: string | null;
  readonly id: string;
  readonly name: string;
  readonly studioName?: string | undefined;
}

export interface CommentMediaPresentation {
  readonly alt: string;
  readonly id: string;
  readonly kind: "image" | "sticker";
  readonly src: string;
}

export interface CommentReply {
  readonly deleted?: boolean;
  readonly createdAtLabel: string;
  readonly id: string;
  readonly likeCount: number;
  readonly liked: boolean;
  readonly media?: readonly CommentMediaPresentation[];
  readonly replyToUser?: CommentUserPresentation;
  readonly text: string;
  readonly user: CommentUserPresentation;
}

export interface CommentItem {
  readonly deleted?: boolean;
  readonly replyPageTotal?: number;
  readonly replyRemaining?: number;
  readonly createdAtLabel: string;
  readonly id: string;
  readonly isQaGenerated: boolean;
  readonly likeCount: number;
  readonly liked: boolean;
  readonly media?: readonly CommentMediaPresentation[];
  readonly replies: readonly CommentReply[];
  /** The Backend's visible reply total; absent for QA fixtures. */
  readonly replyTotal?: number;
  readonly text: string;
  readonly user: CommentUserPresentation;
}

export interface CommentReplyTarget {
  /** The sibling reply being answered; absent when answering the root. */
  readonly replyId?: string;
  readonly rootCommentId: string;
  readonly user: CommentUserPresentation;
}
