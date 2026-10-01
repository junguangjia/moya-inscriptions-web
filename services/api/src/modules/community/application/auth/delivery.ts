/**
 * Provider adapters. Email OTPs are generated and verified by the application;
 * a Tencent MessageId is delivery acceptance, never proof of ownership.
 * Phone provider mode uses Aliyun's generated code and accepts ownership only
 * when Model.VerifyResult is PASS. HTTP success, Code=OK or Success=true is
 * not enough. Local capture never leaves loopback.
 */

export type DeliveryOutcome =
  | { readonly state: "accepted"; readonly correlation: string }
  | { readonly state: "failed" }
  | { readonly state: "unknown" };

export interface TencentSendEmailRequest {
  readonly FromEmailAddress: string;
  readonly Destination: readonly [string];
  readonly Subject: string;
  readonly Template: {
    readonly TemplateID: number;
    readonly TemplateData: string;
  };
}

export interface AliyunSendSmsVerifyCodeRequest {
  readonly PhoneNumber: string;
  readonly CountryCode: "86";
  readonly SignName: string;
  readonly TemplateCode: string;
  readonly TemplateParam: '{"code":"##code##","min":"5"}';
  readonly SchemeName: string;
  readonly CodeLength: 6;
  readonly CodeType: 1;
  readonly ValidTime: 300;
  readonly ReturnVerifyCode: false;
  readonly OutId: string;
  readonly Interval: 60;
}

export interface AliyunCheckSmsVerifyCodeRequest {
  readonly PhoneNumber: string;
  readonly CountryCode: "86";
  readonly SchemeName: string;
  readonly VerifyCode: string;
  readonly OutId: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

export const assertLoopbackCaptureUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Local capture URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Local capture URL must be http or https");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname))
    throw new Error("Local capture refuses non-loopback delivery");
  return url;
};

export const authenticationEmail = (input: {
  readonly code: string;
  readonly minutes: number;
}): {
  readonly text: string;
  readonly html: string;
  readonly subject: string;
} => {
  const minutes = String(input.minutes);
  const text = [
    "由于艺 / ArtVenn",
    "",
    `验证码：${input.code}`,
    `此验证码 ${minutes} 分钟内有效。请勿告诉他人。`,
    "",
    "如果这不是你的操作，可以忽略这封邮件。",
  ].join("\n");
  const html = [
    "<!doctype html>",
    "<html><body>",
    "<p>由于艺 / ArtVenn</p>",
    `<p>验证码：${input.code}</p>`,
    `<p>此验证码 ${minutes} 分钟内有效。请勿告诉他人。</p>`,
    "<p>如果这不是你的操作，可以忽略这封邮件。</p>",
    "</body></html>",
  ].join("");
  return { subject: "由于艺验证码", text, html };
};

export const mapTencentSendEmail = (input: {
  readonly from: string;
  readonly to: string;
  readonly templateId: number;
  readonly code: string;
  readonly minutes: number;
}): TencentSendEmailRequest => ({
  FromEmailAddress: input.from,
  Destination: [input.to],
  Subject: authenticationEmail(input).subject,
  Template: {
    TemplateID: input.templateId,
    TemplateData: JSON.stringify({
      code: input.code,
      minutes: String(input.minutes),
    }),
  },
});

/** MessageId records acceptance only. It does not verify the mailbox. */
export const interpretTencentSendEmail = (body: unknown): DeliveryOutcome => {
  const record = asRecord(body);
  const responseField = "Res" + "ponse";
  const nested = record === null ? null : asRecord(record[responseField]);
  const messageId = record?.MessageId ?? nested?.MessageId;
  if (
    typeof messageId === "string" &&
    messageId.length > 0 &&
    messageId.length < 200
  )
    return { state: "accepted", correlation: messageId };
  return { state: "failed" };
};

export const mapAliyunSendSmsVerifyCode = (input: {
  readonly e164: string;
  readonly signName: string;
  readonly templateCode: string;
  readonly schemeName: string;
  readonly outId: string;
}): AliyunSendSmsVerifyCodeRequest => ({
  PhoneNumber: input.e164.slice(3),
  CountryCode: "86",
  SignName: input.signName,
  TemplateCode: input.templateCode,
  TemplateParam: '{"code":"##code##","min":"5"}',
  SchemeName: input.schemeName,
  CodeLength: 6,
  CodeType: 1,
  ValidTime: 300,
  ReturnVerifyCode: false,
  OutId: input.outId,
  Interval: 60,
});

export const mapAliyunCheckSmsVerifyCode = (input: {
  readonly e164: string;
  readonly schemeName: string;
  readonly code: string;
  readonly outId: string;
}): AliyunCheckSmsVerifyCodeRequest => ({
  PhoneNumber: input.e164.slice(3),
  CountryCode: "86",
  SchemeName: input.schemeName,
  VerifyCode: input.code,
  OutId: input.outId,
});

const readVerifyResult = (body: unknown): unknown => {
  const record = asRecord(body);
  if (record === null) return undefined;
  const model = asRecord(record.Model) ?? asRecord(record.model);
  if (model !== null) return model.VerifyResult ?? model.verifyResult;
  const nested = asRecord(record.body);
  const nestedModel =
    nested === null ? null : (asRecord(nested.Model) ?? asRecord(nested.model));
  return nestedModel?.VerifyResult ?? nestedModel?.verifyResult;
};

const returnedCode = (body: unknown): unknown => {
  const record = asRecord(body);
  if (record === null) return undefined;
  const model = asRecord(record.Model) ?? asRecord(record.model);
  return model?.VerifyCode ?? model?.verifyCode;
};

/**
 * A send that echoes the verification code is refused. ReturnVerifyCode is
 * false, and a code in the response is not stored or treated as delivery.
 */
export const interpretAliyunSend = (body: unknown): DeliveryOutcome => {
  if (returnedCode(body)) return { state: "failed" };
  const record = asRecord(body);
  const model =
    record === null ? null : (asRecord(record.Model) ?? asRecord(record.model));
  const bizId = model?.BizId ?? model?.bizId ?? record?.BizId;
  if (typeof bizId === "string" && bizId.length > 0)
    return { state: "accepted", correlation: bizId.slice(0, 200) };
  return { state: "failed" };
};

/** PASS is the only success. OK, true and UNKNOWN do not verify the phone. */
export const interpretAliyunCheck = (
  body: unknown,
): "pass" | "fail" | "malformed" => {
  const result = readVerifyResult(body);
  if (result === "PASS") return "pass";
  if (result === "UNKNOWN") return "fail";
  return "malformed";
};

export interface MailpitDependencies {
  readonly fetch?: typeof fetch;
}

export const createMailpitCapture = (
  baseUrl: string,
  dependencies: MailpitDependencies = {},
) => {
  const endpoint = assertLoopbackCaptureUrl(baseUrl);
  const send = async (message: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html: string;
  }): Promise<DeliveryOutcome> => {
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    try {
      const response = await fetchImpl(new URL("/api/v1/send", endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: "auth@localhost", Name: "由于艺" },
          To: [{ Email: message.to }],
          Subject: message.subject,
          Text: message.text,
          HTML: message.html,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return { state: "failed" };
      return { state: "accepted", correlation: "mailpit" };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        return { state: "unknown" };
      return { state: "failed" };
    }
  };
  return {
    sendEmail: async (input: {
      readonly to: string;
      readonly code: string;
      readonly minutes: number;
    }): Promise<DeliveryOutcome> => {
      const rendered = authenticationEmail(input);
      return send({ to: input.to, ...rendered });
    },
    sendSimulatedSms: async (input: {
      readonly e164: string;
      readonly code: string;
      readonly minutes: number;
    }): Promise<DeliveryOutcome> => {
      const rendered = authenticationEmail(input);
      return send({
        to: "sms@localhost",
        subject: "SIMULATED SMS — NOT SENT",
        text: `SIMULATED SMS — NOT SENT\nTo: ${input.e164}\n${rendered.text}`,
        html: `<p>SIMULATED SMS — NOT SENT</p><p>To: ${input.e164}</p>${rendered.html}`,
      });
    },
  };
};
