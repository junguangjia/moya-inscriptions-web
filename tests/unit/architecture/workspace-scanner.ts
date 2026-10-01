import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set([
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

export interface WorkspaceManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  moyaArchitecture?: {
    rawSourceAccess?: "controlled-importer";
  };
}

export interface WorkspaceInfo {
  manifest: WorkspaceManifest;
  root: string;
  sourceFiles: string[];
}

export interface ModuleReference {
  kind: "dynamic-import" | "export-from" | "static-import";
  specifier: string;
  typeOnly: boolean;
}

const collectSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(
          ...(await collectSourceFiles(path.join(directory, entry.name))),
        );
      }
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files.sort();
};

const readWorkspace = async (
  workspaceRoot: string,
): Promise<WorkspaceInfo> => ({
  manifest: JSON.parse(
    await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  ) as WorkspaceManifest,
  root: workspaceRoot,
  sourceFiles: await collectSourceFiles(workspaceRoot),
});

export const discoverWorkspaces = async (
  root: string = repositoryRoot,
): Promise<WorkspaceInfo[]> => {
  const roots = [path.join(root, "tests")];

  for (const group of ["apps", "packages", "services"]) {
    const groupRoot = path.join(root, group);
    const entries = await readdir(groupRoot, { withFileTypes: true });
    for (const entry of entries) {
      // Native Apple and HarmonyOS clients are not JS workspaces. Keep
      // manifest errors visible for every other existing/future Web workspace.
      if (
        entry.isDirectory() &&
        !(group === "apps" && ["apple", "harmony"].includes(entry.name))
      )
        roots.push(path.join(groupRoot, entry.name));
    }
  }

  return Promise.all(roots.sort().map(readWorkspace));
};

export const isPathInside = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

export const findOwningWorkspace = (
  workspaces: WorkspaceInfo[],
  candidate: string,
): WorkspaceInfo | undefined =>
  [...workspaces]
    .sort((left, right) => right.root.length - left.root.length)
    .find((workspace) => isPathInside(workspace.root, candidate));

export const extractModuleReferences = (source: string): ModuleReference[] => {
  const references: ModuleReference[] = [];
  const staticImport =
    /\bimport\s+(type\s+)?(?:[^"'`;]+?\s+from\s+)?(["'])([^"']+)\2/g;
  const exportFrom =
    /\bexport\s+(type\s+)?[^"'`;]+?\s+from\s+(["'])([^"']+)\2/g;
  const dynamicImport = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;

  for (const match of source.matchAll(staticImport)) {
    references.push({
      kind: "static-import",
      specifier: match[3] ?? "",
      typeOnly: match[1] !== undefined,
    });
  }
  for (const match of source.matchAll(exportFrom)) {
    references.push({
      kind: "export-from",
      specifier: match[3] ?? "",
      typeOnly: match[1] !== undefined,
    });
  }
  for (const match of source.matchAll(dynamicImport)) {
    references.push({
      kind: "dynamic-import",
      specifier: match[2] ?? "",
      typeOnly: false,
    });
  }

  return references.filter((reference) => reference.specifier !== "");
};

export const workspacePackageName = (specifier: string): string | undefined => {
  if (!specifier.startsWith("@moya/")) return undefined;
  return specifier.split("/").slice(0, 2).join("/");
};

export const declaredDependencies = (
  manifest: WorkspaceManifest,
): Record<string, string> => ({
  ...manifest.dependencies,
  ...manifest.devDependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});

/** Both the reviewed package name and matching manifest capability are required. */
export const authorizedRawSourceImporterPackageNames: ReadonlySet<string> =
  new Set(["@moya/catalog-importer"]);

const permanentFrontendWorkspaceNames = new Set(["web", "admin", "@moya/ui"]);
const browserRuntimeDependencies = new Set(["next", "react-dom"]);

export const isFrontendWorkspace = (workspace: WorkspaceInfo): boolean => {
  const dependencies = declaredDependencies(workspace.manifest);
  const knownFrontendRoots = [
    path.join(repositoryRoot, "apps", "web"),
    path.join(repositoryRoot, "apps", "admin"),
    path.join(repositoryRoot, "packages", "ui"),
  ];

  return (
    permanentFrontendWorkspaceNames.has(workspace.manifest.name) ||
    knownFrontendRoots.some((root) => isPathInside(root, workspace.root)) ||
    [...browserRuntimeDependencies].some(
      (dependency) => dependencies[dependency] !== undefined,
    )
  );
};

export const isRawSourceAccessAuthorized = (
  workspace: WorkspaceInfo,
  approvedPackageNames: ReadonlySet<string> = authorizedRawSourceImporterPackageNames,
): boolean =>
  !isFrontendWorkspace(workspace) &&
  approvedPackageNames.has(workspace.manifest.name) &&
  workspace.manifest.moyaArchitecture?.rawSourceAccess ===
    "controlled-importer";

export const hasUseClientDirective = (source: string): boolean =>
  /^(?:\uFEFF|\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(["'])use client\1\s*;/.test(
    source,
  );

const webRoot = path.join(repositoryRoot, "apps", "web");
const webPublicApiRoot = path.join(webRoot, "lib", "public-api");
const webHomePageFile = path.join(webRoot, "app", "page.tsx");
const webHomeRouteFile = path.join(webRoot, "app", "route.ts");
const webHomeLoaderFile = path.join(
  webRoot,
  "features",
  "home",
  "load-home-catalog.ts",
);
const webCatalogDetailApiRouteFile = path.join(
  webRoot,
  "app",
  "api",
  "catalog",
  "[catalogId]",
  "route.ts",
);
const webCatalogListApiRouteFile = path.join(
  webRoot,
  "app",
  "api",
  "catalog",
  "route.ts",
);
const webCatalogSearchApiRouteFile = path.join(
  webRoot,
  "app",
  "api",
  "catalog-search",
  "route.ts",
);
const webCatalogSearchClientFile = path.join(
  webRoot,
  "features",
  "search",
  "catalog-search.tsx",
);
const webT02StaticFilesFile = path.join(webRoot, "lib", "t02-static-files.ts");
// Community V1 (Mission 2A): each file may import exactly these names from the
// Web Public API server module; nothing else under app/ reaches it.
const webCommunityServerImports: ReadonlyMap<string, string> = new Map([
  [
    path.join(
      webRoot,
      "app",
      "api",
      "catalog",
      "[catalogId]",
      "media",
      "[mediaId]",
      "route.ts",
    ),
    "{relayServerLocalCatalogMedia}",
  ],
  // content-community-completion-v1: Development-only editorial images for a
  // phone on the LAN acceptance origin, looked up in the published item.
  [
    path.join(
      webRoot,
      "app",
      "api",
      "editorial-media",
      "[owner]",
      "[file]",
      "route.ts",
    ),
    "{relayServerLocalEditorialMedia}",
  ],
  [
    path.join(webRoot, "app", "api", "community", "[...path]", "route.ts"),
    "{relayServerAuthorCommunity}",
  ],
  [
    path.join(
      webRoot,
      "app",
      "api",
      "community",
      "auth",
      "[...path]",
      "route.ts",
    ),
    "{relayServerCommunityAuth}",
  ],
  [
    path.join(webRoot, "app", "api", "community", "me", "route.ts"),
    "{fetchServerCurrentUser}",
  ],
  [
    path.join(
      webRoot,
      "app",
      "api",
      "community",
      "development",
      "sign-in",
      "route.ts",
    ),
    "{signInServerDevelopmentAccount}",
  ],
  [
    path.join(
      webRoot,
      "app",
      "api",
      "community",
      "development",
      "sign-out",
      "route.ts",
    ),
    "{signOutServerDevelopmentSession}",
  ],
  [
    path.join(webRoot, "app", "dev", "community", "page.tsx"),
    "{fetchServerCurrentUser}",
  ],
  // Mission 2B: the same-origin comment bridges.
  [
    path.join(
      webRoot,
      "app",
      "api",
      "catalog",
      "[catalogId]",
      "comments",
      "route.ts",
    ),
    "{createServerCatalogComment,fetchServerCatalogCommentPage,}",
  ],
  [
    path.join(
      webRoot,
      "app",
      "api",
      "catalog",
      "[catalogId]",
      "comments",
      "[commentId]",
      "replies",
      "route.ts",
    ),
    "{createServerCatalogCommentReply,fetchServerCatalogCommentReplyPage,}",
  ],
  // work-publishing-v1: the Development streaming relays for component bytes
  // and private derivatives.
  [
    path.join(
      webRoot,
      "app",
      "api",
      "community",
      "publishing",
      "uploads",
      "[componentId]",
      "route.ts",
    ),
    "{relayServerPublishingUpload}",
  ],
  [
    path.join(
      webRoot,
      "app",
      "api",
      "community",
      "publishing",
      "media",
      "[itemId]",
      "[variant]",
      "[editKey]",
      "route.ts",
    ),
    "{relayServerPublishingMedia}",
  ],
]);

export const isAuthorizedWebPublicApiFile = (
  filePath: string,
  source: string,
): boolean =>
  isPathInside(webPublicApiRoot, filePath) && !hasUseClientDirective(source);

const isApprovedHomeConnectionReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  if (
    ![webHomePageFile, webHomeRouteFile].some(
      (candidate) => path.resolve(filePath) === candidate,
    ) ||
    hasUseClientDirective(source) ||
    reference.kind !== "static-import" ||
    reference.specifier !== "next/server"
  ) {
    return false;
  }

  const nextServerImports = [
    ...source.matchAll(
      /\bimport\s+([^;]+?)\s+from\s*(["'])next\/server\2\s*;/g,
    ),
  ];

  return (
    nextServerImports.length === 1 &&
    nextServerImports[0]?.[1]?.replaceAll(/\s/g, "") === "{connection}"
  );
};

const isApprovedT02StaticFilesReference = (
  filePath: string,
  reference: ModuleReference,
): boolean =>
  path.resolve(filePath) === webT02StaticFilesFile &&
  reference.kind === "static-import" &&
  (reference.specifier === "node:fs/promises" ||
    reference.specifier === "node:path");

const isApprovedHomeLoaderReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  if (
    path.resolve(filePath) !== webHomeLoaderFile ||
    hasUseClientDirective(source) ||
    reference.kind !== "static-import" ||
    reference.specifier !== "../../lib/public-api/server"
  ) {
    return false;
  }

  const serverAdapterImports = [
    ...source.matchAll(
      /\bimport\s+([^;]+?)\s+from\s*(["'])\.\.\/\.\.\/lib\/public-api\/server\2\s*;/g,
    ),
  ];

  return (
    serverAdapterImports.length === 1 &&
    serverAdapterImports[0]?.[1]?.replaceAll(/\s/g, "") ===
      "{fetchServerCatalogPage}"
  );
};

const isApprovedCatalogDetailApiReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  if (
    path.resolve(filePath) !== webCatalogDetailApiRouteFile ||
    hasUseClientDirective(source) ||
    reference.kind !== "static-import" ||
    reference.specifier !== "../../../../lib/public-api/server"
  ) {
    return false;
  }

  const serverAdapterImports = [
    ...source.matchAll(
      /\bimport\s+([^;]+?)\s+from\s*(["'])\.\.\/\.\.\/\.\.\/\.\.\/lib\/public-api\/server\2\s*;/g,
    ),
  ];

  return (
    serverAdapterImports.length === 1 &&
    serverAdapterImports[0]?.[1]?.replaceAll(/\s/g, "") ===
      "{fetchServerCatalogDetail}"
  );
};

const isApprovedCatalogListApiReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  if (
    path.resolve(filePath) !== webCatalogListApiRouteFile ||
    hasUseClientDirective(source) ||
    reference.kind !== "static-import" ||
    reference.specifier !== "../../../lib/public-api/server"
  ) {
    return false;
  }

  const serverAdapterImports = [
    ...source.matchAll(
      /\bimport\s+([^;]+?)\s+from\s*(["'])\.\.\/\.\.\/\.\.\/lib\/public-api\/server\2\s*;/g,
    ),
  ];

  return (
    serverAdapterImports.length === 1 &&
    serverAdapterImports[0]?.[1]?.replaceAll(/\s/g, "") ===
      "{fetchServerCatalogPage}"
  );
};

const isApprovedCatalogSearchApiReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  if (
    path.resolve(filePath) !== webCatalogSearchApiRouteFile ||
    hasUseClientDirective(source) ||
    reference.kind !== "static-import" ||
    reference.specifier !== "../../../lib/public-api/server"
  )
    return false;
  const imports = [
    ...source.matchAll(
      /\bimport\s+([^;]+?)\s+from\s*(["'])\.\.\/\.\.\/\.\.\/lib\/public-api\/server\2\s*;/g,
    ),
  ];
  return (
    imports.length === 1 &&
    imports[0]?.[1]?.replaceAll(/\s/g, "") === "{fetchServerCatalogSearchPage}"
  );
};

const isApprovedNotificationStreamReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean =>
  path.resolve(filePath) ===
    path.join(webRoot, "app/api/community/notifications/stream/route.ts") &&
  !hasUseClientDirective(source) &&
  reference.kind === "static-import" &&
  reference.specifier === "../../../../../lib/public-api/notification-stream" &&
  /import\s*\{\s*relayNotificationStream\s*\}\s*from/u.test(source);

const isApprovedCommunityServerReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  const expected = webCommunityServerImports.get(path.resolve(filePath));
  if (
    expected === undefined ||
    hasUseClientDirective(source) ||
    reference.kind !== "static-import" ||
    !reference.specifier.startsWith(".") ||
    path.resolve(path.dirname(filePath), reference.specifier) !==
      path.join(webPublicApiRoot, "server")
  )
    return false;
  const imports = [
    ...source.matchAll(
      /\bimport\s+([^;]+?)\s+from\s*(["'])(?:\.\.\/)+lib\/public-api\/server\2\s*;/g,
    ),
  ];
  return (
    imports.length === 1 && imports[0]?.[1]?.replaceAll(/\s/g, "") === expected
  );
};

const isApprovedCatalogSearchClientReference = (
  filePath: string,
  source: string,
  reference: ModuleReference,
): boolean => {
  if (
    path.resolve(filePath) !== webCatalogSearchClientFile ||
    reference.kind !== "static-import"
  )
    return false;
  if (
    reference.specifier === "../../lib/public-api/catalog-search" &&
    reference.typeOnly
  ) {
    const imports = [
      ...source.matchAll(
        /\bimport\s+type\s*{([^}]+)}\s*from\s*(["'])\.\.\/\.\.\/lib\/public-api\/catalog-search\2/g,
      ),
    ];
    return (
      imports.length === 1 &&
      imports[0]?.[1]?.trim() === "CatalogSearchTransportResult"
    );
  }
  if (
    reference.specifier !== "../../lib/public-api/catalog-search-client" ||
    reference.typeOnly
  )
    return false;
  const imports = [
    ...source.matchAll(
      /\bimport\s*{([^}]+)}\s*from\s*(["'])\.\.\/\.\.\/lib\/public-api\/catalog-search-client\2/g,
    ),
  ];
  const names = imports[0]?.[1]
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  return (
    imports.length === 1 &&
    names?.join(",") ===
      "fetchSameOriginCatalogSearchPage,parseCatalogSearchPage,parseCatalogSearchQuery"
  );
};

const referencesWebPublicApiBoundary = (
  filePath: string,
  specifier: string,
): boolean => {
  const normalized = specifier.replaceAll("\\", "/");
  if (
    normalized === "@/lib/public-api" ||
    normalized.startsWith("@/lib/public-api/")
  ) {
    return true;
  }
  if (!specifier.startsWith(".")) return false;

  return isPathInside(
    webPublicApiRoot,
    path.resolve(path.dirname(filePath), specifier),
  );
};

const stringLiterals = (source: string): string[] => [
  ...[...source.matchAll(/(["'])([^"'\n]+)\1/g)].map((match) => match[2] ?? ""),
  ...[...source.matchAll(/`([^`$\n]+)`/g)].map((match) => match[1] ?? ""),
];

const nonJsonDataExtension =
  /\.(?:csv|jsonl|ndjson|parquet|pdf|sql|tsv|xls|xlsx)$/i;
const jsonExtension = /\.json$/i;
const datasetPathSegment =
  /(?:^|\/)(?:catalog|data|dataset|datasets|fixture|fixtures)(?:\/|$)/i;
const datasetFileName =
  /(?:^|\/)(?:archive[-_]?items?|catalog|records?|dataset|dump|export|seed)(?:[-_.][^/]*)?\.(?:csv|json|jsonl|ndjson|parquet|pdf|sql|tsv|xls|xlsx)$/i;

const normalizedReference = (reference: string): string =>
  reference.replaceAll("\\", "/");

const isGeneralDataFileReference = (reference: string): boolean => {
  const normalized = normalizedReference(reference);
  return (
    nonJsonDataExtension.test(normalized) ||
    (jsonExtension.test(normalized) &&
      (datasetPathSegment.test(normalized) || datasetFileName.test(normalized)))
  );
};

const isRuntimeDatasetReference = (reference: string): boolean => {
  const normalized = normalizedReference(reference);
  const hasKnownDataExtension =
    nonJsonDataExtension.test(normalized) || jsonExtension.test(normalized);
  return (
    hasKnownDataExtension &&
    (datasetPathSegment.test(normalized) || datasetFileName.test(normalized))
  );
};

const catalogImportContractFileNames = new Set([
  "00_manifest.csv",
  "catalog.csv",
  "aliases.csv",
  "provenance.csv",
]);

const isCatalogImportContractMetadata = (
  filePath: string,
  reference: string,
): boolean =>
  normalizedReference(filePath).endsWith(
    "/packages/contracts/src/internal/catalog-import/specification.ts",
  ) && catalogImportContractFileNames.has(normalizedReference(reference));

export const dataFileReferences = (
  filePath: string,
  source: string,
): string[] => {
  const violations: string[] = [];

  for (const literal of stringLiterals(source)) {
    if (isGeneralDataFileReference(literal)) violations.push(literal);

    if (literal.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filePath), literal);
      if (isGeneralDataFileReference(resolved)) violations.push(literal);
    }
  }

  for (const call of source.matchAll(
    /\b(?:path\.)?(?:join|resolve)\s*\(([^)]*)\)/g,
  )) {
    const combined = stringLiterals(call[1] ?? "").join("/");
    if (isGeneralDataFileReference(combined)) violations.push(combined);
  }

  return [...new Set(violations)];
};

/**
 * Finds likely archive-dataset coupling in formal runtime source without
 * treating small configuration, localization or design-token JSON as a
 * database substitute.
 */
export const runtimeDatasetReferences = (
  filePath: string,
  source: string,
): string[] => {
  const violations: string[] = [];

  for (const literal of stringLiterals(source)) {
    if (isCatalogImportContractMetadata(filePath, literal)) continue;
    if (isRuntimeDatasetReference(literal)) violations.push(literal);

    if (literal.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filePath), literal);
      if (isRuntimeDatasetReference(resolved)) violations.push(literal);
    }
  }

  for (const call of source.matchAll(
    /\b(?:path\.)?(?:join|resolve)\s*\(([^)]*)\)/g,
  )) {
    const combined = stringLiterals(call[1] ?? "").join("/");
    if (isRuntimeDatasetReference(combined)) violations.push(combined);
  }

  return [...new Set(violations)];
};

const serverOnlyPackages = [
  "payload",
  "@payloadcms",
  "@moya/api",
  "@moya/backend-production",
  "@moya/backend-runtime",
  "@moya/catalog-postgres",
  "@moya/community-postgres",
  "@moya/contracts/json-schema",
  "@moya/contracts/internal",
  "@moya/contracts/schemas",
  "@moya/image",
  "@moya/public-api",
  "@moya/search",
  "opencc",
  "node-pg-migrate",
  "pg",
  "server-only",
];

const isForbiddenServerReference = (specifier: string): boolean => {
  const normalized = specifier.replaceAll("\\", "/");
  if (specifier === "@payloadcms/ui" || specifier.startsWith("@payloadcms/ui/"))
    return false;
  return (
    serverOnlyPackages.some(
      (entry) => specifier === entry || specifier.startsWith(`${entry}/`),
    ) ||
    specifier.startsWith("node:") ||
    /(?:^|\/)(?:database|infra|infrastructure|server|services)(?:\/|$)/.test(
      normalized,
    )
  );
};

const allowedClientContractTypes = new Set([
  "MentionReference",
  "NotificationPage",
  "NotificationItem",
  "NotificationUnread",
  "NotificationReason",
  "PublicUserProfile",
  "ContentIdentity",
  "ContentCard",
  "AuthorProfile",
  "AuthorMedia",
  "UserWork",
  "AuthorPrivacy",
  "AuthorListQuery",
  "DiscussionPage",
  "DiscussionComment",
  "DiscussionReply",
  "OwnComment",
  "DiscoveryPage",
  "DiscoveryQuery",
  "InscriptionFilters",
  "InscriptionFilterOptions",

  // content-community-completion-v1 editorial content read DTOs.
  "ArticleCitation",
  "ArticleCollectionDetail",
  "ArticleCollectionId",
  "ArticleCollectionMember",
  "ArticleCollectionPage",
  "ArticleCollectionSummary",
  "ArticleDetail",
  "ArticleId",
  "ArticleListQuery",
  "ArticlePage",
  "ArticlePresentation",
  "ArticleSection",
  "ArticleSummary",
  "DiscussionTarget",
  "ThreadId",
  "ThreadListQuery",
  "ThreadPage",
  "ThreadReadResult",
  "ThreadStatus",
  "ThreadSummary",
  "DirectConversation",
  "DirectConversationLookup",
  "DirectConversationPage",
  "DirectMessage",
  "DirectMessageFailureCode",
  "DirectMessagePage",
  "DirectMessageReadCommand",
  "DirectMessageUnread",
  "DmConversationId",
  "DmMessageId",
  "DmParticipant",
  "DmSendRefusal",
  "SendDirectMessageCommand",

  "CatalogDetail",
  "CatalogId",
  "CatalogKind",
  "CatalogListTransportQuery",
  "CatalogPage",
  "CatalogSummary",
  "CatalogSearchMatchKind",
  "CatalogSearchTransportQuery",
  "CatalogSearchItem",
  "CatalogSearchPage",
  "MediaId",
  "PublicMedia",
  "PublicSourceCitation",

  // work-publishing-v1 public publishing DTO, command and enum types.
  "CreatePublishingDraftCommand",
  "CreatePublishingSessionCommand",
  "EditableWork",
  "MediaClientPairing",
  "MediaComponentDeclaration",
  "StandardComponentOutcome",
  "MediaComponentRole",
  "MediaComponentState",
  "MediaContentType",
  "MediaCrop",
  "MediaEdit",
  "MediaFailureCode",
  "MediaItemKind",
  "MediaItemState",
  "MediaMetadata",
  "MediaPairingMethod",
  "MediaPresentation",
  "MediaProcessingProfile",
  "MediaQualityMode",
  "MediaRotation",
  "MediaUploadQualityMode",
  "MediaVariant",
  "OpenWorkEditDraftCommand",
  "PublishingDeviceClass",
  "PublishingDraft",
  "PublishingDraftConflict",
  "PublishingDraftDeletionResult",
  "PublishingDraftKind",
  "PublishingDraftPage",
  "PublishingDraftSaveResult",
  "PublishingDraftSummary",
  "PublishingHolder",
  "PublishingLimits",
  "PublishingMediaComponent",
  "PublishingMediaItem",
  "PublishingMediaSources",
  "PublishingOpenedEditDraft",
  "PublishingPageQuery",
  "PublishingReadiness",
  "PublishingReadinessCommand",
  "PublishingSession",
  "PublishingSessionState",
  "PublishingSnapshot",
  "PublishingSnapshotPage",
  "PublishingUploadResult",
  "RegisterMediaItemCommand",
  "ResolvePublishingConflictCommand",
  "RestorePublishingSnapshotCommand",
  "SavePublishingDraftCommand",
  "TrashRestoreResult",
  "TrashedWork",
  "TrashedWorkPage",
  "WorkAuthorship",
  "WorkAuthorshipKind",
  "WorkDraftContent",
  "WorkDraftItem",
  "WorkMedia",
  "WorkPublishingFailureCode",
  "WorkSnapshotKind",
  "WorkSubmissionCommand",
  "WorkSubmissionContent",
  "WorkSubmissionNotReady",
  "WorkSubmissionReceipt",
  "WorkSubmissionResult",
  "WorkVisibility",
  "WorkVisibilityCommand",
  "WorkVisibilityResult",
]);

const clientContractTypeViolations = (source: string): string[] => {
  const violations: string[] = [];
  const namedTypeImport =
    /\bimport\s+type\s*{([^}]+)}\s*from\s*(["'])@moya\/contracts(?:\/types)?\2/g;

  for (const match of source.matchAll(namedTypeImport)) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) =>
        entry
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim(),
      )
      .filter((entry): entry is string => entry !== undefined && entry !== "");
    for (const name of names) {
      if (!allowedClientContractTypes.has(name)) {
        violations.push(`${name} is not an approved public DTO type`);
      }
    }
  }

  if (
    /\bimport\s+type\s+\*\s+as\s+\w+\s+from\s*(["'])@moya\/contracts(?:\/types)?\1/.test(
      source,
    )
  ) {
    violations.push("contract namespace imports are not public-DTO-only");
  }

  return violations;
};

const cmsRoot = path.join(repositoryRoot, "apps", "admin");
export const isAuthorizedCmsServerFile = (
  filePath: string,
  source: string,
): boolean => {
  if (!isPathInside(cmsRoot, filePath) || hasUseClientDirective(source))
    return false;
  const relative = path.relative(cmsRoot, filePath).replaceAll("\\", "/");
  if (relative === "src/media/snapshot.ts") return false;
  return (
    relative === "payload.config.ts" ||
    relative === "next.config.ts" ||
    /^scripts\/(?:build\.mjs|bootstrap-synthetic\.ts|benchmark-synthetic\.ts|migrate-legacy\.ts|recovery-synthetic\.ts|seed-community-acceptance\.ts)$/.test(
      relative,
    ) ||
    /^src\/owner-workflow\/(?:View|NavLink)\.tsx$/.test(relative) ||
    // Community moderation: the server views, the workspace card and the
    // Backend operator client; the browser modules are listed with the
    // type-only exceptions below.
    /^src\/community\/(?:View|DashboardCard)\.tsx$/.test(relative) ||
    /^src\/community\/(?:backend|endpoints|agent-operations)\.ts$/.test(
      relative,
    ) ||
    // Agent Administration V1: the MCP tool adapter is a server module.
    relative === "src/agent-admin/mcp-tools.ts" ||
    // Agent Connections V1: the connection authentication boundary. These are
    // server modules by construction — they read request headers, resolve a
    // restricted principal and answer the Payload MCP plugin — and they are
    // named one by one rather than by directory, so a browser module added
    // under the same folder later does not inherit the allowance.
    /^src\/agent-connections\/(?:admission|authority|authorization|composition|consent|contracts|decide|discovery|endpoints|index|lifecycle|principal|resolve|resource|runtime)\.ts$/.test(
      relative,
    ) ||
    // The Owner-only consent and connection views. Server components: they
    // authenticate the Payload session, arm an interaction and render from
    // the row the provider wrote. The browser halves are separate files with
    // their own "use client" directive and no server import.
    relative === "src/agent-connections/View.tsx" ||
    // content-community-completion-v1: Articles/Collections editorial modules
    // are Payload server modules like `src/editorial`.
    /^src\/(?:editorial|editorial-content|media|fields|published|migration|migrations|preview)\/[^.].*\.tsx?$/.test(
      relative,
    ) ||
    /^src\/(?:users|runtime-settings|mcp|payload-types)\.ts$/.test(relative) ||
    /^app\/\(payload\)\/.*(?:page|layout|route|importMap)\.tsx?$/.test(relative)
  );
};

const isOwnerWorkflowTypes = (
  filePath: string,
  reference: ModuleReference,
): boolean => {
  const relative = path.relative(cmsRoot, filePath).replaceAll("\\", "/");
  return (
    reference.typeOnly &&
    (([
      "src/owner-workflow/client.tsx",
      "src/media/MediaSnapshotPicker.tsx",
      "src/media/snapshot.ts",
    ].includes(relative) &&
      reference.specifier === "@moya/contracts/internal/editorial") ||
      // Community moderation: the browser modules render operator shapes as
      // types only; every value crosses the same-origin Payload endpoints.
      ([
        "src/community/api.ts",
        "src/community/queue-client.tsx",
        "src/community/content-client.tsx",
        "src/community/users-client.tsx",
        "src/community/settings-client.tsx",
        "src/community/history-client.tsx",
        "src/community/agent-operations-client.tsx",
        // content-community-completion-v1: Threads and DM moderation views.
        "src/community/threads-client.tsx",
        "src/community/dm-moderation-client.tsx",
      ].includes(relative) &&
        reference.specifier ===
          "@moya/contracts/internal/community-operator") ||
      ([
        "src/media/MediaSnapshotPicker.tsx",
        "src/media/CatalogOwnershipField.tsx",
        "src/media/OriginalMediaMetadataField.tsx",
      ].includes(relative) &&
        reference.specifier === "payload") ||
      // The consent form renders what the server decided the human should
      // see, as a type only. Every value reaches it as props from the server
      // component, and its one write crosses the same-origin Payload
      // endpoint; it imports no consent RULE and can enforce none.
      (relative === "src/agent-connections/consent-client.tsx" &&
        reference.specifier === "./consent"))
  );
};

const referencesCmsServerModule = (
  filePath: string,
  specifier: string,
): boolean => {
  if (!specifier.startsWith(".")) return false;
  const base = path.resolve(path.dirname(filePath), specifier);
  const extension = path.extname(base);
  const candidates = sourceExtensions.has(extension)
    ? [
        ...(extension === ".js"
          ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"]
          : []),
        base,
      ]
    : [
        base + ".ts",
        base + ".tsx",
        base + ".js",
        base + ".jsx",
        path.join(base, "index.ts"),
        path.join(base, "index.tsx"),
        path.join(base, "index.js"),
        path.join(base, "index.jsx"),
      ];
  // Resolve actual files first: a permitted helper such as media/snapshot.ts
  // must not be misclassified as an imaginary snapshot/index.ts server module.
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) return false;
  return isAuthorizedCmsServerFile(resolved, readFileSync(resolved, "utf8"));
};

export const clientBoundaryViolations = (
  filePath: string,
  source: string,
): string[] => {
  if (!hasUseClientDirective(source)) return [];

  const violations: string[] = [];
  if (isPathInside(webPublicApiRoot, filePath)) {
    violations.push("Web Public API boundary cannot be a Client Component");
  }
  for (const reference of extractModuleReferences(source)) {
    if (
      referencesWebPublicApiBoundary(filePath, reference.specifier) &&
      !isApprovedCatalogSearchClientReference(filePath, source, reference)
    ) {
      violations.push(`${reference.specifier} is server/runtime-only`);
    }
    if (
      !isOwnerWorkflowTypes(filePath, reference) &&
      (isForbiddenServerReference(reference.specifier) ||
        reference.specifier === "@payload-config" ||
        referencesCmsServerModule(filePath, reference.specifier))
    ) {
      violations.push(`${reference.specifier} is server/runtime-only`);
    }
    if (
      (reference.specifier === "@moya/contracts" ||
        reference.specifier === "@moya/contracts/types") &&
      !reference.typeOnly
    ) {
      violations.push(`${reference.specifier} must use import type`);
    }
  }

  for (const reference of dataFileReferences(filePath, source)) {
    violations.push(`${reference} is a direct data-file reference`);
  }
  violations.push(...clientContractTypeViolations(source));

  if (
    /\bDATABASE_URL\b|\b(?:API_SECRET|PRIVATE_KEY|STORAGE_SECRET)\b|process\.env\.(?!NEXT_PUBLIC_)[A-Z0-9_]+/.test(
      source,
    )
  ) {
    violations.push("server-only configuration or secret access");
  }

  return violations;
};

export const frontendBoundaryViolations = (
  filePath: string,
  source: string,
): string[] => {
  const violations = clientBoundaryViolations(filePath, source);
  const isAuthorizedPublicApi = isAuthorizedWebPublicApiFile(filePath, source);
  const isCmsServer = isAuthorizedCmsServerFile(filePath, source);
  const isPreviewTransport =
    !hasUseClientDirective(source) &&
    path.resolve(filePath) ===
      path.join(webPublicApiRoot, "editorial-preview-server.ts");
  const isPreviewPage =
    !hasUseClientDirective(source) &&
    path.resolve(filePath) ===
      path.join(webRoot, "app/editorial-preview/[id]/page.tsx");
  const isWebTestFile =
    isPathInside(webRoot, filePath) && /\.test\.[cm]?[jt]sx?$/.test(filePath);
  const isDomainAgnosticUi = isPathInside(
    path.join(repositoryRoot, "packages", "ui"),
    filePath,
  );

  for (const reference of extractModuleReferences(source)) {
    const approvedPublicApiRuntimeImport =
      isAuthorizedPublicApi &&
      (reference.specifier === "@moya/contracts/schemas" ||
        reference.specifier === "server-only");
    const approvedHomeConnectionImport = isApprovedHomeConnectionReference(
      filePath,
      source,
      reference,
    );
    const approvedT02StaticFilesImport = isApprovedT02StaticFilesReference(
      filePath,
      reference,
    );
    const approvedWebTestRendererImport =
      isWebTestFile && reference.specifier === "react-dom/server";
    const approvedHomeLoaderImport = isApprovedHomeLoaderReference(
      filePath,
      source,
      reference,
    );
    const approvedCatalogDetailApiImport = isApprovedCatalogDetailApiReference(
      filePath,
      source,
      reference,
    );
    const approvedCatalogListApiImport = isApprovedCatalogListApiReference(
      filePath,
      source,
      reference,
    );
    const approvedCatalogSearchApiImport = isApprovedCatalogSearchApiReference(
      filePath,
      source,
      reference,
    );
    const approvedCommunityServerImport = isApprovedCommunityServerReference(
      filePath,
      source,
      reference,
    );
    if (
      isForbiddenServerReference(reference.specifier) &&
      !isCmsServer &&
      !isOwnerWorkflowTypes(filePath, reference) &&
      !approvedPublicApiRuntimeImport &&
      !(isPreviewTransport && reference.specifier === "next/headers") &&
      !(
        isPreviewPage &&
        reference.specifier ===
          "../../../lib/public-api/editorial-preview-server"
      ) &&
      !approvedHomeConnectionImport &&
      !approvedT02StaticFilesImport &&
      !approvedWebTestRendererImport &&
      !approvedHomeLoaderImport &&
      !approvedCatalogDetailApiImport &&
      !approvedCatalogListApiImport &&
      !approvedCatalogSearchApiImport &&
      !approvedCommunityServerImport &&
      !isApprovedNotificationStreamReference(filePath, source, reference) &&
      !(
        isAuthorizedPublicApi &&
        path.resolve(filePath) ===
          path.join(webPublicApiRoot, "notification-stream.ts") &&
        reference.kind === "static-import" &&
        reference.specifier === "./server" &&
        /import\s*\{\s*parsePublicApiBaseUrl\s*\}\s*from\s*["']\.\/server["']/u.test(
          source,
        )
      )
    ) {
      violations.push(`${reference.specifier} crosses the frontend boundary`);
    }
    if (
      isDomainAgnosticUi &&
      (reference.specifier === "@moya/contracts" ||
        reference.specifier.startsWith("@moya/contracts/"))
    ) {
      violations.push(`${reference.specifier} is domain-specific`);
    }
  }

  for (const reference of dataFileReferences(filePath, source)) {
    violations.push(`${reference} is a direct data-file reference`);
  }

  if (
    isPathInside(webRoot, filePath) &&
    /\b(?:globalThis\.)?fetch\s*\(/.test(source) &&
    !isAuthorizedPublicApi
  ) {
    violations.push(
      "Web business HTTP fetch must stay inside apps/web/lib/public-api",
    );
  }

  if (isAuthorizedPublicApi) {
    for (const match of source.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)) {
      if (
        match[1] !== "MOYA_PUBLIC_API_BASE_URL" &&
        !(isPreviewTransport && match[1] === "CMS_INTERNAL_URL")
      ) {
        violations.push(
          `${match[1] ?? "unknown environment variable"} is not authorized for the Web Public API boundary`,
        );
      }
    }
  }

  if (/\bPUBLIC_CDN_BASE_URL\b/.test(source)) {
    violations.push(
      "PUBLIC_CDN_BASE_URL is a deprecated frontend URL-composition convention",
    );
  }
  if (
    /(?:\b(?:objectKey|object_key)\s*\+|\+\s*(?:objectKey|object_key)\b|\$\{[^}]*\b(?:objectKey|object_key)\b[^}]*\})/.test(
      source,
    )
  ) {
    violations.push("Frontend code cannot compose a URL from objectKey");
  }
  if (
    /\b(?:STORAGE_PROVIDER|STORAGE_BUCKET|ASSET_CDN_BASE_URL|PRIVATE_CDN_BASE_URL)\b/.test(
      source,
    )
  ) {
    violations.push(
      "Frontend code cannot use private storage-provider or CDN configuration",
    );
  }

  return [...new Set(violations)];
};
