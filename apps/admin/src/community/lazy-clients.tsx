"use client";

import dynamic from "next/dynamic";

const loading = () => <p role="status">正在打开…</p>;

export const ArticleSubmissionsQueueClient = dynamic(
  () =>
    import("./article-submissions-client").then(
      (module) => module.ArticleSubmissionsQueueClient,
    ),
  { loading },
);

export const AccountCapacityClient = dynamic(
  () =>
    import("./account-capacity-client").then(
      (module) => module.AccountCapacityClient,
    ),
  { loading },
);

export const AgentOperationsClient = dynamic(
  () =>
    import("./agent-operations-client").then(
      (module) => module.AgentOperationsClient,
    ),
  { loading },
);

export const CommunityContentClient = dynamic(
  () =>
    import("./content-client").then((module) => module.CommunityContentClient),
  { loading },
);

export const CommunityHistoryClient = dynamic(
  () =>
    import("./history-client").then((module) => module.CommunityHistoryClient),
  { loading },
);

export const CommunityFeedbackClient = dynamic(
  () =>
    import("./feedback-client").then(
      (module) => module.CommunityFeedbackClient,
    ),
  { loading },
);

export const PublishingJobsClient = dynamic(
  () =>
    import("./publishing-jobs-client").then(
      (module) => module.PublishingJobsClient,
    ),
  { loading },
);

export const CommunityQueueClient = dynamic(
  () => import("./queue-client").then((module) => module.CommunityQueueClient),
  { loading },
);

export const CommunityReportsClient = dynamic(
  () =>
    import("./reports-client").then((module) => module.CommunityReportsClient),
  { loading },
);

export const ThreadsClient = dynamic(
  () => import("./threads-client").then((module) => module.ThreadsClient),
  { loading },
);

export const DmModerationClient = dynamic(
  () =>
    import("./dm-moderation-client").then(
      (module) => module.DmModerationClient,
    ),
  { loading },
);

export const CommunitySettingsClient = dynamic(
  () =>
    import("./settings-client").then(
      (module) => module.CommunitySettingsClient,
    ),
  { loading },
);

export const WorkSubmissionsQueueClient = dynamic(
  () =>
    import("./work-submissions-client").then(
      (module) => module.WorkSubmissionsQueueClient,
    ),
  { loading },
);
