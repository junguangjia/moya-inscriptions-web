import { createProductionAuthService } from "@moya/backend-runtime";
import type { CommunityAuthPort } from "@moya/backend-runtime";
import type { ConfiguredProductionAuth } from "./config.js";
import { createProductionAuthDelivery } from "./provider.js";
import type { AuthProviderDependencies } from "./provider.js";

export { loadProductionAuthConfiguration } from "./config.js";
export type { ConfiguredProductionAuth } from "./config.js";
export { createProductionAuthDelivery } from "./provider.js";
export type { AuthProviderDependencies } from "./provider.js";
export type {
  ProviderTransport,
  ProviderRequest,
  ProviderResponse,
} from "./transport.js";

export const createConfiguredProductionAuthService = (
  port: CommunityAuthPort,
  config: ConfiguredProductionAuth,
  dependencies: AuthProviderDependencies = {},
) =>
  createProductionAuthService(
    port,
    config.service,
    createProductionAuthDelivery(config, dependencies),
    config.agreement,
  );
