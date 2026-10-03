import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProductionAuthConfiguration,
  createProductionAuthDelivery,
} from "@moya/backend-production/internal/auth";
import type {
  ConfiguredProductionAuth,
  ProviderRequest,
  ProviderTransport,
} from "@moya/backend-production/internal/auth";
import {
  signTencentSes,
  signAliyunDypns,
} from "@moya/backend-production/internal/auth-signing";
import { ProviderTransportError } from "@moya/backend-production/internal/auth-transport";

const protectedValue = () => randomBytes(32).toString("base64");
const environment = () => ({
  NODE_ENV: "production",
  AUTH_PUBLIC_ENABLED: "true",
  AUTH_EMAIL_PROVIDER: "tencent-ses",
  AUTH_KEY_VERSION: "1",
  AUTH_LOOKUP_KEY: protectedValue(),
  AUTH_ENCRYPTION_KEY: protectedValue(),
  AUTH_OTP_KEY: protectedValue(),
  TENCENT_SES_ENDPOINT: "https://ses.tencentcloudapi.com",
  TENCENT_SES_REGION: "ap-guangzhou",
  TENCENT_SES_SECRET_ID: randomBytes(16).toString("hex"),
  TENCENT_SES_SECRET_KEY: protectedValue(),
  TENCENT_SES_FROM: "synthetic@example.invalid",
  TENCENT_SES_TEMPLATE_ID: "42",
  AUTH_PHONE_PROVIDER: "aliyun-dypns",
  ALIYUN_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
  ALIYUN_ACCESS_KEY_SECRET: protectedValue(),
  ALIYUN_SMS_SIGN_NAME: "Synthetic",
  ALIYUN_SMS_TEMPLATE_CODE: "SYNTHETIC_ONLY",
  ALIYUN_SMS_SCHEME_NAME: "synthetic",
});
const configuration = async (): Promise<ConfiguredProductionAuth> => {
  const config = await loadProductionAuthConfiguration(environment());
  if (config === null) throw new Error("Missing synthetic config");
  return config;
};
const refusesConfig = async (pending: Promise<unknown>): Promise<void> => {
  try {
    await pending;
  } catch {
    throw new Error("Configuration refused");
  }
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Production auth protected configuration", () => {
  it("stays off without explicit enablement but refuses local selectors even while off", async () => {
    expect(
      await loadProductionAuthConfiguration({ NODE_ENV: "production" }),
    ).toBeNull();
    expect(
      await loadProductionAuthConfiguration({
        ...environment(),
        AUTH_PUBLIC_ENABLED: "false",
      }),
    ).toBeNull();
    for (const invalid of [
      { AUTH_EMAIL_PROVIDER: "local_capture" },
      { AUTH_PHONE_PROVIDER: "simulated" },
      { AUTH_PROFILE: "full-local" },
      { AUTH_EMAIL_CAPTURE_URL: "http://127.0.0.1:3463" },
    ]) {
      await expect(
        refusesConfig(
          loadProductionAuthConfiguration({
            NODE_ENV: "production",
            ...invalid,
          }),
        ),
      ).rejects.toThrow(/Configuration refused/u);
    }
    await expect(
      refusesConfig(
        loadProductionAuthConfiguration({
          NODE_ENV: "production",
          AUTH_PUBLIC_ENABLED: "true",
        }),
      ),
    ).rejects.toThrow(/Configuration refused/u);
  });
  it("validates key versions, providers and exact endpoint/region pairs", async () => {
    for (const invalid of [
      { AUTH_KEY_VERSION: "0" },
      { AUTH_KEY_VERSION: "1.5" },
      { AUTH_KEY_VERSION: "" },
      { AUTH_LOOKUP_KEY: "synthetic-invalid" },
      { TENCENT_SES_ENDPOINT: "https://redirect.example.invalid/" },
      { TENCENT_SES_ENDPOINT: "https://ses.tencentcloudapi.com/?next=x" },
      { TENCENT_SES_REGION: "ap-singapore" },
      { TENCENT_SES_TEMPLATE_ID: "0" },
      { TENCENT_SES_FROM: "bad\nheader" },
      { ALIYUN_SMS_SCHEME_NAME: "" },
      { AUTH_PUBLIC_ENABLED: "yes" },
    ])
      await expect(
        refusesConfig(
          loadProductionAuthConfiguration({ ...environment(), ...invalid }),
        ),
      ).rejects.toThrow();
    const international = await loadProductionAuthConfiguration({
      ...environment(),
      TENCENT_SES_ENDPOINT: "https://ses.intl.tencentcloudapi.com",
      TENCENT_SES_REGION: "ap-singapore",
    });
    expect(international?.email.region).toBe("ap-singapore");
  });
  it("allows no approved agreement, but refuses an unsafe or malformed supplied file", async () => {
    expect((await configuration()).agreement).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), "synthetic-auth-config-"));
    directories.push(dir);
    const file = join(dir, "agreement.json");
    const agreement = {
      version: "synthetic-v1",
      title: "Synthetic agreement",
      body: "Synthetic acceptance material only.",
    };
    await writeFile(file, JSON.stringify(agreement), { mode: 0o600 });
    expect(
      (
        await loadProductionAuthConfiguration({
          ...environment(),
          AUTH_REGISTRATION_AGREEMENT_FILE: file,
        })
      )?.agreement?.version,
    ).toBe("synthetic-v1");
    await chmod(file, 0o644);
    await expect(
      refusesConfig(
        loadProductionAuthConfiguration({
          ...environment(),
          AUTH_REGISTRATION_AGREEMENT_FILE: file,
        }),
      ),
    ).rejects.toThrow(/Configuration refused/u);
    await chmod(file, 0o600);
    const link = join(dir, "link.json");
    await symlink(file, link);
    await expect(
      refusesConfig(
        loadProductionAuthConfiguration({
          ...environment(),
          AUTH_REGISTRATION_AGREEMENT_FILE: link,
        }),
      ),
    ).rejects.toThrow(/Configuration refused/u);
    await writeFile(file, "{}");
    await expect(
      refusesConfig(
        loadProductionAuthConfiguration({
          ...environment(),
          AUTH_REGISTRATION_AGREEMENT_FILE: file,
        }),
      ),
    ).rejects.toThrow(/Configuration refused/u);
    await writeFile(file, "x".repeat(262145));
    await expect(
      refusesConfig(
        loadProductionAuthConfiguration({
          ...environment(),
          AUTH_REGISTRATION_AGREEMENT_FILE: file,
        }),
      ),
    ).rejects.toThrow(/Configuration refused/u);
  });
});

describe("signed provider request contract", () => {
  it("signs exact Tencent body/header bytes with a UTC credential date", async () => {
    const config = await configuration(),
      body = JSON.stringify({ synthetic: "中文" });
    const now = new Date("2026-10-02T01:02:03Z");
    const request = signTencentSes(config.email, body, now);
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const hmac = (key: string | Buffer, value: string) =>
      createHmac("sha256", key).update(value).digest();
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:ses.tencentcloudapi.com\nx-tc-action:sendemail\n\ncontent-type;host;x-tc-action\n${hash(body)}`;
    const signing = hmac(
      hmac(hmac(`TC3${config.email.secretKey}`, "2026-10-02"), "ses"),
      "tc3_request",
    );
    const expected = hmac(
      signing,
      `TC3-HMAC-SHA256\n${Math.floor(now.getTime() / 1000)}\n2026-10-02/ses/tc3_request\n${hash(canonical)}`,
    ).toString("hex");
    // Boolean comparisons keep generated authorization material out of failure output.
    expect(
      request.headers.authorization?.endsWith(`Signature=${expected}`),
    ).toBe(true);
    expect(request.body === body).toBe(true);
    expect(request.headers["x-tc-version"]).toBe("2020-10-02");
  });
  it("signs ACS3 form data without putting contacts/codes in the URL", async () => {
    const config = await configuration();
    if (config.phone === null) throw Error("Missing synthetic phone");
    const body = new URLSearchParams({
      SignName: "合成",
      TemplateParam: '{"code":"##code##","min":"5"}',
    }).toString();
    const now = new Date("2026-10-02T01:02:03.123Z"),
      nonce = randomUUID();
    const request = signAliyunDypns(
      config.phone,
      "SendSmsVerifyCode",
      body,
      now,
      nonce,
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const names =
      "content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version";
    const canonical = `POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:dypnsapi.aliyuncs.com\nx-acs-action:SendSmsVerifyCode\nx-acs-content-sha256:${hash(body)}\nx-acs-date:2026-10-02T01:02:03Z\nx-acs-signature-nonce:${nonce}\nx-acs-version:2017-05-25\n\n${names}\n${hash(body)}`;
    const expected = createHmac("sha256", config.phone.accessKeySecret)
      .update(`ACS3-HMAC-SHA256\n${hash(canonical)}`)
      .digest("hex");
    expect(
      request.headers.authorization?.endsWith(`Signature=${expected}`),
    ).toBe(true);
    expect(request.url).toBe("https://dypnsapi.aliyuncs.com/");
    expect(request.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });
  it("uses the existing mappings, accepts send metadata only, and requires phone PASS", async () => {
    const config = await configuration();
    const requests: ProviderRequest[] = [];
    const transport: ProviderTransport = async (request) => {
      requests.push(request);
      const action = request.headers["x-acs-action"];
      return {
        status: 200,
        body: JSON.stringify(
          action === "CheckSmsVerifyCode"
            ? { Code: "OK", Success: true, Model: { VerifyResult: "PASS" } }
            : action === "SendSmsVerifyCode"
              ? {
                  Code: "OK",
                  Success: true,
                  Model: { BizId: "synthetic-correlation" },
                }
              : { Response: { MessageId: "synthetic-correlation" } },
        ),
      };
    };
    const delivery = createProductionAuthDelivery(config, { transport });
    const code = randomBytes(3)
      .readUIntBE(0, 3)
      .toString()
      .padStart(6, "0")
      .slice(-6);
    expect(
      (
        await delivery.sendEmail({
          to: "synthetic@example.invalid",
          code,
          minutes: 5,
        })
      ).state,
    ).toBe("accepted");
    expect(
      (
        await delivery.sendPhone({
          e164: "+8613800000000",
          code: null,
          outId: "synthetic-challenge",
          minutes: 5,
        })
      ).state,
    ).toBe("accepted");
    expect(
      await delivery.checkPhone({
        e164: "+8613800000000",
        code,
        outId: "synthetic-challenge",
      }),
    ).toBe("pass");
    const email = JSON.parse(requests[0]!.body) as {
      Template: { TemplateData: string };
      Destination: string[];
    };
    expect(JSON.parse(email.Template.TemplateData).code === code).toBe(true);
    const sms = new URLSearchParams(requests[1]!.body);
    expect(sms.get("ReturnVerifyCode")).toBe("false");
    expect(sms.get("TemplateParam")).toBe('{"code":"##code##","min":"5"}');
    expect(sms.get("AutoRetry")).toBe("0");
    expect(sms.get("CodeLength")).toBe("6");
    expect(requests.length).toBe(3);
  });
  it("refuses provider error envelopes, echoed codes, malformed and oversized responses", async () => {
    const config = await configuration();
    const emailInput = {
      to: "synthetic@example.invalid",
      code: "000000",
      minutes: 5,
    };
    for (const body of [
      {
        Response: { Error: { Code: "SyntheticError" }, MessageId: "synthetic" },
      },
      { Response: { MessageId: "synthetic", Nested: { VerifyCode: "" } } },
      {},
    ]) {
      const delivery = createProductionAuthDelivery(config, {
        transport: async () => ({ status: 200, body: JSON.stringify(body) }),
      });
      expect((await delivery.sendEmail(emailInput)).state).toBe("failed");
    }
    for (const body of [
      { Code: "ERROR", Success: true, Model: { VerifyResult: "PASS" } },
      { Code: "OK", Success: false, Model: { VerifyResult: "PASS" } },
      {
        Code: "OK",
        Success: true,
        Model: { VerifyResult: "PASS", VerifyCode: "" },
      },
      { Code: "OK", Success: true, Model: {} },
    ]) {
      const delivery = createProductionAuthDelivery(config, {
        transport: async () => ({ status: 200, body: JSON.stringify(body) }),
      });
      expect(
        await delivery.checkPhone({
          e164: "+8613800000000",
          code: "000000",
          outId: "synthetic",
        }),
      ).toBe("malformed");
    }
    for (const response of [
      { status: 302, body: "{}" },
      { status: 200, body: "invalid" },
      { status: 200, body: "x".repeat(65537) },
    ]) {
      expect(
        (
          await createProductionAuthDelivery(config, {
            transport: async () => response,
          }).sendEmail(emailInput)
        ).state,
      ).toBe("failed");
    }
    const unknown = createProductionAuthDelivery(config, {
      transport: async () => ({
        status: 200,
        body: JSON.stringify({
          Code: "OK",
          Success: true,
          Model: { VerifyResult: "UNKNOWN" },
        }),
      }),
    });
    expect(
      await unknown.checkPhone({
        e164: "+8613800000000",
        code: "000000",
        outId: "synthetic",
      }),
    ).toBe("fail");
  });
  it("classifies unknown transmission without retries or phone proof", async () => {
    let attempts = 0;
    const delivery = createProductionAuthDelivery(await configuration(), {
      transport: async () => {
        attempts++;
        throw new ProviderTransportError("unknown");
      },
    });
    expect(
      (
        await delivery.sendEmail({
          to: "synthetic@example.invalid",
          code: "000000",
          minutes: 5,
        })
      ).state,
    ).toBe("unknown");
    expect(attempts).toBe(1);
    expect(
      await delivery.checkPhone({
        e164: "+8613800000000",
        code: "000000",
        outId: "synthetic",
      }),
    ).toBe("unknown");
    expect(attempts).toBe(2);
  });
});
