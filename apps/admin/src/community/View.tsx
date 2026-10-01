import { DefaultTemplate } from "@payloadcms/next/templates";
import type { AdminViewServerProps } from "payload";

import { isOwner } from "../editorial/access";
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
 * history, plus the Development-only content and work publishing views (work
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
    <CommunityQueueClient
      phase4Enabled={process.env.NODE_ENV === "development"}
    />
  </OwnerOnly>
);

export const CommunitySettingsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <CommunitySettingsClient
      workPublishing={process.env.NODE_ENV === "development"}
    />
  </OwnerOnly>
);

export const CommunityHistoryView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <CommunityHistoryClient />
  </OwnerOnly>
);

export const CommunityContentView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    {process.env.NODE_ENV === "development" ? (
      <CommunityContentClient />
    ) : (
      <p>此页面暂不可用。</p>
    )}
  </OwnerOnly>
);

const DevelopmentOnly = ({
  children,
}: {
  readonly children: React.ReactNode;
}) =>
  process.env.NODE_ENV === "development" ? children : <p>此页面暂不可用。</p>;

export const WorkSubmissionsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <DevelopmentOnly>
      <WorkSubmissionsQueueClient />
    </DevelopmentOnly>
  </OwnerOnly>
);

export const AccountCapacityView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <DevelopmentOnly>
      <AccountCapacityClient />
    </DevelopmentOnly>
  </OwnerOnly>
);

export const PublishingJobsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <DevelopmentOnly>
      <PublishingJobsClient />
    </DevelopmentOnly>
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

// content-community-completion-v1: operator-managed Threads (Development only).
export const ThreadsView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <DevelopmentOnly>
      <ThreadsClient />
    </DevelopmentOnly>
  </OwnerOnly>
);

// content-community-completion-v1: narrow Owner-only DM moderation (Development only).
export const DmModerationView = (props: AdminViewServerProps) => (
  <OwnerOnly props={props}>
    <DevelopmentOnly>
      <DmModerationClient />
    </DevelopmentOnly>
  </OwnerOnly>
);
