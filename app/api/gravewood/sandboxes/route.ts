import { clientIp, createSandboxHttp, toResponse } from "@/lib/gravewood/http";

export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return toResponse(await createSandboxHttp(clientIp(request.headers), origin));
}
