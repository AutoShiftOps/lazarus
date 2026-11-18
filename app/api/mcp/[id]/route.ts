import { defaultDeps } from "@/lib/mcp/deps";
import { handleMcpRequest, handleOptions, methodNotAllowed } from "@/lib/mcp/http";
import { registry } from "@/lib/registry";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  // Deps are built per request; nothing touches env or Redis at import time.
  return handleMcpRequest(request, id, { ...defaultDeps(), registry });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
