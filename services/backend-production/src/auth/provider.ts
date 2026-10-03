import { randomUUID } from "node:crypto";
import {
  interpretAliyunCheck,
  interpretAliyunSend,
  interpretTencentSendEmail,
  mapAliyunCheckSmsVerifyCode,
  mapAliyunSendSmsVerifyCode,
  mapTencentSendEmail,
} from "@moya/backend-runtime";
import type { AuthDeliveryPorts } from "@moya/backend-runtime";
import type { ConfiguredProductionAuth } from "./config.js";
import { signAliyunDypns, signTencentSes } from "./signing.js";
import {
  sendProviderRequest,
  ProviderTransportError,
  PROVIDER_RESPONSE_MAX_BYTES,
} from "./transport.js";
import type { ProviderTransport, ProviderRequest } from "./transport.js";

export interface AuthProviderDependencies {
  readonly transport?: ProviderTransport;
  readonly now?: () => Date;
  readonly nonce?: () => string;
}
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const returnedOtp = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return true;
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      key.toLowerCase() === "verifycode" || returnedOtp(entry, depth + 1),
  );
};
const form = (value: object): string =>
  new URLSearchParams(
    Object.entries(value).map(([name, entry]) => [name, String(entry)]),
  ).toString();

/** The only production delivery adapter; protocol mappings remain in the API. */
export const createProductionAuthDelivery = (
  config: ConfiguredProductionAuth,
  dependencies: AuthProviderDependencies = {},
): AuthDeliveryPorts => {
  const transport = dependencies.transport ?? sendProviderRequest;
  const now = dependencies.now ?? (() => new Date());
  const nonce = dependencies.nonce ?? randomUUID;
  const call = async (
    request: ProviderRequest,
  ): Promise<Record<string, unknown>> => {
    const response = await transport(request);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      Buffer.byteLength(response.body) > PROVIDER_RESPONSE_MAX_BYTES
    )
      throw new ProviderTransportError("failed");
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new ProviderTransportError("failed");
    }
    const parsed = record(body);
    if (parsed === null || returnedOtp(parsed))
      throw new ProviderTransportError("failed");
    return parsed;
  };
  const failed = (error: unknown): "failed" | "unknown" =>
    error instanceof ProviderTransportError ? error.outcome : "unknown";
  const aliyun = async (
    action: "SendSmsVerifyCode" | "CheckSmsVerifyCode",
    body: object,
  ) => {
    if (config.phone === null) throw new ProviderTransportError("failed");
    const result = await call(
      signAliyunDypns(config.phone, action, form(body), now(), nonce()),
    );
    if (
      result.Code !== "OK" ||
      result.Success !== true ||
      result.Error !== undefined ||
      result.error !== undefined
    )
      throw new ProviderTransportError("failed");
    return result;
  };
  return {
    async sendEmail(input) {
      if (config.email === null) return { state: "failed" };
      try {
        const mapped = mapTencentSendEmail({
          ...input,
          from: config.email.from,
          templateId: config.email.templateId,
        });
        const body = await call(
          signTencentSes(config.email, JSON.stringify(mapped), now()),
        );
        const result = record(body.Response);
        if (
          result === null ||
          result.Error !== undefined ||
          body.Error !== undefined
        )
          return { state: "failed" };
        return interpretTencentSendEmail(result);
      } catch (error) {
        return { state: failed(error) };
      }
    },
    async sendPhone(input) {
      if (
        config.phone === null ||
        input.code !== null ||
        !/^\+861[3-9][0-9]{9}$/u.test(input.e164)
      )
        return { state: "failed" };
      try {
        const mapped = mapAliyunSendSmsVerifyCode({
          ...input,
          ...config.phone,
        });
        // Disable the provider's automatic signature/template replacement retry.
        return interpretAliyunSend(
          await aliyun("SendSmsVerifyCode", { ...mapped, AutoRetry: 0 }),
        );
      } catch (error) {
        return { state: failed(error) };
      }
    },
    async checkPhone(input) {
      if (
        config.phone === null ||
        !/^\+861[3-9][0-9]{9}$/u.test(input.e164) ||
        !/^[0-9]{6}$/u.test(input.code)
      )
        return "fail";
      try {
        const mapped = mapAliyunCheckSmsVerifyCode({
          ...input,
          schemeName: config.phone.schemeName,
        });
        return interpretAliyunCheck(await aliyun("CheckSmsVerifyCode", mapped));
      } catch (error) {
        return failed(error) === "unknown" ? "unknown" : "malformed";
      }
    },
  };
};
