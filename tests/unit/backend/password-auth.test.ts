import { CommunityAuthService, createMemoryCommunityAuthPort } from "@moya/api";
import { describe } from "vitest";
import { passwordAuthCases } from "./password-auth-cases";
describe("password auth memory parity", () => {
  passwordAuthCases(() => {
    let now = new Date("2026-09-30T12:00:00Z");
    let code = "";
    const port = createMemoryCommunityAuthPort();
    const serviceForPort = (
      authPort: import("@moya/api").CommunityAuthPort,
      deliveryOverride?: import("@moya/api").AuthDeliveryPorts,
    ) =>
      new CommunityAuthService(authPort, {
        environment: "development",
        profile: "full-local",
        keys: {
          version: 1,
          lookupKey: Buffer.alloc(32, 1),
          encryptionKey: Buffer.alloc(32, 2),
          otpKey: Buffer.alloc(32, 3),
        },
        emailMode: "local_capture",
        phoneMode: "simulated",
        clock: () => now,
        delivery: deliveryOverride ?? {
          sendEmail: async (input) => {
            code = input.code;
            return { state: "accepted", correlation: "synthetic" };
          },
          sendPhone: async () => ({ state: "failed" }),
          checkPhone: async () => "fail",
        },
      });
    const service = serviceForPort(port);
    return {
      service,
      port,
      serviceForPort,
      suspend: async (id: string) => {
        port.setStatus(id, "suspended");
      },
      latestCode: () => code,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  });
});
