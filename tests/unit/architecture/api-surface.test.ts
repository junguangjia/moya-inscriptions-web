import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractModuleReferences,
  repositoryRoot,
} from "./workspace-scanner.js";

import type {
  PublishingDraftDeletion,
  PublishingProcessingInput,
  PublishingProcessingSource,
} from "@moya/api";

const apiRoot = path.join(repositoryRoot, "services", "api");

const collectFiles = async (
  directory: string,
  accepted: (fileName: string) => boolean,
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, accepted)));
    } else if (accepted(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort();
};

describe("@moya/api server-only surface", () => {
  it("depends only on Public Contracts and exposes the approved server boundary", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(apiRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      sideEffects?: boolean;
    };

    expect(manifest.dependencies).toEqual({
      "@moya/contracts": "workspace:*",
    });
    expect(manifest.sideEffects).toBe(false);
    expect(Object.keys(await import("@moya/api")).sort()).toEqual([
      "AgentAdministrationService",
      "AgentForbiddenError",
      "AgentManifestError",
      "AuthorCommunityService",
      "COMMENT_EMBEDDED_REPLY_LIMIT",
      "COMMENT_HOT_LIMIT",
      "COMMENT_PAGE_SIZE_DEFAULT",
      "COMMENT_REPLY_PAGE_SIZE_DEFAULT",
      "CatalogCommentService",
      "CatalogMediaResolutionError",
      "CatalogQueryUnavailableError",
      "CatalogReadService",
      "CommunityAuthService",
      "CommunityConflictError",
      "CommunityContentOperatorService",
      "CommunityInputError",
      "CommunityModerationService",
      "CommunityNotFoundError",
      "CommunitySessionService",
      "CommunityStoreUnavailableError",
      "DirectMessageService",
      "DisabledCommentAnalysisPort",
      "EditorialContentReadService",
      "ExecutionFenceLostError",
      "NotificationService",
      "PasswordHashBusyError",
      "PublishingOperatorService",
      "PublishingTransferRegistry",
      "ThreadService",
      "WorkPublishingService",
      "assertLoopbackCaptureUrl",
      "assertProductionAuthConfiguration",
      "createDevelopmentAuthService",
      "createMemoryCommunityAuthPort",
      "deriveCatalogPeriodLabel",
      "hashPassword",
      "interpretAliyunCheck",
      "interpretAliyunSend",
      "interpretTencentSendEmail",
      "isAgentForbiddenError",
      "isAgentManifestError",
      "isCatalogMediaResolutionError",
      "isCatalogQueryUnavailableError",
      "isCommunityConflictError",
      "isCommunityInputError",
      "isCommunityNotFoundError",
      "isCommunityStoreUnavailableError",
      "isExecutionFenceLostError",
      "isValidAuthPassword",
      "mapAliyunCheckSmsVerifyCode",
      "mapAliyunSendSmsVerifyCode",
      "mapCatalogDetail",
      "mapCatalogPage",
      "mapCatalogSummary",
      "mapPublicUserProfile",
      "mapTencentSendEmail",
      "normalizeStudioName",
      "parseCatalogListQuery",
      "parseCatalogSearchQuery",
      "parseCommentListingQuery",
      "parseCommentPageQuery",
      "parseCreateCommentRequest",
      "parseCreateReplyRequest",
      "parseWorkPublishingCommand",
      "parseWorkPublishingSegment",
      "splitParagraphs",
      "targetRequestId",
      "validPassword",
      "verifyPassword",
    ]);
  });

  it("exports the work publishing processing source with the port types that name it", async () => {
    const declaration = await readFile(
      path.join(apiRoot, "dist", "index.d.ts"),
      "utf8",
    );
    for (const name of [
      "PublishingProcessingSource",
      "PublishingProcessingInput",
      "PublishingDraftDeletion",
    ])
      expect(declaration).toMatch(new RegExp(`\\b${name}\\b`, "u"));
    // Compile-time: both sources are nameable where the worker composes them.
    const sources: readonly PublishingProcessingSource[] = [
      { kind: "upload" },
      {
        kind: "legacy_user_media",
        legacyMediaId: `user-media-${"a".repeat(32)}`,
        byteSize: 1024,
        contentType: "image/png",
      },
    ];
    const source: PublishingProcessingInput["source"] = sources[1]!;
    const deletion: PublishingDraftDeletion = {
      result: { deleted: true, snapshots: 0, conflictCopies: 0, mediaItems: 0 },
      cancelledComponentIds: [],
    };
    expect([source.kind, deletion.result.deleted]).toEqual([
      "legacy_user_media",
      true,
    ]);
  });

  it("keeps source and build output free of infrastructure and HTTP runtime", async () => {
    const files = [
      ...(await collectFiles(path.join(apiRoot, "src"), (name) =>
        name.endsWith(".ts"),
      )),
      ...(await collectFiles(
        path.join(apiRoot, "dist"),
        (name) => name.endsWith(".js") || name.endsWith(".d.ts"),
      )),
    ];
    const forbidden = [
      /["'](?:pg|node-postgres|node-pg-migrate|hono)["']/,
      /\b(?:Request|Response|DATABASE_URL|Pool|PoolClient)\b/,
      /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET)\b/i,
      /["']node:fs(?:\/promises)?["']/,
      /["'][^"']*(?:\/|\\)(?:data|dataset|datasets)(?:\/|\\)[^"']*["']/i,
    ];
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(path.relative(repositoryRoot, file));
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps application dependencies pointed away from transport", async () => {
    const applicationRoot = path.join(
      apiRoot,
      "src",
      "modules",
      "catalog",
      "application",
    );
    const files = await collectFiles(applicationRoot, (name) =>
      name.endsWith(".ts"),
    );
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const reference of extractModuleReferences(source)) {
        if (reference.specifier.includes("/transport/")) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports transport`,
          );
        }
        if (
          !file.includes(`${path.sep}mappers${path.sep}`) &&
          (reference.specifier === "@moya/contracts/schemas" ||
            reference.specifier === "@moya/contracts/json-schema")
        ) {
          violations.push(
            `${path.relative(repositoryRoot, file)} imports runtime contracts`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("locates transport parsing outside the application layer", async () => {
    const parserPath = path.join(
      apiRoot,
      "src",
      "modules",
      "catalog",
      "transport",
      "catalog-list-query-parser.ts",
    );
    const parser = await readFile(parserPath, "utf8");

    expect(parser).toContain("catalogListTransportQuerySchema.parse(input)");
    expect(parser).toContain("CatalogListQuery");
    expect(parserPath).not.toContain(`${path.sep}application${path.sep}`);
  });
});
