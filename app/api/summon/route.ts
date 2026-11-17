import { summonFromBody } from "@/lib/summon";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > 4096) {
      return Response.json(
        { error: "Request body is too large.", code: "INVALID_REQUEST" },
        { status: 400 },
      );
    }
    const text = await request.text();
    const origin = new URL(request.url).origin;
    const result = await summonFromBody(text, origin);
    return Response.json(result.body, { status: result.status });
  } catch (e) {
    console.error("summon route failed:", e instanceof Error ? e.message : "unknown error");
    return Response.json(
      { error: "An unexpected error occurred.", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
