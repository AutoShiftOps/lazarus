import { expect, test, type APIRequestContext } from "@playwright/test";

// Real dev server, real Redis, real Gravewood sandbox. Nothing is mocked.

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type RpcResponse = {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type Summoned = {
  id: string;
  ownerToken: string;
  operations: { name: string; risk: string }[];
};

type Account = { id: string; balance: number | string; status: string };

const OWNER_HEADER = "x-lazarus-owner";
const GHOST_MARKER = "[GHOST";

let nextRpcId = 1;

async function rpc(
  request: APIRequestContext,
  serviceId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  const res = await request.post(`/api/mcp/${serviceId}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: nextRpcId++, method, params },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as RpcResponse;
}

async function callTool(
  request: APIRequestContext,
  serviceId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const body = await rpc(request, serviceId, "tools/call", { name, arguments: args });
  expect(body.error).toBeUndefined();
  expect(body.result).toBeDefined();
  return body.result as unknown as ToolResult;
}

async function summonFreshGravewood(request: APIRequestContext): Promise<Summoned> {
  const sandbox = await request.post("/api/gravewood/sandboxes");
  expect(sandbox.status()).toBe(201);
  const { wsdlUrl } = (await sandbox.json()) as { wsdlUrl: string };
  expect(wsdlUrl).toContain("/api/gravewood/");

  const summon = await request.post("/api/summon", { data: { wsdlUrl } });
  expect(summon.status()).toBe(200);
  const body = (await summon.json()) as Summoned;
  expect(body.id).toMatch(/^[A-Za-z0-9]{8,12}$/);
  expect(typeof body.ownerToken).toBe("string");
  return body;
}

async function listAccounts(request: APIRequestContext, serviceId: string): Promise<Account[]> {
  const result = await callTool(request, serviceId, "ListAccounts", {});
  expect(result.isError).not.toBe(true);
  const accounts = result.structuredContent?.account;
  expect(Array.isArray(accounts)).toBe(true);
  return accounts as Account[];
}

function accountById(accounts: Account[], id: string): Account {
  const found = accounts.find((a) => a.id === id);
  expect(found, `account ${id} present`).toBeDefined();
  return found as Account;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

test.describe("MCP gateway end to end", () => {
  test("summon, hold, approve, execute once, transcripts", async ({ request }) => {
    const svc = await summonFreshGravewood(request);
    expect(svc.operations).toHaveLength(6);

    // tools/list: 6 operations + check_approval, every description starts with the risk line.
    const list = await rpc(request, svc.id, "tools/list", {});
    const tools = (list.result?.tools ?? []) as { name: string; description: string }[];
    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name)).toContain("check_approval");
    for (const t of tools.filter((x) => x.name !== "check_approval")) {
      expect(t.description.startsWith("Risk:"), `${t.name} description`).toBe(true);
    }

    // Read: allowed immediately, real data, no hold.
    const balance = await callTool(request, svc.id, "GetBalance", { accountId: "4471" });
    expect(balance.isError).not.toBe(true);
    expect(Number(balance.structuredContent?.balance)).toBe(12450);
    expect(balance.structuredContent?.status).toBeUndefined();
    expect(balance.structuredContent?.approvalId).toBeUndefined();

    // Destructive: held.
    const held = await callTool(request, svc.id, "CloseAccount", { accountId: "7718" });
    expect(held.isError).not.toBe(true);
    expect(held.structuredContent?.status).toBe("held");
    const approvalId = held.structuredContent?.approvalId;
    expect(typeof approvalId).toBe("string");

    // Approvals list shows it pending with redacted args.
    const listed = await request.get(`/api/services/${svc.id}/approvals`);
    expect(listed.status()).toBe(200);
    const approvals = (await listed.json()) as {
      id: string;
      status: string;
      tool: string;
      args: unknown;
    }[];
    const pending = approvals.find((a) => a.id === approvalId);
    expect(pending).toBeDefined();
    expect(pending?.status).toBe("pending");
    expect(pending?.tool).toBe("CloseAccount");
    expect(pending?.args).toEqual({ accountId: "7718" });
    expect(JSON.stringify(approvals)).not.toContain(svc.ownerToken);

    // Still open before approval.
    expect(accountById(await listAccounts(request, svc.id), "7718").status).toBe("OPEN");

    // Approve (demo service: no owner token).
    const approve = await request.post(`/api/services/${svc.id}/approvals/${String(approvalId)}`, {
      data: { decision: "approve" },
    });
    expect(approve.status()).toBe(200);
    expect(((await approve.json()) as { status: string }).status).toBe("approved");

    // check_approval executes it.
    const done = await callTool(request, svc.id, "check_approval", { approvalId });
    expect(done.isError).not.toBe(true);
    expect(done.structuredContent?.closed).toBe(true);

    expect(accountById(await listAccounts(request, svc.id), "7718").status).toBe("CLOSED");

    // Second check: already executed, not run again.
    const again = await callTool(request, svc.id, "check_approval", { approvalId });
    expect(again.structuredContent?.status).toBe("executed");
    expect(textOf(again)).toContain("already executed");

    // Second approve: conflict.
    const second = await request.post(`/api/services/${svc.id}/approvals/${String(approvalId)}`, {
      data: { decision: "approve" },
    });
    expect(second.status()).toBe(409);

    // Transcripts: held and ok entries linked by approvalId; no token anywhere.
    const tr = await request.get(`/api/services/${svc.id}/transcripts`);
    expect(tr.status()).toBe(200);
    const entries = (await tr.json()) as {
      tool: string;
      outcome: string;
      approvalId?: string;
    }[];
    const mine = entries.filter((e) => e.approvalId === approvalId);
    expect(mine.some((e) => e.tool === "CloseAccount" && e.outcome === "held")).toBe(true);
    expect(mine.some((e) => e.tool === "check_approval" && e.outcome === "ok")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(svc.ownerToken);
  });

  test("ghost mode simulates writes and still reads real data", async ({ request }) => {
    const svc = await summonFreshGravewood(request);
    const owner = { [OWNER_HEADER]: svc.ownerToken };

    const noToken = await request.patch(`/api/services/${svc.id}/settings`, { data: { ghost: true } });
    expect(noToken.status()).toBe(401);

    const on = await request.patch(`/api/services/${svc.id}/settings`, {
      data: { ghost: true },
      headers: owner,
    });
    expect(on.status()).toBe(200);
    expect(((await on.json()) as { ghost: boolean }).ghost).toBe(true);

    const before = await listAccounts(request, svc.id);

    const transfer = await callTool(request, svc.id, "TransferFunds", {
      fromAccount: "4471",
      toAccount: "5530",
      amount: 100,
    });
    expect(transfer.isError).not.toBe(true);
    expect(textOf(transfer).startsWith(GHOST_MARKER)).toBe(true);
    expect(transfer.structuredContent?.ghost).toBe(true);

    const close = await callTool(request, svc.id, "CloseAccount", { accountId: "7718" });
    expect(close.isError).not.toBe(true);
    expect(textOf(close).startsWith(GHOST_MARKER)).toBe(true);
    expect(close.structuredContent?.ghost).toBe(true);

    const after = await listAccounts(request, svc.id);
    expect(after).toEqual(before);
    expect(accountById(after, "7718").status).toBe("OPEN");
    expect(Number(accountById(after, "4471").balance)).toBe(12450);
    expect(Number(accountById(after, "5530").balance)).toBe(48000);

    // Reads are real even in ghost mode.
    const read = await callTool(request, svc.id, "GetBalance", { accountId: "4471" });
    expect(read.isError).not.toBe(true);
    expect(Number(read.structuredContent?.balance)).toBe(12450);
    expect(read.structuredContent?.ghost).toBeUndefined();
  });

  test("block rule stops large transfers and rule limits are enforced", async ({ request }) => {
    const svc = await summonFreshGravewood(request);
    const owner = { [OWNER_HEADER]: svc.ownerToken };

    const rule = {
      id: "no-big-transfers",
      operation: "TransferFunds",
      when: { field: "amount", op: "gt", value: 1000 },
      effect: "block",
      reason: "Transfers over 1000 are not allowed",
    };
    const put = await request.put(`/api/services/${svc.id}/rules`, { data: [rule], headers: owner });
    expect(put.status()).toBe(200);
    expect(await put.json()).toEqual([rule]);

    const big = await callTool(request, svc.id, "TransferFunds", {
      fromAccount: "4471",
      toAccount: "5530",
      amount: 5000,
    });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("Transfers over 1000 are not allowed");

    const small = await callTool(request, svc.id, "TransferFunds", {
      fromAccount: "4471",
      toAccount: "5530",
      amount: 10,
    });
    expect(small.isError).not.toBe(true);
    expect(textOf(small).startsWith(GHOST_MARKER)).toBe(false);
    expect(small.structuredContent?.confirmationId).toBeDefined();

    // Only the small transfer moved money.
    const accounts = await listAccounts(request, svc.id);
    expect(Number(accountById(accounts, "4471").balance)).toBe(12440);
    expect(Number(accountById(accounts, "5530").balance)).toBe(48010);

    const tooMany = Array.from({ length: 26 }, (_, i) => ({ ...rule, id: `r${i}` }));
    const rejected = await request.put(`/api/services/${svc.id}/rules`, { data: tooMany, headers: owner });
    expect(rejected.status()).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe("INVALID_REQUEST");
  });

  test("hostile inputs are rejected cleanly", async ({ request }) => {
    const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

    const unknown = await request.post("/api/mcp/ZZZZZZZZ", { headers: json, data: listBody });
    expect(unknown.status()).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toBe("Service not found.");

    const get = await request.get("/api/mcp/ZZZZZZZZ");
    expect(get.status()).toBe(405);
    expect(get.headers()["allow"]).toBe("POST, OPTIONS");

    const huge = await request.post("/api/mcp/ZZZZZZZZ", {
      headers: json,
      data: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(300 * 1024) } }),
    });
    expect(huge.status()).toBe(413);

    const options = await request.fetch("/api/mcp/ZZZZZZZZ", { method: "OPTIONS" });
    expect(options.status()).toBe(204);
    expect(options.headers()["access-control-allow-origin"]).toBe("*");
    expect(options.headers()["access-control-allow-methods"]).toBe("POST, OPTIONS");
    expect(options.headers()["access-control-allow-headers"]).toContain("mcp-session-id");
  });
});
