import { NotificationService } from "@moya/api";
import type { NotificationPort, NotificationWorkerPort } from "@moya/api";
import {
  NotificationSignals,
  NotificationStreams,
} from "./community/notification-stream.js";
import {
  createDevelopmentCatalogFixtureQueryPort,
  createDevelopmentCatalogFixtureSearchPort,
  developmentMediaUrlsByObjectKey,
} from "./catalog/development-catalog-fixture.js";
import { createRouter } from "./http/router.js";

import {
  AgentAdministrationService,
  AuthorCommunityService,
  CatalogCommentService,
  CatalogReadService,
  CommunityModerationService,
  CommunityAuthService,
  CommunitySessionService,
  DirectMessageService,
  EditorialContentReadService,
  PublishingOperatorService,
  ThreadService,
  PublishingTransferRegistry,
  WorkPublishingService,
} from "@moya/api";
import { MappedStorageUrlResolver } from "@moya/image";

import type {
  AgentAdministrationPort,
  AuthorCommunityPort,
  CommunityContentOperatorPort,
  DiscussionPort,
  CommunityDiscoveryPort,
  CatalogPublicationPort,
  CommentAnalysisPort,
  CatalogQueryPort,
  CatalogSearchQueryPort,
  CommunityCommentPort,
  CommunityIdentityPort,
  DirectMessagePort,
  EditorialContentReadPort,
  ThreadPort,
  PublishingMediaProcessorPort,
  PublishingMediaStorePort,
  PublishingOperatorPort,
  PublishingTransferPolicy,
  StorageUrlResolver,
  WorkPublishingPort,
} from "@moya/api";
import type { NodeEnvironment } from "./config.js";
import type { HealthReadinessCheck } from "./health/health-handler.js";
import type { CommunityRouterDependencies } from "./http/router.js";
import type { RequestListener } from "node:http";

export interface BackendApplicationOptions {
  readonly notificationPort?: NotificationPort;
  readonly notificationWorkerPort?: NotificationWorkerPort;
  readonly notificationSignals?: NotificationSignals;
  readonly nodeEnv: NodeEnvironment;
  readonly catalogQueryPort?: CatalogQueryPort;
  readonly catalogSearchQueryPort?: CatalogSearchQueryPort;
  readonly storageUrlResolver?: StorageUrlResolver;
  readonly healthReadinessCheck?: HealthReadinessCheck;
  /** Backend-owned identity and sessions; without it every credential is unauthenticated. */
  readonly communityIdentityPort?: CommunityIdentityPort;
  /**
   * Email and phone authentication. Refused in production: this task does not
   * expose public registration there.
   */
  readonly authService?: CommunityAuthService;
  readonly authorCommunityPort?: AuthorCommunityPort;
  readonly discussionPort?: DiscussionPort;
  readonly contentOperatorPort?: CommunityContentOperatorPort;
  readonly discoveryPort?: CommunityDiscoveryPort;
  /** Comments, moderation and the publication setting; requires the identity port. */
  readonly communityCommentPort?: CommunityCommentPort;
  /** Answers whether a Catalog record is currently published, from the Catalog read side. */
  readonly catalogPublicationPort?: CatalogPublicationPort;
  /** Advisory analysis provider; absent means the boundary reports "not connected". */
  readonly communityAnalysisPort?: CommentAnalysisPort;
  /** The Owner's operator credential; empty leaves the internal subpath closed. */
  readonly communityOperatorCredential?: string;
  /** Work publishing persistence; composed only under NODE_ENV=development with the author port. */
  readonly workPublishingPort?: WorkPublishingPort;
  /** Owner work publishing operations; composed only under NODE_ENV=development. */
  readonly publishingOperatorPort?: PublishingOperatorPort;
  /** Agent administration persistence; composed only under NODE_ENV=development. */
  readonly agentAdministrationPort?: AgentAdministrationPort;
  /** Private media bytes; without it uploads and media reads answer 503. */
  readonly publishingMediaStore?: PublishingMediaStorePort;
  /** Derivative processing; without it no media item is accepted (503). */
  readonly publishingMediaProcessor?: PublishingMediaProcessorPort;
  /**
   * Shared with the publishing worker in the same process so cancels and
   * session expiry stop transfers; create it with
   * {@link createPublishingTransferRegistry}. A private registry otherwise.
   */
  readonly publishingTransfers?: PublishingTransferRegistry;
  /** Published editorial content reads; composed only under NODE_ENV=development. */
  readonly editorialContentPort?: EditorialContentReadPort;
  /** Threads over Works; composed only under NODE_ENV=development. */
  readonly threadPort?: ThreadPort;
  /** Direct messages; composed only under NODE_ENV=development. */
  readonly directMessagePort?: DirectMessagePort;
  /** Injected clock for publishing commands; defaults to the system clock. */
  readonly publishingClock?: () => Date;
  /** Upload idle timeout and refusal read window; defaults 120 s and 5 s. */
  readonly publishingTransferPolicy?: Partial<PublishingTransferPolicy>;
}

/**
 * The in-process registry of streaming component uploads. A composition root
 * that also runs the publishing worker creates exactly one, passes it as
 * `publishingTransfers` and hands its `stop(componentIds)` to the worker, so a
 * session the worker expires stops its live transfers early; the port fence
 * refuses their commits in any case. Composition roots never import the
 * application package for this.
 */
export const createPublishingTransferRegistry =
  (): PublishingTransferRegistry => new PublishingTransferRegistry();

const resolveCatalogQueryPort = ({
  nodeEnv,
  catalogQueryPort,
}: BackendApplicationOptions): CatalogQueryPort => {
  if (catalogQueryPort !== undefined) return catalogQueryPort;
  if (nodeEnv !== "production") {
    return createDevelopmentCatalogFixtureQueryPort();
  }

  throw new Error(
    "A CatalogQueryPort must be explicitly provided in production",
  );
};

const resolveStorageUrlResolver = ({
  nodeEnv,
  storageUrlResolver,
}: BackendApplicationOptions): StorageUrlResolver => {
  if (storageUrlResolver !== undefined) return storageUrlResolver;
  if (nodeEnv !== "production") {
    return new MappedStorageUrlResolver(developmentMediaUrlsByObjectKey);
  }

  throw new Error(
    "A StorageUrlResolver must be explicitly provided in production",
  );
};

// Work publishing exists only under NODE_ENV=development: the author routes
// with the author port, the operator routes with the operator port.
const resolvePublishing = (
  options: BackendApplicationOptions,
): Pick<
  CommunityRouterDependencies,
  "publishingService" | "publishingOperatorService"
> => {
  if (options.nodeEnv !== "development") return {};
  const shared = {
    store: options.publishingMediaStore,
    clock: options.publishingClock,
  };
  return {
    ...(options.authorCommunityPort !== undefined &&
    options.workPublishingPort !== undefined
      ? {
          publishingService: new WorkPublishingService(
            options.workPublishingPort,
            {
              ...shared,
              processor: options.publishingMediaProcessor,
              transfers: options.publishingTransfers,
              transferPolicy: options.publishingTransferPolicy,
            },
          ),
        }
      : {}),
    ...(options.publishingOperatorPort !== undefined
      ? {
          publishingOperatorService: new PublishingOperatorService(
            options.publishingOperatorPort,
            shared,
          ),
        }
      : {}),
  };
};

// Without an identity and comment port no session or comment can exist and no
// community route is composed; the production composition root always wires the
// App-role adapters. The Development sign-in entry itself exists only under
// NODE_ENV=development, and the operator boundary only with a credential.
const resolveCommunity = (
  options: BackendApplicationOptions,
  catalogPublicationPort: CatalogPublicationPort,
  storageUrlResolver: StorageUrlResolver,
): CommunityRouterDependencies | undefined => {
  const { nodeEnv, communityIdentityPort, communityCommentPort } = options;
  if (communityIdentityPort === undefined) return undefined;
  if (nodeEnv === "production" && options.authService !== undefined)
    throw new Error("Public authentication is not composed in production");
  const sessionService = new CommunitySessionService(communityIdentityPort);
  const threadService =
    nodeEnv === "development" && options.threadPort !== undefined
      ? new ThreadService(options.threadPort)
      : undefined;
  const directMessageService =
    nodeEnv === "development" && options.directMessagePort !== undefined
      ? new DirectMessageService(options.directMessagePort)
      : undefined;
  return {
    sessionService,
    ...(nodeEnv === "development" && options.authService !== undefined
      ? { authService: options.authService }
      : {}),
    ...(nodeEnv === "development" && options.notificationPort
      ? {
          notificationService: new NotificationService(
            options.notificationPort,
          ),
          notificationStreams: new NotificationStreams(
            sessionService,
            options.notificationSignals ?? new NotificationSignals(),
          ),
        }
      : {}),
    ...(nodeEnv === "development" && options.authorCommunityPort !== undefined
      ? {
          authorService: new AuthorCommunityService(
            options.authorCommunityPort,
            catalogPublicationPort,
            options.discussionPort,
            options.discoveryPort,
            storageUrlResolver,
            options.editorialContentPort === undefined
              ? undefined
              : new EditorialContentReadService(
                  options.editorialContentPort,
                  storageUrlResolver,
                ),
            threadService,
            directMessageService,
          ),
        }
      : {}),
    ...(threadService === undefined ? {} : { threadService }),
    ...(directMessageService === undefined ? {} : { directMessageService }),
    // Work publishing is Development only, like the Phase 4 author surface.
    ...resolvePublishing(options),
    developmentEntry: nodeEnv === "development",
    ...(nodeEnv === "development"
      ? {
          contentOperatorPort: options.contentOperatorPort,
          discussionPort: options.discussionPort,
        }
      : {}),
    // Comments and moderation need their own port; identity works without it.
    ...(communityCommentPort === undefined
      ? {}
      : {
          commentService: new CatalogCommentService(
            communityCommentPort,
            catalogPublicationPort,
            nodeEnv === "development" && options.discussionPort
              ? { discussionPort: options.discussionPort }
              : {},
          ),
          moderationService: new CommunityModerationService(
            communityCommentPort,
            communityIdentityPort,
            catalogPublicationPort,
            {
              ...(nodeEnv === "development" && options.contentOperatorPort
                ? { contentOperatorPort: options.contentOperatorPort }
                : {}),
              ...(options.communityAnalysisPort === undefined
                ? {}
                : { analysisPort: options.communityAnalysisPort }),
            },
          ),
        }),
    // Agent administration shares the moderation and content operator ports;
    // it exists only in Development, like every phase 4 operator surface.
    ...(nodeEnv === "development" &&
    communityCommentPort !== undefined &&
    options.agentAdministrationPort !== undefined
      ? {
          agentAdministrationService: new AgentAdministrationService(
            options.agentAdministrationPort,
            {
              commentPort: communityCommentPort,
              identityPort: communityIdentityPort,
              catalogPort: catalogPublicationPort,
              contentOperatorPort: options.contentOperatorPort,
              discussionPort: options.discussionPort,
            },
          ),
        }
      : {}),
    operatorCredential: options.communityOperatorCredential ?? "",
  };
};

/** Composes the HTTP listener before any TCP listener is created. */
export const createBackendApplication = (
  options: BackendApplicationOptions,
): RequestListener => {
  const catalogQueryPort = resolveCatalogQueryPort(options);
  const storageUrlResolver = resolveStorageUrlResolver(options);
  const community = resolveCommunity(
    options,
    options.catalogPublicationPort ?? {
      // A comment may only attach to a record the Catalog read side publishes;
      // the same read side names the record in the Owner's review queue.
      isPublished: async (catalogId) =>
        (await catalogQueryPort.getById(catalogId)) !== null,
      readTitle: async (catalogId) =>
        (await catalogQueryPort.getById(catalogId))?.title ?? null,
    },
    storageUrlResolver,
  );
  return createRouter({
    catalogReadService: new CatalogReadService(
      catalogQueryPort,
      storageUrlResolver,
      options.catalogSearchQueryPort ??
        (options.nodeEnv !== "production" &&
        options.catalogQueryPort === undefined
          ? createDevelopmentCatalogFixtureSearchPort()
          : undefined),
    ),
    healthReadinessCheck:
      options.healthReadinessCheck ?? (async (): Promise<void> => undefined),
    ...(community === undefined ? {} : { community }),
  });
};
