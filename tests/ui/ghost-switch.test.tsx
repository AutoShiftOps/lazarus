// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostShell } from "../../components/GhostShell";
import { GhostSwitch } from "../../components/GhostSwitch";
import { setOwnerToken } from "../../lib/ui/token-store";

const SID = "abcd1234";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";
const BANNER = "Ghost mode: nothing dangerous reaches the real service.";

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

function stubFetch(initialGhost: boolean, patchStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (method === "PATCH") {
      if (patchStatus !== 200) return new Response(JSON.stringify({ error: "SECRET" }), { status: patchStatus });
      const next = (JSON.parse(String(init?.body)) as { ghost: boolean }).ghost;
      return new Response(JSON.stringify({ ghost: next }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: SID, ghost: initialGhost, rules: [] }), { status: 200 });
  });
  return calls;
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function mount() {
  return render(
    <GhostShell serviceId={SID}>
      <GhostSwitch />
    </GhostShell>,
  );
}

const patches = (calls: Call[]): Call[] => calls.filter((c) => c.method === "PATCH");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GhostSwitch", () => {
  it("is disabled without a token and says why", async () => {
    stubFetch(false);
    mount();
    await flush();
    const sw = screen.getByRole("switch", { name: "Ghost mode" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText("Only the owner can change this.")).toBeTruthy();
    expect(screen.getByText("Dangerous calls are rehearsed, never sent.")).toBeTruthy();
  });

  it("toggles with a token, sends one PATCH with the header, and shows the banner", async () => {
    setOwnerToken(SID, TOKEN);
    const calls = stubFetch(false);
    const { container } = mount();
    await flush();
    const sw = screen.getByRole("switch", { name: "Ghost mode" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(BANNER)).toBeNull();

    fireEvent.click(sw);
    fireEvent.click(sw);
    await flush();
    expect(patches(calls)).toHaveLength(1);
    expect(patches(calls)[0].body).toBe('{"ghost":true}');
    expect(patches(calls)[0].headers["x-lazarus-owner"]).toBe(TOKEN);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(BANNER).closest("[role=status]")).toBeTruthy();
    expect(container.querySelector(".ghost-tint")).not.toBeNull();
    expect(container.textContent).not.toContain(TOKEN);

    fireEvent.click(sw);
    await flush();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(container.querySelector(".ghost-tint")).toBeNull();
  });

  it("shows the banner when ghost mode is already on", async () => {
    stubFetch(true);
    mount();
    await flush();
    expect(screen.getByText(BANNER)).toBeTruthy();
  });

  it("rolls back and shows a fixed message when the PATCH fails", async () => {
    setOwnerToken(SID, TOKEN);
    const calls = stubFetch(false, 500);
    mount();
    await flush();
    const sw = screen.getByRole("switch", { name: "Ghost mode" });
    fireEvent.click(sw);
    await flush();
    expect(patches(calls)).toHaveLength(1);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The spirits are unreachable. Try again.");
    expect(document.body.textContent).not.toContain("SECRET");
  });
});
