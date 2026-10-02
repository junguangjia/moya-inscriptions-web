import { DefaultTemplate } from "@payloadcms/next/templates";
import type { AdminViewServerProps } from "payload";

import { isOwner } from "../editorial/access";
import { ArticleSubmissionsQueueClient } from "./article-submissions-client";
import { AccountCapacityClient } from "./account-capacity-client";
import { AgentOperationsClient } from "./agent-operations-client";
import { CommunityContentClient } from "./content-client";
import { CommunityHistoryClient } from "./history-client";
import { PublishingJobsClient } from "./publishing-jobs-client";
import { CommunityQueueClient } from "./queue-client";
import { ThreadsClient } from "./threads-client";
import { DmModerationClient } from "./dm-moderation-client";
import { CommunitySettingsClient } from "./settings-client";
import { WorkSubmissionsQueueClient } from "./work-submissions-client";

/**
 * The Community views inside the standard Admin shell: the review queue (the
 * primary working surface), the publication setting and the operation
 * history, plus the content and work publishing views (work
 * submissions, account capacity, publishing jobs). Each is Owner-only;
 * `automation` never moderates.
 */
const OwnerOnly = ({
  children,
  props,
}: {
  readonly children: React.ReactNode;
  readonly props: AdminViewServerProps;
}) => {
  const { req, visibleEntities } = props.initPageResult;
  return (
    <DefaultTemplate {...props} req={req} visibleEntities={visibleEntities}>
      {isOwner(req) ? children : <p role="alert">此工作区仅限 Owner。</p>}
    </DefaultTemplate>
  );
};

export const CommunityModerationView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <CommunityQueueClient phase4Enabled />
  </OwnerOnly>
);

export const CommunitySettingsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <CommunitySettingsClient workPublishing />
  </OwnerOnly>
);

export const CommunityHistoryView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <CommunityHistoryClient />
  </OwnerOnly>
);

export const CommunityContentView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <CommunityContentClient />
  </OwnerOnly>
);

export const WorkSubmissionsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <WorkSubmissionsQueueClient />
  </OwnerOnly>
);

export const AccountCapacityView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <AccountCapacityClient />
  </OwnerOnly>
);

export const PublishingJobsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <PublishingJobsClient />
  </OwnerOnly>
);

/** Agent Administration V1 (Development): Owner-only registry, delegations and approvals. */
export const AgentOperationsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    {process.env.NODE_ENV === "development" ? (
      <AgentOperationsClient />
    ) : (
      <p role="alert">代理操作仅在开发环境可用。</p>
    )}
  </OwnerOnly>
);

// content-community-completion-v1: operator-managed Threads.
export const ThreadsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <ThreadsClient />
  </OwnerOnly>
);

// content-community-completion-v1: narrow Owner-only DM moderation.
export const DmModerationView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <DmModerationClient />
  </OwnerOnly>
);

/** Authored Article submissions, separate from Payload editorial Articles. */
export const ArticleSubmissionsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <ArticleSubmissionsQueueClient />
  </OwnerOnly>
);
