import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

let stored: string | null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  native.isTauri.mockReturnValue(true);
  stored = null;
  native.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "read_desktop_session") return stored;
    if (command === "write_desktop_session") stored = args.token;

    return undefined;
  });
  fetchMock = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_API_URL", "https://api.example.test/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function authorization(call = 0) {
  return (fetchMock.mock.calls[call][1].headers as Headers).get("Authorization");
}

describe("desktop session persistence", () => {
  it("restores a saved login after the webview restarts", async () => {
    const firstLaunch = await import("./api");
    await firstLaunch.setDesktopToken("saved-session");
    vi.resetModules();
    const restarted = await import("./api");
    await restarted.api("/api/me");
    expect(authorization()).toBe("Bearer saved-session");
    expect(native.invoke).toHaveBeenCalledWith("read_desktop_session", {
      server: "https://api.example.test",
    });
  });

  it("waits for one credential read before sending concurrent startup requests", async () => {
    let restore!: (token: string) => void;
    native.invoke.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          restore = resolve;
        }),
    );
    const { api } = await import("./api");
    const requests = Promise.all([api("/api/me"), api("/api/files")]);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
    restore("restored-session");
    await requests;
    expect(authorization(0)).toBe("Bearer restored-session");
    expect(authorization(1)).toBe("Bearer restored-session");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("removes the saved credential on explicit sign-out", async () => {
    stored = "saved-session";
    const { signOut } = await import("./api");
    await signOut();
    expect(authorization()).toBe("Bearer saved-session");
    expect(stored).toBeNull();
    vi.resetModules();
    const restarted = await import("./api");
    await restarted.api("/api/me");
    expect(authorization(1)).toBeNull();
  });

  it("retries credential reads after an unavailable credential store", async () => {
    stored = "saved-session";
    native.invoke.mockRejectedValueOnce(new Error("Credential store locked"));
    const { api } = await import("./api");
    await expect(api("/api/me")).rejects.toThrow("Credential store locked");
    expect(fetchMock).not.toHaveBeenCalled();
    await api("/api/me");
    expect(authorization()).toBe("Bearer saved-session");
  });

  it("reports persistence failures instead of accepting an unsaved login", async () => {
    native.invoke.mockRejectedValueOnce(new Error("Credential store locked"));
    const { setDesktopToken, api } = await import("./api");
    await expect(setDesktopToken("unsaved-session")).rejects.toThrow("Credential store locked");
    await api("/api/me");
    expect(authorization()).toBeNull();
  });

  it.each([401, 503])("keeps the credential when an API request fails with %s", async (status) => {
    stored = "saved-session";
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status }));
    const { api } = await import("./api");
    await expect(api("/api/me")).rejects.toThrow("Unavailable");
    expect(stored).toBe("saved-session");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("leaves browser authentication on cookies without native IPC", async () => {
    native.isTauri.mockReturnValue(false);
    const { api, signOut } = await import("./api");
    await api("/api/me");
    await signOut();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(authorization()).toBeNull();
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });
});

describe("web sign-in routing", () => {
  it("redirects web sign-in to hosted AuthKit", async () => {
    native.isTauri.mockReturnValue(false);
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/recents", assign } });
    const { signIn } = await import("./api");
    await signIn();
    expect(assign).toHaveBeenCalledWith("https://api.example.test/auth/login?returnTo=%2Frecents");
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("keeps the editor open while signing in in another tab", async () => {
    native.isTauri.mockReturnValue(false);
    vi.useFakeTimers();
    const assign = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/files/design", assign }, open });

    try {
      const { signIn } = await import("./api");
      const pending = signIn(true);
      expect(open).toHaveBeenCalledWith(
        "https://api.example.test/auth/login?returnTo=%2Ffiles%2Fdesign",
        "_blank",
        "noopener,noreferrer",
      );
      await vi.advanceTimersByTimeAsync(1500);
      await pending;
      expect(assign).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/api/me");
    } finally {
      vi.useRealTimers();
    }
  });
});
