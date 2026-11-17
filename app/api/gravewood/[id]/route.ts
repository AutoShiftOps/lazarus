import { declaredTooLarge, requestTooLarge, soapHttp, toResponse } from "@/lib/gravewood/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (declaredTooLarge(request.headers)) return toResponse(requestTooLarge());
  const body = await request.text();
  return toResponse(await soapHttp(id, request.headers.get("soapaction"), body));
}
