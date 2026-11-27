import { describe, expect, it } from "vitest";
import { createAnthropicRisk, type FetchLike } from "../../lib/soap/anthropic-risk";
import { classifyOperations, heuristicRisk } from "../../lib/soap/risk";
import type { OperationSchema } from "../../lib/soap/types";

const KEY = "sk-ant-test-secret";

function op(name: string, extra: Partial<OperationSchema> = {}): OperationSchema {
  const h = heuristicRisk(name, extra.documentation);
  return {
    name,
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: "http://secret.example/soapAction",
    targetNamespace: "http://secret.example/targetNamespace",
    inputElementName: name,
    outputElementName: `${name}Response`,
    endpointAddress: "http://internal.example/endpoint",
    elementFormDefault: "qualified",
    inputDescriptor: [{ name: "accountId", xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false }],
    outputDescriptor: [{ name: "balance", xsdType: "decimal", minOccurs: 1, maxOccurs: 1, nillable: false }],
    warnings: [],
    risk: h.risk,
    riskReason: h.reason,
    riskSource: "heuristic",
    ...extra,
  };
}

function reply(text: string, status = 200): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status });
}

type Call = { url: string; init: RequestInit };

function stub(respond: (init: RequestInit) => Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(init);
    },
  };
}

describe("createAnthropicRisk", () => {
  it("returns undefined without a key", () => {
    expect(createAnthropicRisk({})).toBeUndefined();
    expect(createAnthropicRisk({ ANTHROPIC_API_KEY: "" })).toBeUndefined();
  });

  it("raises risk from a valid response and sends the documented headers", async () => {
    const s = stub(async () => reply('[{"name":"GetBalance","risk":"write","reason":"bumps a counter"}]'));
    const adapter = createAnthropicRisk({ ANTHROPIC_API_KEY: KEY }, s.fetch);
    const out = await classifyOperations([op("GetBalance")], { bedrock: adapter });
    expect(out[0].risk).toBe("write");
    expect(out[0].riskSource).toBe("model");
    const headers = s.calls[0].init.headers as Record<string, string>;
    expect(s.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(s.calls[0].init.body)).model).toBe("claude-haiku-5-5");
  });

  it("accepts a fenced JSON answer and honours ANTHROPIC_MODEL", async () => {
    const s = stub(async () => reply('```json\n[{"name":"GetBalance","risk":"destructive","reason":"x"}]\n```'));
    const adapter = createAnthropicRisk({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: "custom-model" }, s.fetch);
    const out = await classifyOperations([op("GetBalance")], { bedrock: adapter });
    expect(out[0].risk).toBe("destructive");
    expect(JSON.parse(String(s.calls[0].init.body)).model).toBe("custom-model");
  });

  it("ignores an answer that lowers risk", async () => {
    const s = stub(async () => reply('[{"name":"CloseAccount","risk":"read","reason":"harmless"}]'));
    const out = await classifyOperations([op("CloseAccount")], {
      bedrock: createAnthropicRisk({ ANTHROPIC_API_KEY: KEY }, s.fetch),
    });
    expect(out[0].risk).toBe("destructive");
    expect(out[0].riskSource).toBe("heuristic");
  });

  it.each([
    ["non-2xx", () => Promise.resolve(reply("[]", 500))],
    ["invalid JSON text", () => Promise.resolve(reply("not json"))],
    ["schema mismatch", () => Promise.resolve(reply('[{"name":"GetBalance","risk":"nuke","reason":"x"}]'))],
    ["bad envelope", () => Promise.resolve(new Response(JSON.stringify({ nope: 1 }), { status: 200 }))],
    ["network error", () => Promise.reject(new Error("down"))],
  ])("falls back to the heuristic on %s", async (_label, respond) => {
    const s = stub(respond);
    const out = await classifyOperations([op("GetBalance")], {
      bedrock: createAnthropicRisk({ ANTHROPIC_API_KEY: KEY }, s.fetch),
    });
    expect(out[0].risk).toBe("read");
    expect(out[0].riskSource).toBe("heuristic");
  });

  it("falls back on timeout and aborts the request", async () => {
    let aborted = false;
    const s = stub(
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const out = await classifyOperations([op("GetBalance")], {
      bedrock: createAnthropicRisk({ ANTHROPIC_API_KEY: KEY }, s.fetch),
      timeoutMs: 20,
    });
    expect(out[0].riskSource).toBe("heuristic");
    expect(aborted).toBe(true);
  });

  it("sends only names, documentation and field names", async () => {
    const s = stub(async () => reply("[]"));
    await classifyOperations([op("GetBalance", { documentation: "d".repeat(900) })], {
      bedrock: createAnthropicRisk({ ANTHROPIC_API_KEY: KEY }, s.fetch),
    });
    const body = JSON.parse(String(s.calls[0].init.body)) as { messages: { content: string }[] };
    const sent = JSON.parse(body.messages[0].content) as Record<string, unknown>[];
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual(["documentation", "fields", "name"]);
    expect(sent[0].fields).toEqual(["accountId", "balance"]);
    expect((sent[0].documentation as string).length).toBe(500);
    const raw = String(s.calls[0].init.body);
    for (const secret of ["secret.example", "internal.example", KEY, "soapAction"]) {
      expect(raw).not.toContain(secret);
    }
  });
});
