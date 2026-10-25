import { describe, expect, it } from "vitest";

import { catalogDirectPublishEnabled } from "admin/runtime-settings";

describe("CMS_CATALOG_DIRECT_PUBLISH", () => {
  it("keeps the preparation guard unless the switch is exactly on", () => {
    expect(catalogDirectPublishEnabled({})).toBe(false);
    expect(
      catalogDirectPublishEnabled({ CMS_CATALOG_DIRECT_PUBLISH: "off" }),
    ).toBe(false);
    // A blanked switch (`CMS_CATALOG_DIRECT_PUBLISH=` in admin.env) is off.
    expect(
      catalogDirectPublishEnabled({ CMS_CATALOG_DIRECT_PUBLISH: "" }),
    ).toBe(false);
    expect(
      catalogDirectPublishEnabled({ CMS_CATALOG_DIRECT_PUBLISH: "on" }),
    ).toBe(true);
  });

  it("refuses any other value", () => {
    for (const value of ["ON", "true", "1", " ", " on", "on ", "off "])
      expect(() =>
        catalogDirectPublishEnabled({ CMS_CATALOG_DIRECT_PUBLISH: value }),
      ).toThrow("CMS_CATALOG_DIRECT_PUBLISH_INVALID");
  });
});
