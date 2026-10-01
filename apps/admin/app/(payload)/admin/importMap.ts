import { MediaSnapshotPicker as MediaSnapshotPicker_a43c203023e3389c5dc6b4863a273b24 } from "../../../src/media/MediaSnapshotPicker";
import { OwnerWithdrawButton as OwnerWithdrawButton_9e998a9a7cb97e1d133b14fcf3c6aaf1 } from "../../../src/owner-workflow/OwnerWithdrawButton";
import { CatalogOwnershipField as CatalogOwnershipField_d68431953f65de60bd9cd6665817055b } from "../../../src/media/CatalogOwnershipField";
import { OriginalRightsField as OriginalRightsField_f0988f7c8f9ddbf7bb7be320ee5c0422 } from "../../../src/media/OriginalMediaMetadataField";
import { OriginalOrderConfidenceField as OriginalOrderConfidenceField_f0988f7c8f9ddbf7bb7be320ee5c0422 } from "../../../src/media/OriginalMediaMetadataField";
import { CommunityNavGroups as CommunityNavGroups_2abcbe3af7cd0474b6c7e39c62ec32e3 } from "../../../src/community/NavGroup";
import { CommunityDashboardCard as CommunityDashboardCard_04d062f16b5363b8f080834354c73870 } from "../../../src/community/DashboardCard";
import { S3ClientUploadHandler as S3ClientUploadHandler_f97aa6c64367fa259c5bc0567239ef24 } from "@payloadcms/storage-s3/client";
import { OwnerWorkflowView as OwnerWorkflowView_6be79d619593d3e50db1d13a833f41ac } from "../../../src/owner-workflow/View";
import { CommunityModerationView as CommunityModerationView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { ThreadsView as ThreadsView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { DmModerationView as DmModerationView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { CommunitySettingsView as CommunitySettingsView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { CommunityContentView as CommunityContentView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { CommunityHistoryView as CommunityHistoryView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { WorkSubmissionsView as WorkSubmissionsView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { AgentConnectionsView as AgentConnectionsView_3d1d3bf96b1194d419c311865cb1d9cc } from "../../../src/agent-connections/View";
import { AgentConsentView as AgentConsentView_3d1d3bf96b1194d419c311865cb1d9cc } from "../../../src/agent-connections/View";
import { AccountCapacityView as AccountCapacityView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { PublishingJobsView as PublishingJobsView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { AgentOperationsView as AgentOperationsView_86a1b3c9ec56e37b61bf12e13c3d66d2 } from "../../../src/community/View";
import { CollectionCards as CollectionCards_f9c02e79a4aed9a3924487c0cd4cafb1 } from "@payloadcms/next/rsc";
import { AdminLogo, AdminIcon } from "../../../src/branding/Brand";

/** @type import('payload').ImportMap */
export const importMap = {
  "/src/branding/Brand#AdminLogo": AdminLogo,
  "/src/branding/Brand#AdminIcon": AdminIcon,
  "./src/media/MediaSnapshotPicker#MediaSnapshotPicker":
    MediaSnapshotPicker_a43c203023e3389c5dc6b4863a273b24,
  "/src/owner-workflow/OwnerWithdrawButton#OwnerWithdrawButton":
    OwnerWithdrawButton_9e998a9a7cb97e1d133b14fcf3c6aaf1,
  "./src/media/CatalogOwnershipField#CatalogOwnershipField":
    CatalogOwnershipField_d68431953f65de60bd9cd6665817055b,
  "./src/media/OriginalMediaMetadataField#OriginalRightsField":
    OriginalRightsField_f0988f7c8f9ddbf7bb7be320ee5c0422,
  "./src/media/OriginalMediaMetadataField#OriginalOrderConfidenceField":
    OriginalOrderConfidenceField_f0988f7c8f9ddbf7bb7be320ee5c0422,
  "/src/community/NavGroup#CommunityNavGroups":
    CommunityNavGroups_2abcbe3af7cd0474b6c7e39c62ec32e3,
  "/src/community/DashboardCard#CommunityDashboardCard":
    CommunityDashboardCard_04d062f16b5363b8f080834354c73870,
  "@payloadcms/storage-s3/client#S3ClientUploadHandler":
    S3ClientUploadHandler_f97aa6c64367fa259c5bc0567239ef24,
  "/src/owner-workflow/View#OwnerWorkflowView":
    OwnerWorkflowView_6be79d619593d3e50db1d13a833f41ac,
  "/src/community/View#CommunityModerationView":
    CommunityModerationView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#ThreadsView":
    ThreadsView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#DmModerationView":
    DmModerationView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#CommunitySettingsView":
    CommunitySettingsView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#CommunityContentView":
    CommunityContentView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#CommunityHistoryView":
    CommunityHistoryView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#WorkSubmissionsView":
    WorkSubmissionsView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/agent-connections/View#AgentConnectionsView":
    AgentConnectionsView_3d1d3bf96b1194d419c311865cb1d9cc,
  "/src/agent-connections/View#AgentConsentView":
    AgentConsentView_3d1d3bf96b1194d419c311865cb1d9cc,
  "/src/community/View#AccountCapacityView":
    AccountCapacityView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#PublishingJobsView":
    PublishingJobsView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "/src/community/View#AgentOperationsView":
    AgentOperationsView_86a1b3c9ec56e37b61bf12e13c3d66d2,
  "@payloadcms/next/rsc#CollectionCards":
    CollectionCards_f9c02e79a4aed9a3924487c0cd4cafb1,
};
