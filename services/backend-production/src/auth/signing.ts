import { createHash, createHmac } from "node:crypto";
import type {
  TencentSesConfiguration,
  AliyunDypnsConfiguration,
} from "./config.js";
import type { ProviderRequest } from "./transport.js";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const mac = (key: string | Uint8Array, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

/** TC3: https://cloud.tencent.com/document/product/213/30654 */
export const signTencentSes = (
  config: TencentSesConfiguration,
  body: string,
  now: Date,
): ProviderRequest => {
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const date = now.toISOString().slice(0, 10);
  const host = new URL(config.endpoint).host;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:sendemail\n`;
  const canonical = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    digest(body),
  ].join("\n");
  const scope = `${date}/ses/tc3_request`;
  const signingKey = mac(
    mac(mac(`TC3${config.secretKey}`, date), "ses"),
    "tc3_request",
  );
  const signature = mac(
    signingKey,
    `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${digest(canonical)}`,
  ).toString("hex");
  return {
    url: config.endpoint,
    method: "POST",
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      host,
      "x-tc-action": "SendEmail",
      "x-tc-version": "2020-10-02",
      "x-tc-timestamp": timestamp,
      "x-tc-region": config.region,
      authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

/** ACS3 uses case-preserved trimmed values and lowercase sorted header names. */
export const signAliyunDypns = (
  config: AliyunDypnsConfiguration,
  action: "SendSmsVerifyCode" | "CheckSmsVerifyCode",
  body: string,
  now: Date,
  nonce: string,
): ProviderRequest => {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: "dypnsapi.aliyuncs.com",
    "x-acs-action": action,
    "x-acs-content-sha256": digest(body),
    "x-acs-date": now.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    "x-acs-signature-nonce": nonce,
    "x-acs-version": "2017-05-25",
  };
  const names = Object.keys(headers)
    .filter(
      (name) =>
        name === "content-type" || name === "host" || name.startsWith("x-acs-"),
    )
    .sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const canonical = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    digest(body),
  ].join("\n");
  const signature = mac(
    config.accessKeySecret,
    `ACS3-HMAC-SHA256\n${digest(canonical)}`,
  ).toString("hex");
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${config.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return {
    url: "https://dypnsapi.aliyuncs.com/",
    method: "POST",
    headers,
    body,
  };
};
