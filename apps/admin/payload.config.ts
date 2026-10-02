import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "payload";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { guardCmsMigrationAdapter } from "./src/migration/guard";
import { zh } from "@payloadcms/translations/languages/zh";
import { Users } from "./src/users";
import { Articles } from "./src/editorial-content/articles";
import { ArticleCollections } from "./src/editorial-content/article-collections";
import { EditorialArticleApprovals } from "./src/editorial-content/approvals";
import { editorialFields } from "./src/fields/editorial-fields";
import {
  catalogAccess,
  catalogHooks,
  EditorialIdentities,
  EditorialApprovals,
  EditorialReceipts,
  editorialEndpoints,
} from "./src/editorial";
import { agentConnectionEndpoints } from "./src/agent-connections/endpoints";
import { agentConnectionAuthenticateHeader } from "./src/agent-connections/discovery";
import { communityEndpoints } from "./src/community/endpoints";
import { editorialMcp } from "./src/mcp";
import { createMediaCollection } from "./src/media/collection";
import { createEditorialStoragePlugin } from "./src/media/storage";
import {
  canEditCatalog,
  catalogScopeAccess,
  isOwner,
} from "./src/editorial/access";
import { adminPreviewURL, editorialPreviewEndpoint } from "./src/preview";
import {
  cmsDatabasePool,
  assertCmsProductionEnvironment,
  cmsRuntimeLogFields,
  requiredSetting,
} from "./src/runtime-settings";
assertCmsProductionEnvironment();
const dirname = path.dirname(fileURLToPath(import.meta.url));
export default buildConfig({
  secret: requiredSetting("CMS_SECRET"),
  admin: {
    user: "users",
    importMap: {
      autoGenerate: false,
      baseDir: dirname,
      importMapFile: path.resolve(dirname, "app/(payload)/admin/importMap.ts"),
    },
    meta: {
      titleSuffix: "— 由于艺管理端",
      icons: {
        icon: [
          { url: "/admin/brand.svg", type: "image/svg+xml", sizes: "any" },
        ],
      },
    },
    components: {
      graphics: {
        Logo: "/src/branding/Brand#AdminLogo",
        Icon: "/src/branding/Brand#AdminIcon",
      },
      views: {
        editorialWorkflow: {
          Component: "/src/owner-workflow/View#OwnerWorkflowView",
          path: "/editorial-workflow",
          exact: true,
        },
        // Community: the review queue is the primary working surface; the
        // publication setting and the operation history are their own views.
        communityModeration: {
          Component: "/src/community/View#CommunityModerationView",
          path: "/community-moderation",
          exact: true,
        },
        // content-community-completion-v1: Threads over Works (Development).
        communityThreads: {
          Component: "/src/community/View#ThreadsView",
          path: "/community-moderation/threads",
          exact: true,
        },
        communityDirectMessages: {
          Component: "/src/community/View#DmModerationView",
          path: "/community-moderation/direct-messages",
          exact: true,
        },
        communitySettings: {
          Component: "/src/community/View#CommunitySettingsView",
          path: "/community-moderation/settings",
          exact: true,
        },
        communityContent: {
          Component: "/src/community/View#CommunityContentView",
          path: "/community-moderation/content",
          exact: true,
        },
        communityHistory: {
          Component: "/src/community/View#CommunityHistoryView",
          path: "/community-moderation/history",
          exact: true,
        },
        // Work publishing (Development): explicit submission review, account
        // capacity designation and content-free publishing job outcomes.
        communityWorkSubmissions: {
          Component: "/src/community/View#WorkSubmissionsView",
          path: "/community-moderation/work-submissions",
          exact: true,
        },
        // Agent Connections (Development): the Owner's own list of AI
        // connections, and the review page the consent landing continues to.
        // The LANDING itself is deliberately not here -- it lives outside
        // /admin because it must render for a browser that withheld the
        // SameSite=Strict session on the provider's cross-site redirect.
        agentConnections: {
          Component: "/src/agent-connections/View#AgentConnectionsView",
          path: "/agent-connections",
          exact: true,
        },
        agentConnectionsConsent: {
          Component: "/src/agent-connections/View#AgentConsentView",
          path: "/agent-connections/consent",
          exact: true,
        },
        communityAccountCapacity: {
          Component: "/src/community/View#AccountCapacityView",
          path: "/community-moderation/account-capacity",
          exact: true,
        },
        communityPublishingJobs: {
          Component: "/src/community/View#PublishingJobsView",
          path: "/community-moderation/publishing-jobs",
          exact: true,
        },
        // Agent Administration V1 (Development): principals, delegations and
        // prepared operations awaiting the Owner's approval.
        communityAgentOperations: {
          Component: "/src/community/View#AgentOperationsView",
          path: "/community-moderation/agent-operations",
          exact: true,
        },
      },
      // Work-oriented groups after the collection groups: 社区 and 自动化工具.
      afterNavLinks: [
        {
          path: "/src/community/NavGroup#CommunityNavGroups",
          clientProps: {
            developmentAgentsEnabled: process.env.NODE_ENV === "development",
          },
        },
      ],
      beforeDashboard: ["/src/community/DashboardCard#CommunityDashboardCard"],
    },
  },
  i18n: { fallbackLanguage: "zh", supportedLanguages: { zh } },
  graphQL: { disable: true },
  telemetry: false,
  logger: {
    options: {
      base: null,
      hooks: {
        logMethod(args, method) {
          method.apply(this, [cmsRuntimeLogFields(args)]);
        },
      },
    },
  },
  db: guardCmsMigrationAdapter(
    postgresAdapter({
      pool: cmsDatabasePool(),
      push: false,
      disableCreateDatabase: true,
      migrationDir: path.resolve(dirname, "src/migrations"),
    }),
  ),
  collections: [
    Users,
    {
      slug: "catalogs",
      disableBulkEdit: true,
      labels: { singular: "资料", plural: "资料" },
      admin: {
        preview: adminPreviewURL,
        components: {
          edit: {
            UnpublishButton:
              "/src/owner-workflow/OwnerWithdrawButton#OwnerWithdrawButton",
          },
        },
        useAsTitle: "title",
        defaultColumns: ["title", "kind", "catalogId", "revision", "_status"],
        group: "内容",
      },
      access: catalogAccess,
      hooks: catalogHooks,
      versions: {
        drafts: { autosave: { interval: 1500 }, validate: true },
        maxPerDoc: 100,
      },
      fields: [
        {
          name: "lastEditedBy",
          type: "relationship",
          relationTo: "users",
          admin: { readOnly: true, position: "sidebar" },
        },
        {
          name: "revision",
          type: "number",
          defaultValue: 0,
          admin: { readOnly: true, position: "sidebar" },
        },
        ...editorialFields,
      ],
    },
    createMediaCollection({
      read: ({ req }) => catalogScopeAccess(req),
      canWrite: canEditCatalog,
      canRegister: isOwner,
      localDirectory: requiredSetting("CMS_MEDIA_DIR"),
    }),
    EditorialIdentities,
    EditorialApprovals,
    EditorialReceipts,
    // content-community-completion-v1: editorial content collections.
    Articles,
    ArticleCollections,
    EditorialArticleApprovals,
  ],
  endpoints: [
    ...editorialEndpoints,
    ...communityEndpoints,
    // Empty unless the connection surface is composed at all; the gate is the
    // array, not a branch inside a handler.
    ...agentConnectionEndpoints(),
    editorialPreviewEndpoint,
  ],
  plugins: [createEditorialStoragePlugin(), editorialMcp()],
  hooks: {
    // The one header a standards-based MCP client needs before it has a token.
    //
    // A 401 from `/api/mcp` used to carry nothing, so a client following the
    // MCP authorization spec had no way to learn where the authorization
    // server is — measured against the running service, not inferred. Payload
    // runs `afterError` before it builds the response and merges
    // `req.responseHeaders` into it, so this is the supported seam; the
    // alternative was patching the MCP plugin.
    //
    // Only that path, only that status, and only the metadata pointer: no
    // `error="invalid_token"`, because the boundary answers ONE shape whatever
    // went wrong and telling a prober which rule refused them would undo that.
    afterError: [agentConnectionAuthenticateHeader],
  },
  typescript: {
    autoGenerate: false,
    outputFile: path.resolve(dirname, "src/payload-types.ts"),
  },
});
