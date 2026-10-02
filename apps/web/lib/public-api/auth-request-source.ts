import "server-only";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const protectedToken = (value: string | undefined): string | null =>
  value !== undefined && /^[A-Za-z0-9_-]{43,128}$/u.test(value) ? value : null;

const canonicalIp = (value: string | null): string | null => {
  if (value === null || value.length > 45 || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16),
      low = Number.parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return address;
};

/** Next's Request has no transport peer. Only the authenticated ingress may
 * assert a source; direct callers and browser-provided XFF never choose it. */
export const trustedAuthSourceHeaders = (
  request: Request,
): Record<string, string> | null => {
  const ingress = protectedToken(process.env.AUTH_INGRESS_TOKEN);
  const relay = protectedToken(process.env.AUTH_SOURCE_RELAY_TOKEN);
  if (ingress === null || relay === null || ingress === relay) return null;
  const token = request.headers.get("x-moya-auth-ingress");
  if (token === null || !/^[A-Za-z0-9_-]{43,128}$/u.test(token)) return null;
  const expected = Buffer.from(ingress),
    supplied = Buffer.from(token);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    return null;
  // Fetch Headers joins repeated values with commas; a comma or folded value
  // fails the strict IP/token grammar instead of choosing one claimed identity.
  const source = canonicalIp(request.headers.get("x-moya-client-ip"));
  if (source === null) return null;
  return { "x-moya-auth-relay": relay, "x-moya-auth-source": source };
};
