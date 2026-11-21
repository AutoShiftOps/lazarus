// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommuneForm } from "../../components/CommuneForm";
import type { FieldDescriptor } from "../../lib/soap/types";

const SID = "abcd1234";

function f(name: string, xsdType: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { name, xsdType, minOccurs: 1, maxOccurs: 1, nillable: false, ...extra };
}

function rpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}

function toolResult(structured: Record<string, unknown>, text = "text"): unknown {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

interface Sent {
  name: string;
  arguments: unknown;
}

function mockFetch(responses: (() => Promise<Response>)[]): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  let i = 0;
  return {
    sent,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { params: Sent };
      sent.push(body.params);
      const next = responses[Math.min(i++, responses.length - 1)];
      return next();
    },
  };
}

const respond = (result: unknown) => async () => rpc(result);

afterEach(() => cleanup());

const submit = () => fireEvent.click(screen.getByRole("button", { name: "Commune" }));

describe("CommuneForm", () => {
  it("shows a required error next to the field and sends nothing", async () => {
    const m = mockFetch([respond(toolResult({}))]);
    render(<CommuneForm serviceId={SID} toolName="Add" inputDescriptor={[f("a", "int")]} fetchImpl={m.fetch} />);
    submit();
    const input = screen.getByLabelText(/^a(\s|$)/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errorId = input.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    expect(document.getElementById(errorId as string)?.textContent).toBe("This field is required.");
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(m.sent).toHaveLength(0);
  });

  it("sends nested and list fields converted to the right types", async () => {
    const m = mockFetch([respond(toolResult({ sum: 3 }))]);
    const desc = [
      f("a", "int"),
      f("addr", "Address", { children: [f("city", "string"), f("zip", "int", { minOccurs: 0 })] }),
      f("tags", "int", { maxOccurs: "unbounded" }),
      f("active", "boolean", { minOccurs: 0 }),
    ];
    render(<CommuneForm serviceId={SID} toolName="Add" inputDescriptor={desc} fetchImpl={m.fetch} />);
    expect(screen.getByRole("group", { name: /addr/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^a(\s|$)/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/^city/), { target: { value: "Oslo" } });
    fireEvent.change(screen.getByLabelText(/^tags/), { target: { value: "[1,2]" } });
    submit();
    await screen.findByText(/"sum": 3/);
    expect(m.sent[0]).toEqual({
      name: "Add",
      arguments: { a: 5, addr: { city: "Oslo" }, tags: [1, 2] },
    });
  });

  it("maps a bad list to the field and a zod failure to the field", async () => {
    const m = mockFetch([respond(toolResult({}))]);
    const desc = [f("tags", "int", { maxOccurs: "unbounded", minOccurs: 0 }), f("n", "int")];
    render(<CommuneForm serviceId={SID} toolName="Add" inputDescriptor={desc} fetchImpl={m.fetch} />);
    fireEvent.change(screen.getByLabelText(/^tags/), { target: { value: "[1, " } });
    fireEvent.change(screen.getByLabelText(/^n/), { target: { value: "1.5" } });
    submit();
    expect(document.getElementById(screen.getByLabelText(/^tags/).getAttribute("aria-describedby") as string)?.textContent).toMatch(/JSON/);
    fireEvent.change(screen.getByLabelText(/^tags/), { target: { value: "[1]" } });
    submit();
    expect(screen.getByLabelText(/^n/).getAttribute("aria-describedby")).toBeTruthy();
    expect(m.sent).toHaveLength(0);
  });

  it("renders HTML in a result as text", async () => {
    const m = mockFetch([respond(toolResult({ note: "<img src=x onerror=alert(1)>" }))]);
    const { container } = render(
      <CommuneForm serviceId={SID} toolName="Get" inputDescriptor={[]} fetchImpl={m.fetch} />,
    );
    submit();
    await screen.findByText(/<img src=x/);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows waiting, then the held message with the Inbox link, and collects the real result", async () => {
    let release: (r: Response) => void = () => undefined;
    const held = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    const m = mockFetch([
      held,
      respond(toolResult({ status: "held", approvalId: "ap1", expiresAt: "2030-01-01T00:00:00Z" })),
      respond(toolResult({ closed: true })),
    ]);
    render(<CommuneForm serviceId={SID} toolName="Close" inputDescriptor={[]} fetchImpl={m.fetch} />);
    submit();
    expect(await screen.findByText("Waiting for a human to release this call")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop waiting" })).toBeTruthy();

    await act(async () => {
      release(rpc(toolResult({ status: "held", approvalId: "ap1", expiresAt: "2030-01-01T00:00:00Z" })));
    });
    const link = await screen.findByRole("link", { name: "Open the Inbox" });
    expect(link).toHaveAttribute("href", "#inbox");
    expect(screen.queryByText("Waiting for a human to release this call")).toBeNull();

    // Collect: first still held, then the real result.
    fireEvent.click(screen.getByRole("button", { name: "Collect result" }));
    await screen.findByRole("link", { name: "Open the Inbox" });
    await waitFor(() => expect(m.sent).toHaveLength(2));
    expect(m.sent[1]).toEqual({ name: "check_approval", arguments: { approvalId: "ap1" } });
    fireEvent.click(screen.getByRole("button", { name: "Collect result" }));
    await screen.findByText(/"closed": true/);
    expect(m.sent[2]).toEqual({ name: "check_approval", arguments: { approvalId: "ap1" } });
  });

  it("shows the blocked reason", async () => {
    const m = mockFetch([
      respond({ content: [{ type: "text", text: "A human refused this call. too risky" }], isError: true }),
    ]);
    render(<CommuneForm serviceId={SID} toolName="Close" inputDescriptor={[]} fetchImpl={m.fetch} />);
    submit();
    expect(await screen.findByText(/Blocked: A human refused this call\. too risky/)).toBeTruthy();
  });

  it("shows the ghost banner and the made-up result", async () => {
    const m = mockFetch([respond(toolResult({ ghost: true, result: { closed: true } }))]);
    render(<CommuneForm serviceId={SID} toolName="Close" inputDescriptor={[]} fetchImpl={m.fetch} />);
    submit();
    expect(await screen.findByText("Ghost mode: nothing was sent")).toBeTruthy();
    expect(screen.getByText(/"closed": true/)).toBeTruthy();
  });

  it("stops waiting on request and aborts the call", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      });
    };
    render(<CommuneForm serviceId={SID} toolName="Close" inputDescriptor={[]} fetchImpl={fetchImpl} />);
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Stop waiting" }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText(/Stopped waiting/)).toBeTruthy();
    expect(screen.queryByText("Waiting for a human to release this call")).toBeNull();
  });

  it("aborts the request on unmount", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      });
    };
    const { unmount } = render(
      <CommuneForm serviceId={SID} toolName="Close" inputDescriptor={[]} fetchImpl={fetchImpl} />,
    );
    submit();
    await screen.findByText("Waiting for a human to release this call");
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
