import { listServiceTranscripts, unavailable } from "@/lib/api/services";
import { defaultDeps, type DefaultDeps } from "@/lib/mcp/deps";
import { registry } from "@/lib/registry";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  let deps: DefaultDeps;
  try {
    deps = defaultDeps();
  } catch {
    return unavailable();
  }
  return listServiceTranscripts({ registry, transcripts: deps.transcripts }, id, request);
}
