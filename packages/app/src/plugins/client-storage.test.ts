// @vitest-environment jsdom
import AsyncStorage from "@react-native-async-storage/async-storage";
import { describe, expect, it } from "vitest";
import { createPluginClientStorage } from "./client-storage";

describe("plugin client preferences", () => {
  it("persists across runtime instances and isolates host, plugin, and key boundaries", async () => {
    await AsyncStorage.clear();
    const first = createPluginClientStorage("host/a", "plugin");
    await first.setItem("filters", "saved");
    expect(await createPluginClientStorage("host/a", "plugin").getItem("filters")).toBe("saved");
    expect(await createPluginClientStorage("host", "a/plugin").getItem("filters")).toBeNull();
    expect(await createPluginClientStorage("host/a", "other").getItem("filters")).toBeNull();
    expect(await first.getItem("other")).toBeNull();
    await first.removeItem("filters");
    expect(await first.getItem("filters")).toBeNull();
  });
});

it("waits for a prior installation's writes before restoring preferences", async () => {
  const first = createPluginClientStorage("reconnect-host", "inbox");
  const older = first.setItem("drafts", "first");
  const newer = first.setItem("drafts", "latest");
  const reinstalled = createPluginClientStorage("reconnect-host", "inbox");
  expect(await reinstalled.getItem("drafts")).toBe("latest");
  await Promise.all([older, newer]);
  await reinstalled.removeItem("drafts");
});
