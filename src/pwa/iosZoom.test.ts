import { describe, expect, it } from "vitest";
import { stopFocusZoom, type ZoomEnv } from "./iosZoom";

const VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const env = (userAgent: string, platform: string, maxTouchPoints: number): ZoomEnv => ({ userAgent, platform, maxTouchPoints, viewport: { content: VIEWPORT } });

describe("iOS focus zoom", () => {
  it("adds maximum-scale=1 on iPhone and iPad (which reports itself as a touch Mac), once", () => {
    for (const e of [env(IPHONE, "iPhone", 5), env(MAC, "MacIntel", 5)]) {
      expect(stopFocusZoom(e)).toBe(true);
      expect(e.viewport!.content).toBe(`${VIEWPORT}, maximum-scale=1`);
      expect(stopFocusZoom(e)).toBe(false);
      expect(e.viewport!.content).toBe(`${VIEWPORT}, maximum-scale=1`);
    }
  });

  it("leaves Android and desktop alone, so pinch zoom keeps working there", () => {
    for (const e of [env(ANDROID, "Linux armv8l", 5), env(MAC, "MacIntel", 0)]) {
      expect(stopFocusZoom(e)).toBe(false);
      expect(e.viewport!.content).toBe(VIEWPORT);
    }
  });

  it("does nothing without a viewport meta", () => {
    expect(stopFocusZoom({ ...env(IPHONE, "iPhone", 5), viewport: null })).toBe(false);
  });
});
