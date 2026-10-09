import { PublicationProviderError } from "./provider.js";
import type { PublishedUnit } from "./provider.js";

const hex32 = "[0-9a-f]{32}";
const editKey = `(?:base|${hex32})`;
const roles = "(?:thumb|cover|display|viewer|full|motion)";
const fileKey = new RegExp(
  `^v1/${hex32}/${hex32}/${editKey}/${roles}\\.r([1-9][0-9]{0,9})\\.(?:webp|jpg|mp4)$`,
  "u",
);
const prefixKey = new RegExp(
  `^v1/${hex32}/(?:${hex32}/(?:${editKey}/)?)?$`,
  "u",
);

export function validatePublishedKey(key: string): string {
  const match = fileKey.exec(key);
  if (!match || Number(match[1]) > 2_147_483_647)
    throw new PublicationProviderError("invalid");
  return key;
}

export function validatePublishedUnit(unit: PublishedUnit): void {
  validatePublishedKey(unit.objectKey);
  const extension = {
    "image/webp": ".webp",
    "image/jpeg": ".jpg",
    "video/mp4": ".mp4",
  }[unit.contentType];
  if (
    !extension ||
    !unit.objectKey.endsWith(extension) ||
    !Number.isSafeInteger(unit.byteSize) ||
    unit.byteSize < 1 ||
    unit.byteSize > 5 * 1024 ** 3
  )
    throw new PublicationProviderError("invalid");
}

/** Origins are configuration, never a request-provided purge authority. */
export function validatePublishedOrigin(
  value: string,
  development = false,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicationProviderError("invalid");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  const dns = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu.test(
    url.hostname,
  );
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (development && loopback
      ? !["http:", "https:"].includes(url.protocol)
      : url.protocol !== "https:" || Boolean(url.port) || !dns)
  )
    throw new PublicationProviderError("invalid");
  return url.origin;
}

export function publishedObjectUrl(origin: string, key: string): string {
  validatePublishedKey(key);
  return `${validatePublishedOrigin(origin, true)}/${key}`;
}

export function validatePurgeTarget(
  origin: string,
  target: string,
  type: "file" | "prefix",
): string {
  const expected = validatePublishedOrigin(origin, true);
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new PublicationProviderError("invalid");
  }
  if (
    url.origin !== expected ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    target !== `${expected}${url.pathname}`
  )
    throw new PublicationProviderError("invalid");
  const key = url.pathname.slice(1);
  if (type === "file") validatePublishedKey(key);
  else if (!prefixKey.test(key)) throw new PublicationProviderError("invalid");
  return target;
}
