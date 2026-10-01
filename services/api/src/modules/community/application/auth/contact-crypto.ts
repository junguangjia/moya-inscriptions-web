/**
 * Three separate keys: lookup HMAC, contact encryption, and OTP verification.
 * Lookup digests do not include a second uniqueness island per key version.
 *
 * Email policy: trim; one @; domain converted to ASCII and lowercased; the
 * local-part is lowercased for lookup and preserved, including dots and plus
 * suffixes, for delivery. No provider alias merging.
 * Phone policy: E.164, +86 only, mainland mobile numbers.
 */

export interface AuthKeys {
  readonly version: number;
  readonly lookupKey: Uint8Array;
  readonly encryptionKey: Uint8Array;
  readonly otpKey: Uint8Array;
}

const text = new TextEncoder();

export const assertAuthKeys = (keys: AuthKeys): void => {
  if (!Number.isInteger(keys.version) || keys.version < 1)
    throw new Error("Authentication key version must be a positive integer");
  for (const key of [keys.lookupKey, keys.encryptionKey, keys.otpKey]) {
    if (key.byteLength !== 32)
      throw new Error("Authentication keys must be 32 bytes");
  }
};

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const unhex = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const bytesToBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const copyBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const hmac = async (key: Uint8Array, value: string): Promise<string> => {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    copyBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    text.encode(value),
  );
  return hex(new Uint8Array(signature));
};

export const normalizeEmail = (
  input: string,
): { readonly lookup: string; readonly delivery: string } | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 254 || /\s/u.test(trimmed))
    return null;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (
    local.length === 0 ||
    local.length > 64 ||
    domain.length === 0 ||
    domain.length > 253 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)
  )
    return null;
  let asciiDomain: string;
  try {
    asciiDomain = new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
  if (
    asciiDomain.length === 0 ||
    asciiDomain.includes("..") ||
    (!asciiDomain.includes(".") && asciiDomain !== "localhost")
  )
    return null;
  return {
    lookup: `${local.toLowerCase()}@${asciiDomain}`,
    delivery: `${local}@${asciiDomain}`,
  };
};

/** +86 mainland mobiles. Other country codes are rejected. */
export const normalizePhone = (input: string): string | null => {
  const compact = input.trim().replace(/[\s()-]/gu, "");
  if (compact.length === 0) return null;
  let national = compact;
  if (national.startsWith("+")) national = national.slice(1);
  if (national.startsWith("00")) national = national.slice(2);
  if (national.startsWith("86") && national.length === 13)
    national = national.slice(2);
  if (!/^1[3-9]\d{9}$/u.test(national)) return null;
  return `+86${national}`;
};

export const maskEmail = (delivery: string): string => {
  const at = delivery.indexOf("@");
  const local = at > 0 ? delivery.slice(0, at) : delivery;
  const domain = at > 0 ? delivery.slice(at + 1) : "";
  return `${local.slice(0, 1)}***@${domain}`;
};

export const maskPhone = (e164: string): string => {
  const national = e164.startsWith("+86") ? e164.slice(3) : e164;
  return `+86 ${national.slice(0, 3)}****${national.slice(-4)}`;
};

export const lookupDigest = (
  kind: string,
  normalized: string,
  keys: AuthKeys,
): Promise<string> =>
  hmac(keys.lookupKey, `${keys.version}\0${kind}\0${normalized}`);

export const keyedHash = (key: Uint8Array, value: string): Promise<string> =>
  hmac(key, value);

export const encryptContact = async (
  keys: AuthKeys,
  kind: string,
  plaintext: string,
): Promise<string> => {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    copyBuffer(keys.encryptionKey),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const encrypted = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: text.encode(`${kind}|${keys.version}`),
      },
      cryptoKey,
      text.encode(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.byteLength + encrypted.byteLength);
  packed.set(iv, 0);
  packed.set(encrypted, iv.byteLength);
  return bytesToBase64Url(packed);
};

export const decryptContact = async (
  keys: AuthKeys,
  kind: string,
  encoded: string,
): Promise<string | null> => {
  try {
    const packed = base64UrlToBytes(encoded);
    if (packed.byteLength < 13 + 16) return null;
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      copyBuffer(keys.encryptionKey),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plain = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: text.encode(`${kind}|${keys.version}`),
      },
      cryptoKey,
      ciphertext,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
};

/** Six cryptographically generated digits, without modulo bias. */
export const generateEmailOtp = (): string => {
  let code = "";
  while (code.length < 6) {
    const byte = globalThis.crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
    if (byte < 250) code += String(byte % 10);
  }
  return code;
};

export const otpVerifier = (
  keys: AuthKeys,
  challengeId: string,
  purpose: string,
  targetDigest: string,
  code: string,
): Promise<string> =>
  hmac(keys.otpKey, `${challengeId}\0${purpose}\0${targetDigest}\0${code}`);

export const verifierMatches = (
  expectedHex: string,
  actualHex: string,
): boolean => {
  const expected = unhex(expectedHex);
  const actual = unhex(actualHex);
  if (expected.length === 0 || expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1)
    difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
  return difference === 0;
};
