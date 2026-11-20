// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useApprove } from "../../lib/ui/use-approve";

describe("useApprove", () => {
  it("sends once on a double call, then reports released", async () => {
    const calls: Array<{ url: string; headers: unknown }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, headers: init?.headers });
      return new Response("{}", { status: 200 });
    };
    const token = "tok_abcdefghijklmnopqrstuvwxyz";
    const { result } = renderHook(() =>
      useApprove("svc", "a1", { ownerToken: token, fetch: fetchImpl }),
    );
    expect(result.current.status).toBe("idle");

    await act(async () => {
      void result.current.approve();
      void result.current.approve();
    });
    await waitFor(() => expect(result.current.status).toBe("released"));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({ "x-lazarus-owner": token });
  });

  it("exposes a fixed message on failure", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("{}", { status: 409 });
    const { result } = renderHook(() => useApprove("svc", "a1", { fetch: fetchImpl }));
    await act(async () => {
      await result.current.deny();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.message).toBe("This call was already resolved.");
  });
});
