import { toResponse, wsdlHttp } from "@/lib/gravewood/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return toResponse(await wsdlHttp(id, new URL(request.url).origin));
}
