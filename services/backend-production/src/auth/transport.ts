import { request } from "node:https";

export interface ProviderRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export interface ProviderResponse {
  readonly status: number;
  readonly body: string;
}
/** Code-only injection boundary; never selected by environment or a request. */
export type ProviderTransport = (
  input: ProviderRequest,
) => Promise<ProviderResponse>;
export class ProviderTransportError extends Error {
  constructor(readonly outcome: "failed" | "unknown") {
    super("AUTH_PROVIDER_TRANSPORT");
  }
}
export const PROVIDER_TIMEOUT_MS = 8000;
export const PROVIDER_RESPONSE_MAX_BYTES = 65536;
const hosts = new Set([
  "ses.tencentcloudapi.com",
  "ses.intl.tencentcloudapi.com",
  "dypnsapi.aliyuncs.com",
]);

/** One HTTPS attempt, verified system TLS, no redirects, no upstream error text. */
export const sendProviderRequest: ProviderTransport = (input) =>
  new Promise((resolve, reject) => {
    const url = new URL(input.url);
    if (
      url.protocol !== "https:" ||
      !hosts.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      input.headers.host !== url.host
    ) {
      reject(new ProviderTransportError("failed"));
      return;
    }
    let settled = false;
    const finish = (
      error: ProviderTransportError | null,
      response?: ProviderResponse,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error !== null) reject(error);
      else resolve(response!);
    };
    const outgoing = request(
      url,
      {
        method: input.method,
        headers: {
          ...input.headers,
          "content-length": Buffer.byteLength(input.body).toString(),
        },
        rejectUnauthorized: true,
      },
      (incoming) => {
        if (
          incoming.statusCode === undefined ||
          incoming.statusCode < 200 ||
          incoming.statusCode >= 300
        ) {
          finish(new ProviderTransportError("failed"));
          incoming.destroy();
          return;
        }
        const declared = incoming.headers["content-length"];
        if (
          declared !== undefined &&
          (!/^[0-9]+$/u.test(declared) ||
            Number(declared) > PROVIDER_RESPONSE_MAX_BYTES)
        ) {
          finish(new ProviderTransportError("failed"));
          incoming.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > PROVIDER_RESPONSE_MAX_BYTES) {
            finish(new ProviderTransportError("failed"));
            incoming.destroy();
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("error", () =>
          finish(new ProviderTransportError("unknown")),
        );
        incoming.once("aborted", () =>
          finish(new ProviderTransportError("unknown")),
        );
        incoming.once("end", () => {
          try {
            const body = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            );
            finish(null, { status: incoming.statusCode!, body });
          } catch {
            finish(new ProviderTransportError("failed"));
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      finish(new ProviderTransportError("unknown"));
      outgoing.destroy();
    }, PROVIDER_TIMEOUT_MS);
    outgoing.once("error", () => finish(new ProviderTransportError("unknown")));
    outgoing.end(input.body);
  });
