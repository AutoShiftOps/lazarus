import { getServiceSummary } from "@/lib/api/services";
import { registry } from "@/lib/registry";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return getServiceSummary({ registry }, id);
}
