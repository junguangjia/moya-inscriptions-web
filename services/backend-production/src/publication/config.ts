import { isAbsolute } from "node:path";
import { validatePublishedOrigin } from "./keys.js";

type Environment = Readonly<Record<string, string | undefined>>;
export interface PublicationConfig {
  readonly nodeEnv: "development" | "production";
  readonly productMode: "public" | "closed-beta";
  readonly publication: "off" | "on";
  readonly delivery: "relay" | "edge";
  readonly origin?: string;
  readonly bucket?: string;
  readonly region?: string;
  readonly roleArn?: string;
  readonly zoneId?: string;
  readonly verifyConnectHost?: string;
  readonly localRoot?: string;
}

function failure(name: string): never {
  throw new Error(`${name}: invalid media publication configuration`);
}
const set = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

/** No credentials or network I/O. A worker without a product mode cannot publish. */
export function parsePublicationConfig(
  environment: Environment,
  nodeEnv: PublicationConfig["nodeEnv"],
  productMode?: PublicationConfig["productMode"],
): PublicationConfig {
  const configuredMode = environment.PRODUCT_ACCESS_MODE;
  if (
    configuredMode &&
    configuredMode !== "public" &&
    configuredMode !== "closed-beta"
  )
    failure("PRODUCT_ACCESS_MODE");
  const mode =
    productMode ??
    configuredMode ??
    (nodeEnv === "development" ? "public" : "closed-beta");
  if (mode !== "public" && mode !== "closed-beta")
    failure("PRODUCT_ACCESS_MODE");
  const publication = environment.MEDIA_PUBLICATION || "off";
  const delivery = environment.MEDIA_PUBLIC_DELIVERY || "relay";
  if (publication !== "off" && publication !== "on")
    failure("MEDIA_PUBLICATION");
  if (delivery !== "relay" && delivery !== "edge")
    failure("MEDIA_PUBLIC_DELIVERY");
  let origin: string | undefined;
  if (set(environment.MEDIA_PUBLISHED_ORIGIN)) {
    try {
      origin = validatePublishedOrigin(
        environment.MEDIA_PUBLISHED_ORIGIN,
        nodeEnv === "development",
      );
    } catch {
      failure("MEDIA_PUBLISHED_ORIGIN");
    }
  }
  const bucket = environment.MEDIA_PUBLISHED_COS_BUCKET || undefined;
  const region = environment.MEDIA_PUBLISHED_COS_REGION || undefined;
  const roleArn = environment.MEDIA_PUBLISHER_ROLE_ARN || undefined;
  const zoneId = environment.MEDIA_EDGE_ZONE_ID || undefined;
  const verifyConnectHost =
    environment.MEDIA_EDGE_VERIFY_CONNECT_HOST || undefined;
  const localRoot = environment.MEDIA_PUBLISHED_LOCAL_ROOT || undefined;
  if (bucket && !/^[a-z0-9][a-z0-9-]{1,49}-[0-9]{5,20}$/u.test(bucket))
    failure("MEDIA_PUBLISHED_COS_BUCKET");
  if (region && !/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/u.test(region))
    failure("MEDIA_PUBLISHED_COS_REGION");
  if (
    roleArn &&
    !/^qcs::cam::uin\/[0-9]{5,20}:role(?:Name)?\/[A-Za-z0-9_-]{1,128}$/u.test(
      roleArn,
    )
  )
    failure("MEDIA_PUBLISHER_ROLE_ARN");
  if (zoneId && !/^zone-[a-z0-9]{3,64}$/u.test(zoneId))
    failure("MEDIA_EDGE_ZONE_ID");
  if (
    verifyConnectHost &&
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu.test(
      verifyConnectHost,
    )
  )
    failure("MEDIA_EDGE_VERIFY_CONNECT_HOST");
  if (
    localRoot &&
    (nodeEnv !== "development" ||
      !isAbsolute(localRoot) ||
      localRoot.includes("\0"))
  )
    failure("MEDIA_PUBLISHED_LOCAL_ROOT");
  const config: PublicationConfig = {
    nodeEnv,
    productMode: mode,
    publication,
    delivery,
    ...(origin ? { origin } : {}),
    ...(bucket ? { bucket } : {}),
    ...(region ? { region } : {}),
    ...(roleArn ? { roleArn } : {}),
    ...(zoneId ? { zoneId } : {}),
    ...(verifyConnectHost ? { verifyConnectHost } : {}),
    ...(localRoot ? { localRoot } : {}),
  };
  // A forbids publication in Beta, even when an operator sets the two switches.
  // Disabled preparation may omit the future provider's access configuration.
  if (
    (publication === "on" || delivery === "edge") &&
    mode === "public" &&
    !hasPublicationProviderConfig(config)
  )
    failure("MEDIA_PUBLISHED_ORIGIN");
  return Object.freeze(config);
}

export function hasPublicationProviderConfig(
  config: PublicationConfig,
): boolean {
  return Boolean(
    config.origin &&
    (config.nodeEnv === "development"
      ? config.localRoot
      : config.bucket && config.region && config.roleArn && config.zoneId),
  );
}
export const allowsPublication = (config: PublicationConfig): boolean =>
  config.productMode === "public" &&
  config.publication === "on" &&
  hasPublicationProviderConfig(config);
export const allowsEdgeDelivery = (config: PublicationConfig): boolean =>
  config.productMode === "public" &&
  config.delivery === "edge" &&
  hasPublicationProviderConfig(config);
