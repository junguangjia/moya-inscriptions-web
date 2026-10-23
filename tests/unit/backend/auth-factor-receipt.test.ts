import { createMemoryCommunityAuthPort } from "@moya/api";
import { authFactorReceiptCases } from "./auth-factor-receipt-cases";
authFactorReceiptCases(
  createMemoryCommunityAuthPort,
  async (port, invitation) => {
    (
      port as ReturnType<typeof createMemoryCommunityAuthPort>
    ).provisionInvitation(invitation);
  },
);
