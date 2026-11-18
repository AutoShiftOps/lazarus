import { patchServiceSettings } from "@/lib/api/services";
import { registry } from "@/lib/registry";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return patchServiceSettings({ registry }, id, request);
}
