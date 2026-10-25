import type { BackendApplicationOptions } from "@moya/backend-runtime";
import type { PublishingCosTransport } from "../storage/publishing-cos-transport.js";
import { CosReportingEvidenceStore } from "./cos-evidence-store.js";
import { PrivateReportingEvidenceStore } from "./evidence-store.js";

export { CosReportingEvidenceStore };

type Environment = Readonly<Record<string, string | undefined>>;

/** Configuration is explicit and checked before pools; no cloud I/O at startup. */
export function openReportingEvidenceStore(
  environment: Environment,
  transport?: PublishingCosTransport,
): BackendApplicationOptions["reportingEvidenceStore"] {
  const mode = environment.MOYA_REPORT_EVIDENCE_STORE;
  const directory = environment.MOYA_REPORT_EVIDENCE_DIRECTORY;
  const cosSettings = Object.keys(environment).some(
    (key) =>
      key.startsWith("REPORT_EVIDENCE_COS_") && environment[key] !== undefined,
  );
  if (mode !== undefined && mode !== "filesystem" && mode !== "cos")
    throw new Error("REPORT_EVIDENCE_STORE_INVALID");
  if (mode !== "cos") {
    if (cosSettings)
      throw new Error("REPORT_EVIDENCE_COS_EXPLICIT_SELECTION_REQUIRED");
    if (mode === "filesystem" && !directory)
      throw new Error("REPORT_EVIDENCE_DIRECTORY_REQUIRED");
    // Keep existing deployments and Development usable during the explicit cutover.
    return directory ? new PrivateReportingEvidenceStore(directory) : undefined;
  }
  if (directory)
    throw new Error("REPORT_EVIDENCE_STORE_CONFIGURATION_CONFLICT");
  if (environment.NODE_ENV !== "production")
    throw new Error("REPORT_EVIDENCE_COS_PRODUCTION_PROFILE_REQUIRED");
  const required = (suffix: string) => {
    const key = "REPORT_EVIDENCE_COS_" + suffix;
    const value = environment[key];
    if (
      !value ||
      value.trim() !== value ||
      /[\r\n]/u.test(value) ||
      value.startsWith("REPLACE_ME")
    )
      throw new Error("REPORT_EVIDENCE_COS_CONFIGURATION_INVALID: " + key);
    return value;
  };
  const secretId = required("SECRET_ID");
  const secretKey = required("SECRET_KEY");
  if (!/^[A-Za-z0-9_-]+$/u.test(secretId))
    throw new Error("REPORT_EVIDENCE_COS_CREDENTIALS_INVALID");
  for (const namespace of [
    "COS",
    "CMS_COS",
    "WORK_MEDIA_COS",
    "CATALOG_SOURCE_COS",
  ])
    if (
      secretId === environment[namespace + "_SECRET_ID"] ||
      secretKey === environment[namespace + "_SECRET_KEY"]
    )
      throw new Error("REPORT_EVIDENCE_COS_IDENTITY_NOT_SEPARATE");
  const tokenSet = environment.REPORT_EVIDENCE_COS_SECURITY_TOKEN !== undefined;
  const expirySet =
    environment.REPORT_EVIDENCE_COS_CREDENTIAL_EXPIRES_AT !== undefined;
  if (tokenSet !== expirySet)
    throw new Error("REPORT_EVIDENCE_COS_TEMPORARY_CREDENTIALS_INCOMPLETE");
  const securityToken = tokenSet ? required("SECURITY_TOKEN") : undefined;
  const expires = expirySet ? required("CREDENTIAL_EXPIRES_AT") : undefined;
  const expiresAt = expires === undefined ? undefined : Number(expires);
  if (
    expires !== undefined &&
    (!/^[1-9]\d*$/u.test(expires) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt! <= Math.floor(Date.now() / 1000) + 30)
  )
    throw new Error("REPORT_EVIDENCE_COS_TEMPORARY_CREDENTIALS_EXPIRED");
  const timeout = environment.REPORT_EVIDENCE_COS_REQUEST_TIMEOUT_MS ?? "30000";
  if (!/^[1-9]\d*$/u.test(timeout))
    throw new Error("REPORT_EVIDENCE_COS_TIMEOUT_INVALID");
  return new CosReportingEvidenceStore(
    {
      bucket: required("BUCKET"),
      region: required("REGION"),
      prefix: required("PREFIX"),
      requestTimeoutMs: Number(timeout),
      credentials: async () => ({
        secretId,
        secretKey,
        ...(securityToken === undefined ? {} : { securityToken }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
    },
    transport,
  );
}
