// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "../../components/Inbox";
import { setOwnerToken } from "../../lib/ui/token-store";

const SID = "abcd1234";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function approval(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    tool: "CloseAccount",
    args: { account: "GW-1", extra: { nested: [1, 2] } },
    risk: "destructive",
    reason: "Closes an account",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...over,
  };
}

function stubFetch(list: unknown[], postStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "POST") return new Response("{}", { status: postStatus });
    return new Response(JSON.stringify(list), { status: 200 });
  });
  return calls;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const posts = (calls: Call[]): Call[] => calls.filter((c) => c.method === "POST");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Inbox", () => {
  it("lists a pending approval with args as text", async () => {
    stubFetch([approval()]);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByText("CloseAccount")).toBeTruthy();
    expect(screen.getByText("Closes an account")).toBeTruthy();
    expect(screen.getByText("GW-1")).toBeTruthy();
    expect(screen.getByText('{"nested":[1,2]}')).toBeTruthy();
    expect(screen.getByTestId("remaining").textContent).toMatch(/left$/);
  });

  it("shows the empty state", async () => {
    stubFetch([]);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByText("No spirits are waiting.")).toBeTruthy();
  });

  it("keeps Approve disabled until the checkbox is ticked, then sends once", async () => {
    const calls = stubFetch([approval()]);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    const button = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(posts(calls)).toHaveLength(1);
    expect(JSON.parse(posts(calls)[0].body ?? "{}")).toEqual({ decision: "approve" });
    expect(screen.getByText("Released")).toBeTruthy();
  });

  it("Deny sends once with the note", async () => {
    const calls = stubFetch([approval()]);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "not today" } });
    const deny = screen.getByRole("button", { name: "Deny" });
    fireEvent.click(deny);
    fireEvent.click(deny);
    await flush();
    expect(posts(calls)).toHaveLength(1);
    expect(JSON.parse(posts(calls)[0].body ?? "{}")).toEqual({ decision: "deny", note: "not today" });
    expect(screen.getByText("Denied")).toBeTruthy();
  });

  it("shows the conflict message on 409 and re-enables the controls", async () => {
    stubFetch([approval()], 409);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    const deny = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
    fireEvent.click(deny);
    await flush();
    expect(screen.getByText("This call was already resolved.")).toBeTruthy();
    expect(deny.disabled).toBe(false);
  });

  it("non-demo without a token shows the owner message, no controls and no fetch", async () => {
    const calls = stubFetch([approval()]);
    render(<Inbox serviceId={SID} isDemo={false} />);
    await flush(5000);
    expect(screen.getByText("Only the owner can release calls.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("non-demo with a token polls and sends the owner header", async () => {
    setOwnerToken(SID, TOKEN);
    const calls = stubFetch([approval()]);
    render(<Inbox serviceId={SID} isDemo={false} />);
    await flush();
    expect(calls.length).toBeGreaterThan(0);
    expect(screen.getByText("CloseAccount")).toBeTruthy();
  });

  it("renders HTML in reason and args as text", async () => {
    stubFetch([
      approval({ reason: "<img src=x onerror=alert(1)>", args: { note: "<b>bold</b>" } }),
    ]);
    const { container } = render(<Inbox serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("truncates long cells to 200 characters", async () => {
    stubFetch([approval({ args: { big: "x".repeat(500) } })]);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByText(`${"x".repeat(200)}…`)).toBeTruthy();
  });

  it("shows a quiet listening line when polling fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByText("Listening for the spirits…")).toBeTruthy();
  });

  it("shows only the 5 newest resolved items when the API returns newest first", async () => {
    const resolved = Array.from({ length: 7 }, (_, i) =>
      approval({ id: `r${i + 1}`, tool: `Tool${i + 1}`, status: "approved" }),
    );
    stubFetch(resolved);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    for (const n of [1, 2, 3, 4, 5]) expect(screen.getByText(`Tool${n}`)).toBeTruthy();
    for (const n of [6, 7]) expect(screen.queryByText(`Tool${n}`)).toBeNull();
  });

  it("keeps controls enabled when the client clock says expired but the server says pending", async () => {
    stubFetch([approval({ expiresAt: new Date(Date.now() - 60_000).toISOString(), status: "pending" })]);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    expect(screen.getByTestId("remaining").textContent).toBe("expired");
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Hold to release" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Note (optional)") as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a 409 from a failed candle release exactly once", async () => {
    const calls = stubFetch([approval()], 409);
    render(<Inbox serviceId={SID} isDemo />);
    await flush();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to release" }));
    await flush(2200);
    expect(posts(calls)).toHaveLength(1);
    expect(screen.getAllByText("This call was already resolved.")).toHaveLength(1);
  });
});
