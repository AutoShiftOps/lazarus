import { resolveServiceApproval, unavailable } from "@/lib/api/services";
import { defaultDeps } from "@/lib/mcp/deps";
import type { Deps } from "@/lib/mcp/pipeline";
import { registry } from "@/lib/registry";

type Ctx = { params: Promise<{ id: string; aid: string }> };

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id, aid } = await params;
  let deps: Deps;
  try {
    deps = defaultDeps();
  } catch {
    return unavailable();
  }
  return resolveServiceApproval({ registry, approvals: deps.approvals, rateRedis: deps.rateRedis }, id, aid, request);
}
