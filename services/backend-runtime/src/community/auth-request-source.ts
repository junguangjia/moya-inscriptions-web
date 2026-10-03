import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

/** Dedicated Web-to-Backend forwarding authority; it grants no user or Owner role. */
export type AuthRequestSource = (request: IncomingMessage) => string | null;

const singleHeader = (
  request: IncomingMessage,
  name: string,
): string | null => {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  const value = request.headers[name];
  return count === 1 && typeof value === "string" ? value : null;
};

const canonicalIp = (value: string | null): string | null => {
  if (value === null || value.length > 45 || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // IPv4 and IPv4-mapped IPv6 represent the same source budget.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16),
      low = Number.parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return address;
};

/** Validate once before Production pools open. Never read generic forwarding headers. */
export const createTrustedAuthRequestSource = (
  credential: string | undefined,
): AuthRequestSource => {
  if (credential === undefined || !/^[A-Za-z0-9_-]{43,128}$/u.test(credential))
    throw new Error("AUTH_SOURCE_RELAY_TOKEN: invalid protected configuration");
  const expected = Buffer.from(credential);
  return (request) => {
    const token = singleHeader(request, "x-moya-auth-relay");
    if (token === null || !/^[A-Za-z0-9_-]{43,128}$/u.test(token)) return null;
    const supplied = Buffer.from(token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return null;
    return canonicalIp(singleHeader(request, "x-moya-auth-source"));
  };
};
