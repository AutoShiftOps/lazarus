import { listServiceApprovals, unavailable } from "@/lib/api/services";
import { defaultDeps } from "@/lib/mcp/deps";
import type { Deps } from "@/lib/mcp/pipeline";
import { registry } from "@/lib/registry";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  let deps: Deps;
  try {
    deps = defaultDeps();
  } catch {
    return unavailable();
  }
  return listServiceApprovals({ registry, approvals: deps.approvals, rateRedis: deps.rateRedis }, id, request);
}
