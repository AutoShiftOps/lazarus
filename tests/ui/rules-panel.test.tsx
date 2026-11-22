// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RulesPanel } from "../../components/RulesPanel";
import type { Rule } from "../../lib/safety/types";
import { RuleSetSchema } from "../../lib/safety/schemas";
import { setOwnerToken } from "../../lib/ui/token-store";
import type { StarterOperation } from "../../lib/ui/starter-rules";

const SID = "abcd1234";
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";

const OPERATIONS: StarterOperation[] = [
  { name: "TransferFunds", risk: "write", inputFields: ["amount", "to"] },
  { name: "CloseAccount", risk: "destructive", inputFields: ["accountId"] },
];

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

function stubFetch(initial: Rule[], putStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (method === "PUT") {
      if (putStatus !== 200) return new Response(JSON.stringify({ error: "SECRET" }), { status: putStatus });
      return new Response(String(init?.body), { status: 200 });
    }
    return new Response(JSON.stringify({ id: SID, ghost: false, rules: initial }), { status: 200 });
  });
  return calls;
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const puts = (calls: Call[]): Call[] => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const existing: Rule = {
  id: "keep",
  operation: "GetBalance",
  effect: "allow",
  reason: "<b>bold</b> <img src=x onerror=alert(1)>",
};

describe("RulesPanel", () => {
  it("shows the empty state", async () => {
    stubFetch([]);
    render(<RulesPanel serviceId={SID} operations={OPERATIONS} />);
    await flush();
    expect(
      screen.getByText("No rules yet. The spirits follow their defaults: destructive calls are held."),
    ).toBeTruthy();
  });

  it("is read-only without a token and renders reasons as plain text", async () => {
    const calls = stubFetch([existing]);
    const { container } = render(<RulesPanel serviceId={SID} operations={OPERATIONS} />);
    await flush();
    expect(screen.getByText("Only the owner can change rules.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>bold</b>");
    expect(puts(calls)).toHaveLength(0);
  });

  it("adds a starter rule with exactly one PUT of the full list, then removes it", async () => {
    setOwnerToken(SID, TOKEN);
    const calls = stubFetch([existing]);
    render(<RulesPanel serviceId={SID} operations={OPERATIONS} />);
    await flush();

    const hold = screen.getByRole("checkbox", { name: /Hold transfers over 1000/ }) as HTMLInputElement;
    expect(hold.checked).toBe(false);
    fireEvent.click(hold);
    fireEvent.click(hold);
    await flush();

    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].headers["x-lazarus-owner"]).toBe(TOKEN);
    const sent: unknown = JSON.parse(puts(calls)[0].body ?? "null");
    expect(RuleSetSchema.safeParse(sent).success).toBe(true);
    expect(sent).toEqual([
      existing,
      {
        id: expect.any(String),
        operation: "TransferFunds",
        when: { field: "amount", op: "gt", value: 1000 },
        effect: "hold",
        reason: "Large transfer",
      },
    ]);
    expect(hold.checked).toBe(true);
    expect(screen.getByText(/Hold TransferFunds when amount is greater than 1000/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Remove rule: Hold TransferFunds/ }));
    await flush();
    expect(puts(calls)).toHaveLength(2);
    expect(JSON.parse(puts(calls)[1].body ?? "null")).toEqual([existing]);
    expect(hold.checked).toBe(false);
  });

  it("rolls back with a fixed message when the PUT fails", async () => {
    setOwnerToken(SID, TOKEN);
    stubFetch([]);
    render(<RulesPanel serviceId={SID} operations={OPERATIONS} />);
    await flush();
    stubFetch([], 500);
    const block = screen.getByRole("checkbox", { name: /Block all destructive calls/ }) as HTMLInputElement;
    fireEvent.click(block);
    await flush();
    expect(block.checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("The spirits are unreachable. Try again.");
    expect(document.body.textContent).not.toContain("SECRET");
  });
});
