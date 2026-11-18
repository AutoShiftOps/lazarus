import { putServiceRules } from "@/lib/api/services";
import { registry } from "@/lib/registry";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return putServiceRules({ registry }, id, request);
}
