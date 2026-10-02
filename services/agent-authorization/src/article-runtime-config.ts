import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { parsePostgresConfig } from "@moya/catalog-postgres";
import {
  providerAdapterKeysFrom,
  wrapperKeysFrom,
} from "@moya/community-postgres";
import type { JsonWebKey } from "node:crypto";
import type { ArticleAuthorizationConfig } from "./article-provider.js";

const refused = (category: string): never => {
  throw new Error(category);
};
const loopback = (host: string): boolean =>
  ["127.0.0.1", "localhost", "[::1]"].includes(host);

/** Role metadata deliberately cannot carry another process's password. */
export const articleDatabaseRoleTarget = (
  raw: string | undefined,
  options: { readonly production: boolean; readonly metadata?: boolean },
): { readonly target: string; readonly role: string } => {
  try {
    if (!raw || raw.trim() !== raw || /\s/u.test(raw)) throw new Error();
    const url = new URL(raw);
    const modes = url.searchParams.getAll("sslmode");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      url.pathname.length <= 1 ||
      url.hash ||
      (options.metadata && url.password !== "") ||
      modes.length > 1 ||
      [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
      (modes[0] !== undefined &&
        !["disable", "verify-full"].includes(modes[0])) ||
      (!loopback(url.hostname) &&
        (!options.production || modes[0] !== "verify-full"))
    )
      throw new Error();
    return {
      target: `${url.hostname}:${url.port || "5432"}${decodeURIComponent(url.pathname)}`,
      role: decodeURIComponent(url.username),
    };
  } catch {
    return refused("ARTICLE_DATABASE_ROLE_REFUSED");
  }
};

/** Use the existing verified TLS parser after rejecting URL parameter overrides. */
export const articleAuthorizationPostgresFrom = (
  config: ArticleAuthorizationConfig,
  environment: NodeJS.ProcessEnv,
) => {
  const production = config.environment === "production";
  const issuer = articleDatabaseRoleTarget(config.databaseUrl, { production });
  if (production) {
    const control = articleDatabaseRoleTarget(
      environment.ARTICLE_AUTHORING_CONTROL_DATABASE_TARGET,
      { production, metadata: true },
    );
    const resource = articleDatabaseRoleTarget(
      environment.ARTICLE_AUTHORING_RESOURCE_DATABASE_TARGET,
      { production, metadata: true },
    );
    const catalog = articleDatabaseRoleTarget(environment.DATABASE_TARGET, {
      production,
      metadata: true,
    });
    const cms = articleDatabaseRoleTarget(environment.CMS_DATABASE_TARGET, {
      production,
      metadata: true,
    });
    const roles = [issuer, control, resource, catalog, cms];
    if (
      new Set(roles.map((value) => value.target)).size !== 1 ||
      new Set(roles.map((value) => value.role)).size !== roles.length
    )
      refused("ARTICLE_DATABASE_ROLE_SEPARATION");
  }
  try {
    return parsePostgresConfig({
      DATABASE_URL: config.databaseUrl,
      DATABASE_SSL_CA_FILE:
        environment.ARTICLE_AUTHORIZATION_DATABASE_SSL_CA_FILE,
      DATABASE_POOL_MAX: environment.DATABASE_POOL_MAX,
      DATABASE_IDLE_TIMEOUT_MS: environment.DATABASE_IDLE_TIMEOUT_MS,
    });
  } catch {
    return refused("ARTICLE_DATABASE_TLS_REFUSED");
  }
};

const MAX_SIGNING_FILE_BYTES = 65_536;
/** Bounded descriptor read with no symlink/FIFO following and owner-only access. */
export const readArticleSigningJwks = (
  file: string | undefined,
): { keys: JsonWebKey[] } => {
  let descriptor: number | undefined;
  try {
    if (!file || !isAbsolute(file)) throw new Error();
    descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      (typeof process.getuid === "function" &&
        before.uid !== process.getuid()) ||
      before.size < 1 ||
      before.size > MAX_SIGNING_FILE_BYTES
    )
      throw new Error();
    const bytes = Buffer.alloc(MAX_SIGNING_FILE_BYTES + 1);
    let count = 0;
    while (count <= MAX_SIGNING_FILE_BYTES) {
      const read = readSync(
        descriptor,
        bytes,
        count,
        bytes.length - count,
        null,
      );
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(descriptor);
    if (
      count > MAX_SIGNING_FILE_BYTES ||
      count !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.mode !== before.mode
    )
      throw new Error();
    const parsed: unknown = JSON.parse(
      bytes.subarray(0, count).toString("utf8"),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("keys" in parsed) ||
      !Array.isArray(parsed.keys) ||
      parsed.keys.length < 1 ||
      parsed.keys.length > 4
    )
      throw new Error();
    const kids = new Set<string>();
    const material = new Set<string>();
    const keys: JsonWebKey[] = [];
    for (const input of parsed.keys as unknown[]) {
      if (!input || typeof input !== "object") throw new Error();
      const key = input as JsonWebKey;
      if (
        key.kty !== "RSA" ||
        key.alg !== "RS256" ||
        key.use !== "sig" ||
        typeof key.kid !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(key.kid) ||
        kids.has(key.kid) ||
        ["n", "e", "d", "p", "q", "dp", "dq", "qi"].some(
          (name) =>
            typeof key[name] !== "string" ||
            !/^[A-Za-z0-9_-]+$/u.test(key[name] as string),
        ) ||
        (key.key_ops !== undefined &&
          (!Array.isArray(key.key_ops) ||
            key.key_ops.length !== 1 ||
            key.key_ops[0] !== "sign"))
      )
        throw new Error();
      const privateKey = createPrivateKey({ key, format: "jwk" });
      if (
        privateKey.asymmetricKeyType !== "rsa" ||
        (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
      const publicKey = createPublicKey({
        key: { kty: "RSA", n: key.n!, e: key.e! },
        format: "jwk",
      });
      const probe = Buffer.from("article-signing-key-validation-v1");
      if (
        !verify(
          "RSA-SHA256",
          probe,
          publicKey,
          sign("RSA-SHA256", probe, privateKey),
        )
      )
        throw new Error();
      const publicMaterial = publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64");
      if (material.has(publicMaterial)) throw new Error();
      kids.add(key.kid);
      material.add(publicMaterial);
      // Canonical export excludes remote key URLs, certificates and unused metadata.
      keys.push({
        ...privateKey.export({ format: "jwk" }),
        kid: key.kid,
        alg: "RS256",
        use: "sig",
      });
    }
    return { keys };
  } catch {
    return refused("ARTICLE_SIGNING_JWKS_REFUSED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

/** Validate all issuer private material before constructing a pool or provider. */
export const prepareArticleAuthorizationKeys = (
  config: ArticleAuthorizationConfig,
  environment: NodeJS.ProcessEnv,
) => {
  try {
    const providerKeys = providerAdapterKeysFrom({
      NODE_ENV: environment.NODE_ENV,
      AGENT_CONNECTION_PROVIDER_INDEX_KEY:
        environment.ARTICLE_AUTHORING_PROVIDER_INDEX_KEY,
      AGENT_CONNECTION_PROVIDER_SEAL_KEY:
        environment.ARTICLE_AUTHORING_PROVIDER_SEAL_KEY,
    });
    const wrapperKeys = wrapperKeysFrom({
      NODE_ENV: environment.NODE_ENV,
      AGENT_CONNECTION_WRAPPER_INDEX_KEY:
        environment.ARTICLE_AUTHORING_WRAPPER_INDEX_KEY,
      AGENT_CONNECTION_WRAPPER_SEAL_KEY:
        environment.ARTICLE_AUTHORING_WRAPPER_SEAL_KEY,
    });
    const cookieKey = environment.ARTICLE_AUTHORING_COOKIE_KEY;
    if (
      !cookieKey ||
      Buffer.byteLength(cookieKey) < 32 ||
      Buffer.byteLength(cookieKey) > 1024
    )
      throw new Error();
    if (config.environment === "production") {
      for (const name of [
        "ARTICLE_AUTHORING_PROVIDER_INDEX_KEY",
        "ARTICLE_AUTHORING_PROVIDER_SEAL_KEY",
        "ARTICLE_AUTHORING_WRAPPER_INDEX_KEY",
        "ARTICLE_AUTHORING_WRAPPER_SEAL_KEY",
      ]) {
        const value = environment[name];
        if (!value || Buffer.from(value, "base64").toString("base64") !== value)
          throw new Error();
      }
      const secrets = [
        providerKeys.indexKey,
        providerKeys.sealKey,
        wrapperKeys.indexKey,
        wrapperKeys.sealKey,
      ];
      if (
        new Set(secrets.map((key) => key.toString("hex"))).size !==
        secrets.length
      )
        throw new Error();
      const cookieBytes = Buffer.from(cookieKey, "base64url");
      if (
        cookieBytes.length < 32 ||
        secrets.some((key) => key.equals(cookieBytes))
      )
        throw new Error();
      for (const name of [
        "AGENT_CONNECTION_PROVIDER_INDEX_KEY",
        "AGENT_CONNECTION_PROVIDER_SEAL_KEY",
        "AGENT_CONNECTION_WRAPPER_INDEX_KEY",
        "AGENT_CONNECTION_WRAPPER_SEAL_KEY",
      ]) {
        const raw = environment[name];
        if (
          raw &&
          [...secrets, cookieBytes].some((key) =>
            key.equals(Buffer.from(raw, "base64")),
          )
        )
          throw new Error();
      }
      if (environment.AGENT_AUTHORIZATION_COOKIE_KEY === cookieKey)
        throw new Error();
    }
    const signingFile = environment.ARTICLE_AUTHORIZATION_SIGNING_JWKS_FILE;
    const jwks =
      config.environment === "production" || signingFile !== undefined
        ? readArticleSigningJwks(signingFile)
        : undefined;
    return { providerKeys, wrapperKeys, cookieKey, jwks };
  } catch {
    return refused("ARTICLE_AUTHORIZATION_KEYS_REFUSED");
  }
};
