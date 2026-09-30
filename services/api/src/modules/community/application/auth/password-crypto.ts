/// <reference types="node" />
import { isValidAuthPassword } from "../../domain/auth-profile-policy.js";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768,
  R = 8,
  P = 3,
  KEY_BYTES = 32,
  SALT_BYTES = 16;
const MAX_ACTIVE = 2,
  MAX_QUEUED = 8;
let active = 0;
const waiters: Array<() => void> = [];
export class PasswordHashBusyError extends Error {}

/** Domain policy; password bytes are never trimmed or normalized. */
export const validPassword = (value: string): boolean =>
  isValidAuthPassword(value);

const derive = async (password: string, salt: Buffer): Promise<Buffer> => {
  if (active >= MAX_ACTIVE) {
    if (waiters.length >= MAX_QUEUED)
      throw new PasswordHashBusyError("Password hash queue is full");
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        KEY_BYTES,
        { N, r: R, p: P, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
};
const encode = (salt: Buffer, key: Buffer) =>
  `scrypt-v1$32768$8$3$${salt.toString("base64url")}$${key.toString("base64url")}`;
const decode = (verifier: string): { salt: Buffer; key: Buffer } | null => {
  const match =
    /^scrypt-v1\$32768\$8\$3\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/u.exec(
      verifier,
    );
  if (!match?.[1] || !match[2]) return null;
  const salt = Buffer.from(match[1], "base64url"),
    key = Buffer.from(match[2], "base64url");
  return salt.length === SALT_BYTES &&
    key.length === KEY_BYTES &&
    encode(salt, key) === verifier
    ? { salt, key }
    : null;
};
export const hashPassword = async (password: string): Promise<string> => {
  if (!validPassword(password)) throw new Error("Invalid password policy");
  const salt = randomBytes(SALT_BYTES);
  return encode(salt, await derive(password, salt));
};
/** Missing/unsupported credentials still perform the same bounded slow work. */
export const verifyPassword = async (
  password: string,
  verifier: string | null,
): Promise<boolean> => {
  const parsed = verifier === null ? null : decode(verifier);
  const key = await derive(
    password,
    parsed?.salt ?? Buffer.alloc(SALT_BYTES, 173),
  );
  const matched = timingSafeEqual(key, parsed?.key ?? Buffer.alloc(KEY_BYTES));
  return parsed !== null && matched;
};
