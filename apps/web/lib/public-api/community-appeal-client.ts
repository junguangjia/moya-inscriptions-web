import {
  authChallengeAcceptedSchema,
  authChallengeRequestSchema,
  authPasswordLoginRequestSchema,
  authVerifyRequestSchema,
  communityAppealLoginResultSchema,
  communityAppealSessionSchema,
} from "@moya/contracts/schemas";
import type {
  AuthChallengeRequest,
  AuthPasswordLoginRequest,
} from "@moya/contracts";
import type { AuthVerifyRequest } from "@moya/contracts/schemas";
import { authRequest, parseAuthCapabilities } from "./auth-client";
import { ReportingRequestError } from "./community-reporting-client";
export const appealClient = {
  signOut: async () => {
    const result = await authRequest("appeals/sign-out", { body: {} });
    if (result.status !== 200 && result.status !== 204)
      throw new ReportingRequestError(result.status);
  },
  session: async () => {
    const result = await authRequest("appeals/session");
    if (result.status === 401) return null;
    if (result.status !== 200) throw new ReportingRequestError(result.status);
    return communityAppealSessionSchema.parse(result.body);
  },
  capabilities: async () => {
    const result = await authRequest("capabilities");
    const parsed =
      result.status === 200 ? parseAuthCapabilities(result.body) : null;
    // The same-origin auth relay already rejects Development capabilities in
    // Production. This browser transport validates the public response only.
    if (parsed === null) throw new Error("登录服务暂不可用，请重试");
    return parsed;
  },
  login: async (command: AuthPasswordLoginRequest) => {
    const result = await authRequest("appeals/login", {
      body: authPasswordLoginRequestSchema.parse(command),
    });
    if (result.status !== 200) throw new ReportingRequestError(result.status);
    return communityAppealLoginResultSchema.parse(result.body).session;
  },
  challenge: async (command: AuthChallengeRequest) => {
    const result = await authRequest("appeals/challenges", {
      body: authChallengeRequestSchema.parse(command),
    });
    if (result.status !== 200) throw new ReportingRequestError(result.status);
    return authChallengeAcceptedSchema.parse(result.body);
  },
  verify: async (command: AuthVerifyRequest) => {
    const result = await authRequest("appeals/verify", {
      body: authVerifyRequestSchema.parse(command),
    });
    if (result.status !== 200) throw new ReportingRequestError(result.status);
    return communityAppealLoginResultSchema.parse(result.body).session;
  },
};
