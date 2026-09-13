import { afterEach, describe, expect, it, vi } from "vitest";
import { openDesktopWithAgent } from "./open.js";

// OS install paths and process launch are isolated so this test cannot open an installed app.
const system = vi.hoisted(() => ({
  installed: new Set<string>(),
  spawn: vi.fn((_command: string, _args: string[]) => ({ unref: vi.fn() })),
}));
vi.mock("node:fs", () => ({ existsSync: (path: string) => system.installed.has(path) }));
vi.mock("node:os", () => ({ homedir: () => "/Users/test" }));
vi.mock("@getpaseo/server", () => ({
  spawnProcess: (command: string, args: string[]) => system.spawn(command, args),
}));

afterEach(() => {
  system.installed.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  system.spawn.mockClear();
});

describe("desktop discovery", () => {
  it("opens Forkeo when both Forkeo and upstream Paseo are installed", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("PASEO_DESKTOP_CLI", "0");
    system.installed.add("/Applications/Forkeo.app");
    system.installed.add("/Applications/Paseo.app");

    await openDesktopWithAgent({ serverId: "host", agentId: "agent" });

    expect(system.spawn).toHaveBeenCalledWith("open", [
      "-n",
      "-g",
      "-a",
      "/Applications/Forkeo.app",
      "--args",
      expect.any(String),
    ]);
  });

  it("never launches upstream when Forkeo is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("PASEO_DESKTOP_CLI", "0");
    system.installed.add("/Applications/Paseo.app");

    await expect(openDesktopWithAgent({ serverId: "host", agentId: "agent" })).rejects.toThrow(
      "Forkeo desktop app not found. Install it from https://github.com/totally-tim/paseo/releases",
    );
    expect(system.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin", "/Users/test/Applications/Forkeo.app"],
    ["linux", "/opt/Forkeo/Forkeo"],
    ["linux", `/Users/test/Applications/Forkeo-${process.arch}.AppImage`],
    ["win32", "/Users/test/AppData/Local/Programs/Forkeo/Forkeo.exe"],
  ] as const)("discovers the %s installation at %s", async (platform, installedPath) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubEnv("PASEO_DESKTOP_CLI", "0");
    vi.stubEnv("LOCALAPPDATA", "/Users/test/AppData/Local");
    system.installed.add(installedPath);

    await openDesktopWithAgent({ serverId: "host", agentId: "agent" });

    expect(system.spawn).toHaveBeenCalledTimes(1);
    const [command, args] = system.spawn.mock.calls[0]!;
    const selectedPath = platform === "darwin" ? args[3] : command;
    expect(selectedPath).toBe(installedPath);
  });
});
