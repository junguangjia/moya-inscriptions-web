import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { productionAuthConfigurationFrom } from "@moya/backend-runtime";
import type { ProductionAuthConfiguration } from "@moya/backend-runtime";
import type { AuthRegistrationAgreement } from "@moya/backend-runtime";
import { authRegistrationAgreementSchema } from "@moya/backend-runtime";

type Environment = Readonly<Record<string, string | undefined>>;
export interface TencentSesConfiguration {
  readonly endpoint:
    | "https://ses.tencentcloudapi.com/"
    | "https://ses.intl.tencentcloudapi.com/";
  readonly region: string;
  readonly secretId: string;
  readonly secretKey: string;
  readonly from: string;
  readonly templateId: number;
}
export interface AliyunDypnsConfiguration {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly signName: string;
  readonly templateCode: string;
  readonly schemeName: string;
}
export interface ConfiguredProductionAuth {
  readonly service: ProductionAuthConfiguration;
  readonly email: TencentSesConfiguration;
  readonly phone: AliyunDypnsConfiguration | null;
  readonly agreement: AuthRegistrationAgreement | null;
}

const required = (env: Environment, name: string, maximum = 1024): string => {
  const value = env[name];
  if (
    !value ||
    value.trim() !== value ||
    value.length > maximum ||
    /[\r\n]/u.test(value) ||
    value.includes("\0")
  )
    throw new Error(`${name}: missing or invalid protected configuration`);
  return value;
};

/** Open the file once, without following a symlink or trusting a prior stat. */
const readAgreement = async (
  path: string | undefined,
): Promise<AuthRegistrationAgreement | null> => {
  if (path === undefined || path === "") return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > 262144
    )
      throw new Error();
    // Bound bytes even if the file grows after stat; JSON escapes can exceed text size.
    const bytes = Buffer.alloc(262145);
    let used = 0;
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, null);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used > 262144) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, used),
    );
    return Object.freeze(
      authRegistrationAgreementSchema.parse(JSON.parse(text)),
    );
  } catch {
    throw new Error(
      "AUTH_REGISTRATION_AGREEMENT_FILE: invalid protected agreement",
    );
  } finally {
    await file?.close();
  }
};

/** Validation only. No provider request, pool, credential generation or fallback. */
export const loadProductionAuthConfiguration = async (
  env: Environment,
): Promise<ConfiguredProductionAuth | null> => {
  const service = productionAuthConfigurationFrom(env);
  if (service === null) return null;
  const selected = required(env, "TENCENT_SES_ENDPOINT");
  if (
    selected !== "https://ses.tencentcloudapi.com" &&
    selected !== "https://ses.tencentcloudapi.com/" &&
    selected !== "https://ses.intl.tencentcloudapi.com" &&
    selected !== "https://ses.intl.tencentcloudapi.com/"
  )
    throw new Error("TENCENT_SES_ENDPOINT: unsupported provider endpoint");
  const endpoint =
    `${selected.replace(/\/$/u, "")}/` as TencentSesConfiguration["endpoint"];
  const region = required(env, "TENCENT_SES_REGION", 64);
  const regions =
    endpoint === "https://ses.tencentcloudapi.com/"
      ? ["ap-guangzhou", "ap-hongkong"]
      : ["ap-singapore"];
  if (!regions.includes(region))
    throw new Error("TENCENT_SES_REGION: unsupported endpoint region");
  const template = required(env, "TENCENT_SES_TEMPLATE_ID", 16);
  if (
    !/^[1-9][0-9]*$/u.test(template) ||
    !Number.isSafeInteger(Number(template))
  )
    throw new Error("TENCENT_SES_TEMPLATE_ID: positive safe integer required");
  const from = required(env, "TENCENT_SES_FROM", 320);
  // Existing mapped request accepts either a bare address or SES display-name form.
  if (
    !/^[^\s@<>]+@[^\s@<>]+$/u.test(from) &&
    !/^[^\r\n<>]+<[^\s@<>]+@[^\s@<>]+>$/u.test(from)
  )
    throw new Error("TENCENT_SES_FROM: invalid sender");
  const email: TencentSesConfiguration = {
    endpoint,
    region,
    from,
    templateId: Number(template),
    secretId: required(env, "TENCENT_SES_SECRET_ID", 256),
    secretKey: required(env, "TENCENT_SES_SECRET_KEY", 256),
  };
  const phone: AliyunDypnsConfiguration | null = service.phoneEnabled
    ? {
        accessKeyId: required(env, "ALIYUN_ACCESS_KEY_ID", 256),
        accessKeySecret: required(env, "ALIYUN_ACCESS_KEY_SECRET", 256),
        signName: required(env, "ALIYUN_SMS_SIGN_NAME", 128),
        templateCode: required(env, "ALIYUN_SMS_TEMPLATE_CODE", 128),
        schemeName: required(env, "ALIYUN_SMS_SCHEME_NAME", 20),
      }
    : null;
  return {
    service,
    email,
    phone,
    agreement: await readAgreement(env.AUTH_REGISTRATION_AGREEMENT_FILE),
  };
};
