import { resetHttp, toResponse } from "@/lib/gravewood/http";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return toResponse(await resetHttp(id));
}
