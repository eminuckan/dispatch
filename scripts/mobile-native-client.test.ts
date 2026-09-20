import { describe, expect, it } from "vite-plus/test";

import { nativeClientRecordRelativePaths } from "./mobile-native-client.ts";

describe("native client record identity", () => {
  it("writes fresh records under Dispatch cache and keeps the T3 cache as legacy input", () => {
    expect(nativeClientRecordRelativePaths("ios", "abc123")).toEqual({
      current: ".cache/dispatch/native-clients/ios/abc123.json",
      legacy: ".cache/t3code/native-clients/ios/abc123.json",
    });
    expect(nativeClientRecordRelativePaths("android", "def456")).toEqual({
      current: ".cache/dispatch/native-clients/android/def456.json",
      legacy: ".cache/t3code/native-clients/android/def456.json",
    });
  });
});
