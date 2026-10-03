import {
  moderateWorkSubmissionCommandSchema,
  operatorLabelSchema,
  operatorPublishingJobQuerySchema,
  operatorWorkSubmissionQuerySchema,
  publishingJobCommandSchema,
  publishingJobIdSchema,
  setAccountCapacityClassCommandSchema,
  setWorkPublishingSettingsCommandSchema,
} from "@moya/contracts/internal/community-operator";

import { CommunityInputError } from "../errors/community-request-errors.js";
import { CommunityNotFoundError } from "../errors/community-request-errors.js";
import { openPublishingMemoryMedia } from "./publishing-memory-media.js";
import { openPublishingMedia } from "./work-publishing-service.js";

import type {
  OperatorAccountCapacity,
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  OperatorWorkSubmission,
  OperatorWorkSubmissionPage,
  WorkPublishingSettings,
  WorkSubmissionModerationResult,
} from "@moya/contracts/internal/community-operator";
import type { PublishingOperatorPort } from "../ports/publishing-operator-port.js";
import type {
  PublishingMediaByteRange,
  PublishingMediaStorePort,
} from "../ports/publishing-media-store-port.js";
import type { MediaVariant } from "@moya/contracts";
import type { PublishingMediaDelivery } from "./work-publishing-service.js";

interface SafeParser<T> {
  safeParse(
    input: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/** The operator boundary answers a bare invalid command, never field detail. */
const parseCommand = <T>(schema: SafeParser<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new CommunityInputError("Invalid operator command");
  return result.data;
};

/** A malformed route id names nothing: it is unavailable, never a hint. */
const routeId = <T>(schema: SafeParser<T>, value: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new CommunityNotFoundError();
  return result.data;
};

const accountIdSchema: SafeParser<string> = {
  safeParse: (input) =>
    typeof input === "string" && /^user-[0-9a-f]{32}$/u.test(input)
      ? { success: true, data: input }
      : { success: false },
};

export interface PublishingOperatorServiceOptions {
  /** Private media bytes for the submission media proxy. */
  readonly store?: PublishingMediaStorePort | undefined;
  readonly clock?: (() => Date) | undefined;
  /** Server configuration recorded on every command; never request input. */
  readonly operatorLabel?: string | undefined;
}

/**
 * The Owner's work publishing operations behind the operator credential: the
 * independent work publication policy and limits, the explicit submission
 * queue, account capacity designation and content-free job outcomes. The
 * internal command contracts are enforced here, outside the Public API.
 */
export class PublishingOperatorService {
  private readonly store: PublishingMediaStorePort | undefined;
  private readonly clock: () => Date;
  private readonly operator: string;

  constructor(
    private readonly port: PublishingOperatorPort,
    options: PublishingOperatorServiceOptions = {},
  ) {
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
    this.operator = operatorLabelSchema.parse(options.operatorLabel ?? "owner");
  }

  readSettings(): Promise<WorkPublishingSettings> {
    return this.port.readSettings();
  }

  setSettings(body: unknown): Promise<WorkPublishingSettings> {
    return this.port.setSettings(
      this.operator,
      parseCommand(setWorkPublishingSettingsCommandSchema, body),
      this.clock(),
    );
  }

  listSubmissions(query: unknown): Promise<OperatorWorkSubmissionPage> {
    return this.port.listSubmissions(
      parseCommand(operatorWorkSubmissionQuerySchema, query),
    );
  }

  /** `revisionId` is a well-formed route id (transport parsed). */
  readSubmission(revisionId: string): Promise<OperatorWorkSubmission> {
    return this.port.readSubmission(revisionId);
  }

  moderateSubmission(
    revisionId: string,
    body: unknown,
  ): Promise<WorkSubmissionModerationResult> {
    return this.port.moderateSubmission(
      revisionId,
      this.operator,
      parseCommand(moderateWorkSubmissionCommandSchema, body),
      this.clock(),
    );
  }

  /** Submitted derivatives or the unedited legacy PNG, for the private Admin proxy. */
  async openMedia(
    revisionId: string,
    itemId: string,
    variant: MediaVariant,
    editKey: string,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaDelivery> {
    const target = await this.port.resolveMediaRead(
      revisionId,
      itemId,
      variant,
      editKey,
    );
    if (target !== null && "legacyPng" in target) {
      return openPublishingMemoryMedia(target.legacyPng, target.sha256, range);
    }
    return openPublishingMedia(this.store, async () => target, range);
  }

  readCapacity(accountId: string): Promise<OperatorAccountCapacity> {
    return this.port.readCapacity(routeId(accountIdSchema, accountId));
  }

  setCapacity(
    accountId: string,
    body: unknown,
  ): Promise<OperatorAccountCapacity> {
    const id = routeId(accountIdSchema, accountId);
    return this.port.setCapacity(
      id,
      this.operator,
      parseCommand(setAccountCapacityClassCommandSchema, body),
      this.clock(),
    );
  }

  listJobs(query: unknown): Promise<OperatorPublishingJobPage> {
    return this.port.listJobs(
      parseCommand(operatorPublishingJobQuerySchema, query),
    );
  }

  retryJob(jobId: string, body: unknown): Promise<OperatorPublishingJob> {
    const id = routeId(publishingJobIdSchema, jobId);
    return this.port.retryJob(
      id,
      this.operator,
      parseCommand(publishingJobCommandSchema, body),
      this.clock(),
    );
  }

  abandonJob(jobId: string, body: unknown): Promise<OperatorPublishingJob> {
    const id = routeId(publishingJobIdSchema, jobId);
    return this.port.abandonJob(
      id,
      this.operator,
      parseCommand(publishingJobCommandSchema, body),
      this.clock(),
    );
  }
}
