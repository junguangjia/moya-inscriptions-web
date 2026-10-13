import {
  MEDIA_PROFILE_RENDER,
  MEDIA_PROFILE_RENDITIONS,
  parseProfileMediaSwitch,
} from "@moya/backend-production/internal/publishing-config";
import { describe, expect, it } from "vitest";

/*
 * The two profile image switches (unified media pipeline, increment 3a):
 * `MEDIA_PROFILE_RENDER` (media worker) and `MEDIA_PROFILE_RENDITIONS`
 * (Backend). Missing or empty means on in Development and off in
 * Production, so a Production host without the keys behaves as before the
 * increment; only `on` and `off` are accepted, and a refusal names the key,
 * never the value.
 */

for (const key of [MEDIA_PROFILE_RENDER, MEDIA_PROFILE_RENDITIONS] as const)
  describe(`profile image switch ${key}`, () => {
    it("defaults on in Development and off in Production", () => {
      for (const environment of [{}, { [key]: "" }, { [key]: undefined }]) {
        expect(parseProfileMediaSwitch(environment, key, "development")).toBe(
          true,
        );
        expect(parseProfileMediaSwitch(environment, key, "production")).toBe(
          false,
        );
      }
    });

    it("accepts exactly on and off in both runtimes", () => {
      for (const nodeEnv of ["development", "production"] as const) {
        expect(parseProfileMediaSwitch({ [key]: "on" }, key, nodeEnv)).toBe(
          true,
        );
        expect(parseProfileMediaSwitch({ [key]: "off" }, key, nodeEnv)).toBe(
          false,
        );
      }
    });

    it("refuses any other value, naming only the key", () => {
      for (const value of [
        "ON",
        "Off",
        " on",
        "on ",
        "true",
        "1",
        "enabled",
        "synthetic-secret-value",
      ]) {
        for (const nodeEnv of ["development", "production"] as const) {
          let message = "";
          try {
            parseProfileMediaSwitch({ [key]: value }, key, nodeEnv);
          } catch (error) {
            message = (error as Error).message;
          }
          expect(message).toBe(`${key} must be on or off`);
        }
      }
    });

    it("reads only its own key", () => {
      const other =
        key === MEDIA_PROFILE_RENDER
          ? MEDIA_PROFILE_RENDITIONS
          : MEDIA_PROFILE_RENDER;
      expect(
        parseProfileMediaSwitch({ [other]: "invalid" }, key, "production"),
      ).toBe(false);
      expect(
        parseProfileMediaSwitch(
          { [other]: "off", [key]: "on" },
          key,
          "production",
        ),
      ).toBe(true);
    });
  });

it("names the two switch keys", () => {
  expect([MEDIA_PROFILE_RENDER, MEDIA_PROFILE_RENDITIONS]).toEqual([
    "MEDIA_PROFILE_RENDER",
    "MEDIA_PROFILE_RENDITIONS",
  ]);
});
