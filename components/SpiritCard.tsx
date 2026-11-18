import type { SpiritView } from "../lib/ui/service-view";
import { RiskBadge } from "./RiskBadge";

/** One operation (spirit). All text is pre-sanitised by `toServiceView`. */
export function SpiritCard({ spirit }: { spirit: SpiritView }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <h3 className="font-mono text-base font-medium text-spectral [overflow-wrap:anywhere]">
        {spirit.name}
      </h3>
      <p className="text-sm text-muted">{spirit.description}</p>
      <div className="mt-auto">
        <RiskBadge risk={spirit.risk} reason={spirit.riskReason} />
      </div>
    </li>
  );
}
