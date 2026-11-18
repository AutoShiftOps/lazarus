import { clientIpOf } from "../../../lib/api/services";
import { defaultDemoDeps } from "../../../lib/demo/deps";
import { bootstrapDemo, methodNotAllowed, type DemoDeps } from "../../../lib/demo";

export const maxDuration = 60;

// The request body is never read: this endpoint accepts no input.
export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  let deps: DemoDeps;
  try {
    deps = defaultDemoDeps(origin);
  } catch {
    return Response.json(
      { error: "The demo is not available right now.", code: "UNAVAILABLE" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return bootstrapDemo(deps, clientIpOf(request));
}

export const GET = async (): Promise<Response> => methodNotAllowed();
export const PUT = async (): Promise<Response> => methodNotAllowed();
export const PATCH = async (): Promise<Response> => methodNotAllowed();
export const DELETE = async (): Promise<Response> => methodNotAllowed();
