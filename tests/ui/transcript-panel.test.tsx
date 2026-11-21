// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptPanel } from "../../components/TranscriptPanel";

const SID = "abcd1234";

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    ts: "2026-01-01T10:00:00.000Z",
    tool: "GetBalance",
    args: { account: "GW-1" },
    risk: "read",
    decision: "allow",
    outcome: "ok",
    durationMs: 12,
    summary: "ok",
    ...over,
  };
}

function stubFetch(next: () => unknown[]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(next()), { status: 200 });
  });
  return { urls };
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TranscriptPanel", () => {
  it("lists entries newest first with text labels for each decision", async () => {
    stubFetch(() => [
      entry({ id: "a", tool: "ToolA", decision: "allow" }),
      entry({ id: "b", tool: "ToolB", decision: "hold", outcome: "held" }),
      entry({ id: "c", tool: "ToolC", decision: "block", outcome: "blocked" }),
      entry({ id: "d", tool: "ToolD", decision: "ghost", outcome: "ghost" }),
    ]);
    const { container } = render(<TranscriptPanel serviceId={SID} isDemo />);
    await flush();
    const tools = Array.from(container.querySelectorAll("li[data-entry] summary [data-tool]")).map(
      (n) => n.textContent,
    );
    expect(tools).toEqual(["ToolA", "ToolB", "ToolC", "ToolD"]);
    for (const label of ["Allowed", "Held", "Blocked", "Ghost"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("expands to show four steps and keeps [redacted]", async () => {
    stubFetch(() => [entry({ args: { pin: "[redacted]" }, soapRequest: "<req/>" })]);
    const { container } = render(<TranscriptPanel serviceId={SID} isDemo />);
    await flush();
    const details = container.querySelector("details") as HTMLDetailsElement;
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    for (const t of ["JSON in", "SOAP request", "SOAP response", "JSON out"]) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    expect(details.querySelectorAll("pre")).toHaveLength(4);
    expect(details.textContent).toContain('"pin": "[redacted]"');
    expect(details.textContent).toContain("Not sent");
  });

  it("renders HTML in args and summary as text", async () => {
    stubFetch(() => [entry({ args: { x: "<img src=x onerror=alert(1)>" }, summary: "<b>bold</b>" })]);
    const { container } = render(<TranscriptPanel serviceId={SID} isDemo />);
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows the empty state", async () => {
    stubFetch(() => []);
    render(<TranscriptPanel serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByText("No one has called this spirit yet.")).toBeTruthy();
  });

  it("shows the owner message and makes no fetch for a non-demo service without a token", async () => {
    const { urls } = stubFetch(() => []);
    render(<TranscriptPanel serviceId={SID} isDemo={false} />);
    await flush(5000);
    expect(screen.getByText("Only the owner can read this transcript.")).toBeTruthy();
    expect(urls).toHaveLength(0);
  });

  it("announces once per poll without argument values", async () => {
    let list: unknown[] = [entry({ id: "old" })];
    stubFetch(() => list);
    render(<TranscriptPanel serviceId={SID} isDemo />);
    await flush();
    const live = screen.getByTestId("transcript-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    list = [
      entry({ id: "n2", tool: "GetBalance", args: { secret: "TOPSECRET" } }),
      entry({ id: "n1", tool: "CloseAccount", decision: "hold", outcome: "held", args: { secret: "TOPSECRET" } }),
      entry({ id: "old" }),
    ];
    await flush(2000);
    expect(live.textContent).toBe("2 new calls: GetBalance allowed, CloseAccount held");
    expect(live.textContent).not.toContain("TOPSECRET");
    await flush(2000);
    expect(live.textContent).toBe("");
  });

  it("pauses polling while the tab is hidden", async () => {
    const { urls } = stubFetch(() => []);
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
    render(<TranscriptPanel serviceId={SID} isDemo />);
    await flush();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(1);
    const before = urls.length;
    await flush(10_000);
    expect(urls.length).toBe(before);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(1);
    expect(urls.length).toBeGreaterThan(before);
  });
});
