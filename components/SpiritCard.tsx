import type { CSSProperties } from "react";
import type { SpiritView } from "../lib/ui/service-view";
import { CommuneForm } from "./CommuneForm";
import { RiskBadge } from "./RiskBadge";

/** One operation (spirit). All text is pre-sanitised by `toServiceView`. `index` staggers the rise-in. */
export function SpiritCard({
  spirit,
  serviceId,
  index = 0,
}: {
  spirit: SpiritView;
  serviceId: string;
  index?: number;
}) {
  return (
    <li
      className="rise flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4"
      style={{ ["--i" as string]: index } as CSSProperties}
    >
      <h3 className="font-mono text-base font-medium text-spectral [overflow-wrap:anywhere]">
        {spirit.name}
      </h3>
      <p className="text-sm text-muted">{spirit.description}</p>
      <div className="mt-auto">
        <RiskBadge risk={spirit.risk} reason={spirit.riskReason} />
      </div>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm text-candle">Commune</summary>
        <div className="mt-3">
          <CommuneForm
            serviceId={serviceId}
            toolName={spirit.toolName}
            inputDescriptor={spirit.inputDescriptor}
          />
        </div>
      </details>
    </li>
  );
}
