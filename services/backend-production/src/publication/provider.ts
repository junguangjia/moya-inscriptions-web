export type PublishedContentType = "image/webp" | "image/jpeg" | "video/mp4";

export interface PublishedUnit {
  readonly objectKey: string;
  readonly contentType: PublishedContentType;
  readonly byteSize: number;
}

export interface PublishedObjectEvidence {
  readonly byteSize: number;
  readonly etag?: string;
  readonly crc64?: string;
}

export interface MonthlyPublicationUsage {
  readonly start: Date;
  readonly end: Date;
  readonly requests: number;
  readonly warning: boolean;
}

/**
 * The image host's day-to-date usage (catalog-deep-zoom-v1): requests and
 * the traffic the cap counts, from the start of the cap's day.
 */
export interface DailyPublicationUsage {
  readonly dayStart: Date;
  readonly requests: number;
  readonly bytes: number;
}

/** Server-only port. A caller registers immutable keys before any object I/O. */
export interface PublicationProvider {
  write(
    unit: PublishedUnit,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<PublishedObjectEvidence>;
  head(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<PublishedObjectEvidence | undefined>;
  remove(objectKey: string, signal?: AbortSignal): Promise<void>;
  purge(
    targets: readonly string[],
    type: "file" | "prefix",
    signal?: AbortSignal,
  ): Promise<string>;
  purgeStatus(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<"pending" | "succeeded" | "failed">;
  verifyGone(target: string, signal?: AbortSignal): Promise<boolean>;
  monthlyRequests(
    now: Date,
    signal?: AbortSignal,
  ): Promise<MonthlyPublicationUsage>;
  /** catalog-deep-zoom-v1: today's requests and traffic since `dayStart`. */
  dayUsage(
    dayStart: Date,
    now: Date,
    signal?: AbortSignal,
  ): Promise<DailyPublicationUsage>;
}

export class PublicationProviderError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "invalid"
      | "unavailable"
      | "integrity"
      | "quota"
      | "aborted",
  ) {
    super(`Media publication failure: ${code}`);
    this.name = "PublicationProviderError";
  }
}

export const PUBLICATION_CACHE_CONTROL = "public, max-age=300, must-revalidate";
export const MONTHLY_REQUEST_WARNING = 2_000_000;
/**
 * The traffic metric the image host's daily cap counts (catalog-deep-zoom-v1
 * breaker): EdgeOne's L7 response traffic, in bytes. Planned; P0 item 7
 * settles it.
 */
export const CATALOG_ZOOM_TRAFFIC_METRIC = "l7Flow_outFlux";

/** The billing month starts at 00:00 on the fourth in Asia/Shanghai (UTC+8). */
export function publicationPlanMonth(now: Date): Date {
  if (!Number.isFinite(now.getTime()))
    throw new PublicationProviderError("invalid");
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const month = beijing.getUTCMonth() - (beijing.getUTCDate() < 4 ? 1 : 0);
  return new Date(
    Date.UTC(beijing.getUTCFullYear(), month, 4) - 8 * 60 * 60 * 1_000,
  );
}

export function assertPublicationSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PublicationProviderError("aborted");
}
